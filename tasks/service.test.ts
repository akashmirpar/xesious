import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from './store'
import { TaskService, type ServiceDeps } from './service'
import type { Scope } from './api'
import type { Task } from './model'

let dir: string
let store: TaskStore
let svc: TaskService
let now = new Date('2026-10-16T14:40:00Z')
let changes: [string, string][]
let manageBlock: string | undefined
let createBlock: string | undefined

const person: Scope = { kind: 'run', chat: '-100777', thread: 5, person: '1', personName: 'Sara', runKind: 'interactive' }
const inDm: Scope = { kind: 'run', chat: '1', person: '1', runKind: 'interactive' }
const operator: Scope = { kind: 'operator' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xesious-svc-'))
  store = new TaskStore(join(dir, 'tasks.db'))
  now = new Date('2026-10-16T14:40:00Z')
  changes = []
  manageBlock = undefined
  createBlock = undefined
  const deps: ServiceDeps = {
    store, now: () => now,
    mayCreate: () => createBlock,
    mayManage: () => manageBlock,
    isGroup: chat => chat.startsWith('-'),
    changed: (t: Task, what) => { changes.push([t.id, what]) },
    runNow: (t: Task) => (t.name === 'busy' ? { error: 'it is already running' } : { runId: `${t.id}@manual-1` }),
  }
  svc = new TaskService(deps)
})
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

const create = (input: any, scope: Scope = person) => {
  const r = svc.create(scope, { tz: 'Europe/Berlin', ...input })
  if (!r.ok) throw new Error(r.error)
  return r.value.task
}

describe('creating', () => {
  test('a reminder: due when asked, loud, named after its message', () => {
    const t = create({ message: 'Take your medicine', in_minutes: 120 })
    expect(t.nextDue).toBe('2026-10-16T16:40:00.000Z')
    expect(t.action).toEqual({ kind: 'message', text: 'Take your medicine' })
    expect(t.sound).toBe('loud')
    expect(t.name).toBe('Take your medicine')
    expect(t.owner).toBe('1')
    expect(t.ownerName).toBe('Sara')
    expect(t.createdBy).toBe('person:1')
    expect(t.thread).toBe(5)
    expect(changes).toEqual([[t.id, 'created']])
  })

  test('a Claude task: fresh session, says result; silent in a group, loud in a DM; noteworthy is loud', () => {
    const g = create({ name: 'Nightly news', prompt: 'Summarize the news', cron: '7 21 * * *' })
    expect(g.action).toEqual({ kind: 'claude', prompt: 'Summarize the news', session: 'fresh' })
    expect(g.says).toBe('result')
    expect(g.sound).toBe('silent')
    expect(g.nextDue).toBe('2026-10-16T19:07:00.000Z')
    expect(create({ prompt: 'Summarize the news', cron: '7 21 * * *' }, inDm).sound).toBe('loud')
    expect(create({ prompt: 'Check the status page', every_minutes: 60, says: 'noteworthy' }).sound).toBe('loud')
  })

  test('the zone is required and must be real; a message or a prompt, not both', () => {
    const r1 = svc.create(person, { message: 'x', in_minutes: 5 } as any)
    expect(r1.ok ? '' : r1.error).toContain('tz is required')
    const r2 = svc.create(person, { tz: 'Mars/Olympus', message: 'x', in_minutes: 5 })
    expect(r2.ok ? '' : r2.error).toContain('unknown time zone')
    const r3 = svc.create(person, { tz: 'UTC', message: 'x', prompt: 'y', in_minutes: 5 })
    expect(r3.ok ? '' : r3.error).toContain('give one of message')
    const r4 = svc.create(person, { tz: 'UTC', in_minutes: 5 })
    expect(r4.ok ? '' : r4.error).toContain('give message')
  })

  test('asking twice returns the first task', () => {
    const a = create({ prompt: 'Summarize the news', cron: '7 21 * * *' })
    const r = svc.create(person, { tz: 'Europe/Berlin', prompt: 'summarize the news', cron: '7 21 * * *' })
    expect(r.ok && r.value.duplicate).toBe(true)
    expect(r.ok && r.value.task.id).toBe(a.id)
    expect(changes.length).toBe(1)
  })

  test('at most 20 tasks in a topic', () => {
    for (let i = 0; i < 20; i++) create({ message: `m${i}`, in_minutes: 10 + i })
    const r = svc.create(person, { tz: 'UTC', message: 'one more', in_minutes: 99 })
    expect(r.ok ? 0 : r.status).toBe(409)
  })

  test('who may create is the bridge\'s call; a scheduled run cannot create', () => {
    createBlock = 'only admins create tasks in this group'
    const r = svc.create(person, { tz: 'UTC', message: 'x', in_minutes: 5 })
    expect(r.ok ? '' : r.error).toBe('only admins create tasks in this group')
    createBlock = undefined
    const s = svc.create({ ...person, runKind: 'scheduled', taskId: 'x', runId: 'x@1' }, { tz: 'UTC', message: 'x', in_minutes: 5 })
    expect(s.ok ? 0 : s.status).toBe(403)
    expect(svc.create(operator, { tz: 'UTC', message: 'x', in_minutes: 5 }).ok).toBe(false)
  })
})

