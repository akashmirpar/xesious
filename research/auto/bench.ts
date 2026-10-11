#!/usr/bin/env bun
// Benchmark Auto mode's triage step: should the bot speak up now, unasked?
//
// Runs the exact prompts the bridge sends (lib.ts: triageSystemPrompt and
// triageUserPrompt) over research/auto/triage-eval.jsonl, against either the
// Claude CLI (your subscription) or a local OpenAI-compatible server such as
// llama.cpp's llama-server, and prints accuracy, precision and recall for JOIN,
// false joins, latency and cost.
//
//   bun research/auto/bench.ts --backend claude:haiku --conc 4
//   bun research/auto/bench.ts --backend local:http://127.0.0.1:8090 --name qwen3.5-2b
//
// Results go to research/auto/results/<name>.jsonl, one line per case, plus a
// summary line at the end.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { triageSystemPrompt, triageCompactPrompt, triageUserPrompt, parseTriage, joinProbability, type TriageMsg, type Eagerness } from '../../lib.ts'

const argv = process.argv.slice(2)
const arg = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const backend = arg('backend', 'claude:haiku')!
const name = arg('name', backend.replace(/[^\w.-]+/g, '_'))!
const evalFile = arg('eval', join(import.meta.dir, 'triage-eval.jsonl'))!
const outFile = arg('out', join(import.meta.dir, 'results', `${name}.jsonl`))!
const conc = Number(arg('conc', backend.startsWith('claude') ? '4' : '1'))
const limit = Number(arg('limit', '0'))
const eagerness = (arg('eagerness', 'balanced') as Eagerness)
const only = arg('only')                     // comma-separated case ids
const threads = arg('threads')               // informational, for the summary
const neutralCwd = arg('cwd', process.env.TRIAGE_CWD || '/tmp')!

const BOT = 'Scout', USERNAME = 'scout_bot'
const NOW = Date.parse('2026-09-25T12:00:00Z') / 1000

interface EvalMsg { id: number; from: string; text: string; reply_to?: number | null; minutes_ago?: number }
interface EvalCase { id: string; lang: string; topic: string; messages: EvalMsg[]; label: 'join' | 'quiet'; strength: string; category: string; why: string }

function toTriage(c: EvalCase): TriageMsg[] {
  const ms = c.messages
  const last = ms[ms.length - 1]
  const lastAgo = last.minutes_ago ?? 0
  // What arrived since the bot last looked: the final burst (within two minutes of
  // the last message), and never across one of the bot's own messages.
  const fresh = new Set<number>()
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i]
    if (m.from === BOT) break
    if (i !== ms.length - 1 && (m.minutes_ago ?? 0) > lastAgo + 2) break
    fresh.add(m.id)
  }
  return ms.map(m => ({
    id: m.id, t: NOW - Math.round((m.minutes_ago ?? 0) * 60), name: m.from, text: m.text,
    replyTo: m.reply_to ?? undefined, bot: m.from === BOT, isNew: fresh.has(m.id),
  }))
}

type Pred = { join: boolean | null; prob?: number | null; raw: string; ms: number; inTok?: number; outTok?: number; cost?: number; promptMs?: number; err?: string }

