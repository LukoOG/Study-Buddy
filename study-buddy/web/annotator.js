import { sizeCanvas } from './ink.js';

const COLORS = ['#e0302f', '#1f6feb', '#0f7b5f'];
const HAND_FONT = '"Marker Felt", "Comic Sans MS", "Chalkboard SE", cursive';

// Small deterministic wobble so strokes look hand-drawn but don't shimmer on redraw.
const wobble = (t, seed, amp) => amp * (Math.sin(t * 7 + seed) * 0.6 + Math.sin(t * 13 + seed * 2) * 0.4);

function ellipse(box) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const rx = Math.max(box.w / 2 + 10, 16);
  const ry = Math.max(box.h / 2 + 8, 14);
  const seed = Math.random() * 10;
  const start = -2.2;
  const pts = [];
  // A little past a full turn, like a real pen loop.
  for (let a = 0; a <= Math.PI * 2 + 0.45; a += 0.08) {
    const r = 1 + wobble(a, seed, 0.05) + (a / (Math.PI * 2)) * 0.06;
    pts.push({ x: cx + Math.cos(start + a) * rx * r, y: cy + Math.sin(start + a) * ry * r });
  }
  return [pts];
}

function underline(box) {
  const seed = Math.random() * 10;
  const pts = [];
  for (let i = 0; i <= 30; i++) {
    const t = i / 30;
    pts.push({ x: box.x - 4 + t * (box.w + 8), y: box.y + box.h + 4 + wobble(t * 6, seed, 1.6) });
  }
  return [pts];
}

function rect(box) {
  const p = 6;
  const corners = [
    [box.x - p, box.y - p], [box.x + box.w + p, box.y - p],
    [box.x + box.w + p, box.y + box.h + p], [box.x - p, box.y + box.h + p], [box.x - p, box.y - p - 2],
  ];
  const pts = [];
  for (let i = 0; i < corners.length - 1; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[i + 1];
    for (let t = 0; t < 1; t += 0.1) pts.push({ x: ax + (bx - ax) * t + Math.random() - 0.5, y: ay + (by - ay) * t + Math.random() - 0.5 });
  }
  pts.push({ x: corners.at(-1)[0], y: corners.at(-1)[1] });
  return [pts];
}

// Point on the (padded) edge of `box` heading toward (tx, ty).
function edgePoint(box, tx, ty, pad = 8) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  const hw = box.w / 2 + pad;
  const hh = box.h / 2 + pad;
  const s = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity, 1);
  return { x: cx + dx * s, y: cy + dy * s };
}

function arrow(from, to) {
  const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  let a = edgePoint(from, center(to).x, center(to).y);
  let b = edgePoint(to, center(from).x, center(from).y);
  if (Math.hypot(b.x - a.x, b.y - a.y) < 20) {
    // Same or overlapping targets: swoop in from above instead.
    a = { x: b.x - 40, y: b.y - 50 };
  }
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const nx = -(b.y - a.y) / len;
  const ny = (b.x - a.x) / len;
  const c = { x: (a.x + b.x) / 2 + nx * len * 0.2, y: (a.y + b.y) / 2 + ny * len * 0.2 };
  const shaft = [];
  for (let t = 0; t <= 1; t += 0.04) {
    shaft.push({
      x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t ** 2 * b.x,
      y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t ** 2 * b.y,
    });
  }
  const angle = Math.atan2(b.y - c.y, b.x - c.x);
  const head = [-0.45, 0.45].map((d) => [
    { x: b.x - Math.cos(angle + d) * 13, y: b.y - Math.sin(angle + d) * 13 },
    b,
  ]);
  return [shaft, ...head];
}

// The buddy's marker. Each drawing animates in, then stays until cleared.
export class BuddyInk {
  constructor(canvas) {
    this.canvas = canvas;
    this.shapes = [];
    this.colorIndex = 0;
  }

  resize(width, height) {
    this.size = { width, height };
    this.ctx = sizeCanvas(this.canvas, width, height);
    this.redraw();
  }

  clear() {
    this.shapes = [];
    this.colorIndex = 0;
    this.redraw();
  }

  // `resolve` maps a plan anchor ({id} or {at}) to a box in CSS pixels.
  draw(spec, resolve) {
    const color = COLORS[this.colorIndex++ % COLORS.length];
    let shape;
    if (spec.type === 'arrow') {
      shape = { paths: arrow(resolve(spec.from), resolve(spec.to)), color };
    } else {
      const box = resolve(spec.target);
      if (spec.type === 'note') shape = { note: spec.text ?? '', box, color };
      else shape = { paths: { circle: ellipse, underline, box: rect }[spec.type](box), color };
    }
    shape.progress = 0;
    this.shapes.push(shape);
    const duration = shape.note ? 500 + shape.note.length * 40 : 700;
    return new Promise((done) => {
      const start = performance.now();
      const tick = (now) => {
        shape.progress = Math.min(1, (now - start) / duration);
        this.redraw();
        if (shape.progress < 1) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
  }

  redraw() {
    const { ctx } = this;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const shape of this.shapes) {
      ctx.strokeStyle = ctx.fillStyle = shape.color;
      if (shape.note) this.#drawNote(shape);
      else this.#drawPaths(shape);
    }
  }

  #drawPaths({ paths, progress }) {
    const total = paths.reduce((n, p) => n + p.length, 0);
    let budget = Math.ceil(total * progress);
    const { ctx } = this;
    ctx.lineWidth = 3.5;
    for (const path of paths) {
      if (budget <= 1) break;
      const visible = path.slice(0, budget);
      budget -= path.length;
      ctx.beginPath();
      visible.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
  }

  #drawNote({ note, box, progress }) {
    const { ctx } = this;
    ctx.font = `20px ${HAND_FONT}`;
    const text = note.slice(0, Math.ceil(note.length * progress));
    const width = ctx.measureText(note).width;
    // Prefer just above-right of the target; flip inside if it would leave the page.
    let x = box.x + box.w + 8;
    if (x + width > this.size.width - 8) x = Math.max(8, box.x - width - 8);
    const y = box.y > 28 ? box.y - 6 : box.y + box.h + 22;
    // Paper-colored backing keeps the note readable over printed text.
    const color = ctx.fillStyle;
    ctx.fillStyle = 'rgb(255 253 248 / 0.9)';
    ctx.fillRect(x - 4, y - 19, ctx.measureText(text).width + 8, 25);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }
}
