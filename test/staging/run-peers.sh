#!/usr/bin/env bash
# Tier 3, two bots: hand-offs between two xesious bridges over REAL Telegram. Boots
# two ISOLATED staging bridges in the staging group, the staging bot (A) and a second
# bot (B), each listing the other in TG_PEER_BOTS, and drives hand-offs between them
# with test/staging/peer_driver.py as the test account. Exits non-zero if a case fails.
#
#   test/staging/run-peers.sh
#
# Needs, in test/staging/.env.staging (gitignored), besides what run-staging.sh needs:
#   STAGING_GROUP_ID            the forum group both bots and the test account are in
#   STAGING_PEER_BOT_TOKEN      the second bot's token
#   STAGING_PEER_BOT_USERNAME   …and its username
# Both bots: privacy mode off, Bot-to-Bot Communication Mode on (@BotFather).
#
# The model is the stub (test/claude-stub.ts): its MCPTASK scenario calls the handoff
# tool, so what is under test is Telegram between the bots and the bridges' handling.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." # repo root
ROOT="$PWD"

ENVF="${STAGING_ENV:-test/staging/.env.staging}"
[ -f "$ENVF" ] || { echo "missing $ENVF — copy test/staging/.env.staging.example and fill it in" >&2; exit 1; }
set -a; . "$ENVF"; set +a
: "${STAGING_BOT_TOKEN:?set STAGING_BOT_TOKEN in $ENVF}"
: "${STAGING_BOT_USERNAME:?set STAGING_BOT_USERNAME in $ENVF}"
: "${STAGING_PEER_BOT_TOKEN:?set STAGING_PEER_BOT_TOKEN in $ENVF}"
: "${STAGING_PEER_BOT_USERNAME:?set STAGING_PEER_BOT_USERNAME in $ENVF}"
: "${STAGING_GROUP_ID:?set STAGING_GROUP_ID in $ENVF}"
: "${TEST_ACCOUNT_USER_ID:?set TEST_ACCOUNT_USER_ID in $ENVF (from gen_session.py)}"

[ -d "$ROOT/test/staging/.deps" ] && export PYTHONPATH="$ROOT/test/staging/.deps${PYTHONPATH:+:$PYTHONPATH}"
python3 -c "import telethon" 2>/dev/null || {
  echo "driver deps missing — pip install -t test/staging/.deps -r test/staging/requirements.txt" >&2; exit 1; }
if ! command -v bun >/dev/null 2>&1; then
  for d in "$HOME/.bun/bin" "$HOME/.local/bin" "$HOME"/.nvm/versions/node/*/bin; do
    [ -x "$d/bun" ] && { export PATH="$d:$PATH"; break; }
  done
fi
command -v bun >/dev/null 2>&1 || { echo "bun not on PATH" >&2; exit 1; }

# Wiped every run, so outside any repository (Claude's memory belongs to a repo) and
# with "staging" in the path, as run-staging.sh insists.
BASE="${STAGING_PEERS_BASE:-${XDG_STATE_HOME:-$HOME/.local/state}/xesious-staging-peers}"
case "$BASE" in *staging*) ;; *) echo "[peers] refusing $BASE: it is wiped every run, so its path must contain 'staging'" >&2; exit 1 ;; esac
if git -C "$(dirname "$BASE")" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "[peers] $BASE is inside a git repository; set STAGING_PEERS_BASE elsewhere" >&2; exit 1
fi
A_PORT="${STAGING_PEERS_PORT_A:-41871}"
B_PORT="${STAGING_PEERS_PORT_B:-41872}"
CLAUDE="${STAGING_CLAUDE_BIN:-$ROOT/test/claude-stub.ts}"

PIDS=()
# One bridge: its name (a|b), its token, the bot it hands off to, its file port.
start_bridge() {
  local name=$1 token=$2 peer=$3 port=$4
  local dir="$ROOT/state/staging-peer-$name" sessions="$BASE/$name/sessions"
  rm -rf "$dir" "$BASE/$name"; mkdir -p "$dir" "$sessions"
  (
    export TG_ENV_FILE=/dev/null TELEGRAM_BOT_TOKEN="$token" TG_ALLOWED_USERS="$TEST_ACCOUNT_USER_ID"
    export TG_ALLOWED_CHATS="$STAGING_GROUP_ID" TG_SESSIONS_BASE="$sessions" TG_STATE_FILE="$dir/state.json"
    # Two bots read every message in the group: each answers only when named.
    export TG_REQUIRE_MENTION=1
    export CLAUDE_BIN="$CLAUDE" CLAUDE_TG_SESSION="claude-tg-staging-peer-$name"
    export TG_PEER_BOTS="$peer" TG_TASKS_WEBHOOK_PORT="$port"
    exec bun --env-file=/dev/null run "$ROOT/bridge.ts"
  ) >"$dir/bridge.log" 2>&1 &
  PIDS+=($!)
  echo "[peers] bridge $name: pid $!, log $dir/bridge.log"
}
cleanup() {
  for p in "${PIDS[@]}"; do pkill -P "$p" 2>/dev/null || true; kill -TERM "$p" 2>/dev/null || true; done
  for p in "${PIDS[@]}"; do wait "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

start_bridge a "$STAGING_BOT_TOKEN" "$STAGING_PEER_BOT_USERNAME" "$A_PORT"
start_bridge b "$STAGING_PEER_BOT_TOKEN" "$STAGING_BOT_USERNAME" "$B_PORT"
for name in a b; do
  LOG="$ROOT/state/staging-peer-$name/bridge.log"
  for _ in $(seq 1 40); do
    grep -q 'polling Telegram' "$LOG" && break
    grep -qE '\[FATAL\]|\[fatal\]' "$LOG" && { echo "[peers] bridge $name failed:" >&2; tail -20 "$LOG" >&2; exit 1; }
    sleep 1
  done
  grep -q 'polling Telegram' "$LOG" || { echo "[peers] bridge $name never reached 'polling Telegram':" >&2; tail -20 "$LOG" >&2; exit 1; }
done

echo "[peers] both bridges up — running the driver…"
export STAGING_PEERS_BASE="$BASE" STAGING_PEERS_STATE="$ROOT/state"
python3 -u test/staging/peer_driver.py
RC=$?
echo "[peers] driver exit=$RC"
exit $RC
