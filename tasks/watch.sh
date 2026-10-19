#!/usr/bin/env bash
# watch.sh OUT ERR COMMAND — runs a task's streaming watcher for the bridge
# (tasks/watchers.ts), detached from it.
#
# Each line COMMAND prints is appended to OUT with the second it was printed in front:
# epoch seconds, a tab, the line. So the bridge can tell a fresh event from an old one
# even for lines written while it was restarting. COMMAND's stderr goes to ERR. When
# COMMAND ends, a last line says how: the second, a tab, \001exit and its status.
# The bridge reads OUT on from where it left off, whether or not it ran all along.
#
# A restart takes seconds, so the watcher outlives it. A bridge gone for good must not
# leave it running forever: the bridge touches $XESIOUS_HEARTBEAT every half minute,
# and once that is older than $XESIOUS_HEARTBEAT_MAX seconds (an hour) the whole group
# ends. Checked every $XESIOUS_HEARTBEAT_EVERY seconds (a minute).
out=$1 err=$2 cmd=$3
if [ -n "$XESIOUS_HEARTBEAT" ]; then
  (
    while sleep "${XESIOUS_HEARTBEAT_EVERY:-60}"; do
      beat=$(stat -c %Y "$XESIOUS_HEARTBEAT" 2>/dev/null) || continue
      if [ $(( $(printf '%(%s)T' -1) - beat )) -gt "${XESIOUS_HEARTBEAT_MAX:-3600}" ]; then
        printf '%(%s)T\t\001exit 143\n' -1 >>"$out"
        kill -TERM 0
      fi
    done
  ) </dev/null >/dev/null 2>&1 &
fi
set -o pipefail
bash -c "$cmd" </dev/null 2>>"$err" | while IFS= read -r line || [ -n "$line" ]; do
  printf '%(%s)T\t%s\n' -1 "$line"
done >>"$out"
code=$?
printf '%(%s)T\t\001exit %d\n' -1 "$code" >>"$out"
kill -TERM 0 2>/dev/null
exit "$code"
