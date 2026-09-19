#!/usr/bin/env bash
# A stand-in for voice/tts.sh in tier 2. Real synthesis is ~1x realtime, so a test
# that used it would take minutes; what tier 2 needs to prove is the PLUMBING —
# that the note is threaded, and that a slow note does not block the topic.
#
# Not named TG_* on purpose: childEnv() strips every TG_ and TELEGRAM_ variable
# before spawning a child, so the model never sees the bot token or bridge config —
# a marker with that prefix would be silently removed and this stub would never sleep.
#
# Sleeps only while $XESIOUS_TTS_STUB_SLOW names a file that exists, so one test can make
# synthesis slow (to prove the topic is not blocked by it) without every other test
# paying for it.
set -uo pipefail
OUT="${1:?usage: tts-stub.sh <out.ogg>}"
cat > /dev/null                      # drain stdin, as the real script does
[ -n "${XESIOUS_TTS_STUB_SLOW:-}" ] && [ -f "${XESIOUS_TTS_STUB_SLOW}" ] && sleep 4
FF="$(command -v ffmpeg || true)"
[ -n "$FF" ] || { echo "tts-stub: no ffmpeg" >&2; exit 4; }
"$FF" -y -f lavfi -i anullsrc=r=24000:cl=mono -t 0.3 -c:a libopus -b:a 32k "$OUT" >/dev/null 2>&1