describe('changing', () => {
  test('a new schedule replaces the old one; a rename keeps the next slot', () => {
    const t = create({ prompt: 'p', cron: '7 21 * * *' })
    const renamed = svc.update(person, t.id, { name: 'Evening news' })
    expect(renamed.ok && renamed.value.task.nextDue).toBe(t.nextDue)
    const moved = svc.update(person, t.id, { cron: '7 22 * * *' })
    expect(moved.ok && moved.value.task.nextDue).toBe('2026-10-16T20:07:00.000Z')
    expect(changes.map(c => c[1])).toEqual(['created', 'updated', 'updated'])
  })

  test('a reminder that already went out can still be renamed', () => {
    const t = create({ message: 'm', in_minutes: 5 })
    store.updateTask(t.id, { state: 'done', nextDue: undefined })
    now = new Date('2026-10-17T10:00:00Z')
    expect(svc.update(person, t.id, { name: 'renamed' }).ok).toBe(true)
    const again = svc.update(person, t.id, { in_minutes: 30 })
    expect(again.ok && again.value.task.state).toBe('active')
  })

  test('pause, then resume from now: what it missed while paused is not owed', () => {
    const t = create({ prompt: 'p', every_minutes: 60 })
    const p = svc.pause(person, t.id)
    expect(p.ok && p.value.task.state).toBe('paused')
    expect(p.ok && p.value.task.nextDue).toBeUndefined()
    expect(svc.pause(person, t.id).ok).toBe(false)
    now = new Date('2026-10-17T09:00:00Z')
    const r = svc.resume(person, t.id)
    expect(r.ok && r.value.task.state).toBe('active')
    expect(r.ok && new Date(r.value.task.nextDue!).getTime()).toBeGreaterThan(now.getTime())
  })

  test('a one-off whose time passed while paused needs a new time', () => {
    const t = create({ message: 'm', in_minutes: 5 })
    svc.pause(person, t.id)
    now = new Date('2026-10-16T16:00:00Z')
    const r = svc.resume(person, t.id)
    expect(r.ok ? '' : r.error).toContain('new time')
  })

  test('delete; the task is gone from the run\'s view', () => {
    const t = create({ message: 'm', in_minutes: 5 })
    expect(svc.remove(person, t.id).ok).toBe(true)
    expect(svc.get(person, t.id).ok).toBe(false)
  })

  test('who may change it is the bridge\'s call', () => {
    const t = create({ message: 'm', in_minutes: 5 })
    manageBlock = 'only its owner or an admin can delete it'
    const r = svc.remove(person, t.id)
    expect(r.ok ? '' : r.error).toBe('only its owner or an admin can delete it')
  })

  test('another chat\'s task is invisible to a run', () => {
    const t = create({ message: 'm', in_minutes: 5 })
    const other: Scope = { kind: 'run', chat: '-100888', person: '1', runKind: 'interactive' }
    expect(svc.get(other, t.id).ok).toBe(false)
    expect(svc.pause(other, t.id).ok).toBe(false)
    expect(svc.get(operator, t.id).ok).toBe(true)
  })

  test('run now goes to the bridge; its refusal comes back', async () => {
    const t = create({ prompt: 'p', cron: '7 21 * * *' })
    const r = await svc.runNow(person, t.id)
    expect(r.ok && r.value.runId).toBe(`${t.id}@manual-1`)
    const b = create({ name: 'busy', prompt: 'q', cron: '7 22 * * *' })
    const r2 = await svc.runNow(person, b.id)
    expect(r2.ok ? '' : r2.error).toBe('it is already running')
  })
})

