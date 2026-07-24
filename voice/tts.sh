#!/usr/bin/env bash
# Speak text (read from stdin) into an OGG/Opus voice file Telegram can play.
#
#   echo "hello" | tts.sh /path/out.ogg
#
# Prefers Piper (neural, natural) when TG_PIPER_VOICE points at a .onnx voice;
# otherwise falls back to espeak-ng (robotic but always available). ffmpeg
# transcodes to Opus, which is what Telegram voice messages use.
set -euo pipefail
OUT="${1:?usage: tts.sh <out.ogg>}"
TEXT="$(cat)"
[ -n "${TEXT//[[:space:]]/}" ] || { echo "tts.sh: empty text" >&2; exit 2; }

PIPER="${TG_PIPER_BIN:-piper}"
tmp="$(mktemp /tmp/tts-XXXX.wav)"
trap 'rm -f "$tmp"' EXIT

if command -v "$PIPER" >/dev/null 2>&1 && [ -n "${TG_PIPER_VOICE:-}" ] && [ -f "${TG_PIPER_VOICE}" ]; then
  printf '%s' "$TEXT" | "$PIPER" --model "$TG_PIPER_VOICE" --output_file "$tmp" >/dev/null 2>&1
elif command -v espeak-ng >/dev/null 2>&1; then
  espeak-ng -v "${TG_ESPEAK_VOICE:-en}" -s "${TG_ESPEAK_WPM:-165}" "$TEXT" -w "$tmp" >/dev/null 2>&1
else
  echo "tts.sh: no TTS engine — set TG_PIPER_VOICE (see voice/setup.sh) or install espeak-ng" >&2
  exit 3
fi

ffmpeg -y -i "$tmp" -ac 1 -c:a libopus -b:a 32k "$OUT" >/dev/null 2>&1
