#!/usr/bin/env bash
# Run the live voice server in tmux so it survives SSH disconnect, respawning on
# crash. Reads LIVE_* and TG_KOKORO_* from .env.
#
#   live/start-live.sh                 # start (or report already running)
#   tmux attach -t live-voice          # watch logs
#   tmux kill-session -t live-voice    # stop
set -euo pipefail
SESSION="${LIVE_SESSION:-live-voice}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  for d in "$HOME/.bun/bin" "$HOME/.local/bin" "$HOME"/.nvm/versions/node/*/bin; do
    [ -x "$d/bun" ] && { export PATH="$d:$PATH"; break; }
  done
fi
command -v bun >/dev/null 2>&1 || { echo "ERROR: bun not on PATH" >&2; exit 1; }
[ -f "$DIR/.env" ] || { echo "ERROR: $DIR/.env missing" >&2; exit 1; }
grep -qE '^LIVE_PASSCODE=.+' "$DIR/.env" || { echo "ERROR: set LIVE_PASSCODE in .env" >&2; exit 1; }

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Already running in tmux '$SESSION'.  Attach: tmux attach -t $SESSION"
  exit 0
fi
BUNPATH="$(dirname "$(command -v bun)")"
tmux new-session -d -s "$SESSION" \
  "cd '$DIR' && export PATH='$BUNPATH':\$PATH && set -a && . ./.env && set +a && \
   while true; do bun run live/server.ts 2>&1 | tee -a live/live.log; \
   echo \"[respawn] \$(date +%H:%M:%S)\" | tee -a live/live.log; sleep 5; done"
echo "Live voice server started in tmux '$SESSION' (127.0.0.1:${LIVE_PORT:-3060})."
