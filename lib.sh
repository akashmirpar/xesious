#!/usr/bin/env bash
# lib.sh — shared primitives for the deploy scripts (start/update/apply/restart-notify).
#
# THE RULE THIS FILE EXISTS TO ENFORCE: never signal a process on a *negative*
# match. A pid is ours only when BOTH checks positively succeed — it is owned by
# this uid, and its cwd reads back as exactly the directory we care about.
#
# Why that phrasing matters. This box really is multi-user: two xesious
# deployments run right now, one as `ops` and one as `george`. Today the only
# thing stopping a redeploy from killing the other person's bot is that
# /proc/<pid>/cwd needs ptrace access to read, so the comparison quietly fails and
# the process is skipped. That is a kernel side effect, not a decision — and it
# evaporates the moment any of this runs as root, which this deployment already
# contemplates. So an unreadable /proc entry is treated as "definitively not
# mine" by design here, which keeps the current behaviour correct rather than
# lucky.
#
# Sourced, not executed: `. "$(dirname "$0")/lib.sh"`.

# Put bun on PATH portably. Hardcoding one install dir breaks on any host that
# put it elsewhere, so prefer a bun that already resolves, else search the usual
# locations (bun's own dir, ~/.local/bin, any nvm node bin).
find_bun() {
  command -v bun >/dev/null 2>&1 && return 0
  local d
  for d in "$HOME/.bun/bin" "$HOME/.local/bin" "$HOME"/.nvm/versions/node/*/bin; do
    [ -x "$d/bun" ] && { export PATH="$d:$PATH"; return 0; }
  done
  return 1
}

# owns_pid <pid> <dir> — is this exact pid mine AND running in <dir>?
# Both halves must succeed positively. An unreadable owner or cwd returns false:
# "I could not prove this is mine" is never the same as "it is mine".
owns_pid() {
  local pid="${1:-}" dir="${2:-}" owner cwd
  [ -n "$pid" ] && [ -n "$dir" ] || return 1
  owner=$(stat -c %u "/proc/$pid" 2>/dev/null) || return 1
  [ -n "$owner" ] && [ "$owner" = "$(id -u)" ] || return 1
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || return 1
  [ -n "$cwd" ] && [ "$cwd" = "$dir" ]
}

# own_pids <procname> <dir> — pids of <procname> that are mine and in <dir>.
# `pgrep -x -u` is the positive owner filter the old code never had: the previous
# selectors used `pgrep -f` (no user filter at all) or guarded on
# /proc/<pid>/comm, which is world-readable and only proves the process is bun.
# Prints nothing — rather than everything — when either argument is empty, so a
# caller with an unset $DIR can't accidentally select the whole process table.
own_pids() {
  local name="${1:-}" dir="${2:-}" p
  [ -n "$name" ] && [ -n "$dir" ] || return 0
  for p in $(pgrep -x -u "$(id -u)" "$name" 2>/dev/null); do
    owns_pid "$p" "$dir" && printf '%s\n' "$p"
  done
  return 0
}

# busy <dir> — is one of MY bridges in <dir> mid-run?
# "Mid-run" = its bun has a `claude` child. Matching the command line instead
# (e.g. 'claude.*--output-format stream-json') also matches the IDE extension's
# own claude, and any other instance's, which deadlocks the caller against the
# very session running it.
#
# Known limitation, unchanged from the original and deliberately not widened
# here: this only sees a direct child named exactly `claude`. A CLAUDE_BIN
# pointing at a wrapper or a stub (as the staging harness does) is invisible to
# it, so a deploy could proceed mid-run in that configuration.
busy() {
  local dir="${1:-}" b
  [ -n "$dir" ] || return 1
  for b in $(own_pids bun "$dir"); do
    pgrep -x -P "$b" claude >/dev/null 2>&1 && return 0
  done
  return 1
}

# wait_for_idle <dir> <max_seconds> — block until no run is active, bounded.
# Returns 0 when idle, 1 if the cap was reached while still busy.
#
# The grace window is the reason for the outer loop: a message that lands during
# the wait must not have its reply cut off either, so we require the bridge to
# still be idle a few seconds after it first looked idle. The cap is what the
# original lacked — its 12-minute bound was the INNER loop, wrapped in
# `while true`, so a hung claude child (which never exits) stalled a deploy
# forever, detached, with nothing reported.
wait_for_idle() {
  local dir="${1:-}" cap="${2:-1800}" waited=0
  while :; do
    while busy "$dir"; do
      [ "$waited" -ge "$cap" ] && return 1
      sleep 3; waited=$((waited + 3))
    done
    sleep 8; waited=$((waited + 8))   # let the just-finished reply get delivered
    busy "$dir" || return 0
    [ "$waited" -ge "$cap" ] && return 1
  done
}

# snapshot_tree <dest_dir> — archive the working tree so a failed deploy can be
# undone byte for byte, including edits that were never committed.
#
# Every TRACKED file, not one hardcoded name. bridge.ts used to be the entire
# program; it is not any more. lib.ts now holds the stream parser, the renderers,
# the mode/model normalisation and the rich-message routing, and live/server.ts is
# its own process — so restoring bridge.ts alone puts back a file that imports a
# still-broken module and calls that a rollback.
snapshot_tree() {
  local dest="${1:-}"
  [ -n "$dest" ] && [ -d "$dest" ] || return 1
  if git rev-parse --git-dir >/dev/null 2>&1 &&
     git ls-files -z 2>/dev/null | tar --null --files-from=- -cf "$dest/tree.tar" 2>/dev/null &&
     [ -s "$dest/tree.tar" ]; then
    return 0
  fi
  # Not a git checkout, or ls-files came back empty: keep the runtime files at least.
  tar -cf "$dest/tree.tar" bridge.ts lib.ts lib.sh 2>/dev/null
}

# restore_tree <dest_dir> — put the snapshot back over the working tree.
restore_tree() {
  local dest="${1:-}"
  [ -n "$dest" ] && [ -f "$dest/tree.tar" ] || return 1
  tar -xf "$dest/tree.tar"
}

# log_verdict <logfile> — does the log say this instance came up and is serving?
# Prints the reason and returns 1 when it does not; silent and 0 when it does.
# Split out from update.sh's healthy() so it can be tested against canned logs
# rather than only against a live restart.
log_verdict() {
  local log="${1:-}" l409 lpoll
  [ -n "$log" ] && [ -f "$log" ] || { echo "no log file at ${log:-<unset>}"; return 1; }
  grep -q 'polling Telegram' "$log" || { echo "never reached 'polling Telegram'"; return 1; }
  grep -qiE '\[fatal\]' "$log" && { echo "fatal in log"; return 1; }

  # A 409 the bridge RECOVERED from is not a failure. bridge.ts catches a polling
  # 409, waits ~40s for the previous long-poll to expire, and resumes — logging
  # 'polling Telegram' again. Failing on ANY occurrence (what the old check did)
  # rolled back deploys that were perfectly healthy. Only an unrecovered 409 —
  # one with no successful poll after it — means another instance holds the token.
  l409=$(grep -n '409' "$log" 2>/dev/null | tail -1 | cut -d: -f1)
  lpoll=$(grep -n 'polling Telegram' "$log" 2>/dev/null | tail -1 | cut -d: -f1)
  if [ -n "$l409" ] && { [ -z "$lpoll" ] || [ "$l409" -gt "$lpoll" ]; }; then
    echo "409 conflict with no successful poll after it — another instance holds the token"
    return 1
  fi
  return 0
}

# stop_own <dir> [signal] — signal only the bridges that are provably mine.
# Prints one line per pid it signals, and per pid it declines to, so a redeploy
# that quietly does nothing says why instead of looking like it worked.
stop_own() {
  local dir="${1:-}" sig="${2:-TERM}" p signalled="" n=0
  for p in $(own_pids bun "$dir"); do
    if kill "-$sig" "$p" 2>/dev/null; then
      echo "[stop] signalled $sig -> pid $p ($dir)"
      signalled="$signalled $p"; n=$((n + 1))
    fi
  done
  # Report what was visible but rejected — that is where a cross-user kill would
  # have happened before, so it is worth saying out loud rather than silently.
  #
  # Skip anything we just signalled. A process we TERM'd is already exiting by
  # the time this loop runs, so owns_pid can no longer prove it was ours and it
  # would be reported as "not provably mine" — naming the very pid the line above
  # says we killed. Harmless to the kill itself, but the output contradicted
  # itself, and this reporting exists precisely so a redeploy's process decisions
  # can be read at a glance.
  for p in $(pgrep -x bun 2>/dev/null); do
    case " $signalled " in *" $p "*) continue ;; esac
    owns_pid "$p" "$dir" || echo "[stop] skipped pid $p — not provably mine in $dir"
  done
  [ "$n" -gt 0 ]
}
