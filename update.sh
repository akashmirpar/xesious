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
#
# Knobs (all optional):
#   UPDATE_SKIP_TESTS=1        skip the test gate in a pinch
#   UPDATE_MAX_WAIT=<seconds>  cap on waiting for the bridge to go idle (default 1800)
#   UPDATE_ON_BUSY=abort|force what to do when that cap is hit (default abort)
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
DIR="$PWD"
MAX_WAIT="${UPDATE_MAX_WAIT:-1800}"
ON_BUSY="${UPDATE_ON_BUSY:-abort}"
# Ceiling on waiting for a signalled bridge to finish draining. Slightly above the
# bridge's own TG_DRAIN_MAX_MS default (5 min) so the bridge's cap fires first.
DRAIN_WAIT="${UPDATE_DRAIN_WAIT:-330}"

# busy(), own_pids(), stop_own(), wait_for_idle() and find_bun() live in lib.sh so
# every deploy script selects processes the same way. The rule they enforce —
# never signal on a negative match — is documented there.
# shellcheck source=lib.sh
. "$DIR/lib.sh"

SESSION="${CLAUDE_TG_SESSION:-$(session_name_for "$DIR")}"

find_bun || { echo "ERROR: bun not on PATH" >&2; exit 1; }

say() { echo "[update] $*"; }
fail() { echo "[update] FAILED: $*" >&2; }

PULLED=0
[ "${1:-}" = "--pull" ] && PULLED=1

# 1. Snapshot BEFORE anything moves, so rollback restores the exact bytes that
#    were running — including edits that were never committed.
#
#    Snapshot the whole tracked tree, not just bridge.ts. bridge.ts used to be
#    the entire program; it is not any more. lib.ts now holds the stream parser,
#    the renderers, the mode/model normalisation and the rich-message routing, and
#    live/server.ts is its own process — so restoring bridge.ts alone puts back a
#    file that imports a still-broken module and calls it a rollback.
BEFORE="$(git rev-parse HEAD 2>/dev/null || echo '')"
BAK="$(mktemp -d /tmp/xesious-bak-XXXX)"
snapshot_tree "$BAK" || { fail "could not snapshot the working tree"; exit 1; }
say "backup: $BAK/tree.tar ($(tar -tf "$BAK/tree.tar" 2>/dev/null | wc -l) files)"

# 2. Optionally pull.
if [ "$PULLED" = 1 ]; then
  say "pulling…"; git pull --ff-only || { fail "git pull"; exit 1; }
fi

# 3. Deps + typecheck BEFORE touching the running bot. A syntax error caught here
#    costs nothing; caught after the restart it costs an outage.
say "installing deps…"; bun install >/dev/null 2>&1 || { fail "bun install"; exit 1; }
say "typechecking…"
# Two steps, because they catch different things and the first was doing duty for
# both under a misleading name: `bun build` is a BUNDLER — it resolves imports and
# never checks a type. tsc is the actual typecheck. (Neither catches a reference to
# a `const` declared later in the same scope from inside an async callback; that is
# a runtime TDZ error, and only a test that exercises the path will find it.)
bun build bridge.ts --target=node >/dev/null 2>/tmp/update-build.err || {
  fail "bridge.ts does not compile — NOT restarting. Nothing changed."; cat /tmp/update-build.err >&2; exit 1; }
if [ -x node_modules/.bin/tsc ]; then
  node_modules/.bin/tsc --noEmit >/tmp/update-tsc.err 2>&1 || {
    fail "typecheck failed — NOT restarting. Nothing changed."; head -30 /tmp/update-tsc.err >&2; exit 1; }
else
  say "  (no local tsc — skipping the type pass; bun add -d typescript to enable)"
fi

# 4. Run the test suite BEFORE touching the running bot. This is the regression
#    gate: a change that breaks any tested feature stops the deploy here, with the
#    bot still happily running the old code. --env-file=/dev/null keeps it hermetic
#    (never loads the production .env). Set UPDATE_SKIP_TESTS=1 to bypass in a pinch.
if [ "${UPDATE_SKIP_TESTS:-0}" = 1 ]; then
  say "SKIPPING tests (UPDATE_SKIP_TESTS=1)"
else
  say "running tests…"
  bun --env-file=/dev/null test >/tmp/update-test.err 2>&1 || {
    fail "tests failed — NOT restarting. Nothing changed. See below:"; tail -40 /tmp/update-test.err >&2; exit 1; }
  # The shell tier covers this script's own process-selection logic, which is
  # exactly the code that can take down someone else's bridge. Gate on it too.
  say "running shell tests…"
  bash test/shell/run.sh >/tmp/update-shelltest.err 2>&1 || {
    fail "shell tests failed — NOT restarting. Nothing changed. See below:"; tail -30 /tmp/update-shelltest.err >&2; exit 1; }
fi

