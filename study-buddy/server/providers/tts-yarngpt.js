// YarnGPT (yarngpt.ai): Nigerian-accented voices. Online only, and every call spends credits
// (there is no sandbox), so the browser keeps the device voice as a fallback.
// Uses the conversation route, which streams audio back in the same call (no job polling).
import { randomUUID } from 'node:crypto';

export default function yarngpt({ url = 'https://api.yarngpt.ai', voice, format = 'mp3', apiKeyEnv = 'YARNGPT_API_KEY' }) {
  const apiKey = process.env[apiKeyEnv];
  const headers = { authorization: `Bearer ${apiKey}` };
  let checked = { at: 0, up: false };

  return {
    name: `YarnGPT${voice ? ` (${voice})` : ''}`,
    server: true,

    // The status endpoint is polled every few seconds; don't hit the API that often.
    async health() {
      if (!apiKey) return false;
      if (Date.now() - checked.at < 60_000) return checked.up;
      let up = false;
      try {
        up = (await fetch(`${url}/api/v1/voices`, { headers, signal: AbortSignal.timeout(3000) })).ok;
      } catch {}
      checked = { at: Date.now(), up };
      return up;
    },

    async synthesize(text, { signal } = {}) {
      const res = await fetch(`${url}/api/v1/streaming/conversation`, {
        method: 'POST',
        signal,
        headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ text, output_format: format, ...(voice && { voice }) }),
      });
      if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
      return { body: res.body, contentType: res.headers.get('content-type') ?? `audio/${format === 'mp3' ? 'mpeg' : format}` };
    },
  };
}
