#!/usr/bin/env bash
# Detached restart helper: restart the claude-tg bridge, wait until the NEW
# instance is actually polling Telegram, then post a confirmation into the chat.
#
# Run detached (it must outlive the claude process the bridge spawned, because
# restarting the bridge kills that process):
#   setsid nohup bash restart-notify.sh >/tmp/restart-notify.log 2>&1 </dev/null &
set -uo pipefail

DIR=/root/sepehr/xesious
LOG="$DIR/bridge.log"
CHAT_ID="-1003777585204"
THREAD_ID="44"

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
tmux kill-session -t claude-tg 2>/dev/null || true
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
      if ! printf '%s' "$AFTER" | grep -q "409" && pgrep -f "bun run bridge.ts" >/dev/null; then
        UP=1; break
      fi
    fi
  fi
  sleep 1
done

if [ "$UP" = "1" ]; then
  log "bridge is up"
  TEXT=$'✅ Bridge restarted and fully back online.\n\nNow live:\n• Files — send any file to drop it into this topic\'s inbox/ (a caption runs as a prompt). Ask me to put a file in outbox/, or use /get <path>, to receive one.\n• Clarifying questions — I\'ll now ask instead of guessing when a request is ambiguous; just reply in this topic to continue.'
else
  log "could not confirm bridge came up within timeout"
  TEXT='⚠️ I tried to restart the bridge but could not confirm it came back within 3 minutes. Check: tmux attach -t claude-tg'
fi

curl -sS "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "message_thread_id=${THREAD_ID}" \
  --data-urlencode "text=${TEXT}" >/dev/null && log "notification sent" || log "notification send failed"
