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

// The most audio one message may hold. The page sends 20 ms frames every 100 ms, or a
// couple of seconds at once after a wake; a whole 64 kB message of its frames is ~20 s.
// It is counted before anything is decoded, from each packet's first bytes: unbounded,
// 64 kB of one- and two-byte packets (each a valid 60–120 ms) decoded to 22–33 minutes
// of PCM in one go (42–63 MB, the server stopped for a second or two), all of it then
// written to the recording and sent on to Soniox.
export const OPUS_MAX_MESSAGE_MS = 30_000

export function isOpus(b: Uint8Array): boolean {
  return b.byteLength > OPUS_MAGIC.length && OPUS_MAGIC.every((x, i) => b[i] === x)
}

// How long one Opus packet plays, in ms, read from its first bytes (RFC 6716, 3.1): the
// frame length its configuration gives, times its frame count. 0 for what is no packet.
export function opusPacketMs(p: Uint8Array): number {
  if (!p.byteLength) return 0
  const config = p[0] >> 3, code = p[0] & 3
  const frameMs = config < 12 ? [10, 20, 40, 60][config & 3] : config < 16 ? [10, 20][config & 1] : [2.5, 5, 10, 20][config & 3]
  const count = code === 0 ? 1 : code < 3 ? 2 : p.byteLength > 1 ? p[1] & 0x3f : 0
  const ms = frameMs * count
  return count > 0 && ms <= 120 ? ms : 0
}

// The frames of a message, or null when it is malformed or holds more audio than
// OPUS_MAX_MESSAGE_MS.
export function opusFrames(b: Uint8Array): Uint8Array[] | null {
  const frames: Uint8Array[] = []
  let i = OPUS_MAGIC.length, ms = 0
  while (i < b.byteLength) {
    if (i + 2 > b.byteLength) return null
    const n = (b[i] << 8) | b[i + 1]
    i += 2
    if (!n || i + n > b.byteLength) return null
    const frame = b.subarray(i, i + n), d = opusPacketMs(frame)
    if (!d || (ms += d) > OPUS_MAX_MESSAGE_MS) return null
    frames.push(frame)
    i += n
  }
  return frames.length ? frames : null
}

// For tests and the page's framing: frames into one message.
export function packOpus(frames: Uint8Array[]): Uint8Array<ArrayBuffer> {
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
  private closed = false
  private waiting: Uint8Array[][] = []
  errors = 0
  constructor(private onPcm: (pcm: Uint8Array) => void) {
    void this.dec.ready.then(() => { this.ready = true; for (const f of this.waiting.splice(0)) this.decode(f) }).catch(() => {})
  }
  // false when the message is not good Opus framing, or holds too much (it is then dropped)
  push(msg: Uint8Array): boolean {
    if (this.closed) return false
    const frames = opusFrames(msg)
    if (!frames) { this.errors++; return false }
    // copied: the socket's buffer may be reused once this returns
    const own = frames.map(f => f.slice())
    if (this.ready) this.decode(own)
    // Until the decoder has loaded (a moment): kept, but not without end if it never does.
    else if (this.waiting.length < WAITING_MAX) this.waiting.push(own)
    else { this.errors++; return false }
    return true
  }
  private decode(frames: Uint8Array[]) {
    // After the call: its recording is closed, and what was still waiting must not reopen it.
    if (this.closed) return
    const r = this.dec.decodeFrames(frames)
    if (r.errors?.length) this.errors += r.errors.length
    if (r.samplesDecoded) this.onPcm(toPcm16(r.channelData[0].subarray(0, r.samplesDecoded)))
  }
  free() { this.closed = true; this.waiting = []; try { this.dec.free() } catch {} }
}
// Messages kept while the decoder loads: 20 s of the page's 100 ms messages.
const WAITING_MAX = 200
