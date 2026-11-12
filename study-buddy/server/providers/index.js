import openaiCompatible from './llm-openai-compatible.js';
import whisperServer from './stt-whisper-server.js';
import openaiCompatibleStt from './stt-openai-compatible.js';
import yarngpt from './tts-yarngpt.js';
import sherpaOnnx from './tts-sherpa-onnx.js';

// Provider contracts. Add a new model backend by writing one file that returns
// one of these shapes and registering it below; nothing else in the app changes.
//
// LLM: {
//   name: string,
//   vision: boolean,                       // can it take image_url content?
//   health(): Promise<boolean>,
//   streamJson({ messages, schema, signal }): AsyncIterable<string>,  // raw text deltas of a JSON document
// }
// STT: {
//   name: string,
//   health(): Promise<boolean>,
//   transcribe(wav: Buffer): Promise<string>,  // 16 kHz mono WAV in, text out
// }
// TTS: {
//   name: string,
//   server: boolean,                       // false: the browser speaks with the device's own voices
//   health(): Promise<boolean>,
//   synthesize?(text, { signal, voice }): Promise<{ body: AsyncIterable<Uint8Array>, contentType: string }>,  // when server
// }
const LLM_PROVIDERS = { 'openai-compatible': openaiCompatible };
const STT_PROVIDERS = { 'whisper-server': whisperServer, 'openai-compatible': openaiCompatibleStt };
const TTS_PROVIDERS = {
  browser: () => ({ name: 'device voice', server: false, health: async () => true }),
  yarngpt,
  'sherpa-onnx': sherpaOnnx,
};

function create(registry, kind, options) {
  const factory = registry[options?.provider];
  if (!factory) throw new Error(`Unknown ${kind} provider "${options?.provider}". Known: ${Object.keys(registry).join(', ')}`);
  return factory(options);
}

export function createProviders(models) {
  return {
    llm: create(LLM_PROVIDERS, 'llm', models.llm),
    stt: create(STT_PROVIDERS, 'stt', models.stt),
    tts: create(TTS_PROVIDERS, 'tts', models.tts ?? { provider: 'browser' }),
  };
}
