#!/usr/bin/env bun
// Feed a recorded call's mic audio to Soniox again, to see what it hears with other
// settings — the way to tell a speech-recognition problem from everything after it.
//
//   bun live/replay.ts state/live-calls/<call> [--model stt-rt-v6] [--languages en,fa]
//                      [--endpoint 1500] [--speed 1] [--from 0] [--to 0] [--terms 'Hey Lucy,Lucy']
//
// Prints each finished piece with who said it and where it is in the audio. Uses
// SONIOX_API_KEY (from .env) and paid Soniox time, like a call does.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { SonioxStream, TokenTracker } from './soniox'

const args = process.argv.slice(2)
const dir = args.find(a => !a.startsWith('--'))
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] ? args[i + 1] : d }
if (!dir) { console.error('usage: bun live/replay.ts <call dir> [--model m] [--languages en,fa] [--endpoint ms] [--speed x] [--from s] [--to s]'); process.exit(2) }
const wavPath = dir.endsWith('.wav') ? dir : join(dir, 'mic.wav')
if (!existsSync(wavPath)) { console.error(`no ${wavPath}`); process.exit(2) }
const key = process.env.SONIOX_API_KEY
if (!key) { console.error('SONIOX_API_KEY is not set'); process.exit(2) }

const wav = readFileSync(wavPath)
const BPS = 32000
const from = Math.floor(Number(opt('from', '0')) * BPS / 2) * 2
const toS = Number(opt('to', '0'))
const pcm = wav.subarray(44 + from, toS > 0 ? 44 + Math.floor(toS * BPS / 2) * 2 : wav.length)
const speed = Math.max(0.25, Number(opt('speed', '1')))
const cfg = { key, model: opt('model', 'stt-rt-v6'), languages: opt('languages', 'en,fa').split(','), endpointMs: Number(opt('endpoint', '1500')), terms: opt('terms', '').split(',').map(s => s.trim()).filter(Boolean) }
console.log(`replaying ${(pcm.length / BPS).toFixed(1)} s of ${wavPath} — ${cfg.model}, ${cfg.languages.join('+')}, endpoint ${cfg.endpointMs} ms, ${speed}x`)

const tracker = new TokenTracker()
const t0 = Date.now()
const stream = new SonioxStream(cfg, {
  connected: () => {},
  status: s => console.log(`[soniox] ${s}`),
  fatal: s => { console.error(`[soniox] ${s}`); process.exit(1) },
  message: m => {
    const r = tracker.push(m)
    if (r.done) for (const t of r.done) console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  speaker ${t.speaker ?? '?'} [${t.language ?? '?'}]: ${t.text}`)
    if (m.finished) { console.log('finished'); process.exit(0) }
  },
})
const step = 3200   // 100 ms
for (let i = 0; i < pcm.length; i += step) { stream.send(new Uint8Array(pcm.subarray(i, i + step))); await Bun.sleep(100 / speed) }
stream.finalize()
await Bun.sleep(3000)
stream.close()
process.exit(0)
