import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from './store'
import { TaskRuntime, eventText, type ClaudeOutcome, type FilterVerdict, type RuntimeDeps, type StepCall, type WatcherControl } from './runtime'
import type { Run, Task, WatchEvent } from './model'
import type { PollResult } from './watchers'
import type { ScriptOutcome } from './scripts'

let dir: string
let store: TaskStore
let now: Date
let posts: { task: string; kind: string; text: string; opts: any }[]
let notes: string[]
let acts: string[]
let timers: { fn: () => void; ms: number }[]
let owner: boolean
let claude: (t: Task, r: Run, step?: StepCall) => Promise<ClaudeOutcome>
let rt: TaskRuntime
let msg: number

const OK = (text = 'Five stories today.'): ClaudeOutcome => ({ ok: true, text, sessionId: 'sess-1', usage: { model: 'sonnet', inputTokens: 1000, outputTokens: 200, costUsd: 0.01 } })

function deps(over: Partial<RuntimeDeps> = {}): RuntimeDeps {
  return {
    store, now: () => now, log: () => {}, dataDir: join(dir, 'tasks'), maxClaude: 2,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    ownerAllowed: () => owner,
    runClaude: (t, r, step) => claude(t, r, step),
    post: async (t, kind, text, opts) => { posts.push({ task: t.id, kind, text, opts }); return opts.edit ?? ++msg },
    cardChanged: () => {}, note: (_t, text) => { notes.push(text) }, activity: (_t, text) => { acts.push(text) },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimer: () => {},
    ...over,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xesious-rt-'))
  store = new TaskStore(join(dir, 'tasks.db'))
  now = new Date('2026-10-16T19:07:00Z')
  posts = []; notes = []; acts = []; timers = []; owner = true; msg = 100
  claude = async () => OK()
  rt = new TaskRuntime(deps())
})
afterEach(() => { rt.stop(); store.close(); rmSync(dir, { recursive: true, force: true }) })

const mk = (over: Partial<Task> = {}): Task => store.createTask({
  chat: '-100777', thread: 5, name: 'Nightly news', tz: 'UTC',
  trigger: { kind: 'cron', expr: '7 19 * * *' },
  action: { kind: 'claude', prompt: 'Summarize the news', session: 'fresh' },
  says: 'result', sound: 'loud', where: 'home', owner: '1', createdBy: 'person:1',
  nextDue: '2026-10-16T19:07:00.000Z', ...over,
} as any)
const reminder = (over: Partial<Task> = {}) => mk({
  name: 'Medicine', trigger: { kind: 'at', at: '2026-10-16T19:07:00.000Z' }, action: { kind: 'message', text: 'Take your medicine' }, ...over,
})
const tick = async () => { await rt.tick(); await rt.idle() }

describe('reminders', () => {
  test('on time: sent once, loud, with its buttons; the task is done', async () => {
    const t = reminder()
    await tick()
    expect(posts).toMatchObject([{ task: t.id, kind: 'reminder', text: 'Take your medicine', opts: { loud: true, buttons: 'reminder' } }])
    expect(store.getTask(t.id)).toMatchObject({ state: 'done', runsDone: 1, lastMark: 'posted' })
    expect(store.getTask(t.id)!.nextDue).toBeUndefined()
    await tick()
    expect(posts.length).toBe(1)
  })

  test('three hours late, it still goes out, marked late', async () => {
    reminder()
    now = new Date('2026-10-16T22:07:00Z')
    await tick()
    expect(posts[0].kind).toBe('reminder')
    expect(posts[0].opts.lateMs).toBe(3 * 3600_000)
    expect(store.runsFor(store.listTasks()[0].id)[0].trigger).toBe('catchup')
  })

  test('thirteen hours late it is missed, and the topic is told so', async () => {
    const t = reminder()
    now = new Date('2026-10-17T08:08:00Z')
    await tick()
    expect(posts).toMatchObject([{ kind: 'notice', text: '🔔 Missed while the bot was down: Take your medicine', opts: { loud: false } }])
    expect(store.getTask(t.id)!.state).toBe('done')
    expect(store.runsFor(t.id)[0]).toMatchObject({ state: 'skipped', reason: 'missed while the bot was down' })
  })

  test('a failed send is retried', async () => {
    let fails = 1
    rt = new TaskRuntime(deps({ post: async (t, kind, text, opts) => { if (kind === 'reminder' && fails-- > 0) throw new Error('429'); posts.push({ task: t.id, kind, text, opts }); return ++msg } }))
    reminder()
    const p = rt.tick()
    await p
    await new Promise(r => setTimeout(r, 0))
    const retry = timers.find(x => x.ms === 60_000)!
    retry.fn()
    await rt.idle()
    expect(posts.map(p => p.kind)).toEqual(['reminder'])
  })
})