describe('a scheduled run', () => {
  const setup = () => {
    const t = create({ prompt: 'p', cron: '7 21 * * *', says: 'noteworthy' })
    store.insertRun({ id: `${t.id}@s1`, task: t.id, trigger: 'schedule', state: 'running' })
    const scope: Scope = { kind: 'run', chat: '-100777', thread: 5, person: '1', runKind: 'scheduled', taskId: t.id, runId: `${t.id}@s1` }
    return { t, scope }
  }

  test('sees only its own task', () => {
    const { t, scope } = setup()
    const other = create({ prompt: 'q', cron: '7 22 * * *' })
    expect(svc.get(scope, 'self').ok).toBe(true)
    expect(svc.get(scope, t.id).ok).toBe(true)
    expect(svc.get(scope, other.id).ok).toBe(false)
    expect(svc.list(scope, 'chat').ok && (svc.list(scope, 'chat') as any).value.map((v: any) => v.id)).toEqual([t.id])
    expect(svc.update(scope, 'self', { name: 'x' }).ok).toBe(false)
  })

  test('reports once, with a valid outcome and a summary', () => {
    const { t, scope } = setup()
    expect(svc.report(scope, { outcome: 'great', notify: true, summary: 's' }).ok).toBe(false)
    expect(svc.report(scope, { outcome: 'nothing_new', notify: false, summary: '' }).ok).toBe(false)
    expect(svc.report(scope, { outcome: 'nothing_new', notify: false, summary: 'All quiet' }).ok).toBe(true)
    expect(store.getRun(`${t.id}@s1`)).toMatchObject({ outcome: 'nothing_new', notify: false, summary: 'All quiet' })
    expect(svc.report(scope, { outcome: 'done', notify: true, summary: 'again' }).ok).toBe(false)
    expect(svc.report(person, { outcome: 'done', notify: true, summary: 'x' }).ok).toBe(false)
  })

  test('can pause or finish its task, not resume, delete or run it', async () => {
    const { t, scope } = setup()
    expect(svc.remove(scope, 'self').ok).toBe(false)
    expect((await svc.runNow(scope, 'self')).ok).toBe(false)
    const d = svc.done(scope)
    expect(d.ok && d.value.task.state).toBe('done')
    expect(d.ok && d.value.task.nextDue).toBeUndefined()
    expect(svc.done(person).ok).toBe(false)
    expect(changes.at(-1)).toEqual([t.id, 'done'])
  })
})

test('lists: this topic by default from a topic, the chat on request; the operator sees all', () => {
  const a = create({ message: 'a', in_minutes: 5 })
  const b = create({ message: 'b', in_minutes: 6 }, { ...person, thread: 9 })
  const c = create({ message: 'c', in_minutes: 7 }, inDm)
  const ids = (r: any) => r.value.map((v: any) => v.id)
  expect(ids(svc.list(person, undefined))).toEqual([a.id])
  expect(ids(svc.list(person, 'chat'))).toEqual([a.id, b.id])
  expect(ids(svc.list(operator, undefined))).toEqual([a.id, b.id, c.id])
  expect(ids(svc.list(operator, undefined, '1'))).toEqual([c.id])
  const v = (svc.list(person, undefined) as any).value[0]
  expect(v).toMatchObject({ kind: 'reminder', message: 'a', schedule: 'once, Fri 16 Oct, 16:45', next_run: 'Fri 16 Oct, 16:45 (Europe/Berlin)', state: 'active' })
})

