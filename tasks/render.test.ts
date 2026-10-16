import { test, expect, describe } from 'bun:test'
import {
  cronText, scheduleText, durationText, frequencyText, cardHtml, listLine, runLine, markOf, usageText,
  tgTime, esc, elapsedText, historyHtml, digestMarkdown, watchedText, stepLine, stepsStrip,
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

describe('watchers on the card', () => {
  const w = (over: Partial<Task> = {}) => task({
    name: 'Price watch', trigger: { kind: 'watch', command: 'python3 watchers/price.py' },
    action: { kind: 'message', text: 'Below 300: {event}' }, nextDue: undefined, until: '2026-10-23T14:40:00.000Z', ...over,
  })
  const now = new Date('2026-10-16T12:00:00Z')

  test('label, what it does, its command, and that it is running', () => {
    const html = cardHtml(w({ eventsSeen: 1234, lastEventAt: '2026-10-16T11:59:00.000Z' }), [], now, { running: true, since: '2026-10-16T10:00:00.000Z' })
    expect(html).toContain('👀 Watch: <b>Price watch</b>')
    expect(html).toContain('watches continuously · sends a message when it sees something · 🔔 loud')
    expect(html).not.toContain('(Europe/Berlin)')
    expect(html).toContain('<code>python3 watchers/price.py</code>')
    expect(html).toContain('👀 running since Fri 16 Oct, 12:00 · 1,234 lines, the last Fri 16 Oct, 13:59')
    expect(html).toContain('Ends <tg-time')
  })

  test('failing: what went wrong, and when it starts again', () => {
    const html = cardHtml(w({ watchError: 'it ended with status 1: refused', watchRetryAt: '2026-10-16T12:05:00.000Z' }), [], now, { running: false })
    expect(html).toContain('⚠️ it ended with status 1: refused · starts again <tg-time')
  })

  test('polled, with a Claude run: when it looks next, and the cap on runs', () => {
    const html = cardHtml(w({
      trigger: { kind: 'watch', command: 'python3 page.py', everyMs: 600_000, anchor: '2026-10-16T11:50:00.000Z' }, nextDue: '2026-10-16T12:10:00.000Z',
      action: { kind: 'claude', prompt: 'Say what changed', session: 'fresh' }, says: 'noteworthy',
    }), [], now)
    expect(html).toContain('checks every 10 minutes · Claude, a fresh session each run, when it sees something · posts only when something is worth telling')
    expect(html).toContain('at most 6 runs an hour, 5 min apart')
    expect(html).toContain('Next check: <tg-time')
  })

  test('kept running for its own sake; in /tasks; event runs in history', () => {
    expect(cardHtml(w({ action: { kind: 'none' }, says: 'problems' }), [], now, { running: true })).toContain('keeps it running; says something only if it fails')
    expect(listLine(w(), [])).toContain('· 👀 <b>Price watch</b> — watches continuously')
    const r = { id: 'x@e', task: 'x', trigger: 'event', state: 'succeeded', startedAt: '2026-10-16T12:00:00.000Z', postedMsg: 9, folded: 3 } as Run
    expect(runLine(r, 'UTC')).toContain('3 events')
  })
})

test('the card says what a watcher lets through: its rule, and its AI filter with what it let through', () => {
  const t = task({
    name: 'Outage feed', trigger: { kind: 'watch', command: 'python3 feed.py' }, nextDue: undefined,
    rule: { op: 'contains', words: ['outage', 'degraded'] }, ai: { question: 'Is a major outage starting?', everyMs: 300_000 },
    filterSeen: 340, filterPassed: 12, filterError: 'the AI filter did not answer; it asks again at its next batch',
  })
  const html = cardHtml(t, [], new Date('2026-10-16T12:00:00Z'), { running: true })
  expect(html).toContain('Only when it mentions “outage”, “degraded”')
  expect(html).toContain('AI filter every 5 minutes: “Is a major outage starting?” · 340 considered, 12 let through')
  expect(html).toContain('⚠️ the AI filter did not answer')
})

describe('what tasks did', () => {
  const since = new Date('2026-10-16T00:00:00Z')
  const news = task({ id: 'n1', name: 'Nightly news', tz: 'UTC' })
  const watch = task({ id: 'w1', name: 'Price watch', tz: 'UTC', trigger: { kind: 'watch', command: 'x' }, eventsSeen: 1204 })
  const backup = task({ id: 'b1', name: 'Backup', tz: 'UTC', failStreak: 2, action: { kind: 'script', command: 'bash backup.sh' } })
  const r = (over: Partial<Run>): Run => ({ id: Math.random().toString(36), task: 'x', trigger: 'schedule', state: 'succeeded', startedAt: '2026-10-16T21:07:00.000Z', endedAt: '2026-10-16T21:09:00.000Z', ...over })
  const entries = [
    { task: news, runs: [r({ postedMsg: 4, summary: 'Five stories today' })] },
    { task: watch, runs: [r({ trigger: 'event', postedMsg: 9, summary: 'price went below 300: 299' }), r({ trigger: 'event' })] },
    { task: backup, runs: [r({ state: 'failed', reason: 'it exited with status 2: rsync: connection refused' })] },
  ]

  test('a digest: one line a task, its runs by mark, and what the last said or why it failed', () => {
    const md = digestMarkdown(entries, since, 'UTC')
    expect(md.split('\n')).toEqual([
      '**Since Fri 16 Oct, 00:00**',
      '- **Nightly news** (⏰ every day at 21:07): 1 run ✅ · “Five stories today”',
      '- **Price watch** (👀 watches continuously): 1,204 lines seen in all · 2 runs 🔇✅ · “price went below 300: 299”',
      '- **Backup** (⏰ every day at 21:07): 1 run ❌ · last failed: it exited with status 2: rsync: connection refused',
    ])
    expect(digestMarkdown([], since, 'UTC')).toContain('No tasks to report on.')
  })

  test("a watchdog's material: every run since, plainly, with each task's health", () => {
    const text = watchedText(entries, since, 'UTC')
    expect(text).toContain('- Backup (id b1; every day at 21:07; active; 2 failure(s) in a row):')
    expect(text).toContain('    Fri 16 Oct, 21:07 failed, 2 min: it exited with status 2: rsync: connection refused')
    expect(text).toContain('- Price watch (id w1; watches continuously; active; watcher: fine, 1,204 lines seen):')
  })
})

test('a plan on its card, and how its run went', () => {
  expect(stepLine({ name: 'tests', kind: 'script', command: 'x', onFail: 5, retries: 1 }, 3)).toBe('3. tests (command) · fails → step 5, 1 retry')
  expect(stepLine({ name: 'post', kind: 'handoff', thread: 9, topicName: 'Posting' }, 4)).toBe('4. post (hand-off) · to Posting')
  const r = (step: number, name: string, ok: boolean, attempt = 1) => ({ step, name, ok, attempt, startedAt: '' })
  expect(stepsStrip([r(1, 'fetch', true), r(2, 'tests', false), r(2, 'tests', true, 2)], { step: 3, name: 'push' })).toBe('✅ fetch · ✅ tests ×2 · ⏳ push')
  const card = cardHtml(task({ action: { kind: 'steps', steps: [{ name: 'fetch', kind: 'script', command: 'f' }, { name: 'fix', kind: 'codex', prompt: 'p' }] } }), [])
  expect(card).toContain('🪜 Plan: <b>Nightly &lt;news&gt;</b>')
  expect(card).toContain('runs a plan of 2 steps')
  expect(card).toContain('1. fetch (command)\n2. fix (Codex)')
})

test('how a task links to the rest, in a list line', () => {
  const t = task({ name: 'Translate', trigger: { kind: 'after', task: 'r1', name: 'Report', on: 'success' }, nextDue: undefined, then: { thread: 9, topicName: 'Posting' }, parent: 'p1', parentName: 'Research' })
  expect(listLine(t, [])).toBe('· ↪️ <b>Translate</b> — after “Report” works · then → Posting · made by Research')
})
