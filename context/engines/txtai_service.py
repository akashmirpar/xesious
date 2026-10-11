#!/usr/bin/env python3
"""txtai (github.com/neuml/txtai, Apache-2.0) as a xesious context engine.

A small HTTP service speaking the engine protocol in context/ENGINES.md: the bridge
sends it stretches of conversation, and asks it to rank them for a question. One
txtai index per (index name, chat), each a hybrid index: dense vectors from the
embeddings server (bge-m3 through llama.cpp's llama-server) plus BM25 terms. A
search picks how they are mixed, so one index serves all three modes:

    dense   vectors only        (weights 1.0 — txtai skips the side with weight 0)
    bm25    keywords only       (weights 0.0)
    hybrid  both, fused by txtai (weights 0.5, or "weights" in the request)

Environment:
    TXTAI_HOST, TXTAI_PORT   where to listen (127.0.0.1:8092)
    TXTAI_DATA               where indexes are saved (./txtai-data)
    EMB_URL                  the OpenAI-compatible embeddings server (http://127.0.0.1:8091)
    EMB_MODEL                the model name it expects (bge-m3)

Standard library only, besides txtai and numpy.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
from txtai import Embeddings

HOST = os.environ.get("TXTAI_HOST", "127.0.0.1")
PORT = int(os.environ.get("TXTAI_PORT", "8092"))
DATA = Path(os.environ.get("TXTAI_DATA", "txtai-data")).resolve()
EMB_URL = os.environ.get("EMB_URL", "http://127.0.0.1:8091").rstrip("/")
EMB_MODEL = os.environ.get("EMB_MODEL", "bge-m3")
BATCH = 16
MODES = {"dense": 1.0, "bm25": 0.0, "hybrid": 0.5}

LOCK = threading.Lock()
INDEXES: dict[str, Embeddings] = {}
META: dict[str, dict[str, dict]] = {}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


def embed(texts: list[str]) -> np.ndarray:
    """txtai's external transform: texts -> (n, d) float32 vectors from the embeddings server."""
    out: list[list[float]] = []
    for i in range(0, len(texts), BATCH):
        batch = [t if t.strip() else " " for t in texts[i : i + BATCH]]
        req = urllib.request.Request(f"{EMB_URL}/v1/embeddings", data=json.dumps({"model": EMB_MODEL, "input": batch}).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=600) as r:
            data = sorted(json.load(r)["data"], key=lambda d: d["index"])
        if len(data) != len(batch):
            raise RuntimeError(f"embeddings server returned {len(data)} vectors for {len(batch)} texts")
        out.extend(d["embedding"] for d in data)
    return np.asarray(out, dtype=np.float32)


def slot(index: str, chat: str) -> str:
    """Folder name for one (index, chat): safe characters only, keeping the "@"
    between them, which the service splits on to reload its indexes at start."""
    return re.sub(r"[^A-Za-z0-9_.+@-]", "_", f"{index}@{chat}")


def config(dense: bool = True) -> dict:
    # Keyword-only (BM25) needs no embeddings at all: cheap to build on a small CPU.
    return {"content": True, "transform": embed, "hybrid": True} if dense else {"content": True, "keyword": True}


def get(index: str, chat: str, create: bool, dense: bool = True) -> Embeddings | None:
    name = slot(index, chat)
    if name in INDEXES:
        return INDEXES[name]
    path = DATA / name
    if (path / "config.json").exists() or (path / "config").exists():
        e = Embeddings()
        saved = json.loads((path / "config.json").read_text()) if (path / "config.json").exists() else {}
        e.load(str(path), config={"transform": embed} if not saved.get("keyword") else None)
        INDEXES[name] = e
        META[name] = json.loads((path / "meta.json").read_text()) if (path / "meta.json").exists() else {}
        return e
    if not create:
        return None
    INDEXES[name] = Embeddings(config(dense))
    META[name] = {}
    return INDEXES[name]


def save(index: str, chat: str) -> None:
    name = slot(index, chat)
    path = DATA / name
    path.mkdir(parents=True, exist_ok=True)
    INDEXES[name].save(str(path))
    (path / "meta.json").write_text(json.dumps(META[name]))