function runClaude(model: string, system: string, user: string): Promise<Pred> {
  const t0 = performance.now()
  return new Promise(resolve => {
    const env = { ...process.env }
    for (const k of Object.keys(env)) if (k.startsWith('TG_') || k.startsWith('TELEGRAM_')) delete env[k]
    const p = spawn('claude', ['-p', user, '--model', model, '--system-prompt', system, '--tools', '', '--strict-mcp-config',
      '--no-session-persistence', '--disable-slash-commands', '--output-format', 'json', '--settings', '{"alwaysThinkingEnabled":false}'],
      { cwd: neutralCwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', d => out += d)
    p.stderr.on('data', d => err += d)
    p.on('close', () => {
      const ms = performance.now() - t0
      try {
        const d = JSON.parse(out)
        const raw = String(d.result ?? '')
        const parsed = parseTriage(raw)
        const u = d.usage ?? {}
        resolve({ join: parsed ? parsed.join : null, raw, ms, inTok: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          outTok: u.output_tokens, cost: d.total_cost_usd, promptMs: d.duration_api_ms })
      } catch (e) { resolve({ join: null, raw: out.slice(0, 200), ms, err: `${e} ${err.slice(0, 200)}` }) }
    })
  })
}

async function runLocal(url: string, system: string, user: string): Promise<Pred> {
  const t0 = performance.now()
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'local', temperature: 0, max_tokens: 1, logprobs: true, top_logprobs: 20,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        chat_template_kwargs: { enable_thinking: false }, cache_prompt: true,
      }),
    })
    const d: any = await r.json()
    const ms = performance.now() - t0
    const ch = d.choices?.[0]
    const raw = String(ch?.message?.content ?? '')
    const top = ch?.logprobs?.content?.[0]?.top_logprobs ?? []
    const prob = joinProbability(top.map((x: any) => ({ token: x.token, logprob: x.logprob })))
    const parsed = parseTriage(raw)
    const join = prob !== null ? prob >= 0.5 : parsed ? parsed.join : null
    return { join, prob, raw: raw + (top.length ? `  top=${top.slice(0, 4).map((x: any) => `${JSON.stringify(x.token)}:${Math.exp(x.logprob).toFixed(2)}`).join(' ')}` : ''),
      ms, inTok: d.usage?.prompt_tokens, outTok: d.usage?.completion_tokens, promptMs: d.timings?.prompt_ms }
  } catch (e) { return { join: null, raw: '', ms: performance.now() - t0, err: String(e) } }
}

