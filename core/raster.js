// Pixel helpers used where no <canvas> is available (the CLI).

/** Where the visible signature goes. `size` is its width as a fraction of the image width. */
export function signatureRect(imgW, imgH, sigW, sigH, { position = 'br', size = 0.25, margin = 0.03 } = {}) {
  const w = Math.max(1, Math.round(imgW * size));
  const h = Math.max(1, Math.round((w * sigH) / sigW));
  const m = Math.round(Math.min(imgW, imgH) * margin);
  const xs = { l: m, c: Math.round((imgW - w) / 2), r: imgW - w - m };
  const ys = { t: m, c: Math.round((imgH - h) / 2), b: imgH - h - m };
  const [v, hz] = position === 'center' ? ['c', 'c'] : [position[0], position[1]];
  return { x: xs[hz] ?? xs.r, y: ys[v] ?? ys.b, w, h };
}

/** Alpha-composite `src` (RGBA) onto `dst` (RGBA) scaled into rect, with bilinear sampling. */
export function drawOver(dst, src, rect, opacity = 1) {
  const { x: rx, y: ry, w: rw, h: rh } = rect;
  for (let y = 0; y < rh; y++) {
    const dy = ry + y;
    if (dy < 0 || dy >= dst.height) continue;
    const sy = Math.min(src.height - 1, Math.max(0, ((y + 0.5) * src.height) / rh - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < rw; x++) {
      const dx = rx + x;
      if (dx < 0 || dx >= dst.width) continue;
      const sx = Math.min(src.width - 1, Math.max(0, ((x + 0.5) * src.width) / rw - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const fx = sx - x0;
      const px = [0, 0, 0, 0];
      // Premultiplied bilinear sample, so transparent edges do not turn dark.
      for (const [ix, iy, wgt] of [[x0, y0, (1 - fx) * (1 - fy)], [x1, y0, fx * (1 - fy)], [x0, y1, (1 - fx) * fy], [x1, y1, fx * fy]]) {
        const i = (iy * src.width + ix) * 4;
        const a = (src.data[i + 3] / 255) * wgt;
        px[0] += src.data[i] * a;
        px[1] += src.data[i + 1] * a;
        px[2] += src.data[i + 2] * a;
        px[3] += a;
      }
      const a = px[3] * opacity;
      if (a <= 0) continue;
      const o = (dy * dst.width + dx) * 4;
      const da = dst.data[o + 3] / 255;
      const outA = a + da * (1 - a);
      for (let c = 0; c < 3; c++) {
        const s = px[c] / px[3];
        dst.data[o + c] = Math.round((s * a + dst.data[o + c] * da * (1 - a)) / outA);
      }
      dst.data[o + 3] = Math.round(outA * 255);
    }
  }
}
