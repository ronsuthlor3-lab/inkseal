import { detectLanguage, getLanguage, setLanguage, t } from './i18n.js';
import { SignaturePad } from './signature-pad.js';
import { fingerprintBytes } from '../core/bytes.js';
import { detectFormat } from '../core/container.js';
import { createIdentity, supportsEd25519, unlockIdentity } from '../core/identity.js';
import { readSeal, sealImage, VERSION } from '../core/seal.js';
import { createTimestampProof } from '../core/timestamp.js';
import { canHoldWatermark, embedWatermark, extractWatermark } from '../core/watermark.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};
const KEY_IDENTITY = 'inkseal.identity';
const KEY_SIGNATURE = 'inkseal.signature';

const state = {
  identity: null,
  signature: null, // HTMLImageElement
  source: null, // { bitmap, bytes, name, check }
  overlay: { cx: 0.8, cy: 0.88, size: 0.25 },
  verify: null, // last verification, kept so it can be re-rendered on language change
  downloads: [],
};

/** Build DOM safely. Text from files is untrusted, so it only ever goes in as textContent. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

function say(id, key, kind = '', vars) {
  const m = $(id);
  m.textContent = key ? t(key, vars) : '';
  m.className = `msg ${kind}`;
}

function errorKey(err) {
  return {
    WRONG_PASSPHRASE: 'errWrongPass',
    INVALID_IDENTITY: 'errBadIdentity',
    NAME_REQUIRED: 'errName',
    PASSPHRASE_TOO_SHORT: 'errPassShort',
  }[err?.message];
}

function download(bytes, filename, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  state.downloads.push(url);
  return url;
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/\.sealed$/, '');
}

async function decodePixels(blob) {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, c.width, c.height);
}

// ---------------- tabs & language ----------------

function showTab(name) {
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== `tab-${name}`;
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (name === 'seal') drawPreview();
}

function applyLanguage(lang) {
  setLanguage(lang);
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === getLanguage()));
  renderSealWarnings();
  renderVerify();
}

// ---------------- identity ----------------

function renderIdentity() {
  const id = state.identity;
  $('id-active').hidden = !id;
  $('id-forms').hidden = !!id;
  $('seal-need-id').hidden = !!id;
  if (id) {
    $('id-active-name').textContent = id.name;
    $('id-active-fp').textContent = id.fingerprint;
  }
  const saved = savedIdentity();
  $('id-saved').hidden = !!id || !saved;
  if (saved) {
    $('id-saved-name').textContent = saved.name;
    $('id-saved-fp').textContent = saved.fingerprint;
  }
  renderSealWarnings();
}

function savedIdentity() {
  try { return JSON.parse(store.get(KEY_IDENTITY)); } catch { return null; }
}

async function withBusy(form, fn) {
  const buttons = form.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try { await fn(); } finally { buttons.forEach((b) => (b.disabled = false)); }
}

$('form-create').addEventListener('submit', (e) => {
  e.preventDefault();
  const pass = $('new-pass').value;
  if (pass !== $('new-pass2').value) return say('msg-create', 'errPassMismatch', 'error');
  withBusy(e.target, async () => {
    say('msg-create', 'working');
    try {
      const file = await createIdentity({ name: $('new-name').value, contact: $('new-contact').value }, pass);
      const slug = file.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'me';
      download(new TextEncoder().encode(JSON.stringify(file, null, 2)), `inkseal-identity-${slug}.json`, 'application/json');
      state.identity = await unlockIdentity(file, pass);
      e.target.reset();
      say('msg-create', '');
      say('msg-active', 'created', 'ok');
      renderIdentity();
    } catch (err) {
      console.error(err);
      say('msg-create', errorKey(err) || 'errBadIdentity', 'error');
    }
  });
});

$('form-open').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = $('open-file').files[0];
  if (!f) return say('msg-open', 'errNoFile', 'error');
  withBusy(e.target, async () => {
    say('msg-open', 'working');
    try {
      let file;
      try { file = JSON.parse(await f.text()); } catch { throw new Error('INVALID_IDENTITY'); }
      state.identity = await unlockIdentity(file, $('open-pass').value);
      if ($('open-remember').checked) store.set(KEY_IDENTITY, JSON.stringify(file));
      e.target.reset();
      say('msg-open', '');
      renderIdentity();
    } catch (err) {
      say('msg-open', errorKey(err) || 'errBadIdentity', 'error');
    }
  });
});

$('form-saved').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(e.target, async () => {
    say('msg-saved', 'working');
    try {
      state.identity = await unlockIdentity(savedIdentity(), $('saved-pass').value);
      e.target.reset();
      say('msg-saved', '');
      renderIdentity();
    } catch (err) {
      say('msg-saved', errorKey(err) || 'errBadIdentity', 'error');
    }
  });
});

$('id-forget').addEventListener('click', () => {
  store.del(KEY_IDENTITY);
  renderIdentity();
});

$('id-lock').addEventListener('click', () => {
  state.identity = null;
  say('msg-active', '');
  renderIdentity();
});

// ---------------- handwritten signature ----------------

const pad = new SignaturePad($('pad'));

function markSwatch(color) {
  for (const b of $('swatches').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.color === color));
}
$('swatches').addEventListener('click', (e) => {
  const c = e.target.closest('button')?.dataset.color;
  if (!c) return;
  pad.color = c;
  $('pad-color').value = c;
  markSwatch(c);
});
$('pad-color').addEventListener('input', (e) => { pad.color = e.target.value; markSwatch(e.target.value); });
$('pad-width').addEventListener('input', (e) => { pad.width = Number(e.target.value); });
$('pad-undo').addEventListener('click', () => pad.undo());
$('pad-clear').addEventListener('click', () => pad.clear());
markSwatch(pad.color);

async function useSignature(dataUrl, persist) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  state.signature = img;
  $('sig-current').src = dataUrl;
  $('sig-current').hidden = false;
  $('sig-none').hidden = true;
  if (persist) store.set(KEY_SIGNATURE, dataUrl);
  drawPreview();
}

$('pad-save').addEventListener('click', async () => {
  const canvas = pad.toCanvas();
  if (!canvas) return say('msg-sig', 'sigEmpty', 'error');
  await useSignature(canvas.toDataURL('image/png'), true);
  say('msg-sig', 'sigSavedMsg', 'ok');
});

$('sig-upload').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const url = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(f);
  });
  try {
    await useSignature(url, true);
    say('msg-sig', 'sigSavedMsg', 'ok');
  } catch {
    say('msg-sig', 'errImage', 'error');
  }
  e.target.value = '';
});

// ---------------- seal ----------------

function overlayRect(w, h) {
  const sig = state.signature;
  const { cx, cy, size } = state.overlay;
  const rw = w * size;
  const rh = (rw * sig.naturalHeight) / sig.naturalWidth;
  return { x: cx * w - rw / 2, y: cy * h - rh / 2, w: rw, h: rh };
}

function showOverlay() {
  return !!state.signature && $('opt-show-sig').checked;
}

function drawPreview() {
  const src = state.source;
  if (!src) return;
  const canvas = $('seal-preview');
  const maxW = Math.min(1400, src.bitmap.width);
  const scale = maxW / src.bitmap.width;
  canvas.width = Math.round(src.bitmap.width * scale);
  canvas.height = Math.round(src.bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src.bitmap, 0, 0, canvas.width, canvas.height);
  if (showOverlay()) {
    const r = overlayRect(canvas.width, canvas.height);
    ctx.globalAlpha = Number($('opt-opacity').value);
    ctx.drawImage(state.signature, r.x, r.y, r.w, r.h);
    ctx.globalAlpha = 1;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(120,120,120,0.7)';
    ctx.lineWidth = Math.max(1, canvas.width / 600);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.setLineDash([]);
  }
}

function setCorner(pos) {
  const src = state.source;
  if (!src || !state.signature) return;
  const W = src.bitmap.width;
  const H = src.bitmap.height;
  const r = overlayRect(W, H);
  const m = Math.min(W, H) * 0.03;
  const fx = { l: (m + r.w / 2) / W, c: 0.5, r: 1 - (m + r.w / 2) / W };
  const fy = { t: (m + r.h / 2) / H, c: 0.5, b: 1 - (m + r.h / 2) / H };
  const [v, h] = pos === 'center' ? ['c', 'c'] : [pos[0], pos[1]];
  state.overlay.cx = fx[h];
  state.overlay.cy = fy[v];
  drawPreview();
}

// Drag the signature around the preview.
{
  const canvas = $('seal-preview');
  let drag = null;
  const pointFrac = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!showOverlay()) return;
    const p = pointFrac(e);
    const r = overlayRect(1, 1); // in fractions; height is relative to width, fix below
    const ratio = canvas.width / canvas.height;
    const rh = r.h * ratio;
    const inside = Math.abs(p.x - state.overlay.cx) <= r.w / 2 && Math.abs(p.y - state.overlay.cy) <= rh / 2;
    drag = inside ? { dx: state.overlay.cx - p.x, dy: state.overlay.cy - p.y } : { dx: 0, dy: 0 };
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    state.overlay.cx = p.x + drag.dx;
    state.overlay.cy = p.y + drag.dy;
    drawPreview();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = pointFrac(e);
    state.overlay.cx = Math.min(1, Math.max(0, p.x + drag.dx));
    state.overlay.cy = Math.min(1, Math.max(0, p.y + drag.dy));
    drawPreview();
  });
  for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, () => (drag = null));
}

for (const id of ['opt-show-sig', 'opt-opacity']) $(id).addEventListener('input', drawPreview);
$('opt-size').addEventListener('input', (e) => { state.overlay.size = Number(e.target.value); drawPreview(); });
for (const b of document.querySelectorAll('[data-pos]')) b.addEventListener('click', () => setCorner(b.dataset.pos));
$('opt-wm').addEventListener('change', (e) => { $('opt-strength').disabled = !e.target.checked; });

async function loadSource(file) {
  say('msg-seal', '');
  $('seal-result').hidden = true;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const bitmap = await createImageBitmap(file);
    state.source?.bitmap.close();
    state.source = { bitmap, bytes, name: file.name, check: null };
  } catch {
    $('seal-work').hidden = true;
    state.source = null;
    return say('msg-seal', 'errImage', 'error');
  }
  $('seal-work').hidden = false;
  $('opt-title').value = baseName(file.name);
  const small = !canHoldWatermark(state.source.bitmap.width, state.source.bitmap.height);
  $('opt-wm').disabled = small;
  $('opt-wm').checked = !small;
  $('opt-strength').disabled = small;
  if (state.signature) setCorner('br');
  drawPreview();

  // Look for someone else's seal or hidden ID before the user seals it as their own.
  const src = state.source;
  const check = { small };
  try { if (detectFormat(src.bytes)) check.seal = await readSeal(src.bytes); } catch {}
  try { check.watermark = extractWatermark(await decodePixels(file)); } catch {}
  if (state.source === src) {
    src.check = check;
    renderSealWarnings();
  }
}

function renderSealWarnings() {
  const box = $('seal-warnings');
  box.replaceChildren();
  const check = state.source?.check;
  if (!check) return;
  const mine = state.identity?.fingerprint;
  const seal = check.seal;
  if (seal?.manifest && ['valid', 'modified'].includes(seal.status) && seal.manifest.fingerprint !== mine) {
    box.append(el('div', { class: 'banner warn' }, t('warnOtherSeal', { name: seal.manifest.creator?.name || '?', fp: seal.manifest.fingerprint })));
  }
  if (check.watermark && check.watermark.fingerprint !== mine) {
    box.append(el('div', { class: 'banner warn' }, t('warnOtherWatermark', { fp: check.watermark.fingerprint })));
  }
  if (check.small) box.append(el('div', { class: 'banner warn' }, t('warnSmall')));
}

function bindDrop(zone, input, onFile) {
  input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  });
}
bindDrop($('seal-drop'), $('seal-file'), loadSource);

$('form-seal').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!state.identity) {
    showTab('identity');
    return;
  }
  if (!state.source) return;
  withBusy(e.target, async () => {
    say('msg-seal', 'working');
    $('seal-result').hidden = true;
    try {
      await seal();
    } catch (err) {
      console.error(err);
      say('msg-seal', 'errImage', 'error');
    }
  });
});

async function seal() {
  const { bitmap, name } = state.source;
  const format = $('opt-format').value;
  const W = bitmap.width;
  const H = bitmap.height;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (format === 'jpeg') {
    ctx.fillStyle = '#ffffff'; // JPEG has no transparency
    ctx.fillRect(0, 0, W, H);
  }
  ctx.drawImage(bitmap, 0, 0);
  if (showOverlay()) {
    const r = overlayRect(W, H);
    ctx.globalAlpha = Number($('opt-opacity').value);
    ctx.drawImage(state.signature, r.x, r.y, r.w, r.h);
    ctx.globalAlpha = 1;
  }

  let watermark = null;
  if ($('opt-wm').checked && canHoldWatermark(W, H)) {
    const strength = $('opt-strength').value;
    const pixels = ctx.getImageData(0, 0, W, H);
    embedWatermark(pixels, await fingerprintBytes(state.identity.publicKeyRaw), strength);
    ctx.putImageData(pixels, 0, 0);
    watermark = { strength };
  }

  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise((res) => canvas.toBlob(res, mime, 0.92));
  const encoded = new Uint8Array(await blob.arrayBuffer());
  const { bytes } = await sealImage(encoded, state.identity, {
    title: $('opt-title').value.trim(),
    description: $('opt-desc').value.trim(),
    license: $('opt-license').value,
    watermark,
  });

  for (const u of state.downloads) URL.revokeObjectURL(u);
  state.downloads = [];
  const outName = `${baseName(name)}.sealed.${format === 'jpeg' ? 'jpg' : 'png'}`;
  const imgUrl = download(bytes, outName, mime);
  $('dl-image').href = imgUrl;
  $('dl-image').download = outName;
  $('dl-ots').hidden = true;
  say('msg-seal', '');

  if ($('opt-ts').checked) {
    say('msg-seal', 'working');
    try {
      const { proof } = await createTimestampProof(bytes);
      const otsUrl = download(proof, `${outName}.ots`, 'application/octet-stream');
      $('dl-ots').href = otsUrl;
      $('dl-ots').download = `${outName}.ots`;
      $('dl-ots').hidden = false;
      say('msg-seal', '');
    } catch (err) {
      console.error(err);
      say('msg-seal', 'sealTsFailed', 'error');
    }
  }
  $('seal-result').hidden = false;
}

// ---------------- verify ----------------

bindDrop($('verify-drop'), $('verify-file'), verifyFile);

async function verifyFile(file) {
  $('verify-report').replaceChildren(el('p', { class: 'muted' }, t('working')));
  const bytes = new Uint8Array(await file.arrayBuffer());
  let seal = { status: 'none' };
  if (detectFormat(bytes)) {
    try { seal = await readSeal(bytes); } catch { seal = { status: 'unreadable' }; }
  }
  let watermark = null;
  try { watermark = extractWatermark(await decodePixels(file)); } catch {}
  if (state.verify?.thumb) URL.revokeObjectURL(state.verify.thumb);
  state.verify = { seal, watermark, thumb: URL.createObjectURL(file) };
  renderVerify();
}

function renderVerify() {
  const v = state.verify;
  const box = $('verify-report');
  if (!v) return;
  const { seal, watermark } = v;
  const m = seal.manifest;
  const mismatch = m && watermark && watermark.fingerprint !== m.fingerprint;

  let kind, title, text;
  if (seal.status === 'valid' && !mismatch) [kind, title, text] = ['ok', t('vValid'), t('vValidText')];
  else if (mismatch) [kind, title, text] = ['bad', t('vMismatch'), t('vMismatchText', { wm: watermark.fingerprint, fp: m.fingerprint })];
  else if (seal.status === 'modified') [kind, title, text] = ['warn', t('vModified'), t('vModifiedText')];
  else if (seal.status === 'forged') [kind, title, text] = ['bad', t('vForged'), t('vForgedText')];
  else if (seal.status === 'unreadable') [kind, title, text] = ['bad', t('vUnreadable'), t('vUnreadableText')];
  else if (watermark) [kind, title, text] = ['info', t('vStripped'), t('vStrippedText')];
  else [kind, title, text] = ['none', t('vNone'), t('vNoneText')];

  const rows = [];
  const row = (label, ...value) => rows.push(el('dt', {}, label), el('dd', {}, ...value));
  if (m && seal.status !== 'forged') {
    row(t('vCreator'), m.creator?.name || '—');
    if (m.creator?.contact) row(t('vContact'), m.creator.contact);
    if (m.work?.title) row(t('vWork'), m.work.title);
    if (m.work?.description) row(t('vDescription'), m.work.description);
    if (m.work?.license) row(t('vLicense'), m.work.license);
    const when = new Date(m.sealedAt);
    row(t('vSealedAt'), isNaN(when) ? String(m.sealedAt) : when.toLocaleString(getLanguage() === 'th' ? 'th-TH' : 'en-GB'), ' ', el('span', { class: 'muted small' }, t('vSealedAtNote')));
    row(t('vCreatorId'), el('code', {}, m.fingerprint));
  }
  row(
    t('vHiddenId'),
    watermark
      ? [el('code', {}, watermark.fingerprint), ` (${t('vConfidence')} ${Math.round(watermark.confidence * 100)}%)`]
      : t('vNotFound'),
  );
  if (m?.publicKey && seal.status !== 'forged') row(t('vPublicKey'), el('code', { class: 'small' }, m.publicKey));

  box.replaceChildren(
    el('div', { class: `report ${kind}` }, el('h3', {}, title), el('p', {}, text)),
    el('img', { class: 'verify-thumb checker', src: v.thumb, alt: '' }),
    el('div', { class: 'card' }, el('dl', { class: 'details' }, rows)),
    el('p', { class: 'muted small' }, t('vOts'), ' ', el('a', { href: 'https://opentimestamps.org', target: '_blank', rel: 'noopener' }, 'opentimestamps.org')),
  );
}

// ---------------- start ----------------

for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));
for (const b of document.querySelectorAll('[data-lang]')) b.addEventListener('click', () => applyLanguage(b.dataset.lang));
window.addEventListener('hashchange', () => showTab(location.hash.slice(1) || 'identity'));

$('version').textContent = VERSION;
applyLanguage(detectLanguage());
const initialTab = location.hash.slice(1);
showTab(['identity', 'signature', 'seal', 'verify'].includes(initialTab) ? initialTab : 'identity');
renderIdentity();
const savedSig = store.get(KEY_SIGNATURE);
if (savedSig) useSignature(savedSig, false).catch(() => store.del(KEY_SIGNATURE));
else $('sig-current').hidden = true;
supportsEd25519().then((ok) => { $('unsupported').hidden = ok; });
