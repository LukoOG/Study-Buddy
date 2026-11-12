// Any server speaking the OpenAI chat API: llama-server (Mac, Windows, Android/Termux),
// LM Studio, Ollama's /v1 endpoint, or a hosted API. Secrets come from an env var named
// in the config (apiKeyEnv), never from the config file itself.
export default function openaiCompatible({ url, model, vision = false, apiKeyEnv, temperature = 0.2, maxTokens = 900 }) {
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  const headers = { 'content-type': 'application/json', ...(apiKey && { authorization: `Bearer ${apiKey}` }) };

  return {
    name: model ?? url,
    vision,

    async health() {
      try {
        const res = await fetch(`${url}/v1/models`, { headers, signal: AbortSignal.timeout(800) });
        return res.ok;
      } catch {
        return false;
      }
    },

    async *streamJson({ messages, schema, signal }) {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: true,
          // Schema-constrained decoding keeps small models from emitting malformed plans.
          response_format: { type: 'json_schema', json_schema: { name: 'plan', schema } },
        }),
      });
      if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);

      // Server-sent events: "data: {...}" lines, ending with "data: [DONE]".
      let buffer = '';
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) yield delta;
        }
      }
    },
  };
}