describe('Claude runs: what gets posted', () => {
  test('result: the answer is posted, the run is recorded with its usage, the topic gets a note, the next slot is set', async () => {
    const t = mk()
    await tick()
    expect(posts).toMatchObject([{ kind: 'result', text: 'Five stories today.', opts: { loud: true } }])
    const run = store.runsFor(t.id)[0]
    expect(run).toMatchObject({ state: 'succeeded', postedMsg: 101, usage: { model: 'sonnet' }, sessionId: 'sess-1' })
    expect(readFileSync(run.resultPath!, 'utf8')).toBe('Five stories today.')
    expect(notes[0]).toContain('The task "Nightly news" ran at')
    expect(store.getTask(t.id)).toMatchObject({ runsDone: 1, nextDue: '2026-10-17T19:07:00.000Z', lastMark: 'posted' })
  })

  test('own session: the session id is kept for the next run', async () => {
    const t = mk({ action: { kind: 'claude', prompt: 'p', session: 'own' } })
    await tick()
    expect(store.getTask(t.id)!.sessionId).toBe('sess-1')
  })

  test('noteworthy: silent unless the run reports notify, then its text is posted', async () => {
    const t = mk({ says: 'noteworthy' })
    await tick()
    expect(posts).toEqual([])
    expect(store.getTask(t.id)!.lastMark).toBe('quiet')
    now = new Date('2026-10-17T19:07:00Z')
    claude = async (_t, r) => { store.updateRun(r.id, { outcome: 'needs_attention', notify: true, summary: 'Outage', reportText: 'A big outage started.' }); return OK('long answer') }
    await tick()
    expect(posts).toMatchObject([{ kind: 'result', text: 'A big outage started.' }])
  })

  test('problems: posted only when blocked or needing attention; never: nothing', async () => {
    const p = mk({ says: 'problems' })
    claude = async (_t, r) => { store.updateRun(r.id, { outcome: 'done', notify: true, summary: 'fine' }); return OK() }
    await tick()
    expect(posts).toEqual([])
    store.updateTask(p.id, { nextDue: '2026-10-17T19:07:00.000Z' })
    now = new Date('2026-10-17T19:07:00Z')
    claude = async (_t, r) => { store.updateRun(r.id, { outcome: 'blocked', notify: true, summary: 'No access to the server' }); return OK('') }
    await tick()
    expect(posts).toMatchObject([{ kind: 'result', text: 'No access to the server' }])
    mk({ says: 'never', nextDue: '2026-10-17T19:07:00.000Z' })
    posts = []
    claude = async () => OK()
    await tick()
    expect(posts).toEqual([])
  })

  test('a deleted task posts nothing when its run ends', async () => {
    const t = mk()
    claude = async () => { store.updateTask(t.id, { state: 'deleted' }); return OK() }
    await tick()
    expect(posts).toEqual([])
    expect(store.runsFor(t.id)[0].state).toBe('canceled')
  })
})

describe('overlap, limits and order', () => {
  test('a slot that comes while the last run is still going is skipped, not stacked', async () => {
    const t = mk({ trigger: { kind: 'every', everyMs: 60_000, anchor: '2026-10-16T19:07:00.000Z' } })
    let release!: () => void
    claude = () => new Promise(res => { release = () => res(OK()) })
    await rt.tick()
    expect(rt.isRunning(t.id)).toBe(true)
    now = new Date('2026-10-16T19:08:00Z')
    await rt.tick()
    expect(store.runsFor(t.id).map(r => r.state)).toContain('skipped')
    release()
    await rt.idle()
  })

  test('at most maxClaude scheduled Claude runs at once; the rest wait their turn', async () => {
    rt = new TaskRuntime(deps({ maxClaude: 1 }))
    const a = mk({ name: 'A' })
    const b = mk({ name: 'B', trigger: { kind: 'cron', expr: '7 19 * * *' } })
    const started: string[] = []
    const releases: (() => void)[] = []
    claude = t => new Promise(res => { started.push(t.name); releases.push(() => res(OK(t.name))) })
    await rt.tick()
    expect(started).toEqual(['A'])
    releases[0]()
    await new Promise(r => setTimeout(r, 5))
    expect(started).toEqual(['A', 'B'])
    releases[1]()
    await rt.idle()
    expect(posts.map(p => p.text)).toEqual(['A', 'B'])
    expect([a.id, b.id].every(id => store.getTask(id)!.runsDone === 1)).toBe(true)
  })

  test('just after a start, reminders go out but Claude runs wait two minutes', async () => {
    rt = new TaskRuntime(deps({ startedAt: now }))
    const c = mk()
    reminder()
    await tick()
    expect(posts.map(p => p.kind)).toEqual(['reminder'])
    expect(store.getTask(c.id)!.nextDue).toBe('2026-10-16T19:07:00.000Z')
    expect(timers.at(-1)!.ms).toBe(30_000)
    now = new Date('2026-10-16T19:09:01Z')
    await tick()
    expect(posts.map(p => p.kind)).toEqual(['reminder', 'result'])
  })

  test('run now: a manual run, and not a second one while it runs', async () => {
    const t = mk({ nextDue: '2026-10-17T19:07:00.000Z' })
    let release!: () => void
    claude = () => new Promise(res => { release = () => res(OK()) })
    const r = rt.runNow(t.id)
    expect(r.runId).toMatch(new RegExp(`^${t.id}@manual-`))
    expect(rt.runNow(t.id).error).toBe('it is already running')
    release()
    await rt.idle()
    expect(store.getRun(r.runId!)!.trigger).toBe('manual')
    expect(store.getTask(t.id)!.nextDue).toBe('2026-10-17T19:07:00.000Z')
  })

  test('one broken task is parked for review and the others still run', async () => {
    const broken = mk({ name: 'Broken', trigger: { kind: 'cron', expr: 'not a cron' } })
    const fine = reminder()
    await tick()
    expect(store.getTask(broken.id)).toMatchObject({ state: 'paused', pauseReason: 'review' })
    expect(store.getTask(fine.id)!.state).toBe('done')
  })
})

