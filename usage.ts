// usage.ts — one ledger per bridge instance: what every claude run cost, across all
// of its topics.
//
// The CLI reports what a run used in its result (tokens in, out, cache read and
// written, its own cost estimate, turns, duration). The tasks store keeps that per
// task run and nothing kept it for anything else — a topic turn, a judge, a recall
// query, a voice pass — so the one question "how much has this bot used?" had no
// answer. Every run now lands here as one row, whichever path spawned it.
//
// Rows hold numbers and ids only — kind of run, chat, thread, model — never prompt
// text. One SQLite file next to the state file (TG_USAGE_DB moves it), WAL so the
// live voice server, a separate process, can write to the same ledger.
//
//   bun usage.ts [--db state/usage.db] [--since 30]     prints the report
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RunUsage } from './lib'

// One run's usage, with what the ledger needs to say whose it was.
export interface UsageEvent extends RunUsage {
  // turn | bg | auto | private | passthrough | compact | fanout | task | handoff |
  // judge | filter | recall | digest | voice | live | chore
  kind: string
  chat?: string
  thread?: number
  ok?: boolean
  // The CLI session the run belongs to, and whether this run STARTED it. Needed
  // because costUsd is the session's running total, not the run's (see costOf). A
  // one-shot that never resumes passes neither: its total is its own.
  session?: string
  fresh?: boolean
}

export interface UsageTotals {
  runs: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
  // Runs whose cost could not be told apart from their session's history.
  unpriced: number
  durationMs: number
}

export const tokensOf = (t: UsageTotals): number => t.input + t.output + t.cacheRead + t.cacheWrite
const DAY = 24 * 60 * 60 * 1000

