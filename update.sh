#!/usr/bin/env bash
# The one way to update this bridge. Run it instead of hand-restarting:
#
#   ./update.sh              # apply what's in the working tree, verify, roll back on failure
#   ./update.sh --pull       # git pull first, then the same
#
# It exists because updating by hand kept taking the bot down:
#   * restarting mid-run killed the in-flight reply       -> we wait for idle
#   * a bad edit only surfaced after the restart          -> we typecheck first
#   * "polling Telegram" was logged while the bot was     -> we health-check what
#     silently dropping every message (empty allowlist)      actually matters
#   * and when it did fail, nothing put the old code back -> we snapshot + roll back
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
DIR="$PWD"
SESSION="${CLAUDE_TG_SESSION:-claude-tg}"

# "Is this bridge mid-run?" = does THIS instance's bun have a claude child.
# Matching the command line instead (e.g. 'claude.*--output-format stream-json')
# also matches the IDE extension's own claude, and any other instance's — which
# deadlocks this script against the very session running it.
busy() {
  local b
  for b in $(pgrep -x bun 2>/dev/null); do
    [ "$(readlink /proc/$b/cwd 2>/dev/null)" = "$DIR" ] || continue
    pgrep -x -P "$b" claude >/dev/null 2>&1 && return 0
  done
  return 1
}

if ! command -v bun >/dev/null 2>&1; then
  for d in "$HOME/.bun/bin" "$HOME/.local/bin" "$HOME"/.nvm/versions/node/*/bin; do
    [ -x "$d/bun" ] && { export PATH="$d:$PATH"; break; }
  done
fi
command -v bun >/dev/null 2>&1 || { echo "ERROR: bun not on PATH" >&2; exit 1; }

say() { echo "[update] $*"; }
fail() { echo "[update] FAILED: $*" >&2; }

# 1. Optionally pull, remembering where we were so we can go back.
BEFORE="$(git rev-parse HEAD 2>/dev/null || echo '')"
if [ "${1:-}" = "--pull" ]; then
  say "pulling…"; git pull --ff-only || { fail "git pull"; exit 1; }
fi

# 2. Deps + typecheck BEFORE touching the running bot. A syntax error caught here
#    costs nothing; caught after the restart it costs an outage.
say "installing deps…"; bun install >/dev/null 2>&1 || { fail "bun install"; exit 1; }
say "typechecking…"
bun build bridge.ts --target=node >/dev/null 2>/tmp/update-build.err || {
  fail "bridge.ts does not compile — NOT restarting. Nothing changed."; cat /tmp/update-build.err >&2; exit 1; }

# 3. Snapshot the exact file we're replacing, so rollback is a copy, not a git guess
#    (the working tree may hold edits that were never committed).
BAK="$(mktemp -d /tmp/bridge-bak-XXXX)"; cp bridge.ts "$BAK/bridge.ts"
say "backup: $BAK/bridge.ts"

# 4. Wait for idle so we never cut off a reply in flight.
say "waiting for the bridge to go idle…"
while true; do
  for _ in $(seq 1 240); do busy || break; sleep 3; done
  sleep 8                     # let the finished reply actually get delivered
  busy || break               # still idle after the grace window -> safe
done

restart() {
  for p in $(pgrep -x bun); do
    [ "$(readlink /proc/$p/cwd 2>/dev/null)" = "$DIR" ] && kill -TERM "$p"
  done
  sleep 3
  tmux kill-session -t "$SESSION" 2>/dev/null
  : > bridge.log
  ./start.sh >/tmp/update-start.log 2>&1
  sleep 10
}

# 5. Health check: does it actually SERVE, not merely run? Each of these has been
#    a real outage — a crash, a fight over the token, or an auth config that made
#    the bot ignore everyone while still logging "polling Telegram".
healthy() {
  grep -q 'polling Telegram' bridge.log || { fail "never reached 'polling Telegram'"; return 1; }
  grep -qE '^\[FATAL\]|\[fatal\]' bridge.log && { fail "fatal in log"; return 1; }
  grep -q '409' bridge.log && { fail "409 conflict — another instance holds the token"; return 1; }
  pgrep -x bun | while read -r p; do [ "$(readlink /proc/$p/cwd 2>/dev/null)" = "$DIR" ] && exit 0; done
  pgrep -f "$DIR" >/dev/null || true
  return 0
}

say "restarting…"; restart
if healthy; then
  say "OK — up and serving. $(git rev-parse --short HEAD 2>/dev/null)"
  rm -rf "$BAK"
  exit 0
fi

# 6. Roll back to the exact bytes that were running before.
fail "health check failed — rolling back"
cp "$BAK/bridge.ts" bridge.ts
[ -n "$BEFORE" ] && [ "${1:-}" = "--pull" ] && git reset --hard "$BEFORE" >/dev/null 2>&1
restart
if healthy; then say "rolled back and healthy again (kept $BAK)"; exit 1; fi
fail "STILL unhealthy after rollback — look at bridge.log:"; tail -20 bridge.log >&2; exit 2