describe('watchers', () => {
  const WEEK = 7 * 24 * 3600_000

  test('a streaming watcher: no slots, loud, no end of its own; its name from its message', () => {
    const t = create({ watch: { command: 'python3 watchers/price.py' }, message: 'Below 300: {event}' })
    expect(t.trigger).toEqual({ kind: 'watch', command: 'python3 watchers/price.py' })
    expect(t.nextDue).toBeUndefined()
    expect(t.sound).toBe('loud')
    expect(t.until).toBeUndefined()
    expect(t.name).toBe('Below 300: {event}')
  })

  test('a polled watcher looks at once, then every so often; the same command at the same pace is the same task', () => {
    const t = create({ watch: { command: 'python3 page.py', every_minutes: 10 }, prompt: 'Say what changed on the page' })
    expect(t.trigger).toEqual({ kind: 'watch', command: 'python3 page.py', everyMs: 600_000, anchor: now.toISOString() })
    expect(t.nextDue).toBe(now.toISOString())
    const again = svc.create(person, { tz: 'Europe/Berlin', watch: { command: 'python3 page.py', every_minutes: 10 }, prompt: 'Say what changed on the page' })
    expect(again.ok && again.value.duplicate).toBe(true)
    // An edit that leaves the command and pace alone keeps the checks where they were.
    now = new Date(now.getTime() + 25 * 60_000)
    const r = svc.update(person, t.id, { watch: { command: 'python3 page.py', every_minutes: 10 }, name: 'Page' })
    expect(r.ok && r.value.task.trigger).toEqual(t.trigger)
  })

  test('what a watcher needs: a command, and something to do with what it sees, or keep_running', () => {
    const e = (input: any) => { const r = svc.create(person, { tz: 'UTC', ...input }); return r.ok ? '' : r.error }
    expect(e({ watch: {}, message: 'x' })).toContain('watch needs command')
    expect(e({ watch: { command: 'x' } })).toContain('a watcher needs message')
    expect(e({ watch: { command: 'x', every_minutes: 0.5 }, message: 'x' })).toContain('at least 1')
    expect(e({ watch: { command: 'x' }, in_minutes: 5, message: 'x' })).toContain('give one of: a time')
    expect(e({ keep_running: true, in_minutes: 5 })).toContain('keep_running is for a watcher')
    expect(e({ watch: { command: 'x' }, message: 'x', cooldown_minutes: -1 })).toContain('cooldown_minutes is between')
    expect(e({ watch: { command: 'x' }, message: 'x', max_per_hour: 500 })).toContain('max_per_hour')
    const k = create({ watch: 'bash sync.sh', keep_running: true })
    expect(k).toMatchObject({ action: { kind: 'none' }, says: 'problems' })
  })

  test("one task, asked for: what its runs did lately; a list shows only each one's last", () => {
    const t = create({ prompt: 'Back up the photos', cron: '0 3 * * *' })
    store.insertRun({ id: `${t.id}@1`, task: t.id, trigger: 'schedule', state: 'succeeded', startedAt: '2026-10-14T01:00:00.000Z', summary: 'backed up 120 files' })
    store.insertRun({ id: `${t.id}@2`, task: t.id, trigger: 'schedule', state: 'failed', startedAt: '2026-10-15T01:00:00.000Z', reason: 'the disk was full' })
    store.insertRun({ id: `${t.id}@3`, task: t.id, trigger: 'manual', state: 'succeeded', startedAt: '2026-10-15T09:00:00.000Z', summary: 'backed up 2 files' })
    const v = svc.get(person, t.id)
    expect(v.ok && (v.value as any).recent_runs).toEqual([
      { when: 'Thu 15 Oct, 11:00', trigger: 'manual', result: 'quiet', summary: 'backed up 2 files' },
      { when: 'Thu 15 Oct, 03:00', trigger: 'schedule', result: 'failed', why: 'the disk was full' },
      { when: 'Wed 14 Oct, 03:00', trigger: 'schedule', result: 'quiet', summary: 'backed up 120 files' },
    ])
    const l = svc.list(person, {})
    expect(l.ok && (l.value as any[]).find(x => x.id === t.id).recent_runs).toBeUndefined()
  })

  test("its limits are its own; the view shows them, with what it saw", () => {
    const t = create({ watch: { command: 'python3 price.py' }, prompt: 'Find out why', cooldown_minutes: 15, max_per_hour: 4, stale_minutes: 5 })
    expect(t.limits).toEqual({ cooldownMs: 900_000, maxPerHour: 4, staleMs: 300_000 })
    const v = svc.get(person, t.id)
    expect(v.ok && v.value).toMatchObject({ kind: 'watch', watch: { command: 'python3 price.py', streaming: true }, cooldown_minutes: 15, max_per_hour: 4, stale_minutes: 5, events_seen: 0 })
  })

  test('nothing ends on its own: an end only when given, and it can be taken away', () => {
    const f = create({ prompt: 'Check the queue', every_minutes: 15 })
    expect(f.until).toBeUndefined()
    const g = create({ prompt: 'Check the queue again', every_minutes: 15, until: '2027-01-31 12:00' })
    expect(g.until).toBe('2027-01-31T11:00:00.000Z')
    const r = svc.update(person, g.id, { until: '' })
    expect(r.ok && r.value.task.until).toBeUndefined()
  })

  test('keep running: an ended one starts again with no end; a running one loses its end', () => {
    const WEEK = 7 * 24 * 3600_000
    const t = create({ watch: { command: 'python3 price.py' }, message: '{event}', until: '2026-10-20 12:00' })
    store.updateTask(t.id, { state: 'expired' })
    now = new Date(now.getTime() + WEEK)
    const r = svc.keepRunning(person, t.id)
    expect(r.ok && r.value.task).toMatchObject({ state: 'active' })
    expect(r.ok && r.value.task.until).toBeUndefined()
    const p = create({ prompt: 'Poll', every_minutes: 5, until: '2026-12-01 12:00' })
    const r2 = svc.keepRunning(person, p.id)
    expect(r2.ok && r2.value.task.until).toBeUndefined()
    expect(changes.slice(-2).map(c => c[1])).toEqual(['created', 'updated'])
  })

  test('a paused streaming watcher resumes, its failures forgotten', () => {
    const t = create({ watch: { command: 'python3 price.py' }, message: '{event}' })
    store.updateTask(t.id, { state: 'paused', pauseReason: 'failures', watchFails: 5, watchError: 'it ended with status 1' })
    const r = svc.resume(person, t.id)
    expect(r.ok && r.value.task).toMatchObject({ state: 'active' })
    expect(r.ok && r.value.task.watchFails).toBeUndefined()
  })

  test('the bot keeps only so many streaming watchers running', () => {
    svc = new TaskService({
      store, now: () => now, mayCreate: () => undefined, mayManage: () => undefined, isGroup: c => c.startsWith('-'),
      changed: () => {}, runNow: () => ({ runId: 'x' }), maxWatchers: 1,
    })
    create({ watch: { command: 'a' }, message: '{event}' })
    const r = svc.create(person, { tz: 'UTC', watch: { command: 'b' }, message: '{event}' })
    expect(r.ok ? '' : r.error).toContain('already keeps 1 watchers running')
    expect(svc.create(person, { tz: 'UTC', watch: { command: 'b', every_minutes: 5 }, message: '{event}' }).ok).toBe(true)
  })
})

