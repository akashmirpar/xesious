#!/usr/bin/env bun
/**
 * judge.ts — suggested marks for a compare.ts result: for each question, Claude reads
 * every conversation any engine returned and says whether it answers the question,
 * is related, or is not. review.ts shows them as suggestions a person confirms or
 * corrects, so judging a few hundred results is skimming, not reading from scratch.
 *
 *   bun context/judge.ts <results.json> [--model sonnet]
 *
 * One call per question (with everything its engines returned); only conversations
 * not judged before are sent, so re-running after adding engines costs little.
 * The marks go into <results>.judged.json, keyed by question and conversation.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cliRun } from './summarize'

const SYSTEM = [
  'You judge search results for a team chat history. You get one question and several numbered conversation excerpts from the chat',
  '(which may mix languages and scripts). For each excerpt decide:',
  '2 = it answers the question, fully or in an important part (someone reading it could answer, or it states the fact, decision, date or cause asked about);',
  '1 = it is about the same subject or incident but does not answer the question;',
  '0 = unrelated, or only shares words.',
  'Judge each excerpt on its own; the question and the chat may write the same name in different scripts or spellings.',
  'Answer with exactly one line per excerpt, in order, as "n: score", and nothing else.',
].join('\n')

if (import.meta.main) {
  const args = process.argv.slice(2)
  const src = args.find(a => a.endsWith('.json'))
  if (!src) { console.error('usage: bun context/judge.ts <results.json> [--model sonnet]'); process.exit(2) }
  const model = args[args.indexOf('--model') + 1] && args.includes('--model') ? args[args.indexOf('--model') + 1] : 'sonnet'
  const D = JSON.parse(readFileSync(src, 'utf8'))
  const outFile = src.replace(/\.json$/, '') + '.judged.json'
  const judged: Record<string, Record<string, number>> = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : {}
  const cwd = join(tmpdir(), `xesious-judge-${process.pid}`)
  mkdirSync(cwd, { recursive: true })
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)
  let cost = 0, calls = 0
  for (const q of D.questions) {
    const pool = new Set<string>()
    for (const form of Object.keys(D.runs[q.n] ?? {})) for (const run of Object.values(D.runs[q.n][form]) as any[]) for (const h of run.hits) pool.add(h.key)
    const todo = [...pool].filter(k => judged[q.n]?.[k] === undefined)
    for (let i = 0; i < todo.length; i += 25) {
      const part = todo.slice(i, i + 25)
      const user = `Question: ${q.text}\n\n` + part.map((k, j) => {
        const s = D.stretches[k]
        return `=== ${j + 1} === (topic: ${s.topic}; ${day(s.t0)}${day(s.t1) !== day(s.t0) ? ` to ${day(s.t1)}` : ''})\n${s.text.split('\n').slice(1).join('\n')}`
      }).join('\n\n')
      const r = await cliRun(model, SYSTEM, user, cwd)
      calls++; cost += r.cost
      if (!r.text) { console.error(`[judge] Q${q.n}: ${r.error}`); continue }
      for (const line of r.text.split('\n')) {
        const m = /^\s*(\d+)\s*[:.)-]\s*([012])\b/.exec(line)
        if (m && part[Number(m[1]) - 1]) (judged[q.n] ??= {})[part[Number(m[1]) - 1]] = Number(m[2])
      }
      writeFileSync(outFile, JSON.stringify(judged, null, 1))
    }
    const got = judged[q.n] ?? {}
    console.log(`[judge] Q${q.n}: ${Object.keys(got).length} judged, ${Object.values(got).filter(v => v === 2).length} answer(s)`)
  }
  console.log(`[judge] ${calls} call(s) with ${model}, $${cost.toFixed(3)} list price → ${outFile}`)
}
