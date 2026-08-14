#!/usr/bin/env bash
# Tier 3 harness: boot an ISOLATED staging bridge (its own token, state, sessions,
# and tmux name — never touches production) and drive it with the real-Telegram
# user client in driver.py. Exits non-zero if any case fails.
#
#   test/staging/run-staging.sh                 # uses test/staging/.env.staging
#   STAGING_REAL_CLAUDE=1 test/staging/run-staging.sh   # against real `claude`
#
# By default CLAUDE_BIN points at test/claude-stub.ts so the model is deterministic;
# what's under test here is the REAL Telegram transport + the real bridge process.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." # repo root
ROOT="$PWD"

ENVF="${STAGING_ENV:-test/staging/.env.staging}"
[ -f "$ENVF" ] || { echo "missing $ENVF — copy test/staging/.env.staging.example and fill it in" >&2; exit 1; }
set -a; . "$ENVF"; set +a

: "${STAGING_BOT_TOKEN:?set STAGING_BOT_TOKEN in $ENVF}"
: "${TEST_ACCOUNT_USER_ID:?set TEST_ACCOUNT_USER_ID in $ENVF (from gen_session.py)}"

python3 -c "import telethon" 2>/dev/null || {
  echo "driver deps missing — pip install -r test/staging/requirements.txt" >&2; exit 1; }

# bun on PATH (same portable lookup as start.sh)
if ! command -v bun >/dev/null 2>&1; then
  for d in "$HOME/.bun/bin" "$HOME/.local/bin" "$HOME"/.nvm/versions/node/*/bin; do
    [ -x "$d/bun" ] && { export PATH="$d:$PATH"; break; }
  done
fi
command -v bun >/dev/null 2>&1 || { echo "bun not on PATH" >&2; exit 1; }

STAGE_DIR="$ROOT/state/staging" # under state/ → already gitignored
mkdir -p "$STAGE_DIR"
# Fresh session state every run. A session id persisted by a previous run must not
# bleed in: the stub's fake id (sessTEST…) makes real claude error on --resume, and
# even a stale REAL id would resume the wrong conversation. Hermetic > sticky here.
rm -f "$STAGE_DIR/state.json"; rm -rf "$STAGE_DIR/sessions"
LOG="$STAGE_DIR/bridge.log"; : > "$LOG"

# Isolated environment for the staging bridge process. Both .env loaders are
# neutralized so NO production value can leak in: TG_ENV_FILE=/dev/null stops
# bridge.ts's own loadDotenv, and `bun --env-file=/dev/null` stops Bun's auto-load
# of the repo-root .env. Everything the bridge needs is exported explicitly here.
export TG_ENV_FILE=/dev/null
export TELEGRAM_BOT_TOKEN="$STAGING_BOT_TOKEN"
export TG_ALLOWED_USERS="$TEST_ACCOUNT_USER_ID"
# The fan-out tests drive a forum group; isAllowed() requires a non-private chat to
# be listed, so an unset value here makes those cases look broken rather than skipped.
[ -n "${STAGING_GROUP_ID:-}" ] && export TG_ALLOWED_CHATS="$STAGING_GROUP_ID"
export TG_SESSIONS_BASE="$STAGE_DIR/sessions"
export TG_STATE_FILE="$STAGE_DIR/state.json"
# Real-Claude mode drives the actual `claude` CLI (real model, real answer);
# otherwise the deterministic stub. STAGING_CLAUDE_BIN overrides either way.
if [ -n "${STAGING_REAL_CLAUDE:-}" ] && [ "${STAGING_REAL_CLAUDE}" != 0 ]; then
  export CLAUDE_BIN="${STAGING_CLAUDE_BIN:-claude}"
else
  export CLAUDE_BIN="${STAGING_CLAUDE_BIN:-$ROOT/test/claude-stub.ts}"
fi
export CLAUDE_TG_SESSION="claude-tg-staging"

echo "[staging] token=***${STAGING_BOT_TOKEN: -4}  CLAUDE_BIN=$CLAUDE_BIN  allow=$TEST_ACCOUNT_USER_ID"
echo "[staging] starting bridge (isolated .env)…"
# No setsid: this script is foreground, so $! is the real bun pid and the trap can
# actually signal it. (With setsid, $! is setsid's pid, which exits at once and the
# bridge would be orphaned — a leaked Telegram poller — surviving teardown.)
bun --env-file=/dev/null run "$ROOT/bridge.ts" >"$LOG" 2>&1 &
BRIDGE_PID=$!
cleanup() {
  pkill -P "$BRIDGE_PID" 2>/dev/null || true   # any child claude run
  kill -TERM "$BRIDGE_PID" 2>/dev/null || true # the bridge (its SIGTERM handler exits cleanly)
  wait "$BRIDGE_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for it to actually serve (or fail loudly).
for _ in $(seq 1 30); do
  grep -q 'polling Telegram' "$LOG" && break
  grep -qE '\[FATAL\]|\[fatal\]' "$LOG" && { echo "[staging] bridge failed:" >&2; tail -20 "$LOG" >&2; exit 1; }
  sleep 1
done
grep -q 'polling Telegram' "$LOG" || { echo "[staging] bridge never reached 'polling Telegram':" >&2; tail -20 "$LOG" >&2; exit 1; }

echo "[staging] bridge up — running driver…"
python3 test/staging/driver.py
RC=$?
echo "[staging] driver exit=$RC"
exit $RC