describe('health', () => {
  const failing = () => { claude = async () => ({ ok: false, text: '', error: 'the server said no' }) }
  const nextDay = (t: Task) => { now = new Date(now.getTime() + 86_400_000); store.updateTask(t.id, { nextDue: now.toISOString() }) }

  test('one failure is quiet; two raise an alert, edited after that; five pause the task; a success says it recovered', async () => {
    failing()
    const t = mk()
    await tick()
    expect(posts).toEqual([])
    expect(acts.at(-1)).toContain('failed')
    nextDay(t); await tick()
    expect(posts).toMatchObject([{ kind: 'alert', opts: { loud: true, buttons: 'alert' } }])
    expect(posts[0].text).toContain('failed 2 times in a row. Last error: the server said no')
    const alertId = store.getTask(t.id)!.alertMsg
    nextDay(t); await tick()
    expect(posts[1].opts).toMatchObject({ edit: alertId, loud: false })
    nextDay(t); await tick()
    nextDay(t); await tick()
    expect(store.getTask(t.id)).toMatchObject({ state: 'paused', pauseReason: 'failures' })
    expect(posts.at(-1)!.opts.buttons).toBe('paused')
    // A person resumes it (from the next slot: a slot that ran never runs again), and it works.
    claude = async () => OK()
    store.updateTask(t.id, { state: 'active', pauseReason: undefined })
    nextDay(t); await tick()
    expect(posts.at(-1)).toMatchObject({ kind: 'alert', text: '✅ Nightly news is working again.', opts: { edit: alertId } })
    expect(store.getTask(t.id)!.alertMsg).toBeUndefined()
  })

  test('a live task says every failure', async () => {
    failing()
    mk({ says: 'live' })
    await tick()
    expect(posts).toMatchObject([{ kind: 'failure', text: '⚠️ Nightly news failed: the server said no' }])
  })

  test('a usage limit defers the run without counting as a failure; a one-off tries again later', async () => {
    claude = async () => ({ ok: false, text: '', usageLimited: true })
    const t = mk()
    await tick()
    expect(store.runsFor(t.id)[0].state).toBe('deferred')
    expect(store.getTask(t.id)).toMatchObject({ failStreak: 0, lastMark: 'deferred' })
    const once = mk({ name: 'Once', trigger: { kind: 'at', at: now.toISOString() }, nextDue: now.toISOString() })
    await tick()
    expect(store.getTask(once.id)!.nextDue).toBe(new Date(now.getTime() + 30 * 60_000).toISOString())
    // When the CLI says when the limit resets, a minute after that.
    const resets = new Date(now.getTime() + 2 * 3600_000)
    claude = async () => ({ ok: false, text: '', usageLimited: true, retryAt: resets })
    const twice = mk({ name: 'Twice', trigger: { kind: 'at', at: now.toISOString() }, nextDue: now.toISOString() })
    await tick()
    expect(store.getTask(twice.id)!.nextDue).toBe(new Date(resets.getTime() + 60_000).toISOString())
  })

  test('a task whose owner can no longer use the chat pauses instead of running', async () => {
    owner = false
    const t = mk()
    await tick()
    expect(store.getTask(t.id)).toMatchObject({ state: 'paused', pauseReason: 'owner' })
    expect(posts).toEqual([])
  })
})

describe('ends', () => {
  test('times: done after that many runs', async () => {
    const t = mk({ times: 2 })
    await tick()
    now = new Date('2026-10-17T19:07:00Z'); await tick()
    expect(store.getTask(t.id)).toMatchObject({ state: 'done', runsDone: 2 })
    expect(store.getTask(t.id)!.nextDue).toBeUndefined()
  })

  test('until: expired once the next slot would be after it', async () => {
    const t = mk({ until: '2026-10-17T20:00:00.000Z' })
    await tick()
    expect(store.getTask(t.id)!.state).toBe('active')
    now = new Date('2026-10-17T19:07:00Z'); await tick()
    expect(store.getTask(t.id)!.state).toBe('expired')
  })
})

test('after a restart, runs left open are interrupted and the topic is told, with a way to run again', async () => {
  const t = mk({ nextDue: '2026-10-17T19:07:00.000Z' })
  store.insertRun({ id: `${t.id}@x`, task: t.id, trigger: 'schedule', state: 'running', startedAt: '2026-10-16T19:07:00.000Z' })
  const r = rt.start()
  await new Promise(res => setTimeout(res, 0))
  expect(r.interrupted.map(x => x.id)).toEqual([`${t.id}@x`])
  expect(store.getRun(`${t.id}@x`)!.state).toBe('interrupted')
  expect(posts).toMatchObject([{ kind: 'notice', opts: { buttons: 'rerun' } }])
  expect(posts[0].text).toContain('the bot restarted while this was running')
})

