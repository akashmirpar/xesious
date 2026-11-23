// live/opus.ts — the mic as Opus: ~24 kbit/s instead of 256 kbit/s of raw 16 kHz PCM,
// so a weak upload keeps up (one measured at 150–460 kbit/s with ~1 s of jitter could
// not carry the raw audio). The page encodes it (WebCodecs); here it is decoded back to
// the PCM everything else works on: the quiet detection, the recording, Soniox.
//
// A message of Opus starts with OPUS_MAGIC, then 20 ms frames, each as
// [length: 2 bytes, big-endian][frame]. Anything else is raw PCM, as before, so a page
// that can't encode (or an older page) still works.
import { OpusDecoder } from 'opus-decoder'

export const OPUS_MAGIC = new Uint8Array([0x4f, 0x50, 0x53, 0x31])   // "OPS1"

export function isOpus(b: Uint8Array): boolean {
  return b.byteLength > OPUS_MAGIC.length && OPUS_MAGIC.every((x, i) => b[i] === x)
}

// The frames of a message, or null when it is malformed.
export function opusFrames(b: Uint8Array): Uint8Array[] | null {
  const frames: Uint8Array[] = []
  let i = OPUS_MAGIC.length
  while (i < b.byteLength) {
    if (i + 2 > b.byteLength) return null
    const n = (b[i] << 8) | b[i + 1]
    i += 2
    if (!n || i + n > b.byteLength) return null
    frames.push(b.subarray(i, i + n))
    i += n
  }
  return frames.length ? frames : null
}

// For tests and the page's framing: frames into one message.
export function packOpus(frames: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(OPUS_MAGIC.length + frames.reduce((s, f) => s + 2 + f.byteLength, 0))
  out.set(OPUS_MAGIC)
  let i = OPUS_MAGIC.length
  for (const f of frames) { out[i] = f.byteLength >> 8; out[i + 1] = f.byteLength & 255; out.set(f, i + 2); i += 2 + f.byteLength }
  return out
}

function toPcm16(f: Float32Array): Uint8Array {
  const out = new Int16Array(f.length)
  for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 32768 : s * 32767 }
  return new Uint8Array(out.buffer)
}

// One per call: decodes its messages in order, as 16 kHz mono 16-bit PCM.
export class OpusIn {
  private dec = new OpusDecoder({ sampleRate: 16000, channels: 1, preSkip: 0 })
  private ready = false
  private waiting: Uint8Array[][] = []
  errors = 0
  constructor(private onPcm: (pcm: Uint8Array) => void) {
    void this.dec.ready.then(() => { this.ready = true; for (const f of this.waiting.splice(0)) this.decode(f) })
  }
  // false when the message is not good Opus framing (it is then dropped)
  push(msg: Uint8Array): boolean {
    const frames = opusFrames(msg)
    if (!frames) { this.errors++; return false }
    // copied: the socket's buffer may be reused once this returns
    const own = frames.map(f => f.slice())
    if (!this.ready) this.waiting.push(own); else this.decode(own)
    return true
  }
  private decode(frames: Uint8Array[]) {
    const r = this.dec.decodeFrames(frames)
    if (r.errors?.length) this.errors += r.errors.length
    if (r.samplesDecoded) this.onPcm(toPcm16(r.channelData[0].subarray(0, r.samplesDecoded)))
  }
  free() { try { this.dec.free() } catch {} }
}
