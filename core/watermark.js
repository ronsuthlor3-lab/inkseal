// Invisible watermark: hides the creator ID (48-bit fingerprint + CRC-16) in the pixels.
//
// Method: the image is cut into 8x8 blocks. In each block two mid-frequency DCT
// coefficients of the luminance are nudged onto one of two interleaved grids
// (quantization index modulation). Which grid encodes 0 or 1. Every payload bit is
// repeated across many blocks and decoded by soft majority vote.
//
// Survives: re-saving, JPEG compression down to roughly quality 75, small colour tweaks.
// Does NOT survive: cropping, resizing, rotating, heavy filters. That is a known limit.

import { crc16, formatFingerprint } from './bytes.js';

const BITS = 64;
const COEFFS = [[1, 2], [2, 1]];
export const STRENGTHS = { normal: 20, strong: 32 };
const MIN_BLOCKS = 256;
const MIN_CONFIDENCE = 0.3;

const BASIS = COEFFS.map(([u, v]) => {
  const b = new Float64Array(64);
  const au = u ? Math.sqrt(2 / 8) : Math.sqrt(1 / 8);
  const av = v ? Math.sqrt(2 / 8) : Math.sqrt(1 / 8);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      b[y * 8 + x] = au * av * Math.cos(((2 * x + 1) * u * Math.PI) / 16) * Math.cos(((2 * y + 1) * v * Math.PI) / 16);
    }
  }
  return b;
});

const bitIndex = (bx, by) => (bx + by * 7) % BITS;
const qim = (c, bit, d) => {
  const off = bit ? d / 2 : 0;
  return Math.round((c - off) / d) * d + off;
};

function payloadBits(fp6) {
  const crc = crc16(fp6);
  const bytes = [...fp6, crc >> 8, crc & 0xff];
  const bits = new Uint8Array(BITS);
  for (let i = 0; i < BITS; i++) bits[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return bits;
}

/** Read luma of one 8x8 block into `out`. Returns the mean, or -1 if the block is unusable. */
function readBlock(data, width, x0, y0, out) {
  let sum = 0;
  for (let y = 0; y < 8; y++) {
    let i = ((y0 + y) * width + x0) * 4;
    for (let x = 0; x < 8; x++, i += 4) {
      if (data[i + 3] !== 255) return -1; // transparent pixels cannot hold the mark
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      out[y * 8 + x] = l;
      sum += l;
    }
  }
  const mean = sum / 64;
  // Near-black / near-white blocks would clip; both embedder and detector skip them.
  return mean < 12 || mean > 243 ? -1 : mean;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < 64; i++) s += a[i] * b[i];
  return s;
}

export function canHoldWatermark(width, height) {
  return Math.floor(width / 8) * Math.floor(height / 8) >= MIN_BLOCKS;
}

/**
 * Embed the 6-byte fingerprint into RGBA pixel data, in place.
 * @param {{data: Uint8Array|Uint8ClampedArray, width: number, height: number}} img
 */
export function embedWatermark(img, fingerprint6, strength = 'normal') {
  const { data, width, height } = img;
  const delta = STRENGTHS[strength];
  if (!delta) throw new Error('BAD_STRENGTH');
  if (!canHoldWatermark(width, height)) throw new Error('IMAGE_TOO_SMALL');
  const bits = payloadBits(fingerprint6);
  const luma = new Float64Array(64);
  const change = new Float64Array(64);
  const bw = Math.floor(width / 8);
  const bh = Math.floor(height / 8);

  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const bit = bits[bitIndex(bx, by)];
      // Two passes: the second corrects rounding / clipping error left by the first.
      for (let pass = 0; pass < 2; pass++) {
        if (readBlock(data, width, bx * 8, by * 8, luma) < 0) break;
        change.fill(0);
        let any = false;
        for (let k = 0; k < BASIS.length; k++) {
          const c = dot(luma, BASIS[k]);
          const d = qim(c, bit, delta) - c;
          if (Math.abs(d) < 0.75) continue;
          any = true;
          for (let i = 0; i < 64; i++) change[i] += d * BASIS[k][i];
        }
        if (!any) break;
        for (let y = 0; y < 8; y++) {
          let p = ((by * 8 + y) * width + bx * 8) * 4;
          for (let x = 0; x < 8; x++, p += 4) {
            const add = Math.round(change[y * 8 + x]);
            if (!add) continue;
            // Adding the same amount to R, G and B shifts luma only; colour stays the same.
            data[p] = Math.min(255, Math.max(0, data[p] + add));
            data[p + 1] = Math.min(255, Math.max(0, data[p + 1] + add));
            data[p + 2] = Math.min(255, Math.max(0, data[p + 2] + add));
          }
        }
      }
    }
  }
}

/**
 * Look for an Inkseal watermark.
 * @returns {{fingerprint: string, confidence: number, strength: string} | null}
 */
export function extractWatermark(img) {
  const { data, width, height } = img;
  if (!canHoldWatermark(width, height)) return null;
  const bw = Math.floor(width / 8);
  const bh = Math.floor(height / 8);
  const luma = new Float64Array(64);
  const coeffs = [];
  const indexes = [];

  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (readBlock(data, width, bx * 8, by * 8, luma) < 0) continue;
      for (let k = 0; k < BASIS.length; k++) {
        coeffs.push(dot(luma, BASIS[k]));
        indexes.push(bitIndex(bx, by));
      }
    }
  }
  if (coeffs.length < MIN_BLOCKS) return null;

  let best = null;
  for (const [strength, delta] of Object.entries(STRENGTHS)) {
    const sums = new Float64Array(BITS);
    const counts = new Uint32Array(BITS);
    for (let i = 0; i < coeffs.length; i++) {
      const c = coeffs[i];
      const d0 = Math.abs(c - qim(c, 0, delta));
      const d1 = Math.abs(c - qim(c, 1, delta));
      sums[indexes[i]] += (d0 - d1) / (delta / 2);
      counts[indexes[i]]++;
    }
    const bytes = new Uint8Array(8);
    let confidence = 0;
    for (let i = 0; i < BITS; i++) {
      if (sums[i] > 0) bytes[i >> 3] |= 1 << (7 - (i & 7));
      confidence += counts[i] ? Math.abs(sums[i]) / counts[i] : 0;
    }
    confidence /= BITS;
    const fp = bytes.subarray(0, 6);
    const crcOk = crc16(fp) === ((bytes[6] << 8) | bytes[7]);
    if (crcOk && confidence >= MIN_CONFIDENCE && (!best || confidence > best.confidence)) {
      best = { fingerprint: formatFingerprint(fp), confidence: Math.min(1, confidence), strength };
    }
  }
  return best;
}
