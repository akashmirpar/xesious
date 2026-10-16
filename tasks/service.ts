/**
 * service.ts — what the API's task endpoints do. Validation, defaults, permissions and
 * the rules of each change live here; the bridge's side effects (posting the card,
 * waking the loop, starting a run) are passed in, so all of it is tested without a bot.
 *
 * Who may call what is decided by the caller's scope (api.ts):
 *   - a run started by a person's message (interactive) creates and manages tasks in
 *     its own chat, as that person;
 *   - a scheduled run sees only its own task: it can report, pause or finish it, and
 *     cannot create tasks yet (child tasks come with hand-offs, in phase 4);
 *   - the operator token (scripts on the host) can read and pause anything.
 */
import { LIMITS, type ReportOutcome, type Run, type Says, type Sound, type Task } from './model'
import type { TaskStore } from './store'
import { firstDue, isValidTz, parseLocalTime, parseWhen, type WhenInput } from './schedule'
import type { Scope } from './api'
import { markOf, scheduleText, whenText } from './render'

export interface TaskInput extends WhenInput {
  name?: string
  message?: string        // a reminder: post this text
  prompt?: string         // a Claude run: this instruction
  tz?: string
  session?: 'fresh' | 'own'
  says?: Says
  sound?: Sound
  deliver_to?: 'topic' | 'dm'
  until?: string          // local time in tz
  times?: number
}

export type Change = 'created' | 'updated' | 'paused' | 'resumed' | 'deleted' | 'done'
export type Action = 'pause' | 'resume' | 'edit' | 'delete' | 'run'

export interface ServiceDeps {
  store: TaskStore
  now(): Date
  // undefined = allowed; otherwise why not, in words the model can pass on.
  mayCreate(scope: Scope): string | undefined
  mayManage(scope: Scope, task: Task, action: Action): string | undefined
  isGroup(chat: string): boolean
  changed(task: Task, what: Change): void
  // Start a run of the task now; its id, or why it can't.
  runNow(task: Task): Promise<{ runId?: string; error?: string }> | { runId?: string; error?: string }
}

// Both branches name both fields, so reading .error after checking .ok type-checks
// without strict mode's narrowing.
export type Result<T = unknown> =
  | { ok: true; status?: number; value: T; error?: undefined }
  | { ok: false; status: number; error: string; value?: undefined }
const ok = <T>(value: T, status = 200): Result<T> => ({ ok: true, status, value })
const err = (status: number, error: string): Result<never> => ({ ok: false, status, error })

const SAYS: Says[] = ['live', 'result', 'noteworthy', 'problems', 'never']
const OUTCOMES: ReportOutcome[] = ['nothing_new', 'done', 'progress', 'blocked', 'needs_attention']
const MAX = { name: 80, message: 3500, prompt: 20_000, summary: 300, text: 30_000 }

// The task, as the model sees it.
export function taskView(t: Task, runs: Run[] = []) {
  const last = runs.find(r => r.state !== 'queued')
  return {
    id: t.id, name: t.name,
    kind: t.action.kind === 'message' ? 'reminder' : 'claude',
    schedule: scheduleText(t.trigger, t.tz), tz: t.tz,
    next_run: t.state === 'active' && t.nextDue ? `${whenText(new Date(t.nextDue), t.tz)} (${t.tz})` : undefined,
    state: t.state, pause_reason: t.pauseReason,
    ...(t.action.kind === 'message' ? { message: t.action.text } : { prompt: t.action.prompt, session: t.action.session, says: t.says }),
    sound: t.sound, deliver_to: t.where === 'dm' ? 'dm' : 'topic',
    topic: t.thread, runs_done: t.runsDone,
    last_run: last ? { when: whenText(new Date(last.startedAt ?? last.slot ?? Date.now()), t.tz), result: markOf(last), summary: last.summary, error: last.state === 'failed' ? last.reason : undefined } : undefined,
  }
}

export class TaskService {
  constructor(private deps: ServiceDeps) {}

  private get store() { return this.deps.store }

  // A task the caller may see: the run's own chat; for a scheduled run, only its own
  // task ('self' names it).
  private visible(scope: Scope, id: string): Result<Task> {
    if (scope.kind === 'run' && scope.runKind === 'scheduled') {
      if (id !== 'self' && id !== scope.taskId) return err(403, 'a scheduled run can only see its own task')
      id = scope.taskId ?? ''
    }
    const t = this.store.getTask(id)
    if (!t || t.state === 'deleted') return err(404, `no task ${id}`)
    if (scope.kind === 'run' && t.chat !== scope.chat) return err(404, `no task ${id}`)
    return ok(t)
  }

