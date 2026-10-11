#!/usr/bin/env bun
// How the ranking of a real history holds up under different ways of fusing the
// engine's signals (context/engine.ts, FusionOpts) and with or without the question's
// expansions (expandQuery). Three kinds of questions, each from a file kept with the
// history (they quote it, so they stay out of this repository):
//
//   --review <dir>  a compare.ts run with judge.ts's marks (results.json and
//                   results.judged.json; 0 no, 1 related, 2 answers it): does an
//                   answer make the top 5 (S@5), and nDCG@5 over the judged
//                   stretches only (an unjudged one is skipped, not counted wrong)
//   --known <files> questions each written for one message, one JSON per line
//                   { id, question, form? }: where the stretch holding that message
//                   ranks (hit@5, hit@10, MRR). Comma-separated.
//   --cases <file>  single cases: { set, q, gold (a stretch key), since?, until?, now? }
//
//   bun context/fusion-eval.ts --db <archive context.db> --chat <id> [--review <dir>] [--known a.jsonl,b.jsonl]
//        [--cases cases.jsonl] [--variants a,b] [--embed-url http://127.0.0.1:8093] [--json out.json]
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ContextIndex, type FusionOpts, type SearchOptions } from './engine'
import { httpEmbedder } from './embed'

const argv = process.argv.slice(2)
const arg = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const CHAT = arg('chat')!
if (!arg('db') || !CHAT) { console.error('usage: bun context/fusion-eval.ts --db <context.db> --chat <id> [--review dir] [--known files] [--cases file]'); process.exit(2) }
const idx = new ContextIndex(arg('db')!)
const embedder = httpEmbedder(arg('embed-url', 'http://127.0.0.1:8093')!, 'bge-m3')
const base = (o: Partial<SearchOptions>): SearchOptions => ({ k: 30, summaries: { model: 'sonnet', use: 'with-text' }, meaning: { embedder }, ...o })

export const VARIANTS: Record<string, { fusion?: FusionOpts; weights?: Record<string, number>; expand?: boolean }> = {
  'before (rrf k60 no-expansion)': { fusion: { k: 60, group: false }, expand: false },
  'rrf k60 (before)': { fusion: { k: 60, group: false } },
  'rrf k20': { fusion: { k: 20, group: false } },
  'rrf k10': { fusion: { k: 10, group: false } },
  'lexical x1.5': { fusion: { k: 60, group: false }, weights: { words: 1.5, message: 1.5 } },
  'semantic x0.5': { fusion: { k: 60, group: false }, weights: { meaning: 0.5, summary: 0.5, 'summary meaning': 0.5 } },
  'group k60': { fusion: { group: true, k: 60 } },
  'group k20': { fusion: { group: true, k: 20 } },
  'group k10 (now)': {},
  'group k10 no-expansion': { expand: false },
  'group k10 agree0': { fusion: { group: true, k: 10, agree: 0 } },
  'group k10 agree0.3': { fusion: { group: true, k: 10, agree: 0.3 } },
}

type Q = { set: string; q: string; o?: Partial<SearchOptions>; judged?: Record<string, number>; gold?: string; now?: number }
const qs: Q[] = []

// Judged real questions: as typed, and as the bridge's search words.
const rv = arg('review')
if (rv && existsSync(join(rv, 'results.json'))) {
  const r = JSON.parse(readFileSync(join(rv, 'results.json'), 'utf8'))
  const j = JSON.parse(readFileSync(join(rv, 'results.judged.json'), 'utf8'))
  for (const q of r.questions) {
    const marks = j[String(q.n)] ?? {}
    qs.push({ set: 'judged/typed', q: q.text, judged: marks, now: r.now })
    if (q.bridgeSonnet) qs.push({ set: 'judged/bridge', q: q.bridgeSonnet, judged: marks, now: r.now })
  }
}
// Known items.
for (const kf of (arg('known') ?? '').split(',').filter(Boolean)) {
  for (const l of readFileSync(kf, 'utf8').split('\n').filter(Boolean)) {
    const x = JSON.parse(l)
    const key = episodeKeyOf(x.id)
    if (key) qs.push({ set: `${x.set ?? 'known'}/${x.form ?? 'typed'}`, q: x.question, gold: key })
  }
}
// Single cases.
const day = (d?: string, end = false) => d ? Date.parse(`${d}T${end ? '23:59:59' : '00:00:00'}Z`) / 1000 : undefined
if (arg('cases')) for (const l of readFileSync(arg('cases')!, 'utf8').split('\n').filter(Boolean)) {
  const x = JSON.parse(l)
  qs.push({ set: x.set ?? 'cases', q: x.q, gold: x.gold, o: { since: day(x.since), until: day(x.until, true) }, now: x.now ? Date.parse(x.now) / 1000 : undefined })
}

