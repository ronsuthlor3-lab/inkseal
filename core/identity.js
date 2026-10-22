// A creator identity is an Ed25519 key pair. The private key never leaves the
// identity file unencrypted: it is wrapped with AES-256-GCM using a key derived
// from the creator's passphrase (PBKDF2-SHA256).

import { encoder, fingerprintBytes, formatFingerprint, fromBase64, toBase64 } from './bytes.js';

export const IDENTITY_FORMAT = 'inkseal-identity/1';
const KDF_ITERATIONS = 310000;
const subtle = () => crypto.subtle;

async function deriveWrappingKey(passphrase, salt, iterations) {
  const base = await subtle().importKey('raw', encoder.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Create a new identity file (a plain JSON object) protected by `passphrase`. */
export async function createIdentity({ name, contact = '' }, passphrase) {
  if (!name || !name.trim()) throw new Error('NAME_REQUIRED');
  if (!passphrase || passphrase.length < 8) throw new Error('PASSPHRASE_TOO_SHORT');

  const pair = await subtle().generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey));

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrap = await deriveWrappingKey(passphrase, salt, KDF_ITERATIONS);
  const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, wrap, pkcs8));

  return {
    format: IDENTITY_FORMAT,
    name: name.trim(),
    contact: contact.trim(),
    fingerprint: formatFingerprint(await fingerprintBytes(publicKey)),
    publicKey: toBase64(publicKey),
    createdAt: new Date().toISOString(),
    privateKey: {
      kdf: 'PBKDF2-SHA256',
      iterations: KDF_ITERATIONS,
      salt: toBase64(salt),
      cipher: 'AES-256-GCM',
      iv: toBase64(iv),
      data: toBase64(sealed),
    },
  };
}

/** Decrypt an identity file. Throws WRONG_PASSPHRASE or INVALID_IDENTITY. */
export async function unlockIdentity(file, passphrase) {
  if (!file || file.format !== IDENTITY_FORMAT || !file.privateKey) throw new Error('INVALID_IDENTITY');
  const pk = file.privateKey;
  const wrap = await deriveWrappingKey(passphrase, fromBase64(pk.salt), pk.iterations);

  let pkcs8;
  try {
    pkcs8 = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(pk.iv) }, wrap, fromBase64(pk.data));
  } catch {
    throw new Error('WRONG_PASSPHRASE');
  }

  const publicKeyRaw = fromBase64(file.publicKey);
  const privateKey = await subtle().importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  const publicKey = await subtle().importKey('raw', publicKeyRaw, { name: 'Ed25519' }, true, ['verify']);

  // Make sure the two halves belong together and the stated fingerprint is honest.
  const probe = crypto.getRandomValues(new Uint8Array(32));
  const sig = await subtle().sign('Ed25519', privateKey, probe);
  const fingerprint = formatFingerprint(await fingerprintBytes(publicKeyRaw));
  if (!(await subtle().verify('Ed25519', publicKey, sig, probe)) || fingerprint !== file.fingerprint) {
    throw new Error('INVALID_IDENTITY');
  }

  return { name: file.name, contact: file.contact || '', fingerprint, publicKeyRaw, privateKey };
}

/** True when this runtime can do Ed25519 through WebCrypto. */
export async function supportsEd25519() {
  try {
    await subtle().generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}
