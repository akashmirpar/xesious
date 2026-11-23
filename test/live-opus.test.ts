// The mic as Opus (live/opus.ts): framing, and decoding back to 16 kHz PCM.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OpusIn, isOpus, opusFrames, opusPacketMs, packOpus, OPUS_MAGIC, OPUS_MAX_MESSAGE_MS } from '../live/opus'

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

test('how long a packet plays is read from its first bytes', () => {
  expect(opusPacketMs(tone[0])).toBe(20)                        // what the page sends
  expect(opusPacketMs(new Uint8Array([0x18]))).toBe(60)         // one byte: 60 ms
  expect(opusPacketMs(new Uint8Array([0x1b, 0x02]))).toBe(120)  // two bytes: two 60 ms frames
  expect(opusPacketMs(new Uint8Array([0xf8]))).toBe(20)
  expect(opusPacketMs(new Uint8Array([0x1b, 0x03]))).toBe(0)    // three would be 180 ms: no packet is that long
  expect(opusPacketMs(new Uint8Array([0x1b]))).toBe(0)          // a frame count that isn't there
  expect(opusPacketMs(new Uint8Array(0))).toBe(0)
})

test('a message holding more audio than a page ever sends is refused before any of it is decoded', async () => {
  // 64 kB of one-byte packets: 22 minutes of "audio", 42 MB of PCM, from one message.
  const flood = packOpus(Array.from({ length: 21_844 }, () => new Uint8Array([0x18])))
  expect(flood.byteLength).toBeLessThanOrEqual(64 * 1024)
  expect(opusFrames(flood)).toBeNull()
  // up to the limit it is taken: 30 s of the page's own 20 ms frames, and not one more
  const most = OPUS_MAX_MESSAGE_MS / 20
  expect(opusFrames(packOpus(Array.from({ length: most }, () => tone[0])))!.length).toBe(most)
  expect(opusFrames(packOpus(Array.from({ length: most + 1 }, () => tone[0])))).toBeNull()
  let pcm = 0
  const o = new OpusIn(p => { pcm += p.byteLength })
  expect(o.push(flood)).toBe(false)
  await Bun.sleep(100)
  expect(pcm).toBe(0)
  expect(o.errors).toBe(1)
  o.free()
})

test('nothing is decoded once the call is over', async () => {
  let pcm = 0
  const o = new OpusIn(p => { pcm += p.byteLength })
  expect(o.push(packOpus(tone.slice(0, 5)))).toBe(true)   // may still be waiting for the decoder to load
  o.free()
  expect(o.push(packOpus(tone.slice(5, 10)))).toBe(false)
  const then = pcm
  await Bun.sleep(150)
  expect(pcm).toBe(then)                                  // what waited is not decoded into a closed recording
})
