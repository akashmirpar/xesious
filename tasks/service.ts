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
import { LIMITS, eventLimits, hasNoSlots, isStreaming, type EventLimits, type ReportOutcome, type Run, type Says, type Sound, type Step, type Task, type Trigger } from './model'
import type { TaskStore } from './store'
import { randomBytes } from 'node:crypto'
import { firstDue, isValidTz, parseLocalTime, parseWhen, type WhenInput } from './schedule'
import type { Scope } from './api'
import { markOf, scheduleText, whenText } from './render'
import { ruleError, ruleText, toRule } from './filters'

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
  // A watcher instead of a time: a program the bot runs (every_minutes) or keeps running.
  watch?: { command?: string; every_minutes?: number } | string
  keep_running?: boolean  // a watcher with no action, kept running for its own sake
  cooldown_minutes?: number
  max_per_hour?: number
  stale_minutes?: number
  script?: string | { command?: string; timeout_minutes?: number }   // a command, no AI
  watch_tasks?: string[]  // with prompt: tasks (ids or names) whose recent runs come with each run
  topic?: string | number // task_create: the topic it lives in, when not the caller's
  then?: { handoff_to?: string; brief?: string } | null   // on success, its result handed to this topic
  steps?: any[]           // a plan: steps with gates (checked here, step by step)
  after?: { task?: string; on?: 'success' | 'noteworthy' | 'failure' | 'any' } | null  // runs after another task's run
  webhook?: boolean       // runs only when fired (xesious fire, or its webhook)
  digest?: { of?: string[] } | boolean   // a list of what tasks did, no AI
  rule?: any              // filters.ruleError says what it may be; null removes it
  ai_filter?: { question?: string; every_minutes?: number } | null
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
  maxWatchers?: number    // streaming watchers the bot keeps running at once
  // A topic of a chat, by id or name ("General" too): its thread, or undefined if none.
  topicOf?(chat: string, ref: string): { thread?: number; name?: string } | undefined
  // Run it now with what it was fired with.
  fire?(task: Task, payload: string): { runId?: string; error?: string }
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
  const lim = eventLimits(t)
  return {
    id: t.id, name: t.name,
    kind: t.trigger.kind === 'watch' ? 'watch' : t.action.kind === 'message' ? 'reminder' : 'claude',
    schedule: scheduleText(t.trigger, t.tz), tz: t.tz,
    next_run: t.state === 'active' && t.nextDue ? `${whenText(new Date(t.nextDue), t.tz)} (${t.tz})` : undefined,
    ends: t.until ? `${whenText(new Date(t.until), t.tz)} (${t.tz})` : undefined,
    state: t.state, pause_reason: t.pauseReason,
    ...(t.trigger.kind === 'watch' ? {
      watch: { command: t.trigger.command, ...(t.trigger.everyMs ? { every_minutes: t.trigger.everyMs / 60_000 } : { streaming: true }) },
      ...(t.action.kind !== 'none' ? { cooldown_minutes: lim.cooldownMs / 60_000, max_per_hour: lim.maxPerHour, stale_minutes: lim.staleMs / 60_000 } : {}),
      events_seen: t.eventsSeen ?? 0, watcher_error: t.watchError,
      ...(t.rule ? { rule: ruleText(t.rule) } : {}),
      ...(t.ai ? { ai_filter: { question: t.ai.question, every_minutes: t.ai.everyMs / 60_000, considered: t.filterSeen ?? 0, passed: t.filterPassed ?? 0, error: t.filterError } } : {}),
    } : {}),
    ...(t.action.kind === 'message' ? { message: t.action.text }
      : t.action.kind === 'claude' ? { prompt: t.action.prompt, session: t.action.session, says: t.says, ...(t.action.watch?.length ? { watch_tasks: t.action.watch } : {}) }
      : t.action.kind === 'script' ? { script: { command: t.action.command, timeout_minutes: (t.action.timeoutMs ?? LIMITS.scriptTimeoutMs) / 60_000 }, says: t.says }
      : t.action.kind === 'digest' ? { digest: { of: t.action.of } }
      : t.action.kind === 'steps' ? { steps: t.action.steps.map((s, i) => ({ step: i + 1, ...s })), says: t.says }
      : { keep_running: true }),
    sound: t.sound, deliver_to: t.where === 'dm' ? 'dm' : 'topic',
    ...(t.then ? { then: { handoff_to: t.then.topicName ?? t.then.thread ?? 'General', brief: t.then.brief } } : {}),
    ...(t.trigger.kind === 'webhook' ? { webhook: { fire: `bun tasks/cli.ts fire ${t.id} "<payload>"`, http_path: `/hook/${t.id}/${t.trigger.secret}` } } : {}),
    topic: t.thread, runs_done: t.runsDone,
    last_run: last ? { when: whenText(new Date(last.startedAt ?? last.slot ?? Date.now()), t.tz), result: markOf(last), summary: last.summary, error: last.state === 'failed' ? last.reason : undefined } : undefined,
  }
}

