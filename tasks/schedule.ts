/**
 * schedule.ts — when tasks are due, as pure functions of a trigger, a time zone and
 * the time now. The store owns the due times; nothing here keeps state, so restarts
 * and missed slots are decided the same way whether the bot was down for a minute or
 * a week.
 *
 * croner is used only as a calculator (paused, never started): it knows time zones
 * and daylight saving, which a hand-written cron reader would get wrong.
 */
import { Cron } from 'croner'
import { LIMITS, type Trigger } from './model'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export function isValidTz(tz: string): boolean {
  if (!tz) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

const cronOf = (expr: string, tz: string) => new Cron(expr, { timezone: tz, paused: true, mode: '5-part' })

export function cronError(expr: string, tz: string): string | undefined {
  if (expr.trim().split(/\s+/).length !== 5) return 'a cron expression has five fields: minute hour day-of-month month day-of-week'
  try {
    if (!cronOf(expr, tz).nextRun()) return 'that cron expression never fires'
  } catch (e) {
    return `not a valid cron expression (${(e as Error).message})`
  }
  return undefined
}

// The first slot strictly after `after`.
export function nextAfter(t: Trigger, tz: string, after: Date): Date | undefined {
  switch (t.kind) {
    case 'at': {
      const at = new Date(t.at)
      return at.getTime() > after.getTime() ? at : undefined
    }
    case 'every': {
      const a = new Date(t.anchor).getTime()
      if (after.getTime() < a) return new Date(a)
      const k = Math.floor((after.getTime() - a) / t.everyMs) + 1
      return new Date(a + k * t.everyMs)
    }
    case 'cron':
      return cronOf(t.expr, tz).nextRun(after) ?? undefined
  }
}

// The latest slot at or before `at`, if any.
export function latestAtOrBefore(t: Trigger, tz: string, at: Date): Date | undefined {
  switch (t.kind) {
    case 'at': {
      const d = new Date(t.at)
      return d.getTime() <= at.getTime() ? d : undefined
    }
    case 'every': {
      const a = new Date(t.anchor).getTime()
      if (at.getTime() < a) return undefined
      return new Date(a + Math.floor((at.getTime() - a) / t.everyMs) * t.everyMs)
    }
    case 'cron': {
      // croner works in whole seconds and drops the milliseconds of its reference, so
      // "before at + 1 ms" would mean "before at" and miss a slot due this very second.
      // Look a second ahead, then keep only a slot that is not after `at`.
      const prev = cronOf(t.expr, tz).previousRuns(1, new Date(at.getTime() + 1000))[0]
      return prev && prev.getTime() <= at.getTime() ? prev : cronOf(t.expr, tz).previousRuns(1, at)[0]
    }
  }
}

// The first slot from now on: a slot due this very moment counts.
export const firstDue = (t: Trigger, tz: string, now: Date) => nextAfter(t, tz, new Date(now.getTime() - 1))

// The shortest gap between slots, for the grace window and "runs N times a day";
// undefined for a one-off. Weekdays-at-nine is a day, not the weekend's three.
export function periodMs(t: Trigger, tz: string, now = new Date()): number | undefined {
  if (t.kind === 'at') return undefined
  if (t.kind === 'every') return t.everyMs
  const runs = cronOf(t.expr, tz).nextRuns(6, now)
  let min = Infinity
  for (let i = 1; i < runs.length; i++) min = Math.min(min, runs[i].getTime() - runs[i - 1].getTime())
  return Number.isFinite(min) ? min : undefined
}

// How late a slot may still start. A reminder two hours late is still worth sending;
// a check that runs every five minutes is not worth running for a slot from an hour ago.
export function graceMs(t: Trigger, tz: string, now = new Date()): number {
  const p = periodMs(t, tz, now)
  if (p === undefined) return LIMITS.oneOffGraceMs
  return Math.min(LIMITS.graceMaxMs, Math.max(LIMITS.graceMinMs, p / 2))
}

export interface Resolution {
  fire?: Date         // the slot to run now (the latest one that has come)
  lateMs: number      // how late that is
  missed: number      // slots that came and will never run
  next?: Date         // the next slot after this one
}

// A task's due slot has come (due ≤ now). Run the latest slot that has come if it is
// still within its grace window, and count every earlier one as missed: after a long
// outage a task runs once, never a backlog of runs.
export function resolveDue(t: Trigger, tz: string, due: Date, now: Date): Resolution {
  let latest = latestAtOrBefore(t, tz, now)
  if (!latest || latest.getTime() < due.getTime()) latest = due
  const missed = t.kind === 'at' ? 0 : countBetween(t, tz, due, latest)
  const lateMs = Math.max(0, now.getTime() - latest.getTime())
  const after = nextAfter(t, tz, latest)
  const next = after && after.getTime() > now.getTime() ? after : nextAfter(t, tz, now)
  if (lateMs <= graceMs(t, tz, now)) return { fire: latest, lateMs, missed, next }
  return { lateMs, missed: missed + 1, next }
}

// Slots in [from, to): the ones before the latest. Arithmetic for intervals; for cron
// a walk, capped, since a minutely cron missed for a month is 43k slots.
function countBetween(t: Trigger, tz: string, from: Date, to: Date): number {
  if (to.getTime() <= from.getTime()) return 0
  if (t.kind === 'every') return Math.round((to.getTime() - from.getTime()) / t.everyMs)
  let n = 0
  let cur: Date | undefined = from
  while (cur && cur.getTime() < to.getTime() && n < 100_000) {
    n++
    cur = nextAfter(t, tz, cur)
  }
  return n
}

export const slotRunId = (taskId: string, slot: Date) => `${taskId}@${slot.toISOString()}`
export const manualRunId = (taskId: string, now: Date) => `${taskId}@manual-${now.getTime().toString(36)}`

// About how often a task runs, for the card ("Claude, about 5 runs a week").
export function runsPerDay(t: Trigger, tz: string, now = new Date()): number | undefined {
  if (t.kind === 'at') return undefined
  if (t.kind === 'every') return DAY / t.everyMs
  const runs = cronOf(t.expr, tz).nextRuns(60, now)
  if (runs.length < 2) return undefined
  const span = runs[runs.length - 1].getTime() - runs[0].getTime()
  return span > 0 ? ((runs.length - 1) * DAY) / span : undefined
}

// ---------------------------------------------------------------------------
// Turning what Claude passes to task_create into a trigger. Claude says what the
// person said in fields ("in_minutes": 120, "at": "2026-10-16 21:07", "cron": "7 21 * * *")
// and the bridge does the date arithmetic: models are unreliable at it, and a
// reminder an hour off because of daylight saving is the bug people remember.
// ---------------------------------------------------------------------------

export interface WhenInput {
  at?: string              // local wall time in tz ("2026-10-16 21:07"), or ISO with Z/offset
  in_minutes?: number
  every_minutes?: number
  start?: string           // for every_minutes: the first run, local wall time (default: one interval from now)
  cron?: string
}

export function parseWhen(w: WhenInput, tz: string, now: Date): { trigger?: Trigger; error?: string } {
  const given = (['at', 'in_minutes', 'every_minutes', 'cron'] as const).filter(k => w[k] !== undefined && w[k] !== null && w[k] !== '')
  if (given.length !== 1) return { error: 'give exactly one of: at, in_minutes, every_minutes, cron' }
  if (!isValidTz(tz)) return { error: `unknown time zone "${tz}"; use an IANA name such as Europe/Berlin` }
  if (w.in_minutes !== undefined) {
    const m = Number(w.in_minutes)
    if (!(m > 0) || m > 366 * 24 * 60) return { error: 'in_minutes must be between 1 minute and a year' }
    return { trigger: { kind: 'at', at: new Date(now.getTime() + m * MIN).toISOString() } }
  }
  if (w.at !== undefined) {
    const at = parseLocalTime(String(w.at), tz)
    if (!at) return { error: `can't read the time "${w.at}"; use "YYYY-MM-DD HH:MM" in the task's time zone` }
    if (at.getTime() < now.getTime() - MIN) return { error: `${String(w.at)} (${tz}) has already passed` }
    if (at.getTime() > now.getTime() + 2 * 366 * DAY) return { error: 'that is more than two years away' }
    return { trigger: { kind: 'at', at: at.toISOString() } }
  }
  if (w.every_minutes !== undefined) {
    const m = Number(w.every_minutes)
    if (!(m * MIN >= LIMITS.minEveryMs)) return { error: 'every_minutes must be at least 1' }
    let anchor = new Date(now.getTime() + m * MIN)
    if (w.start) {
      const s = parseLocalTime(String(w.start), tz)
      if (!s) return { error: `can't read the start time "${w.start}"` }
      anchor = s
    }
    return { trigger: { kind: 'every', everyMs: Math.round(m * MIN), anchor: anchor.toISOString() } }
  }
  const expr = String(w.cron).trim()
  const err = cronError(expr, tz)
  if (err) return { error: err }
  return { trigger: { kind: 'cron', expr } }
}

// "2026-10-16 21:07", "2026-10-16T21:07[:ss]" read in tz; or an ISO time with Z or an offset.
export function parseLocalTime(s: string, tz: string): Date | undefined {
  const t = s.trim()
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(t)) {
    const d = new Date(t)
    return Number.isNaN(d.getTime()) ? undefined : d
  }
  const m = t.match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d?):(\d\d)(?::(\d\d))?$/)
  if (!m) return undefined
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number)
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return undefined
  return zonedToUtc(y, mo, d, h, mi, se, tz)
}

// Wall time in tz → the instant. Two passes, because the offset at the guessed
// instant can differ from the offset at the answer across a daylight-saving change.
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s)
  const off1 = offsetMs(wall, tz)
  let utc = wall - off1
  const off2 = offsetMs(utc, tz)
  if (off2 !== off1) utc = wall - off2
  return new Date(utc)
}

// The zone's offset from UTC at an instant, east positive.
export function offsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - Math.floor(utcMs / 1000) * 1000
}
