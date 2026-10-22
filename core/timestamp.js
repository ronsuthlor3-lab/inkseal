// Proof of existence through OpenTimestamps (https://opentimestamps.org).
//
// Only the SHA-256 of the sealed file is sent to the public calendar servers, never
// the image. The result is a standard .ots file. Right after creation it is "pending";
// a few hours later the calendars anchor it in the Bitcoin blockchain, and anyone can
// verify it at opentimestamps.org or with the official `ots` tool.

import { concat, encoder, sha256 } from './bytes.js';

export const CALENDARS = [
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://a.pool.eternitywall.com',
];

const OTS_MAGIC = concat(
  Uint8Array.of(0x00),
  encoder.encode('OpenTimestamps'),
  Uint8Array.of(0x00, 0x00),
  encoder.encode('Proof'),
  Uint8Array.of(0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94),
);
const OTS_VERSION = 0x01;
const OP_SHA256 = 0x08;
const FORK = 0xff;

async function submit(calendar, digest) {
  const res = await fetch(`${calendar}/digest`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.opentimestamps.v1' },
    body: digest,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Build a .ots proof for `fileBytes`. Throws TIMESTAMP_FAILED if no calendar answers. */
export async function createTimestampProof(fileBytes, calendars = CALENDARS) {
  const digest = await sha256(fileBytes);
  const results = await Promise.allSettled(calendars.map((c) => submit(c, digest)));
  const answers = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!answers.length) throw new Error('TIMESTAMP_FAILED');

  // Each calendar returns a serialized timestamp for `digest`. Several of them are
  // joined as a fork: every branch except the last is prefixed with 0xff.
  const branches = answers.flatMap((a, i) => (i < answers.length - 1 ? [Uint8Array.of(FORK), a] : [a]));
  return {
    proof: concat(OTS_MAGIC, Uint8Array.of(OTS_VERSION, OP_SHA256), digest, ...branches),
    calendars: answers.length,
  };
}