describe('watchers', () => {
  let running: Set<string>
  let starts: string[]
  let canStart: boolean
  let looks: Map<string, PollResult>
  const fake: WatcherControl = {
    list: () => [...running],
    ensure: t => { if (!canStart) return false; if (!running.has(t.id)) starts.push(t.id); running.add(t.id); return true },
    stop: id => { running.delete(id) },
    poll: async t => looks.get(t.id) ?? { events: [], code: 0, err: '', upMs: 5 },
  }
  beforeEach(() => {
    running = new Set(); starts = []; canStart = true; looks = new Map()
    rt.stop()
    rt = new TaskRuntime(deps({ watchers: fake }))
  })
  const stream = (over: Partial<Task> = {}) => mk({
    name: 'Price watch', trigger: { kind: 'watch', command: 'python3 price.py' }, action: { kind: 'message', text: 'Below 300: {event}' },
    nextDue: undefined, until: '2026-10-23T19:07:00.000Z', ...over,
  })
  const ev = (text: string, at = now): WatchEvent => ({ at: at.toISOString(), text })
  const later = (ms: number) => { now = new Date(now.getTime() + ms) }

  test('an active streaming watcher is kept running; paused or deleted, it is stopped', async () => {
    const t = stream()
    rt.sync()
    expect([...running]).toEqual([t.id])
    rt.sync()
    expect(starts).toEqual([t.id])
    store.updateTask(t.id, { state: 'paused' }); rt.sync()
    expect(running.size).toBe(0)
    store.updateTask(t.id, { state: 'active' }); rt.sync()
    store.updateTask(t.id, { state: 'deleted' }); rt.sync()
    expect(running.size).toBe(0)
  })

  test('an event sends the message, with {event} filled in, loud, with a Pause button', async () => {
    const t = stream()
    rt.onEvents(t.id, [ev('{"price": 298}')])
    await rt.idle()
    expect(posts).toMatchObject([{ kind: 'reminder', text: 'Below 300: {"price": 298}', opts: { loud: true, buttons: 'pause' } }])
    expect(store.runsFor(t.id)[0]).toMatchObject({ trigger: 'event', state: 'succeeded', folded: 1 })
    expect(store.getTask(t.id)).toMatchObject({ state: 'active', eventsSeen: 1, runsDone: 1 })
  })

  test('within the cooldown, events wait and are folded into one run when it ends', async () => {
    const t = stream({ limits: { cooldownMs: 10 * 60_000 } })
    rt.onEvents(t.id, [ev('first')]); await rt.idle()
    later(60_000); rt.onEvents(t.id, [ev('second')])
    later(60_000); rt.onEvents(t.id, [ev('third')])
    await rt.idle()
    expect(posts.length).toBe(1)
    later(8 * 60_000 + 1); await tick()
    expect(posts.length).toBe(2)
    expect(posts[1].text).toBe('Below 300: third\n(+1 more since)')
    expect(store.runsFor(t.id)[0].folded).toBe(2)
  })

  test('at most so many runs an hour; past that, events wait for the hour to turn (if they keep that long)', async () => {
    const t = stream({ limits: { cooldownMs: 0, maxPerHour: 2, staleMs: 2 * 3600_000 } })
    for (const x of ['a', 'b', 'c']) { rt.onEvents(t.id, [ev(x)]); await rt.idle(); later(1000) }
    expect(posts.map(p => p.text)).toEqual(['Below 300: a', 'Below 300: b'])
    later(3600_000); await tick()
    expect(posts.map(p => p.text)).toEqual(['Below 300: a', 'Below 300: b', 'Below 300: c'])
  })

  test('stale events are dropped; a watcher kept running for its own sake only counts them', async () => {
    const t = stream()
    rt.onEvents(t.id, [ev('old news', new Date(now.getTime() - 11 * 60_000))])
    await rt.idle()
    expect(posts).toEqual([])
    expect(store.getTask(t.id)!.eventsSeen).toBe(1)
    const k = stream({ name: 'Sync', action: { kind: 'none' }, says: 'problems' })
    rt.onEvents(k.id, [ev('synced 12 files')])
    await rt.idle()
    expect(posts).toEqual([])
    expect(store.getTask(k.id)!.eventsSeen).toBe(1)
  })

  test("a Claude run gets the events; those that come during it start the next run after it", async () => {
    let release!: () => void
    const seen: Run[] = []
    claude = async (_t, r) => { seen.push(r); if (seen.length === 1) await new Promise<void>(res => { release = res }); return OK('Found why.') }
    const t = stream({ action: { kind: 'claude', prompt: 'Find out why it moved', session: 'fresh' }, limits: { cooldownMs: 0 } })
    rt.onEvents(t.id, [ev('moved -1.3% in 3 min')])
    await new Promise(res => setTimeout(res, 0))
    expect(seen[0].events!.map(e => e.text)).toEqual(['moved -1.3% in 3 min'])
    rt.onEvents(t.id, [ev('moved again'), ev('and again')])
    release()
    await rt.idle()
    expect(seen.length).toBe(2)
    expect(seen[1]).toMatchObject({ trigger: 'event', folded: 2 })
    expect(posts.filter(p => p.kind === 'result').length).toBe(2)
  })

  test('a watcher that dies is started again after a backoff; two in a row alert, five pause the task', async () => {
    const t = stream()
    rt.sync()
    const die = () => { running.delete(t.id); rt.onWatcherExit(t.id, { code: 1, err: 'Traceback…\nConnectionError: refused', upMs: 2000 }) }
    die()
    expect(acts.at(-1)).toContain('its watcher it ended with status 1: ConnectionError: refused')
    expect(store.getTask(t.id)!.watchRetryAt).toBe(new Date(now.getTime() + 5000).toISOString())
    rt.sync()
    expect(running.size).toBe(0)
    later(5000); rt.sync()
    expect(running.size).toBe(1)
    die(); await rt.idle()
    expect(posts).toMatchObject([{ kind: 'alert', opts: { loud: true, buttons: 'alert' } }])
    expect(posts[0].text).toContain('failed 2 times in a row')
    for (let i = 0; i < 3; i++) { later(20 * 60_000); rt.sync(); die(); await rt.idle() }
    expect(store.getTask(t.id)).toMatchObject({ state: 'paused', pauseReason: 'failures' })
    expect(running.size).toBe(0)
    expect(posts.at(-1)).toMatchObject({ kind: 'alert', opts: { buttons: 'paused' } })
  })

  test('one that ran a good while before it died starts its count afresh', () => {
    const t = stream({ watchFails: 3 })
    rt.onWatcherExit(t.id, { code: 0, err: '', upMs: 11 * 60_000 })
    expect(store.getTask(t.id)!.watchFails).toBe(1)
  })

  test("polled: at its slot it looks; what a failed look printed isn't news, and a good look clears the alert", async () => {
    const t = stream({ trigger: { kind: 'watch', command: 'python3 page.py', everyMs: 10 * 60_000, anchor: now.toISOString() }, nextDue: now.toISOString() })
    looks.set(t.id, { events: [{ at: now.toISOString(), text: 'Error: page not found' }], code: 1, err: '', upMs: 50 })
    await tick()
    later(10 * 60_000); await tick()
    expect(posts).toMatchObject([{ kind: 'alert' }])
    expect(posts[0].text).toContain('Error: page not found')
    expect(store.getTask(t.id)!.nextDue).toBe(new Date(now.getTime() + 10 * 60_000).toISOString())
    looks.set(t.id, { events: [{ at: now.toISOString(), text: 'price 289' }], code: 0, err: '', upMs: 50 })
    later(10 * 60_000); await tick()
    expect(posts.map(p => p.text)).toEqual([posts[0].text, '✅ Price watch is working again.', 'Below 300: price 289'])
    expect(store.getTask(t.id)!.watchFails).toBe(0)
  })

  test('times: 1 — done after the first event run, and its watcher stopped', async () => {
    const t = stream({ times: 1 })
    rt.sync()
    rt.onEvents(t.id, [ev('298')]); await rt.idle()
    expect(store.getTask(t.id)!.state).toBe('done')
    rt.sync()
    expect(running.size).toBe(0)
  })

  test('at its end date it ends, stops, and says so with a tap for another week', async () => {
    const t = stream()
    rt.sync()
    now = new Date('2026-10-23T19:07:00Z'); rt.sync(); await rt.idle()
    expect(store.getTask(t.id)!.state).toBe('expired')
    expect(running.size).toBe(0)
    expect(posts).toMatchObject([{ kind: 'notice', opts: { loud: false, buttons: 'renew' } }])
    expect(posts[0].text).toContain('has ended')
  })

  test("its owner can no longer use the chat: it pauses", () => {
    const t = stream()
    owner = false
    rt.sync()
    expect(store.getTask(t.id)).toMatchObject({ state: 'paused', pauseReason: 'owner' })
    expect(running.size).toBe(0)
  })

  test('a rule: only what passes starts a run, with its value and why; a crossing is remembered across a restart', async () => {
    const t = stream({ rule: { op: 'crosses_below', field: 'price', value: 300 }, action: { kind: 'message', text: 'Below 300 ({value}): {why}' }, limits: { cooldownMs: 0 } })
    rt.onEvents(t.id, [ev('{"price": 305}'), ev('{"price": 299}'), ev('{"price": 298}')])
    await rt.idle()
    expect(posts.map(p => p.text)).toEqual(['Below 300 (299): price went below 300: 299'])
    rt.stop(); rt = new TaskRuntime(deps({ watchers: fake }))
    rt.onEvents(t.id, [ev('{"price": 297}')]); await rt.idle()
    expect(posts.length).toBe(1)
    rt.onEvents(t.id, [ev('{"price": 301}'), ev('{"price": 296}')]); await rt.idle()
    expect(posts.length).toBe(2)
  })

  describe('the AI filter', () => {
    let asked: { q: string; items: string[] }[]
    let verdict: FilterVerdict | undefined
    beforeEach(() => {
      asked = []; verdict = { pass: [], by: 'haiku' }
      rt.stop()
      rt = new TaskRuntime(deps({ watchers: fake, filter: async (_t, q, items) => { asked.push({ q, items }); return verdict } }))
    })
    // Whatever was set to run later (the batch), now.
    const runLater = async () => { for (const x of timers.splice(0)) x.fn(); await rt.idle() }
    const filtered = (over: Partial<Task> = {}) => stream({
      name: 'Outage feed', rule: { op: 'contains', words: ['outage'] }, ai: { question: 'Is a major outage starting?', everyMs: 5 * 60_000 },
      action: { kind: 'claude', prompt: 'Check other sources and say what is happening', session: 'own' }, limits: { cooldownMs: 0 }, ...over,
    })

    test('what passes the rule waits for the batch; one question for all of it; what passes that starts one run, with why', async () => {
      const seen: Run[] = []
      claude = async (_t, r) => { seen.push(r); return OK('A major outage is starting in one region.') }
      const t = filtered()
      rt.onEvents(t.id, [ev('Minor outage fixed'), ev('Lunch menu'), ev('Major outage in one region')])
      await rt.idle()
      expect(asked).toEqual([])
      expect(seen).toEqual([])
      verdict = { pass: [{ n: 2, why: 'a new, major outage' }], by: 'haiku' }
      await runLater()
      expect(asked).toEqual([{ q: 'Is a major outage starting?', items: ['Minor outage fixed', 'Major outage in one region'] }])
      expect(seen.length).toBe(1)
      expect(seen[0].events).toMatchObject([{ text: 'Major outage in one region', why: 'a new, major outage' }])
      expect(store.getTask(t.id)).toMatchObject({ filterSeen: 2, filterPassed: 1 })
    })

    test('none pass: no run, only counted; with no candidates it asks nothing', async () => {
      const t = filtered()
      rt.onEvents(t.id, [ev('outage drill next week')])
      await runLater()
      expect(asked.length).toBe(1)
      expect(posts).toEqual([])
      expect(store.getTask(t.id)).toMatchObject({ filterSeen: 1, filterPassed: 0 })
      await runLater(); await tick()
      expect(asked.length).toBe(1)
    })

    test("if it can't answer, the batch is asked about again at the next one, and the card says so", async () => {
      const t = filtered()
      verdict = undefined
      rt.onEvents(t.id, [ev('outage?')])
      await runLater()
      expect(store.getTask(t.id)!.filterError).toContain('did not answer')
      expect(timers.some(x => x.ms === 5 * 60_000)).toBe(true)
      verdict = { pass: [{ n: 1, why: 'yes' }], by: 'haiku' }
      later(5 * 60_000)
      await runLater()
      expect(asked.map(a => a.items)).toEqual([['outage?'], ['outage?']])
      expect(store.getTask(t.id)!.filterError).toBeUndefined()
      expect(posts.filter(p => p.kind === 'result').length).toBe(1)
    })
  })

  test('run now: a polled one looks at once; a streaming one waiting out a backoff starts', async () => {
    const p = stream({ trigger: { kind: 'watch', command: 'python3 page.py', everyMs: 3600_000, anchor: now.toISOString() }, nextDue: '2026-10-17T00:00:00.000Z' })
    looks.set(p.id, { events: [{ at: now.toISOString(), text: 'x' }], code: 0, err: '', upMs: 5 })
    expect(rt.runNow(p.id)).toEqual({ runId: 'poll' })
    await rt.idle()
    expect(posts.map(x => x.text)).toEqual(['Below 300: x'])
    const s = stream({ watchRetryAt: new Date(now.getTime() + 60_000).toISOString() })
    expect(rt.runNow(s.id)).toEqual({ runId: 'watcher' })
    expect(running.has(s.id)).toBe(true)
  })
})

