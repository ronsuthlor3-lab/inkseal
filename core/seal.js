// Signs and verifies the provenance record ("seal") stored inside an image file.

import { encoder, fingerprintBytes, formatFingerprint, fromBase64, sha256, toBase64, toHex } from './bytes.js';
import { embedSealText, extractSealText, stripSeal } from './container.js';

export const SEAL_FORMAT = 'inkseal/1';
export const VERSION = '0.1.0';

/** JSON with sorted keys and no whitespace, so signer and verifier hash identical bytes. */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalJSON(value[k]))
      .join(',') +
    '}'
  );
}

/** SHA-256 (hex) of the file with any seal record removed. */
export async function contentHash(bytes) {
  return toHex(await sha256(stripSeal(bytes)));
}

/**
 * Sign an encoded PNG/JPEG file.
 * @param {Uint8Array} bytes   the finished image file (visible signature and watermark already applied)
 * @param {object} identity    result of unlockIdentity()
 * @param {object} info        { title, description, license, watermark: {strength}|null }
 * @returns {{bytes: Uint8Array, manifest: object}}
 */
export async function sealImage(bytes, identity, info = {}) {
  const clean = stripSeal(bytes);
  const manifest = {
    creator: { name: identity.name, contact: identity.contact || '' },
    work: {
      title: info.title || '',
      description: info.description || '',
      license: info.license || '',
    },
    sealedAt: new Date().toISOString(),
    contentHash: toHex(await sha256(clean)),
    hashAlgorithm: 'sha256',
    publicKey: toBase64(identity.publicKeyRaw),
    fingerprint: identity.fingerprint,
    watermark: info.watermark || null,
    generator: `Inkseal ${VERSION}`,
  };
  const signature = new Uint8Array(
    await crypto.subtle.sign('Ed25519', identity.privateKey, encoder.encode(canonicalJSON(manifest))),
  );
  const record = JSON.stringify({ format: SEAL_FORMAT, manifest, signature: toBase64(signature) });
  return { bytes: embedSealText(clean, record), manifest };
}

/**
 * Check the seal of a file.
 * status:
 *   'none'        no Inkseal record
 *   'unreadable'  a record exists but cannot be parsed
 *   'forged'      the signature or the identity data does not check out
 *   'modified'    signature is genuine, but the image changed after sealing
 *   'valid'       genuine and unmodified
 */
export async function readSeal(bytes) {
  const text = extractSealText(bytes);
  if (text === null) return { status: 'none' };

  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return { status: 'unreadable' };
  }
  if (!record || record.format !== SEAL_FORMAT || !record.manifest || !record.signature) {
    return { status: 'unreadable' };
  }

  const { manifest } = record;
  let signatureOk = false;
  let fingerprintOk = false;
  try {
    const publicKeyRaw = fromBase64(manifest.publicKey);
    const key = await crypto.subtle.importKey('raw', publicKeyRaw, { name: 'Ed25519' }, false, ['verify']);
    signatureOk = await crypto.subtle.verify(
      'Ed25519',
      key,
      fromBase64(record.signature),
      encoder.encode(canonicalJSON(manifest)),
    );
    fingerprintOk = formatFingerprint(await fingerprintBytes(publicKeyRaw)) === manifest.fingerprint;
  } catch {
    signatureOk = false;
  }
  if (!signatureOk || !fingerprintOk) return { status: 'forged', manifest };

  const actualHash = await contentHash(bytes);
  return { status: actualHash === manifest.contentHash ? 'valid' : 'modified', manifest, actualHash };
}
