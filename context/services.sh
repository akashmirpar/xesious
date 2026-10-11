#!/usr/bin/env bash
# The context engine's optional local services, each in its own process and kept
# running by a restart loop:
#
#   emb    an embeddings server: llama.cpp's llama-server with bge-m3 (MIT),
#          installed by context/setup.sh
#   cache  a cache in front of it (context/embed-cache.ts), so a text two engines
#          both embed is embedded once; engines point at this one ($CACHE_PORT)
#   txtai  the txtai engine (context/engines/txtai_service.py, Apache-2.0)
#   ocr    the text in photos (context/ocr_service.py: RapidOCR, Apache-2.0),
#          installed by context/setup-ocr.sh
#
#   context/services.sh start [emb|cache|txtai|ocr|all]
#   context/services.sh stop  [emb|cache|txtai|ocr|all]
#   context/services.sh status
#
# None runs a language model; all are CPU only. Where things are, overridable:
#   XESIOUS_DATA   base folder (~/xesious-data): models, logs, pids, txtai indexes
#   LLAMA_SERVER   llama.cpp's llama-server binary ($XESIOUS_DATA/llama/*/llama-server)
#   EMB_MODEL      embedding model file ($XESIOUS_DATA/models/bge-m3-q8_0.gguf)
#   EMB_PORT       8091      EMB_THREADS  1
#   TXTAI_PYTHON   a Python with txtai installed ($XESIOUS_DATA/venvs/txtai/bin/python)
#   TXTAI_PORT     8092
#   OCR_PYTHON     the OCR venv's Python ($XESIOUS_DATA/venvs/ocr/bin/python)
#   OCR_PORT       8094      OCR_QUOTA  25%, like EMB_QUOTA (reading a whole archive's
#                  photos takes hours at that; the photos of live talk, moments)
#   XESIOUS_CPUS   the cores they may use (taskset list, default "2,3"): a small VPS is
#                  throttled when it runs flat out for long, so these never take all
#                  of it; "" for no limit
#   EMB_QUOTA      a hard cap on the embeddings server, as a share of one core
#                  (systemd CPUQuota, default "25%"). A backfill of a large history
#                  keeps it busy for hours; one core flat out that long got this VPS
#                  throttled to 6% of its CPU. "" for no cap (fine for live messages).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="${XESIOUS_DATA:-$HOME/xesious-data}"
LLAMA_SERVER="${LLAMA_SERVER:-$(ls "$DATA"/llama/*/llama-server 2>/dev/null | head -1)}"
EMB_MODEL="${EMB_MODEL:-$DATA/models/bge-m3-q8_0.gguf}"
EMB_PORT="${EMB_PORT:-8091}"
EMB_THREADS="${EMB_THREADS:-1}"
CPUS="${XESIOUS_CPUS-2,3}"
PIN=(); if [ -n "$CPUS" ] && command -v taskset >/dev/null; then PIN=(taskset -c "$CPUS"); fi
EMB_QUOTA="${EMB_QUOTA-25%}"
TXTAI_QUOTA="${TXTAI_QUOTA-25%}"
OCR_QUOTA="${OCR_QUOTA-25%}"
HAVE_SCOPES=0; command -v systemd-run >/dev/null && systemd-run --user --scope --quiet true 2>/dev/null && HAVE_SCOPES=1
# A hard CPU cap (a share of one core) around a command, when systemd can give one.
capped() { local q=$1; shift; if [ "$HAVE_SCOPES" = 1 ] && [ -n "$q" ]; then echo systemd-run --user --scope --quiet -p "CPUQuota=$q"; fi; }
CAP=($(capped "$EMB_QUOTA"))
TCAP=($(capped "$TXTAI_QUOTA"))
OCAP=($(capped "$OCR_QUOTA"))
TXTAI_PYTHON="${TXTAI_PYTHON:-$DATA/venvs/txtai/bin/python}"
TXTAI_PORT="${TXTAI_PORT:-8092}"
CACHE_PORT="${CACHE_PORT:-8093}"
OCR_PYTHON="${OCR_PYTHON:-$DATA/venvs/ocr/bin/python}"
OCR_PORT="${OCR_PORT:-8094}"
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
RUN="$DATA/run"; LOGS="$DATA/logs"
mkdir -p "$RUN" "$LOGS"

say() { echo "[services] $*"; }

