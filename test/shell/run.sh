#!/usr/bin/env bash
# Tier 0 — unit tests for lib.sh, the deploy scripts' process-selection primitives.
#
# This is the tier the project did not have. Tiers 1-3 all exercise TypeScript;
# nothing covered the shell, which is precisely where a mistake kills someone
# else's bot. These are the rules worth pinning, since every one of them was
# broken in at least one script:
#   * a process must be OURS (uid) and in OUR directory before it is ever signalled
#   * an unreadable /proc entry means "not mine", not "probably fine"
#   * an empty directory argument must select NOTHING, never everything
#
# Hermetic and safe to run on a box with live bridges: every process it creates
# is a throwaway `sleep` in a temp directory, and every assertion is scoped to
# those temp directories, so a real bridge (whose cwd is the repo) is never
# selected, never signalled, and never even a candidate. Run with:
#   bash test/shell/run.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
ROOT="$PWD"
# shellcheck source=../../lib.sh
. ./lib.sh

PASS=0; FAIL=0
ok()  { printf '  \033[32m[PASS]\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
no()  { printf '  \033[31m[FAIL]\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
is()  { [ "$2" = "$3" ] && ok "$1" || no "$1 — want '$3', got '$2'"; }
yes_() { if "${@:2}" >/dev/null 2>&1; then ok "$1"; else no "$1 — expected success"; fi; }
not_() { if "${@:2}" >/dev/null 2>&1; then no "$1 — expected failure"; else ok "$1"; fi; }
has()  { case " $2 " in *" $3 "*) ok "$1" ;; *) no "$1 — '$3' not in '$2'" ;; esac; }
hasnt(){ case " $2 " in *" $3 "*) no "$1 — '$3' unexpectedly in '$2'" ;; *) ok "$1" ;; esac; }

TMP=$(mktemp -d /tmp/xesious-shelltest-XXXXXX)
BIN="$TMP/bin"; DIR_A="$TMP/a"; DIR_B="$TMP/b"
mkdir -p "$BIN" "$DIR_A" "$DIR_B"
SPAWNED=()
cleanup() {
  local p
  for p in "${SPAWNED[@]:-}"; do [ -n "$p" ] && kill -9 "$p" 2>/dev/null; done
  rm -rf "$TMP"
}
trap cleanup EXIT

# Real processes named `bun` and `claude`, so pgrep -x matches for real rather
# than against a mock. Copies of stock binaries: /proc/<pid>/comm is the
# executable's basename, so a copy of `sleep` called `claude` IS a claude to
# every selector under test.
#
# Two flavours of fake bun, because they need different binaries. A *bare* bun
# must simply stay alive, so it is a copy of `sleep`. A *busy* bun must fork a
# child, so it is a copy of `bash`. Using bash for both is what a first draft of
# this file did, and `bash 300` reads 300 as a script filename and exits
# immediately — the fake was dead before any assertion ran, which made two
# checks pass for entirely the wrong reason.
BIN_BUSY="$TMP/bin-busy"; mkdir -p "$BIN_BUSY"
cp "$(command -v sleep)" "$BIN/claude"
cp "$(command -v sleep)" "$BIN/bun"
cp "$(command -v bash)"  "$BIN_BUSY/bun"

# Both spawners set REPLY rather than echoing, and both redirect the child's
# stdout. Two bash traps, either of which makes this file hang or leak:
#   * a backgrounded process inherits the command substitution's pipe, so
#     `p=$(spawn_in …)` blocks until the 300s sleep exits, not until it starts;
#   * `SPAWNED+=(…)` inside `$( )` runs in a subshell, so the parent's cleanup
#     array stays empty and every fake process outlives the run.
spawn_in() {  # <dir> <name>; sets REPLY to the pid of a bare process (no children)
  ( cd "$1" && exec "$BIN/$2" 300 ) >/dev/null 2>&1 &
  REPLY=$!; SPAWNED+=("$REPLY"); disown "$REPLY" 2>/dev/null
}
spawn_busy_bun() {  # <dir>; sets REPLY to a `bun` that HAS a `claude` child
  # `& wait` forces a real child: bash would otherwise exec the last command in
  # -c directly, replacing itself, and there would be no child to find.
  ( cd "$1" && exec "$BIN_BUSY/bun" -c "\"$BIN/claude\" 300 & wait" ) >/dev/null 2>&1 &
  REPLY=$!; SPAWNED+=("$REPLY"); disown "$REPLY" 2>/dev/null
}

