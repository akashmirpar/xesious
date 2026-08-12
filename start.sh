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

# find_bun(), own_pids() and stop_own() live in lib.sh so every deploy script
# selects processes the same way. See the rule documented at the top of it.
# shellcheck source=lib.sh
. "$DIR/lib.sh"

find_bun || { echo "ERROR: bun not on PATH" >&2; exit 1; }
[ -f "$DIR/.env" ] || { echo "ERROR: $DIR/.env missing (cp .env.example .env)" >&2; exit 1; }

# Optional: bring up the local Bot API server alongside the bridge (big files).
# Only starts the container — it never migrates the bot off the cloud API, since
# that's irreversible for 10 minutes. See ./local-api.sh migrate.
if grep -qE '^TG_LOCAL_API=(1|true|yes)' "$DIR/.env" 2>/dev/null; then
  "$DIR/local-api.sh" up || { echo "ERROR: local Bot API server failed to start" >&2; exit 1; }
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Already running in tmux session '$SESSION'.  Attach: tmux attach -t $SESSION"
  echo "(to restart: tmux kill-session -t $SESSION && ./start.sh)"
  exit 0
fi

# Kill only THIS instance's orphaned poller. Telegram allows one getUpdates per
# token; two => 409. The old loop compared cwd only, and its comment claimed a
# second instance in another directory "is never affected" as a property of the
# code — it was really a property of /proc permissions, and false under root.
# stop_own() requires owner AND cwd to match positively, and reports what it
# declined, so the guarantee is now actually in the code.
#
# TERM before KILL: -9 denies the old process any chance to close its long-poll
# cleanly, which is what provokes the very 409 the respawn wrapper below then
# waits 50s to clear. Give it 3s to exit politely, then insist.
stop_own "$DIR" TERM || true
for _ in 1 2 3; do [ -n "$(own_pids bun "$DIR")" ] || break; sleep 1; done
stop_own "$DIR" KILL >/dev/null 2>&1 || true
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
