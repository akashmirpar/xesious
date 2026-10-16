/**
 * runtime.ts — the loop that runs tasks, and what happens around each run: claiming
 * the slot, starting it, recording the outcome, deciding what to post, and the health
 * rules. Telegram and Claude are passed in (RuntimeDeps), so every rule here is tested
 * with a fake clock and no bot.
 *
 * One timer, set to the earliest due slot and re-checked at least every 30 s. A due
 * task is claimed with a guarded update before anything runs (store.claim), and a
 * run's id names its slot, so no slot runs twice, whatever restarts in between.
 *
 * After a restart: runs left open become interrupted (never replayed on their own);
 * each overdue task runs its latest slot once if still within its grace window
 * (schedule.resolveDue); Claude runs wait two minutes after start, and catch-ups are
 * started five at a time, so a restart is not a stampede.
 *
 * Watchers: sync() keeps every active streaming watcher running and stops the rest; a
 * polled one is run at its slots. What they print comes to onEvents: stale lines are
 * dropped, the task's rule (filters.ts) keeps the ones that pass, its AI filter, if it
 * has one, screens those in batches, and what is left waits for a run: at most one per
 * cooldown and so many an hour, events that come meanwhile folded into the next. A
 * watcher that dies is a failure of its own (onWatcherExit): started again with
 * backoff, alerting at two in a row and pausing the task at five.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { LIMITS, eventLimits, isStreaming, isWatch, type Run, type RunMark, type Task, type Usage, type WatchEvent } from './model'
import type { TaskStore } from './store'
import { manualRunId, nextAfter, resolveDue, slotRunId } from './schedule'
import { elapsedText, markOf, whenText } from './render'
import type { PollResult, WatcherExit } from './watchers'
import { applyRule } from './filters'
import { lastLines, outputBlock, type ScriptOutcome } from './scripts'

export interface ClaudeOutcome {
  ok: boolean              // the run finished and produced an answer
  text: string             // its final answer ('' when none)
  error?: string
  timedOut?: boolean
  usageLimited?: boolean   // stopped by a usage limit: deferred, not failed
  retryAt?: Date           // when that limit resets, if the CLI said
  canceled?: boolean       // a person stopped it
  sessionId?: string
  usage?: Usage
  denials?: string[]       // actions the permission mode blocked
}

export type PostKind = 'reminder' | 'result' | 'failure' | 'alert' | 'notice'

export interface PostOpts {
  loud: boolean
  lateMs?: number          // a reminder or catch-up that runs late
  edit?: number            // edit this message instead of sending a new one
  buttons?: 'reminder' | 'alert' | 'paused' | 'rerun' | 'renew' | 'pause'
  run?: Run
}

// What the runtime needs of the watcher supervisor (watchers.ts).
export interface WatcherControl {
  list(): string[]                  // the tasks whose streaming watcher is running
  ensure(task: Task): boolean       // running with its current command; false if it can't start
  stop(taskId: string): void
  poll(task: Task): Promise<PollResult>
}

export interface RuntimeDeps {
  store: TaskStore
  now(): Date
  log(s: string): void
  dataDir: string          // where run results are written (state/tasks)
  maxClaude: number        // scheduled Claude runs at once, across all tasks
  startedAt: Date
  // Is the person the task runs as still allowed where it posts?
  ownerAllowed(task: Task): boolean
  runClaude(task: Task, run: Run): Promise<ClaudeOutcome>
  // Post into the task's home (or the owner's DM); the message id, or undefined.
  post(task: Task, kind: PostKind, text: string, opts: PostOpts): Promise<number | undefined>
  cardChanged(task: Task): void
  // A note for the home topic's next turn, so its conversation knows what ran.
  note(task: Task, text: string): void
  activity(task: Task, text: string): void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  // Without it, watcher tasks are never started.
  watchers?: WatcherControl
  maxWatchers?: number     // streaming watchers at once, across every task (8)
  // The AI filter: which of these lines answer the task's question. undefined when
  // it couldn't answer (they are asked about again next time).
  filter?(task: Task, question: string, items: string[]): Promise<FilterVerdict | undefined>
  // A script's run (scripts.ts); without it, scripts fail.
  runScript?(task: Task, run: Run): Promise<ScriptOutcome>
  maxScripts?: number      // scripts at once, across every task (2)
}

export interface FilterVerdict { pass: { n: number; why: string }[]; by: string }

const FILTER_BATCH = 50

const WARMUP_MS = 2 * 60_000
const CATCHUP_BATCH = 5
const CATCHUP_GAP_MS = 5_000
const MAX_SLEEP_MS = 30_000
const REMINDER_RETRIES = [60_000, 5 * 60_000]
const DEFERRED_RETRY_MS = 30 * 60_000

export class TaskRuntime {
  private inFlight = new Map<string, string>()       // task id → its open run
  private waiting: { task: string; run: string }[] = []
  private claudeActive = 0
  private scriptActive = 0
  private timer: unknown
  private stopped = false
  private pending = new Set<Promise<void>>()
  private polling = new Set<string>()
  private filtering = new Set<string>()
  private later = new Map<string, unknown>()     // per task: a cooldown's end, a watcher's restart

  constructor(private d: RuntimeDeps) {}

  private get store() { return this.d.store }
  private setTimer(fn: () => void, ms: number) { return (this.d.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms) }
  private clearTimer(t: unknown) { (this.d.clearTimer ?? (x => clearTimeout(x as any)))(t) }

  // Close what a restart left open, then start the loop.
  start(): { interrupted: Run[] } {
    const interrupted = this.recover()
    this.arm()
    return { interrupted }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) this.clearTimer(this.timer)
    for (const t of this.later.values()) this.clearTimer(t)
    this.later.clear()
  }

  // Something changed (a task created, moved, resumed): look again now.
  wake(): void { this.sync(); this.arm(0) }

  // Do this for the task in ms, unless something is due for it sooner already.
  private soon(taskId: string, ms: number, fn: () => void): void {
    if (this.stopped) return
    const cur = this.later.get(taskId)
    if (cur) this.clearTimer(cur)
    this.later.set(taskId, this.setTimer(() => { this.later.delete(taskId); fn() }, Math.max(0, ms)))
  }

  // Runs open now, for the drain on shutdown.
  get busy(): number { return this.inFlight.size }

  // Resolves when nothing is running or waiting (tests; the drain).
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }

  isRunning(taskId: string): boolean { return this.inFlight.has(taskId) }

  private arm(delay?: number): void {
    if (this.stopped) return
    if (this.timer) this.clearTimer(this.timer)
    let ms = delay
    if (ms === undefined) {
      const due = this.store.earliestDue()
      ms = due ? new Date(due).getTime() - this.d.now().getTime() : MAX_SLEEP_MS
    }
    ms = Math.max(0, Math.min(MAX_SLEEP_MS, ms))
    this.timer = this.setTimer(() => { void this.tick() }, ms)
  }

  private recover(): Run[] {
    const open = this.store.openRuns()
    for (const r of open) {
      const run = this.store.updateRun(r.id, { state: 'interrupted', reason: 'the bot restarted during this run', endedAt: this.d.now().toISOString() })!
      const t = this.store.getTask(r.task)
      if (!t || t.state === 'deleted') continue
      const upd = this.store.updateTask(t.id, { lastMark: 'interrupted', lastRunAt: run.startedAt ?? t.lastRunAt })!
      void this.d.post(upd, 'notice', `✂️ ${t.name}: the bot restarted while this was running, so it stopped.`, { loud: false, buttons: 'rerun', run })
        .catch(e => this.d.log(`[tasks] interrupted notice for ${t.id}: ${e}`))
      this.d.cardChanged(upd)
    }
    return open
  }

  // One pass over the due tasks, the watchers, and the events waiting for a run.
  async tick(): Promise<void> {
    if (this.stopped) return
    try { this.sync() } catch (e) { this.d.log(`[tasks] watchers: ${e}`) }
    for (const id of this.store.tasksWithEvents()) this.fireEvents(id)
    for (const id of this.store.tasksWithEvents('candidate')) this.scheduleFilter(id)
    const now = this.d.now()
    const warm = now.getTime() - this.d.startedAt.getTime() < WARMUP_MS
    let started = 0
    let deferUntil: number | undefined
    try {
      for (const t of this.store.dueTasks(now)) {
        // Claude runs wait out the first two minutes after a start; reminders and a
        // watcher's looks don't.
        if (warm && t.action.kind === 'claude' && !isWatch(t)) {
          deferUntil = Math.min(deferUntil ?? Infinity, this.d.startedAt.getTime() + WARMUP_MS)
          continue
        }
        if (warm && started >= CATCHUP_BATCH) { deferUntil = Math.min(deferUntil ?? Infinity, now.getTime() + CATCHUP_GAP_MS); break }
        try {
          if (await this.fire(t, now)) started++
        } catch (e) {
          // One broken task must not stop the others: park it for a person to look at.
          this.d.log(`[tasks] ${t.id} could not be scheduled: ${e}`)
          const p = this.store.updateTask(t.id, { state: 'paused', pauseReason: 'review', nextDue: undefined })
          if (p) { this.d.activity(p, `⏸ ${p.name} paused: its schedule could not be worked out (${e})`); this.d.cardChanged(p) }
        }
      }
    } finally {
      this.arm(deferUntil !== undefined ? deferUntil - now.getTime() : undefined)
    }
  }

  // Claim the task's due slot and start (or skip) it. true when a run started.
  private async fire(t: Task, now: Date): Promise<boolean> {
    if (isWatch(t)) return this.firePoll(t, now)
    const due = new Date(t.nextDue!)
    const r = resolveDue(t.trigger, t.tz, due, now)
    let next = r.next
    if (next && t.until && next.getTime() > new Date(t.until).getTime()) next = undefined
    if (!this.store.claim(t.id, t.nextDue!, next?.toISOString())) return false
    let task = this.store.getTask(t.id)!

    if (r.missed > 0) {
      const reason = r.missed === 1 ? 'missed while the bot was down' : `${r.missed} runs missed while the bot was down`
      this.store.insertRun({ id: `${t.id}@missed-${t.nextDue}`, task: t.id, slot: t.nextDue, trigger: 'schedule', state: 'skipped', reason })
      this.d.activity(task, `⏭ ${t.name}: ${reason}`)
      if (!r.fire && t.action.kind === 'message') {
        await this.safePost(task, 'notice', `🔔 Missed while the bot was down: ${t.action.text}`, { loud: false })
      }
    }
    if (!r.fire) {
      task = this.endIfFinished(task, next)
      this.d.cardChanged(task)
      return false
    }

    if (!this.d.ownerAllowed(task)) {
      task = this.store.updateTask(t.id, { state: 'paused', pauseReason: 'owner', nextDue: undefined })!
      this.d.activity(task, `⏸ ${task.name} paused: the person it runs as can no longer use this chat`)
      this.d.cardChanged(task)
      return false
    }

    if (this.inFlight.has(t.id)) {
      this.store.insertRun({ id: slotRunId(t.id, r.fire), task: t.id, slot: r.fire.toISOString(), trigger: 'schedule', state: 'skipped', reason: 'still running' })
      this.d.cardChanged(task)
      return false
    }

    const run: Run = {
      id: slotRunId(t.id, r.fire), task: t.id, slot: r.fire.toISOString(),
      trigger: r.lateMs > 60_000 ? 'catchup' : 'schedule', state: 'queued',
      ...(r.lateMs > 60_000 ? { lateMs: r.lateMs } : {}),
    }
    if (!this.store.insertRun(run)) return false
    this.dispatch(task, run)
    return true
  }

  // A run now, outside the schedule. Its id, or why not. For a watcher: look now (a
  // polled one is run, a streaming one that is down is started without waiting).
  runNow(taskId: string): { runId?: string; error?: string } {
    const t = this.store.getTask(taskId)
    if (!t || t.state === 'deleted') return { error: 'no such task' }
    if (isWatch(t)) {
      if (t.state !== 'active') return { error: `it is ${t.state}` }
      if (isStreaming(t)) {
        this.store.updateTask(t.id, { watchRetryAt: undefined })
        this.sync()
        return this.d.watchers?.list().includes(t.id) ? { runId: 'watcher' } : { error: "its watcher couldn't be started" }
      }
      if (this.polling.has(t.id)) return { error: 'it is looking already' }
      this.track(this.pollOnce(t.id))
      return { runId: 'poll' }
    }
    if (this.inFlight.has(t.id)) return { error: 'it is already running' }
    const run: Run = { id: manualRunId(t.id, this.d.now()), task: t.id, trigger: 'manual', state: 'queued' }
    if (!this.store.insertRun(run)) return { error: 'it was started a moment ago' }
    this.dispatch(t, run)
    return { runId: run.id }
  }

  private dispatch(t: Task, run: Run): void {
    this.inFlight.set(t.id, run.id)
    if (!this.free(t)) {
      this.waiting.push({ task: t.id, run: run.id })
      return
    }
    this.track(this.exec(t, run))
  }

  // Room for one more of its kind: Claude runs and scripts have their caps.
  private free(t: Task): boolean {
    if (t.action.kind === 'claude') return this.claudeActive < this.d.maxClaude
    if (t.action.kind === 'script') return this.scriptActive < (this.d.maxScripts ?? 2)
    return true
  }

  private exec(t: Task, run: Run): Promise<void> {
    switch (t.action.kind) {
      case 'message': return this.execMessage(t, run, 0)
      case 'script': return this.execScript(t, run)
      default: return this.execClaude(t, run)
    }
  }

  private track(p: Promise<void>): void {
    const q = p.catch(e => this.d.log(`[tasks] run failed unexpectedly: ${e}`)).finally(() => this.pending.delete(q))
    this.pending.add(q)
  }

  private startWaiting(): void {
    for (let i = 0; i < this.waiting.length;) {
      const w = this.waiting[i]
      const t = this.store.getTask(w.task)
      const run = this.store.getRun(w.run)
      if (!t || !run || t.state === 'deleted') {
        this.waiting.splice(i, 1)
        this.inFlight.delete(w.task)
        if (run) this.store.updateRun(run.id, { state: 'canceled', reason: 'the task was deleted' })
        continue
      }
      if (!this.free(t)) { i++; continue }
      this.waiting.splice(i, 1)
      this.track(this.exec(t, run))
    }
  }

  // --- scripts ------------------------------------------------------------------

  private async execScript(t: Task, run: Run): Promise<void> {
    this.scriptActive++
    run = this.store.updateRun(run.id, { state: 'running', startedAt: this.d.now().toISOString() })!
    this.d.cardChanged(this.store.getTask(t.id) ?? t)
    let o: ScriptOutcome
    try {
      o = this.d.runScript ? await this.d.runScript(t, run) : { code: null, out: '', err: 'scripts are not available here', timedOut: false, durationMs: 0 }
    } catch (e) {
      o = { code: null, out: '', err: String((e as Error)?.message ?? e), timedOut: false, durationMs: 0 }
    } finally {
      this.scriptActive--
    }
    try {
      await this.settleScript(t.id, run.id, o)
    } finally {
      this.inFlight.delete(t.id)
      this.startWaiting()
      this.afterRun(t.id)
    }
  }

  // Its exit status decides. What it printed is posted as says has it: result (and
  // live) always, noteworthy when it printed something, problems only on failure.
  private async settleScript(taskId: string, runId: string, o: ScriptOutcome): Promise<void> {
    const t = this.store.getTask(taskId)!
    let run = this.store.getRun(runId)!
    const end = this.d.now().toISOString()
    const usage = { durationMs: o.durationMs }
    if (t.state === 'deleted') { this.store.updateRun(run.id, { state: 'canceled', reason: 'the task was deleted while it ran', endedAt: end, usage }); return }
    const all = [o.out.trim(), o.err.trim() ? `--- stderr\n${o.err.trim()}` : ''].filter(Boolean).join('\n')
    const resultPath = all ? this.writeResult(t, run, all) : undefined
    const base: Partial<Run> = { endedAt: end, usage, ...(resultPath ? { resultPath } : {}) }
    if (o.stopped) {
      run = this.store.updateRun(run.id, { ...base, state: 'canceled', reason: 'stopped' })!
      this.d.cardChanged(this.store.updateTask(t.id, { lastMark: 'interrupted', lastRunAt: run.startedAt })!)
      return
    }
    if (o.code !== 0 || o.timedOut) {
      const timeout = t.action.kind === 'script' ? t.action.timeoutMs ?? LIMITS.scriptTimeoutMs : LIMITS.scriptTimeoutMs
      const what = o.timedOut ? `it ran past ${elapsedText(timeout)} and was stopped` : o.code === null ? 'it was stopped before it finished' : `it exited with status ${o.code}`
      const said = lastLines(o.err || o.out)
      const reason = said ? `${what}: ${said}` : what
      run = this.store.updateRun(run.id, { ...base, state: o.timedOut ? 'timed_out' : 'failed', reason })!
      await this.onFailure(this.store.getTask(t.id)!, run, reason)
      return
    }
    const out = o.out.trim()
    const post = t.says === 'live' || t.says === 'result' || (t.says === 'noteworthy' && out !== '')
    let postedMsg: number | undefined
    if (post) {
      const text = out ? outputBlock(out) : `Done in ${elapsedText(o.durationMs)}, with nothing printed.`
      postedMsg = await this.safePost(t, 'result', text, { loud: t.sound === 'loud', lateMs: run.lateMs, run })
    }
    run = this.store.updateRun(run.id, { ...base, state: 'succeeded', summary: out ? lastLines(out, 1, 200) : 'nothing printed', ...(postedMsg ? { postedMsg } : {}) })!
    if (postedMsg) this.d.note(t, `The task "${t.name}" ran its command at ${new Date(run.startedAt ?? end).toISOString()} and posted: ${lastLines(out, 3, 280) || 'that it finished'}${resultPath ? ` (full output: ${resultPath})` : ''}`)
    this.finishRun(t.id, run)
  }

  // --- reminders --------------------------------------------------------------

  private async execMessage(t: Task, run: Run, attempt: number): Promise<void> {
    if (t.action.kind !== 'message') return
    const startedAt = this.d.now().toISOString()
    run = this.store.updateRun(run.id, { state: 'running', startedAt: run.startedAt ?? startedAt })!
    let msgId: number | undefined
    let error: string | undefined
    const event = run.trigger === 'event'
    try {
      msgId = await this.d.post(t, 'reminder', event ? eventText(t.action.text, run) : t.action.text,
        { loud: t.sound === 'loud', lateMs: run.lateMs, buttons: event ? 'pause' : 'reminder', run })
      if (msgId === undefined) error = 'Telegram did not accept the message'
    } catch (e) {
      error = String((e as Error)?.message ?? e)
    }
    if (error && attempt < REMINDER_RETRIES.length) {
      this.d.log(`[tasks] reminder ${t.id} failed (${error}); retrying`)
      await new Promise<void>(res => this.setTimer(res, REMINDER_RETRIES[attempt]))
      return this.execMessage(this.store.getTask(t.id) ?? t, run, attempt + 1)
    }
    const end = this.d.now().toISOString()
    if (error) {
      run = this.store.updateRun(run.id, { state: 'failed', reason: error, endedAt: end })!
      this.inFlight.delete(t.id)
      await this.onFailure(this.store.getTask(t.id)!, run, error)
      this.afterRun(t.id)
      return
    }
    run = this.store.updateRun(run.id, { state: 'succeeded', postedMsg: msgId, endedAt: end })!
    this.inFlight.delete(t.id)
    this.finishRun(t.id, run)
    this.afterRun(t.id)
  }

  // --- Claude runs ------------------------------------------------------------

  private async execClaude(t: Task, run: Run): Promise<void> {
    this.claudeActive++
    run = this.store.updateRun(run.id, { state: 'running', startedAt: this.d.now().toISOString() })!
    // Its card shows it running, with a way to stop it.
    this.d.cardChanged(this.store.getTask(t.id) ?? t)
    let o: ClaudeOutcome
    try {
      o = await this.d.runClaude(t, run)
    } catch (e) {
      o = { ok: false, text: '', error: String((e as Error)?.message ?? e) }
    } finally {
      this.claudeActive--
    }
    try {
      await this.settleClaude(t.id, run.id, o)
    } finally {
      this.inFlight.delete(t.id)
      this.startWaiting()
      this.afterRun(t.id)
    }
  }

  // A watcher's events that came during the run go into the next one.
  private afterRun(taskId: string): void {
    if (this.store.countEvents(taskId)) this.fireEvents(taskId)
  }

  private async settleClaude(taskId: string, runId: string, o: ClaudeOutcome): Promise<void> {
    let t = this.store.getTask(taskId)!
    let run = this.store.getRun(runId)!    // re-read: report() may have written to it
    const end = this.d.now().toISOString()
    if (t.state === 'deleted') {
      this.store.updateRun(run.id, { state: 'canceled', reason: 'the task was deleted while it ran', endedAt: end, usage: o.usage })
      return
    }
    const resultPath = o.text ? this.writeResult(t, run, o.text) : undefined
    const base: Partial<Run> = { endedAt: end, usage: o.usage, sessionId: o.sessionId, ...(o.denials?.length ? { denials: o.denials } : {}), ...(resultPath ? { resultPath } : {}) }
    if (t.action.kind === 'claude' && t.action.session === 'own' && o.sessionId) t = this.store.updateTask(t.id, { sessionId: o.sessionId })!

    if (o.usageLimited) {
      run = this.store.updateRun(run.id, { ...base, state: 'deferred', reason: 'stopped by the usage limit' })!
      // A one-off would never run otherwise: try again once the limit has reset (a
      // minute after, if the CLI said when), inside its window.
      if (t.trigger.kind === 'at' && t.state === 'active' && !t.nextDue) {
        const slot = new Date(run.slot ?? t.trigger.at).getTime()
        const retry = o.retryAt ? o.retryAt.getTime() + 60_000 : this.d.now().getTime() + DEFERRED_RETRY_MS
        if (retry - slot < LIMITS.oneOffGraceMs) t = this.store.updateTask(t.id, { nextDue: new Date(retry).toISOString() })!
      }
      t = this.store.updateTask(t.id, { lastMark: 'deferred', lastRunAt: run.startedAt })!
      this.d.activity(t, `⏳ ${t.name}: deferred by the usage limit`)
      this.d.cardChanged(t)
      this.arm()
      return
    }
    if (o.canceled) {
      run = this.store.updateRun(run.id, { ...base, state: 'canceled', reason: 'stopped' })!
      t = this.store.updateTask(t.id, { lastMark: 'interrupted', lastRunAt: run.startedAt })!
      this.d.cardChanged(t)
      return
    }
    if (!o.ok || o.timedOut) {
      const reason = o.timedOut ? 'it took too long and was stopped' : (o.error || 'it ended without an answer')
      run = this.store.updateRun(run.id, { ...base, state: o.timedOut ? 'timed_out' : 'failed', reason })!
      await this.onFailure(t, run, reason)
      return
    }

    // It worked. What gets posted follows the task's setting and the run's report.
    const text = (run.reportText || o.text || run.summary || '').trim()
    const post = this.shouldPost(t, run)
    let postedMsg: number | undefined
    if (post && text) {
      postedMsg = await this.safePost(t, 'result', text, { loud: t.sound === 'loud', lateMs: run.lateMs, run })
    }
    run = this.store.updateRun(run.id, { ...base, state: 'succeeded', ...(postedMsg ? { postedMsg } : {}) })!
    if (postedMsg && t.action.kind === 'claude') {
      const gist = run.summary || text.replace(/\s+/g, ' ').slice(0, 280)
      this.d.note(t, `The task "${t.name}" ran at ${new Date(run.startedAt ?? end).toISOString()} and posted: ${gist}${resultPath ? ` (full result: ${resultPath})` : ''}`)
    }
    this.finishRun(t.id, run)
  }

  private shouldPost(t: Task, run: Run): boolean {
    switch (t.says) {
      case 'live': case 'result': return true
      case 'noteworthy': return run.notify === true
      case 'problems': return run.outcome === 'blocked' || run.outcome === 'needs_attention'
      case 'never': return false
    }
  }

  private writeResult(t: Task, run: Run, text: string): string | undefined {
    try {
      const dir = join(this.d.dataDir, t.id)
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `${run.id.replace(/[^\w.-]+/g, '_')}.md`)
      writeFileSync(path, text)
      return path
    } catch (e) {
      this.d.log(`[tasks] could not write the result of ${run.id}: ${e}`)
      return undefined
    }
  }

  // --- after a run: counters, the end of a task, health -----------------------

  private finishRun(taskId: string, run: Run): void {
    let t = this.store.getTask(taskId)!
    const alert = t.alertMsg
    t = this.store.updateTask(t.id, {
      runsDone: t.runsDone + 1, failStreak: 0, lastRunAt: run.startedAt, lastMark: markOf(run) as RunMark,
      ...(alert !== undefined ? { alertMsg: undefined, alertAt: undefined } : {}),
    })!
    // The open failure alert is edited to say so, rather than a new message.
    if (alert !== undefined) void this.safePost(t, 'alert', `✅ ${t.name} is working again.`, { loud: false, edit: alert })
    t = this.endIfFinished(t, t.nextDue ? new Date(t.nextDue) : undefined)
    this.d.cardChanged(t)
  }

  // A task with nothing left to run is done (one-off, or out of runs) or expired
  // (past its end date). A watcher has no slots to run out of: only its end date or
  // its number of runs ends it.
  private endIfFinished(t: Task, next: Date | undefined): Task {
    if (t.state !== 'active') return t
    if (t.times !== undefined && t.runsDone >= t.times) {
      if (isWatch(t)) { this.d.watchers?.stop(t.id); this.store.dropEvents(t.id) }
      return this.store.updateTask(t.id, { state: 'done', nextDue: undefined })!
    }
    if (isWatch(t)) return t.until && Date.parse(t.until) <= this.d.now().getTime() ? this.expire(t) : t
    if (t.nextDue) return t
    if (next) return t
    if (t.trigger.kind === 'at') return this.store.updateTask(t.id, { state: 'done' })!
    if (t.until) return this.expire(t)
    return t
  }

  // Past its end date: it stops, and its topic is told, with a tap for another week.
  private expire(t: Task): Task {
    const task = this.store.updateTask(t.id, { state: 'expired', nextDue: undefined, watchRetryAt: undefined })!
    if (isWatch(task)) { this.d.watchers?.stop(task.id); this.store.dropEvents(task.id) }
    const until = task.until ? `: it was set to run until ${whenText(new Date(task.until), task.tz)}` : ''
    void this.safePost(task, 'notice', `⌛ ${task.name} has ended${until}.`, { loud: false, buttons: 'renew' })
    this.d.activity(task, `⌛ ${task.name} ended`)
    this.d.cardChanged(task)
    return task
  }

  // --- watchers ------------------------------------------------------------------

  // The streaming watchers, in line with their tasks: each active one running unless
  // it is waiting out a restart backoff, every other one stopped. One whose end date
  // has passed ends here, having no slots to end on.
  sync(): void {
    const now = this.d.now().getTime()
    const want = new Map<string, Task>()
    for (const t of this.store.listTasks({ states: ['active'] })) {
      if (!isWatch(t)) continue
      if (t.until && Date.parse(t.until) <= now) { this.expire(t); continue }
      // A watcher acts for its owner too: one who can no longer use the chat stops it.
      if (!this.d.ownerAllowed(t)) {
        const p = this.store.updateTask(t.id, { state: 'paused', pauseReason: 'owner', nextDue: undefined })!
        this.store.dropEvents(t.id)
        this.d.activity(p, `⏸ ${p.name} paused: the person it runs as can no longer use this chat`)
        this.d.cardChanged(p)
        continue
      }
      if (isStreaming(t)) want.set(t.id, t)
    }
    const w = this.d.watchers
    if (!w) return
    for (const id of w.list()) if (!want.has(id)) w.stop(id)
    const max = this.d.maxWatchers ?? 8
    for (const t of want.values()) {
      const running = w.list().includes(t.id)
      if (!running && t.watchRetryAt && Date.parse(t.watchRetryAt) > now) continue
      if (!running && w.list().length >= max) {
        const why = `waiting: the bot already keeps ${max} watchers running`
        if (t.watchError !== why) { this.store.updateTask(t.id, { watchError: why }); this.d.cardChanged(t) }
        continue
      }
      if (w.ensure(t)) {
        if (t.watchError?.startsWith('waiting')) { this.store.updateTask(t.id, { watchError: undefined }); this.d.cardChanged(t) }
        if (!running) this.d.cardChanged(this.store.getTask(t.id) ?? t)
      } else {
        this.onWatcherExit(t.id, { code: null, err: "it couldn't be started", upMs: 0 })
      }
    }
  }

  // A polled watcher's slot: run it, and set the next.
  private firePoll(t: Task, now: Date): boolean {
    let next = nextAfter(t.trigger, t.tz, now)
    if (next && t.until && next.getTime() > Date.parse(t.until)) next = undefined
    if (!this.store.claim(t.id, t.nextDue!, next?.toISOString())) return false
    if (!this.d.watchers || this.polling.has(t.id)) return false
    this.track(this.pollOnce(t.id))
    return true
  }

  private async pollOnce(taskId: string): Promise<void> {
    const t = this.store.getTask(taskId)
    if (!t || t.state !== 'active' || !this.d.watchers || this.polling.has(taskId)) return
    this.polling.add(taskId)
    let r: PollResult
    try {
      r = await this.d.watchers.poll(t)
    } catch (e) {
      r = { events: [], code: null, err: String((e as Error)?.message ?? e), upMs: 0 }
    } finally {
      this.polling.delete(taskId)
    }
    // A failed look's output is not news: it is the failure.
    const ok = r.code === 0 && !r.timedOut
    this.onWatcherExit(taskId, ok ? r : { ...r, err: r.err || r.events.map(e => e.text).join('\n') }, true)
    if (ok && r.events.length) this.onEvents(taskId, r.events)
  }

  // What a watcher printed. Stale lines are dropped, the rule keeps what passes it,
  // and the rest goes to the AI filter if the task has one, or else waits for a run.
  onEvents(taskId: string, events: WatchEvent[]): void {
    const t = this.store.getTask(taskId)
    if (!t || t.state !== 'active' || !events.length) return
    const lim = eventLimits(t)
    const now = this.d.now().getTime()
    this.store.updateTask(t.id, { eventsSeen: (t.eventsSeen ?? 0) + events.length, lastEventAt: events[events.length - 1].at })
    if (t.action.kind === 'none') return
    const fresh = events.filter(e => now - Date.parse(e.at) <= lim.staleMs)
    if (fresh.length < events.length) this.d.log(`[tasks] ${t.id}: ${events.length - fresh.length} stale event(s) dropped`)
    if (!fresh.length) return
    let passed = fresh
    if (t.rule) {
      const st = this.store.getRuleState(t.id)
      passed = []
      for (const e of fresh) {
        const r = applyRule(t.rule, st, e)
        if (r.pass) passed.push({ ...e, value: r.value, why: r.why })
      }
      this.store.setRuleState(t.id, st)
      if (!passed.length) return
    }
    if (t.ai) {
      this.store.addEvents(t.id, passed, 'candidate')
      this.scheduleFilter(t.id)
      return
    }
    this.store.addEvents(t.id, passed)
    this.fireEvents(t.id)
  }

  // The AI filter's next batch: once a batch interval after the last, and only when
  // there are candidates.
  private scheduleFilter(taskId: string): void {
    const key = `${taskId}:filter`
    if (this.later.has(key) || this.filtering.has(taskId)) return
    const t = this.store.getTask(taskId)
    if (!t?.ai || t.state !== 'active') { this.store.dropEvents(taskId); return }
    const wait = (t.lastFilterAt ? Date.parse(t.lastFilterAt) + t.ai.everyMs : 0) - this.d.now().getTime()
    this.soon(key, wait, () => this.track(this.runFilter(taskId)))
  }

  // One batch: the model is asked which candidates answer the task's question; those
  // that do, with why, wait for a run. Every decision is logged, and counted on the
  // card. If it couldn't answer, the batch is asked about again next time.
  private async runFilter(taskId: string): Promise<void> {
    const t = this.store.getTask(taskId)
    if (!t?.ai || t.state !== 'active') { this.store.dropEvents(taskId); return }
    if (this.filtering.has(taskId) || !this.d.filter) return
    const lim = eventLimits(t)
    const now = this.d.now()
    const all = this.store.takeEvents(t.id, 'candidate').filter(e => now.getTime() - Date.parse(e.at) <= lim.staleMs)
    if (!all.length) return
    // The newest, if a flood came: the ones left out are counted as not passed.
    const batch = all.slice(-FILTER_BATCH)
    this.filtering.add(taskId)
    let v: FilterVerdict | undefined
    try {
      v = await this.d.filter(t, t.ai.question, batch.map(e => e.text))
    } catch (e) {
      this.d.log(`[tasks] ${t.id}: the filter failed: ${e}`)
    } finally {
      this.filtering.delete(taskId)
    }
    const cur = this.store.getTask(taskId)
    if (!cur || cur.state !== 'active') return
    if (!v) {
      this.store.addEvents(t.id, batch, 'candidate')
      this.store.updateTask(t.id, { lastFilterAt: now.toISOString(), filterError: 'the AI filter did not answer; it asks again at its next batch' })
      this.d.cardChanged(this.store.getTask(t.id)!)
      this.scheduleFilter(t.id)
      return
    }
    const passed = v.pass.map(p => ({ ...batch[p.n - 1], why: p.why || batch[p.n - 1].why }))
    this.d.log(`[tasks] ${t.id}: the AI filter (${v.by}) passed ${passed.length} of ${all.length}${passed.length ? `: ${passed.map(e => e.why).join(' | ')}` : ''}`)
    this.store.updateTask(t.id, {
      lastFilterAt: now.toISOString(), filterError: undefined,
      filterSeen: (cur.filterSeen ?? 0) + all.length, filterPassed: (cur.filterPassed ?? 0) + passed.length,
    })
    if (cur.filterError) this.d.cardChanged(this.store.getTask(t.id)!)
    if (passed.length) { this.store.addEvents(t.id, passed); this.fireEvents(t.id) }
    if (this.store.countEvents(t.id, 'candidate')) this.scheduleFilter(t.id)
  }

  // A run for the events waiting, if the task may run now: not while one is going,
  // nor within the cooldown, nor past the hourly cap. Otherwise they wait, folded into
  // the run that comes when it may.
  fireEvents(taskId: string): void {
    const t = this.store.getTask(taskId)
    if (!t || t.state !== 'active' || !isWatch(t) || t.action.kind === 'none') { this.store.dropEvents(taskId); return }
    if (this.inFlight.has(t.id) || this.stopped) return
    const lim = eventLimits(t)
    const now = this.d.now().getTime()
    const cooled = t.lastEventRunAt ? Date.parse(t.lastEventRunAt) + lim.cooldownMs : 0
    if (cooled > now) { this.soon(t.id, cooled - now, () => this.fireEvents(t.id)); return }
    const hour = this.store.runsFor(t.id, lim.maxPerHour + 5)
      .filter(r => r.trigger === 'event' && r.startedAt && now - Date.parse(r.startedAt) < 3600_000)
      .map(r => Date.parse(r.startedAt!)).sort((a, b) => a - b)
    if (hour.length >= lim.maxPerHour) { this.soon(t.id, hour[0] + 3600_000 - now, () => this.fireEvents(t.id)); return }
    const all = this.store.takeEvents(t.id).filter(e => now - Date.parse(e.at) <= lim.staleMs)
    if (!all.length) return
    const run: Run = {
      id: `${t.id}@event-${now.toString(36)}.${randomBytes(3).toString('hex')}`, task: t.id, trigger: 'event', state: 'queued',
      events: all.slice(-LIMITS.eventsPerRun), folded: all.length,
    }
    // Never lose them: back they go if the run can't be recorded.
    if (!this.store.insertRun(run)) { this.store.addEvents(t.id, all); return }
    this.store.updateTask(t.id, { lastEventRunAt: new Date(now).toISOString() })
    this.dispatch(this.store.getTask(t.id)!, run)
  }

  // How a watcher ended, or how a look went. A good look clears a failure streak; a
  // failure counts, and a streaming watcher is started again after a backoff. Two in a
  // row raise an alert (edited in place after that), five pause the task.
  onWatcherExit(taskId: string, how: WatcherExit, poll = false): void {
    let t = this.store.getTask(taskId)
    if (!t || t.state === 'deleted' || !isWatch(t)) return
    const now = this.d.now()
    if (poll && how.code === 0 && !how.timedOut) {
      if (t.watchFails || t.watchError) {
        const alert = t.alertMsg
        t = this.store.updateTask(t.id, { watchFails: 0, watchError: undefined, ...(alert !== undefined ? { alertMsg: undefined, alertAt: undefined } : {}) })!
        if (alert !== undefined) void this.safePost(t, 'alert', `✅ ${t.name} is working again.`, { loud: false, edit: alert })
        this.d.cardChanged(t)
      }
      return
    }
    const what = how.timedOut ? `it didn't finish within ${elapsedText(LIMITS.pollTimeoutMs)}`
      : how.code === null ? 'it stopped without saying why'
      : poll ? `it exited with status ${how.code}` : how.code === 0 ? 'it ended' : `it ended with status ${how.code}`
    const said = how.err.trim().split('\n').filter(Boolean).pop()?.slice(0, 300)
    const error = said ? `${what}: ${said}` : what
    // A streaming watcher that ran a good while before it died starts a fresh count.
    const fails = !poll && how.upMs >= LIMITS.watchUpResetMs ? 1 : (t.watchFails ?? 0) + 1
    const backoff = LIMITS.watchBackoffMs[Math.min(fails, LIMITS.watchBackoffMs.length) - 1]
    t = this.store.updateTask(t.id, { watchFails: fails, watchError: error, ...(poll ? {} : { watchRetryAt: new Date(now.getTime() + backoff).toISOString() }) })!
    this.d.log(`[tasks] ${t.id}: watcher failed (${fails} in a row): ${error}`)
    if (fails >= LIMITS.failPauseAt) {
      t = this.store.updateTask(t.id, { state: 'paused', pauseReason: 'failures', nextDue: undefined, watchRetryAt: undefined })!
      this.d.watchers?.stop(t.id)
      this.store.dropEvents(t.id)
      const t2 = t
      void this.safePost(t2, 'alert', `⏸ ${t2.name}: its watcher failed ${fails} times in a row, so the task is paused. Last: ${error}`, { loud: true, edit: t2.alertMsg, buttons: 'paused' })
        .then(id => { if (id !== undefined) this.store.updateTask(t2.id, { alertMsg: id, alertAt: this.d.now().toISOString() }) })
      this.d.activity(t, `⏸ ${t.name} paused: its watcher kept failing`)
    } else if (fails >= LIMITS.failAlertAt) {
      const t2 = t
      const next = poll ? 'It looks again at its next check.' : `It starts again in ${elapsedText(backoff)}.`
      void this.safePost(t2, 'alert', `⚠️ ${t2.name}: its watcher failed ${fails} times in a row. Last: ${error}. ${next}`, { loud: !t2.alertMsg, edit: t2.alertMsg, buttons: 'alert' })
        .then(id => { if (id !== undefined) this.store.updateTask(t2.id, { alertMsg: id, alertAt: this.d.now().toISOString() }) })
      this.d.activity(t, `⚠️ ${t.name}: its watcher failed ${fails} times in a row`)
    } else {
      this.d.activity(t, `❌ ${t.name}: its watcher ${error}`)
    }
    this.d.cardChanged(t)
    if (!poll && t.state === 'active') this.soon(t.id, backoff, () => this.sync())
  }

  // Failures: one is recorded quietly; two in a row raise an alert, edited in place
  // after that; five pause the task. A live task's person is watching, so every
  // failure is said.
  private async onFailure(t: Task, run: Run, reason: string): Promise<void> {
    const streak = t.failStreak + 1
    t = this.store.updateTask(t.id, { failStreak: streak, lastRunAt: run.startedAt, lastMark: 'failed' })!
    if (streak >= LIMITS.failPauseAt) {
      t = this.store.updateTask(t.id, { state: 'paused', pauseReason: 'failures', nextDue: undefined })!
      const id = await this.safePost(t, 'alert', `⏸ ${t.name} failed ${streak} times in a row and is paused. Last error: ${reason}`, { loud: true, edit: t.alertMsg, buttons: 'paused', run })
      t = this.store.updateTask(t.id, { alertMsg: id ?? t.alertMsg, alertAt: this.d.now().toISOString() })!
      this.d.activity(t, `⏸ ${t.name} paused after ${streak} failures`)
    } else if (streak >= LIMITS.failAlertAt) {
      const id = await this.safePost(t, 'alert', `⚠️ ${t.name} failed ${streak} times in a row. Last error: ${reason}`, { loud: !t.alertMsg, edit: t.alertMsg, buttons: 'alert', run })
      t = this.store.updateTask(t.id, { alertMsg: id ?? t.alertMsg, alertAt: this.d.now().toISOString() })!
      this.d.activity(t, `⚠️ ${t.name} failed ${streak} times in a row`)
    } else if (t.says === 'live' || t.says === 'problems') {
      // Someone watching, or a task whose whole job is to say when something fails.
      await this.safePost(t, 'failure', `⚠️ ${t.name} failed: ${reason}`, { loud: true, run })
    } else {
      this.d.activity(t, `❌ ${t.name} failed: ${reason}`)
    }
    if (t.trigger.kind === 'at' && t.state === 'active' && !t.nextDue) t = this.store.updateTask(t.id, { state: 'done' })!
    this.d.cardChanged(t)
  }

  private async safePost(t: Task, kind: PostKind, text: string, opts: PostOpts): Promise<number | undefined> {
    try {
      return await this.d.post(t, kind, text, opts)
    } catch (e) {
      this.d.log(`[tasks] could not post ${kind} for ${t.id}: ${e}`)
      return undefined
    }
  }
}

// A watcher's message for its run: {event} is the newest line, {value} what its rule
// looked at, {why} why it passed; events folded into the run are counted. Without any
// of them, the line follows the text.
export function eventText(template: string, run: Run): string {
  const evs = run.events ?? []
  const last = evs[evs.length - 1]
  const more = (run.folded ?? evs.length) - 1
  const fill: Record<string, string> = { '{event}': last?.text ?? '', '{value}': last?.value ?? last?.text ?? '', '{why}': last?.why ?? '' }
  const used = Object.keys(fill).some(k => template.includes(k))
  const body = used ? template.replace(/\{event\}|\{value\}|\{why\}/g, k => fill[k]) : last ? `${template}\n${last.text}` : template
  return more > 0 ? `${body}\n(+${more} more since)` : body
}
