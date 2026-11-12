import { PdfReader } from './reader.js';
import { StudentInk } from './ink.js';
import { BuddyInk } from './annotator.js';
import { speak, stopSpeaking, prefetch, useServerVoice, encodeWav } from './voice.js';
import { createListener } from './listen.js';
import { parseUtterance } from './wake.js';
import { findQuestions, spokenQuestionNumber, boundsOf } from './questions.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const video = $('video');
const caption = $('caption');
const questionInput = $('questionInput');

const ACKS = ['Okay, let me see.', 'Alright, one second.', 'Hmm, let me look at this.'];
const MAX_ITEMS = 250;
const FOLLOW_UP_MS = 8000; // after Buddy answers, no wake phrase needed for this long
const POINTER_LOOKBACK_MS = 1500; // pointer positions this long before speech still count

const reader = new PdfReader($('page'));
const buddy = new BuddyInk($('buddyInk'));
const student = new StudentInk($('studentInk'), {
  onStrokeStart() {
    video.pause();
    // First mark after an answer starts a fresh question.
    if (answered) {
      student.clear();
      buddy.clear();
      answered = false;
    }
  },
});

let mode = null; // 'pdf' | 'video'
let mediaSize = { width: 0, height: 0 };
let answered = false;
let history = []; // [{q, a}] recent turns, so follow-ups like "and the next one?" make sense
let lastFocus = null; // {page, num} of the question Buddy last explained, for follow-ups

// Voice loop state. phase: off | idle | hearing | awake | thinking | speaking
let listener = null;
let phase = 'off';
let awakeUntil = 0;
let speechStartedAwake = false;
let speechStartedAt = 0;
let current = null; // AbortController of the answer in progress
let transcribing = Promise.resolve();

const PHASE_LABELS = {
  off: 'Start listening',
  idle: 'Say “Hey Buddy…”',
  hearing: 'Hearing you…',
  awake: 'I’m listening…',
  thinking: 'Thinking…',
  speaking: 'Say “Buddy, wait” to interrupt',
};

function setPhase(next) {
  phase = next;
  $('listenBtn').dataset.phase = next;
  $('listenLabel').textContent = PHASE_LABELS[next];
}

const busy = () => phase === 'thinking' || phase === 'speaking';
const stageWidth = () => Math.min($('stageWrap').clientWidth - 32, 960);
const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

function showCaption(text, thinking = false) {
  caption.hidden = false;
  caption.textContent = text;
  caption.classList.toggle('thinking', thinking);
}

// ---------- Media ----------

function layout(size) {
  mediaSize = size;
  student.resize(size.width, size.height);
  buddy.resize(size.width, size.height);
}

function setPen(on) {
  $('penBtn').setAttribute('aria-pressed', String(on));
  $('studentInk').classList.toggle('off', !on);
  stage.classList.toggle('pen', on);
  if (on) video.pause();
}

function resetMarks() {
  student.clear();
  buddy.clear();
  answered = false;
}

function showMedia(kind) {
  mode = kind;
  history = [];
  lastFocus = null;
  $('empty').hidden = true;
  stage.hidden = false;
  $('page').hidden = kind !== 'pdf';
  video.hidden = kind !== 'video';
  $('pager').hidden = kind !== 'pdf';
  resetMarks();
  // Video controls need clicks, so the marker starts off there.
  setPen(kind === 'pdf');
}

async function renderPdf() {
  // Clear before rendering, so marks made while the page loads aren't wiped afterwards.
  resetMarks();
  try {
    layout(await reader.render(stageWidth()));
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') throw err;
  }
  $('pageLabel').textContent = `${reader.pageNum} / ${reader.pageCount}`;
}

async function openPdf(data) {
  interrupt();
  if (video.src) URL.revokeObjectURL(video.src);
  video.removeAttribute('src');
  showMedia('pdf');
  await reader.open(data);
  await renderPdf();
}

function layoutVideo() {
  const width = stageWidth();
  const height = Math.round((width * video.videoHeight) / video.videoWidth);
  video.style.width = `${width}px`;
  video.style.height = `${height}px`;
  layout({ width, height });
}

function openVideo(file) {
  interrupt();
  if (video.src) URL.revokeObjectURL(video.src);
  showMedia('video');
  video.src = URL.createObjectURL(file);
}