  // Fields from input, over a base task when updating. Everything is checked here,
  // and nothing is computed by the model.
  private build(input: TaskInput, base: Task | undefined, chat: string): Result<Omit<Task, 'id' | 'chat' | 'thread' | 'owner' | 'ownerName' | 'createdBy' | 'createdAt' | 'updatedAt' | 'state' | 'runsDone' | 'failStreak'>> {
    const now = this.deps.now()
    const tz = input.tz ?? base?.tz
    if (!tz) return err(400, "tz is required: the person's IANA time zone, such as Europe/Berlin. Work it out from what you know of them; if you can't tell, ask them first.")
    if (!isValidTz(tz)) return err(400, `unknown time zone "${tz}"; use an IANA name such as Europe/Berlin`)

    const timeGiven = ['at', 'in_minutes', 'every_minutes', 'cron'].some(k => (input as any)[k] !== undefined && (input as any)[k] !== null && (input as any)[k] !== '')
    let trigger = base?.trigger
    if (timeGiven || !base) {
      const w = parseWhen(input, tz, now)
      if (w.error) return err(400, w.error)
      trigger = w.trigger
    }

    let action = base?.action
    const hasMsg = typeof input.message === 'string' && input.message.trim() !== ''
    const hasPrompt = typeof input.prompt === 'string' && input.prompt.trim() !== ''
    if (hasMsg && hasPrompt) return err(400, 'give message (a reminder) or prompt (a Claude run), not both')
    if (hasMsg) {
      if (input.message!.length > MAX.message) return err(400, `message is too long (at most ${MAX.message} characters)`)
      action = { kind: 'message', text: input.message!.trim() }
    } else if (hasPrompt) {
      if (input.prompt!.length > MAX.prompt) return err(400, `prompt is too long (at most ${MAX.prompt} characters)`)
      const session = input.session ?? (base?.action.kind === 'claude' ? base.action.session : 'fresh')
      action = { kind: 'claude', prompt: input.prompt!.trim(), session }
    } else if (!base) {
      return err(400, 'give message (what to send, for a reminder) or prompt (what Claude should do when it runs)')
    } else if (input.session && base.action.kind === 'claude') {
      action = { ...base.action, session: input.session }
    }
    if (input.session && input.session !== 'fresh' && input.session !== 'own') return err(400, 'session is fresh or own')

    if (input.says !== undefined && !SAYS.includes(input.says)) return err(400, `says is one of ${SAYS.join(', ')}`)
    if (input.sound !== undefined && input.sound !== 'loud' && input.sound !== 'silent') return err(400, 'sound is loud or silent')
    if (input.deliver_to !== undefined && input.deliver_to !== 'topic' && input.deliver_to !== 'dm') return err(400, 'deliver_to is topic or dm')

    const says: Says = action!.kind === 'message' ? 'result' : (input.says ?? base?.says ?? 'result')
    // Loud for what the person asked to receive and for what speaks only when it
    // matters; a result in a group is silent unless asked otherwise.
    const defaultSound: Sound = action!.kind === 'message' || says === 'noteworthy' || says === 'problems' ? 'loud'
      : this.deps.isGroup(chat) ? 'silent' : 'loud'
    const sound = input.sound ?? base?.sound ?? defaultSound

    let name = (input.name ?? base?.name ?? '').trim()
    if (!name) {
      const src = action!.kind === 'message' ? action!.text : action!.prompt
      name = src.replace(/\s+/g, ' ').slice(0, 40).trim() + (src.length > 40 ? '…' : '')
    }
    if (name.length > MAX.name) return err(400, `name is too long (at most ${MAX.name} characters)`)

    let until = base?.until
    if (input.until !== undefined) {
      if (input.until === '' || input.until === null as any) until = undefined
      else {
        const u = parseLocalTime(String(input.until), tz)
        if (!u) return err(400, `can't read until "${input.until}"; use "YYYY-MM-DD HH:MM"`)
        if (u.getTime() <= now.getTime()) return err(400, 'until has already passed')
        until = u.toISOString()
      }
    }
    let times = base?.times
    if (input.times !== undefined) {
      const n = Number(input.times)
      if (!Number.isInteger(n) || n < 1) return err(400, 'times is a whole number, at least 1')
      times = n
    }

    // Undefined for a one-off whose time has passed: fine for renaming a reminder that
    // went out, not for creating one or giving it a new schedule (the callers check).
    const nextDue = firstDue(trigger!, tz, now)
    return ok({
      name, trigger: trigger!, tz, action: action!, says, sound,
      where: input.deliver_to ? (input.deliver_to === 'dm' ? 'dm' : 'home') : (base?.where ?? 'home'),
      until, times, nextDue: nextDue?.toISOString(),
    } as any)
  }

