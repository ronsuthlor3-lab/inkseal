// Reads, writes and removes the Inkseal record inside PNG and JPEG files.
//
// PNG:  an iTXt chunk with keyword "inkseal", placed right before IEND.
// JPEG: an APP15 segment starting with "INKSEAL\0", placed after the leading APPn segments.
//
// The signed content hash is always computed over the file *without* this record,
// so the record can hold the signature of everything else in the file.

import { concat, crc32, decoder, encoder } from './bytes.js';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const PNG_KEYWORD = 'inkseal';
const JPEG_MARKER = 0xef; // APP15
const JPEG_ID = encoder.encode('INKSEAL\0');
const JPEG_MAX_PAYLOAD = 65533 - JPEG_ID.length;

export function detectFormat(bytes) {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

function requireFormat(bytes) {
  const format = detectFormat(bytes);
  if (!format) throw new Error('UNSUPPORTED_FORMAT');
  return format;
}

// ---------- PNG ----------

function readU32(b, p) {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
}

function pngChunks(bytes) {
  const chunks = [];
  let p = 8;
  while (p + 12 <= bytes.length) {
    const len = readU32(bytes, p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const end = p + 12 + len;
    if (end > bytes.length) throw new Error('CORRUPT_FILE');
    chunks.push({ type, start: p, end, data: bytes.subarray(p + 8, p + 8 + len) });
    p = end;
    if (type === 'IEND') break;
  }
  if (!chunks.length || chunks[chunks.length - 1].type !== 'IEND') throw new Error('CORRUPT_FILE');
  return chunks;
}

const PNG_KEYWORD_BYTES = encoder.encode(PNG_KEYWORD + '\0');

function isPngSeal(chunk) {
  return (
    chunk.type === 'iTXt' &&
    chunk.data.length > PNG_KEYWORD_BYTES.length &&
    PNG_KEYWORD_BYTES.every((b, i) => chunk.data[i] === b)
  );
}

function pngSealText(chunk) {
  // iTXt: keyword\0 compressionFlag compressionMethod languageTag\0 translatedKeyword\0 text
  const d = chunk.data;
  let p = PNG_KEYWORD_BYTES.length + 2;
  while (p < d.length && d[p] !== 0) p++;
  p++;
  while (p < d.length && d[p] !== 0) p++;
  p++;
  return decoder.decode(d.subarray(p));
}

function makePngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(encoder.encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// ---------- JPEG ----------

function jpegSegments(bytes) {
  const segs = [];
  let p = 2;
  while (p + 1 < bytes.length) {
    if (bytes[p] !== 0xff) throw new Error('CORRUPT_FILE');
    const m = bytes[p + 1];
    if (m === 0xff) { p++; continue; } // fill byte
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; } // no length
    if (m === 0xda || m === 0xd9) { segs.push({ marker: m, start: p, end: bytes.length, tail: true }); break; }
    const len = (bytes[p + 2] << 8) | bytes[p + 3];
    const end = p + 2 + len;
    if (len < 2 || end > bytes.length) throw new Error('CORRUPT_FILE');
    segs.push({ marker: m, start: p, end, data: bytes.subarray(p + 4, end) });
    p = end;
  }
  return segs;
}

function isJpegSeal(seg) {
  return seg.marker === JPEG_MARKER && seg.data && JPEG_ID.every((b, i) => seg.data[i] === b);
}

// ---------- public API ----------

/** Return the Inkseal JSON text stored in the file, or null. */
export function extractSealText(bytes) {
  const format = requireFormat(bytes);
  if (format === 'png') {
    const chunk = pngChunks(bytes).find(isPngSeal);
    return chunk ? pngSealText(chunk) : null;
  }
  const seg = jpegSegments(bytes).find(isJpegSeal);
  return seg ? decoder.decode(seg.data.subarray(JPEG_ID.length)) : null;
}

/** Return a copy of the file with every Inkseal record removed. */
export function stripSeal(bytes) {
  const format = requireFormat(bytes);
  const keep = [bytes.subarray(0, format === 'png' ? 8 : 2)];
  if (format === 'png') {
    for (const c of pngChunks(bytes)) if (!isPngSeal(c)) keep.push(bytes.subarray(c.start, c.end));
  } else {
    for (const s of jpegSegments(bytes)) if (!isJpegSeal(s)) keep.push(bytes.subarray(s.start, s.end));
  }
  return concat(...keep);
}

/** Return a copy of the file carrying `text` as its (only) Inkseal record. */
export function embedSealText(bytes, text) {
  const clean = stripSeal(bytes);
  const payload = encoder.encode(text);
  if (detectFormat(clean) === 'png') {
    const iend = pngChunks(clean).at(-1);
    // keyword\0, compression flag 0, method 0, empty language tag\0, empty translated keyword\0
    const data = concat(PNG_KEYWORD_BYTES, Uint8Array.of(0, 0, 0, 0), payload);
    return concat(clean.subarray(0, iend.start), makePngChunk('iTXt', data), clean.subarray(iend.start));
  }
  if (payload.length > JPEG_MAX_PAYLOAD) throw new Error('SEAL_TOO_LARGE');
  const segs = jpegSegments(clean);
  const first = segs.find((s) => s.marker < 0xe0 || s.marker > 0xef);
  const at = first ? first.start : 2;
  const len = 2 + JPEG_ID.length + payload.length;
  const header = Uint8Array.of(0xff, JPEG_MARKER, len >> 8, len & 0xff);
  return concat(clean.subarray(0, at), header, JPEG_ID, payload, clean.subarray(at));
}