const cases: EvalCase[] = readFileSync(evalFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
let todo = only ? cases.filter(c => only.split(',').includes(c.id)) : cases
if (limit) todo = todo.slice(0, limit)
// --prompt compact: the short few-shot prompt meant for small local models.
const promptStyle = arg('prompt', 'full')!
const system = promptStyle === 'compact' ? triageCompactPrompt({ bot: BOT, eagerness }) : triageSystemPrompt({ bot: BOT, username: USERNAME, eagerness })
const results: (EvalCase & { pred: Pred })[] = []
mkdirSync(dirname(outFile), { recursive: true })

let next = 0, done = 0
async function worker() {
  while (next < todo.length) {
    const c = todo[next++]
    const user = triageUserPrompt({ topic: c.topic, msgs: toTriage(c), now: NOW, bot: BOT })
    const pred = backend.startsWith('claude:') ? await runClaude(backend.slice(7), system, user) : await runLocal(backend.slice(6), system, user)
    results.push({ ...c, pred })
    done++
    const ok = pred.join === null ? '??' : (pred.join === (c.label === 'join')) ? 'ok' : 'XX'
    process.stderr.write(`${String(done).padStart(3)}/${todo.length} ${c.id} ${c.label.padEnd(5)} ${ok} ${pred.prob != null ? pred.prob.toFixed(2) : ''} ${Math.round(pred.ms)}ms ${pred.err ? 'ERR ' + pred.err.slice(0, 80) : JSON.stringify(pred.raw.slice(0, 60))}\n`)
  }
}
const t0 = performance.now()
await Promise.all(Array.from({ length: Math.max(1, conc) }, worker))
const wall = performance.now() - t0

// ---- metrics
type M = { n: number; acc: number; tp: number; fp: number; tn: number; fn: number; prec: number; rec: number; f1: number; falseJoinRate: number; unparsed: number }
function metrics(rs: typeof results, pick: (r: (typeof results)[number]) => boolean | null): M {
  let tp = 0, fp = 0, tn = 0, fn = 0, unparsed = 0
  for (const r of rs) {
    const p = pick(r)
    const y = r.label === 'join'
    if (p === null) { unparsed++; if (y) fn++; else tn++; continue }  // unparseable counts as QUIET, like the bridge
    if (p && y) tp++; else if (p && !y) fp++; else if (!p && !y) tn++; else fn++
  }
  const n = rs.length
  const prec = tp + fp ? tp / (tp + fp) : 0, rec = tp + fn ? tp / (tp + fn) : 0
  return { n, acc: n ? (tp + tn) / n : 0, tp, fp, tn, fn, prec, rec, f1: prec + rec ? 2 * prec * rec / (prec + rec) : 0, falseJoinRate: fp + tn ? fp / (fp + tn) : 0, unparsed }
}
const pct = (x: number) => `${(100 * x).toFixed(0)}%`
const base = metrics(results, r => r.pred.join)
const lat = results.map(r => r.pred.ms).sort((a, b) => a - b)
const q = (p: number) => Math.round(lat[Math.min(lat.length - 1, Math.floor(p * lat.length))])
const cost = results.reduce((s, r) => s + (r.pred.cost ?? 0), 0)
const inTok = results.reduce((s, r) => s + (r.pred.inTok ?? 0), 0) / Math.max(1, results.length)

const by = (k: (r: (typeof results)[number]) => string) => {
  const g = new Map<string, typeof results>()
  for (const r of results) { const kk = k(r); g.set(kk, [...(g.get(kk) ?? []), r]) }
  return [...g.entries()].sort().map(([kk, rs]) => { const m = metrics(rs, r => r.pred.join); return `${kk}: ${m.tp + m.tn}/${m.n}` }).join('  ')
}

const lines: string[] = []
lines.push(`== ${name} (${backend}, prompt=${promptStyle}, eagerness=${eagerness}${threads ? `, threads=${threads}` : ''}) — ${results.length} cases in ${(wall / 1000).toFixed(0)}s`)
lines.push(`accuracy ${pct(base.acc)} | JOIN precision ${pct(base.prec)} recall ${pct(base.rec)} F1 ${base.f1.toFixed(2)} | false joins ${base.fp} (${pct(base.falseJoinRate)} of quiet cases), missed joins ${base.fn} | unparsed ${base.unparsed}`)
lines.push(`latency p50 ${q(0.5)}ms p90 ${q(0.9)}ms | avg input ${Math.round(inTok)} tok${cost ? ` | list-price cost $${cost.toFixed(4)} total, $${(cost / results.length).toFixed(5)}/call` : ''}`)
const clear = results.filter(r => r.strength === 'clear')
const mc = metrics(clear, r => r.pred.join)
lines.push(`clear cases only: accuracy ${pct(mc.acc)}, false joins ${mc.fp}, missed ${mc.fn} (of ${mc.n})`)
lines.push(`by lang: ${by(r => r.lang)}`)
lines.push(`by category: ${by(r => r.category)}`)
if (results.some(r => r.pred.prob != null)) {
  const th = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map(t => {
    const m = metrics(results, r => r.pred.prob == null ? r.pred.join : r.pred.prob >= t)
    return `${t}: acc ${pct(m.acc)} P ${pct(m.prec)} R ${pct(m.rec)} FJ ${m.fp}`
  })
  lines.push(`thresholds on P(JOIN): ${th.join(' | ')}`)
  // ROC AUC over cases with a probability
  const ps = results.filter(r => r.pred.prob != null)
  const pos = ps.filter(r => r.label === 'join'), neg = ps.filter(r => r.label !== 'join')
  let auc = 0
  for (const a of pos) for (const b of neg) auc += a.pred.prob! > b.pred.prob! ? 1 : a.pred.prob! === b.pred.prob! ? 0.5 : 0
  if (pos.length && neg.length) lines.push(`ROC AUC ${(auc / (pos.length * neg.length)).toFixed(3)}`)
}
const wrong = results.filter(r => r.pred.join !== (r.label === 'join')).map(r => `${r.id}(${r.label[0]}/${r.category})`)
lines.push(`wrong: ${wrong.join(' ')}`)
console.log(lines.join('\n'))

const summary = { name, backend, eagerness, threads, n: results.length, wallMs: Math.round(wall), ...base, p50: q(0.5), p90: q(0.9), avgInTok: Math.round(inTok), cost, clear: mc, report: lines }
writeFileSync(outFile, results.sort((a, b) => a.id.localeCompare(b.id)).map(r => JSON.stringify({ id: r.id, label: r.label, category: r.category, lang: r.lang, strength: r.strength, ...r.pred })).join('\n') + '\n' + JSON.stringify({ summary }) + '\n')
if (!existsSync(outFile)) process.exit(1)