describe('rules and the AI filter', () => {
  const e = (input: any) => { const r = svc.create(person, { tz: 'UTC', ...input }); return r.ok ? '' : r.error }
  const w = { watch: { command: 'python3 feed.py' }, message: '{event}' }

  test('checked when given, and only for a watcher', () => {
    expect(e({ ...w, rule: { op: 'below' } })).toContain('rule.value')
    expect(e({ ...w, ai_filter: { question: '' } })).toContain('ai_filter.question')
    expect(e({ ...w, ai_filter: { question: 'Big?', every_minutes: 90 } })).toContain('ai_filter.every_minutes is between 1 and 60')
    expect(e({ message: 'x', in_minutes: 5, rule: { op: 'changed' } })).toContain('rule and ai_filter are for a watcher')
    expect(e({ watch: { command: 'x' }, keep_running: true, rule: { op: 'changed' } })).toContain('nothing to filter')
  })

  test('stored as given; a slow batch makes events keep longer; null removes them', () => {
    const t = create({ ...w, rule: { op: 'crosses_below', field: 'price', value: 300 }, ai_filter: { question: 'Is it a real drop?', every_minutes: 15 } })
    expect(t.rule).toEqual({ op: 'crosses_below', field: 'price', value: 300 })
    expect(t.ai).toEqual({ question: 'Is it a real drop?', everyMs: 900_000 })
    expect(t.limits?.staleMs).toBe(1_800_000)
    const v = svc.get(person, t.id)
    expect(v.ok && v.value).toMatchObject({ rule: 'when price goes below 300', ai_filter: { question: 'Is it a real drop?', every_minutes: 15, considered: 0, passed: 0 } })
    const r = svc.update(person, t.id, { rule: null, ai_filter: null })
    expect(r.ok && r.value.task.rule).toBeUndefined()
    expect(r.ok && r.value.task.ai).toBeUndefined()
  })

  test('a watcher made into a timed task loses them', () => {
    const t = create({ ...w, rule: { op: 'changed' } })
    const r = svc.update(person, t.id, { cron: '7 9 * * *', message: 'Morning' })
    expect(r.ok && r.value.task.rule).toBeUndefined()
    expect(r.ok && r.value.task.trigger.kind).toBe('cron')
  })
})

