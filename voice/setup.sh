#!/usr/bin/env bash
# One-time setup for turn-based voice: STT (faster-whisper) + TTS (Kokoro).
# Idempotent, no API keys — everything runs locally on this box.
#
#   voice/setup.sh              # STT + Kokoro (the good voice). No root needed.
#   voice/setup.sh --espeak     # also install the robotic espeak-ng fallback (needs apt)
#   voice/setup.sh --piper      # also install Piper + a neural voice
#   voice/setup.sh --check      # report what is installed and change nothing
#
# NOTHING HERE NEEDS ROOT. It used to: the script opened by apt-installing ffmpeg,
# and under `set -e` a machine without sudo died on that first line and installed
# NOTHING — not faster-whisper, not Kokoro, neither of which needs a system package.
# That is what "I could not set it up on my VPS without switching to root" actually
# was. Root is now only ever a fallback, and never a precondition.
#
# `set -e` is deliberately NOT used. An optional component failing must not abort the
# required ones; failures are collected and reported at the end instead, and the exit
# code reflects only whether voice can actually work.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
say()  { echo "[voice-setup] $*"; }
warn() { echo "[voice-setup] ⚠️  $*" >&2; }
MODEL="${TG_STT_MODEL:-base}"
FAILED=()
NOTES=()

MODE="${1:-}"
CHECK=0; WANT_ESPEAK=0; WANT_PIPER=0
for a in "$@"; do
  case "$a" in
    --check)  CHECK=1 ;;
    --espeak) WANT_ESPEAK=1 ;;
    --piper)  WANT_PIPER=1 ;;
    --kokoro) : ;;   # kept for compatibility: Kokoro is the default now
    *) [ -n "$a" ] && warn "unknown option $a (ignored)" ;;
  esac
done

# ---------------------------------------------------------------------------
# 0. A working pip, in the SAME interpreter that will import the packages.
#
# `pip3` was the old entry point and it is the wrong one twice over: it is a
# PATH-resolved console script that may belong to a different interpreter, and it
# frequently lives in ~/.local/bin — which sudo drops — so "switch to root to fix
# the permissions problem" is what REMOVES pip. `python3 -m pip` is the same
# interpreter by construction.
# ---------------------------------------------------------------------------
PY_BIN="python3"
PIP_ARGS=()
resolve_pip() {
  # Already usable? Prefer --user so nothing is written to system site-packages.
  if "$PY_BIN" -m pip --version >/dev/null 2>&1; then
    if "$PY_BIN" -c 'import sys; sys.exit(0 if sys.prefix != sys.base_prefix else 1)' 2>/dev/null; then
      PIP_ARGS=()                       # already inside a venv: plain install is right
    else
      PIP_ARGS=(--user)
    fi
    return 0
  fi
  say "python3 has no pip — trying ensurepip…"
  "$PY_BIN" -m ensurepip --upgrade >/dev/null 2>&1 && "$PY_BIN" -m pip --version >/dev/null 2>&1 && {
    PIP_ARGS=(--user); return 0; }
  say "ensurepip unavailable — trying a virtualenv at voice/.venv…"
  if "$PY_BIN" -m venv voice/.venv >/dev/null 2>&1 && [ -x voice/.venv/bin/python3 ]; then
    PY_BIN="$ROOT/voice/.venv/bin/python3"; PIP_ARGS=()
    echo "$PY_BIN" > voice/.python
    say "using $PY_BIN"
    return 0
  fi
  return 1
}

PIP() {
  "$PY_BIN" -m pip install --quiet "${PIP_ARGS[@]}" "$@" 2>/dev/null && return 0
  # Debian/Ubuntu mark the system Python externally-managed (PEP 668) and refuse even
  # a --user install without this flag. It is APPENDED, never substituted: dropping
  # --user here would aim the retry at SYSTEM site-packages, which fails as a normal
  # user and, as root, is exactly the combination that damages a distro's Python.
  say "  (PEP 668 externally-managed environment — retrying with --break-system-packages)"
  "$PY_BIN" -m pip install --quiet "${PIP_ARGS[@]}" --break-system-packages "$@"
}