# Runs "$@" forever in its own process group, restarting it 3 s after it exits.
keep() {
  local name=$1; shift
  if running "$name"; then say "$name is already running (pid $(cat "$RUN/$name.pid"))"; return 0; fi
  setsid "${PIN[@]}" bash -c 'while true; do "$@"; echo "[services] exited with $?, restarting in 3 s"; sleep 3; done' _ "$@" >> "$LOGS/$name.log" 2>&1 < /dev/null &
  echo $! > "$RUN/$name.pid"
  say "$name started (pid $!), log: $LOGS/$name.log"
}
running() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
stop_one() {
  if running "$1"; then
    local g; g=$(cat "$RUN/$1.pid")
    kill -- -"$g" 2>/dev/null
    # A server busy on a request can outlast the polite signal; nothing of it may linger.
    for _ in 1 2 3 4 5; do pgrep -g "$g" >/dev/null || break; sleep 1; done
    pgrep -g "$g" >/dev/null && kill -KILL -- -"$g" 2>/dev/null
    say "$1 stopped"
  else say "$1 was not running"; fi
  rm -f "$RUN/$1.pid"
}

start_emb() {
  [ -x "$LLAMA_SERVER" ] || { say "no llama-server (set LLAMA_SERVER)"; return 1; }
  [ -f "$EMB_MODEL" ] || { say "no embedding model at $EMB_MODEL (set EMB_MODEL)"; return 1; }
  [ ${#CAP[@]} -gt 0 ] && say "emb capped at $EMB_QUOTA of one core"
  LD_LIBRARY_PATH="$(dirname "$LLAMA_SERVER")" keep emb "${CAP[@]}" nice -n 19 "$LLAMA_SERVER" -m "$EMB_MODEL" --alias bge-m3 --host 127.0.0.1 --port "$EMB_PORT" \
    --embedding -c 4096 -b 2048 -ub 2048 -np 1 -t "$EMB_THREADS" --no-webui
}
start_cache() {
  EMB_UPSTREAM="http://127.0.0.1:$EMB_PORT" EMB_CACHE="$DATA/emb-cache.db" EMB_CACHE_PORT="$CACHE_PORT" \
    keep cache "$BUN" "$HERE/embed-cache.ts"
}
start_txtai() {
  [ -x "$TXTAI_PYTHON" ] || { say "no Python with txtai (set TXTAI_PYTHON)"; return 1; }
  TXTAI_PORT="$TXTAI_PORT" TXTAI_DATA="$DATA/txtai" EMB_URL="http://127.0.0.1:$CACHE_PORT" EMB_MODEL=bge-m3 \
    keep txtai "${TCAP[@]}" nice -n 19 "$TXTAI_PYTHON" "$HERE/engines/txtai_service.py"
}
start_ocr() {
  [ -x "$OCR_PYTHON" ] || { say "no OCR venv (run context/setup-ocr.sh, or set OCR_PYTHON)"; return 1; }
  OCR_PORT="$OCR_PORT" keep ocr "${OCAP[@]}" nice -n 19 "$OCR_PYTHON" "$HERE/ocr_service.py"
}

what="${2:-all}"
case "${1:-status}" in
  start)
    if [[ $what == emb || $what == all ]]; then start_emb; fi
    if [[ $what == cache || $what == all ]]; then start_cache; fi
    if [[ $what == txtai || $what == all ]]; then start_txtai; fi
    if [[ $what == ocr || $what == all ]]; then start_ocr; fi ;;
  stop)
    if [[ $what == ocr || $what == all ]]; then stop_one ocr; fi
    if [[ $what == txtai || $what == all ]]; then stop_one txtai; fi
    if [[ $what == cache || $what == all ]]; then stop_one cache; fi
    if [[ $what == emb || $what == all ]]; then stop_one emb; fi ;;
  status)
    for s in emb cache txtai ocr; do if running $s; then say "$s: running (pid $(cat "$RUN/$s.pid"))"; else say "$s: stopped"; fi; done
    curl -s -m 3 "http://127.0.0.1:$EMB_PORT/health" >/dev/null && say "emb answers on :$EMB_PORT" || say "emb does not answer on :$EMB_PORT"
    curl -s -m 3 "http://127.0.0.1:$CACHE_PORT/cache" && echo || say "cache does not answer on :$CACHE_PORT"
    curl -s -m 3 "http://127.0.0.1:$TXTAI_PORT/health" && echo || say "txtai does not answer on :$TXTAI_PORT"
    curl -s -m 3 "http://127.0.0.1:$OCR_PORT/health" && echo || say "ocr does not answer on :$OCR_PORT" ;;
  *) echo "usage: $0 start|stop|status [emb|cache|txtai|ocr|all]"; exit 2 ;;
esac
