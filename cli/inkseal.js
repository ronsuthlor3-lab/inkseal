#!/usr/bin/env node
// Inkseal command line: create an identity, seal many images at once, verify images.

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { fingerprintBytes } from '../core/bytes.js';
import { detectFormat } from '../core/container.js';
import { createIdentity, unlockIdentity } from '../core/identity.js';
import { drawOver, signatureRect } from '../core/raster.js';
import { readSeal, sealImage, VERSION } from '../core/seal.js';
import { createTimestampProof } from '../core/timestamp.js';
import { canHoldWatermark, embedWatermark, extractWatermark } from '../core/watermark.js';

const HELP = `Inkseal ${VERSION} - seal your artwork with an unforgeable signature

Usage:
  inkseal keygen --name "Your Name" [--contact "site or email"] [--out me.inkseal-id.json]
  inkseal seal <image|folder>... --id me.inkseal-id.json [options]
  inkseal verify <image>...

Seal options:
  --title <text>          title of the work (default: file name)
  --description <text>
  --license <text>        default "All rights reserved"
  --signature <png>       handwritten signature image (transparent PNG) to draw on the work
  --position <br|bl|tr|tl|center>   where to draw it (default br)
  --size <0.05-0.8>       signature width as a fraction of image width (default 0.25)
  --opacity <0-1>         default 0.9
  --format <png|jpeg>     output format (default: same as input)
  --strength <normal|strong>   invisible watermark strength (default normal)
  --no-watermark          do not embed the invisible creator ID
  --timestamp             also create a public OpenTimestamps proof (.ots)
  -o, --out <folder>      output folder (default: next to the input)

The passphrase is asked interactively, or read from the INKSEAL_PASSPHRASE environment variable.`;

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function askHidden(prompt) {
  if (process.env.INKSEAL_PASSPHRASE) return Promise.resolve(process.env.INKSEAL_PASSPHRASE);
  if (!process.stdin.isTTY) fail('no terminal to ask for the passphrase; set INKSEAL_PASSPHRASE');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(prompt);
    rl._writeToOutput = () => {}; // hide typing
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function decode(bytes) {
  const format = detectFormat(bytes);
  if (format === 'png') {
    const png = PNG.sync.read(Buffer.from(bytes));
    return { format, width: png.width, height: png.height, data: new Uint8Array(png.data) };
  }
  if (format === 'jpeg') {
    const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
    return { format, width: img.width, height: img.height, data: img.data };
  }
  throw new Error('only PNG and JPEG are supported');
}

function encode(img, format) {
  if (format === 'jpeg') {
    // JPEG has no transparency: flatten onto white.
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      if (a < 1) for (let c = 0; c < 3; c++) d[i + c] = Math.round(d[i + c] * a + 255 * (1 - a));
      d[i + 3] = 255;
    }
    return new Uint8Array(jpeg.encode({ data: d, width: img.width, height: img.height }, 92).data);
  }
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return new Uint8Array(PNG.sync.write(png));
}

async function expandInputs(inputs) {
  const files = [];
  for (const input of inputs) {
    const s = await stat(input).catch(() => fail(`not found: ${input}`));
    if (s.isDirectory()) {
      for (const name of (await readdir(input)).sort()) {
        if (/\.(png|jpe?g)$/i.test(name) && !/\.sealed\./i.test(name)) files.push(path.join(input, name));
      }
    } else {
      files.push(input);
    }
  }
  return files;
}

// ---------------- commands ----------------

async function keygen(opts) {
  if (!opts.name) fail('--name is required');
  const pass = await askHidden('New passphrase (min 8 chars): ');
  const again = await askHidden('Repeat passphrase: ');
  if (pass !== again) fail('passphrases do not match');
  const file = await createIdentity({ name: opts.name, contact: opts.contact || '' }, pass);
  const out = opts.out || 'me.inkseal-id.json';
  await writeFile(out, JSON.stringify(file, null, 2), { flag: 'wx' }).catch((e) =>
    fail(e.code === 'EEXIST' ? `${out} already exists, refusing to overwrite` : e.message),
  );
  console.log(`Identity created: ${out}`);
  console.log(`Creator ID: ${file.fingerprint}`);
  console.log('Back this file up and keep the passphrase safe. Publish your Creator ID on your profiles.');
}

