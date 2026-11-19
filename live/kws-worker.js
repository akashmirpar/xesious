// The phone's wake-word spotter (sherpa-onnx KWS, WebAssembly), in a worker so the
// page stays smooth. The page feeds it the mic's 16 kHz audio only while the mic is off
// (audio it would otherwise throw away); nothing of it leaves the phone. On the wake
// phrase it says so, and the page turns the mic on.
//   in:  {type:'init', keywords, threshold}  {type:'keywords', keywords}  {type:'audio', pcm: ArrayBuffer (Int16)}  {type:'reset'}
//   out: {type:'ready'}  {type:'hit', keyword}  {type:'error', error}
/* global importScripts, createKws */
let kws = null, stream = null, threshold = 0.25, mod = null, pending = null

function make(keywords) {
  try { stream?.free() } catch {}
  try { kws?.free() } catch {}
  stream = null; kws = null
  if (!keywords) return
  kws = createKws(mod, {
    featConfig: { samplingRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: './encoder-epoch-12-avg-2-chunk-16-left-64.onnx',
        decoder: './decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
        joiner: './joiner-epoch-12-avg-2-chunk-16-left-64.onnx',
      },
      tokens: './tokens.txt', provider: 'cpu', modelType: '', numThreads: 1, debug: 0, modelingUnit: 'bpe', bpeVocab: '',
    },
    maxActivePaths: 4, numTrailingBlanks: 1, keywordsScore: 1.0, keywordsThreshold: threshold,
    keywords,
  })
  stream = kws.createStream()
}

self.onmessage = e => {
  const m = e.data || {}
  if (m.type === 'init') {
    if (mod) return
    threshold = Number(m.threshold) || 0.25
    pending = m.keywords || ''
    // The Emscripten glue finds its .wasm and .data next to this script (/kws/). It
    // declares the global Module itself, so this script must not ("already declared").
    self.Module = mod = {
      print() {}, printErr() {},
      onRuntimeInitialized() {
        try { make(pending); self.postMessage({ type: 'ready' }) } catch (err) { self.postMessage({ type: 'error', error: String(err) }) }
      },
    }
    try { importScripts('sherpa-onnx-kws.js', 'sherpa-onnx-wasm-kws-main.js') } catch (err) { self.postMessage({ type: 'error', error: String(err) }) }
    return
  }
  if (m.type === 'keywords') { pending = m.keywords || ''; if (mod?.calledRun) make(pending); return }
  if (m.type === 'reset') { if (kws) { try { stream?.free() } catch {}; stream = kws.createStream() } return }
  if (m.type === 'audio' && kws && stream) {
    const i16 = new Int16Array(m.pcm), f = new Float32Array(i16.length)
    for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768
    stream.acceptWaveform(16000, f)
    while (kws.isReady(stream)) {
      kws.decode(stream)
      const r = kws.getResult(stream)
      if (r && r.keyword) { kws.reset(stream); self.postMessage({ type: 'hit', keyword: r.keyword }) }
    }
  }
}
