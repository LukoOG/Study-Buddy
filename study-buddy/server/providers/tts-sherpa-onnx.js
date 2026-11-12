// Offline voices via sherpa-onnx (the same runtime works on Mac, Windows, Linux and Android).
// Ships with Meta's MMS-TTS voices: English for Buddy's answers, Nigerian Pidgin ready for
// Pidgin answers. MMS reads characters, not words, so text is spelled out for it first.
import path from 'node:path';
import { createRequire } from 'node:module';
import { config } from '../config.js';

const require = createRequire(import.meta.url);

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const LETTERS = { a: 'ay', b: 'bee', c: 'see', d: 'dee', e: 'ee', f: 'ef', g: 'jee', h: 'aitch', i: 'eye', j: 'jay', k: 'kay',
  l: 'el', m: 'em', n: 'en', o: 'oh', p: 'pee', q: 'kew', r: 'ar', s: 'es', t: 'tee', u: 'you', v: 'vee', w: 'double you',
  x: 'ex', y: 'why', z: 'zed' };
const SYMBOLS = { '%': ' percent ', '°': ' degrees ', '=': ' equals ', '+': ' plus ', '×': ' times ', '÷': ' divided by ',
  '/': ' over ', '&': ' and ', '->': ' gives ', '→': ' gives ' };

function numberWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` and ${numberWords(n % 100)}` : ''}`;
  if (n < 1e6) return `${numberWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberWords(n % 1000)}` : ''}`;
  return [...String(n)].map((d) => ONES[d]).join(' ');
}

// "CH3" -> "see aitch three", "OH" -> "oh aitch", "1.5" -> "one point five", "30%" -> "thirty percent".
export function spellOut(text) {
  return text
    .replace(/->|→|[%°=+×÷/&]/g, (s) => SYMBOLS[s])
    .replace(/\b(?:(?=[A-Za-z]*\d)(?=[A-Z])[A-Za-z0-9]+|[A-Z]{2,3})\b/g, (formula) =>
      formula.match(/[A-Z][a-z]?|[a-z]|\d+/g).map((p) => (/\d/.test(p) ? p : [...p.toLowerCase()].map((c) => LETTERS[c]).join(' '))).join(' '),
    )
    .replace(/\d+\.\d+/g, (d) => `${d.split('.')[0]} point ${[...d.split('.')[1]].join(' ')}`)
    .replace(/\d+/g, (d) => ` ${numberWords(Number(d))} `);
}

// Split into clauses so punctuation becomes pauses (MMS has no punctuation symbols).
function clauses(text) {
  return spellOut(text)
    .split(/([.!?;:]+|,)/)
    .reduce((out, part, i, all) => {
      if (i % 2) return out;
      const words = part.toLowerCase().replace(/[^a-z' -]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (words) out.push({ words, pause: all[i + 1] === ',' ? 0.12 : 0.28 });
      return out;
    }, []);
}

function wav(chunks, rate) {
  const n = chunks.reduce((sum, c) => sum + c.length, 0);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  let off = 44;
  for (const c of chunks) for (const s of c) (buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 0x7fff), off), (off += 2));
  return buf;
}

export default function sherpaOnnx({ voices, defaultVoice = Object.keys(voices)[0], speed = 1, threads = 2 }) {
  let sherpa;
  const loaded = {}; // voice -> Promise<OfflineTts>
  let queue = Promise.resolve(); // one sentence at a time, in request order

  function load(voice) {
    sherpa ??= require('sherpa-onnx-node');
    const dir = path.resolve(config.root, voices[voice]);
    loaded[voice] ??= sherpa.OfflineTts.createAsync({
      model: { vits: { model: path.join(dir, 'model.onnx'), tokens: path.join(dir, 'tokens.txt') }, numThreads: threads },
      maxNumSentences: 1,
    });
    return loaded[voice];
  }
  load(defaultVoice).catch((err) => console.error(`TTS voice "${defaultVoice}" failed to load:`, err.message));

  async function generate(text, voice, signal) {
    const tts = await load(voice);
    const chunks = [];
    for (const { words, pause } of clauses(text)) {
      if (signal?.aborted) throw new Error('aborted');
      const audio = await tts.generateAsync({ text: words, sid: 0, speed, onProgress: () => !signal?.aborted });
      chunks.push(audio.samples, new Float32Array(Math.round(pause * tts.sampleRate)));
    }
    return wav(chunks, tts.sampleRate);
  }

  return {
    name: `offline ${defaultVoice} voice (MMS)`,
    server: true,

    async health() {
      try {
        await load(defaultVoice);
        return true;
      } catch {
        return false;
      }
    },

    async synthesize(text, { signal, voice = defaultVoice } = {}) {
      if (!voices[voice]) voice = defaultVoice;
      const result = queue.then(() => generate(text, voice, signal));
      queue = result.catch(() => {});
      return { body: [await result], contentType: 'audio/wav' };
    },
  };
}
