#!/usr/bin/env bun
/**
 * compare.ts — run a list of questions through every configured engine, on one
 * history, the way the bridge would, and keep everything: what each engine ranked,
 * how long it took, and the exact recall block the bot would have been handed.
 *
 *   bun context/compare.ts --config <context-engines.json> --archive <chat id> --questions <file> --out <results.json>
 *        [--now 2026-09-26T16:00:00Z] [--k 5] [--no-rewrite]
 *
 * Each question is asked two ways: as typed, and as a search query Claude Haiku
 * writes from it (key terms, names in the spellings the chat may use) — what the
 * bot's own search tool calls look like. context/review.ts turns the result into a
 * page for judging them blind.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { ContextIndex, recallPick, refersBack, type Hit } from './engine'
import { buildEngines, loadEnginesConfig } from './engines'
import { recallBody, RECALL_MAX } from './recall'
import { cliRun } from './summarize'
import { QUERY_SYSTEM, languageNote, parseQuery, queryUser } from './query'

const REWRITE_SYSTEM = [
  'You turn questions about a team chat history into search queries for a search engine over that chat (keyword and meaning search).',
  'The chat may mix languages and scripts, and write names in more than one of them.',
  'For each question, write one line: the key terms, every product, company, project or person name in the spellings the chat is likely to use',
  "(in Latin letters and in the question's own script), and a few close synonyms. No filler words, no question words, no explanation.",
  'Answer with exactly one line per question, in order, as "n: query".',
].join('\n')

export interface Question { n: number; text: string }
export function readQuestions(file: string): Question[] {
  return readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
    .map((l, i) => ({ n: i + 1, text: l.replace(/^\s*[\d۰-۹]+\s*[.)\-:]\s*/, '').trim() }))
}

export interface EngineRun {
  ms: number
  error?: string
  hits: { key: string; score: number; why: string[]; matched: number[] }[]
  // What the bridge hands Claude with Recall on "every message", and whether the
  // default ("when a message points back") would have handed anything.
  block: string
  gate: { pointsBack: boolean; passed: number }
}

// The bridge's own query writer (context/query.ts), one question at a time, the way
// the recall calls it.
async function bridgeWords(qs: Question[], cacheFile: string, terms: string[], model = 'haiku'): Promise<Record<number, string>> {
  const out: Record<number, string> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {}
  const cwd = join(tmpdir(), `xesious-compare-${process.pid}`)
  mkdirSync(cwd, { recursive: true })
  let cost = 0
  for (const q of qs) {
    if (out[q.n]) continue
    const r = await cliRun(model, QUERY_SYSTEM, queryUser(q.text, undefined, languageNote(q.text), terms), cwd)
    cost += r.cost
    const w = parseQuery(r.text)
    if (w) out[q.n] = w
    writeFileSync(cacheFile, JSON.stringify(out, null, 1))
  }
  console.log(`[compare] the bridge's query writer: ${Object.keys(out).length} questions ($${cost.toFixed(4)})`)
  return out
}

