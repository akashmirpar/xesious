#!/usr/bin/env bash
# Run the bridge inside tmux so it survives SSH disconnect / laptop sleep.
#
#   ./start.sh                  # start (or report already running)
#   tmux attach -t claude-tg    # watch logs / interact
#   Ctrl-b then d               # detach, leaves it running
#   tmux kill-session -t claude-tg   # stop
set -euo pipefail

SESSION="${CLAUDE_TG_SESSION:-claude-tg}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# bun lives in the node bin dir (installed via npm); make sure it's on PATH.
export PATH="/root/.nvm/versions/node/v24.2.0/bin:$PATH"

command -v bun >/dev/null 2>&1 || { echo "ERROR: bun not on PATH" >&2; exit 1; }
[ -f "$DIR/.env" ] || { echo "ERROR: $DIR/.env missing (cp .env.example .env)" >&2; exit 1; }

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Already running in tmux session '$SESSION'.  Attach: tmux attach -t $SESSION"
  echo "(to restart: tmux kill-session -t $SESSION && ./start.sh)"
  exit 0
fi

# Kill only THIS instance's orphaned poller (matched by working directory), so a
# second instance in another directory is never affected. Telegram allows one
# getUpdates per token; two => 409.
for p in $(pgrep -x bun 2>/dev/null); do
  [ "$(readlink /proc/$p/cwd 2>/dev/null)" = "$DIR" ] && kill -9 "$p" 2>/dev/null || true
done
sleep 3  # let Telegram release the previous long-poll lock

# Respawn wrapper with a long restart delay. grammY can't catch a polling 409
# in-process, so if the bot exits on one (a previous instance's long-poll still
# reserved server-side), we wait 50s — longer than Telegram's ~30s long-poll
# expiry — so the NEXT start finds the token free and comes up clean. Once a
# clean start happens, the bot stays up indefinitely.
tmux new-session -d -s "$SESSION" -c "$DIR" \
  "while true; do PATH='$PATH' bun run bridge.ts 2>&1 | tee -a bridge.log; echo \"[respawn] exited \$(date +%H:%M:%S), restarting in 50s\" | tee -a bridge.log; sleep 50; done"
echo "Started in tmux session '$SESSION'."
echo "Watch:  tmux attach -t $SESSION     Detach: Ctrl-b then d"
