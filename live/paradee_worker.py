#!/usr/bin/env python3
"""Paradee, kept loaded, for the live page's English answers.

Run with voice/paradee/.venv/bin/python. Uses voice/speak.py's loader, so the voice,
speed and thread settings are the same as Telegram voice notes (TG_PARADEE_*,
TG_KOKORO_SPEED). One JSON request per line on stdin, one JSON answer per line:

  ->  {"id": 1, "text": "Hello there.", "out": "/tmp/a.pcm"}
  <-  {"id": 1, "ok": true, "rate": 24000}        (16-bit mono PCM written to "out")
  <-  {"ready": true}                              (once, when the model is loaded)
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "voice"))


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> int:
    try:
        import numpy as np
        from speak import load_engine
        synth = load_engine("paradee")
    except Exception as e:  # noqa: BLE001 — reported to the server, which says so in the trace
        send({"fatal": f"Paradee could not load ({e}); run voice/setup.sh"})
        return 1
    send({"ready": True})
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        try:
            samples, rate = synth(req["text"])
            pcm = (np.clip(np.asarray(samples, dtype=np.float32), -1, 1) * 32767).astype("<i2").tobytes()
            with open(req["out"], "wb") as f:
                f.write(pcm)
            send({"id": req.get("id"), "ok": True, "rate": int(rate)})
        except Exception as e:  # noqa: BLE001
            send({"id": req.get("id"), "error": str(e)[:300]})
    return 0


if __name__ == "__main__":
    sys.exit(main())