async function rewrite(qs: Question[], cacheFile: string): Promise<Record<number, string>> {
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8'))
  const cwd = join(tmpdir(), `xesious-compare-${process.pid}`)
  mkdirSync(cwd, { recursive: true })
  const r = await cliRun('haiku', REWRITE_SYSTEM, qs.map(q => `${q.n}: ${q.text}`).join('\n'), cwd)
  if (!r.text) throw new Error(`rewrite failed: ${r.error}`)
  const out: Record<number, string> = {}
  for (const line of r.text.split('\n')) {
    const m = /^\s*(\d+)\s*[:.)-]\s*(.+)$/.exec(line)
    if (m) out[Number(m[1])] = m[2].trim()
  }
  writeFileSync(cacheFile, JSON.stringify(out, null, 1))
  console.log(`[compare] rewrote ${Object.keys(out).length} questions with Haiku ($${r.cost.toFixed(4)})`)
  return out
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
  const cfg = loadEnginesConfig(opt('--config'))
  const chat = opt('--archive')!
  const db = cfg.archives?.[chat]?.db ?? opt('--db')
  const qfile = opt('--questions'), out = opt('--out')
  if (!chat || !db || !qfile || !out) { console.error('usage: bun context/compare.ts --config <file> --archive <chat id> --questions <file> --out <results.json>'); process.exit(2) }
  const now = Date.parse(opt('--now') ?? new Date().toISOString()) / 1000
  const k = Number(opt('--k') ?? 5)
  const store = new ContextIndex(db)
  store.refresh()
  const all = buildEngines(cfg)
  // --engines a,b: only these (e.g. the ones whose vectors are ready); --merge: add
  // to an earlier result, keeping its runs.
  const only = opt('--engines') ? new Set(opt('--engines')!.split(',')) : undefined
  const engines = new Map([...all].filter(([id]) => !only || only.has(id)))
  const prev = args.includes('--merge') && existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : undefined
  const qs = readQuestions(qfile)
  // --forms: which ways of asking to run (typed, rewritten, bridge); default the first two.
  const wanted = new Set((opt('--forms') ?? 'typed,rewritten').split(','))
  const rewritten = !wanted.has('rewritten') || args.includes('--no-rewrite') ? {} : await rewrite(qs, out.replace(/\.json$/, '') + '.rewrites.json')
  const bridged = wanted.has('bridge') ? await bridgeWords(qs, out.replace(/\.json$/, '') + '.bridge-words.json', store.vocabulary(chat, 400)) : {}
  // The same writer with Sonnet (the "Search words" setting's other model).
  const bridgedSonnet = wanted.has('bridge-sonnet') ? await bridgeWords(qs, out.replace(/\.json$/, '') + '.bridge-words-sonnet.json', store.vocabulary(chat, 400), 'sonnet') : {}
  const names = store.people(chat)
  const runs: Record<string, Record<string, Record<string, EngineRun>>> = prev?.runs ?? {}   // question n → form → engine → run
  const keys = new Set<string>(Object.keys(prev?.stretches ?? {}))
  for (const q of qs) {
    runs[q.n] ??= {}
    const forms: [string, string][] = []
    if (wanted.has('typed')) forms.push(['typed', q.text])
    if (rewritten[q.n]) forms.push(['rewritten', rewritten[q.n]])
    if (bridged[q.n]) forms.push(['bridge', bridged[q.n]])
    if (bridgedSonnet[q.n]) forms.push(['bridge-sonnet', bridgedSonnet[q.n]])
    for (const [form, text] of forms) {
      runs[q.n][form] ??= {}
      for (const e of engines.values()) {
        const t0 = performance.now()
        let hits: Hit[] = [], error: string | undefined
        try { hits = await e.search(store, chat, text, { k: Math.max(k, 8), now }) } catch (x) { error = String(x).slice(0, 300) }
        const ms = Math.round(performance.now() - t0)
        const top = hits.slice(0, k)
        const picked = recallPick(hits, text, { names, now, max: RECALL_MAX, strength: e.def.kind === 'xesious' })
        const block = recallBody(hits.slice(0, RECALL_MAX)).text
        runs[q.n][form][e.id] = { ms, error, block, gate: { pointsBack: refersBack(text, { names, now }), passed: picked.length },
          hits: top.map(h => ({ key: h.episode.key, score: h.score, why: h.why, matched: h.matched })) }
        for (const h of top) keys.add(h.episode.key)
      }
    }
    console.log(`[compare] ${q.n}/${qs.length}: ${q.text.slice(0, 60)}`)
  }
  // Every stretch any engine returned, with what a reader needs to judge it.
  const stretches: Record<string, any> = {}
  for (const key of keys) {
    const e = store.episode(key)!
    stretches[key] = { topic: e.topicTitle, t0: e.t0, t1: e.t1, first: e.first, last: e.last, text: e.text,
      summaries: { haiku: store.summaryOf(key, 'haiku') ?? null, sonnet: store.summaryOf(key, 'sonnet') ?? null } }
  }
  // Engines in config order, whichever run they came from.
  const ran = new Set<string>(Object.values(runs).flatMap(f => Object.values(f).flatMap(r => Object.keys(r))))
  const engineInfo = [...all.values()].filter(e => ran.has(e.id)).map(e => ({ id: e.id, label: e.label, kind: e.def.kind }))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify({ made: new Date().toISOString(), now, chat, title: cfg.archives?.[chat]?.title ?? chat, k,
    engines: engineInfo, questions: qs.map(q => ({ ...q, rewritten: rewritten[q.n] ?? prev?.questions?.find((p: any) => p.n === q.n)?.rewritten ?? null,
      bridge: bridged[q.n] ?? prev?.questions?.find((p: any) => p.n === q.n)?.bridge ?? null,
      bridgeSonnet: bridgedSonnet[q.n] ?? prev?.questions?.find((p: any) => p.n === q.n)?.bridgeSonnet ?? null })), runs, stretches }))
  console.log(`[compare] wrote ${out}: ${qs.length} questions × ${engines.size} engines, ${keys.size} distinct stretches`)
  store.close()
}