function episodeKeyOf(id: number): string | undefined {
  const m = idx.db.query('SELECT topic FROM msgs WHERE chat = ? AND id = ?').get(CHAT, id) as { topic: string } | null
  if (!m) return undefined
  return (idx.db.query('SELECT ekey FROM episodes WHERE chat = ? AND topic = ? AND first_id <= ? AND last_id >= ?').get(CHAT, m.topic, id, id) as { ekey: string } | null)?.ekey
}

function ndcg5(ranked: string[], marks: Record<string, number>): number {
  const gain = (m: number) => (m === 2 ? 3 : m === 1 ? 1 : 0)
  const judged = ranked.filter(k => k in marks).slice(0, 5)
  const dcg = judged.reduce((s, k, i) => s + gain(marks[k]) / Math.log2(i + 2), 0)
  const ideal = Object.values(marks).map(gain).sort((a, b) => b - a).slice(0, 5).reduce((s, g, i) => s + g / Math.log2(i + 2), 0)
  return ideal ? dcg / ideal : 0
}

const pick = arg('variants')?.split(',')
const results: Record<string, Record<string, { n: number; a: number; b: number; c: number; ranks: number[] }>> = {}
for (const [name, v] of Object.entries(VARIANTS)) {
  if (pick && !pick.includes(name)) continue
  const per: Record<string, { n: number; a: number; b: number; c: number; ranks: number[] }> = {}
  for (const q of qs) {
    const hits = await idx.search(CHAT, q.q, base({ ...q.o, fusion: v.fusion, weights: v.weights, expand: v.expand, now: q.now }))
    const keys = hits.map(h => h.episode.key)
    const s = (per[q.set] ??= { n: 0, a: 0, b: 0, c: 0, ranks: [] })
    s.n++
    if (q.judged) {
      s.a += keys.slice(0, 5).some(k => q.judged![k] === 2) ? 1 : 0
      s.b += ndcg5(keys, q.judged)
      s.c += keys.slice(0, 5).filter(k => !(k in q.judged!)).length / 5
    } else {
      const r = keys.indexOf(q.gold!) + 1
      s.ranks.push(r)
      s.a += r >= 1 && r <= 5 ? 1 : 0
      s.b += r >= 1 && r <= 10 ? 1 : 0
      s.c += r ? 1 / r : 0
    }
  }
  results[name] = per
  const cells = Object.entries(per).map(([set, s]) => set.startsWith('judged')
    ? `${set}: S@5 ${(s.a / s.n * 100).toFixed(0)}% nDCG@5 ${(s.b / s.n).toFixed(3)} unjudged@5 ${(s.c / s.n * 100).toFixed(0)}%`
    : `${set}: hit@5 ${(s.a / s.n * 100).toFixed(0)}% hit@10 ${(s.b / s.n * 100).toFixed(0)}% MRR ${(s.c / s.n).toFixed(3)}${s.n <= 12 ? ` ranks ${s.ranks.map(r => r || '-').join(',')}` : ''}`)
  console.log(`${name.padEnd(20)} ${cells.join(' | ')}`)
}
if (arg('json')) await Bun.write(arg('json')!, JSON.stringify(results))