test('a watcher message: {event} is the newest line, and folded ones are counted', () => {
  const run = { id: 'x', task: 'x', trigger: 'event', state: 'queued', events: [{ at: '', text: 'a' }, { at: '', text: 'b' }], folded: 5 } as Run
  expect(eventText('Saw {event}!', run)).toBe('Saw b!\n(+4 more since)')
  expect(eventText('Something happened', { ...run, folded: 1, events: [{ at: '', text: 'c' }] })).toBe('Something happened\nc')
})

describe('scripts', () => {
  let outcome: ScriptOutcome
  let ran: Run[]
  beforeEach(() => {
    outcome = { code: 0, out: 'backup: 12 files\n', err: '', timedOut: false, durationMs: 1200 }
    ran = []
    rt.stop()
    rt = new TaskRuntime(deps({ runScript: async (_t, r) => { ran.push(r); return outcome } }))
  })
  const script = (over: Partial<Task> = {}) => mk({ name: 'Backup', action: { kind: 'script', command: 'bash backup.sh' }, says: 'result', ...over })

  test('result: what it printed is posted as a code block, and the next turn hears of it', async () => {
    const t = script()
    await tick()
    expect(posts).toMatchObject([{ kind: 'result', text: '```\nbackup: 12 files\n```', opts: { loud: true } }])
    expect(store.runsFor(t.id)[0]).toMatchObject({ state: 'succeeded', summary: 'backup: 12 files', usage: { durationMs: 1200 } })
    expect(notes[0]).toContain('ran its command')
  })

  test('noteworthy: only when it printed something', async () => {
    outcome = { ...outcome, out: '' }
    const t = script({ says: 'noteworthy' })
    await tick()
    expect(posts).toEqual([])
    expect(store.runsFor(t.id)[0]).toMatchObject({ state: 'succeeded', summary: 'nothing printed' })
  })

  test('problems: nothing when it works; every failure, loud, with its last lines', async () => {
    const t = script({ says: 'problems' })
    await tick()
    expect(posts).toEqual([])
    outcome = { code: 2, out: '', err: 'rsync: connection refused\n', timedOut: false, durationMs: 300 }
    now = new Date('2026-10-17T19:07:00Z'); await tick()
    expect(posts).toMatchObject([{ kind: 'failure', opts: { loud: true } }])
    expect(posts[0].text).toBe('⚠️ Backup failed: it exited with status 2: rsync: connection refused')
    expect(store.getTask(t.id)!.failStreak).toBe(1)
  })

  test('stopped by a person: canceled, not a failure', async () => {
    outcome = { code: null, out: '', err: '', timedOut: false, stopped: true, durationMs: 100 }
    const t = script()
    await tick()
    expect(store.runsFor(t.id)[0]).toMatchObject({ state: 'canceled', reason: 'stopped' })
    expect(store.getTask(t.id)!.failStreak).toBe(0)
  })

  test('at most so many at once; the rest wait their turn', async () => {
    let release!: () => void
    rt.stop()
    rt = new TaskRuntime(deps({ maxScripts: 1, runScript: async (_t, r) => { ran.push(r); if (ran.length === 1) await new Promise<void>(res => { release = res }); return outcome } }))
    script({ name: 'A' })
    script({ name: 'B', action: { kind: 'script', command: 'bash other.sh' } })
    await rt.tick()
    await new Promise(r => setTimeout(r, 0))
    expect(ran.length).toBe(1)
    release()
    await rt.idle()
    expect(ran.length).toBe(2)
  })
})

