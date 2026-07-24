#!/usr/bin/env python3
"""Kokoro TTS — text on stdin, writes a WAV to argv[1]. Local, no API key.

Env:  TG_KOKORO_VOICE  (default af_heart)   any of Kokoro's ~54 voices
      TG_KOKORO_SPEED  (default 1.0)
      TG_KOKORO_LANG   (default en-us)
      TG_KOKORO_MODEL / TG_KOKORO_VOICES     override the model file paths
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

def main() -> int:
    out = sys.argv[1] if len(sys.argv) > 1 else None
    if not out:
        sys.stderr.write("usage: kokoro_tts.py <out.wav>\n")
        return 2
    text = sys.stdin.read().strip()
    if not text:
        sys.stderr.write("kokoro_tts.py: empty text\n")
        return 2
    try:
        import soundfile as sf
        from kokoro_onnx import Kokoro
    except Exception as e:
        sys.stderr.write(f"kokoro not installed ({e}); run voice/setup.sh --kokoro\n")
        return 3

    model = os.environ.get("TG_KOKORO_MODEL", os.path.join(HERE, "kokoro", "kokoro-v1.0.onnx"))
    voices = os.environ.get("TG_KOKORO_VOICES", os.path.join(HERE, "kokoro", "voices-v1.0.bin"))
    voice = os.environ.get("TG_KOKORO_VOICE", "af_heart").strip() or "af_heart"
    speed = float(os.environ.get("TG_KOKORO_SPEED", "1.0") or "1.0")
    lang = os.environ.get("TG_KOKORO_LANG", "en-us").strip() or "en-us"

    k = Kokoro(model, voices)
    samples, sr = k.create(text, voice=voice, speed=speed, lang=lang)
    sf.write(out, samples, sr)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
