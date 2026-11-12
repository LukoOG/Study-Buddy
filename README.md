# Study Buddy

Study Buddy is an offline-first, voice-controlled PDF and video reader for WAEC and JAMB students. A student points at or circles a confusing part of a page, asks a question, and receives a short spoken explanation with animated marker annotations directly on the material.

It is a hackathon prototype built to explore a private, low-connectivity study experience: speech detection runs in the browser, the language model and speech recognition can run locally, and the default text-to-speech voice runs inside the app.

## What it does

1. Open a PDF or a local video and pause on the material to study.
2. Press **Start listening**, point at an area or mark it with the highlighter, then say: **“Hey Buddy, how do I solve this?”**
3. Study Buddy transcribes the request, identifies the relevant question or selection, and sends only the surrounding context to the local model.
4. The model returns short explanation steps and drawing instructions.
5. Buddy speaks each step and draws circles, underlines, arrows, boxes, and notes on the page.

It also supports follow-up questions for eight seconds after an answer, question references such as “question two,” and interruptions such as “Buddy, stop.”

## Architecture

```text
Browser
  PDF.js / local video + pointer or marker selection
  Silero VAD -> 16 kHz WAV -> Node app
  rendered captions, speech playback, animated annotations
                         |
                         v
Node app (:3000)
  API and static files
  context selection + streamed answer plan
  local MMS text-to-speech via sherpa-onnx
       |                         |
       v                         v
Whisper server (:8081)      llama-server (:8080)
speech-to-text               Qwen vision-language model
```

The configured providers live in [`models.config.json`](models.config.json). The app communicates with model servers through OpenAI-compatible interfaces, so another compatible local or hosted provider can be substituted without changing the UI.

## Quick start

### Prerequisites

- Node.js 20 or newer
- `whisper-server` from `whisper-cpp` on your `PATH`
- A built `llama-server` in the included `tools/llama.cpp` submodule
- macOS is the currently tested environment; the web app itself is standard browser JavaScript

Clone with submodules, or initialise the included llama.cpp source after cloning:

```bash
git submodule update --init --recursive
```

Build llama.cpp if `tools/llama.cpp/build/bin/llama-server` does not exist:

```bash
cmake -S tools/llama.cpp -B tools/llama.cpp/build
cmake --build tools/llama.cpp/build --target llama-server -j
```

Install app dependencies:

```bash
npm install
```

Download the local voice files once:

```bash
./scripts/models.sh voices
```

Start these processes in separate terminals:

```bash
./scripts/models.sh llm  # Qwen model server on http://127.0.0.1:8080
./scripts/models.sh stt  # Whisper speech-to-text server on http://127.0.0.1:8081
npm start                # Study Buddy UI and API on http://127.0.0.1:3000
```

Open `http://localhost:3000`, choose **Sample PDF**, press **Start listening**, allow microphone access, then ask a question.

`pnpm run start` also starts the app server if you prefer pnpm, but this repository currently tracks `package-lock.json`; use `npm install` for the reproducible dependency tree.

## Services and models

| Command | Starts or downloads | Default model | Port |
| --- | --- | --- | --- |
| `npm start` | Study Buddy's Node server and browser UI | — | 3000 |
| `./scripts/models.sh llm` | `llama-server` | Qwen2.5-VL-3B-Instruct | 8080 |
| `./scripts/models.sh stt` | `whisper-server` | Whisper `base.en` | 8081 |
| `./scripts/models.sh voices` | Downloads voice assets only | Meta MMS English and Pidgin TTS | — |

The Meta MMS files are not a separate running server. `npm start` loads them through `sherpa-onnx` when it synthesizes an answer.

On first start, the LLM command downloads its configured Hugging Face model into the local cache. Set `LLM_HF` to use another llama.cpp-compatible model:

```bash
LLM_HF=ggml-org/gemma-3-4b-it-GGUF ./scripts/models.sh llm
```

Set `WHISPER_MODEL` to use another compatible GGML Whisper file stored as `models/ggml-<name>.bin`:

```bash
WHISPER_MODEL=small.en ./scripts/models.sh stt
```

## Configuration

[`models.config.json`](models.config.json) controls the LLM, STT, and TTS providers. The default configuration is fully local:

```json
{
  "llm": {
    "provider": "openai-compatible",
    "url": "http://127.0.0.1:8080",
    "model": "qwen2.5-vl-3b",
    "vision": true
  },
  "stt": {
    "provider": "whisper-server",
    "url": "http://127.0.0.1:8081"
  },
  "tts": {
    "provider": "sherpa-onnx"
  }
}
```

- **LLM:** LM Studio, Ollama's `/v1` endpoint, or another OpenAI-compatible backend can replace llama.cpp. Set `vision` to `false` for text-only models.
- **Speech to text:** an OpenAI-style `/v1/audio/transcriptions` service can use the `openai-compatible` STT provider.
- **Speech:** use `{ "provider": "browser" }` for the device voice, or YarnGPT for an online Nigerian-accented voice. Do not commit API keys; use an environment variable referenced through `apiKeyEnv`.
- **Alternative setups:** create another JSON file and run `MODELS_CONFIG=models.phone.json npm start`.

## Demo checklist

Before a demo, verify the services are ready:

```bash
curl http://127.0.0.1:3000/api/status
```

All of `llm.up`, `stt.up`, and `tts.up` should be `true`. If the LLM is unavailable, the UI intentionally switches to canned answers so the interaction design can still be shown, but this is not a real AI explanation.

Recommended demo flow:

1. Start the three services and wait for model loading to finish.
2. Open **Sample PDF**.
3. Circle a chemistry expression or point at a numbered question.
4. Ask a short, specific question beginning with “Hey Buddy”.
5. Use headphones if the device's playback is being detected as microphone input.
6. Keep the typed-question control available as a fallback: press `/` to reveal it.

## Android testing

For a phone as the display and a Mac as the compute host, connect the device through USB with debugging enabled:

```bash
adb reverse tcp:3000 tcp:3000
```

Then open `http://localhost:3000` in Chrome on the phone. Chrome permits microphone access on localhost; opening the Mac's LAN IP will not receive the same permission without HTTPS.

## Project layout

```text
server/                 Node HTTP server, answer pipeline, and model providers
web/                    Vanilla browser UI, PDF reader, voice loop, and canvas annotations
scripts/models.sh       Starts local model services or downloads voice files
models.config.json      Selects and configures the active model providers
samples/practice.pdf    Demo study material
tools/llama.cpp/        llama.cpp source submodule used to build llama-server
```

## Current limitations

- This is a prototype, not a production or exam-preparation authority; model explanations should be checked against trusted learning material.
- Voice input quality depends on microphone quality, Whisper configuration, and background noise.
- The first local model request can be slow while models warm up.
- Meta MMS-TTS is licensed CC-BY-NC 4.0, suitable for the hackathon prototype but not a paid product without changing the voice solution.
- There is currently no automated test suite.
