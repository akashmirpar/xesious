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
    expect(r3.ok ? '' : r3.error).toContain('not both')
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
