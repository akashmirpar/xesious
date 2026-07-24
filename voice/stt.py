#!/usr/bin/env python3
"""Transcribe an audio file to text with faster-whisper — local, no API key.

Usage:  stt.py <audio-file>        # prints the transcript to stdout
Env:    TG_STT_MODEL  (default 'base')   whisper size: tiny|base|small|medium|large-v3
        TG_STT_LANG   (default auto)     force a language code, e.g. en, fa
The model is downloaded once and cached under ~/.cache/huggingface.
"""
import os
import sys

def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: stt.py <audio-file>\n")
        return 2
    audio = sys.argv[1]
    if not os.path.isfile(audio):
        sys.stderr.write(f"no such file: {audio}\n")
        return 2
    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # pragma: no cover
        sys.stderr.write(f"faster-whisper not installed ({e}); run voice/setup.sh\n")
        return 3

    model_name = os.environ.get("TG_STT_MODEL", "base").strip() or "base"
    lang = (os.environ.get("TG_STT_LANG") or "").strip() or None  # None = autodetect

    # int8 on CPU: fast and light; faster-whisper decodes the .ogg itself via PyAV.
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(audio, language=lang, vad_filter=True)
    text = "".join(seg.text for seg in segments).strip()
    sys.stdout.write(text)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
