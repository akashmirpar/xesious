#!/usr/bin/env bash
# DEPRECATED — this is now a thin shim over ./update.sh. Use that instead.
#
# What was here, and why it had to go. apply.sh redeployed the bridge by waiting
# for its own instance to go idle and then running:
#
#     for p in $(pgrep -f 'bun run bridge.ts'); do
#       [ "$(cat /proc/$p/comm 2>/dev/null)" = bun ] && kill -TERM "$p"
#     done
#
# `pgrep -f` has no user filter, and /proc/<pid>/comm is world-readable — it only
# proves the process is bun, it says nothing about who owns it. Verified on this
# box: that selector matches the bridge running as another user, and the guard
# passes for it. As a normal user the kill fails with EPERM (noise); as root it
# succeeds and takes down someone else's bot mid-reply. Worse, the wait above it
# WAS correctly scoped to this instance, so the script carefully avoided cutting
# off its own reply and then cut off everyone else's — the exact bug it existed
# to prevent, inflicted on other people.
#
# It also lacked everything update.sh has: no typecheck, no test gate, no
# snapshot, no rollback, no health check. There is no case left where running
# apply.sh is better than running update.sh, so it forwards rather than
# duplicating a second, dumber deploy path. The name is kept because hooks,
# notes and muscle memory still reach for it.
exec "$(dirname "${BASH_SOURCE[0]}")/update.sh" "$@"
