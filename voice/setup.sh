#!/usr/bin/env bash
# One-time setup for turn-based voice: STT (faster-whisper) + TTS.
# Idempotent, no API keys — everything runs locally on this box.
#
#   voice/setup.sh            # ffmpeg + faster-whisper + espeak-ng (robotic voice)
#   voice/setup.sh --piper    # also install Piper + a natural neural voice
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
say() { echo "[voice-setup] $*"; }
APT() { command -v sudo >/dev/null 2>&1 && [ "$(id -u)" != 0 ] && sudo apt-get "$@" || apt-get "$@"; }
PIP() { pip3 install --quiet "$@" 2>/dev/null || pip3 install --quiet --break-system-packages "$@"; }
MODEL="${TG_STT_MODEL:-base}"

# 1. ffmpeg — decode the incoming .ogg, encode the outgoing Opus.
command -v ffmpeg >/dev/null 2>&1 || { say "installing ffmpeg…"; APT update -qq; APT install -y ffmpeg; }

# 2. STT — faster-whisper, and warm the model so the first voice note isn't slow.
python3 -c 'import faster_whisper' 2>/dev/null || { say "installing faster-whisper…"; PIP faster-whisper; }
say "caching the whisper '$MODEL' model…"
python3 - "$MODEL" <<'PY' || say "(model will download on first use)"
import sys
from faster_whisper import WhisperModel
WhisperModel(sys.argv[1], device="cpu", compute_type="int8")
print("ok")
PY

# 3. TTS — espeak-ng always (robotic but reliable); Piper optional (natural).
command -v espeak-ng >/dev/null 2>&1 || { say "installing espeak-ng (fallback voice)…"; APT install -y espeak-ng; }

if [ "${1:-}" = "--kokoro" ]; then
  say "installing Kokoro (kokoro-onnx, CPU)…"; PIP kokoro-onnx soundfile || say "(kokoro-onnx pip install failed)"
  mkdir -p voice/kokoro
  KBASE="${TG_KOKORO_URL:-https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0}"
  [ -f voice/kokoro/kokoro-v1.0.onnx ] || { say "downloading Kokoro model (~311MB)…"; curl -fL "$KBASE/kokoro-v1.0.onnx" -o voice/kokoro/kokoro-v1.0.onnx; }
  [ -f voice/kokoro/voices-v1.0.bin ]  || { say "downloading Kokoro voices…"; curl -fL "$KBASE/voices-v1.0.bin" -o voice/kokoro/voices-v1.0.bin; }
  say "Kokoro ready. In .env set:  TG_TTS_ENGINE=kokoro  and  TG_KOKORO_VOICE=af_heart"
fi

if [ "${1:-}" = "--piper" ]; then
  say "installing Piper…"; PIP piper-tts || say "(piper-tts pip install failed; espeak-ng still works)"
  mkdir -p voice/piper
  URL="${TG_PIPER_VOICE_URL:-https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx}"
  say "downloading a neural voice…"
  curl -fL "$URL" -o voice/piper/voice.onnx && curl -fL "$URL.json" -o voice/piper/voice.onnx.json \
    && say "add to .env:  TG_PIPER_VOICE=$PWD/voice/piper/voice.onnx" \
    || say "voice download failed — espeak-ng still works"
fi

say "done."
say "enable it: set TG_VOICE=1 in .env, or send /voice on in a topic."