// What watch: gives, as a trigger. A polled watcher is first run at once, so the
// person sees it work.
function parseWatch(w: TaskInput['watch'], now: Date): { trigger?: Trigger; error?: string } {
  const o: any = typeof w === 'string' ? { command: w } : (w ?? {})
  const command = String(o.command ?? '').trim()
  if (!command) return { error: 'watch needs command: the program to run in this topic\'s folder, e.g. "python3 watchers/price.py"' }
  if (command.length > LIMITS.watchCommandMax) return { error: `watch.command is too long (at most ${LIMITS.watchCommandMax} characters)` }
  if (o.every_minutes === undefined || o.every_minutes === null || o.every_minutes === '') return { trigger: { kind: 'watch', command } }
  const m = Number(o.every_minutes)
  if (!(m * 60_000 >= LIMITS.minEveryMs)) return { error: 'watch.every_minutes must be at least 1' }
  return { trigger: { kind: 'watch', command, everyMs: Math.round(m * 60_000), anchor: now.toISOString() } }
}

// A number of minutes within bounds, or why not.
function minutesIn(v: unknown, name: string, lo: number, hi: number): { ms?: number; error?: string } {
  const m = Number(v)
  if (!Number.isFinite(m) || m < lo || m > hi) return { error: `${name} is between ${lo} and ${hi}` }
  return { ms: Math.round(m * 60_000) }
}

export class TaskService {
  constructor(private deps: ServiceDeps) {}

  private get store() { return this.deps.store }

