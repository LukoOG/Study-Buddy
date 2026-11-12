# Study Buddy — Phase 0 prototype

A voice-first, screen-aware study partner for WAEC/JAMB students. Open a PDF or a paused video, press **Start
listening**, point at (or circle) what confuses you and say **"Hey Buddy, how do I name this?"**. Buddy talks you
through it while drawing on the page with a marker.

## Run

```bash
npm install
brew install llama.cpp whisper-cpp
./scripts/models.sh llm   # terminal 1: vision-language model, :8080
./scripts/models.sh stt   # terminal 2: whisper speech-to-text, :8081
./scripts/models.sh voices  # once: downloads the offline voices (~230 MB)
npm start                 # terminal 3: http://localhost:3000
```

Without the model servers the app runs in **demo mode** (canned answers), so the UI can be worked on.
Press `/` to show a text box for typing questions while testing.

## Talking to Buddy

- **Wake phrase:** "Hey Buddy, …" (or "Buddy, …"). Other speech nearby is transcribed and ignored.
- **Follow-ups:** for 8 seconds after Buddy finishes, no wake phrase is needed ("and the second one?").
- **Pointing:** whatever the cursor or finger was on while you spoke becomes the selection. Circling with the
  marker overrides it.
- **Interrupting:** "Buddy, wait" or "Buddy, stop" while it talks. "Buddy, &lt;new question&gt;" switches topic.
- Buddy's voice is played by the page, so the browser's echo cancellation should be able to remove it from the mic
  (not yet confirmed). The device-voice fallback isn't covered by it, so use headphones if Buddy keeps hearing itself.

## Swapping models

All model choices are in [`models.config.json`](models.config.json). Nothing else needs to change:

```json
{
  "llm": { "provider": "openai-compatible", "url": "http://127.0.0.1:8080", "model": "qwen2.5-vl-3b", "vision": true },
  "stt": { "provider": "whisper-server", "url": "http://127.0.0.1:8081", "prompt": "Hey Buddy. WAEC, JAMB, IUPAC…" }
}
```

- **Different local model:** start llama-server with another GGUF (`LLM_HF=ggml-org/gemma-3-4b-it-GGUF ./scripts/models.sh llm`).
  Set `"vision": false` for text-only models; Buddy then answers PDF questions from the text layer only.
- **LM Studio / Ollama / a hosted API:** any OpenAI-compatible endpoint works. Change `url` and `model`. For keys, set
  `"apiKeyEnv": "MY_KEY_VAR"` and export that variable (keys never go in the file).
- **A different speech model** (e.g. an English + Pidgin model): if it runs behind an OpenAI-style
  `/v1/audio/transcriptions` endpoint (faster-whisper/Speaches, vLLM, LocalAI, hosted APIs), just change the config:
  `"stt": { "provider": "openai-compatible", "url": "http://127.0.0.1:8000", "model": "<model name>", "language": "en" }`.
  A fine-tuned whisper.cpp GGML file works with the existing `whisper-server` provider (`WHISPER_MODEL=<name> ./scripts/models.sh stt`
  looks for `models/ggml-<name>.bin`). Anything else is one new file in `server/providers/`.
- **Buddy's voice:** by default an offline voice runs inside the app server (sherpa-onnx with Meta's MMS-TTS:
  English for answers, Nigerian Pidgin ready for Pidgin answers). It's set up by the `tts` block in the config:
  `"tts": { "provider": "sherpa-onnx", "voices": { "en": "models/tts/mms-eng", "pcm": "models/tts/mms-pcm" } }`.
  The same runtime and model files work on Windows, Linux and Android. MMS is CC-BY-NC 4.0: fine for the hackathon,
  not for a paid product (a Nigerian-trained voice is the post-hackathon plan).
  Other options: `{ "provider": "browser" }` uses the device's own voices, and
  `{ "provider": "yarngpt", "voice": "idera" }` uses YarnGPT's online Nigerian voices (`YARNGPT_API_KEY=... npm start`;
  every call spends credits). Whatever is configured, Buddy falls back to the device voice if it fails, so it never
  goes silent. The status bar shows which voice is in use.
- **Several setups:** keep e.g. `models.phone.json` and run `MODELS_CONFIG=models.phone.json npm start`.
- **A new kind of backend:** write one file in `server/providers/` that returns the LLM or STT shape documented in
  [`server/providers/index.js`](server/providers/index.js) and register it there.

On the client, the voice (`web/voice.js`), wake phrase (`web/wake.js`) and listening (`web/listen.js`) are separate
modules for the same reason. Piper TTS or a dedicated wake-word model can replace them later.

## Testing on an Android phone

**1. Phone as the screen, Mac as the brain** (tests voice, touch and pointing on a real phone):

```bash
adb reverse tcp:3000 tcp:3000
```

With the phone on USB (Developer options → USB debugging), open `http://localhost:3000` in Chrome on the phone.
It has to be `localhost`, because Chrome only allows the microphone on localhost or HTTPS. Opening the Mac's Wi-Fi
IP won't get mic access.

**2. Models on the phone** (measures real phone speed, no app build needed):

1. Install Termux from F-Droid. The Play Store version is outdated.
2. In Termux: `pkg install git cmake clang curl` and build llama.cpp
   (`cmake -B build && cmake --build build -j --target llama-server`).
3. Copy a small GGUF to the phone and run `./build/bin/llama-server -m model.gguf --port 8080`.
4. Either run this app in Termux too (`pkg install nodejs`), or forward the phone's port to the Mac with
   `adb forward tcp:8080 tcp:8080` and use a config whose `llm.url` is `http://127.0.0.1:8080`.

The server prints prompt and generation speed for every answer. Those are the numbers that decide which model ships.

**3. Real app:** wrap `web/` in Capacitor and replace the HTTP model calls with an on-device llama.cpp plugin.

## How a question flows

1. **Listen** (`web/listen.js`): Silero VAD runs in the browser and cuts speech into utterances.
2. **Hear** (`server/providers/stt-*`): each utterance → 16 kHz WAV → whisper → text. `web/wake.js` checks for "Hey Buddy".
3. **Select** (`web/app.js`): circled strokes, otherwise the pointer position during speech, snapped to the line of text.
   Numbered questions on the page are detected (`web/questions.js`). A question named out loud ("question 2", "the
   second one") wins, then the question pointed at, then (in a follow-up) the one Buddy just explained.
4. **Context**: PDF words get ids and boxes (`web/reader.js`). When a question is in focus, only its words are sent, so
   the model can't answer or draw on another one (and the prompt is much shorter). Words in the selection are flagged
   `[CIRCLED]`. An image crop is only built and sent when there's no text to go on (video frames, diagrams).
5. **Plan** (`server/pipeline.js`): the model writes hidden `working`, then steps of `{say, draw[]}` under a JSON schema.
   Steps stream to the browser as each one completes (`server/plan-stream.js`).
6. **Explain** (`web/annotator.js`): each sentence is spoken while its drawings animate.

## Layout

- `server/`: Node HTTP server (no framework), pipeline, and model providers.
- `web/`: browser UI (vanilla JS modules, pdf.js, Silero VAD).
- `models.config.json`: which models to use.
- `samples/practice.pdf`: original WAEC-style questions for testing.
- `scripts/models.sh`: starts the local model servers.