// ---------- What the student is asking about ----------

// Pointer/finger positions over the page, so "what is this?" while pointing works without circling.
const pointerTrail = [];
function trackPointer(e) {
  const r = stage.getBoundingClientRect();
  pointerTrail.push({ x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() });
  if (pointerTrail.length > 200) pointerTrail.splice(0, 100);
}
stage.addEventListener('pointermove', trackPointer, { capture: true });
stage.addEventListener('pointerdown', trackPointer, { capture: true });

function pointerFocus(since) {
  const p = pointerTrail.findLast((pt) => pt.t >= since);
  if (!p || p.x < 0 || p.y < 0 || p.x > mediaSize.width || p.y > mediaSize.height) return null;
  if (mode === 'pdf') {
    // Snap to the line of text under the pointer.
    const near = reader.words
      .map((w) => ({ w, d: Math.hypot(center(w.box).x - p.x, center(w.box).y - p.y) }))
      .filter((n) => n.d < 60)
      .sort((a, b) => a.d - b.d)[0];
    if (near) {
      return boundsOf(
        reader.words.filter(
          (w) => Math.abs(center(w.box).y - center(near.w.box).y) < near.w.box.h * 0.6 && Math.abs(center(w.box).x - p.x) < 220,
        ),
      );
    }
  }
  return { x: p.x - 120, y: p.y - 70, w: 240, h: 140 };
}

// Circled strokes win; otherwise wherever the student was pointing while they spoke.
function currentSelection(pointerSince) {
  return student.bounds() ?? (pointerSince == null ? null : pointerFocus(pointerSince));
}

function clampToMedia(b) {
  const x = Math.max(0, b.x);
  const y = Math.max(0, b.y);
  return { x, y, w: Math.min(mediaSize.width, b.x + b.w) - x, h: Math.min(mediaSize.height, b.y + b.h) - y };
}

// Which numbered question the student means: one they name ("question 2"), else the one they
// point at or circle, else (in a follow-up) the one Buddy just explained.
function focusQuestion(question, sel, followUp) {
  if (mode !== 'pdf') return null;
  const questions = findQuestions(reader.words);
  const named = spokenQuestionNumber(question);
  if (named) return questions.find((q) => q.num === named) ?? null;
  if (sel) {
    const c = center(sel);
    return questions.find((q) => intersects(q.box, { x: c.x, y: c.y, w: 1, h: 1 })) ?? questions.find((q) => intersects(q.box, sel)) ?? null;
  }
  if (followUp && lastFocus?.page === reader.pageNum) return questions.find((q) => q.num === lastFocus.num) ?? null;
  return null;
}

// What the model gets. With a focused question, only that question's words, so a small model can't
// answer (or draw on) the wrong one; it's also a much shorter prompt. The image crop is only built
// when the text can't answer (video, diagrams), since images are the slowest part of a prompt.
function selectionContext(sel, focus) {
  const pad = 24;
  const target = focus?.box ?? sel;
  const region = target
    ? clampToMedia({ x: target.x - pad, y: target.y - pad, w: target.w + pad * 2, h: target.h + pad * 2 })
    : { x: 0, y: 0, w: mediaSize.width, h: mediaSize.height };

  let items = [];
  if (focus) {
    const pointed = sel ? focus.words.filter((w) => intersects(w.box, sel)) : [];
    const marked = new Set(pointed.length ? pointed : focus.words);
    items = focus.words.map((w) => ({ id: w.id, text: w.text, circled: marked.has(w) }));
  } else if (mode === 'pdf') {
    const near = sel ? { x: 0, y: region.y - 120, w: mediaSize.width, h: region.h + 240 } : region;
    let words = reader.words.filter((w) => intersects(w.box, near));
    if (words.length > MAX_ITEMS) {
      const c = center(region);
      const dist = (w) => Math.hypot(center(w.box).x - c.x, center(w.box).y - c.y);
      const keep = new Set(words.toSorted((a, b) => dist(a) - dist(b)).slice(0, MAX_ITEMS));
      words = words.filter((w) => keep.has(w));
    }
    items = words.map((w) => ({ id: w.id, text: w.text, circled: !!sel && intersects(w.box, sel) }));
  }

  const boxes = new Map(reader.words.map((w) => [w.id, w.box]));
  const resolve = (anchor) => {
    if (anchor.id && boxes.has(anchor.id)) return boxes.get(anchor.id);
    const [fx, fy] = anchor.at ?? [0.5, 0.5];
    return { x: region.x + fx * region.w, y: region.y + fy * region.h, w: 0, h: 0 };
  };
  const selected = !!target;
  const needsImage = selected ? !items.some((it) => it.circled) : items.length === 0;
  return { items, selected, image: needsImage ? cropImage(region) : null, resolve };
}

