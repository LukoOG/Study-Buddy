#!/usr/bin/env bash
# Starts the local model servers the app talks to (addresses live in models.config.json).
# Run each in its own terminal:
#   ./scripts/models.sh llm      # vision-language model on :8080
#   ./scripts/models.sh stt      # speech-to-text on :8081
#   ./scripts/models.sh voices   # one-off download of the offline voices
# Needs: brew install llama.cpp whisper-cpp
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-}" in
  llm)
    # Some M1/macOS combos can't compile llama.cpp's bfloat16 GPU shaders; turning bf16 off
    # keeps the GPU usable (otherwise the server fails to start, or you're stuck on slow CPU).
    export GGML_METAL_BF16_DISABLE=1
    # Any llama.cpp-compatible model works; override with LLM_HF=org/repo[:quant].
    # -hf downloads the model + its vision projector into the Hugging Face cache on first run.
    exec llama-server -hf "${LLM_HF:-ggml-org/Qwen2.5-VL-3B-Instruct-GGUF}" \
      --port 8080 --ctx-size 8192 --n-gpu-layers 99 --jinja
    ;;
  stt)
    model="models/ggml-${WHISPER_MODEL:-base.en}.bin"
    if [[ ! -f "$model" ]]; then
      mkdir -p models
      curl -L -o "$model" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$(basename "$model")"
    fi
    # CPU: whisper's Metal shaders hit the same bf16 compile error, and base.en is fast on CPU anyway.
    exec whisper-server -m "$model" --port 8081 --no-gpu
    ;;
  voices)
    # Offline voices (Meta MMS-TTS, CC-BY-NC 4.0: fine for the hackathon, not for a paid product).
    # The app loads them itself; this just downloads them once.
    fetch_voice() {
      local dir="models/tts/$1" repo="$2"
      [[ -f "$dir/model.onnx" ]] && return
      mkdir -p "$dir"
      curl -L --retry 3 -o "$dir/model.onnx" "https://huggingface.co/$repo/model.onnx"
      curl -L --retry 3 -o "$dir/tokens.txt" "https://huggingface.co/$repo/tokens.txt"
    }
    fetch_voice mms-eng csukuangfj/vits-mms-eng/resolve/main
    fetch_voice mms-pcm Axiveri/Renpiper-mms-onnx-V1/resolve/main/pcm
    ;;
  *)
    echo "usage: $0 llm|stt|voices" >&2
    exit 1
    ;;
esac
