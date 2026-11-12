// whisper.cpp's whisper-server. `prompt` biases recognition toward the wake phrase
// and subject vocabulary ("IUPAC", "Snell's law") that a general model mishears.
export default function whisperServer({ url, prompt, language }) {
  return {
    name: `whisper-server (${url})`,

    async health() {
      try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(800) });
        return res.ok;
      } catch {
        return false;
      }
    },

    async transcribe(wav) {
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
      form.append('response_format', 'json');
      if (prompt) form.append('prompt', prompt);
      if (language) form.append('language', language);
      const res = await fetch(`${url}/inference`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(`STT ${res.status}: ${await res.text()}`);
      const data = await res.json();
      // Whisper emits tags like [BLANK_AUDIO] or (music) for non-speech.
      return data.text.replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim();
    },
  };
}
