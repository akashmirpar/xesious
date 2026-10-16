import { test, expect, describe } from 'bun:test'
import {
  cronText, scheduleText, durationText, frequencyText, cardHtml, listLine, runLine, markOf, usageText,
  tgTime, esc, elapsedText, historyHtml,
} from './render'
import type { Run, Task } from './model'

const task = (over: Partial<Task> = {}): Task => ({
  id: 'ab12cd', chat: '-100777', thread: 5, name: 'Nightly <news>', tz: 'Europe/Berlin',
  trigger: { kind: 'cron', expr: '7 21 * * *' },
  action: { kind: 'claude', prompt: 'Summarize', session: 'fresh' },
  says: 'result', sound: 'loud', where: 'home', owner: '1', createdBy: 'person:1',
  createdAt: '2026-10-16T10:00:00.000Z', updatedAt: '2026-10-16T10:00:00.000Z',
  state: 'active', nextDue: '2026-10-16T19:07:00.000Z', runsDone: 0, failStreak: 0, ...over,
})

describe('schedules in words', () => {
  test('the common cron shapes, and the expression itself for the rest', () => {
    expect(cronText('7 21 * * *')).toBe('every day at 21:07')
    expect(cronText('7 9 * * 1-5')).toBe('weekdays at 09:07')
    expect(cronText('0 10 * * 6,0')).toBe('weekends at 10:00')
    expect(cronText('7 9 * * 1')).toBe('every Monday at 09:07')
    expect(cronText('0 9 1 * *')).toBe('on day 1 of each month at 09:00')
    expect(cronText('*/15 * * * *')).toBe('every 15 minutes')
    expect(cronText('5 * * * *')).toBe('every hour at :05')
    expect(cronText('0 9 1-7 * 1')).toBe('cron 0 9 1-7 * 1')
  })

  test('one-offs and intervals', () => {
    expect(scheduleText({ kind: 'at', at: '2026-10-16T14:40:00.000Z' }, 'Europe/Berlin')).toBe('once, Fri 16 Oct, 16:40')
    expect(durationText(30 * 60_000)).toBe('30 minutes')
    expect(durationText(2 * 3600_000)).toBe('2 hours')
    expect(durationText(24 * 3600_000)).toBe('day')
    expect(elapsedText(125_000)).toBe('2 min')
    expect(elapsedText(3_780_000)).toBe('1 h 3 min')
  })

  test('how often a Claude task runs is said plainly', () => {
    expect(frequencyText(task({ trigger: { kind: 'every', everyMs: 1_800_000, anchor: '2026-01-01T00:00:00Z' } }))).toBe('about 48 runs a day')
    expect(frequencyText(task({ trigger: { kind: 'cron', expr: '7 9 * * 1-5' } }), new Date('2026-10-16T00:00:00Z'))).toBe('about 5 runs a week')
    expect(frequencyText(task({ trigger: { kind: 'at', at: '2026-10-16T14:40:00.000Z' } }))).toBeUndefined()
  })
})

test('times are <tg-time>, with the written time in the task zone for older apps', () => {
  expect(tgTime(new Date('2026-10-16T19:07:00Z'), 'Europe/Berlin')).toBe('<tg-time unix="1792177620" format="wdt">Fri 16 Oct, 21:07</tg-time>')
  expect(esc('a<b & c>')).toBe('a&lt;b &amp; c&gt;')
})

