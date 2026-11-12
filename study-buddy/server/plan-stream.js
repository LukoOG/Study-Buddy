// Pulls each finished step out of a partially generated plan document,
// {"working": "...", "steps": [{...}, {...}, ...]}, so Buddy can start talking
// while later steps are still being generated.
export class StepExtractor {
  constructor() {
    this.text = '';
    this.pos = -1; // index just past the last consumed step, once "steps": [ has appeared
  }

  push(delta) {
    this.text += delta;
    const steps = [];
    if (this.pos < 0) {
      const m = /"steps"\s*:\s*\[/.exec(this.text);
      if (!m) return steps;
      this.pos = m.index + m[0].length;
    }
    for (;;) {
      const start = this.text.indexOf('{', this.pos);
      const end = start < 0 ? -1 : closingBrace(this.text, start);
      if (end < 0) return steps;
      steps.push(JSON.parse(this.text.slice(start, end + 1)));
      this.pos = end + 1;
    }
  }
}

function closingBrace(s, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}
