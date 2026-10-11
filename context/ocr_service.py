#!/usr/bin/env python3
"""The text in photos, read on this machine's CPU, for the context engine.

A screenshot's words (an email, a dashboard, an error, a tweet) are often the whole
point of the message that carried it, and a search that only sees "[photo]" cannot
find it. This service reads them with RapidOCR (Apache-2.0): PaddleOCR's PP-OCR models
run on ONNX Runtime, CPU only, no GPU, nothing sent anywhere.

    POST /ocr     body: the image file's bytes      ->  {"lines": [{"text", "score"}], "ms", "model"}
    GET  /health                                    ->  {"ok": true, "model": ...}

What reads the lines is OCR_MODEL (see context/OCR.md for how they were measured):

    fa+en   (default) PP-OCRv5 finds the lines and the English model reads them; the
            lines it cannot read (Persian comes back blank) are read again by the
            Arabic-script model, and a line with both scripts keeps both readings' words
    fa      the Arabic-script model alone (a little faster, a little worse on English)
    en      the English model alone (fastest; Persian comes out as nothing useful)

Environment: OCR_HOST, OCR_PORT (127.0.0.1:8094), OCR_MODEL, OCR_THREADS (1).
One request at a time: a small server is better off reading one photo quickly than
several slowly.
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

THREADS = int(os.environ.get("OCR_THREADS", "1"))
for k in ("OMP_NUM_THREADS", "OMP_THREAD_LIMIT", "MKL_NUM_THREADS"):
    os.environ.setdefault(k, str(THREADS))

import cv2
import numpy as np
from rapidocr import LangDet, LangRec, ModelType, OCRVersion, RapidOCR
from rapidocr.ch_ppocr_rec.typings import TextRecInput

HOST = os.environ.get("OCR_HOST", "127.0.0.1")
PORT = int(os.environ.get("OCR_PORT", "8094"))
MODEL = os.environ.get("OCR_MODEL", "fa+en")
MAX_BYTES = 20 * 1024 * 1024
LOCK = threading.Lock()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


def engine(rec: str) -> RapidOCR:
    return RapidOCR(params={
        "Global.log_level": "error",
        "EngineConfig.onnxruntime.intra_op_num_threads": THREADS,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        "Det.ocr_version": OCRVersion.PPOCRV5, "Det.model_type": ModelType.MOBILE, "Det.lang_type": LangDet.CH,
        "Rec.ocr_version": OCRVersion.PPOCRV5, "Rec.model_type": ModelType.MOBILE,
        "Rec.lang_type": LangRec.ARABIC if rec == "fa" else LangRec.EN,
    })


READERS = {name: engine(name) for name in (["fa", "en"] if MODEL == "fa+en" else [MODEL])}
TEXT_SCORE = 0.5   # a line read with less confidence than this is left out


def read(img: np.ndarray) -> list[dict]:
    """The lines of text in an image, top to bottom, as {"text", "score"}."""
    first = READERS["fa" if MODEL == "fa" else "en"]
    # RapidOCR's own steps, so that a line read twice is the very same image: find
    # the lines, turn the ones that are upside down or sideways (a chart's axis
    # label), read them.
    im, op = first.preprocess_img(img)
    try:
        crops, _ = first.detect_and_crop(im, op)
    except Exception:          # no text anywhere in the image
        return []
    crops, _ = first.cls_and_rotate(crops)
    got = first.text_rec(TextRecInput(img=crops))
    lines = [((t or "").strip(), float(s)) for t, s in zip(got.txts or [], got.scores or [])]
    if MODEL == "fa+en":
        # Lines the English model could not read are read again by the Arabic-script
        # model: Persian comes back from the English model as blanks, or as a few Latin
        # words where a whole line of text is (fewer characters than a line that wide
        # holds). On an English screenshot that is a few icons; on a Persian one, the
        # Persian lines.
        doubt = [i for i, (c, (t, s)) in enumerate(zip(crops, lines)) if s < 0.6 or len(t) < c.shape[1] / max(c.shape[0], 1)]
        if doubt:
            fa = READERS["fa"].text_rec(TextRecInput(img=[crops[i] for i in doubt]))
            for i, t, s in zip(doubt, fa.txts or [], fa.scores or []):
                lines[i] = merge((t or "").strip(), float(s), *lines[i])
    return [{"text": t, "score": round(s, 3)} for t, s in lines if t and s >= TEXT_SCORE]


ARABIC_LETTER = re.compile(r"[\u0600-\u06FF]")
LATIN_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@#%$&+-]*[A-Za-z0-9]")


def merge(fa: str, fa_score: float, en: str, en_score: float) -> tuple[str, float]:
    """One line from its two readings. A line with Persian in it keeps its Persian
    reading, plus the Latin words only the English model saw. Any other line is Latin
    script, which the English model reads better: its reading, unless it is clearly
    less sure of it."""
    if len(ARABIC_LETTER.findall(fa)) >= 2:
        have = {w.lower() for w in LATIN_WORD.findall(fa)}
        extra = [w for w in LATIN_WORD.findall(en) if w.lower() not in have and re.search(r"[A-Za-z]", w)]
        return " ".join([fa, *dict.fromkeys(extra)]), fa_score
    if en and en_score >= fa_score - 0.05:
        return en, en_score
    return fa, fa_score


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"ok": True, "model": MODEL})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/ocr":
            return self.reply(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BYTES:
            return self.reply(413 if n > MAX_BYTES else 400, {"error": "send the image's bytes, at most 20 MB"})
        data = self.rfile.read(n)
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            return self.reply(415, {"error": "not an image this service can read"})
        t0 = time.time()
        with LOCK:
            try:
                lines = read(img)
            except Exception as e:  # a bad image costs its own request only
                log("error:", e)
                return self.reply(500, {"error": str(e)[:300]})
        ms = int((time.time() - t0) * 1000)
        log(f"read {len(lines)} line(s) in {ms} ms")
        self.reply(200, {"lines": lines, "ms": ms, "model": f"rapidocr/pp-ocrv5/{MODEL}"})


if __name__ == "__main__":
    log(f"ocr ({MODEL}) listening on {HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