  // A task the caller may see: the run's own chat; for a scheduled run, only its own
  // task ('self' names it), and, to read, the tasks it watches.
  private visible(scope: Scope, id: string, read = false): Result<Task> {
    if (scope.kind === 'run' && scope.runKind === 'scheduled') {
      const own = scope.taskId ? this.store.getTask(scope.taskId) : undefined
      const watched = own?.action.kind === 'claude' ? own.action.watch ?? [] : []
      if (id === 'self' || id === scope.taskId) id = scope.taskId ?? ''
      else if (!(read && watched.includes(id))) return err(403, read ? 'a scheduled run can only see its own task, and the tasks it watches' : 'a scheduled run can only change its own task')
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
    const watchGiven = input.watch !== undefined && input.watch !== null && (input.watch as any) !== ''
    const afterGiven = input.after !== undefined && input.after !== null
    const hookGiven = input.webhook === true
    if ([watchGiven, timeGiven, afterGiven, hookGiven].filter(Boolean).length > 1) return err(400, 'give one of: a time (at, in_minutes, every_minutes, cron), watch, after, or webhook')
    let trigger = base?.trigger
    if (hookGiven) {
      // Its secret stays with it: changing the task doesn't break the scripts that call it.
      trigger = base?.trigger.kind === 'webhook' ? base.trigger : { kind: 'webhook', secret: randomBytes(12).toString('hex') }
    } else if (afterGiven) {
      const ref = String(input.after!.task ?? '').trim()
      const hit = this.store.getTask(ref) ?? this.store.listTasks({ chat }).find(x => x.name.trim().toLowerCase() === ref.toLowerCase())
      if (!hit || hit.chat !== chat || hit.state === 'deleted') return err(404, `after: no task "${ref}" in this chat`)
      if (base && hit.id === base.id) return err(400, "after: a task can't run after itself")
      const on = input.after!.on ?? 'success'
      if (!['success', 'noteworthy', 'failure', 'any'].includes(on)) return err(400, 'after.on is success, noteworthy, failure or any')
      // One that runs after this, round and round, would never stop.
      for (let x: Task | undefined = hit, n = 0; x?.trigger.kind === 'after' && n < 20; x = this.store.getTask(x.trigger.task), n++) {
        if (base && x.trigger.task === base.id) return err(400, `after: "${hit.name}" already runs after this one; that would go round forever`)
      }
      trigger = { kind: 'after', task: hit.id, name: hit.name, on }
    } else if (watchGiven) {
      const w = parseWatch(input.watch, now)
      if (w.error) return err(400, w.error)
      // The same command at the same pace keeps its anchor, so an edit doesn't move its checks.
      const b = base?.trigger
      trigger = b?.kind === 'watch' && w.trigger!.kind === 'watch' && b.command === w.trigger!.command && b.everyMs === w.trigger!.everyMs ? b : w.trigger
    } else if (timeGiven || !base) {
      const w = parseWhen(input, tz, now)
      if (w.error) return err(400, w.error)
      trigger = w.trigger
    }
    const watching = trigger!.kind === 'watch'

    let action = base?.action
    const hasMsg = typeof input.message === 'string' && input.message.trim() !== ''
    const hasPrompt = typeof input.prompt === 'string' && input.prompt.trim() !== ''
    const keep = input.keep_running === true
    const scriptIn: any = typeof input.script === 'string' ? { command: input.script } : input.script
    const hasScript = scriptIn !== undefined && scriptIn !== null
    const digestIn: any = input.digest === true ? {} : input.digest
    const hasDigest = digestIn !== undefined && digestIn !== null && digestIn !== false
    const hasSteps = Array.isArray(input.steps)
    if ([hasMsg, hasPrompt, hasScript, hasDigest, hasSteps, keep].filter(Boolean).length > 1) return err(400, 'give one of message (a reminder, or a line for each event), prompt (a Claude run), script (a command), steps (a plan), digest or keep_running')
    // Other tasks, named by id or by name, in this chat.
    const tasksNamed = (refs: unknown, what: string): Result<string[]> => {
      if (refs === undefined || refs === null) return ok([])
      if (!Array.isArray(refs) || refs.length > 20) return err(400, `${what} is a list of at most 20 task ids or names`)
      const ids: string[] = []
      for (const ref of refs) {
        const r = String(ref ?? '').trim()
        const hit = this.store.getTask(r) ?? this.store.listTasks({ chat }).find(x => x.name.trim().toLowerCase() === r.toLowerCase())
        if (!hit || hit.chat !== chat || hit.state === 'deleted') return err(404, `${what}: no task "${r}" in this chat`)
        if (base && hit.id === base.id) return err(400, `${what}: a task can't include itself`)
        if (!ids.includes(hit.id)) ids.push(hit.id)
      }
      return ok(ids)
    }
    if (keep && !watching) return err(400, 'keep_running is for a watcher: give watch too')
    if (hasMsg) {
      if (input.message!.length > MAX.message) return err(400, `message is too long (at most ${MAX.message} characters)`)
      action = { kind: 'message', text: input.message!.trim() }
    } else if (hasPrompt) {
      if (input.prompt!.length > MAX.prompt) return err(400, `prompt is too long (at most ${MAX.prompt} characters)`)
      const session = input.session ?? (base?.action.kind === 'claude' ? base.action.session : 'fresh')
      const w = tasksNamed(input.watch_tasks, 'watch_tasks')
      if (!w.ok) return err(w.status, w.error)
      const watch = input.watch_tasks !== undefined ? w.value! : base?.action.kind === 'claude' ? base.action.watch ?? [] : []
      action = { kind: 'claude', prompt: input.prompt!.trim(), session, ...(watch.length ? { watch } : {}) }
    } else if (hasScript) {
      const command = String(scriptIn.command ?? '').trim()
      if (!command) return err(400, 'script needs command: what to run with bash in this topic\'s folder, e.g. "bash backup.sh"')
      if (command.length > LIMITS.watchCommandMax) return err(400, `script.command is too long (at most ${LIMITS.watchCommandMax} characters)`)
      let timeoutMs: number | undefined
      if (scriptIn.timeout_minutes !== undefined && scriptIn.timeout_minutes !== null) {
        const m = minutesIn(scriptIn.timeout_minutes, 'script.timeout_minutes', 1, LIMITS.scriptTimeoutMaxMs / 60_000)
        if (m.error) return err(400, m.error)
        timeoutMs = m.ms
      }
      action = { kind: 'script', command, ...(timeoutMs ? { timeoutMs } : {}) }
    } else if (hasSteps) {
      const s = this.buildSteps(input.steps!, chat)
      if (!s.ok) return err(s.status, s.error)
      action = { kind: 'steps', steps: s.value! }
    } else if (hasDigest) {
      const o = tasksNamed(digestIn.of, 'digest.of')
      if (!o.ok) return err(o.status, o.error)
      action = { kind: 'digest', of: o.value! }
    } else if (keep) {
      action = { kind: 'none' }
    } else if (!base) {
      return err(400, watching
        ? 'a watcher needs message (sent for each event; {event} is the line it printed), prompt (what Claude does with the events) or keep_running: true'
        : 'give message (what to send, for a reminder) or prompt (what Claude should do when it runs)')
    } else if (base.action.kind === 'claude' && (input.session || input.watch_tasks !== undefined)) {
      const w = tasksNamed(input.watch_tasks, 'watch_tasks')
      if (!w.ok) return err(w.status, w.error)
      const watch = input.watch_tasks !== undefined ? w.value! : base.action.watch ?? []
      action = { kind: 'claude', prompt: base.action.prompt, session: input.session ?? base.action.session, ...(watch.length ? { watch } : {}) }
    }
    if (input.watch_tasks !== undefined && action!.kind !== 'claude') return err(400, 'watch_tasks is for a prompt: the Claude run that checks on them')
    if (action!.kind === 'digest' && watching) return err(400, 'a digest runs on a schedule ("every evening at 21:07"), not on a watcher')
    if (input.session && input.session !== 'fresh' && input.session !== 'own') return err(400, 'session is fresh or own')
    if (action!.kind === 'none' && !watching) return err(400, 'only a watcher can be kept running with nothing to do: give message or prompt')

    if (input.says !== undefined && !SAYS.includes(input.says)) return err(400, `says is one of ${SAYS.join(', ')}`)
    if (input.sound !== undefined && input.sound !== 'loud' && input.sound !== 'silent') return err(400, 'sound is loud or silent')
    if (input.deliver_to !== undefined && input.deliver_to !== 'topic' && input.deliver_to !== 'dm') return err(400, 'deliver_to is topic or dm')

    // A watchdog speaks only when something looks wrong, unless told otherwise.
    const watchdog = action!.kind === 'claude' && !!action!.watch?.length
    const says: Says = action!.kind === 'message' || action!.kind === 'digest' ? 'result' : action!.kind === 'none' ? 'problems'
      : (input.says ?? (base && base.action.kind === action!.kind ? base.says : undefined) ?? (watchdog ? 'noteworthy' : 'result'))
    // Loud for what the person asked to receive and for what speaks only when it
    // matters (a watcher that saw something does); a result in a group is silent
    // unless asked otherwise.
    const defaultSound: Sound = action!.kind === 'digest' ? 'silent'
      : action!.kind === 'message' || says === 'noteworthy' || says === 'problems' || watching ? 'loud'
      : this.deps.isGroup(chat) ? 'silent' : 'loud'
    const sound = input.sound ?? base?.sound ?? defaultSound

    let name = (input.name ?? base?.name ?? '').trim()
    if (!name) {
      const src = action!.kind === 'message' ? action!.text : action!.kind === 'claude' ? action!.prompt
        : action!.kind === 'script' ? action!.command : action!.kind === 'digest' ? 'Digest'
        : action!.kind === 'steps' ? `Plan: ${action!.steps.map(s => s.name).join(', ')}`
        : trigger!.kind === 'watch' ? trigger!.command : 'task'
      name = src.replace(/\s+/g, ' ').slice(0, 40).trim() + (src.length > 40 ? '…' : '')
    }

    const limits: Partial<EventLimits> = { ...base?.limits }
    const lims: [keyof EventLimits, unknown, string, number, number][] = [
      ['cooldownMs', input.cooldown_minutes, 'cooldown_minutes', 0, 24 * 60],
      ['staleMs', input.stale_minutes, 'stale_minutes', 1, 24 * 60],
    ]
    for (const [k, v, label, lo, hi] of lims) {
      if (v === undefined || v === null) continue
      const m = minutesIn(v, label, lo, hi)
      if (m.error) return err(400, m.error)
      limits[k] = m.ms
    }
    if (input.max_per_hour !== undefined && input.max_per_hour !== null) {
      const n = Number(input.max_per_hour)
      if (!Number.isInteger(n) || n < 1 || n > 120) return err(400, 'max_per_hour is a whole number between 1 and 120')
      limits.maxPerHour = n
    }

    // What decides which events start a run: a watcher's alone. A task that stops
    // watching loses them, unless this very input gave them.
    const empty = (v: any) => v === null || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)
    let rule = base?.rule
    if (input.rule !== undefined) {
      if (empty(input.rule)) rule = undefined
      else {
        const e = ruleError(input.rule)
        if (e) return err(400, e)
        rule = toRule(input.rule)
      }
    }
    let ai = base?.ai
    if (input.ai_filter !== undefined) {
      if (empty(input.ai_filter)) ai = undefined
      else {
        const q = String(input.ai_filter!.question ?? '').trim()
        if (!q) return err(400, 'ai_filter.question is what the model is asked of each event, such as "Does this suggest a major outage is starting?"')
        if (q.length > 1000) return err(400, 'ai_filter.question is at most 1000 characters')
        const m = minutesIn(input.ai_filter!.every_minutes ?? 5, 'ai_filter.every_minutes', 1, 60)
        if (m.error) return err(400, m.error)
        ai = { question: q, everyMs: m.ms! }
      }
    }
    if (!watching) {
      if ((input.rule !== undefined && rule) || (input.ai_filter !== undefined && ai)) return err(400, 'rule and ai_filter are for a watcher: give watch too')
      rule = undefined; ai = undefined
    }
    if ((rule || ai) && action!.kind === 'none') return err(400, 'a watcher kept running for its own sake has nothing to filter: give message or prompt')

    // Its then: on success, its result handed to another topic of this group.
    let then = base?.then
    if (input.then !== undefined) {
      if (input.then === null || !input.then.handoff_to) then = undefined
      else {
        if (!chat.startsWith('-')) return err(400, 'then hands results between the topics of a group; this is a private chat')
        const to = this.deps.topicOf?.(chat, String(input.then.handoff_to))
        if (!to) return err(404, `then.handoff_to: no topic "${input.then.handoff_to}" here; topic_list lists them`)
        if (action!.kind !== 'claude' && action!.kind !== 'script' && action!.kind !== 'steps') return err(400, 'then is for a Claude run, a script or a plan, which have a result to hand on')
        then = { thread: to.thread, topicName: to.name ?? String(input.then.handoff_to), ...(input.then.brief ? { brief: String(input.then.brief).slice(0, 2000) } : {}) }
      }
    }
    // A batch mustn't go stale while it waits for the filter.
    if (ai && limits.staleMs === undefined && ai.everyMs * 2 > 10 * 60_000) limits.staleMs = ai.everyMs * 2
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
    // A streaming watcher has no slots at all.
    const nextDue = firstDue(trigger!, tz, now)
    return ok({
      name, trigger: trigger!, tz, action: action!, says, sound,
      where: input.deliver_to ? (input.deliver_to === 'dm' ? 'dm' : 'home') : (base?.where ?? 'home'),
      until, times, nextDue: nextDue?.toISOString(),
      limits: Object.keys(limits).length ? limits : undefined,
      rule, ai, then,
    } as any)
  }

