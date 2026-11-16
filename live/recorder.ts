// live/recorder.ts — a folder per call, for finding out later what went wrong where.
//
//   state/live-calls/<start time>-<link>/
//     mic.wav       what the page sent: 16 kHz mono, everything the mic heard
//     trace.jsonl   one line per step, with ms since the call started
//     answers/      each spoken sentence as it was sent to the page
//
// mic.wav can be fed to Soniox again with other settings: bun live/replay.ts <dir>.
// It holds anyone near the phone, so it stays on this machine (state/ is
// git-ignored, mode 700) and is deleted after LIVE_KEEP_DAYS (7).
import { mkdirSync, openSync, writeSync, closeSync, writeFileSync, appendFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const RATE = 16000
const MAX_AUDIO_BYTES = Number(process.env.LIVE_MAX_AUDIO_MB || 450) * 1024 * 1024   // 16 kHz 16-bit: ~4 h

function wavHeader(dataBytes: number, rate = RATE): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40)
  return h
}
export function pcmToWav(pcm: Uint8Array, rate = RATE): Buffer { return Buffer.concat([wavHeader(pcm.byteLength, rate), pcm]) }

export class CallRecorder {
  readonly dir: string
  private fd: number | null = null
  private bytes = 0
  private sinceHeader = 0
  private full = false
  private readonly t0 = Date.now()
  private answers = 0

  constructor(base: string, name: string, meta: Record<string, unknown>) {
    const stamp = new Date(this.t0).toISOString().replace(/[:.]/g, '-')
    this.dir = join(base, `${stamp}-${name.replace(/[^\w-]/g, '').slice(0, 12)}`)
    mkdirSync(join(this.dir, 'answers'), { recursive: true, mode: 0o700 })
    writeFileSync(join(this.dir, 'meta.json'), JSON.stringify({ started: new Date(this.t0).toISOString(), ...meta }, null, 2), { mode: 0o600 })
  }

  audio(pcm: Uint8Array): void {
    // A call's recording stops growing at MAX_AUDIO_BYTES (about four hours).
    if (this.bytes + pcm.byteLength > MAX_AUDIO_BYTES) { if (!this.full) { this.full = true; this.trace('audio', 'recording full: the rest of the call is not kept') } return }
    if (this.fd === null) {
      this.fd = openSync(join(this.dir, 'mic.wav'), 'w', 0o600)
      writeSync(this.fd, wavHeader(0))
      this.trace('audio', 'first audio from the page')
    }
    writeSync(this.fd, pcm, 0, pcm.byteLength, 44 + this.bytes)
    this.bytes += pcm.byteLength
    // Keep the header right as we go (every ~5 s), so a crash still leaves a playable file.
    if ((this.sinceHeader += pcm.byteLength) >= RATE * 2 * 5) { this.sinceHeader = 0; writeSync(this.fd, wavHeader(this.bytes), 0, 44, 0) }
  }
  // The position in mic.wav right now, so a trace line can be found in the audio.
  audioMs(): number { return Math.round(this.bytes / (RATE * 2) * 1000) }

  trace(stage: string, msg: string, extra: Record<string, unknown> = {}): void {
    const line = { ms: Date.now() - this.t0, audio_ms: this.audioMs(), stage, msg, ...extra }
    try { appendFileSync(join(this.dir, 'trace.jsonl'), JSON.stringify(line) + '\n', { mode: 0o600 }) } catch {}
  }
  answer(wav: Uint8Array, text: string): void {
    const n = String(++this.answers).padStart(3, '0')
    try { writeFileSync(join(this.dir, 'answers', `${n}.wav`), wav, { mode: 0o600 }) } catch {}
    this.trace('voice', `answer audio ${n}.wav`, { text })
  }
  private closed = false
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.fd !== null) { try { writeSync(this.fd, wavHeader(this.bytes), 0, 44, 0); closeSync(this.fd) } catch {}; this.fd = null }
    this.trace('call', 'ended', { audio_s: Math.round(this.bytes / (RATE * 2)) })
  }
}

// Delete call folders older than `days`.
export function pruneCalls(base: string, days: number, now = Date.now()): string[] {
  if (!(days > 0)) return []
  const gone: string[] = []
  let names: string[] = []
  try { names = readdirSync(base) } catch { return [] }
  for (const n of names) {
    const p = join(base, n)
    try { if (now - statSync(p).mtimeMs > days * 86_400_000) { rmSync(p, { recursive: true, force: true }); gone.push(n) } } catch {}
  }
  return gone
}