describe('scripts', () => {
  test('a command on a schedule: says result by default, named after its command, silent in a group; checked', () => {
    const t = create({ script: 'bash backup.sh', cron: '7 3 * * *' })
    expect(t.action).toEqual({ kind: 'script', command: 'bash backup.sh' })
    expect(t).toMatchObject({ says: 'result', name: 'bash backup.sh', sound: 'silent' })
    const p = create({ script: { command: 'bash sync.sh', timeout_minutes: 90 }, cron: '7 4 * * *', says: 'problems' })
    expect(p.action).toEqual({ kind: 'script', command: 'bash sync.sh', timeoutMs: 5_400_000 })
    expect(p.sound).toBe('loud')
    const e = (input: any) => { const r = svc.create(person, { tz: 'UTC', ...input }); return r.ok ? '' : r.error }
    expect(e({ script: '', cron: '7 3 * * *' })).toContain('script needs command')
    expect(e({ script: { command: 'x', timeout_minutes: 500 }, cron: '7 3 * * *' })).toContain('script.timeout_minutes is between 1 and 240')
    expect(e({ script: 'x', prompt: 'y', cron: '7 3 * * *' })).toContain('give one of')
    const v = svc.get(person, p.id)
    expect(v.ok && v.value).toMatchObject({ script: { command: 'bash sync.sh', timeout_minutes: 90 }, says: 'problems' })
  })

  test("a watcher's events can run a script", () => {
    expect(create({ watch: { command: 'python3 feed.py' }, script: 'bash on-event.sh' }).action.kind).toBe('script')
  })
})

describe('digests and watchdogs', () => {
  const e = (input: any) => { const r = svc.create(person, { tz: 'UTC', ...input }); return r.ok ? '' : r.error }

  test('a digest of named tasks: silent, named Digest; on a schedule only', () => {
    const news = create({ name: 'Nightly news', prompt: 'News', cron: '7 21 * * *' })
    const d = create({ digest: { of: ['nightly news'] }, cron: '7 22 * * *' })
    expect(d).toMatchObject({ action: { kind: 'digest', of: [news.id] }, name: 'Digest', sound: 'silent', says: 'result' })
    expect(create({ digest: true, cron: '7 23 * * *' }).action).toEqual({ kind: 'digest', of: [] })
    expect(e({ digest: { of: ['nope'] }, cron: '7 22 * * 1' })).toContain('digest.of: no task "nope" in this chat')
    expect(e({ digest: {}, watch: { command: 'x' } })).toContain('a digest runs on a schedule')
  })

  test('a watchdog: the tasks it watches, by id or name; noteworthy unless told; not itself', () => {
    const backup = create({ name: 'Backup', script: 'bash backup.sh', cron: '7 3 * * *' })
    const sync = create({ name: 'Sync', script: 'bash sync.sh', cron: '7 4 * * *' })
    const w = create({ name: 'Watchdog', prompt: 'Check the backup and the sync', cron: '7 9 * * *', watch_tasks: [backup.id, 'SYNC'] })
    expect(w.action).toEqual({ kind: 'claude', prompt: 'Check the backup and the sync', session: 'fresh', watch: [backup.id, sync.id] })
    expect(w).toMatchObject({ says: 'noteworthy', sound: 'loud' })
    const r = svc.update(person, w.id, { watch_tasks: [w.id] })
    expect(r.ok ? '' : r.error).toContain("can't include itself")
    expect(e({ message: 'x', in_minutes: 5, watch_tasks: [backup.id] })).toContain('watch_tasks is for a prompt')
  })

  test("a watchdog's run may read the tasks it watches, and nothing else, and change none of them", () => {
    const backup = create({ name: 'Backup', script: 'bash backup.sh', cron: '7 3 * * *' })
    const other = create({ name: 'Other', script: 'bash other.sh', cron: '7 5 * * *' })
    const w = create({ name: 'Watchdog', prompt: 'Check', cron: '7 9 * * *', watch_tasks: [backup.id] })
    const run: Scope = { kind: 'run', chat: '-100777', thread: 5, runKind: 'scheduled', taskId: w.id, runId: `${w.id}@1` }
    expect(svc.get(run, backup.id).ok).toBe(true)
    const no = svc.get(run, other.id)
    expect(no.ok ? '' : no.error).toContain('and the tasks it watches')
    const p = svc.pause(run, backup.id)
    expect(p.ok ? '' : p.error).toContain('can only change its own task')
  })
})

