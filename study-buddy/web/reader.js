import * as pdfjs from '/vendor/pdfjs/build/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';

const measure = document.createElement('canvas').getContext('2d');

// pdf.js gives text in runs (often whole lines). Split runs into words so the
// model can point at "CH3" rather than the whole line; word widths are estimated
// with measureText and scaled to the run's real width.
function splitWords(run, firstId) {
  const words = [];
  measure.font = `${run.box.h}px sans-serif`;
  const scale = run.box.w / (measure.measureText(run.text).width || 1);
  let x = run.box.x;
  for (const part of run.text.split(/(\s+)/)) {
    const w = measure.measureText(part).width * scale;
    if (part.trim()) words.push({ id: `t${firstId + words.length}`, text: part, box: { ...run.box, x, w } });
    x += w;
  }
  return words;
}

export class PdfReader {
  constructor(canvas) {
    this.canvas = canvas;
    this.doc = null;
    this.pageNum = 1;
    this.words = [];
  }

  get pageCount() {
    return this.doc?.numPages ?? 0;
  }

  async open(data) {
    this.doc = await pdfjs.getDocument({ data }).promise;
    this.pageNum = 1;
  }

  // Renders the current page at `width` CSS pixels and returns its CSS size.
  async render(width) {
    const page = await this.doc.getPage(this.pageNum);
    const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(viewport.width * dpr);
    this.canvas.height = Math.floor(viewport.height * dpr);
    this.canvas.style.width = `${viewport.width}px`;
    this.canvas.style.height = `${viewport.height}px`;

    this.task?.cancel();
    this.task = page.render({ canvas: this.canvas, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
    await this.task.promise;

    const { items } = await page.getTextContent();
    this.words = [];
    for (const it of items) {
      if (!it.str?.trim()) continue;
      const [x, y] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
      const h = Math.hypot(it.transform[2], it.transform[3]) * viewport.scale;
      const run = { text: it.str, box: { x, y: y - h, w: it.width * viewport.scale, h } };
      this.words.push(...splitWords(run, this.words.length));
    }
    return { width: viewport.width, height: viewport.height };
  }
}