test('a digest lists what the topic\'s other tasks did since it last ran, silently, without Claude', async () => {
  const news = mk({ name: 'Nightly news' })
  claude = async () => OK('Five stories today.')
  await tick()
  const d = mk({ name: 'Digest', action: { kind: 'digest', of: [] }, sound: 'silent', trigger: { kind: 'cron', expr: '0 22 * * *' }, nextDue: '2026-10-16T22:00:00.000Z' })
  now = new Date('2026-10-16T22:00:00Z'); await tick()
  const digest = posts.filter(p => p.task === d.id)
  expect(digest.length).toBe(1)
  expect(digest[0]).toMatchObject({ kind: 'result', opts: { loud: false } })
  expect(digest[0].text).toContain('- **Nightly news**')
  expect(digest[0].text).toContain('1 run ✅')
  expect(store.runsFor(d.id)[0]).toMatchObject({ state: 'succeeded', summary: '1 task, 1 run' })
  // The next one starts where this one stopped: the slot the clock jumped over is
  // there, the run before is not.
  now = new Date('2026-10-17T22:00:00Z'); await tick()
  const second = posts.filter(p => p.task === d.id)[1].text
  expect(second).toContain('1 run ⏭')
  expect(second).not.toContain('✅')
  expect(store.getTask(news.id)!.state).toBe('active')
})

describe('questions', () => {
  const ask = (t: Task, runId: string, over: any = {}) => rt.ask(t.id, runId, { question: 'Which one goes first?', options: ['A', 'B'], waitMs: 60_000, ...over })
  const asked: any[] = []
  beforeEach(() => {
    asked.length = 0
    rt.stop()
    rt = new TaskRuntime(deps({ questionDone: w => { asked.push(w) } }))
  })

  test('posted for its owner, loud, with its options; an answer in time goes straight back to the run', async () => {
    const t = mk()
    const p = ask(t, `${t.id}@r1`)
    await new Promise(r => setTimeout(r, 0))
    expect(posts).toMatchObject([{ kind: 'question', text: 'Which one goes first?', opts: { loud: true, wait: { options: ['A', 'B'], state: 'open' } } }])
    const w = posts[0].opts.wait
    expect(store.getWait(w.id)!.askedMsg).toBe(101)
    expect(rt.answer(w.id, 'B', 'Ada', '1').ok).toBe(true)
    expect(await p).toEqual({ answer: 'B', by: 'Ada' })
    expect(store.getWait(w.id)).toMatchObject({ state: 'answered', answer: 'B', answeredBy: 'Ada', answeredById: '1' })
    expect(asked.map(x => x.state)).toEqual(['answered'])
    expect(rt.answer(w.id, 'A', 'Ben').error).toContain('answered already')
  })

  test("no answer in time: the run is told to stop, it ends waiting, and the answer carries it on in its session", async () => {
    const seen: Run[] = []
    let p: Promise<any> | undefined
    claude = async (_t, r) => {
      seen.push(r)
      if (seen.length === 1) {
        p = ask(_t, r.id)
        await new Promise(res => setTimeout(res, 0))
        timers.find(x => x.ms === 60_000)!.fn()       // nobody answered within its wait
        expect(await p).toEqual({ parked: true })
        return { ok: true, text: 'Waiting for the person.', sessionId: 'sess-asked' }
      }
      return OK('Done, with B first.')
    }
    const t = mk()
    await tick()
    const first = store.runsFor(t.id)[0]
    expect(first).toMatchObject({ state: 'waiting' })
    expect(first.reason).toContain('waiting for an answer: “Which one goes first?”')
    expect(store.getTask(t.id)!.lastMark).toBe('waiting')
    expect(posts.filter(x => x.kind === 'result')).toEqual([])
    const w = store.waitsForRun(first.id)[0]
    expect(w).toMatchObject({ state: 'parked', sessionId: 'sess-asked' })
    expect(rt.answer(w.id, 'B', 'Ada', '1').ok).toBe(true)
    await rt.idle()
    expect(seen[1]).toMatchObject({ trigger: 'answer', waitId: w.id })
    expect(store.getRun(first.id)).toMatchObject({ state: 'succeeded' })
    expect(posts.filter(x => x.kind === 'result').map(x => x.text)).toEqual(['Done, with B first.'])
  })

  test('after a day: the default answer if it had one, or let go', async () => {
    const t = mk({ trigger: { kind: 'cron', expr: '0 3 * * *' }, nextDue: '2026-10-17T03:00:00.000Z' })
    void ask(t, `${t.id}@r1`, { defaultAnswer: 'A' })
    void ask(t, `${t.id}@r2`, { question: 'Anything else?', options: undefined })
    await new Promise(r => setTimeout(r, 0))
    for (const w of store.openWaits()) store.updateWait(w.id, { state: 'parked' })
    now = new Date(now.getTime() + 25 * 3600_000)
    await rt.tick()
    const [a, b] = [store.openWaits(), asked]
    expect(a).toEqual([])
    expect(b.map(x => [x.question, x.state, x.answer ?? null])).toEqual([['Which one goes first?', 'answered', 'A'], ['Anything else?', 'expired', null]])
  })

  test('a restart parks a question whose run it cut off', () => {
    const t = mk()
    store.createWait({ task: t.id, run: `${t.id}@r9`, chat: t.chat, question: 'Go?', askedAt: now.toISOString(), deadline: new Date(now.getTime() + 3600_000).toISOString(), state: 'open' })
    rt.start()
    expect(store.openWaits()[0].state).toBe('parked')
  })
})

