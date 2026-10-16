import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from './store'
import { TaskRuntime, type ClaudeOutcome, type RuntimeDeps } from './runtime'
import type { Run, Task } from './model'

let dir: string
let store: TaskStore
let now: Date
let posts: { task: string; kind: string; text: string; opts: any }[]
let notes: string[]
let acts: string[]
let timers: { fn: () => void; ms: number }[]
let owner: boolean
let claude: (t: Task, r: Run) => Promise<ClaudeOutcome>
let rt: TaskRuntime
let msg: number

const OK = (text = 'Five stories today.'): ClaudeOutcome => ({ ok: true, text, sessionId: 'sess-1', usage: { model: 'sonnet', inputTokens: 1000, outputTokens: 200, costUsd: 0.01 } })

function deps(over: Partial<RuntimeDeps> = {}): RuntimeDeps {
  return {
    store, now: () => now, log: () => {}, dataDir: join(dir, 'tasks'), maxClaude: 2,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    ownerAllowed: () => owner,
    runClaude: (t, r) => claude(t, r),
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
