// Always-on listening. Silero VAD runs in the browser (offline, ~2 MB) and cuts the mic
// stream into utterances; only those get sent for transcription.
// Loaded as globals by index.html: window.ort (onnxruntime-web) and window.vad.
export async function createListener({ onSpeechStart, onUtterance, onMisfire }) {
  window.ort.env.wasm.numThreads = 1; // threads need cross-origin isolation; the VAD model is tiny anyway
  const mic = await window.vad.MicVAD.new({
    model: 'v5',
    baseAssetPath: '/vendor/vad/',
    onnxWASMBasePath: '/vendor/ort/',
    positiveSpeechThreshold: 0.6,
    negativeSpeechThreshold: 0.45,
    redemptionMs: 900, // students pause mid-question ("how do I… name this?")
    minSpeechMs: 300,
    preSpeechPadMs: 300,
    startOnLoad: false,
    getStream: () =>
      navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }),
    onSpeechStart,
    onSpeechEnd: onUtterance, // Float32Array, 16 kHz mono
    onVADMisfire: onMisfire,
  });
  return mic; // start(), pause()
}
