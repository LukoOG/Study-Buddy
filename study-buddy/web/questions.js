// Finds numbered questions on a page ("1.", "2)", "Q3", "Question 4") and the question a
// student names out loud ("question two", "number 5", "the second one"), so Buddy answers the
// question the student means and draws only on it.

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const CARDINALS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const NUM = `(\\d{1,3}|${CARDINALS.join('|')})`;
const toNum = (s) => (/^\d/.test(s) ? Number(s) : CARDINALS.indexOf(s.toLowerCase()) + 1);

// "atomic number 6" or "mass number 12" isn't a question reference.
const SPOKEN_NUMBER = new RegExp(`\\b(?<!(?:atomic|mass|oxidation|quantum|avogadro'?s?)\\s)(?:question|number|no\\.?|q)\\s*${NUM}\\b`, 'i');
const SPOKEN_ORDINAL = new RegExp(`\\b(?:the\\s+)?(${ORDINALS.join('|')})\\s+(?:one|question)\\b`, 'i');
const QUESTION_START = /^(?:(\d{1,3})[.)]|q(\d{1,3})[.):]?|question)$/i;
// "PHYSICS: REFRACTION OF LIGHT" is a heading; "CH3 - CH2 - OH" (no long all-letter word) isn't.
const isHeading = (line) => line.words.every((w) => !/[a-z]/.test(w.text)) && line.words.some((w) => /^[A-Z]{4,}:?$/.test(w.text));

export function spokenQuestionNumber(text) {
  const n = text.match(SPOKEN_NUMBER);
  if (n) return toNum(n[1]);
  const o = text.match(SPOKEN_ORDINAL);
  return o ? ORDINALS.indexOf(o[1].toLowerCase()) + 1 : null;
}

const midY = (b) => b.y + b.h / 2;

export function boundsOf(words) {
  const xs = words.flatMap((w) => [w.box.x, w.box.x + w.box.w]);
  const ys = words.flatMap((w) => [w.box.y, w.box.y + w.box.h]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function groupLines(words) {
  const lines = [];
  for (const w of [...words].sort((a, b) => midY(a.box) - midY(b.box) || a.box.x - b.box.x)) {
    const line = lines.at(-1);
    if (line && Math.abs(midY(w.box) - line.y) < w.box.h * 0.5) line.words.push(w);
    else lines.push({ y: midY(w.box), h: w.box.h, words: [w] });
  }
  for (const line of lines) line.words.sort((a, b) => a.box.x - b.box.x);
  return lines;
}

// A question runs from its numbered line until the next numbered line, a heading, or a big
// vertical gap.
export function findQuestions(words) {
  const questions = [];
  let q = null;
  let lastY = 0;
  for (const line of groupLines(words)) {
    const [first, second] = line.words;
    const m = first.text.match(QUESTION_START);
    const num = m && (m[1] ?? m[2] ?? (second && /^\d{1,3}[.):]?$/.test(second.text) ? parseInt(second.text) : null));
    if (num) {
      q = { num: Number(num), words: [] };
      questions.push(q);
    } else if (q && (isHeading(line) || line.y - lastY > line.h * 3)) {
      q = null;
    }
    if (q) q.words.push(...line.words);
    lastY = line.y;
  }
  for (const it of questions) it.box = boundsOf(it.words);
  return questions;
}