describe('plans', () => {
  const e = (input: any) => { const r = svc.create(person, { tz: 'UTC', cron: '7 10 * * 6', ...input }); return r.ok ? '' : r.error }
  test('each step checked: what it does, and where it goes after', () => {
    expect(e({ steps: [] })).toContain('steps is a list of 1 to 12')
    expect(e({ steps: [{ kind: 'dance' }] })).toContain('step 1: kind is one of')
    expect(e({ steps: [{ kind: 'script' }] })).toContain('step 1: a script step needs command')
    expect(e({ steps: [{ kind: 'claude', prompt: 'x', on_fail: 9 }] })).toContain('step 1: on_fail is "next", "stop" or a step number from 1 to 1')
    expect(e({ steps: [{ kind: 'script', command: 'x', retries: 7 }] })).toContain('retries is 0 to 3')
    expect(e({ steps: [{ kind: 'handoff', topic: 'nowhere' }] })).toContain('step 1: a handoff step needs topic')
    expect(e({ steps: [{ kind: 'script', command: 'x' }], prompt: 'y' })).toContain('give one of')
  })
  test('stored with its names and gates; named after its steps; its view lists them', () => {
    const t = create({ cron: '7 10 * * 6', steps: [
      { name: 'tests', kind: 'script', command: 'bun test', on_fail: 2 },
      { name: 'fix', kind: 'codex', prompt: 'Fix the failing tests', retries: 1, on_pass: 1, timeout_minutes: 45 },
    ] })
    expect(t.action).toEqual({ kind: 'steps', steps: [
      { name: 'tests', kind: 'script', command: 'bun test', onFail: 2 },
      { name: 'fix', kind: 'codex', prompt: 'Fix the failing tests', retries: 1, onPass: 1, timeoutMs: 2_700_000 },
    ] })
    expect(t.name).toBe('Plan: tests, fix')
    const v = svc.get(person, t.id)
    expect(v.ok && (v.value as any).steps.map((x: any) => x.step)).toEqual([1, 2])
  })
})