echo "== own_pids: selects by owner AND directory =="
spawn_in "$DIR_A" claude; PID_A=$REPLY
spawn_in "$DIR_B" claude; PID_B=$REPLY
sleep 0.3
GOT_A=$(own_pids claude "$DIR_A" | tr '\n' ' ')
GOT_B=$(own_pids claude "$DIR_B" | tr '\n' ' ')
has   "finds my process in its own directory"        "$GOT_A" "$PID_A"
hasnt "does not select a process from another dir"   "$GOT_A" "$PID_B"
has   "finds the other one when asked for its dir"   "$GOT_B" "$PID_B"
hasnt "and that query excludes the first"            "$GOT_B" "$PID_A"

echo
echo "== the empty-argument guard: select nothing, never everything =="
is "empty dir selects nothing"          "$(own_pids claude '' | wc -l)" "0"
is "empty procname selects nothing"     "$(own_pids '' "$DIR_A" | wc -l)" "0"
is "both empty selects nothing"         "$(own_pids '' '' | wc -l)" "0"
not_ "busy with no dir is false"        busy ""

echo
echo "== owns_pid: unprovable ownership is never ownership =="
# pid 1 is root-owned and its cwd is unreadable to us — the exact shape of
# another user's bridge, which is what the old `comm`-based guard let through.
not_ "pid 1 (root, unreadable cwd) is not mine"  owns_pid 1 /
not_ "a nonexistent pid is not mine"             owns_pid 999999 "$DIR_A"
not_ "a pid with no dir argument is not mine"    owns_pid "$PID_A" ""
not_ "my pid in the WRONG dir is not mine"       owns_pid "$PID_A" "$DIR_B"
yes_ "my pid in the RIGHT dir is mine"           owns_pid "$PID_A" "$DIR_A"

echo
echo "== the regression this branch exists for: another user's bridge is untouchable =="
# On a multi-user box this exercises a REAL foreign bridge. apply.sh's old
# selector (pgrep -f + a /proc/<pid>/comm guard) selected exactly this process
# and called kill -TERM on it; as root that succeeds and takes down another
# person's bot mid-reply.
FOREIGN=""
for p in $(pgrep -x bun 2>/dev/null); do
  [ "$(stat -c %u "/proc/$p" 2>/dev/null)" = "$(id -u)" ] || { FOREIGN="$p"; break; }
done
if [ -n "$FOREIGN" ]; then
  echo "  (found a foreign bun on this box: pid $FOREIGN, owner $(stat -c %U "/proc/$FOREIGN" 2>/dev/null))"
  not_ "a foreign bun is not mine, even guessing my own dir" owns_pid "$FOREIGN" "$PWD"
  hasnt "and own_pids never lists it" "$(own_pids bun "$PWD" | tr '\n' ' ')" "$FOREIGN"
  # The old guard, reproduced: this is what used to pass.
  is "…while /proc/<pid>/comm — the OLD guard — still says 'bun'" \
     "$(cat "/proc/$FOREIGN/comm" 2>/dev/null)" "bun"
else
  echo "  (no foreign bun running; skipping the live cross-user case)"
fi

echo
echo "== busy: only counts a run belonging to us =="
spawn_busy_bun "$DIR_A"; BUSY_BUN=$REPLY
sleep 0.5
yes_ "a bun with a claude child in our dir is busy"     busy "$DIR_A"
not_ "the same run does not make another dir busy"      busy "$DIR_B"
spawn_in "$DIR_B" bun; IDLE_BUN=$REPLY
sleep 0.3
not_ "a bun with no claude child is not busy"           busy "$DIR_B"

echo
echo "== wait_for_idle: bounded, and reports the cap rather than hanging =="
START=$(date +%s)
if wait_for_idle "$DIR_A" 6; then
  no "a permanently busy dir must NOT report idle"
else
  ok "a permanently busy dir hits the cap and returns failure"
fi
ELAPSED=$(( $(date +%s) - START ))
if [ "$ELAPSED" -le 20 ]; then ok "…and it gave up in ${ELAPSED}s, near the 6s cap"
else no "cap not honoured — waited ${ELAPSED}s"; fi
if wait_for_idle "$DIR_B" 30; then ok "an idle dir returns success"
else no "an idle dir should report idle"; fi

echo
echo "== stop_own: signals only ours, and says what it declined =="
spawn_in "$DIR_A" bun; VICTIM=$REPLY
sleep 0.3
OUT=$(stop_own "$DIR_A" TERM 2>&1)
sleep 0.3
case "$OUT" in *"signalled TERM -> pid $VICTIM"*) ok "signalled our own bun" ;;
                *) no "did not signal our own bun — output: $OUT" ;; esac