describe('plans', () => {
  let calls: StepCall[]
  let scripts: Record<string, ScriptOutcome[]>
  const ran = (name: string) => calls.filter(c => c.step.name === name).length
  beforeEach(() => {
    calls = []
    scripts = {}
    rt.stop()
    rt = new TaskRuntime(deps({
      runScript: async (_t, _r, call) => {
        calls.push(call!)
        const q = scripts[call!.step.name] ?? []
        return q.length > 1 ? q.shift()! : (q[0] ?? { code: 0, out: `${call!.step.name} ok\n`, err: '', timedOut: false, durationMs: 10 })
      },
    }))
    claude = async (_t, _r, call) => { if (call) calls.push(call); return OK(`scoped: ${call?.prior.map(p => p.name).join('+')}`) }
  })
  const plan = (steps: any[], over: Partial<Task> = {}) => mk({ name: 'Weekend fix', action: { kind: 'steps', steps }, says: 'result', ...over })
  const ok = (out = 'ok\n') => ({ code: 0, out, err: '', timedOut: false, durationMs: 5 })
  const bad = (err = 'tests: 37 of 40 passed') => ({ code: 1, out: '', err, timedOut: false, durationMs: 5 })

  test('steps in order, each told what came before; its progress edited as it goes; the last word is its result', async () => {
    const t = plan([{ name: 'fetch', kind: 'script', command: 'f' }, { name: 'scope', kind: 'claude', prompt: 'Scope it' }, { name: 'push', kind: 'script', command: 'p' }])
    await tick()
    expect(calls.map(c => [c.n, c.step.name, c.prior.length])).toEqual([[1, 'fetch', 0], [2, 'scope', 1], [3, 'push', 2]])
    const progress = posts.filter(p => p.kind === 'progress')
    expect(progress[0].text).toBe('🪜 Weekend fix: ⏳ fetch')
    expect(progress.at(-1)!.text).toBe('🪜 Weekend fix: ✅ fetch · ✅ scope · ✅ push\n✅ done')
    // One message, edited: the first post made it (the harness numbers it 101).
    expect(progress[0].opts.edit).toBeUndefined()
    expect(progress.slice(1).every(p => p.opts.edit === 101)).toBe(true)
    expect(posts.filter(p => p.kind === 'result').map(p => p.text)).toEqual(['push ok'])
    expect(store.runsFor(t.id)[0]).toMatchObject({ state: 'succeeded', summary: '✅ fetch · ✅ scope · ✅ push' })
  })

  test("the gates: a failing test goes to the fix, which is tried again told why; push only once they pass", async () => {
    scripts.tests = [bad(), ok('40 of 40\n')]
    const t = plan([
      { name: 'tests', kind: 'script', command: 't', onFail: 2 },
      { name: 'fix', kind: 'claude', prompt: 'Fix it', onPass: 3, retries: 1 },
      { name: 'tests again', kind: 'script', command: 't2', onPass: 4, onFail: 'stop' },
      { name: 'push', kind: 'script', command: 'p' },
    ])
    await tick()
    expect(calls.map(c => c.step.name)).toEqual(['tests', 'fix', 'tests again', 'push'])
    expect(calls[1].prior[0]).toMatchObject({ name: 'tests', ok: false, error: 'it exited with status 1: tests: 37 of 40 passed' })
    expect(store.runsFor(t.id)[0].state).toBe('succeeded')
  })

  test('a step that keeps failing: retried with how it failed, then the plan stops, loud, naming the step', async () => {
    scripts.build = [bad('compile error'), bad('compile error'), bad('compile error')]
    const t = plan([{ name: 'build', kind: 'script', command: 'b', retries: 2 }, { name: 'push', kind: 'script', command: 'p' }], { says: 'result' })
    await tick()
    expect(ran('build')).toBe(3)
    expect(calls[1].lastFailure).toBe('it exited with status 1: compile error')
    expect(ran('push')).toBe(0)
    expect(store.runsFor(t.id)[0]).toMatchObject({ state: 'failed' })
    expect(store.runsFor(t.id)[0].reason).toBe('step 1 (build): it exited with status 1: compile error')
    expect(posts.find(p => p.kind === 'failure')).toMatchObject({ opts: { loud: true } })
    expect(posts.filter(p => p.kind === 'progress').at(-1)!.text).toContain('❌ build ×3')
  })

  test('a loop that never ends is cut off', async () => {
    const t = plan([{ name: 'a', kind: 'script', command: 'a', onPass: 2 }, { name: 'b', kind: 'script', command: 'b', onPass: 1 }])
    await tick()
    expect(calls.length).toBe(50)
    expect(store.runsFor(t.id)[0].reason).toContain('went round 50 steps')
  })

  test('a question step: the plan waits, and the answer carries it on from the next step', async () => {
    let p: Promise<any> | undefined
    const asked: any[] = []
    rt.stop()
    rt = new TaskRuntime(deps({ runScript: async (_t, _r, call) => { calls.push(call!); return ok(`${call!.step.name} ok`) }, questionDone: w => { asked.push(w) } }))
    const t = plan([{ name: 'draft', kind: 'script', command: 'd' }, { name: 'which', kind: 'ask', question: 'Post it?', options: ['Yes', 'No'] }, { name: 'post', kind: 'script', command: 'p' }])
    void (p = rt.tick())
    await new Promise(r => setTimeout(r, 10))
    timers.find(x => x.ms === 10 * 60_000)!.fn()       // nobody answered within the wait
    await p; await rt.idle()
    expect(store.runsFor(t.id)[0]).toMatchObject({ state: 'waiting', stepAt: 2 })
    expect(calls.map(c => c.step.name)).toEqual(['draft'])
    const w = store.openWaits()[0]
    rt.answer(w.id, 'Yes', 'Ada', '1')
    await rt.idle()
    expect(calls.map(c => [c.step.name, c.prior.map(r => `${r.name}:${r.output}`).join(',')])).toEqual([['draft', ''], ['post', 'draft:draft ok,which:Yes']])
    expect(store.runsFor(t.id).find(r => r.trigger === 'answer')).toMatchObject({ state: 'succeeded' })
  })

  test('after a restart a plan carries on at the step it was at', async () => {
    const t = plan([{ name: 'one', kind: 'script', command: '1' }, { name: 'two', kind: 'script', command: '2' }])
    store.insertRun({ id: `${t.id}@x`, task: t.id, trigger: 'schedule', state: 'running', startedAt: now.toISOString(), stepAt: 2,
      stepResults: [{ step: 1, name: 'one', ok: true, output: 'one ok', attempt: 1, startedAt: now.toISOString() }] })
    const r = rt.start()
    expect(r.interrupted).toEqual([])
    await rt.idle()
    expect(calls.map(c => c.step.name)).toEqual(['two'])
    expect(store.getRun(`${t.id}@x`)!.state).toBe('succeeded')
  })

  test('a plan a person stops ends after the step going, canceled', async () => {
    let release!: () => void
    rt.stop()
    rt = new TaskRuntime(deps({ runScript: async (_t, _r, call) => { calls.push(call!); if (calls.length === 1) await new Promise<void>(res => { release = res }); return ok() } }))
    const t = plan([{ name: 'one', kind: 'script', command: '1' }, { name: 'two', kind: 'script', command: '2' }])
    void rt.tick()
    await new Promise(r => setTimeout(r, 10))
    expect(rt.stopPlan(t.id)).toBe(true)
    release()
    await rt.idle()
    expect(calls.map(c => c.step.name)).toEqual(['one'])
    expect(store.runsFor(t.id)[0]).toMatchObject({ state: 'canceled', reason: 'stopped' })
  })
})

