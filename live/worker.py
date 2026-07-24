#!/usr/bin/env python3
"""Long-lived STT+TTS worker for the live voice server.

Loads faster-whisper and Kokoro ONCE, then serves JSON-line requests on stdin and
replies JSON-line on stdout — so each turn skips the ~7s of model reloading that
spawning a fresh process per call would cost. One request at a time (fine for a
single caller). Reused across turns; the server respawns it if it dies.

  ->  {"id":1,"cmd":"stt","file":"/tmp/utt.webm"}
  <-  {"id":1,"text":"what files are here"}
  ->  {"id":2,"cmd":"tts","text":"Paris.","out":"/tmp/a.wav"}
  <-  {"id":2,"ok":true}
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def main() -> int:
    try:
        from faster_whisper import WhisperModel
        import soundfile as sf
        from kokoro_onnx import Kokoro
    except Exception as e:
        send({"fatal": f"missing deps ({e}); run voice/setup.sh --kokoro"})
        return 3

    stt = WhisperModel(os.environ.get("TG_STT_MODEL", "base"), device="cpu", compute_type="int8")
    stt_lang = (os.environ.get("TG_STT_LANG") or "").strip() or None
    kok = Kokoro(
        os.environ.get("TG_KOKORO_MODEL", os.path.join(HERE, "..", "voice", "kokoro", "kokoro-v1.0.onnx")),
        os.environ.get("TG_KOKORO_VOICES", os.path.join(HERE, "..", "voice", "kokoro", "voices-v1.0.bin")),
    )
    default_voice = os.environ.get("TG_KOKORO_VOICE", "af_heart")
    send({"ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        try:
            if req.get("cmd") == "stt":
                segs, _ = stt.transcribe(req["file"], language=stt_lang, vad_filter=True)
                send({"id": rid, "text": "".join(s.text for s in segs).strip()})
            elif req.get("cmd") == "tts":
                s, sr = kok.create(req["text"], voice=req.get("voice", default_voice),
                                   speed=float(req.get("speed", 1.0)), lang=req.get("lang", "en-us"))
                sf.write(req["out"], s, sr)
                send({"id": rid, "ok": True})
            else:
                send({"id": rid, "error": "unknown cmd"})
        except Exception as e:
            send({"id": rid, "error": str(e)})
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
