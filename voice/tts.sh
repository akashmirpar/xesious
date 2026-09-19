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

# The interpreter setup.sh installed into. Plain python3 unless it had to fall back
# to a venv, in which case the packages are only importable from that one.
PY="python3"
[ -f "$DIR/.python" ] && [ -x "$(cat "$DIR/.python")" ] && PY="$(cat "$DIR/.python")"

# ffmpeg, resolved rather than assumed: an override, then the private copy setup.sh
# may have put in voice/bin (pip's static build — no root), then the system one.
# Used ONLY for the transcode below; nothing on the inbound path needs it.
FFMPEG="${TG_FFMPEG:-}"
[ -n "$FFMPEG" ] && [ -x "$FFMPEG" ] || FFMPEG=""
[ -z "$FFMPEG" ] && [ -x "$DIR/bin/ffmpeg" ] && FFMPEG="$DIR/bin/ffmpeg"
[ -z "$FFMPEG" ] && FFMPEG="$(command -v ffmpeg 2>/dev/null || true)"
if [ -z "$FFMPEG" ]; then
  # Named precisely, because this used to surface to the user as silence: the bridge
  # logs the exit code and sends text instead.
  echo "tts.sh: no ffmpeg — cannot encode Opus. Run voice/setup.sh (it can install a private copy without root)." >&2
  exit 4
fi

tmp="$(mktemp /tmp/tts-XXXX.wav)"
trap 'rm -f "$tmp"' EXIT

case "$ENGINE" in
  kokoro)
    # Delegated to speak.py, which is the ONE Kokoro implementation in the tree.
    # There used to be a second one in kokoro_tts.py reading the same nine env vars;
    # two ways to load the same model is two places for them to drift apart.
    # speak.py encodes the Opus itself, so there is nothing left to do afterwards.
    printf '%s' "$TEXT" | "$PY" -c '
import json,sys
sys.stdout.write(json.dumps({"units":[{"text":sys.stdin.read(),"gap":0.0}],"out":sys.argv[1]}))
' "$OUT" | "$PY" "$DIR/speak.py" >/dev/null
    exit $? ;;
  piper)
    if command -v "$PIPER" >/dev/null 2>&1 && [ -n "${TG_PIPER_VOICE:-}" ] && [ -f "${TG_PIPER_VOICE}" ]; then
      printf '%s' "$TEXT" | "$PIPER" --model "$TG_PIPER_VOICE" --output_file "$tmp" >/dev/null 2>&1
    else
      command -v espeak-ng >/dev/null 2>&1 || {
        echo "tts.sh: no TTS engine — piper is unconfigured and espeak-ng is not installed. Run voice/setup.sh." >&2; exit 5; }
      espeak-ng -v "${TG_ESPEAK_VOICE:-en}" -s "${TG_ESPEAK_WPM:-165}" "$TEXT" -w "$tmp" >/dev/null 2>&1
    fi ;;
  espeak)
    command -v espeak-ng >/dev/null 2>&1 || {
      echo "tts.sh: TG_TTS_ENGINE=espeak but espeak-ng is not installed. Run voice/setup.sh --espeak." >&2; exit 5; }
    espeak-ng -v "${TG_ESPEAK_VOICE:-en}" -s "${TG_ESPEAK_WPM:-165}" "$TEXT" -w "$tmp" >/dev/null 2>&1 ;;
  *)
    echo "tts.sh: unknown TG_TTS_ENGINE '$ENGINE'" >&2; exit 3 ;;
esac

"$FFMPEG" -y -i "$tmp" -ac 1 -c:a libopus -b:a 32k "$OUT" >/dev/null 2>&1