describe('after, and child tasks', () => {
  const after = (source: Task, on: any, over: Partial<Task> = {}) => mk({
    name: 'Follow-up', trigger: { kind: 'after', task: source.id, name: source.name, on }, nextDue: undefined, ...over,
  })

  test('a task runs after another when its run meets the condition, given that run', async () => {
    const seen: Run[] = []
    claude = async (t, r) => { seen.push(r); return t.name === 'Report' ? { ...OK('The report.'), } : OK('Translated.') }
    const report = mk({ name: 'Report' })
    const onWork = after(report, 'success', { name: 'Translate' })
    const onFail = after(report, 'failure', { name: 'Fix', action: { kind: 'claude', prompt: 'Find out why', session: 'fresh' } })
    await tick()
    expect(seen.map(r => r.task)).toEqual([report.id, onWork.id])
    expect(seen[1]).toMatchObject({ trigger: 'after', after: { task: report.id, name: 'Report', outcome: 'noteworthy', depth: 1 } })
    expect(store.runsFor(onFail.id)).toEqual([])
  })

  test('a failure sets off what waits for one; a chain of them stops at five', async () => {
    claude = async () => ({ ok: false, text: '', error: 'boom' })
    const a = mk({ name: 'A' })
    const b = after(a, 'failure', { name: 'B' })
    await tick()
    expect(store.runsFor(b.id)[0]).toMatchObject({ trigger: 'after', after: { outcome: 'failure' } })
    // Five deep already: no sixth.
    const c = after(b, 'any', { name: 'C' })
    const deep = { id: `${b.id}@deep`, task: b.id, trigger: 'after', state: 'failed', after: { task: a.id, run: 'x', name: 'A', outcome: 'failure', depth: 5 } } as Run
    store.insertRun(deep)
    ;(rt as any).fireAfter(store.getTask(b.id)!, deep)
    await rt.idle()
    expect(store.runsFor(c.id).filter(r => r.after?.depth === 6)).toEqual([])
  })

  test('a child ends when its parent does, and says why', async () => {
    const parent = mk({ name: 'Parent' })
    const kid = mk({ name: 'Kid', parent: parent.id, parentName: 'Parent', childDepth: 1, nextDue: '2026-10-20T00:00:00.000Z' })
    store.updateTask(parent.id, { state: 'deleted' })
    rt.sync()
    await rt.idle()
    expect(store.getTask(kid.id)!.state).toBe('expired')
    expect(posts.find(p => p.task === kid.id)!.text).toContain('it was made by "Parent", which has ended')
  })
})