function cropImage(r) {
  const src = mode === 'pdf' ? $('page') : video;
  const k = (mode === 'pdf' ? src.width : video.videoWidth) / mediaSize.width; // CSS px -> source px
  const s = Math.min(3, 896 / Math.max(r.w * k, r.h * k)); // vision encoders like ~900px images
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(r.w * k * s));
  out.height = Math.max(1, Math.round(r.h * k * s));
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.85);
}

// ---------- Answering ----------

async function* ndjson(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) yield JSON.parse(line);
    }
  }
}

// Pulls a stream eagerly, calling onItem as each item arrives, while the consumer takes its time.
async function* readAhead(source, onItem) {
  const queue = [];
  let done = false;
  let error = null;
  let wake = null;
  (async () => {
    try {
      for await (const item of source) {
        onItem(item);
        queue.push(item);
        wake?.();
      }
    } catch (err) {
      error = err;
    }
    done = true;
    wake?.();
  })();
  for (;;) {
    if (queue.length) yield queue.shift();
    else if (error) throw error;
    else if (done) return;
    else await new Promise((r) => (wake = r));
  }
}

function interrupt() {
  current?.abort();
  current = null;
  stopSpeaking();
}

function listenForFollowUp() {
  awakeUntil = Date.now() + FOLLOW_UP_MS;
  setPhase(listener ? 'awake' : 'off');
}

async function ask(question, sel, followUp = false) {
  if (!mode) {
    showCaption('Open a PDF or a video first, then point at what you need help with.');
    return speak('Open a PDF or a video first.');
  }
  interrupt();
  const controller = new AbortController();
  current = controller;
  const { signal } = controller;
  setPhase('thinking');
  buddy.clear();
  const focus = focusQuestion(question, sel, followUp);
  const ctx = selectionContext(sel, focus);
  showCaption(`“${question}”`, true);
  const ack = speak(ACKS[Math.floor(Math.random() * ACKS.length)]);
  const said = [];

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question,
        history,
        source: mode,
        items: ctx.items,
        image: ctx.image,
        selection: ctx.selected,
        focus: focus?.num,
      }),
    });
    await ack;
    // Steps stream in; each one's drawings play while its sentence is spoken. Reading ahead lets
    // the next sentence's audio be fetched while the current one plays.
    for await (const msg of readAhead(ndjson(res.body), (m) => m.step && prefetch(m.step.say))) {
      if (signal.aborted) return;
      if (msg.error) throw new Error(msg.error);
      if (!msg.step) continue;
      setPhase('speaking');
      showCaption(msg.step.say);
      said.push(msg.step.say);
      await Promise.all([
        speak(msg.step.say),
        (async () => {
          for (const d of msg.step.draw) {
            if (signal.aborted) return;
            await buddy.draw(d, ctx.resolve);
          }
        })(),
      ]);
    }
    if (signal.aborted) return;
    history = [...history, { q: question, a: said.join(' ') }].slice(-3);
    lastFocus = focus ? { page: reader.pageNum, num: focus.num } : null;
    answered = true;
    current = null;
    listenForFollowUp();
  } catch (err) {
    if (signal.aborted) return;
    current = null;
    showCaption(`Something went wrong: ${err.message}`);
    setPhase(listener ? 'idle' : 'off');
  }
}

// ---------- Listening ----------

