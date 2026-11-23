// How long a call's requests took, read from its trace (live/latency.ts).
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestTimings, summarize, latencyLine, callDirs, callLatency, type TraceLine } from '../live/latency'

const L = (ms: number, stage: string, msg: string): TraceLine => ({ ms, stage, msg })
// Three requests: a plain one, one with a tool, and one where the caller went on talking.
const trace: TraceLine[] = [
  L(10_000, 'soniox', '1350 ms of quiet in the audio: ending the piece'),
  L(11_200, 'decide', 'send: sounds finished'),
  L(11_200, 'turn', 'request 1 (your voice)'),
  L(13_200, 'claude', 'first words after 2000 ms'),
  L(14_200, 'page', 'playing the answer'),
  L(20_000, 'soniox', '1350 ms of quiet in the audio: ending the piece'),
  L(21_000, 'turn', 'request 2 (your voice)'),
  L(22_000, 'claude', 'tool ⚙️ Running a command'),
  L(26_000, 'claude', 'first words after 5000 ms'),
  L(27_000, 'page', 'playing the answer'),
  L(30_000, 'soniox', '1350 ms of quiet in the audio: ending the piece'),
  L(30_500, 'decide', "you're talking again, so the request waits until you stop"),
  L(33_000, 'turn', 'request 3 (your voice)'),
  L(34_000, 'claude', 'request 3 done in 1000 ms (stopped)'),
  L(40_000, 'turn', 'request 4 (typed)'),
  L(41_000, 'claude', 'first words after 1000 ms'),
]

test('each request: the wait from your last word, first words, the answer playing', () => {
  expect(requestTimings(trace)).toEqual([
    { req: 1, voice: true, tools: 0, wait: 2550, words: 2000, audio: 3000, total: 5550 },
    { req: 2, voice: true, tools: 1, wait: 2350, words: 5000, audio: 6000, total: 8350 },
    // went on talking: when they stopped isn't known, so no wait
    { req: 3, voice: true, tools: 0, stopped: true },
    { req: 4, voice: false, tools: 0, words: 1000 },
  ])
})

test('the call in one line: medians, and the answer without tools', () => {
  const s = summarize(requestTimings(trace))
  expect(s).toMatchObject({ requests: 4, voice: 3, wait: 2450, words: 2000, audio: 4500, total: 6950, audioNoTools: 3000 })
  expect(latencyLine(s)).toBe('⏱ Median of 4 requests: you stop → sent 2.5 s; sent → first words 2.0 s, answer playing 4.5 s (without tools 3.0 s); your last word to the answer: 7.0 s')
  expect(latencyLine(summarize([]))).toBe('')
})

test("a call's folders: this link's, from when the call started", () => {
  const base = mkdtempSync(join(tmpdir(), 'latency-'))
  const uuid = '0f3c2a9e-1b2c-4d5e-8f90-123456789abc'
  const mk = (stamp: string, id: string, lines: TraceLine[] = trace) => {
    mkdirSync(join(base, `${stamp}-${id}`)); writeFileSync(join(base, `${stamp}-${id}`, 'trace.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  }
  mk('2026-11-20T09-00-00-000Z', '0f3c2a9e-1b2')   // an earlier call on the same link
  mk('2026-11-20T10-00-00-000Z', '0f3c2a9e-1b2')
  mk('2026-11-20T10-05-00-000Z', '0f3c2a9e-1b2')   // the page reconnected
  mk('2026-11-20T10-01-00-000Z', 'aaaaaaaa-bbb')   // another link
  const since = Date.parse('2026-11-20T09:59:00Z')
  expect(callDirs(base, uuid, since).map(d => d.slice(base.length + 1))).toEqual(['2026-11-20T10-00-00-000Z-0f3c2a9e-1b2', '2026-11-20T10-05-00-000Z-0f3c2a9e-1b2'])
  expect(callLatency(base, uuid, since)).toStartWith('⏱ Median of 8 requests:')
  expect(callLatency(base, 'nothing-here', since)).toBe('')
})
