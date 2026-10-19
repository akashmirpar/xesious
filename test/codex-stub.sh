#!/usr/bin/env bash
# A stand-in for `codex exec` in tests: writes its last message where -o says, naming
# the last line of what it was asked (the step's instruction), so a test can see the
# step and its context reached it.
out='' prev=''
for a in "$@"; do
  [ "$prev" = "-o" ] && out=$a
  prev=$a
done
prompt=${!#}
[ -n "$out" ] && printf 'codex did it: %s\n' "$(printf '%s\n' "$prompt" | tail -n 1)" > "$out"
printf '{"type":"turn.completed"}\n'
