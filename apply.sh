#!/usr/bin/env bash
# Safely redeploy the bridge onto the latest code WITHOUT killing an in-flight
# reply. Run detached:  setsid nohup bash apply.sh >/tmp/apply.log 2>&1 &
#
# Why: the bridge answers a Telegram message by spawning
#   claude ... --output-format stream-json ...
# If we restart while that child is running, the reply is lost and only the
# progress steps remain. So we WAIT until no such run is active (idle), give the
# bot a moment to deliver the finished reply, then gracefully restart.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
if ! command -v bun >/dev/null 2>&1; then
  for d in "$HOME/.bun/bin" "$HOME/.local/bin" "$HOME"/.nvm/versions/node/*/bin; do
    [ -x "$d/bun" ] && { export PATH="$d:$PATH"; break; }
  done
fi
SESSION="${CLAUDE_TG_SESSION:-claude-tg}"
# Bridge-is-busy = this instance's bun has a claude child. A command-line match
# would also catch the IDE's own claude and deadlock against it.
busy() {
  local b
  for b in $(pgrep -x bun 2>/dev/null); do
    [ "$(readlink /proc/$b/cwd 2>/dev/null)" = "$PWD" ] || continue
    pgrep -x -P "$b" claude >/dev/null 2>&1 && return 0
  done
  return 1
}

# Wait for idle: loop until no run is active through a short grace window (so a
# message that arrives mid-wait doesn't get its reply cut off either).
while true; do
  for _ in $(seq 1 240); do busy || break; sleep 3; done
  sleep 8                                  # let the bot deliver the just-finished reply
  busy || break                            # still idle after grace -> safe to restart
done

# Graceful stop (clean long-poll close -> no ghost), then fresh start.
for p in $(pgrep -f 'bun run bridge.ts'); do
  [ "$(cat /proc/$p/comm 2>/dev/null)" = bun ] && kill -TERM "$p"
done
sleep 3
tmux kill-session -t "$SESSION" 2>/dev/null
./start.sh
