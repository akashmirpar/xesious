#!/usr/bin/env bash
# The phone's wake-word spotter for /live ("Hey Lucy" while the mic is off): Vosk in the
# browser (vosk-browser, Apache-2.0) with its small English model, into state/kws/ (or
# $LIVE_KWS_DIR), where the live server serves them at /kws/. Optional: without them the
# page has no "Mic on by voice" switch, and everything else works as before.
#
#   live/kws-setup.sh        # downloads ~46 MB, checks them, about 1 minute
#
# Chosen over sherpa-onnx's keyword spotter after testing both on recorded calls
# (2026-11-19): Vosk told to listen only for "hey lucy", with a 90% word confidence
# cutoff, caught 44-46 of 50 fast "Hey Lucy"s against 25, with no false wakes in 3.3 h.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${LIVE_KWS_DIR:-$ROOT/state/kws}
VB_URL=https://registry.npmjs.org/vosk-browser/-/vosk-browser-0.0.8.tgz
VB_SHA=fd16fc7e64c935d7a79cf07c8f67d84232b6485376a59144af8a234979a9a4b4
MODEL=vosk-model-small-en-us-0.15
MODEL_URL=https://alphacephei.com/vosk/models/$MODEL.zip
MODEL_SHA=30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
get() { curl -fsSL "$1" -o "$2"; echo "$3  $2" | sha256sum -c --quiet - || { echo "[kws] $1: checksum mismatch" >&2; exit 1; }; }
get "$VB_URL" "$WORK/vb.tgz" "$VB_SHA"
get "$MODEL_URL" "$WORK/model.zip" "$MODEL_SHA"
mkdir -p "$OUT"
tar -xzf "$WORK/vb.tgz" -C "$WORK" package/dist/vosk.js
# vosk-browser starts its worker from a blob made of code embedded in vosk.js, and that
# worker evaluates strings as code: a blob worker inherits the page's security policy,
# which forbids that (and should). So the worker is taken out into a file of its own
# (vosk-worker.js, served with no such policy: eval confined to the worker, which can't
# touch the page), and vosk.js starts it from globalThis.VOSK_WORKER_URL when set.
python3 - "$WORK/package/dist/vosk.js" "$OUT" <<'PY'
import sys, re, base64, os
src, out = sys.argv[1], sys.argv[2]
s = open(src, encoding='utf-8').read()
m = re.search(r"var WorkerFactory = createBase64WorkerFactory\('([A-Za-z0-9+/=]+)', null, false\);", s)
assert m, 'vosk.js: the embedded worker was not found (another vosk-browser version?)'
code = base64.b64decode(m.group(1)).decode('latin-1')   # atob: one char per byte, as the blob had it
body = code[code.index('\n', 10) + 1:]
# Keeping the unpacked model in IndexedDB is a cache; when the browser refuses it (little
# storage, a private window) the model must still load, from memory. The download itself
# stays in the HTTP cache.
keep = 'return this.Vosk.syncFilesystem(false);'
assert body.count(keep) == 1, 'vosk worker: the cache step changed'
body = body.replace(keep, 'return this.Vosk.syncFilesystem(false).catch(e => this.logger.warn(`model not kept in the browser: ${e}`));')
# The first download is ~40 MB (half a minute on a slow line): the worker already counts
# the bytes, so it also tells the page (model.on('progress')), once per whole percent.
count = 'if(length){log(`${Math.round(100*bytesWritten/length)}%'
assert body.count(count) == 1, 'vosk worker: the download counter changed'
# Without a size (a proxy may drop it) it reports every 0.5 MB; the page knows the size.
body = body.replace(count, 'const step=length?Math.floor(100*bytesWritten/length):Math.floor(bytesWritten/524288);if(step!==self.kwsStep){self.kwsStep=step;self.postMessage({event:"progress",loaded:bytesWritten,total:length||0})}' + count)
open(os.path.join(out, 'vosk-worker.js'), 'w', encoding='utf-8').write(body)
old = 'url = url || createURL(base64, sourcemapArg, enableUnicodeArg);'
assert s.count(old) == 1, 'vosk.js: the worker factory changed'
s = s.replace(old, 'url = url || globalThis.VOSK_WORKER_URL || createURL(base64, sourcemapArg, enableUnicodeArg);')
open(os.path.join(out, 'vosk.js'), 'w', encoding='utf-8').write(s)
PY
# vosk-browser loads a model as a .tar.gz; the release is a .zip.
python3 - "$WORK/model.zip" "$OUT/$MODEL.tar.gz" <<'EOF'
import sys, tarfile, zipfile, io
z = zipfile.ZipFile(sys.argv[1])
# Every folder gets its own entry, before its files: the extractor in the browser only
# creates the folders it is given, and files in a missing one are silently lost.
dirs = set()
for i in z.infolist():
    parts = i.filename.rstrip('/').split('/')
    for n in range(1, len(parts) + (1 if i.is_dir() else 0)): dirs.add('/'.join(parts[:n]))
with tarfile.open(sys.argv[2], 'w:gz') as t:
    for d in sorted(dirs, key=lambda d: (d.count('/'), d)):
        ti = tarfile.TarInfo(d); ti.type = tarfile.DIRTYPE; ti.mode = 0o755; t.addfile(ti)
    for i in z.infolist():
        if i.is_dir(): continue
        data = z.read(i); ti = tarfile.TarInfo(i.filename); ti.size = len(data); ti.mode = 0o644; t.addfile(ti, io.BytesIO(data))
EOF
ls -lh "$OUT"
echo "[kws] done: the live server picks the files up on the next call"