export class UsageLedger {
  private db: Database
  constructor(public readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;')
    // A ledger written before costOf existed charged each resumed run its session's
    // whole history. Its rows carry no session, so the true costs cannot be recovered:
    // they are cleared once, and those runs stay — tokens intact — as unpriced.
    // One-shot kinds never resume, and were right.
    const has = (t: string) => !!this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)
    const legacy = has('usage') && !has('session_cost')
    this.db.exec(`CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, chat TEXT, thread INTEGER, model TEXT,
      input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
      cost REAL, turns INTEGER, duration_ms INTEGER, ok INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
      CREATE TABLE IF NOT EXISTS session_cost (session TEXT PRIMARY KEY, cum REAL NOT NULL, ts INTEGER NOT NULL);`)
    if (legacy) this.db.run(`UPDATE usage SET cost = NULL WHERE kind NOT IN ('judge', 'filter', 'recall', 'digest', 'voice', 'chore')`)
  }

  // Never throws: a ledger that cannot write must not cost anyone their answer. A
  // count that is not a number is kept as 0 rather than losing the row.
  record(e: UsageEvent, at = Date.now()): void {
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0)
    const opt = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    try {
      const cost = this.costOf(e)
      this.db.run(`INSERT INTO usage (ts, kind, chat, thread, model, input, output, cache_read, cache_write, cost, turns, duration_ms, ok)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [at, e.kind, e.chat ?? null, e.thread ?? null, e.model ?? null,
          n(e.inputTokens), n(e.outputTokens), n(e.cacheReadTokens), n(e.cacheWriteTokens),
          cost, opt(e.turns), opt(e.durationMs), e.ok === false ? 0 : 1])
    } catch (err) { console.error(`[usage] record: ${err}`) }
  }

  // What this run cost. The CLI's total_cost_usd — and modelUsage — are the SESSION's
  // running totals: resumed, a session reports everything it has ever cost (measured
  // 2026-11-14: a resumed call reported the first call's cost plus its own, while its
  // `usage` tokens were its own alone). So a run is charged the difference from what
  // its session reported last, and a run that started its session owns the whole
  // total. A session first met mid-life — resumed from before the ledger existed, or
  // forked — has no baseline: that one run is left unpriced rather than charged the
  // whole history, and the session is priced from its next run on.
  private costOf(e: UsageEvent): number | null {
    const cum = typeof e.costUsd === 'number' && Number.isFinite(e.costUsd) ? e.costUsd : null
    if (cum === null || !e.session) return cum
    const prev = this.db.query('SELECT cum FROM session_cost WHERE session = ?').get(e.session) as { cum: number } | null
    this.db.run(`INSERT INTO session_cost (session, cum, ts) VALUES (?, ?, ?)
      ON CONFLICT(session) DO UPDATE SET cum = excluded.cum, ts = excluded.ts`, [e.session, cum, Date.now()])
    if (e.fresh) return cum
    return prev && cum >= prev.cum ? cum - prev.cum : null
  }

  totals(sinceMs = 0): UsageTotals {
    const r = this.db.query(`SELECT COUNT(*) runs, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output,
      COALESCE(SUM(cache_read),0) cacheRead, COALESCE(SUM(cache_write),0) cacheWrite,
      COALESCE(SUM(cost),0) costUsd, COUNT(*) - COUNT(cost) unpriced, COALESCE(SUM(duration_ms),0) durationMs FROM usage WHERE ts >= ?`).get(sinceMs) as UsageTotals
    return r
  }

  // Per kind of run, biggest first.
  byKind(sinceMs = 0): { kind: string; totals: UsageTotals }[] {
    const rows = this.db.query(`SELECT kind, COUNT(*) runs, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output,
      COALESCE(SUM(cache_read),0) cacheRead, COALESCE(SUM(cache_write),0) cacheWrite,
      COALESCE(SUM(cost),0) costUsd, COUNT(*) - COUNT(cost) unpriced, COALESCE(SUM(duration_ms),0) durationMs FROM usage WHERE ts >= ? GROUP BY kind`).all(sinceMs) as (UsageTotals & { kind: string })[]
    return rows.map(({ kind, ...totals }) => ({ kind, totals })).sort((a, b) => tokensOf(b.totals) - tokensOf(a.totals))
  }

  // The busiest places, as chat:thread, biggest first.
  top(sinceMs = 0, n = 5): { chat: string; thread: number | null; totals: UsageTotals }[] {
    const rows = this.db.query(`SELECT chat, thread, COUNT(*) runs, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output,
      COALESCE(SUM(cache_read),0) cacheRead, COALESCE(SUM(cache_write),0) cacheWrite,
      COALESCE(SUM(cost),0) costUsd, COUNT(*) - COUNT(cost) unpriced, COALESCE(SUM(duration_ms),0) durationMs FROM usage
      WHERE ts >= ? AND chat IS NOT NULL GROUP BY chat, thread`).all(sinceMs) as (UsageTotals & { chat: string; thread: number | null })[]
    return rows.map(({ chat, thread, ...totals }) => ({ chat, thread, totals })).sort((a, b) => tokensOf(b.totals) - tokensOf(a.totals)).slice(0, n)
  }

  firstAt(): number | undefined {
    const r = this.db.query('SELECT MIN(ts) t FROM usage').get() as { t: number | null }
    return r?.t ?? undefined
  }

  // Rows older than this are gone; the totals of a long-running bot still fit in a
  // few megabytes, so the default (TG_USAGE_KEEP_DAYS) is generous.
  prune(keepDays: number): number {
    const cut = Date.now() - keepDays * DAY
    this.db.run('DELETE FROM session_cost WHERE ts < ?', [cut])
    return this.db.run('DELETE FROM usage WHERE ts < ?', [cut]).changes
  }

  close(): void { this.db.close() }
}

export const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
export const fmtCost = (usd: number): string => `~$${usd < 0.01 && usd > 0 ? usd.toFixed(3) : usd.toFixed(2)}`
const line = (t: UsageTotals): string =>
  `${t.runs} run${t.runs === 1 ? '' : 's'} · ${fmtTokens(tokensOf(t))} tokens · ${fmtCost(t.costUsd)}`

// One line for the startup banner: this month so far.
export function monthLine(l: UsageLedger, now = Date.now()): string {
  const d = new Date(now)
  return `this month: ${line(l.totals(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)))}`
}

// The /stats report: what this bot has used across all its topics. Plain text.
export function usageReport(l: UsageLedger, instance: string, now = Date.now()): string {
  const since = (days: number) => now - days * DAY
  const d = new Date(now)
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const first = l.firstAt()
  const rows: [string, UsageTotals][] = [
    ['today', l.totals(today)], ['7 days', l.totals(since(7))], ['30 days', l.totals(since(30))], ['all time', l.totals()],
  ]
  const w = Math.max(...rows.map(([k]) => k.length))
  const out = [`📊 ${instance} — Claude usage across all topics`, '']
  for (const [k, t] of rows) out.push(`${k.padEnd(w)}  ${line(t)}`)
  if (first) out.push(`${''.padEnd(w)}  (since ${new Date(first).toISOString().slice(0, 10)})`)
  const t30 = l.totals(since(30))
  if (t30.runs) {
    out.push('', `30 days: in ${fmtTokens(t30.input)} · out ${fmtTokens(t30.output)} · cache read ${fmtTokens(t30.cacheRead)} · cache written ${fmtTokens(t30.cacheWrite)}`)
    const kinds = l.byKind(since(30))
    if (kinds.length) out.push(`by kind: ${kinds.map(k => `${k.kind} ${fmtTokens(tokensOf(k.totals))}`).join(' · ')}`)
    const top = l.top(since(30), 5)
    if (top.length > 1) out.push(`busiest: ${top.map(t => `${t.chat}${t.thread != null ? `:${t.thread}` : ''} ${fmtTokens(tokensOf(t.totals))}`).join(' · ')}`)
  }
  const unpriced = rows[rows.length - 1][1].unpriced
  if (unpriced) out.push('', `${unpriced} run${unpriced === 1 ? '' : 's'} unpriced (the first the ledger saw of a session already under way); their tokens are counted.`)
  out.push('', 'tokens = input + output + cache. $ is the CLI\'s own list-price estimate, not a bill.')
  return out.join('\n')
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
  const l = new UsageLedger(opt('--db') ?? 'state/usage.db')
  const days = Number(opt('--since') ?? 0)
  if (days) {
    const t = l.totals(Date.now() - days * DAY)
    console.log(`last ${days} days: ${line(t)}`)
    for (const k of l.byKind(Date.now() - days * DAY)) console.log(`  ${k.kind.padEnd(12)} ${line(k.totals)}`)
  } else console.log(usageReport(l, '(this instance)'))
  l.close()
}