describe('after, child tasks and proposals', () => {
  const run = (t: Task): Scope => ({ kind: 'run', chat: t.chat, thread: t.thread, person: t.owner, personName: t.ownerName, runKind: 'scheduled', taskId: t.id, runId: `${t.id}@1` })

  test('after another task: by id or name, on what; no slots of its own; never round in a circle', () => {
    const report = create({ name: 'Nightly report', prompt: 'Report', cron: '7 21 * * *' })
    const tr = create({ name: 'Translate it', prompt: 'Translate the report', after: { task: 'nightly report' } })
    expect(tr.trigger).toEqual({ kind: 'after', task: report.id, name: 'Nightly report', on: 'success' })
    expect(tr.nextDue).toBeUndefined()
    const loop = svc.update(person, report.id, { after: { task: tr.id } })
    expect(loop.ok ? '' : loop.error).toContain('would go round forever')
    const e = svc.create(person, { tz: 'UTC', prompt: 'x', after: { task: report.id, on: 'sometimes' as any } })
    expect(e.ok ? '' : e.error).toContain('after.on is')
  })

  test("a task's run makes child tasks: at most three, two levels, ending with it or within a week", () => {
    const parent = create({ name: 'Research', prompt: 'Look into it', cron: '7 9 * * *', until: '2026-10-19 12:00' })
    const kid = svc.create(run(parent), { tz: 'Europe/Berlin', prompt: 'Look again', every_minutes: 120 })
    expect(kid.ok && kid.value.task).toMatchObject({ parent: parent.id, parentName: 'Research', childDepth: 1, createdBy: `run:${parent.id}@1`, until: parent.until })
    const free = create({ name: 'Free', prompt: 'x', cron: '7 8 * * *' })
    const kid2 = svc.create(run(free), { tz: 'UTC', prompt: 'later', in_minutes: 60 * 24 * 30 })
    expect(kid2.ok && kid2.value.task.until).toBe(new Date(now.getTime() + 7 * 24 * 3600_000).toISOString())
    for (const m of [2, 3]) expect(svc.create(run(parent), { tz: 'UTC', prompt: `again ${m}`, every_minutes: 60 * m }).ok).toBe(true)
    const fourth = svc.create(run(parent), { tz: 'UTC', prompt: 'one more', every_minutes: 300 })
    expect(fourth.ok ? '' : fourth.error).toContain('3 child tasks already')
    const grand = svc.create(run((kid as any).value.task), { tz: 'UTC', prompt: 'deeper', in_minutes: 30 })
    expect(grand.ok && grand.value.task.childDepth).toBe(2)
    const great = svc.create(run((grand as any).value.task), { tz: 'UTC', prompt: 'deeper still', in_minutes: 30 })
    expect(great.ok ? '' : great.error).toContain('2 levels at most')
  })

  test('a proposal is checked, not made', () => {
    const before = store.listTasks().length
    const c = svc.check(person, { tz: 'UTC', name: 'Weekly sum-up', prompt: 'Sum up the week', cron: '7 17 * * 5' })
    expect(c.ok && c.value.task).toMatchObject({ id: 'proposal', name: 'Weekly sum-up' })
    expect(store.listTasks().length).toBe(before)
    const bad = svc.check(person, { tz: 'UTC', prompt: 'x' })
    expect(bad.ok).toBe(false)
  })
})

describe('fired tasks', () => {
  test('a webhook task: no slots, a secret kept through edits; its view says how to fire it', () => {
    const t = create({ name: 'Deploy note', message: 'Deployed: {payload}', webhook: true })
    expect(t.trigger.kind).toBe('webhook')
    expect(t.nextDue).toBeUndefined()
    const secret = (t.trigger as any).secret
    const u = svc.update(person, t.id, { name: 'Deploys', webhook: true })
    expect(u.ok && (u.value.task.trigger as any).secret).toBe(secret)
    const v = svc.get(person, t.id)
    expect(v.ok && (v.value as any).webhook).toEqual({ fire: `bun tasks/cli.ts fire ${t.id} "<payload>"`, http_path: `/hook/${t.id}/${secret}` })
  })
  test('firing: as anyone who may run it, never from a scheduled run', () => {
    svc = new TaskService({ store, now: () => now, mayCreate: () => undefined, mayManage: () => undefined, isGroup: c => c.startsWith('-'), changed: () => {}, runNow: () => ({ runId: 'x' }),
      fire: (t, payload) => ({ runId: `${t.id}@fired:${payload}` }) })
    const t = create({ name: 'Deploy note', message: 'Deployed: {payload}', webhook: true })
    expect(svc.fire(operator, t.id, 'v1')).toMatchObject({ ok: true, value: { runId: `${t.id}@fired:v1` } })
    expect(svc.fire(person, t.id, { v: 2 })).toMatchObject({ ok: true, value: { runId: `${t.id}@fired:{"v":2}` } })
    const run: Scope = { kind: 'run', chat: '-100777', runKind: 'scheduled', taskId: t.id, runId: 'r' }
    expect(svc.fire(run, t.id, 'x').ok).toBe(false)
  })
})
