#!/usr/bin/env python3
"""Speak an answer as a SEQUENCE of voice notes, emitted as each one is ready.

Reads one JSON object on stdin and writes one JSON object per line to stdout:

    in : {"units":[{"text":"Results.","gap":0.55}, ...],
          "outdir":"/tmp/x", "chunks":[45,90,180]}
    out: {"chunk":1,"path":"/tmp/x/part-1.ogg","seconds":47.2,"at":0.0}
         {"chunk":2,"path":"/tmp/x/part-2.ogg","seconds":91.0,"at":47.2}
         {"full":"/tmp/x/full.ogg","seconds":138.2,"chunks":2,
          "timings":[[0.0,4.1],[4.6,12.3], ...]}

`timings` is one [start, end] per unit, in the finished audio. It is exact rather
than estimated — every unit was synthesised here, so its length is known — and it is
what the caller turns into a section index for the caption and into the highlighting
of the read-along page. Computing it costs nothing; it used to be thrown away.

Pass {"out":"/path/one.ogg"} instead of "outdir" for the single-file case — one
utterance, one file, no chunking. That mode exists so this is the ONLY place in the
tree that loads Kokoro: voice/tts.sh delegates to it rather than carrying a second
implementation that reads the same nine environment variables.

Why this exists rather than another call to tts.sh:

  * The topic used to be BLOCKED for the whole synthesis — measured at 65s for a
    note at the old 1400-character cap. Emitting chunks as they finish is what lets
    the first audio arrive in ~30 seconds instead of after everything.
  * The model is loaded ONCE for the whole answer. tts.sh spawns a fresh process
    per note, so the 311MB ONNX model was reconstructed every time: 2 of those 65
    seconds were model load, per note.
  * Pauses have to be real silence. Kokoro honours punctuation only weakly and has
    no SSML, so a heading is followed by appending zeros to the sample array — which
    is only possible when synthesis and joining happen in the same process.
  * The full file at the end costs nothing here: the samples are already in hand,
    so it is a concatenate and one encode, not a second synthesis.

Env: TG_KOKORO_MODEL / TG_KOKORO_VOICES / TG_KOKORO_VOICE / TG_KOKORO_SPEED /
     TG_KOKORO_LANG, and TG_FFMPEG to override the encoder.
"""
import json
import os
import queue
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))


