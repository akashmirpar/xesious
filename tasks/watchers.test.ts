import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from './store'
import { Watchers, alive, type WatcherExit } from './watchers'
import { LIMITS, type Task, type WatchEvent } from './model'

let dir: string
let store: TaskStore
let events: { task: string; ev: WatchEvent[] }[]
let exits: { task: string; how: WatcherExit }[]
let made: Watchers[]

const supervisor = (extra: { heartbeat?: string; env?: Record<string, string> } = {}) => {
  const w = new Watchers({
    store, now: () => new Date(), log: () => {},
    dir: t => join(dir, t.id), cwd: () => dir,
    env: () => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...extra.env }),
    events: (t, ev) => { events.push({ task: t.id, ev }) },
    exited: (t, how) => { exits.push({ task: t.id, how }) },
    heartbeat: extra.heartbeat,
  })
  made.push(w)
  return w
}

const watcher = (command: string, everyMs?: number): Task => store.createTask({
  chat: '-100777', thread: 5, name: 'Watch', tz: 'UTC',
  trigger: everyMs ? { kind: 'watch', command, everyMs, anchor: new Date().toISOString() } : { kind: 'watch', command },
  action: { kind: 'message', text: 'Saw: {event}' },
  says: 'result', sound: 'loud', where: 'home', owner: '1', createdBy: 'person:1',
} as any)

