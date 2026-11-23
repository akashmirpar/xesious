// The mic as Opus (live/opus.ts): framing, and decoding back to 16 kHz PCM.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OpusIn, isOpus, opusFrames, packOpus, OPUS_MAGIC } from '../live/opus'

const tone: Uint8Array[] = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures-opus-tone.json'), 'utf8')).frames.map((b: string) => new Uint8Array(Buffer.from(b, 'base64')))

test('frames are packed behind the marker, and read back the same', () => {
  const m = packOpus(tone.slice(0, 5))
  expect(isOpus(m)).toBe(true)
  expect(opusFrames(m)!.map(f => [...f])).toEqual(tone.slice(0, 5).map(f => [...f]))
  // raw PCM is never taken for Opus; broken framing is refused
  expect(isOpus(new Uint8Array(3200))).toBe(false)
  expect(isOpus(OPUS_MAGIC)).toBe(false)
  expect(opusFrames(m.subarray(0, m.byteLength - 3))).toBeNull()
  expect(opusFrames(new Uint8Array([...OPUS_MAGIC, 0, 0]))).toBeNull()
})

test('decoded to 16 kHz 16-bit PCM: as long as it was, and not silent', async () => {
  const pcm: Uint8Array[] = []
  const o = new OpusIn(p => pcm.push(p))
  for (let i = 0; i < tone.length; i += 5) expect(o.push(packOpus(tone.slice(i, i + 5)))).toBe(true)
  for (let i = 0; i < 50 && pcm.reduce((n, p) => n + p.byteLength, 0) < tone.length * 640; i++) await Bun.sleep(20)
  const all = new Int16Array(Buffer.concat(pcm).buffer.slice(0))
  expect(all.length).toBe(tone.length * 320)   // 20 ms at 16 kHz each
  const rms = Math.sqrt(all.reduce((s, x) => s + x * x, 0) / all.length)
  expect(rms).toBeGreaterThan(2000)            // the tone (ffmpeg makes it at 1/8 of full scale: ~2900), not silence
  expect(o.errors).toBe(0)
  expect(o.push(new Uint8Array([...OPUS_MAGIC, 0, 9, 1]))).toBe(false)
  expect(o.errors).toBe(1)
  o.free()
})
