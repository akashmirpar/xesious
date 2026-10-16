import { test, expect, describe } from 'bun:test'
import {
  parseWhen, nextAfter, firstDue, resolveDue, periodMs, graceMs, runsPerDay, slotRunId,
  parseLocalTime, zonedToUtc, isValidTz, cronError, latestAtOrBefore,
} from './schedule'
import type { Trigger } from './model'

const iso = (s: string) => new Date(s)
const BERLIN = 'Europe/Berlin'

describe('parseWhen: what Claude passes becomes a trigger, with the date arithmetic done here', () => {
  const now = iso('2026-10-16T14:40:00Z')

  test('in_minutes is from now', () => {
    expect(parseWhen({ in_minutes: 120 }, BERLIN, now).trigger).toEqual({ kind: 'at', at: '2026-10-16T16:40:00.000Z' })
  })

  test('at is wall time in the task zone, through daylight saving', () => {
    // 16 Oct is summer time in Berlin (UTC+2); 30 Oct is winter time (UTC+1).
    expect(parseWhen({ at: '2026-10-16 21:07' }, BERLIN, now).trigger).toEqual({ kind: 'at', at: '2026-10-16T19:07:00.000Z' })
    expect(parseWhen({ at: '2026-10-30T21:07' }, BERLIN, now).trigger).toEqual({ kind: 'at', at: '2026-10-30T20:07:00.000Z' })
  })

  test('at with an explicit offset is taken as is', () => {
    expect(parseWhen({ at: '2026-10-16T18:00:00Z' }, BERLIN, now).trigger).toEqual({ kind: 'at', at: '2026-10-16T18:00:00.000Z' })
  })

  test('exactly one of the four, a real zone, and not in the past', () => {
    expect(parseWhen({}, BERLIN, now).error).toContain('exactly one')
    expect(parseWhen({ in_minutes: 5, cron: '7 21 * * *' }, BERLIN, now).error).toContain('exactly one')
    expect(parseWhen({ in_minutes: 5 }, 'Mars/Olympus', now).error).toContain('time zone')
    expect(parseWhen({ at: '2026-10-16 10:00' }, BERLIN, now).error).toContain('already passed')
    expect(parseWhen({ at: 'tomorrow at nine' }, BERLIN, now).error).toContain("can't read")
  })

  test('every_minutes starts one interval from now unless a start is given', () => {
    expect(parseWhen({ every_minutes: 30 }, BERLIN, now).trigger).toEqual({ kind: 'every', everyMs: 1_800_000, anchor: '2026-10-16T15:10:00.000Z' })
    expect(parseWhen({ every_minutes: 30, start: '2026-10-16 17:00' }, BERLIN, now).trigger)
      .toEqual({ kind: 'every', everyMs: 1_800_000, anchor: '2026-10-16T15:00:00.000Z' })
    expect(parseWhen({ every_minutes: 0.5 }, BERLIN, now).error).toContain('at least 1')
  })

  test('cron is checked, five fields only', () => {
    expect(parseWhen({ cron: '7 9 * * 1-5' }, BERLIN, now).trigger).toEqual({ kind: 'cron', expr: '7 9 * * 1-5' })
    expect(parseWhen({ cron: '0 7 9 * * 1-5' }, BERLIN, now).error).toContain('five fields')
    expect(parseWhen({ cron: '99 9 * * *' }, BERLIN, now).error).toContain('not a valid')
    expect(cronError('0 0 30 2 *', BERLIN)).toContain('never fires')
  })

  test('zones', () => {
    expect(isValidTz('Asia/Tokyo')).toBe(true)
    expect(isValidTz('')).toBe(false)
    expect(zonedToUtc(2026, 3, 29, 1, 30, 0, BERLIN).toISOString()).toBe('2026-03-29T00:30:00.000Z')
    expect(parseLocalTime('2026-10-16T21:07+03:30', BERLIN)!.toISOString()).toBe('2026-10-16T17:37:00.000Z')
  })
})

