#!/usr/bin/env bash
# Detached restart helper: restart the claude-tg bridge, wait until the NEW
# instance is actually polling Telegram, then post a confirmation into the chat.
#
# Run detached (it must outlive the claude process the bridge spawned, because
# restarting the bridge kills that process):
#   setsid nohup bash restart-notify.sh >/tmp/restart-notify.log 2>&1 </dev/null &
#
# Where the notification goes — override per deployment, since the defaults are
# one specific chat and are wrong for anyone else's:
#   TG_RESTART_CHAT_ID, TG_RESTART_THREAD_ID
#   TG_RESTART_TEXT     what to say on success (default: a plain confirmation)
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$DIR/bridge.log"
# shellcheck source=lib.sh
. "$DIR/lib.sh"

# Was hardcoded to one chat/thread. Kept as defaults so this deployment behaves
# exactly as before, but overridable so the script isn't married to one group.
CHAT_ID="${TG_RESTART_CHAT_ID:--1003777585204}"
THREAD_ID="${TG_RESTART_THREAD_ID:-44}"
# Was hardcoded to `claude-tg`, ignoring the CLAUDE_TG_SESSION that start.sh,
# update.sh and apply.sh all honour — so on any deployment that set it, this
# script killed the wrong session (or none) and then waited three minutes to
# conclude the bridge never came back.
SESSION="${CLAUDE_TG_SESSION:-$(session_name_for "$DIR")}"

log() { echo "[restart-notify $(date +%H:%M:%S)] $*"; }

# Token straight from .env so it never has to be passed around in the clear.
TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$DIR/.env" | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//' | tr -d '[:space:]')
if [ -z "${TOKEN:-}" ]; then log "no TELEGRAM_BOT_TOKEN in .env, aborting"; exit 1; fi

# Let the current run's reply get delivered before we cut the bridge down.
sleep 8

# Remember where the log is so we only look at the NEW instance's output.
START=$(wc -c < "$LOG" 2>/dev/null || echo 0)
log "restarting; log offset=$START"

# start.sh no-ops if a session already exists, so kill it first (this also kills
# the old bridge + any claude subprocess it spawned).
tmux_kill_own "$DIR" || true   # by process proof, not by name
sleep 1
( cd "$DIR" && ./start.sh ) >/dev/null 2>&1 || true

# Wait (up to ~3 min) for the new instance to log that it is polling, and make
# sure that line isn't immediately followed by a 409 back-off (the self-heal
# path). Re-check after a short settle so we don't notify during a 409 wait.
UP=0
for i in $(seq 1 180); do
  NEW=$(tail -c +"$((START + 1))" "$LOG" 2>/dev/null)
  if printf '%s' "$NEW" | grep -q "polling Telegram"; then
    AFTER=$(printf '%s\n' "$NEW" | awk '/polling Telegram/{seen=1; buf=""; next} seen{buf=buf $0 ORS} END{printf "%s", buf}')
    if ! printf '%s' "$AFTER" | grep -q "409"; then
      sleep 4
      NEW=$(tail -c +"$((START + 1))" "$LOG" 2>/dev/null)
      AFTER=$(printf '%s\n' "$NEW" | awk '/polling Telegram/{seen=1; buf=""; next} seen{buf=buf $0 ORS} END{printf "%s", buf}')
      # The liveness half used `pgrep -f "bun run bridge.ts"` — no owner filter and
      # no cwd filter — so ANOTHER user's bridge could satisfy "we came back up"
      # and this script would report success while our own bot was down.
      if ! printf '%s' "$AFTER" | grep -q "409" && [ -n "$(own_pids bun "$DIR")" ]; then
        UP=1; break
      fi
    fi
  fi
  sleep 1
done

if [ "$UP" = "1" ]; then
  log "bridge is up"
  # Was a hardcoded "Now live: …" release announcement for one specific deploy,
  # re-sent verbatim on every restart long after those features shipped. Default
  # to stating only what this script actually knows; set TG_RESTART_TEXT when a
  # restart really does carry news.
  TEXT="${TG_RESTART_TEXT:-✅ Bridge restarted and back online.}"
else
  log "could not confirm bridge came up within timeout"
  TEXT="⚠️ I tried to restart the bridge but could not confirm it came back within 3 minutes. Check: tmux attach -t $SESSION"
fi

curl -sS "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "message_thread_id=${THREAD_ID}" \
  --data-urlencode "text=${TEXT}" >/dev/null && log "notification sent" || log "notification send failed"