describe('the card', () => {
  test('active: kind, name escaped, schedule with its zone, what it does, sound, frequency and the next run', () => {
    const html = cardHtml(task(), [], new Date('2026-10-16T10:00:00Z'))
    expect(html).toContain('⏰ Scheduled: <b>Nightly &lt;news&gt;</b>')
    expect(html).toContain('every day at 21:07 <i>(Europe/Berlin)</i>')
    expect(html).toContain('Claude, a fresh session each run · posts the result')
    expect(html).toContain('🔔 loud')
    expect(html).toContain('about 1 run a day')
    expect(html).toContain('Next: <tg-time unix="1792177620" format="wdt">')
  })

  test('a reminder shows its message; a paused task says why; the strip shows the last runs', () => {
    const r = task({ action: { kind: 'message', text: 'Take your medicine' }, trigger: { kind: 'at', at: '2026-10-16T14:40:00.000Z' } })
    expect(cardHtml(r, [])).toContain('🔔 Reminder')
    expect(cardHtml(r, [])).toContain('“Take your medicine”')
    const p = task({ state: 'paused', pauseReason: 'failures' })
    const runs: Run[] = [
      { id: 'x@2', task: 'x', trigger: 'schedule', state: 'failed', startedAt: '2026-10-15T19:07:00.000Z', reason: 'boom' },
      { id: 'x@1', task: 'x', trigger: 'schedule', state: 'succeeded', startedAt: '2026-10-14T19:07:00.000Z' },
    ]
    const html = cardHtml(p, runs)
    expect(html).toContain('⏸ paused after failing several times in a row')
    expect(html).not.toContain('Next:')
    expect(html).toContain('🔇❌')
  })

  test('a run in progress says so, and "last" is the last run that ended', () => {
    const runs: Run[] = [
      { id: 'x@3', task: 'x', trigger: 'manual', state: 'running', startedAt: '2026-10-16T12:00:00.000Z' },
      { id: 'x@2', task: 'x', trigger: 'schedule', state: 'succeeded', startedAt: '2026-10-15T19:07:00.000Z', postedMsg: 4 },
    ]
    const html = cardHtml(task(), runs, new Date('2026-10-16T12:01:00Z'))
    expect(html).toContain('⏳ running since Fri 16 Oct, 14:00')
    expect(html).toContain('last: ✅ Thu 15 Oct, 21:07')
  })
})

describe('runs', () => {
  test('marks', () => {
    const r = (over: Partial<Run>): Run => ({ id: 'x@1', task: 'x', trigger: 'schedule', state: 'succeeded', ...over })
    expect(markOf(r({ postedMsg: 9 }))).toBe('posted')
    expect(markOf(r({}))).toBe('quiet')
    expect(markOf(r({ outcome: 'blocked' }))).toBe('blocked')
    expect(markOf(r({ state: 'timed_out' }))).toBe('failed')
    expect(markOf(r({ state: 'deferred' }))).toBe('deferred')
    expect(markOf(r({ state: 'running' }))).toBe('running')
  })

  test('usage reads short', () => {
    expect(usageText({ model: 'claude-sonnet-5-20260101', inputTokens: 15_000, outputTokens: 2_400, costUsd: 0.041 })).toBe('sonnet-5 · 17k tokens · ~$0.04')
    expect(usageText({ inputTokens: 500, costUsd: 0.002 })).toBe('500 tokens · ~$0.002')
    expect(usageText(undefined)).toBe('')
  })

  test('a history line has the time, how long, usage and what happened', () => {
    const line = runLine({
      id: 'x@1', task: 'x', trigger: 'catchup', state: 'succeeded', startedAt: '2026-10-16T19:07:00.000Z',
      endedAt: '2026-10-16T19:09:10.000Z', postedMsg: 4, summary: 'Five stories', usage: { model: 'sonnet', inputTokens: 900, costUsd: 0.01 },
    }, 'Europe/Berlin')
    expect(line).toBe('✅ · Fri 16 Oct, 21:07 · caught up · 2 min · sonnet · 900 tokens · ~$0.01 · Five stories')
    expect(runLine({ id: 'x@2', task: 'x', trigger: 'schedule', state: 'skipped', slot: '2026-10-16T19:07:00.000Z', reason: 'still running' }, 'UTC'))
      .toContain('⏭ · Fri 16 Oct, 19:07 · still running')
    expect(historyHtml(task(), [])).toContain('no runs yet')
  })

  test('a /tasks line', () => {
    expect(listLine(task(), [])).toContain('· ⏰ <b>Nightly &lt;news&gt;</b> — every day at 21:07 · next <tg-time')
    expect(listLine(task({ state: 'paused' }), [])).toContain('⏸ ⏰')
  })
})
