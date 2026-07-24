#!/usr/bin/env bash
# Speak text (read from stdin) into an OGG/Opus voice file Telegram can play.
#
#   echo "hello" | tts.sh /path/out.ogg
#
# Engine chosen by TG_TTS_ENGINE (default: kokoro if its model is present, else piper):
#   kokoro  — Kokoro-82M neural voice (natural; ~1x realtime on CPU)
#   piper   — Piper neural voice (fast, more mechanical); needs TG_PIPER_VOICE
#   espeak  — espeak-ng (robotic, always-available fallback)
# ffmpeg transcodes to Opus, which is what Telegram voice messages use.
set -euo pipefail
OUT="${1:?usage: tts.sh <out.ogg>}"
TEXT="$(cat)"
[ -n "${TEXT//[[:space:]]/}" ] || { echo "tts.sh: empty text" >&2; exit 2; }
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default engine: kokoro when its model is on disk, otherwise piper.
if [ -n "${TG_TTS_ENGINE:-}" ]; then ENGINE="$TG_TTS_ENGINE"
elif [ -f "${TG_KOKORO_MODEL:-$DIR/kokoro/kokoro-v1.0.onnx}" ]; then ENGINE=kokoro
else ENGINE=piper; fi

PIPER="${TG_PIPER_BIN:-piper}"
tmp="$(mktemp /tmp/tts-XXXX.wav)"
trap 'rm -f "$tmp"' EXIT

case "$ENGINE" in
  kokoro)
    printf '%s' "$TEXT" | python3 "$DIR/kokoro_tts.py" "$tmp" ;;
  piper)
    if command -v "$PIPER" >/dev/null 2>&1 && [ -n "${TG_PIPER_VOICE:-}" ] && [ -f "${TG_PIPER_VOICE}" ]; then
      printf '%s' "$TEXT" | "$PIPER" --model "$TG_PIPER_VOICE" --output_file "$tmp" >/dev/null 2>&1
    else
      espeak-ng -v "${TG_ESPEAK_VOICE:-en}" -s "${TG_ESPEAK_WPM:-165}" "$TEXT" -w "$tmp" >/dev/null 2>&1
    fi ;;
  espeak)
    espeak-ng -v "${TG_ESPEAK_VOICE:-en}" -s "${TG_ESPEAK_WPM:-165}" "$TEXT" -w "$tmp" >/dev/null 2>&1 ;;
  *)
    echo "tts.sh: unknown TG_TTS_ENGINE '$ENGINE'" >&2; exit 3 ;;
esac

ffmpeg -y -i "$tmp" -ac 1 -c:a libopus -b:a 32k "$OUT" >/dev/null 2>&1
