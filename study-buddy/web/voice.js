// Speech out. Two voices behind one speak/stop contract:
// - a server voice (e.g. YarnGPT's Nigerian voices) when models.config.json sets one and it's reachable;
// - the OS's built-in voices otherwise (offline on macOS, Windows and Android), also the fallback
//   whenever the server voice fails, so Buddy never goes silent.
let serverVoice = false;
let playing = null; // { audio, resolve } of the server-voice sentence being played
let stopCount = 0; // bumped by stopSpeaking(), so audio that arrives after an interrupt isn't played
const cache = new Map(); // text -> Promise<Blob>; ACKs repeat, and steps are fetched ahead

export function useServerVoice(on) {
  serverVoice = on;
}

function pickVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.localService);
  for (const lang of ['en-NG', 'en-GB', 'en-ZA', 'en-US']) {
    const match = voices.find((v) => v.lang === lang);
    if (match) return match;
  }
  return voices.find((v) => v.lang.startsWith('en')) ?? null;
}

function speakOnDevice(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return setTimeout(resolve, 60 * text.length);
    const u = new SpeechSynthesisUtterance(text);
    u.voice = pickVoice();
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

function fetchAudio(text) {
  if (!cache.has(text)) {
    const blob = fetch('/api/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`speak ${res.status}`))));
    blob.catch(() => cache.delete(text));
    cache.set(text, blob);
    if (cache.size > 40) cache.delete(cache.keys().next().value);
  }
  return cache.get(text);
}

// Start fetching a sentence's audio now, so it's ready by the time it's spoken.
export function prefetch(text) {
  if (serverVoice) fetchAudio(text).catch(() => {});
}

async function speakOnServer(text, token) {
  const blob = await fetchAudio(text);
  if (token !== stopCount) return;
  const audio = new Audio(URL.createObjectURL(blob));
  await new Promise((resolve, reject) => {
    playing = { audio, resolve };
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error('audio playback failed'));
    audio.play().catch(reject);
  }).finally(() => {
    URL.revokeObjectURL(audio.src);
    if (playing?.audio === audio) playing = null;
  });
}

// Resolves when the sentence finishes or is cut off by stopSpeaking().
export async function speak(text) {
  if (serverVoice) {
    const token = stopCount;
    try {
      return await speakOnServer(text, token);
    } catch (err) {
      if (token !== stopCount) return; // interrupted; stay quiet
      console.warn('Server voice failed, using the device voice:', err.message);
    }
  }
  return speakOnDevice(text);
}

export function stopSpeaking() {
  stopCount++;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (playing) {
    playing.audio.pause();
    playing.resolve();
    playing = null;
  }
}

// 16 kHz mono float samples (what the VAD hands us) -> 16-bit PCM WAV for whisper.
export function encodeWav(samples, rate = 16000) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (off, s) => [...s].forEach((c, i) => view.setUint8(off + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return new Blob([view], { type: 'audio/wav' });
}
