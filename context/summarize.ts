#!/usr/bin/env bun
/**
 * summarize.ts — write the context engine's per-stretch summaries in bulk, through
 * the Claude CLI (the same subscription the bot uses): for an imported archive, or to
 * catch a group up at once instead of a few per background tick.
 *
 *   bun context/summarize.ts --db <context.db> --model haiku|sonnet [--chat <id>] [--batch 8] [--conc 2] [--limit N] [--skip-topics 1,2]
 *
 * Several stretches go in one call (--batch): each `claude -p` start costs seconds of
 * CPU, which on a small server is most of the price. Summaries are stored per model,
 * so several can be compared. Resumable: a stretch that already has a current summary
 * from that model is skipped. Stops at the first sign of a usage limit.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ContextIndex, type Episode } from './engine'
import { DIGEST_BATCH_SYSTEM, digestBatchUser, splitDigests } from './digest'

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'

// One call through `claude -p`: no tools, no MCP, no session file, no thinking, run
// from an empty folder so no project instructions or memory come along.
export async function cliRun(model: string, system: string, user: string, cwd: string): Promise<{ text: string; cost: number; error?: string }> {
  const args = ['-p', user, '--model', model, '--system-prompt', system, '--tools', '', '--strict-mcp-config',
    '--no-session-persistence', '--disable-slash-commands', '--output-format', 'json', '--settings', '{"alwaysThinkingEnabled":false}']
  const p = Bun.spawn([CLAUDE_BIN, ...args], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const kill = setTimeout(() => p.kill(9), 300_000)
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  await p.exited
  clearTimeout(kill)
  try {
    const j = JSON.parse(out)
    if (j.is_error) return { text: '', cost: Number(j.total_cost_usd ?? 0), error: String(j.result ?? 'error').slice(0, 300) }
    return { text: String(j.result ?? ''), cost: Number(j.total_cost_usd ?? 0) }
  } catch {
    return { text: '', cost: 0, error: (err || out || `exit ${p.exitCode}`).slice(0, 300) }
  }
}

// Summaries for a batch of stretches, by key. A stretch the reply skipped is simply
// missing, and the next run picks it up.
export async function summarizeBatch(model: string, eps: Episode[], cwd: string): Promise<{ got: Map<string, string>; cost: number; error?: string }> {
  const r = await cliRun(model, DIGEST_BATCH_SYSTEM, digestBatchUser(eps), cwd)
  const got = new Map<string, string>()
  if (r.text) for (const [n, d] of splitDigests(r.text)) if (eps[n - 1]) got.set(eps[n - 1].key, d)
  return { got, cost: r.cost, error: r.error }
}

const LIMIT_RX = /usage limit|rate limit|limit reached|429|overloaded|quota/i

if (import.meta.main) {
  const args = process.argv.slice(2)
  const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
  const db = opt('--db'), model = opt('--model')
  if (!db || !model) { console.error('usage: bun context/summarize.ts --db <context.db> --model haiku|sonnet [--chat <id>] [--batch 8] [--conc 2] [--limit N] [--skip-topics a,b]'); process.exit(2) }
  const conc = Math.max(1, Number(opt('--conc') ?? 2)), size = Math.max(1, Number(opt('--batch') ?? 8))
  const idx = new ContextIndex(db)
  idx.refresh()
  const skip = opt('--skip-topics') ? new Set(opt('--skip-topics')!.split(',')) : undefined
  const todo = idx.episodesNeedingSummary(model, { chat: opt('--chat'), skipTopics: skip, limit: opt('--limit') ? Number(opt('--limit')) : undefined })
  const batches: Episode[][] = []
  for (let i = 0; i < todo.length; i += size) batches.push(todo.slice(i, i + size))
  const cwd = join(tmpdir(), `xesious-summaries-${process.pid}`)
  mkdirSync(cwd, { recursive: true })
  console.log(`[summarize] ${model}: ${todo.length} stretch(es) to write, ${size} per call, ${conc} call(s) at a time`)
  let done = 0, missed = 0, cost = 0, calls = 0, stop = ''
  const t0 = Date.now()
  let next = 0
  async function worker() {
    while (!stop && next < batches.length) {
      const b = batches[next++]
      let r = await summarizeBatch(model!, b, cwd)
      if (!r.got.size && !(r.error && LIMIT_RX.test(r.error))) r = await summarizeBatch(model!, b, cwd)   // one retry
      calls++
      cost += r.cost
      for (const e of b) {
        const d = r.got.get(e.key)
        if (d) { idx.setSummary(e.key, model!, d); done++ } else missed++
      }
      if (!r.got.size && r.error) {
        if (LIMIT_RX.test(r.error)) stop = r.error
        else console.error(`[summarize] batch at ${b[0].key}: ${r.error}`)
      }
      const n = done + missed
      const rate = n / ((Date.now() - t0) / 1000)
      console.log(`[summarize] ${model}: ${done} written, ${missed} missed of ${todo.length} (${calls} calls); $${cost.toFixed(3)} list price; ` +
        `${rate.toFixed(2)}/s, ~${Math.round((todo.length - n) / Math.max(rate, 0.01) / 60)} min left`)
    }
  }
  await Promise.all(Array.from({ length: conc }, worker))
  idx.close()
  if (stop) { console.log(`[summarize] ${model}: STOPPED — ${stop}`); process.exit(3) }
  console.log(`[summarize] ${model}: finished — ${done} written, ${missed} missed, ${calls} calls, $${cost.toFixed(3)} list price, ${Math.round((Date.now() - t0) / 60000)} min`)
}