if kill -0 "$VICTIM" 2>/dev/null; then no "our bun should have been signalled"; else ok "our bun is gone"; fi
if [ -n "$FOREIGN" ]; then
  case "$OUT" in *"skipped pid $FOREIGN"*) ok "declined the foreign bun, and said so" ;;
                  *) no "did not report skipping the foreign bun" ;; esac
  # Liveness of a FOREIGN pid must be read from /proc, not `kill -0`: signal 0
  # to another user's process returns EPERM, which is a non-zero exit and looks
  # exactly like death. Getting this wrong reports a cross-user kill that never
  # happened — which is a bad way to find out your safety test is lying.
  if [ -d "/proc/$FOREIGN" ]; then ok "the foreign bun is still alive"
  else no "THE FOREIGN BUN WAS KILLED — this is the bug"; fi
fi

echo
echo "== log_verdict: a RECOVERED 409 is not a failure =="
LOGD="$TMP/logs"; mkdir -p "$LOGD"
printf '[ok] polling Telegram\n' > "$LOGD/good.log"
printf 'starting up\n'           > "$LOGD/nopoll.log"
printf '[ok] polling Telegram\n[fatal] boom\n' > "$LOGD/fatal.log"
# The bridge catches a polling 409, waits ~40s and resumes — this is the shape of
# a HEALTHY startup, and the old check rolled it back for containing '409'.
printf '[warn] 409 conflict — waiting 40s\n[ok] polling Telegram (resumed #2)\n' > "$LOGD/recovered.log"
# Genuinely bad: nothing polled after the conflict.
printf '[ok] polling Telegram\n[warn] 409 conflict\n' > "$LOGD/stuck.log"

yes_ "a log that reached 'polling Telegram' is healthy"      log_verdict "$LOGD/good.log"
not_ "a log that never polled is not healthy"                log_verdict "$LOGD/nopoll.log"
not_ "a log with [fatal] is not healthy"                     log_verdict "$LOGD/fatal.log"
not_ "a missing log file is not healthy"                     log_verdict "$LOGD/nope.log"
not_ "no log argument at all is not healthy"                 log_verdict ""
yes_ "409 FOLLOWED by a successful poll is healthy"          log_verdict "$LOGD/recovered.log"
not_ "409 with no poll after it is not healthy"              log_verdict "$LOGD/stuck.log"
case "$(log_verdict "$LOGD/stuck.log" 2>&1)" in
  *"409 conflict"*) ok "…and it says which check failed" ;;
  *) no "no reason given for the 409 failure" ;;
esac

echo
echo "== snapshot_tree / restore_tree: rollback covers EVERY tracked file =="
# The regression: rollback used to restore bridge.ts alone. lib.ts is now
# load-bearing (stream parser, renderers, rich-message routing), so a bad edit
# there survived the rollback and the bot came back still broken.
REPO="$TMP/repo"; mkdir -p "$REPO"
cd "$REPO"
git init -q . 2>/dev/null
printf 'ORIGINAL bridge\n' > bridge.ts
printf 'ORIGINAL lib\n'    > lib.ts
printf 'ORIGINAL libsh\n'  > lib.sh
mkdir -p live && printf 'ORIGINAL server\n' > live/server.ts
git add -A 2>/dev/null
BAKD="$TMP/bak"; mkdir -p "$BAKD"
yes_ "snapshot_tree succeeds in a git checkout" snapshot_tree "$BAKD"
is "…and it captured all four tracked files" "$(tar -tf "$BAKD/tree.tar" 2>/dev/null | wc -l)" "4"

printf 'BROKEN\n' > bridge.ts
printf 'BROKEN\n' > lib.ts
printf 'BROKEN\n' > live/server.ts
restore_tree "$BAKD"
is "bridge.ts restored"      "$(cat bridge.ts)"      "ORIGINAL bridge"
is "lib.ts restored TOO"     "$(cat lib.ts)"         "ORIGINAL lib"
is "live/server.ts restored" "$(cat live/server.ts)" "ORIGINAL server"

# Uncommitted edits are the reason this is a file snapshot rather than a git
# checkout: they must survive the round trip, and `git reset --hard` would eat them.
printf 'UNCOMMITTED WORK\n' >> lib.ts
BAKD2="$TMP/bak2"; mkdir -p "$BAKD2"
snapshot_tree "$BAKD2"
printf 'BROKEN\n' > lib.ts
restore_tree "$BAKD2"
case "$(cat lib.ts)" in *"UNCOMMITTED WORK"*) ok "uncommitted edits survive snapshot+restore" ;;
                        *) no "uncommitted edits were lost" ;; esac

not_ "snapshot_tree with no destination fails"  snapshot_tree ""
not_ "restore_tree with no snapshot fails"      restore_tree "$TMP/nonexistent"
cd "$ROOT"

echo
echo "-- $PASS passed, $FAIL failed --"
[ "$FAIL" -eq 0 ]
