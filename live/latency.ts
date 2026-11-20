// live/latency.ts — how long a call's requests took, from its trace: the speed work's
// measure. For each request said by voice:
//   wait   your last word → sent (the quiet wait, plus any "sounds unfinished" wait)
//   words  sent → Claude's first words
//   audio  sent → the answer starting to play on the page
//   total  your last word → the answer playing
// Your last word is where the piece ended less the quiet that ended it; when you started
// again before it was sent, that moment isn't in the trace, so its wait (and total) is left out.
//
//   bun live/latency.ts state/live-calls/<call> [<call> …]     # per request, then medians
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type TraceLine = { ms: number; stage: string; msg: string; [k: string]: unknown }
export type RequestTiming = { req: number; voice: boolean; tools: number; wait?: number; words?: number; audio?: number; total?: number; stopped?: boolean }

export function requestTimings(lines: TraceLine[]): RequestTiming[] {
  const out: RequestTiming[] = []
  let pieceEnd: number | undefined, quiet = 0, wentOn = false
  let cur: (RequestTiming & { sentAt: number }) | undefined
  const close = () => { if (cur) { const { sentAt: _, ...r } = cur; out.push(r) } cur = undefined }
  for (const l of lines) {
    const msg = String(l.msg ?? '')
    if (l.stage === 'soniox') {
      const q = /^(\d+) ms of quiet in the audio: ending the piece/.exec(msg) ?? /have been quiet (\d+) ms while others talk/.exec(msg)
      if (q) { pieceEnd = l.ms; quiet = Number(q[1]); wentOn = false }
      continue
    }
    if (l.stage === 'decide' && msg.startsWith("you're talking again")) { wentOn = true; continue }
    const turn = l.stage === 'turn' ? /^request (\d+) \((.+?)\)/.exec(msg) : null
    if (turn) {
      close()
      const voice = turn[2] === 'your voice'
      cur = { req: Number(turn[1]), voice, tools: 0, sentAt: l.ms }
      if (voice && pieceEnd !== undefined && !wentOn && l.ms - pieceEnd < 15_000) cur.wait = l.ms - pieceEnd + quiet
      continue
    }
    if (!cur) continue
    if (l.stage === 'claude' && msg.startsWith('tool ')) cur.tools++
    else if (l.stage === 'claude' && cur.words === undefined && /^first words after/.test(msg)) cur.words = l.ms - cur.sentAt
    else if (l.stage === 'claude' && new RegExp(`^request ${cur.req} done in .*\\(stopped\\)`).test(msg)) cur.stopped = true
    else if (l.stage === 'page' && msg === 'playing the answer' && cur.audio === undefined) {
      cur.audio = l.ms - cur.sentAt
      if (cur.wait !== undefined) cur.total = cur.wait + cur.audio
    }
  }
  close()
  return out
}

const median = (xs: number[]) => { if (!xs.length) return undefined; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const sec = (ms: number | undefined) => ms === undefined ? '–' : `${(ms / 1000).toFixed(1)} s`

export type LatencySummary = { requests: number; voice: number; wait?: number; words?: number; audio?: number; total?: number; audioNoTools?: number; noTools: number }
export function summarize(t: RequestTiming[]): LatencySummary {
  const pick = (k: 'wait' | 'words' | 'audio' | 'total', rs = t) => median(rs.map(r => r[k]).filter((x): x is number => typeof x === 'number'))
  const plain = t.filter(r => r.tools === 0)
  return { requests: t.length, voice: t.filter(r => r.voice).length, wait: pick('wait'), words: pick('words'), audio: pick('audio'), total: pick('total'), audioNoTools: pick('audio', plain), noTools: plain.length }
}

// One line for the call's summary (medians), or '' when nothing was asked.
export function latencyLine(s: LatencySummary): string {
  if (!s.requests) return ''
  const after = [s.words !== undefined && `first words ${sec(s.words)}`, s.audio !== undefined && `answer playing ${sec(s.audio)}`].filter(Boolean)
  const parts = [s.wait !== undefined && `you stop → sent ${sec(s.wait)}`, after.length && `sent → ${after.join(', ')}`].filter(Boolean)
  if (!parts.length) return ''
  const total = s.total !== undefined ? `; your last word to the answer: ${sec(s.total)}` : ''
  const plain = s.audioNoTools !== undefined && s.noTools < s.requests ? ` (without tools ${sec(s.audioNoTools)})` : ''
  return `⏱ Median of ${s.requests} request${s.requests === 1 ? '' : 's'}: ${parts.join('; ')}${plain}${total}`
}

export function readTrace(dir: string): TraceLine[] {
  try { return readFileSync(join(dir, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] }
}

// A call's folders (one per page connection: a phone that locks reconnects), named
// "<start>-<link id, first 12 characters>" by CallRecorder, started at or after `since`.
export function callDirs(base: string, uuid: string, since: number): string[] {
  const tag = '-' + uuid.replace(/[^\w-]/g, '').slice(0, 12)
  let names: string[] = []
  try { names = readdirSync(base) } catch { return [] }
  return names.filter(n => n.endsWith(tag)).filter(n => {
    const at = Date.parse(n.slice(0, 24).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z/, 'T$1:$2:$3.$4Z'))
    return Number.isFinite(at) && at >= since
  }).sort().map(n => join(base, n))
}
export function callLatency(base: string, uuid: string, since: number): string {
  return latencyLine(summarize(callDirs(base, uuid, since).flatMap(d => requestTimings(readTrace(d)))))
}

if (import.meta.main) {
  const dirs = process.argv.slice(2)
  if (!dirs.length) { console.error('usage: bun live/latency.ts <call dir> [<call dir> …]'); process.exit(2) }
  const all: RequestTiming[] = []
  for (const d of dirs) {
    const t = requestTimings(readTrace(d))
    all.push(...t)
    console.log(d)
    for (const r of t) console.log(`  request ${r.req}${r.voice ? '' : ' (typed)'}: wait ${sec(r.wait)}, first words ${sec(r.words)}, playing ${sec(r.audio)}, total ${sec(r.total)}${r.tools ? `, ${r.tools} tool${r.tools === 1 ? '' : 's'}` : ''}${r.stopped ? ', stopped' : ''}`)
  }
  console.log(latencyLine(summarize(all)) || 'no requests')
}
