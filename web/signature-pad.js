// A handwriting pad. Stroke width follows pen pressure when the device reports it,
// otherwise it follows writing speed (fast = thin, slow = thick), like a real nib.

export class SignaturePad {
  constructor(canvas, { color = '#1b2a6b', width = 4 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.color = color;
    this.width = width;
    this.strokes = [];
    this.current = null;
    this.onchange = null;
    this.#resize();
    new ResizeObserver(() => this.#resize()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.#down(e));
    canvas.addEventListener('pointermove', (e) => this.#move(e));
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) canvas.addEventListener(ev, () => this.#up());
  }

  get isEmpty() {
    return this.strokes.length === 0;
  }

  undo() {
    this.strokes.pop();
    this.redraw();
    this.onchange?.();
  }

  clear() {
    this.strokes = [];
    this.redraw();
    this.onchange?.();
  }

  #resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.scale = dpr;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.redraw();
  }

  #point(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp, p: e.pointerType === 'pen' ? e.pressure : null };
  }

  #down(e) {
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch {}
    const pt = this.#point(e);
    pt.w = this.#widthFor(pt, null, this.width);
    this.current = { color: this.color, points: [pt] };
    this.strokes.push(this.current);
    this.redraw();
  }

  #move(e) {
    if (!this.current) return;
    e.preventDefault();
    const coalesced = e.getCoalescedEvents?.() ?? [];
    const events = coalesced.length ? coalesced : [e];
    for (const ev of events) {
      const pt = this.#point(ev);
      const prev = this.current.points.at(-1);
      if (Math.hypot(pt.x - prev.x, pt.y - prev.y) < 1) continue;
      pt.w = this.#widthFor(pt, prev, prev.w);
      this.current.points.push(pt);
    }
    this.redraw();
  }

  #up() {
    if (!this.current) return;
    this.current = null;
    this.onchange?.();
  }

  #widthFor(pt, prev, lastWidth) {
    let target;
    if (pt.p !== null && pt.p > 0) {
      target = this.width * (0.35 + pt.p * 1.3);
    } else if (prev) {
      const speed = Math.hypot(pt.x - prev.x, pt.y - prev.y) / Math.max(1, pt.t - prev.t); // px per ms
      target = this.width * Math.min(1.5, Math.max(0.45, 1.5 - speed * 0.55));
    } else {
      target = this.width;
    }
    return lastWidth * 0.65 + target * 0.35; // smooth width changes
  }

  /** Draw all strokes onto ctx, multiplied by `scale`, shifted by (ox, oy). */
  static render(ctx, strokes, scale, ox = 0, oy = 0) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      const pts = s.points;
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc((pts[0].x - ox) * scale, (pts[0].y - oy) * scale, (pts[0].w / 2) * scale, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      // Smooth curve through midpoints; each segment gets its own width.
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const m0 = i === 1 ? a : { x: (pts[i - 2].x + a.x) / 2, y: (pts[i - 2].y + a.y) / 2 };
        const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        ctx.lineWidth = ((a.w + b.w) / 2) * scale;
        ctx.beginPath();
        ctx.moveTo((m0.x - ox) * scale, (m0.y - oy) * scale);
        ctx.quadraticCurveTo((a.x - ox) * scale, (a.y - oy) * scale, (m1.x - ox) * scale, (m1.y - oy) * scale);
        if (i === pts.length - 1) ctx.lineTo((b.x - ox) * scale, (b.y - oy) * scale);
        ctx.stroke();
      }
    }
  }

  redraw() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    SignaturePad.render(ctx, this.strokes, this.scale);
  }

  /** Export the signature, trimmed to its ink, as a high-resolution transparent canvas. */
  toCanvas(resolution = 4) {
    if (this.isEmpty) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of this.strokes) {
      for (const p of s.points) {
        minX = Math.min(minX, p.x - p.w); minY = Math.min(minY, p.y - p.w);
        maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.w);
      }
    }
    const pad = 4;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const out = document.createElement('canvas');
    out.width = Math.ceil((maxX - minX) * resolution);
    out.height = Math.ceil((maxY - minY) * resolution);
    SignaturePad.render(out.getContext('2d'), this.strokes, resolution, minX, minY);
    return out;
  }
}
