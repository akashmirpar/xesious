#!/usr/bin/env bash
# Build the phone's wake-word spotter for /live: sherpa-onnx's keyword spotter (KWS)
# as WebAssembly, with its small English model, into state/kws/ (or $LIVE_KWS_DIR),
# where the live server serves it at /kws/. Optional: without it the page simply has
# no "Hey Lucy" while the mic is off.
#
#   live/kws-build.sh            # one core, lowest priority; ~1 h on a small VPS
#
# Needs git, curl, python3 (for cmake/ninja from pip if they're missing; libatomic is
# fetched with apt-get download if Emscripten's wasm-opt can't find it) and ~3 GB of
# disk while it builds (emsdk + build tree, removed afterwards unless KEEP=1). sherpa-onnx
# publishes no prebuilt WASM for KWS (checked v2.0.1), hence the build.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${LIVE_KWS_DIR:-$ROOT/state/kws}
WORK=${KWS_WORK:-$(mktemp -d)}
SHERPA_TAG=${SHERPA_TAG:-v2.0.1}
EMSDK_VERSION=4.0.23      # the version sherpa-onnx's build script names as known to work
MODEL=sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01
cd "$WORK"
echo "[kws] building in $WORK → $OUT"

# cmake and ninja: the system's, else from pip in a venv of their own.
if ! command -v cmake >/dev/null || ! command -v ninja >/dev/null; then
  python3 -m venv tools && tools/bin/python -m pip -q install cmake ninja
  export PATH="$WORK/tools/bin:$PATH"
fi
export CMAKE_POLICY_VERSION_MINIMUM=3.5   # cmake 4 refuses the older projects it pulls in otherwise

[ -d emsdk ] || git clone -q --depth 1 https://github.com/emscripten-core/emsdk.git
(cd emsdk && ./emsdk install "$EMSDK_VERSION" >/dev/null && ./emsdk activate "$EMSDK_VERSION" >/dev/null)
# shellcheck disable=SC1091
source emsdk/emsdk_env.sh >/dev/null 2>&1
# Emscripten's optimiser needs libatomic, which a slim server may lack: unpacked here, no install.
if ! emsdk/upstream/bin/wasm-opt --version >/dev/null 2>&1; then
  (apt-get download libatomic1 >/dev/null && dpkg-deb -x libatomic1_*.deb libatomic)
  export LD_LIBRARY_PATH="$WORK/libatomic/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

[ -d sherpa-onnx ] || git clone -q --depth 1 --branch "$SHERPA_TAG" https://github.com/k2-fsa/sherpa-onnx.git
curl -sL "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/$MODEL.tar.bz2" -o model.tar.bz2
python3 -c "import tarfile; tarfile.open('model.tar.bz2').extractall('.')"   # no bzip2 needed
A=sherpa-onnx/wasm/kws/assets
# The int8 model (5 MB instead of 13), under the names the build expects.
for f in encoder decoder joiner; do cp "$MODEL/$f-epoch-12-avg-2-chunk-16-left-64.int8.onnx" "$A/$f-epoch-12-avg-2-chunk-16-left-64.onnx"; done
cp "$MODEL/tokens.txt" "$A/"

cd sherpa-onnx
# A phone can't spare the 512 MB it asks for up front; it grows as it needs.
sed -i 's/INITIAL_MEMORY=512MB/INITIAL_MEMORY=64MB/' wasm/kws/CMakeLists.txt
# One core, Ninja (make may be missing).
sed -i -e 's/^cmake \\/cmake -G Ninja \\/' -e 's/^make -j8/ninja -j1/' -e 's/^make install/ninja install/' build-wasm-simd-kws.sh
nice -n 19 ./build-wasm-simd-kws.sh > "$WORK/build.log" 2>&1 || { tail -30 "$WORK/build.log"; exit 1; }

mkdir -p "$OUT"
cp build-wasm-simd-kws/install/bin/wasm/sherpa-onnx-wasm-kws-main.{js,wasm,data} build-wasm-simd-kws/install/bin/wasm/sherpa-onnx-kws.js "$OUT/"
ls -lh "$OUT"
[ "${KEEP:-0}" = 1 ] || { cd /; rm -rf "$WORK"; }
echo "[kws] done: restart the live server, or it picks the files up on the next call"
