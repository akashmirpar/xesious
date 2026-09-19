#!/usr/bin/env python3
"""A stand-in for voice/speak.py in tier 2.

Real synthesis runs at roughly realtime, so a test that used it would take minutes.
This speaks the same protocol — a chunk line per note, then `full`, then `done` with
the per-unit timings — using near-silent Opus made by ffmpeg, so the bridge's whole
progressive path runs: the notes, the stop button, the section index on the full
file, the tidy button and the read-along page.

XESIOUS_SPEAK_STUB_SLOW: a file whose existence makes each chunk take ~3s, so a test
can cancel one mid-flight. Not named TG_* because childEnv() strips that prefix
before spawning, and the marker would never arrive.

XESIOUS_SPEAK_STUB_DUMP: a path to write the units received on stdin to. That is the
only way to see WHAT the bridge asked to have spoken, as opposed to what came back —
which is what a truncation test needs, since a sliced answer still synthesises
perfectly well and sounds fine right up to where it stops.
"""
import json
import os
import subprocess
import sys
import time


def emit(o):
    sys.stdout.write(json.dumps(o) + "\n")
    sys.stdout.flush()


def main() -> int:
    # Line-delimited, mirroring speak.py: the first line is the request, and with
    # {"streaming": true} the caller appends more {"units":[...]} lines and closes with
    # {"end": true}. The stub must speak the same protocol or it cannot see the thing
    # under test — and the thing under test is whether the tail arrives at all.
    req = json.loads(sys.stdin.readline())
    units = list(req.get("units") or [])
    saw_end = False
    if req.get("streaming"):
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if msg.get("end"):
                saw_end = True
                break
            units.extend(msg.get("units") or [])
        # Recorded in the dump so a test can assert the caller finished properly rather
        # than merely closing the pipe — the difference between those two is the bug.
        req["saw_end"] = saw_end
    single = req.get("out")
    outdir = req.get("outdir") or (os.path.dirname(single) if single else ".")
    if not units:
        return 2
    ff = os.environ.get("TG_FFMPEG") or "ffmpeg"
    slow = os.environ.get("XESIOUS_SPEAK_STUB_SLOW")
    dump = os.environ.get("XESIOUS_SPEAK_STUB_DUMP")
    if dump:
        with open(dump, "w", encoding="utf-8") as fh:
            json.dump(units, fh)
        # The request beside the units, so a test can assert on HOW the answer was
        # handed over and not only on what arrived. Whether the streamed path was used
        # at all is the difference the kill switch is supposed to make.
        with open(dump.replace(".json", "-req.json"), "w", encoding="utf-8") as fh:
            json.dump({k: v for k, v in req.items() if k != "units"}, fh)

    def make(path, seconds=0.4):
        subprocess.run([ff, "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
                        "-t", str(seconds), "-c:a", "libopus", "-b:a", "32k", path],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)

    # One second of "audio" per unit, so the timings are predictable to assert on.
    timings, t = [], 0.0
    for _ in units:
        timings.append([round(t, 3), round(t + 1.0, 3)])
        t += 1.0 + 0.4

    if single:
        make(single)
        emit({"done": True, "seconds": round(t, 3), "chunks": 1, "timings": timings})
        return 0

    # Two chunks for a substantial answer, one for a short one — the real splitter
    # closes a chunk on accumulated SECONDS, and both outcomes have their own paths:
    # multiple notes get a full file, an index on it and a tidy button, while a single
    # note gets the index on itself and no duplicate audio file.
    n = 2 if len(units) >= 4 else 1
    at = 0.0
    for i in range(1, n + 1):
        if slow and os.path.isfile(slow):
            time.sleep(3)
        p = os.path.join(outdir, f"part-{i}.ogg")
        make(p)
        emit({"chunk": i, "path": p, "seconds": round(t / n, 1), "at": round(at, 1)})
        at += t / n
    if n > 1:
        full = os.path.join(outdir, "full.ogg")
        make(full, 0.8)
        emit({"full": full, "seconds": round(t, 1), "chunks": n, "timings": timings})
    emit({"done": True, "seconds": round(t, 3), "chunks": n, "timings": timings})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
