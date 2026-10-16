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
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LIMITS, type Run, type RunMark, type Task, type Usage } from './model'
import type { TaskStore } from './store'
import { manualRunId, resolveDue, slotRunId } from './schedule'
import { markOf } from './render'

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
  buttons?: 'reminder' | 'alert' | 'paused' | 'rerun'
  run?: Run
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
}

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
  private timer: unknown
  private stopped = false
  private pending = new Set<Promise<void>>()

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
  }

  // Something changed (a task created, moved, resumed): look again now.
  wake(): void { this.arm(0) }

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

  // One pass over the due tasks.
  async tick(): Promise<void> {
    if (this.stopped) return
    const now = this.d.now()
    const warm = now.getTime() - this.d.startedAt.getTime() < WARMUP_MS
    let started = 0
    let deferUntil: number | undefined
    try {
      for (const t of this.store.dueTasks(now)) {
        // Claude runs wait out the first two minutes after a start; reminders don't.
        if (warm && t.action.kind === 'claude') {
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

  // A run now, outside the schedule. Its id, or why not.
  runNow(taskId: string): { runId?: string; error?: string } {
    const t = this.store.getTask(taskId)
    if (!t || t.state === 'deleted') return { error: 'no such task' }
    if (this.inFlight.has(t.id)) return { error: 'it is already running' }
    const run: Run = { id: manualRunId(t.id, this.d.now()), task: t.id, trigger: 'manual', state: 'queued' }
    if (!this.store.insertRun(run)) return { error: 'it was started a moment ago' }
    this.dispatch(t, run)
    return { runId: run.id }
  }

  private dispatch(t: Task, run: Run): void {
    this.inFlight.set(t.id, run.id)
    if (t.action.kind === 'claude' && this.claudeActive >= this.d.maxClaude) {
      this.waiting.push({ task: t.id, run: run.id })
      return
    }
    this.track(t.action.kind === 'message' ? this.execMessage(t, run, 0) : this.execClaude(t, run))
  }

  private track(p: Promise<void>): void {
    const q = p.catch(e => this.d.log(`[tasks] run failed unexpectedly: ${e}`)).finally(() => this.pending.delete(q))
    this.pending.add(q)
  }

  private startWaiting(): void {
    while (this.claudeActive < this.d.maxClaude && this.waiting.length) {
      const w = this.waiting.shift()!
      const t = this.store.getTask(w.task)
      const run = this.store.getRun(w.run)
      if (!t || !run || t.state === 'deleted') { this.inFlight.delete(w.task); if (run) this.store.updateRun(run.id, { state: 'canceled', reason: 'the task was deleted' }); continue }
      this.track(this.execClaude(t, run))
    }
  }

  // --- reminders --------------------------------------------------------------

  private async execMessage(t: Task, run: Run, attempt: number): Promise<void> {
    if (t.action.kind !== 'message') return
    const startedAt = this.d.now().toISOString()
    run = this.store.updateRun(run.id, { state: 'running', startedAt: run.startedAt ?? startedAt })!
    let msgId: number | undefined
    let error: string | undefined
    try {
      msgId = await this.d.post(t, 'reminder', t.action.text, { loud: t.sound === 'loud', lateMs: run.lateMs, buttons: 'reminder', run })
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
      return
    }
    run = this.store.updateRun(run.id, { state: 'succeeded', postedMsg: msgId, endedAt: end })!
    this.inFlight.delete(t.id)
    this.finishRun(t.id, run)
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
    }
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
  // (past its end date).
  private endIfFinished(t: Task, next: Date | undefined): Task {
    if (t.state !== 'active') return t
    if (t.times !== undefined && t.runsDone >= t.times) return this.store.updateTask(t.id, { state: 'done', nextDue: undefined })!
    if (t.nextDue) return t
    if (next) return t
    if (t.trigger.kind === 'at') return this.store.updateTask(t.id, { state: 'done' })!
    if (t.until) return this.store.updateTask(t.id, { state: 'expired' })!
    return t
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
    } else if (t.says === 'live') {
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