# 5. Wait for idle so we never cut off a reply in flight — but bounded.
#    The old loop's 12-minute limit was the INNER loop, wrapped in `while true`,
#    so a hung claude child (one that never exits, a documented failure mode)
#    stalled the deploy forever, detached, with nothing reported.
say "waiting for the bridge to go idle (cap ${MAX_WAIT}s)…"
if ! wait_for_idle "$DIR" "$MAX_WAIT"; then
  if [ "$ON_BUSY" = force ]; then
    say "still busy after ${MAX_WAIT}s — UPDATE_ON_BUSY=force, restarting anyway (one reply may be lost)"
  else
    fail "still busy after ${MAX_WAIT}s — NOT restarting. Nothing changed."
    fail "the run may be hung; check 'tmux attach -t $SESSION', or re-run with UPDATE_ON_BUSY=force"
    rm -rf "$BAK"; exit 1
  fi
fi

restart() {
  # Only ever signals processes proven to be ours AND in this directory, and says
  # which candidates it declined. The old loop matched on cwd alone, which is a
  # kernel accident rather than a check the moment this runs as root.
  # Which pids are we actually waiting on? Capture them BEFORE signalling: the
  # supervisor now brings a cleanly-exited bridge straight back, so "wait until no
  # bridge is running" would never be true. A freshly respawned one has no
  # in-flight work, and the session teardown below takes it with the wrapper.
  local before p waited=0
  before="$(own_pids bun "$DIR" | tr '\n' ' ')"
  stop_own "$DIR" TERM || say "no bridge of ours was running"
  # The bridge now finishes and delivers in-flight runs on SIGTERM, which can take
  # longer than the three seconds this used to sleep — and cutting it short would
  # lose exactly the reply the drain exists to protect.
  for p in $before; do
    while [ -d "/proc/$p" ] && [ "$waited" -lt "$DRAIN_WAIT" ]; do sleep 1; waited=$((waited + 1)); done
    if [ -d "/proc/$p" ]; then say "pid $p still draining after ${waited}s — tearing down anyway"
    else say "pid $p drained and exited"; fi
  done
  # Kill only the tmux session proven to be running OUR bridge. The old line was
  # `tmux kill-session -t "$SESSION"` — a bare name, with no owner or cwd check —
  # so a redeploy here tore down a same-user deployment in another directory.
  tmux_kill_own "$DIR" || true
  : > bridge.log
  ./start.sh >/tmp/update-start.log 2>&1
  sleep 3
}

# Poll the health check rather than trusting one shot after a fixed sleep: a
# healthy bridge can take longer than 10s to reach 'polling Telegram' (getMe + a
# getChat per allowed chat), and a transient startup 409 self-heals in ~40s — a
# one-shot check rolled those good deploys back, defeating the recovered-409 fix.
wait_healthy() {
  local secs="${1:-60}" waited=0
  while [ "$waited" -lt "$secs" ]; do
    healthy >/dev/null 2>&1 && return 0
    sleep 3; waited=$((waited + 3))
  done
  healthy   # final attempt — prints the reason on failure
}

# 6. Health check: does it actually SERVE, not merely run? Each of these has been
#    a real outage — a crash, a fight over the token, or an auth config that made
#    the bot ignore everyone while still logging "polling Telegram".
healthy() {
  local why
  why=$(log_verdict bridge.log) || { fail "$why"; return 1; }

  # Is a bridge of ours actually alive? This must be a command substitution, not
  # a pipeline: the old form was `pgrep -x bun | while read p; do … exit 0; done`,
  # whose `exit 0` leaves the SUBSHELL the pipe created, not the function. The
  # line after it discarded its own status with `|| true` and the function then
  # returned 0 unconditionally — so this check could never fail, and a bot that
  # died right after logging 'polling Telegram' was reported healthy.
  [ -n "$(own_pids bun "$DIR")" ] || { fail "no bridge process of ours is running in $DIR"; return 1; }
  return 0
}

say "restarting…"; restart
if wait_healthy 60; then
  say "OK — up and serving. $(git rev-parse --short HEAD 2>/dev/null)"
  rm -rf "$BAK"
  exit 0
fi

# 7. Roll back to the exact bytes that were running before.
fail "health check failed — rolling back"
restore_tree "$BAK"
if [ "$PULLED" = 1 ] && [ -n "$BEFORE" ]; then
  # --mixed, never --hard. The snapshot we just restored contains uncommitted
  # edits — that is the whole reason it is a file snapshot and not a git guess —
  # and --hard would delete them a second time. --mixed moves HEAD back so it
  # agrees with the restored files, and leaves the working tree alone.
  git reset --mixed "$BEFORE" >/dev/null 2>&1 || true
fi
restart
if wait_healthy 45; then say "rolled back and healthy again (kept $BAK)"; exit 1; fi
fail "STILL unhealthy after rollback — look at bridge.log:"; tail -20 bridge.log >&2; exit 2