  create(scope: Scope, input: TaskInput): Result<{ task: Task; duplicate?: boolean }> {
    if (scope.kind !== 'run' || !scope.chat || !scope.person) return err(403, 'tasks are created from a conversation, as the person who asked')
    if (scope.runKind === 'scheduled') return err(403, "a scheduled run can't create tasks")
    const why = this.deps.mayCreate(scope)
    if (why) return err(403, why)
    const b = this.build(input, undefined, scope.chat)
    if (!b.ok) return err(b.status, b.error)
    if (!b.value.nextDue) return err(400, 'that time has already passed')
    const dup = this.store.findDuplicate(scope.chat, scope.thread, b.value)
    if (dup) return ok({ task: dup, duplicate: true })
    if (this.store.countInTopic(scope.chat, scope.thread) >= LIMITS.tasksPerTopic) {
      return err(409, `this topic already has ${LIMITS.tasksPerTopic} tasks; delete one first`)
    }
    const task = this.store.createTask({
      ...b.value, chat: scope.chat, thread: scope.thread, owner: scope.person, ownerName: scope.personName,
      createdBy: `person:${scope.person}`,
    }, this.deps.now())
    this.deps.changed(task, 'created')
    return ok({ task }, 201)
  }

  update(scope: Scope, id: string, input: TaskInput): Result<{ task: Task }> {
    const v = this.visible(scope, id)
    if (!v.ok) return err(v.status, v.error)
    if (scope.runKind === 'scheduled') return err(403, "a scheduled run can't change its task; it can pause or finish it")
    const why = this.deps.mayManage(scope, v.value, 'edit')
    if (why) return err(403, why)
    const b = this.build(input, v.value, v.value.chat)
    if (!b.ok) return err(b.status, b.error)
    const t = v.value
    const retimed = JSON.stringify(b.value.trigger) !== JSON.stringify(t.trigger) || b.value.tz !== t.tz
    if (retimed && !b.value.nextDue) return err(400, 'that time has already passed')
    const patch: Partial<Task> = { ...b.value }
    // A changed schedule replaces the old one; an unchanged one keeps its next slot.
    if (!retimed) patch.nextDue = t.nextDue
    if (retimed && (t.state === 'done' || t.state === 'expired')) { patch.state = 'active'; patch.runsDone = 0 }
    if (t.state === 'paused') patch.nextDue = undefined
    const task = this.store.updateTask(t.id, patch, this.deps.now())!
    this.deps.changed(task, 'updated')
    return ok({ task })
  }

  pause(scope: Scope, id: string): Result<{ task: Task }> {
    const v = this.visible(scope, id)
    if (!v.ok) return err(v.status, v.error)
    const why = this.deps.mayManage(scope, v.value, 'pause')
    if (why) return err(403, why)
    if (v.value.state !== 'active') return err(409, `it is ${v.value.state}, not active`)
    const task = this.store.updateTask(v.value.id, { state: 'paused', pauseReason: 'person', nextDue: undefined }, this.deps.now())!
    this.deps.changed(task, 'paused')
    return ok({ task })
  }

  // A resumed task starts from now: what it would have run while paused is not owed.
  resume(scope: Scope, id: string): Result<{ task: Task }> {
    const v = this.visible(scope, id)
    if (!v.ok) return err(v.status, v.error)
    if (scope.runKind === 'scheduled') return err(403, "a scheduled run can't resume its task")
    const why = this.deps.mayManage(scope, v.value, 'resume')
    if (why) return err(403, why)
    const t = v.value
    if (t.state !== 'paused') return err(409, `it is ${t.state}, not paused`)
    const next = firstDue(t.trigger, t.tz, this.deps.now())
    if (!next) return err(409, 'its time has passed while it was paused; give it a new time with task_update')
    const task = this.store.updateTask(t.id, { state: 'active', pauseReason: undefined, failStreak: 0, nextDue: next.toISOString() }, this.deps.now())!
    this.deps.changed(task, 'resumed')
    return ok({ task })
  }