class Handler(BaseHTTPRequestHandler):
    # Keep-alive, as clients expect: with HTTP/1.0 the server closes after each reply,
    # and a client reusing that connection sees it cut mid-request.
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet: one line per call is logged below
        pass

    def reply(self, code: int, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", ""):
            # No lock: a long upsert must not make the service look down.
            counts = {n: len(m) for n, m in list(META.items())}
            return self.reply(200, {"ok": True, "engine": "txtai", "modes": list(MODES), "indexes": counts, "busy": LOCK.locked()})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            t0 = time.perf_counter()
            path = self.path.rstrip("/")
            if path == "/upsert":
                out = self.upsert(req)
            elif path == "/delete":
                out = self.delete(req)
            elif path == "/search":
                out = self.search(req)
            elif path == "/reset":
                out = self.reset(req)
            else:
                return self.reply(404, {"error": "not found"})
            if path != "/search":
                log(f"{path} {req.get('index')}@{req.get('chat')}: {json.dumps({k: v for k, v in out.items() if k != 'hits'})} in {time.perf_counter() - t0:.1f}s")
            self.reply(200, out)
        except Exception as e:  # the bridge treats any error as "this engine is down"
            log(f"error on {self.path}: {e!r}")
            self.reply(500, {"error": str(e)})

    def upsert(self, req: dict) -> dict:
        index, chat, items = str(req.get("index") or "default"), str(req["chat"]), req.get("items") or []
        if not items:
            return {"ok": True, "upserted": 0}
        with LOCK:
            e = get(index, chat, create=True, dense=req.get("dense", True) is not False)
            name = slot(index, chat)
            e.upsert((it["key"], {"text": it.get("text") or " "}, None) for it in items)
            for it in items:
                META[name][it["key"]] = {"topic": str(it.get("topic", "")), "t0": it.get("t0"), "t1": it.get("t1")}
            save(index, chat)
        return {"ok": True, "upserted": len(items)}

    def delete(self, req: dict) -> dict:
        index, chat, keys = str(req.get("index") or "default"), str(req["chat"]), req.get("keys") or []
        with LOCK:
            e = get(index, chat, create=False)
            if not e or not keys:
                return {"ok": True, "deleted": 0}
            gone = e.delete(keys)
            name = slot(index, chat)
            for k in keys:
                META[name].pop(k, None)
            save(index, chat)
        return {"ok": True, "deleted": len(gone or [])}

    def search(self, req: dict) -> dict:
        index, chat, query = str(req.get("index") or "default"), str(req["chat"]), str(req.get("query") or "")
        k = max(1, min(50, int(req.get("k") or 5)))
        mode = str(req.get("mode") or "hybrid")
        weights = float(req["weights"]) if req.get("weights") is not None else MODES.get(mode, 0.5)
        topic, since, until = req.get("topic"), req.get("since"), req.get("until")
        filtered = topic is not None or since is not None or until is not None
        with LOCK:
            e = get(index, chat, create=False)
            if not e or not query.strip():
                return {"hits": []}
            meta = META[slot(index, chat)]
            rows = e.search(query, limit=max(k * 20, 200) if filtered else k, weights=weights)
        hits = []
        for r in rows:
            key, score = (r["id"], r["score"]) if isinstance(r, dict) else (r[0], r[1])
            m = meta.get(key, {})
            if topic is not None and m.get("topic") != str(topic):
                continue
            if since is not None and (m.get("t1") or 0) < since:
                continue
            if until is not None and (m.get("t0") or 0) > until:
                continue
            hits.append({"key": key, "score": float(score)})
            if len(hits) >= k:
                break
        return {"hits": hits}

    def reset(self, req: dict) -> dict:
        index, chat = str(req.get("index") or "default"), req.get("chat")
        with LOCK:
            names = [slot(index, str(chat))] if chat is not None else [p.name for p in DATA.glob(f"{slot(index, '')}*")]
            for name in names:
                INDEXES.pop(name, None)
                META.pop(name, None)
                shutil.rmtree(DATA / name, ignore_errors=True)
        return {"ok": True, "reset": len(names)}


if __name__ == "__main__":
    DATA.mkdir(parents=True, exist_ok=True)
    for p in sorted(DATA.iterdir()):
        if p.is_dir() and (p / "meta.json").exists():
            index, _, chat = p.name.rpartition("@")
            try:
                get(index, chat, create=False)
                log(f"loaded {p.name}: {len(META.get(p.name, {}))} stretches")
            except Exception as err:
                log(f"could not load {p.name}: {err!r}")
    log(f"txtai engine on http://{HOST}:{PORT}, embeddings from {EMB_URL} ({EMB_MODEL}), data in {DATA}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
