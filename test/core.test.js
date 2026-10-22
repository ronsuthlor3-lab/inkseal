import assert from 'node:assert/strict';
import { test } from 'node:test';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { fingerprintBytes } from '../core/bytes.js';
import { embedSealText, extractSealText, stripSeal } from '../core/container.js';
import { createIdentity, unlockIdentity } from '../core/identity.js';
import { readSeal, sealImage } from '../core/seal.js';
import { embedWatermark, extractWatermark } from '../core/watermark.js';

function artwork(width = 640, height = 480) {
  const data = new Uint8Array(width * height * 4);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const n = rand() * 30;
      data[i] = 60 + (x / width) * 150 + n;
      data[i + 1] = 40 + (y / height) * 160 + n;
      data[i + 2] = 120 + Math.sin(x / 30) * 60 + n;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function toPng(img) {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data);
  return new Uint8Array(PNG.sync.write(png));
}

const identity = await (async () => {
  const file = await createIdentity({ name: 'Test Artist', contact: 'test@example.com' }, 'correct horse');
  return unlockIdentity(file, 'correct horse');
})();

test('wrong passphrase is rejected', async () => {
  const file = await createIdentity({ name: 'A' }, 'password-1');
  await assert.rejects(unlockIdentity(file, 'password-2'), /WRONG_PASSPHRASE/);
});

test('seal record round-trips in PNG and JPEG', () => {
  const img = artwork(64, 64);
  const png = toPng(img);
  const jpg = new Uint8Array(jpeg.encode({ ...img, data: Buffer.from(img.data) }, 90).data);
  for (const file of [png, jpg]) {
    const sealed = embedSealText(file, '{"hello":"สวัสดี"}');
    assert.equal(extractSealText(sealed), '{"hello":"สวัสดี"}');
    assert.deepEqual(stripSeal(sealed), file);
    assert.equal(extractSealText(file), null);
  }
});

test('valid, modified, forged and stripped files are told apart', async () => {
  const { bytes } = await sealImage(toPng(artwork()), identity, { title: 'Sunset' });
  assert.equal((await readSeal(bytes)).status, 'valid');

  const modified = bytes.slice();
  modified[100] ^= 1;
  assert.equal((await readSeal(modified)).status, 'modified');

  const record = JSON.parse(extractSealText(bytes));
  record.manifest.creator.name = 'Someone Else';
  assert.equal((await readSeal(embedSealText(bytes, JSON.stringify(record)))).status, 'forged');

  assert.equal((await readSeal(stripSeal(bytes))).status, 'none');
});

test('watermark is invisible-ish and survives JPEG compression', async () => {
  const original = artwork();
  const img = { ...original, data: original.data.slice() };
  const fp = await fingerprintBytes(identity.publicKeyRaw);
  embedWatermark(img, fp, 'normal');

  let se = 0;
  for (let i = 0; i < img.data.length; i++) if (i % 4 !== 3) se += (img.data[i] - original.data[i]) ** 2;
  const psnr = 10 * Math.log10((255 * 255) / (se / ((img.data.length / 4) * 3)));
  assert.ok(psnr > 40, `PSNR ${psnr.toFixed(1)} dB`);

  assert.equal(extractWatermark(img)?.fingerprint, identity.fingerprint);
  for (const quality of [90, 75]) {
    const jpg = jpeg.encode({ ...img, data: Buffer.from(img.data) }, quality).data;
    const back = jpeg.decode(jpg, { useTArray: true, formatAsRGBA: true });
    assert.equal(extractWatermark(back)?.fingerprint, identity.fingerprint, `JPEG q${quality}`);
  }
  assert.equal(extractWatermark(original), null);
});