  // A plan's steps, each checked: what it does, and where it goes after.
  private buildSteps(raw: any[], chat: string): Result<Step[]> {
    if (!raw.length || raw.length > LIMITS.stepsMax) return err(400, `steps is a list of 1 to ${LIMITS.stepsMax} steps`)
    const kinds: Step['kind'][] = ['message', 'script', 'claude', 'codex', 'ask', 'handoff']
    const out: Step[] = []
    const go = (v: any, n: number, what: string): Result<number | 'next' | 'stop' | undefined> => {
      if (v === undefined || v === null || v === '') return ok(undefined)
      if (v === 'next' || v === 'stop') return ok(v)
      const k = Number(v)
      if (!Number.isInteger(k) || k < 1 || k > raw.length) return err(400, `step ${n}: ${what} is "next", "stop" or a step number from 1 to ${raw.length}`)
      return ok(k)
    }
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i] ?? {}
      const n = i + 1
      if (!kinds.includes(r.kind)) return err(400, `step ${n}: kind is one of ${kinds.join(', ')}`)
      const st: Step = { name: String(r.name ?? '').trim().slice(0, 60) || `${r.kind} ${n}`, kind: r.kind }
      const need = (field: string, what: string): string | undefined => { const v = String(r[field] ?? '').trim(); return v ? v : (void 0) }
      if (r.kind === 'message') { st.text = need('text', ''); if (!st.text) return err(400, `step ${n}: a message step needs text`) }
      if (r.kind === 'script') { st.command = need('command', ''); if (!st.command) return err(400, `step ${n}: a script step needs command`) }
      if (r.kind === 'claude' || r.kind === 'codex') {
        st.prompt = need('prompt', '')
        if (!st.prompt) return err(400, `step ${n}: a ${r.kind} step needs prompt`)
        if (st.prompt.length > MAX.prompt) return err(400, `step ${n}: prompt is too long`)
      }
      if (r.kind === 'ask') {
        st.question = need('question', '')
        if (!st.question) return err(400, `step ${n}: an ask step needs question`)
        if (Array.isArray(r.options)) st.options = r.options.map((o: any) => String(o).trim()).filter(Boolean).slice(0, 8)
      }
      if (r.kind === 'handoff') {
        const to = r.topic !== undefined ? this.deps.topicOf?.(chat, String(r.topic)) : undefined
        if (!to) return err(404, `step ${n}: a handoff step needs topic, one of this group's (topic_list lists them)`)
        st.thread = to.thread
        st.topicName = to.name ?? String(r.topic)
        if (r.brief) st.brief = String(r.brief).slice(0, 4000)
      }
      if ((r.kind === 'script' || r.kind === 'codex') && r.timeout_minutes !== undefined && r.timeout_minutes !== null) {
        const m = minutesIn(r.timeout_minutes, `step ${n}: timeout_minutes`, 1, LIMITS.scriptTimeoutMaxMs / 60_000)
        if (m.error) return err(400, m.error)
        st.timeoutMs = m.ms
      }
      const p = go(r.on_pass, n, 'on_pass')
      if (!p.ok) return err(p.status, p.error)
      const f = go(r.on_fail, n, 'on_fail')
      if (!f.ok) return err(f.status, f.error)
      if (p.value !== undefined) st.onPass = p.value
      if (f.value !== undefined) st.onFail = f.value
      if (r.retries !== undefined && r.retries !== null) {
        const k = Number(r.retries)
        if (!Number.isInteger(k) || k < 0 || k > LIMITS.stepRetriesMax) return err(400, `step ${n}: retries is 0 to ${LIMITS.stepRetriesMax}`)
        if (k) st.retries = k
      }
      out.push(st)
    }
    return ok(out)
  }

  // What a task would be, checked but not made: a scheduled run's proposal of one that
  // outlasts it, which a person then creates.
  check(scope: Scope, input: TaskInput): Result<{ task: Task }> {
    if (scope.kind !== 'run' || !scope.chat || !scope.person) return err(403, 'no chat')
    const b = this.build(input, undefined, scope.chat)
    if (!b.ok) return err(b.status, b.error)
    if (!b.value.nextDue && !hasNoSlots(b.value)) return err(400, 'that time has already passed')
    const now = this.deps.now().toISOString()
    return ok({ task: { ...b.value, id: 'proposal', chat: scope.chat, thread: scope.thread, owner: scope.person, ownerName: scope.personName,
      createdBy: `person:${scope.person}`, createdAt: now, updatedAt: now, state: 'active', runsDone: 0, failStreak: 0 } as Task })
  }

  create(scope: Scope, input: TaskInput): Result<{ task: Task; duplicate?: boolean }> {
    if (scope.kind !== 'run' || !scope.chat || !scope.person) return err(403, 'tasks are created from a conversation, as the person who asked')
    // A task's own run may make child tasks: a few, not deep, ending with it or within a
    // week. One that should outlast it is proposed for a person to create.
    let parent: Task | undefined
    let depth = 0
    if (scope.runKind === 'scheduled') {
      parent = scope.taskId ? this.store.getTask(scope.taskId) : undefined
      if (!parent) return err(403, "a scheduled run can't create tasks")
      depth = (parent.childDepth ?? 0) + 1
      if (depth > LIMITS.childDepthMax) return err(403, `a task made by a task's run can't make more (${LIMITS.childDepthMax} levels at most); propose it with task_propose for a person to create`)
      const kids = this.store.listTasks({ chat: parent.chat, states: ['active', 'paused'] }).filter(x => x.parent === parent!.id)
      if (kids.length >= LIMITS.childrenPerParent) return err(409, `this task has ${LIMITS.childrenPerParent} child tasks already; one has to finish first`)
    }
    const why = this.deps.mayCreate(scope)
    if (why) return err(403, why)
    // Its home: the caller's topic, or another of this chat it was asked to live in.
    let thread = scope.thread
    if (input.topic !== undefined && input.topic !== null && input.topic !== '') {
      const to = this.deps.topicOf?.(scope.chat, String(input.topic))
      if (!to) return err(404, `no topic "${input.topic}" here; topic_list lists them`)
      thread = to.thread
    }
    const b = this.build(input, undefined, scope.chat)
    if (!b.ok) return err(b.status, b.error)
    if (!b.value.nextDue && !hasNoSlots(b.value)) return err(400, 'that time has already passed')
    if (parent) {
      const now = this.deps.now().getTime()
      const ends = [b.value.until, parent.until, new Date(now + LIMITS.childMaxMs).toISOString()].filter(Boolean) as string[]
      ;(b.value as any).until = ends.sort()[0]
    }
    const dup = this.store.findDuplicate(scope.chat, thread, b.value)
    if (dup) return ok({ task: dup, duplicate: true })
    if (this.store.countInTopic(scope.chat, thread) >= LIMITS.tasksPerTopic) {
      return err(409, `this topic already has ${LIMITS.tasksPerTopic} tasks; delete one first`)
    }
    const max = this.deps.maxWatchers
    if (max !== undefined && isStreaming(b.value) && this.store.listTasks({ states: ['active'] }).filter(isStreaming).length >= max) {
      return err(409, `the bot already keeps ${max} watchers running; pause or delete one first, or make this one check every few minutes (watch.every_minutes)`)
    }
    const task = this.store.createTask({
      ...b.value, chat: scope.chat, thread, owner: scope.person, ownerName: scope.personName,
      createdBy: parent ? `run:${scope.runId}` : `person:${scope.person}`,
      ...(parent ? { parent: parent.id, parentName: parent.name, childDepth: depth } : {}),
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
    if (retimed && !b.value.nextDue && !hasNoSlots(b.value)) return err(400, 'that time has already passed')
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
    if (!next && !hasNoSlots(t)) return err(409, 'its time has passed while it was paused; give it a new time with task_update')
    const task = this.store.updateTask(t.id, {
      state: 'active', pauseReason: undefined, failStreak: 0, nextDue: next?.toISOString(),
      watchFails: undefined, watchError: undefined, watchRetryAt: undefined,
    }, this.deps.now())!
    this.deps.changed(task, 'resumed')
    return ok({ task })
  }

  // No end any more: a task that reached its end date runs on, from now; one that is
  // running loses its end.
  keepRunning(scope: Scope, id: string): Result<{ task: Task }> {
    const v = this.visible(scope, id)
    if (!v.ok) return err(v.status, v.error)
    if (scope.runKind === 'scheduled') return err(403, "a scheduled run can't change its task's end")
    const why = this.deps.mayManage(scope, v.value, 'resume')
    if (why) return err(403, why)
    const t = v.value
    if (t.state !== 'expired' && t.state !== 'active') return err(409, `it is ${t.state}`)
    const now = this.deps.now()
    const next = t.state === 'expired' ? firstDue(t.trigger, t.tz, now) : undefined
    if (t.state === 'expired' && !next && !hasNoSlots(t)) return err(409, 'it has nothing left to run; give it a new time with task_update')
    const task = this.store.updateTask(t.id, {
      until: undefined, ...(t.state === 'expired' ? { state: 'active', nextDue: next?.toISOString(), watchFails: undefined, watchError: undefined, watchRetryAt: undefined } : {}),
    }, now)!
    this.deps.changed(task, t.state === 'expired' ? 'resumed' : 'updated')
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

  // Run it now, given what it was fired with: a script on the host, or its webhook.
  fire(scope: Scope, id: string, payload: unknown): Result<{ runId: string }> {
    const v = this.visible(scope, id)
    if (!v.ok) return err(v.status, v.error)
    if (scope.runKind === 'scheduled') return err(403, "a scheduled run can't fire tasks")
    const why = this.deps.mayManage(scope, v.value, 'run')
    if (why) return err(403, why)
    const text = typeof payload === 'string' ? payload : payload === undefined || payload === null ? '' : JSON.stringify(payload)
    const r = this.deps.fire?.(v.value, text.slice(0, 64_000)) ?? { error: 'firing is not available here' }
    if (!r.runId) return err(409, r.error ?? "it couldn't start")
    return ok({ runId: r.runId })
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
    const v = this.visible(scope, id, true)
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
      // The Tasks topic sees the whole group's.
      const inTopic = (where ?? (scope.thread !== undefined && !scope.hub ? 'topic' : 'chat')) === 'topic'
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
