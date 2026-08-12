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
LOG="bridge.log"

while true; do
  bun run bridge.ts 2>&1 | tee -a "$LOG"
  rc=${PIPESTATUS[0]}
  if [ "$rc" = 0 ]; then
    echo "[respawn] clean exit at $(date +%H:%M:%S) — restarting now" | tee -a "$LOG"
  else
    echo "[respawn] exited rc=$rc at $(date +%H:%M:%S) — restarting in ${BACKOFF}s" | tee -a "$LOG"
    sleep "$BACKOFF"
  fi
done
