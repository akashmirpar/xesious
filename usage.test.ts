import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { UsageLedger, fmtTokens, monthLine, tokensOf, usageReport } from './usage'
import { usageOf } from './lib'

const DAY = 24 * 60 * 60 * 1000

function fresh(): { l: UsageLedger; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'xesious-usage-'))
  return { l: new UsageLedger(join(dir, 'usage.db')), dir }
}

describe('usageOf reads what a result carries', () => {
  test('the streaming result and the one-shot JSON have the same shape', () => {
    const u = usageOf({ usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 300, cache_creation_input_tokens: 20 },
      total_cost_usd: 0.0123, num_turns: 2, duration_ms: 1500, modelUsage: { 'claude-sonnet-4-6': {} } })
    expect(u).toEqual({ model: 'claude-sonnet-4-6', inputTokens: 1200, outputTokens: 80, cacheReadTokens: 300, cacheWriteTokens: 20, costUsd: 0.0123, turns: 2, durationMs: 1500 })
  })
  test('a result with no usage at all is undefined, not a row of zeros', () => {
    expect(usageOf({ result: 'hi' })).toBeUndefined()
    expect(usageOf(undefined)).toBeUndefined()
  })
})

describe('the usage ledger', () => {
  test('records every kind of run and sums them across topics', () => {
    const { l, dir } = fresh()
    const now = Date.now()
    l.record({ kind: 'turn', chat: '-100', thread: 7, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, costUsd: 0.02 }, now)
    l.record({ kind: 'turn', chat: '-100', thread: 8, inputTokens: 2000, outputTokens: 200, costUsd: 0.04 }, now)
    l.record({ kind: 'task', chat: '-100', thread: 7, inputTokens: 300, outputTokens: 30, costUsd: 0.01 }, now)
    l.record({ kind: 'judge', inputTokens: 900, outputTokens: 1 }, now)
    l.record({ kind: 'voice', inputTokens: 50, outputTokens: 20, ok: false }, now)
    const t = l.totals()
    expect(t.runs).toBe(5)
    expect(t.input).toBe(4250)
    expect(t.output).toBe(351)
    expect(t.cacheRead).toBe(500)
    expect(tokensOf(t)).toBe(5101)
    expect(t.costUsd).toBeCloseTo(0.07, 5)
    // By kind, biggest first; by place, the busiest topic first.
    expect(l.byKind().map(k => k.kind)).toEqual(['turn', 'judge', 'task', 'voice'])
    expect(l.top()[0]).toMatchObject({ chat: '-100', thread: 8 })
    expect(l.top().length).toBe(2)
    l.close(); rmSync(dir, { recursive: true, force: true })
  })

  test('windows are by time: an old row counts for all time, not for today', () => {
    const { l, dir } = fresh()
    const now = Date.now()
    l.record({ kind: 'turn', inputTokens: 10 }, now - 40 * DAY)
    l.record({ kind: 'turn', inputTokens: 1 }, now)
    expect(l.totals().runs).toBe(2)
    expect(l.totals(now - 30 * DAY).runs).toBe(1)
    expect(l.firstAt()).toBe(now - 40 * DAY)
    expect(l.prune(35)).toBe(1)
    expect(l.totals().runs).toBe(1)
    l.close(); rmSync(dir, { recursive: true, force: true })
  })

  test('a bad count never throws and never loses the row — the answer matters more than the ledger', () => {
    const { l, dir } = fresh()
    expect(() => l.record({ kind: 'turn', inputTokens: Number.NaN as any, outputTokens: 5, costUsd: Number.POSITIVE_INFINITY as any })).not.toThrow()
    const t = l.totals()
    expect(t.runs).toBe(1)
    expect(t.input).toBe(0)
    expect(t.output).toBe(5)
    expect(t.costUsd).toBe(0)
    l.close(); rmSync(dir, { recursive: true, force: true })
  })

  test('a resumed session is charged only what the run added — the CLI reports the session\'s running total', () => {
    const { l, dir } = fresh()
    // A session the bot started: the whole total is this run's.
    l.record({ kind: 'turn', costUsd: 0.5, session: 'a', fresh: true })
    // Resumed: the CLI says 0.8 — the session's total — so this run added 0.3.
    l.record({ kind: 'turn', costUsd: 0.8, session: 'a' })
    // A session already under way when the ledger first met it: unpriced, not
    // charged its whole history (a real turn here once read ~$192)…
    l.record({ kind: 'turn', costUsd: 192, session: 'b', inputTokens: 34 })
    // …and priced from its next run on.
    l.record({ kind: 'turn', costUsd: 192.5, session: 'b' })
    // A one-shot that never resumes: its total is its own.
    l.record({ kind: 'judge', costUsd: 0.01 })
    const t = l.totals()
    expect(t.runs).toBe(5)
    expect(t.costUsd).toBeCloseTo(1.31, 6)
    expect(t.unpriced).toBe(1)
    expect(t.input).toBe(34) // the unpriced run's tokens still count in full
    expect(usageReport(l, '@b')).toContain('1 run unpriced')
    l.close(); rmSync(dir, { recursive: true, force: true })
  })

  test('a ledger from before session pricing has its resumed-run costs cleared once, tokens kept', async () => {
    const { Database } = await import('bun:sqlite')
    const dir = mkdtempSync(join(tmpdir(), 'xesious-usage-'))
    const path = join(dir, 'usage.db')
    // The table exactly as the first release wrote it, with the row that gave it away.
    const old = new Database(path, { create: true })
    old.exec(`CREATE TABLE usage (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, chat TEXT, thread INTEGER, model TEXT,
      input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
      cost REAL, turns INTEGER, duration_ms INTEGER, ok INTEGER NOT NULL DEFAULT 1)`)
    old.run(`INSERT INTO usage (ts, kind, input, output, cache_read, cost) VALUES (1, 'turn', 34, 2100, 1230000, 192.21), (2, 'judge', 900, 1, 0, 0.002)`)
    old.close()
    const l = new UsageLedger(path)
    const t = l.totals()
    expect(t.runs).toBe(2)
    expect(t.costUsd).toBeCloseTo(0.002, 6) // the judge was right; the resumed turn's history is gone
    expect(t.unpriced).toBe(1)
    expect(t.cacheRead).toBe(1_230_000)     // its tokens are kept
    l.record({ kind: 'turn', costUsd: 0.4, session: 's', fresh: true })
    l.close()
    // Opening it again is no longer a legacy ledger: new costs are kept.
    const again = new UsageLedger(path)
    expect(again.totals().costUsd).toBeCloseTo(0.402, 6)
    again.close(); rmSync(dir, { recursive: true, force: true })
  })

  test('the report names the instance, every window, and says what the dollars are', () => {
    const { l, dir } = fresh()
    const now = Date.UTC(2026, 10, 14, 12)
    l.record({ kind: 'turn', chat: '-100', thread: 7, inputTokens: 1_200_000, outputTokens: 50_000, costUsd: 4.5 }, now - 3 * DAY)
    l.record({ kind: 'task', chat: '-100', thread: 9, inputTokens: 20_000, costUsd: 0.1 }, now - 60_000)
    const r = usageReport(l, '@somebot', now)
    expect(r).toContain('@somebot — Claude usage across all topics')
    expect(r).toMatch(/today\s+1 run · 20k tokens · ~\$0\.10/)
    expect(r).toMatch(/7 days\s+2 runs · 1\.3M tokens · ~\$4\.60/)
    expect(r).toMatch(/all time\s+2 runs/)
    expect(r).toContain('(since 2026-11-11)')
    expect(r).toContain('by kind: turn 1.3M · task 20k')
    expect(r).toContain('by topic, all time:')
    expect(r).toContain('• -100:7 — 1 run · 1.3M tokens')
    expect(r).toContain('• -100:9 — 1 run · 20k tokens')
    expect(r).toContain('not a bill')
    expect(monthLine(l, now)).toBe('this month: 2 runs · 1.3M tokens · ~$4.60')
    l.close(); rmSync(dir, { recursive: true, force: true })
  })

  test('the topic list names each topic and, with what ran outside any topic, adds up to the total', () => {
    const { l, dir } = fresh()
    for (let i = 1; i <= 12; i++) l.record({ kind: 'turn', chat: '-100', thread: i, inputTokens: i * 1000 })
    l.record({ kind: 'judge', inputTokens: 500 })
    const r = usageReport(l, '@b', Date.now(), (_c, t) => `Topic ${t}`)
    expect(r).toContain('• Topic 12 — 1 run · 12k tokens') // biggest first, by name
    expect(r).not.toContain('• Topic 1 —')                  // past the first ten…
    expect(r).toContain('• 2 more topics — 2 runs · 3.0k tokens') // …summed: topics 1 and 2
    expect(r).toContain('• outside any topic (judges, recall, digests, voice) — 1 run · 500 tokens')
    l.close(); rmSync(dir, { recursive: true, force: true })
  })

  test('token counts read like a person would write them', () => {
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(1234)).toBe('1.2k')
    expect(fmtTokens(12_345)).toBe('12k')
    expect(fmtTokens(1_234_567)).toBe('1.2M')
    expect(fmtTokens(12_345_678)).toBe('12M')
  })
})