async function until(pred: () => boolean, w?: Watchers, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out')
    w?.tick()
    await Bun.sleep(50)
  }
}
const texts = (task: string) => events.filter(e => e.task === task).flatMap(e => e.ev.map(x => x.text))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xesious-watch-'))
  store = new TaskStore(join(dir, 'tasks.db'))
  events = []; exits = []; made = []
})
afterEach(() => {
  for (const w of made) for (const id of w.list()) w.stop(id)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('streaming watchers', () => {
  test('each line it prints is an event, stamped with the second it was printed', async () => {
    const t = watcher('echo first; sleep 0.2; echo \'{"price": 301}\'; sleep 30')
    const w = supervisor()
    expect(w.ensure(t)).toBe(true)
    expect(w.status(t.id).running).toBe(true)
    await until(() => texts(t.id).length >= 2, w)
    expect(texts(t.id)).toEqual(['first', '{"price": 301}'])
    const at = Date.parse(events[0].ev[0].at)
    expect(Math.abs(at - Date.now())).toBeLessThan(5000)
    expect(exits).toEqual([])
  })

  test('stopping it ends its whole process group, and is not reported as an exit', async () => {
    const t = watcher('sleep 300 & echo $! > child.pid; echo started; wait')
    const w = supervisor()
    w.ensure(t)
    await until(() => texts(t.id).includes('started'), w)
    const child = Number(readFileSync(join(dir, 'child.pid'), 'utf8'))
    const proc = store.getWatcher(t.id)!
    expect(alive(proc)).toBe(true)
    w.stop(t.id)
    await until(() => !alive(proc))
    let childGone = false
    for (let i = 0; i < 40 && !childGone; i++) { try { process.kill(child, 0); await Bun.sleep(50) } catch { childGone = true } }
    expect(childGone).toBe(true)
    expect(store.getWatcher(t.id)).toBeUndefined()
    w.tick()
    expect(exits).toEqual([])
  })

  test('when it ends, what it printed last comes first, then how it ended: status and stderr', async () => {
    const t = watcher('echo last words; echo "connection refused" >&2; exit 3')
    const w = supervisor()
    w.ensure(t)
    await until(() => exits.length > 0, w)
    expect(texts(t.id)).toEqual(['last words'])
    expect(exits[0].how.code).toBe(3)
    expect(exits[0].how.err).toContain('connection refused')
    expect(w.list()).toEqual([])
    expect(store.getWatcher(t.id)).toBeUndefined()
  })

  test('a changed command restarts it', async () => {
    let t = watcher('echo one; sleep 30')
    const w = supervisor()
    w.ensure(t)
    await until(() => texts(t.id).includes('one'), w)
    const first = store.getWatcher(t.id)!
    t = store.updateTask(t.id, { trigger: { kind: 'watch', command: 'echo two; sleep 30' } })!
    expect(w.ensure(t)).toBe(true)
    await until(() => texts(t.id).includes('two'), w)
    await until(() => !alive(first))
    expect(store.getWatcher(t.id)!.pid).not.toBe(first.pid)
  })
})

describe('across a bridge restart', () => {
  test('a running watcher is picked up by the next bridge, which reads what it wrote meanwhile', async () => {
    const t = watcher('i=0; while true; do i=$((i+1)); echo "tick $i"; sleep 0.1; done')
    const a = supervisor()
    a.ensure(t)
    await until(() => texts(t.id).length >= 2, a)
    a.detach()                       // the bridge goes; the watcher doesn't
    const before = texts(t.id).length
    await Bun.sleep(500)
    const b = supervisor()
    b.adopt()
    expect(b.list()).toEqual([t.id])
    await until(() => texts(t.id).length >= before + 4, b)
    // Nothing read twice, nothing skipped.
    const n = texts(t.id).map(s => Number(s.split(' ')[1]))
    expect(n).toEqual(n.map((_, i) => i + 1))
    expect(exits).toEqual([])
  })

  test('one that died meanwhile is read to its end and reported, so the runtime can start it again', async () => {
    const t = watcher('echo bye; exit 0')
    const a = supervisor()
    a.ensure(t)
    const proc = store.getWatcher(t.id)!
    a.detach()
    await until(() => !alive(proc))
    const b = supervisor()
    b.adopt()
    expect(b.list()).toEqual([])
    expect(texts(t.id)).toEqual(['bye'])
    expect(exits).toMatchObject([{ task: t.id, how: { code: 0 } }])
  })

  test('a pid that now belongs to another process is not mistaken for the watcher, nor killed', async () => {
    const t = watcher('sleep 30')
    store.setWatcher(t.id, { pid: process.pid, startTicks: 'not-this-one', startedAt: new Date().toISOString(), command: 'sleep 30', out: join(dir, 'none.out'), err: join(dir, 'none.err'), readPos: 0 })
    const b = supervisor()
    b.adopt()
    expect(b.list()).toEqual([])
    expect(exits.length).toBe(1)
    expect(exits[0].how.code).toBeNull()
  })

  test("a watcher whose task stopped wanting it is ended, not adopted", async () => {
    const t = watcher('sleep 30')
    const a = supervisor()
    a.ensure(t)
    const proc = store.getWatcher(t.id)!
    a.detach()
    store.updateTask(t.id, { state: 'paused' })
    const b = supervisor()
    b.adopt()
    expect(b.list()).toEqual([])
    await until(() => !alive(proc))
    expect(exits).toEqual([])
  })
})

test('a watcher whose bridge is gone for good ends itself, once the heartbeat is old', async () => {
  const hb = join(dir, 'bridge.alive')
  const t = watcher('sleep 30')
  const w = supervisor({ heartbeat: hb, env: { XESIOUS_HEARTBEAT_EVERY: '0.3', XESIOUS_HEARTBEAT_MAX: '60' } })
  w.ensure(t)
  const proc = store.getWatcher(t.id)!
  expect(existsSync(hb)).toBe(true)
  w.detach()                                   // the bridge goes and doesn't come back
  await Bun.sleep(1000)
  expect(alive(proc)).toBe(true)               // a fresh heartbeat: it waits
  const old = new Date(Date.now() - 2 * 3600_000)
  utimesSync(hb, old, old)
  await until(() => !alive(proc), undefined, 5000)
  expect(readFileSync(proc.out, 'utf8')).toContain('\u0001exit 143')
})

describe('polled watchers', () => {
  test('a look: what it printed by the time it exited, and its status', async () => {
    const t = watcher('echo "price 299"; echo; echo "price 298"', 60_000)
    const r = await supervisor().poll(t)
    expect(r.code).toBe(0)
    expect(r.events.map(e => e.text)).toEqual(['price 299', 'price 298'])
    const bad = await supervisor().poll(watcher('echo nope >&2; exit 2', 60_000))
    expect(bad.code).toBe(2)
    expect(bad.err).toContain('nope')
  })

  test('one that runs past the limit is killed', async () => {
    const keep = LIMITS.pollTimeoutMs
    LIMITS.pollTimeoutMs = 300
    try {
      const r = await supervisor().poll(watcher('sleep 5; echo late', 60_000))
      expect(r.timedOut).toBe(true)
      expect(r.code).toBeNull()
      expect(r.events).toEqual([])
    } finally { LIMITS.pollTimeoutMs = keep }
  })

  test('it runs in the topic folder, without the secrets of the bot', async () => {
    process.env.TELEGRAM_TEST_SECRET = 'x'
    try {
      const r = await supervisor().poll(watcher('pwd; echo "secret=${TELEGRAM_TEST_SECRET:-none}"', 60_000))
      expect(r.events.map(e => e.text)).toEqual([dir, 'secret=none'])
    } finally { delete process.env.TELEGRAM_TEST_SECRET }
    expect(existsSync(dir)).toBe(true)
  })
})
