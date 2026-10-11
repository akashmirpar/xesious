#!/usr/bin/env bash
# The optional OCR service of the context engine (context/ocr_service.py): the text in
# photos, read on this machine's CPU. Installs a Python venv with RapidOCR (Apache-2.0),
# ONNX Runtime (MIT) and python-bidi (LGPL-3.0, for right-to-left text), then fetches
# the models it uses once — PaddleOCR's PP-OCRv5 line finder, English and
# Arabic-script readers (Apache-2.0, about 30 MB) — by reading a test image.
#
#   context/setup-ocr.sh           # install into $XESIOUS_DATA/venvs/ocr (~/xesious-data)
#   context/setup-ocr.sh --check   # say what is installed and change nothing
#
# Then: context/services.sh start ocr, and "ocr": { "url": "http://127.0.0.1:8094" } in
# context-engines.json. context/OCR.md has how the readers were chosen.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="${XESIOUS_DATA:-$HOME/xesious-data}"
VENV="${OCR_VENV:-$DATA/venvs/ocr}"
PY="$VENV/bin/python"
# The versions measured in OCR.md: RapidOCR's internals (the steps ocr_service.py runs
# one by one) are not a stable interface.
PKGS=("rapidocr==3.9.2" "onnxruntime==1.30.0" "python-bidi==0.6.11")
say() { echo "[ocr-setup] $*"; }

warm() {
  OCR_MODEL=fa+en "$PY" - "$HERE" <<'EOF'
import sys
sys.path.insert(0, sys.argv[1])
import cv2, numpy as np
import ocr_service
img = np.full((80, 520, 3), 255, np.uint8)
cv2.putText(img, 'Hello world 2026', (12, 52), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 0), 2)
lines = ocr_service.read(img)
print('[ocr-setup] test image read as:', ' / '.join(l['text'] for l in lines) or '(nothing)')
sys.exit(0 if any('hello' in l['text'].lower() for l in lines) else 1)
EOF
}

if [ "${1:-}" = "--check" ]; then
  if [ -x "$PY" ]; then say "venv: $VENV"; warm || say "installed, but the test image was not read"
  else say "not installed ($VENV)"; fi
  exit 0
fi

mkdir -p "$(dirname "$VENV")"
if command -v uv >/dev/null; then
  say "creating $VENV with uv"
  uv venv -q -p 3.12 "$VENV" && uv pip install -q --python "$PY" "${PKGS[@]}" || { say "install failed"; exit 1; }
else
  say "creating $VENV with python3 -m venv"
  python3 -m venv "$VENV" && "$VENV/bin/pip" install -q "${PKGS[@]}" || { say "install failed"; exit 1; }
fi
say "fetching the models and reading a test image"
warm || { say "the test image was not read — see the output above"; exit 1; }
say "done. Start it with: context/services.sh start ocr"