async function transcribe(audio) {
  const res = await fetch('/api/transcribe', { method: 'POST', body: encodeWav(audio) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data.text;
}

function onSpeechStart() {
  speechStartedAt = performance.now();
  speechStartedAwake = phase === 'awake' && Date.now() < awakeUntil;
  // While Buddy talks, its own voice can trigger the VAD; leave the phase alone then.
  if (!busy()) setPhase('hearing');
}

function onMisfire() {
  if (phase === 'hearing') setPhase(speechStartedAwake ? 'awake' : 'idle');
}

// Each utterance needs "Hey Buddy" unless it starts inside the follow-up window.
// While Buddy is talking, only "Buddy, …" gets through: that is the interrupt.
async function handleUtterance(audio, awake, pointerSince) {
  const text = await transcribe(audio);
  if (!text) return;
  const { woke, rest, stop } = parseUtterance(text);
  if (!woke && !awake) {
    $('heard').textContent = `Heard “${text}” (say “Hey Buddy” first)`;
    if (phase === 'hearing') setPhase('idle');
    return;
  }
  $('heard').textContent = `Heard “${text}”`;
  if (busy()) interrupt();
  if (stop) {
    setPhase('idle');
    return speak('Okay.');
  }
  if (!rest) {
    speak('Yes?');
    return listenForFollowUp();
  }
  ask(rest, currentSelection(pointerSince), awake); // not awaited, so the next utterance can interrupt it
}

function onUtterance(audio) {
  const awake = speechStartedAwake;
  const pointerSince = speechStartedAt - POINTER_LOOKBACK_MS;
  // Transcribe in order, but never wait on an answer.
  transcribing = transcribing
    .then(() => handleUtterance(audio, awake, pointerSince))
    .catch((err) => showCaption(`Couldn't hear that: ${err.message}`));
}

async function toggleListening() {
  if (listener && phase !== 'off') {
    await listener.pause();
    interrupt();
    return setPhase('off');
  }
  try {
    listener ??= await createListener({ onSpeechStart, onUtterance, onMisfire });
    await listener.start();
    setPhase('idle');
  } catch (err) {
    showCaption(`Microphone unavailable: ${err.message}`);
  }
}

setInterval(() => {
  if (phase === 'awake' && Date.now() > awakeUntil) setPhase('idle');
}, 500);

async function refreshStatus() {
  let s;
  try {
    s = await (await fetch('/api/status')).json();
  } catch {
    s = { llm: { up: false }, stt: { up: false } };
  }
  const serverVoice = !!(s.tts?.server && s.tts.up);
  useServerVoice(serverVoice);
  $('status').textContent = `${s.llm.up ? `Model: ${s.llm.name}` : 'Demo mode (no model)'} · ${s.stt.up ? 'Hearing on' : 'Hearing off'} · Voice: ${serverVoice ? s.tts.name : 'device'}`;
}

// ---------- Wiring ----------

$('listenBtn').addEventListener('click', toggleListening);
$('pdfInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) await openPdf(new Uint8Array(await file.arrayBuffer()));
  e.target.value = '';
});
$('videoInput').addEventListener('change', (e) => {
  if (e.target.files[0]) openVideo(e.target.files[0]);
  e.target.value = '';
});
$('sampleBtn').addEventListener('click', async () => {
  const res = await fetch('/samples/practice.pdf');
  await openPdf(new Uint8Array(await res.arrayBuffer()));
});
$('prevBtn').addEventListener('click', () => reader.pageNum > 1 && (reader.pageNum--, renderPdf()));
$('nextBtn').addEventListener('click', () => reader.pageNum < reader.pageCount && (reader.pageNum++, renderPdf()));
$('penBtn').addEventListener('click', () => setPen($('penBtn').getAttribute('aria-pressed') !== 'true'));
$('clearBtn').addEventListener('click', resetMarks);
$('askForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = questionInput.value.trim();
  questionInput.value = '';
  if (q) ask(q, currentSelection(null));
});
video.addEventListener('loadedmetadata', layoutVideo);
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && e.target !== questionInput) {
    e.preventDefault();
    $('askForm').hidden = !$('askForm').hidden;
    if (!$('askForm').hidden) questionInput.focus();
  }
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (mode === 'pdf') renderPdf();
    else if (mode === 'video' && video.videoWidth) layoutVideo();
  }, 200);
});

refreshStatus();
setInterval(refreshStatus, 5000);

// Exposed for automated testing: pretend the mic is on and feed utterances as if it heard them.
window.studyBuddy = {
  onSpeechStart,
  onUtterance,
  currentSelection,
  fakeListener() {
    listener = { start() {}, pause() {} };
    setPhase('idle');
  },
  get phase() {
    return phase;
  },
  get history() {
    return history;
  },
};
