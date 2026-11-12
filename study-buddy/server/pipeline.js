import { StepExtractor } from './plan-stream.js';

const SYSTEM = `You are Buddy, a friendly study partner sitting beside a Nigerian secondary school student preparing for WAEC and JAMB.
The student pointed at or circled part of their study material and asked a question out loud. Explain it the way a smart
friend would with a marker in hand: short spoken sentences, one idea per step, and a drawing on their material for each step.

Rules:
- 2 to 6 steps. Each "say" is one or two short sentences, written to be spoken aloud (no markdown, no LaTeX, no symbols
  a voice can't read; say "squared", "degrees", "divided by").
- Draw on the material itself. Point at text using its id (like "t12"). Text marked [CIRCLED] is what the student marked.
- For things only visible in the image (diagrams, structures, video frames), use "at": [x, y] as fractions 0..1 of the attached image.
- Draw types: circle (around something), underline, box, arrow (from -> to), note (a short handwritten label, max 4 words).
- Be correct. Use WAEC/JAMB conventions (e.g. IUPAC naming, SI units). If you are unsure, say so honestly.
- First solve the problem carefully in "working" (count atoms, write equations, check units). The student never sees it.
  Keep it brief. Then write the steps, which must agree with your working.

Example. Text: t1: "2", t2: "H2", t3: "+", t4: "O2", t5: "->", t6: "2", t7: "H2O". Student asks: why is there a 2 in front?
{"working": "Right side 2 H2O has 2 O; left O2 has 2 O. Hydrogen: 2 H2O has 4 H, so need 2 H2 on left.",
 "steps": [
  {"say": "Count the oxygen first. O2 gives us two oxygen atoms.", "draw": [{"type": "circle", "target": {"id": "t4"}}]},
  {"say": "So we need two water molecules on the right to use both oxygens.", "draw": [{"type": "arrow", "from": {"id": "t4"}, "to": {"id": "t7"}}, {"type": "circle", "target": {"id": "t6"}}]},
  {"say": "Now there are four hydrogens on the right, so we need 2 H2 on the left.", "draw": [{"type": "underline", "target": {"id": "t2"}}, {"type": "note", "target": {"id": "t1"}, "text": "4 H each side"}]}
 ]}`;

const point = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
const anchor = { type: 'object', properties: { id: { type: 'string' }, at: point } };

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    // Generated first, so the model reasons before it explains.
    working: { type: 'string' },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          say: { type: 'string' },
          draw: {
            type: 'array',
            minItems: 1,
            maxItems: 3,
            items: {
              type: 'object',
              properties: {
                type: { enum: ['circle', 'underline', 'box', 'arrow', 'note'] },
                target: anchor,
                from: anchor,
                to: anchor,
                text: { type: 'string' },
              },
              required: ['type'],
            },
          },
        },
        required: ['say', 'draw'],
      },
    },
  },
  required: ['working', 'steps'],
};

function describeItems(items) {
  if (!items.length) return 'No selectable text here; rely on the image.';
  return items.map((it) => `${it.id}: ${JSON.stringify(it.text)}${it.circled ? ' [CIRCLED]' : ''}`).join('\n');
}

function describeHistory(history) {
  if (!history.length) return '';
  const turns = history.map((h) => `Student: ${h.q}\nBuddy: ${h.a}`).join('\n');
  return `Earlier in this conversation:\n${turns}\n\n`;
}

function validAnchor(anchor, ids) {
  if (!anchor) return false;
  if (anchor.id) return ids.has(anchor.id);
  return Array.isArray(anchor.at) && anchor.at.every((v) => v >= 0 && v <= 1);
}

// Small models invent ids or coordinates; drop drawings we can't place rather than draw in the wrong spot.
function cleanStep(step, ids) {
  return {
    say: step.say,
    draw: (step.draw ?? []).filter((d) =>
      d.type === 'arrow' ? validAnchor(d.from, ids) && validAnchor(d.to, ids) : validAnchor(d.target, ids),
    ),
  };
}

// Images are the slowest part of a prompt (most of the tokens), so only send one when the text
// layer can't answer: video frames, or a marked area with no text in it (a diagram).
function needsImage({ image, items, selection }, llm) {
  if (!image || !llm.vision) return false;
  return selection ? !items.some((it) => it.circled) : items.length === 0;
}

// Lets the UI be exercised before any model is running.
async function* mockSteps(items) {
  const circled = items.filter((it) => it.circled);
  const first = circled[0] ?? items[0];
  const last = circled.at(-1) ?? first;
  const target = first ? { id: first.id } : { at: [0.5, 0.5] };
  const steps = [
    { say: 'Okay, I see what you mean.', draw: [{ type: 'circle', target }] },
    {
      say: 'This is a demo answer, because the local model is not running yet.',
      draw: [{ type: 'arrow', from: target, to: last ? { id: last.id } : { at: [0.8, 0.8] } }],
    },
    { say: 'Start the model server and ask me again.', draw: [{ type: 'note', target, text: 'model offline' }] },
  ];
  for (const step of steps) {
    await new Promise((r) => setTimeout(r, 300));
    yield step;
  }
}

// Yields cleaned steps one by one as the model finishes each of them.
export async function* askStream({ llm, llmUp, question, history = [], source, items = [], image, selection, focus, signal }) {
  if (!llmUp) return yield* mockSteps(items);

  const material = source === 'video' ? 'a paused video frame' : 'a PDF page';
  // With a focus, the client sends only that question's text, so say so plainly.
  const textLabel = focus ? `Question ${focus} (the student is asking about this one; answer only it):` : 'Text on the material:';
  const content = [
    {
      type: 'text',
      text: `${describeHistory(history.slice(-3))}Material: ${material}\n${textLabel}\n${describeItems(items)}\n\nStudent asks: ${question}`,
    },
  ];
  if (needsImage({ image, items, selection }, llm)) content.push({ type: 'image_url', image_url: { url: image } });

  const ids = new Set(items.map((it) => it.id));
  const extractor = new StepExtractor();
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content },
  ];
  for await (const delta of llm.streamJson({ messages, schema: PLAN_SCHEMA, signal })) {
    for (const step of extractor.push(delta)) yield cleanStep(step, ids);
  }
  if (process.env.DEBUG) console.log(extractor.text);
}
