// Any server speaking the OpenAI transcription API (POST /v1/audio/transcriptions):
// faster-whisper / Speaches, vLLM, LocalAI, a fine-tuned English+Pidgin model behind one of
// those, or a hosted API. Secrets come from an env var named in the config (apiKeyEnv).
export default function openaiCompatibleStt({ url, model, language, prompt, apiKeyEnv }) {
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};

  return {
    name: model ?? url,

    async health() {
      try {
        const res = await fetch(`${url}/v1/models`, { headers, signal: AbortSignal.timeout(800) });
        return res.ok;
      } catch {
        return false;
      }
    },

    async transcribe(wav) {
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
      form.append('response_format', 'json');
      if (model) form.append('model', model);
      if (language) form.append('language', language);
      if (prompt) form.append('prompt', prompt);
      const res = await fetch(`${url}/v1/audio/transcriptions`, { method: 'POST', headers, body: form });
      if (!res.ok) throw new Error(`STT ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return data.text.replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim();
    },
  };
}