describe('next slots', () => {
  test('a daily cron in Berlin follows the clocks going back', () => {
    const t: Trigger = { kind: 'cron', expr: '7 21 * * *' }
    expect(nextAfter(t, BERLIN, iso('2026-10-24T12:00:00Z'))!.toISOString()).toBe('2026-10-24T19:07:00.000Z')
    expect(nextAfter(t, BERLIN, iso('2026-10-24T19:07:00Z'))!.toISOString()).toBe('2026-10-25T20:07:00.000Z')
  })

  test('weekdays skip the weekend, and the gap between them is a day', () => {
    const t: Trigger = { kind: 'cron', expr: '7 9 * * 1-5' }
    expect(nextAfter(t, 'UTC', iso('2026-10-16T09:08:00Z'))!.toISOString()).toBe('2026-10-19T09:07:00.000Z')
    expect(periodMs(t, 'UTC', iso('2026-10-16T00:00:00Z'))).toBe(24 * 3600_000)
  })

  test('intervals step from their anchor; a slot due right now counts', () => {
    const t: Trigger = { kind: 'every', everyMs: 600_000, anchor: '2026-10-16T10:00:00.000Z' }
    expect(nextAfter(t, 'UTC', iso('2026-10-16T09:00:00Z'))!.toISOString()).toBe('2026-10-16T10:00:00.000Z')
    expect(nextAfter(t, 'UTC', iso('2026-10-16T10:00:00Z'))!.toISOString()).toBe('2026-10-16T10:10:00.000Z')
    expect(firstDue(t, 'UTC', iso('2026-10-16T10:10:00Z'))!.toISOString()).toBe('2026-10-16T10:10:00.000Z')
    expect(latestAtOrBefore(t, 'UTC', iso('2026-10-16T10:25:00Z'))!.toISOString()).toBe('2026-10-16T10:20:00.000Z')
  })

  test('a one-off has one slot', () => {
    const t: Trigger = { kind: 'at', at: '2026-10-16T16:40:00.000Z' }
    expect(nextAfter(t, 'UTC', iso('2026-10-16T16:00:00Z'))!.toISOString()).toBe('2026-10-16T16:40:00.000Z')
    expect(nextAfter(t, 'UTC', iso('2026-10-16T16:40:00Z'))).toBeUndefined()
  })
})

describe('resolveDue: what a slot that has come turns into', () => {
  const hourly: Trigger = { kind: 'cron', expr: '0 * * * *' }

  test('on time: run it, nothing missed', () => {
    const r = resolveDue(hourly, 'UTC', iso('2026-10-16T09:00:00Z'), iso('2026-10-16T09:00:05Z'))
    expect(r.fire!.toISOString()).toBe('2026-10-16T09:00:00.000Z')
    expect(r.missed).toBe(0)
    expect(r.next!.toISOString()).toBe('2026-10-16T10:00:00.000Z')
  })

  test('after an outage: the latest slot runs once if still in its window; the earlier ones are missed', () => {
    // Hourly: the window is half the period, 30 minutes.
    const r = resolveDue(hourly, 'UTC', iso('2026-10-16T09:00:00Z'), iso('2026-10-16T12:10:00Z'))
    expect(r.fire!.toISOString()).toBe('2026-10-16T12:00:00.000Z')
    expect(r.missed).toBe(3)
    expect(r.lateMs).toBe(10 * 60_000)
    expect(r.next!.toISOString()).toBe('2026-10-16T13:00:00.000Z')
  })

  test('past the window, nothing runs until the next slot', () => {
    const r = resolveDue(hourly, 'UTC', iso('2026-10-16T09:00:00Z'), iso('2026-10-16T12:45:00Z'))
    expect(r.fire).toBeUndefined()
    expect(r.missed).toBe(4)
    expect(r.next!.toISOString()).toBe('2026-10-16T13:00:00.000Z')
  })

  test('a reminder two hours late still goes out; thirteen hours late it is missed', () => {
    const t: Trigger = { kind: 'at', at: '2026-10-16T16:40:00.000Z' }
    expect(resolveDue(t, 'UTC', iso(t.at), iso('2026-10-16T18:40:00Z')).fire!.toISOString()).toBe(t.at)
    const late = resolveDue(t, 'UTC', iso(t.at), iso('2026-10-17T05:41:00Z'))
    expect(late.fire).toBeUndefined()
    expect(late.missed).toBe(1)
    expect(late.next).toBeUndefined()
  })

  test('the window is half the period, between 2 minutes and 2 hours', () => {
    expect(graceMs({ kind: 'every', everyMs: 60_000, anchor: '2026-01-01T00:00:00Z' }, 'UTC')).toBe(120_000)
    expect(graceMs({ kind: 'cron', expr: '0 * * * *' }, 'UTC')).toBe(30 * 60_000)
    expect(graceMs({ kind: 'cron', expr: '7 21 * * *' }, 'UTC')).toBe(2 * 3600_000)
    expect(graceMs({ kind: 'at', at: '2026-01-01T00:00:00Z' }, 'UTC')).toBe(12 * 3600_000)
  })
})

test('how often, for the card', () => {
  expect(runsPerDay({ kind: 'every', everyMs: 1_800_000, anchor: '2026-01-01T00:00:00Z' }, 'UTC')).toBe(48)
  const wk = runsPerDay({ kind: 'cron', expr: '7 9 * * 1-5' }, 'UTC', iso('2026-10-16T00:00:00Z'))!
  expect(wk * 7).toBeGreaterThan(4.5)
  expect(wk * 7).toBeLessThan(5.5)
  expect(runsPerDay({ kind: 'at', at: '2026-01-01T00:00:00Z' }, 'UTC')).toBeUndefined()
})

test('a run id names its slot, so one slot is one run', () => {
  expect(slotRunId('ab12cd', iso('2026-10-16T21:07:00Z'))).toBe('ab12cd@2026-10-16T21:07:00.000Z')
})
