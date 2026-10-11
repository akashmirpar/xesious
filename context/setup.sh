#!/usr/bin/env bash
# Meaning search for the context engine: bge-m3 (MIT) served by llama.cpp's
# llama-server (MIT), in its own process, with a cache in front of it. Keyword search
# needs none of this — it is built into bun:sqlite.
#
#   context/setup.sh             # install, write the engines config if there is none, start, check
#   context/setup.sh --no-start  # install and write the config only
#   context/setup.sh --check     # say what is installed and running; change nothing
#
# What it fetches, into $XESIOUS_DATA (~/xesious-data), once:
#   llama/<build>/llama-server   the latest prebuilt llama.cpp release for Linux (~40 MB)
#   models/bge-m3-q8_0.gguf      bge-m3, 8-bit (~635 MB)
# Overridable: LLAMA_URL (a llama.cpp release archive), EMB_MODEL_URL, or LLAMA_SERVER
# and EMB_MODEL to use files already on disk.
#
# The config: state/context-engines.json (or TG_CONTEXT_ENGINES) from
# context/context-engines.example.json — keywords, and keywords + bge-m3 as the
# default. An existing config is left alone. Then restart the bridge (./update.sh).
# The services do not start themselves after a reboot: context/services.sh start emb,
# then start cache (or add those to whatever starts the bridge).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
DATA="${XESIOUS_DATA:-$HOME/xesious-data}"
EMB_MODEL="${EMB_MODEL:-$DATA/models/bge-m3-q8_0.gguf}"
EMB_MODEL_URL="${EMB_MODEL_URL:-https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q8_0.gguf}"
CACHE_PORT="${CACHE_PORT:-8093}"
CONFIG="${TG_CONTEXT_ENGINES:-$(sed -n 's/^TG_CONTEXT_ENGINES=//p' "$REPO/.env" 2>/dev/null | tail -1)}"
CONFIG="${CONFIG:-$REPO/state/context-engines.json}"
say() { echo "[context-setup] $*"; }
llama_server() { [ -n "${LLAMA_SERVER:-}" ] && echo "$LLAMA_SERVER" || ls "$DATA"/llama/*/llama-server 2>/dev/null | head -1; }

# One embedding through the cache, as the bridge asks for it.
probe() {
  curl -s -m 60 "http://127.0.0.1:$CACHE_PORT/v1/embeddings" -H 'content-type: application/json' \
    -d '{"model":"bge-m3","input":["hello"]}' | grep -q '"embedding"'
}

if [ "${1:-}" = "--check" ]; then
  s=$(llama_server); [ -x "$s" ] && say "llama-server: $s" || say "llama-server: not installed"
  [ -f "$EMB_MODEL" ] && say "model: $EMB_MODEL" || say "model: not downloaded ($EMB_MODEL)"
  [ -f "$CONFIG" ] && say "config: $CONFIG" || say "config: none ($CONFIG)"
  probe && say "embeddings answer on :$CACHE_PORT" || say "no embeddings on :$CACHE_PORT (context/services.sh start emb, then start cache)"
  exit 0
fi

command -v curl >/dev/null || { say "needs curl"; exit 1; }

# llama-server: the release archive for this machine, unpacked so the binary and its
# libraries sit in $DATA/llama/<build>/, where context/services.sh looks.
if [ -x "$(llama_server)" ]; then
  say "llama-server: $(llama_server)"
else
  case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) ARCH=$(uname -m) ;; esac
  URL="${LLAMA_URL:-$(curl -fsSL https://api.github.com/repos/ggml-org/llama.cpp/releases/latest \
    | grep -o "\"browser_download_url\": *\"[^\"]*/llama-b[0-9]*-bin-ubuntu-$ARCH\.\(zip\|tar\.gz\)\"" \
    | head -1 | sed 's/.*"\(https[^"]*\)"$/\1/')}"
  [ -n "$URL" ] || { say "no prebuilt llama.cpp for linux-$ARCH found; build llama-server and set LLAMA_SERVER"; exit 1; }
  NAME="$(basename "$URL")"; NAME="${NAME%.zip}"; NAME="${NAME%.tar.gz}"; NAME="${NAME%-bin-ubuntu-$ARCH}"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  say "downloading $URL"
  curl -fL --progress-bar -o "$TMP/archive" "$URL" || { say "download failed"; exit 1; }
  mkdir -p "$TMP/x"
  case "$URL" in
    *.zip) if command -v unzip >/dev/null; then unzip -q "$TMP/archive" -d "$TMP/x"
           else python3 -m zipfile -e "$TMP/archive" "$TMP/x"; fi ;;
    *)     tar -xzf "$TMP/archive" -C "$TMP/x" ;;
  esac || { say "could not unpack $NAME"; exit 1; }
  BIN="$(find "$TMP/x" -name llama-server -type f | head -1)"
  [ -n "$BIN" ] || { say "no llama-server in $NAME"; exit 1; }
  mkdir -p "$DATA/llama"; rm -rf "${DATA:?}/llama/$NAME"
  mv "$(dirname "$BIN")" "$DATA/llama/$NAME" && chmod +x "$DATA/llama/$NAME/llama-server"
  say "llama-server: $DATA/llama/$NAME/llama-server"
fi
LLAMA_SERVER="$(llama_server)"; export LLAMA_SERVER
LD_LIBRARY_PATH="$(dirname "$LLAMA_SERVER")" "$LLAMA_SERVER" --version >/dev/null 2>&1 \
  || { say "$LLAMA_SERVER does not run on this machine; build llama.cpp and set LLAMA_SERVER"; exit 1; }

# The model, downloaded beside itself and moved into place only when complete.
if [ -f "$EMB_MODEL" ]; then
  say "model: $EMB_MODEL"
else
  mkdir -p "$(dirname "$EMB_MODEL")"
  say "downloading bge-m3 (~635 MB) from $EMB_MODEL_URL"
  curl -fL --progress-bar -C - -o "$EMB_MODEL.part" "$EMB_MODEL_URL" && mv "$EMB_MODEL.part" "$EMB_MODEL" \
    || { say "download failed (run again to resume)"; exit 1; }
fi
export EMB_MODEL

if [ -f "$CONFIG" ]; then
  say "config: $CONFIG exists, left as it is"
  grep -q '"embeddings"' "$CONFIG" || say "  it has no \"embeddings\" entry; see context/context-engines.example.json"
else
  mkdir -p "$(dirname "$CONFIG")"
  cp "$HERE/context-engines.example.json" "$CONFIG" && say "config: wrote $CONFIG (default engine: keywords + bge-m3)"
fi

[ "${1:-}" = "--no-start" ] && { say "done. Start it with: context/services.sh start emb && context/services.sh start cache"; exit 0; }

"$HERE/services.sh" start emb || exit 1
"$HERE/services.sh" start cache || exit 1
say "waiting for the model to load"
for _ in $(seq 1 60); do probe && break; sleep 2; done
probe || { say "no embedding came back; see $DATA/logs/emb.log and $DATA/logs/cache.log"; exit 1; }
say "ok: bge-m3 answers on :$CACHE_PORT. Restart the bridge (./update.sh) to use it."
