// Shared canvas sizing for both overlays: CSS size + device-pixel backing store.
export function sizeCanvas(canvas, width, height) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// The student's highlighter. Strokes are kept in CSS pixels so they survive resizes.
export class StudentInk {
  constructor(canvas, { onStrokeStart } = {}) {
    this.canvas = canvas;
    this.strokes = [];
    this.onStrokeStart = onStrokeStart;
    canvas.addEventListener('pointerdown', (e) => this.#down(e));
    canvas.addEventListener('pointermove', (e) => this.#move(e));
    canvas.addEventListener('pointerup', () => (this.current = null));
    canvas.addEventListener('pointercancel', () => (this.current = null));
  }

  resize(width, height) {
    this.ctx = sizeCanvas(this.canvas, width, height);
    this.redraw();
  }

  clear() {
    this.strokes = [];
    this.redraw();
  }

  // Bounding box of everything the student marked, or null.
  bounds() {
    const pts = this.strokes.flat();
    if (!pts.length) return null;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  #point(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  #down(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.onStrokeStart?.();
    this.current = [this.#point(e)];
    this.strokes.push(this.current);
  }

  #move(e) {
    if (!this.current) return;
    this.current.push(this.#point(e));
    this.redraw();
  }

  redraw() {
    const { ctx } = this;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.strokeStyle = 'rgb(255 200 0 / 0.55)';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of this.strokes) {
      ctx.beginPath();
      stroke.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
  }
}