# ---------------------------------------------------------------------------
# 1. ffmpeg — used in exactly ONE place: transcoding the synthesised WAV to the
#    OGG/Opus that Telegram voice messages need (voice/tts.sh, last line).
#    STT does NOT need it: faster-whisper decodes through PyAV's bundled
#    libraries. The old comment here claimed otherwise and it was wrong.
#    Resolution order matches tts.sh: $TG_FFMPEG, voice/bin/ffmpeg, then PATH.
# ---------------------------------------------------------------------------
have_ffmpeg() {
  [ -n "${TG_FFMPEG:-}" ] && [ -x "${TG_FFMPEG}" ] && return 0
  [ -x "$ROOT/voice/bin/ffmpeg" ] && return 0
  command -v ffmpeg >/dev/null 2>&1
}

install_ffmpeg() {
  have_ffmpeg && { say "ffmpeg: already available"; return 0; }
  # pip first, because it needs no privileges at all. imageio-ffmpeg ships a static
  # binary inside the wheel; we symlink it into voice/bin so tts.sh finds it without
  # importing Python just to transcode.
  say "ffmpeg not found — installing a private copy with pip (no root)…"
  if PIP imageio-ffmpeg; then
    local exe
    exe="$("$PY_BIN" -c 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())' 2>/dev/null)"
    if [ -n "$exe" ] && [ -x "$exe" ]; then
      mkdir -p voice/bin && ln -sf "$exe" voice/bin/ffmpeg && { say "ffmpeg: $exe"; return 0; }
    fi
  fi
  # Only now consider apt, and only if it can run without prompting for a password.
  if [ "$(id -u)" = 0 ]; then
    say "trying apt as root…"; apt-get update -qq && apt-get install -y ffmpeg && return 0
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    say "trying apt with passwordless sudo…"; sudo -n apt-get update -qq && sudo -n apt-get install -y ffmpeg && return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# --check: report and change nothing.
# ---------------------------------------------------------------------------
if [ "$CHECK" = 1 ]; then
  [ -f voice/.python ] && PY_BIN="$(cat voice/.python)"
  echo "python      : $PY_BIN ($("$PY_BIN" --version 2>&1))"
  echo "pip         : $("$PY_BIN" -m pip --version 2>&1 | head -1)"
  echo "ffmpeg      : $(have_ffmpeg && echo present || echo MISSING)"
  echo "faster-whisper (STT): $("$PY_BIN" -c 'import faster_whisper;print("present")' 2>/dev/null || echo MISSING)"
  echo "kokoro-onnx    (TTS): $("$PY_BIN" -c 'import kokoro_onnx;print("present")' 2>/dev/null || echo MISSING)"
  echo "kokoro model        : $([ -f voice/kokoro/kokoro-v1.0.onnx ] && echo present || echo MISSING)"
  echo "kokoro voices       : $([ -f voice/kokoro/voices-v1.0.bin ] && echo present || echo MISSING)"
  echo "espeak-ng  (fallback): $(command -v espeak-ng >/dev/null 2>&1 && echo present || echo MISSING)"
  exit 0
fi

# ---------------------------------------------------------------------------
resolve_pip || {
  warn "no usable pip for $PY_BIN, and no venv could be created."
  warn "Install one of these, then re-run:"
  warn "    sudo apt install -y python3-pip        # or"
  warn "    sudo apt install -y python3-venv"
  exit 1
}
say "using $PY_BIN with pip args: ${PIP_ARGS[*]:-<none>}"

install_ffmpeg || {
  # NOT fatal, and this is the whole point of the rewrite: STT and Kokoro both
  # install fine without it, and only OUTBOUND voice is lost until it exists.
  FAILED+=("ffmpeg")
  NOTES+=("ffmpeg is missing, so the bot can LISTEN but not SPEAK. Fix with one of:
       sudo apt install -y ffmpeg
       $PY_BIN -m pip install --user imageio-ffmpeg   (no root; re-run this script after)")
}

# 2. STT — faster-whisper, and warm the model so the first voice note isn't slow.
if "$PY_BIN" -c 'import faster_whisper' 2>/dev/null; then
  say "faster-whisper: already installed"
else
  say "installing faster-whisper…"
  PIP faster-whisper || { FAILED+=("faster-whisper"); NOTES+=("faster-whisper failed to install — inbound voice notes will not be transcribed."); }
fi
if "$PY_BIN" -c 'import faster_whisper' 2>/dev/null; then
  say "caching the whisper '$MODEL' model…"
  "$PY_BIN" - "$MODEL" <<'PY' || say "(model will download on first use)"
import sys
from faster_whisper import WhisperModel
WhisperModel(sys.argv[1], device="cpu", compute_type="int8")
print("ok")
PY
fi

# 3. TTS — Kokoro is the DEFAULT now, because it is the best engine and the only one
#    that needs no system package at all: pip plus two downloads.
say "installing Kokoro (kokoro-onnx, CPU)…"
if "$PY_BIN" -c 'import kokoro_onnx' 2>/dev/null; then
  say "kokoro-onnx: already installed"
else
  PIP kokoro-onnx soundfile || { FAILED+=("kokoro-onnx"); NOTES+=("kokoro-onnx failed to install — outbound voice will fall back to piper/espeak if present."); }
fi
mkdir -p voice/kokoro
KBASE="${TG_KOKORO_URL:-https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0}"
fetch() {  # fetch <url> <dest> <label>; downloads to a temp file so a partial
           # download never leaves a corrupt model that "exists" on the next run.
  [ -f "$2" ] && { say "$3: already present"; return 0; }
  say "downloading $3…"
  curl -fL --retry 2 "$1" -o "$2.part" && mv -f "$2.part" "$2" && return 0
  rm -f "$2.part"; return 1
}
fetch "$KBASE/kokoro-v1.0.onnx" voice/kokoro/kokoro-v1.0.onnx "Kokoro model (~311MB)" \
  || { FAILED+=("kokoro model"); NOTES+=("the Kokoro model did not download — re-run to retry."); }
fetch "$KBASE/voices-v1.0.bin" voice/kokoro/voices-v1.0.bin "Kokoro voices" \
  || { FAILED+=("kokoro voices"); NOTES+=("the Kokoro voices file did not download — re-run to retry."); }

# 4. Optional extras. Neither is on the good path, and neither may abort the run —
#    failing to install a FALLBACK is not a reason to fail the install.
if [ "$WANT_ESPEAK" = 1 ] && ! command -v espeak-ng >/dev/null 2>&1; then
  say "installing espeak-ng (robotic fallback voice)…"
  if [ "$(id -u)" = 0 ]; then apt-get install -y espeak-ng
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then sudo -n apt-get install -y espeak-ng
  else warn "espeak-ng needs apt and this user has no passwordless sudo — skipped (Kokoro does not need it)."; fi
fi
if [ "$WANT_PIPER" = 1 ]; then
  say "installing Piper…"
  PIP piper-tts || warn "piper-tts pip install failed (Kokoro is unaffected)"
  mkdir -p voice/piper
  URL="${TG_PIPER_VOICE_URL:-https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx}"
  fetch "$URL" voice/piper/voice.onnx "a Piper neural voice" \
    && fetch "$URL.json" voice/piper/voice.onnx.json "its config" \
    && say "add to .env:  TG_PIPER_VOICE=$ROOT/voice/piper/voice.onnx" \
    || warn "piper voice download failed (Kokoro is unaffected)"
fi

# ---------------------------------------------------------------------------
# 5. Say plainly what works and what does not. A setup script that exits 0 having
#    installed half of what was asked for is how you end up debugging silence.
# ---------------------------------------------------------------------------
echo
STT_OK=0; TTS_OK=0
"$PY_BIN" -c 'import faster_whisper' 2>/dev/null && STT_OK=1
"$PY_BIN" -c 'import kokoro_onnx' 2>/dev/null && [ -f voice/kokoro/kokoro-v1.0.onnx ] && [ -f voice/kokoro/voices-v1.0.bin ] && have_ffmpeg && TTS_OK=1
say "listening (speech → text): $([ $STT_OK = 1 ] && echo 'ready' || echo 'NOT WORKING')"
say "speaking  (text → speech): $([ $TTS_OK = 1 ] && echo 'ready (kokoro)' || echo 'NOT WORKING')"
for n in "${NOTES[@]:-}"; do [ -n "$n" ] && echo "    - $n"; done
echo
if [ $STT_OK = 1 ] || [ $TTS_OK = 1 ]; then
  # NOT "now set TG_TTS_ENGINE": tts.sh already picks kokoro whenever the model file
  # is on disk, so telling the user to edit .env implies voice is still broken when
  # it is not. The variables are overrides, and are described as such.
  [ $TTS_OK = 1 ] && say "no configuration needed — tts.sh selects kokoro because the model is present."
  [ $TTS_OK = 1 ] && say "optional overrides:  TG_KOKORO_VOICE=af_heart  TG_TTS_ENGINE=kokoro|piper|espeak"
  say "turn it on: send /voice on in a topic, or set TG_VOICE=1 in .env for every topic."
fi
[ $STT_OK = 1 ] && [ $TTS_OK = 1 ] && { say "done."; exit 0; }
warn "finished with problems: ${FAILED[*]:-see above}"
exit 1
