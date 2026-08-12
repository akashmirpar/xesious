#!/usr/bin/env bash
# The supervisor loop tmux runs. start.sh creates the session; this keeps the
# bridge alive inside it.
#
# It lives in its own file for two reasons. It needs bash (PIPESTATUS), and tmux
# runs a session's command through /bin/sh — which may be dash, where PIPESTATUS
# does not exist. And the exit-code logic below is worth being able to read and
# test, rather than escaped into a one-line tmux argument.
#
# What changed and why. The old inline loop was:
#
#     while true; do bun run bridge.ts 2>&1 | tee -a bridge.log; \
#       echo "[respawn] exited …, restarting in 50s"; sleep 50; done
#
# `$?` after that pipeline is TEE's status, not the bridge's, so every exit looked
# identical and every restart paid the full 50-second back-off. That back-off is
# there for one specific case: a process that died without closing its Telegram
# long-poll leaves the token reserved server-side for ~30s, and starting again too
# soon earns a 409. A graceful drain closes the poll and exits 0, so there is
# nothing to wait out — reading PIPESTATUS[0] is what lets an intentional restart
# come back immediately instead of leaving the bot down for a minute.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

BACKOFF="${TG_RESPAWN_BACKOFF:-50}"
# Exit 3 means another instance holds this bot token. Retrying is still right —
# it self-heals the moment that instance stops — but at the crash cadence it would
# reprint the same three fatal lines every 50s forever, which buries anything else
# in the log. Back off much further for a condition a human has to resolve.
HELD_BACKOFF="${TG_RESPAWN_HELD_BACKOFF:-300}"
EXIT_TOKEN_HELD=3
LOG="bridge.log"

while true; do
  bun run bridge.ts 2>&1 | tee -a "$LOG"
  rc=${PIPESTATUS[0]}
  if [ "$rc" = 0 ]; then
    echo "[respawn] clean exit at $(date +%H:%M:%S) — restarting now" | tee -a "$LOG"
  elif [ "$rc" = "$EXIT_TOKEN_HELD" ]; then
    echo "[respawn] another instance holds this bot token — retrying in ${HELD_BACKOFF}s" | tee -a "$LOG"
    sleep "$HELD_BACKOFF"
  else
    echo "[respawn] exited rc=$rc at $(date +%H:%M:%S) — restarting in ${BACKOFF}s" | tee -a "$LOG"
    sleep "$BACKOFF"
  fi
done