def emit(obj):
    """One JSON object per line, flushed. The bridge reads this as it arrives — if
    it were buffered the progressive delivery would collapse back into one lump."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def find_ffmpeg():
    """Same order as tts.sh: an explicit override, the private copy setup.sh may
    have installed without root, then the system one."""
    cand = os.environ.get("TG_FFMPEG", "")
    if cand and os.access(cand, os.X_OK):
        return cand
    local = os.path.join(HERE, "bin", "ffmpeg")
    if os.access(local, os.X_OK):
        return local
    from shutil import which
    return which("ffmpeg")


def main() -> int:
    # One request, read whole.
    #
    # Line-delimited, the way stdout already is. The first line is the request; with
    # {"streaming": true} the caller then appends {"units":[...]} lines and closes with
    # {"end": true}.
    #
    # It exists so the first note does not wait for the WHOLE answer to be normalised.
    # Measured on a long answer: 19s to the first note with the split, 152s without it.
    #
    # It also, in its first version, cost a user 70% of an answer — the caller closed
    # the pipe without ever sending the tail, and EOF read as "finished". Hence
    # `saw_end` below: a caller that vanishes is now a hard error, not a short answer.
    #
    # readline, not read(): a caller that sends one line and closes is unaffected.
    try:
        _first = sys.stdin.readline()
        _d = os.environ.get("XESIOUS_SPEAK_DUMP_STDIN")
        if _d:
            with open(_d, "a", encoding="utf-8") as fh:
                fh.write(f"--- REQUEST {len(_first)}B ---\n{_first}")
        req = json.loads(_first)
    except Exception as e:
        sys.stderr.write(f"speak.py: bad request ({e})\n")
        return 2
    units = req.get("units") or []
    # How many the CALLER believes it sent. Echoed back on the `done` line so the two
    # sides can disagree OUT LOUD. A run that speaks 6 of 20 units still exits 0, and
    # without a number to compare there is nothing anywhere — not in the audio, not in
    # the log, not in the exit code — that tells it apart from a complete one.
    expect = req.get("expect")
    single = req.get("out")                      # one utterance, one file
    outdir = req.get("outdir") or (os.path.dirname(single) if single else ".")
    targets = req.get("chunks") or [45, 90, 180]
    if not units:
        sys.stderr.write("speak.py: nothing to speak\n")
        return 2

    ff = find_ffmpeg()
    if not ff:
        sys.stderr.write("speak.py: no ffmpeg — cannot encode Opus. Run voice/setup.sh.\n")
        return 4
    try:
        import numpy as np
        import soundfile as sf
        from kokoro_onnx import Kokoro
    except Exception as e:
        sys.stderr.write(f"speak.py: kokoro not installed ({e}); run voice/setup.sh\n")
        return 3

    model = os.environ.get("TG_KOKORO_MODEL", os.path.join(HERE, "kokoro", "kokoro-v1.0.onnx"))
    voices = os.environ.get("TG_KOKORO_VOICES", os.path.join(HERE, "kokoro", "voices-v1.0.bin"))
    voice = os.environ.get("TG_KOKORO_VOICE", "af_heart").strip() or "af_heart"
    speed = float(os.environ.get("TG_KOKORO_SPEED", "1.0") or "1.0")
    lang = os.environ.get("TG_KOKORO_LANG", "en-us").strip() or "en-us"

    k = Kokoro(model, voices)          # once, for the whole answer

    def encode(samples, sr, path):
        wav = path + ".wav"
        sf.write(wav, samples, sr)
        # stdin=DEVNULL and -nostdin, and neither is optional.
        #
        # ffmpeg READS ITS STDIN looking for interactive keypresses, and a child with no
        # stdin of its own inherits ours. Once this file started leaving stdin open to
        # receive the rest of the answer, every chunk encode quietly ate the front of
        # whatever was waiting there: measured, exactly the 10 bytes `{"units":[` off
        # the head of the tail, which left the remainder unparseable and cost the user
        # 14 of 26 units. Invisible before, because stdin was closed the moment the one
        # request had been read and there was nothing left in it to steal.
        subprocess.run([ff, "-nostdin", "-y", "-i", wav, "-ac", "1", "-c:a", "libopus",
                        "-b:a", "32k", path],
                       stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        os.remove(wav)

    sr = None
    sent = 0.0         # seconds already emitted, so a chunk can say where it starts
    pending = []       # samples for the chunk being built
    everything = []    # every sample, for the full file at the end
    timings = []       # [start, end] per unit, in the full file
    spoke = [0]        # units actually synthesised, reported back to the caller
    saw_end = [False]  # did the caller say it was finished, or did it just vanish?
    elapsed = 0.0      # running position, so a unit's start is known as it is made
    n = 0

    def target_for(i):
        return float(targets[i]) if i < len(targets) else float(targets[-1])

    def flush():
        nonlocal pending, n, sent
        if not pending:
            return
        n += 1
        audio = np.concatenate(pending)
        path = single if single else os.path.join(outdir, f"part-{n}.ogg")
        try:
            encode(audio, sr, path)
        except Exception as e:                                  # noqa: BLE001
            sys.stderr.write(f"speak.py: encode chunk {n} failed ({e})\n")
            pending = []
            return
        dur = len(audio) / sr
        # `at` is where this chunk begins in the whole answer. A note captioned
        # "part 3" says nothing about where you are in ten minutes of audio.
        emit({"chunk": n, "path": path, "seconds": round(dur, 1), "at": round(sent, 1)})
        sent += dur
        pending = []

    def unit_stream():
        """The units from the request, then whatever the caller appends."""
        for b in units:
            yield b
        if not req.get("streaming"):
            return
        q = queue.Queue()

        dump = os.environ.get("XESIOUS_SPEAK_DUMP_STDIN")

        def reader():
            try:
                for line in sys.stdin:
                    if dump:
                        with open(dump, "a", encoding="utf-8") as fh:
                            fh.write(f"--- LINE {len(line)}B ---\n{line}")
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        msg = json.loads(line)
                    except Exception as e:                      # noqa: BLE001
                        # NOT silently skipped. A line we cannot read is a line of the
                        # answer we are about to not speak, and the count check at the
                        # end is what turns that into a visible failure.
                        sys.stderr.write(f"speak.py: unreadable input line ({e})\n")
                        continue
                    if msg.get("end"):
                        saw_end[0] = True
                        break
                    for u in msg.get("units") or []:
                        q.put(u)
            finally:
                q.put(None)     # in a finally: a reader that dies must not hang the synthesiser

        threading.Thread(target=reader, daemon=True).start()
        while True:
            u = q.get()
            if u is None:
                return
            yield u

    for b in unit_stream():
        # `speak` is the spoken rendering, `text` is what the reader is shown. They
        # differ deliberately: the page and the section index quote the answer as
        # written, and only the synthesiser is given "one hundred dollars per year".
        # Absent (any older caller, or normalisation turned off) means speak the text.
        text = (b.get("speak") or b.get("text") or "").strip()
        if not text:
            continue
        spoke[0] += 1
        try:
            samples, sr = k.create(text, voice=voice, speed=speed, lang=lang)
        except Exception as e:                                  # noqa: BLE001
            # One unspeakable unit must not lose the whole answer.
            sys.stderr.write(f"speak.py: unit failed ({e})\n")
            continue
        gap = float(b.get("gap", 0.35))
        silence = np.zeros(int(sr * gap), dtype=samples.dtype)
        spoken = len(samples) / sr
        # The unit ENDS where the speech stops, not where its trailing pause does:
        # highlighting a block through its own silence reads as a stall.
        timings.append([round(elapsed, 3), round(elapsed + spoken, 3)])
        elapsed += spoken + gap
        pending.append(samples)
        pending.append(silence)
        everything.append(samples)
        everything.append(silence)
        # Single-file mode never flushes early: the caller asked for one file.
        if not single and sum(len(x) for x in pending) / sr >= target_for(n):
            flush()
    flush()

    if not everything:
        sys.stderr.write("speak.py: nothing was synthesised\n")
        return 5
    # The whole thing, for someone who wants one file rather than a list. Already
    # synthesised, so this is a concatenate and a single encode.
    if n > 1 and not single:
        full = os.path.join(outdir, "full.ogg")
        audio = np.concatenate(everything)
        try:
            encode(audio, sr, full)
            # timings ride along with `full` as well as with `done`: the caller builds
            # the section index the moment the full file arrives, and `done` comes
            # after it. Without them here the caption was captioned with no index at
            # all — silently, because an answer with no headings correctly has none.
            emit({"full": full, "seconds": round(len(audio) / sr, 1), "chunks": n, "timings": timings})
        except Exception as e:                                  # noqa: BLE001
            sys.stderr.write(f"speak.py: encode full failed ({e})\n")
    # ALWAYS last, and separate from "full": a short answer produces one note and no
    # full file, but the read-along page and the section index want the timings just
    # the same. Tying them to the full file meant a one-note answer silently got
    # neither.
    emit({"done": True, "seconds": round(elapsed, 3), "chunks": n, "timings": timings,
          "spoke": spoke[0], "expect": expect})
    # A short read is a FAILURE, and says so in the exit code.
    #
    # Every unit that fails to synthesise is skipped with a line on stderr and the
    # answer continues, which is right — one unspeakable sentence must not cost the
    # rest. But the sum of those skips is an answer the listener never heard, and
    # until now it exited 0 and looked exactly like success. The caller cannot
    # discover this on its own: it has the audio, and audio has no idea what it is
    # missing.
    if expect is not None and spoke[0] != expect:
        sys.stderr.write(f"speak.py: spoke {spoke[0]} of {expect} units\n")
        return 5
    # EOF is not an ending. A caller that dies mid-answer closes the pipe in exactly
    # the same way as one that finished, so only an explicit {"end": true} counts.
    if req.get("streaming") and not saw_end[0]:
        sys.stderr.write("speak.py: input ended without {\"end\": true} — caller vanished\n")
        return 6
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