async function seal(inputs, opts) {
  if (!opts.id) fail('--id <identity file> is required');
  const files = await expandInputs(inputs);
  if (!files.length) fail('no images to seal');

  let idFile;
  try { idFile = JSON.parse(await readFile(opts.id, 'utf8')); } catch { fail(`cannot read identity file ${opts.id}`); }
  let identity;
  try {
    identity = await unlockIdentity(idFile, await askHidden(`Passphrase for ${idFile.name}: `));
  } catch (e) {
    fail(e.message === 'WRONG_PASSPHRASE' ? 'wrong passphrase' : 'invalid identity file');
  }
  const fp = await fingerprintBytes(identity.publicKeyRaw);

  let signature = null;
  if (opts.signature) signature = decode(new Uint8Array(await readFile(opts.signature)));

  let failures = 0;
  for (const file of files) {
    try {
      const img = decode(new Uint8Array(await readFile(file)));
      const format = opts.format === 'jpg' ? 'jpeg' : opts.format || img.format;

      if (signature) {
        const rect = signatureRect(img.width, img.height, signature.width, signature.height, {
          position: opts.position,
          size: Number(opts.size ?? 0.25),
        });
        drawOver(img, signature, rect, Number(opts.opacity ?? 0.9));
      }

      // Warn when the picture already carries someone else's hidden ID.
      const existing = extractWatermark(img);
      if (existing && existing.fingerprint !== identity.fingerprint) {
        console.warn(`  ! ${file}: already carries another creator's hidden ID ${existing.fingerprint}`);
      }

      let watermark = null;
      if (!opts['no-watermark'] && canHoldWatermark(img.width, img.height)) {
        const strength = opts.strength || 'normal';
        embedWatermark(img, fp, strength);
        watermark = { strength };
      }

      const { bytes } = await sealImage(encode(img, format), identity, {
        title: opts.title ?? path.basename(file).replace(/\.[^.]+$/, ''),
        description: opts.description || '',
        license: opts.license || 'All rights reserved',
        watermark,
      });

      const outDir = opts.out || path.dirname(file);
      const outName = `${path.basename(file).replace(/\.[^.]+$/, '')}.sealed.${format === 'jpeg' ? 'jpg' : 'png'}`;
      const outPath = path.join(outDir, outName);
      await writeFile(outPath, bytes);
      let line = `  ✓ ${outPath}`;

      if (opts.timestamp) {
        try {
          const { proof } = await createTimestampProof(bytes);
          await writeFile(`${outPath}.ots`, proof);
          line += ' (+ .ots)';
        } catch {
          line += ' (timestamp failed)';
        }
      }
      console.log(line);
    } catch (e) {
      failures++;
      console.error(`  ✗ ${file}: ${e.message}`);
    }
  }
  if (failures) process.exitCode = 1;
}

async function verify(inputs) {
  let worst = 0;
  for (const file of inputs) {
    const bytes = new Uint8Array(await readFile(file));
    let result = { status: 'none' };
    let wm = null;
    try {
      if (detectFormat(bytes)) result = await readSeal(bytes);
      wm = extractWatermark(decode(bytes));
    } catch (e) {
      console.log(`${file}\n  cannot read: ${e.message}\n`);
      worst = 2;
      continue;
    }
    const m = result.manifest;
    const mismatch = m && wm && wm.fingerprint !== m.fingerprint;
    const verdict = mismatch
      ? 'WARNING: hidden creator ID does not match the sealer (possible re-sealed stolen work)'
      : {
          valid: 'AUTHENTIC - signature valid, file unmodified',
          modified: 'MODIFIED after sealing - signature genuine but image changed',
          forged: 'FORGED - signature does not check out',
          unreadable: 'DAMAGED seal',
          none: wm ? 'Seal removed, but hidden creator ID found' : 'No Inkseal data found',
        }[result.status];
    worst = Math.max(worst, result.status === 'valid' && !mismatch ? 0 : result.status === 'none' && !wm ? 1 : 2);

    console.log(file);
    console.log(`  ${verdict}`);
    if (m && result.status !== 'forged') {
      console.log(`  creator:    ${m.creator?.name}${m.creator?.contact ? ` (${m.creator.contact})` : ''}`);
      if (m.work?.title) console.log(`  title:      ${m.work.title}`);
      if (m.work?.license) console.log(`  license:    ${m.work.license}`);
      console.log(`  sealed at:  ${m.sealedAt} (stated by creator)`);
      console.log(`  creator ID: ${m.fingerprint}`);
    }
    console.log(`  hidden ID:  ${wm ? `${wm.fingerprint} (clarity ${Math.round(wm.confidence * 100)}%)` : 'not found'}`);
    console.log('');
  }
  process.exitCode = worst;
}

// ---------------- main ----------------

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    contact: { type: 'string' },
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    license: { type: 'string' },
    signature: { type: 'string' },
    position: { type: 'string' },
    size: { type: 'string' },
    opacity: { type: 'string' },
    format: { type: 'string' },
    strength: { type: 'string' },
    'no-watermark': { type: 'boolean' },
    timestamp: { type: 'boolean' },
    out: { type: 'string', short: 'o' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

const [command, ...rest] = positionals;
if (opts.version) console.log(VERSION);
else if (opts.help || !command) console.log(HELP);
else if (command === 'keygen') await keygen(opts);
else if (command === 'seal') await seal(rest, opts);
else if (command === 'verify') await verify(rest);
else fail(`unknown command "${command}". Run inkseal --help`);
