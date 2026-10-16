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

  test('a streaming watcher: no slots, loud, a week until it ends; its name from its message', () => {
    const t = create({ watch: { command: 'python3 watchers/price.py' }, message: 'Below 300: {event}' })
    expect(t.trigger).toEqual({ kind: 'watch', command: 'python3 watchers/price.py' })
    expect(t.nextDue).toBeUndefined()
    expect(t.sound).toBe('loud')
    expect(t.until).toBe(new Date(now.getTime() + WEEK).toISOString())
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
    expect(e({ watch: { command: 'x' }, in_minutes: 5, message: 'x' })).toContain('not both')
    expect(e({ keep_running: true, in_minutes: 5 })).toContain('keep_running is for a watcher')
    expect(e({ watch: { command: 'x' }, message: 'x', cooldown_minutes: -1 })).toContain('cooldown_minutes is between')
    expect(e({ watch: { command: 'x' }, message: 'x', max_per_hour: 500 })).toContain('max_per_hour')
    const k = create({ watch: 'bash sync.sh', keep_running: true })
    expect(k).toMatchObject({ action: { kind: 'none' }, says: 'problems' })
  })

  test("its limits are its own; the view shows them, with what it saw", () => {
    const t = create({ watch: { command: 'python3 price.py' }, prompt: 'Find out why', cooldown_minutes: 15, max_per_hour: 4, stale_minutes: 5 })
    expect(t.limits).toEqual({ cooldownMs: 900_000, maxPerHour: 4, staleMs: 300_000 })
    const v = svc.get(person, t.id)
    expect(v.ok && v.value).toMatchObject({ kind: 'watch', watch: { command: 'python3 price.py', streaming: true }, cooldown_minutes: 15, max_per_hour: 4, stale_minutes: 5, events_seen: 0 })
  })

  test('anything more often than hourly gets a week unless given an end; an end can be further, not removed', () => {
    const f = create({ prompt: 'Check the queue', every_minutes: 15 })
    expect(f.until).toBe(new Date(now.getTime() + WEEK).toISOString())
    const g = create({ prompt: 'Check the queue again', every_minutes: 15, until: '2027-01-31 12:00' })
    expect(g.until).toBe('2027-01-31T11:00:00.000Z')
    const r = svc.update(person, g.id, { until: '' })
    expect(r.ok ? '' : r.error).toContain('needs an end')
    expect(create({ prompt: 'Daily', cron: '7 9 * * *' }).until).toBeUndefined()
  })

  test('another week: an ended one starts again; a running one ends a week later', () => {
    const t = create({ watch: { command: 'python3 price.py' }, message: '{event}' })
    store.updateTask(t.id, { state: 'expired' })
    now = new Date(now.getTime() + WEEK + 3600_000)
    const r = svc.extend(person, t.id)
    expect(r.ok && r.value.task).toMatchObject({ state: 'active', until: new Date(now.getTime() + WEEK).toISOString() })
    const r2 = svc.extend(person, t.id)
    expect(r2.ok && r2.value.task.until).toBe(new Date(now.getTime() + 2 * WEEK).toISOString())
    expect(changes.slice(-2).map(c => c[1])).toEqual(['resumed', 'updated'])
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