  remove(scope: Scope, id: string): Result<{ task: Task }> {
    const v = this.visible(scope, id)
    if (!v.ok) return err(v.status, v.error)
    if (scope.runKind === 'scheduled') return err(403, "a scheduled run can't delete its task; it can finish it with task_done")
    const why = this.deps.mayManage(scope, v.value, 'delete')
    if (why) return err(403, why)
    const task = this.store.updateTask(v.value.id, { state: 'deleted', nextDue: undefined }, this.deps.now())!
    this.deps.changed(task, 'deleted')
    return ok({ task })
  }

  // A scheduled run says its task's work is finished for good.
  done(scope: Scope): Result<{ task: Task }> {
    if (scope.runKind !== 'scheduled') return err(403, 'only a task\'s own run can finish it; to stop a task, pause or delete it')
    const v = this.visible(scope, 'self')
    if (!v.ok) return err(v.status, v.error)
    const task = this.store.updateTask(v.value.id, { state: 'done', nextDue: undefined }, this.deps.now())!
    this.deps.changed(task, 'done')
    return ok({ task })
  }

  async runNow(scope: Scope, id: string): Promise<Result<{ runId: string }>> {
    const v = this.visible(scope, id)
    if (!v.ok) return err(v.status, v.error)
    if (scope.runKind === 'scheduled') return err(403, "a scheduled run can't start another run")
    const why = this.deps.mayManage(scope, v.value, 'run')
    if (why) return err(403, why)
    const r = await this.deps.runNow(v.value)
    if (!r.runId) return err(409, r.error ?? "it couldn't start")
    return ok({ runId: r.runId })
  }

  get(scope: Scope, id: string): Result<ReturnType<typeof taskView>> {
    const v = this.visible(scope, id)
    if (!v.ok) return err(v.status, v.error)
    return ok(taskView(v.value, this.store.runsFor(v.value.id, 5)))
  }

  list(scope: Scope, where: 'topic' | 'chat' | undefined, chat?: string): Result<ReturnType<typeof taskView>[]> {
    let tasks: Task[]
    if (scope.kind === 'operator') tasks = this.store.listTasks(chat ? { chat } : {})
    else if (scope.runKind === 'scheduled') {
      const t = scope.taskId ? this.store.getTask(scope.taskId) : undefined
      tasks = t ? [t] : []
    } else {
      const inTopic = (where ?? (scope.thread !== undefined ? 'topic' : 'chat')) === 'topic'
      tasks = this.store.listTasks({ chat: scope.chat, ...(inTopic ? { thread: scope.thread ?? null } : {}) })
    }
    return ok(tasks.map(t => taskView(t, this.store.runsFor(t.id, 1))))
  }

  // The run's verdict on itself: once per run.
  report(scope: Scope, body: { outcome?: string; notify?: boolean; summary?: string; text?: string }): Result<{ recorded: true }> {
    if (scope.runKind !== 'scheduled' || !scope.runId) return err(403, 'report is for a task\'s own run; in a conversation, just answer')
    const run = this.store.getRun(scope.runId)
    if (!run) return err(404, 'this run is not recorded')
    if (run.outcome) return err(409, 'report was already called for this run')
    if (!OUTCOMES.includes(body.outcome as ReportOutcome)) return err(400, `outcome is one of ${OUTCOMES.join(', ')}`)
    if (typeof body.notify !== 'boolean') return err(400, 'notify is true or false')
    const summary = String(body.summary ?? '').trim()
    if (!summary) return err(400, 'summary is required: one line on what this run found or did')
    if (summary.length > MAX.summary) return err(400, `summary is at most ${MAX.summary} characters`)
    const text = body.text === undefined ? undefined : String(body.text)
    if (text && text.length > MAX.text) return err(400, `text is at most ${MAX.text} characters`)
    this.store.updateRun(run.id, { outcome: body.outcome as ReportOutcome, notify: body.notify, summary, reportText: text?.trim() || undefined })
    return ok({ recorded: true })
  }
}
