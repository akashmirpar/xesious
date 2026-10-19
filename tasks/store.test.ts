import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from './store'
import type { Run, Task } from './model'

let dir: string
let store: TaskStore
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'xesious-tasks-')); store = new TaskStore(join(dir, 'tasks.db')) })
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

const base = (over: Partial<Task> = {}): any => ({
  chat: '-100777', thread: 5, name: 'Nightly news', tz: 'UTC',
  trigger: { kind: 'cron', expr: '7 21 * * *' },
  action: { kind: 'claude', prompt: 'Summarize the news', session: 'fresh' },
  says: 'result', sound: 'loud', where: 'home', owner: '1', createdBy: 'person:1',
  nextDue: '2026-10-16T21:07:00.000Z', ...over,
})
const run = (id: string, over: Partial<Run> = {}): Run => ({ id, task: id.split('@')[0], trigger: 'schedule', state: 'queued', ...over })

describe('tasks', () => {
  test('create, read back, and list by topic', () => {
    const a = store.createTask(base())
    const b = store.createTask(base({ thread: undefined, name: 'In General' }))
    expect(a.id).toMatch(/^[0-9a-z]{6}$/)
    expect(store.getTask(a.id)).toEqual(a)
    expect(store.listTasks({ chat: '-100777', thread: 5 }).map(t => t.name)).toEqual(['Nightly news'])
    expect(store.listTasks({ chat: '-100777', thread: null }).map(t => t.id)).toEqual([b.id])
    expect(store.listTasks({ chat: '-100777' }).length).toBe(2)
    expect(store.countInTopic('-100777', 5)).toBe(1)
  })

  test('an update keeps the rest, and an explicit undefined clears a field', () => {
    const a = store.createTask(base({ pauseReason: 'person' }))
    const b = store.updateTask(a.id, { name: 'Renamed', pauseReason: undefined })!
    expect(b.name).toBe('Renamed')
    expect(b.pauseReason).toBeUndefined()
    expect(store.getTask(a.id)!.trigger).toEqual(a.trigger)
  })

  test('deleted tasks are left out of lists, but still readable', () => {
    const a = store.createTask(base())
    store.updateTask(a.id, { state: 'deleted' })
    expect(store.listTasks({ chat: '-100777' })).toEqual([])
    expect(store.getTask(a.id)!.state).toBe('deleted')
  })

  test('due tasks: active ones whose slot has come, earliest first', () => {
    const late = store.createTask(base({ nextDue: '2026-10-16T21:00:00.000Z' }))
    const early = store.createTask(base({ nextDue: '2026-10-16T20:00:00.000Z' }))
    store.createTask(base({ nextDue: '2026-10-16T23:00:00.000Z' }))
    store.createTask(base({ nextDue: '2026-10-16T19:00:00.000Z', state: 'paused' }))
    expect(store.dueTasks(new Date('2026-10-16T22:00:00Z')).map(t => t.id)).toEqual([early.id, late.id])
    expect(store.earliestDue()).toBe('2026-10-16T20:00:00.000Z')
  })

  test('a slot can be claimed once: the second claim of the same slot fails', () => {
    const a = store.createTask(base())
    expect(store.claim(a.id, a.nextDue!, '2026-10-17T21:07:00.000Z')).toBe(true)
    expect(store.claim(a.id, a.nextDue!, '2026-10-17T21:07:00.000Z')).toBe(false)
    expect(store.getTask(a.id)!.nextDue).toBe('2026-10-17T21:07:00.000Z')
    store.updateTask(a.id, { state: 'paused' })
    expect(store.claim(a.id, '2026-10-17T21:07:00.000Z', undefined)).toBe(false)
  })

  test('asking twice for the same thing finds the first task', () => {
    const a = store.createTask(base())
    const probe = { trigger: { kind: 'cron', expr: '7  21 * * *' }, action: { kind: 'claude', prompt: 'summarize the NEWS ', session: 'fresh' } } as any
    expect(store.findDuplicate('-100777', 5, probe)?.id).toBe(a.id)
    expect(store.findDuplicate('-100777', 6, probe)).toBeUndefined()
  })

  test('it all survives closing and reopening the file', () => {
    const a = store.createTask(base())
    store.insertRun(run(`${a.id}@x`, { state: 'running', startedAt: '2026-10-16T21:07:01.000Z' }))
    store.close()
    store = new TaskStore(join(dir, 'tasks.db'))
    expect(store.getTask(a.id)!.name).toBe('Nightly news')
    expect(store.openRuns().map(r => r.id)).toEqual([`${a.id}@x`])
  })
})

describe('runs', () => {
  test('one run per id: a slot that ran cannot run again', () => {
    expect(store.insertRun(run('t1@2026-10-16T21:07:00.000Z'))).toBe(true)
    expect(store.insertRun(run('t1@2026-10-16T21:07:00.000Z'))).toBe(false)
  })

  test('updates, newest first, and open runs', () => {
    store.insertRun(run('t1@a', { startedAt: '2026-10-16T21:07:00.000Z', state: 'succeeded' }))
    store.insertRun(run('t1@b', { startedAt: '2026-10-17T21:07:00.000Z', state: 'running' }))
    store.insertRun(run('t1@c', { slot: '2026-10-15T21:07:00.000Z', state: 'skipped', reason: 'missed' }))
    store.updateRun('t1@b', { state: 'succeeded', usage: { model: 'sonnet', inputTokens: 10 } })
    expect(store.runsFor('t1').map(r => r.id)).toEqual(['t1@b', 't1@a', 't1@c'])
    expect(store.getRun('t1@b')!.usage).toEqual({ model: 'sonnet', inputTokens: 10 })
    expect(store.openRuns()).toEqual([])
  })
})

test('notes wait for the topic\'s next turn, five at most, taken once', () => {
  for (let i = 1; i <= 7; i++) store.addNote('-100777:5', `note ${i}`)
  expect(store.peekNotes('-100777:5')).toEqual(['note 3', 'note 4', 'note 5', 'note 6', 'note 7'])
  expect(store.takeNotes('-100777:5').length).toBe(5)
  expect(store.takeNotes('-100777:5')).toEqual([])
  expect(store.takeNotes('-100777:6')).toEqual([])
})

test('meta values', () => {
  expect(store.getMeta('activity:-100777')).toBeUndefined()
  store.setMeta('activity:-100777', '42')
  expect(store.getMeta('activity:-100777')).toBe('42')
  store.setMeta('activity:-100777', undefined)
  expect(store.getMeta('activity:-100777')).toBeUndefined()
})
