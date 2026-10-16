/**
 * model.ts — what a task is, in the types the store, the scheduler, the local API,
 * the MCP server and the bridge share. The design is research/tasks/REPORT.md.
 *
 * A task is something the bot does on its own: trigger → (optional) filter → action.
 * The triggers are a schedule, or a watcher: a program the bridge runs and reads, each
 * line it prints an event. The actions are a fixed message (a reminder, or a line for
 * each event), a Claude run, or, for a watcher kept running for its own sake, nothing.
 * Filters, steps and hand-offs come later; the shapes leave room for them without
 * pretending they exist.
 *
 * A task is the standing definition; a run is one execution of it. Nothing that shows
 * a run calls it a task.
 */

// When a task fires. Times are stored in UTC; `Task.tz` is the zone they are read
// and shown in, and the zone a cron expression is evaluated in.
export type Trigger =
  | { kind: 'at'; at: string }                          // once
  | { kind: 'every'; everyMs: number; anchor: string }  // anchor + k·everyMs
  | { kind: 'cron'; expr: string }                      // five fields
  // A program in the home topic's folder (bash -c command). With everyMs it is polled:
  // run at anchor + k·everyMs, its output read when it exits. Without, it streams: kept
  // running, read as it prints. Every line it prints is an event.
  | { kind: 'watch'; command: string; everyMs?: number; anchor?: string }
  // After another task's run: when it worked, when it posted something, when it failed,
  // or any of these. That run's result comes with this one.
  | { kind: 'after'; task: string; name: string; on: 'success' | 'noteworthy' | 'failure' | 'any' }

export type Action =
  // For a watcher, {event} in the text is the line that set it off.
  | { kind: 'message'; text: string }
  // fresh: a new session each run, in the topic's folder. own: one session the task
  // keeps across its runs, so it remembers what earlier runs did. A watcher's events
  // come with its run; so do the recent runs of the tasks it watches (a watchdog).
  | { kind: 'claude'; prompt: string; session: 'fresh' | 'own'; watch?: string[] }
  // What other tasks did since the last digest, listed without Claude. of: their ids,
  // or empty for every other task in the home topic.
  | { kind: 'digest'; of: string[] }
  // A short plan whose gates the bridge keeps: "push only if the tests pass".
  | { kind: 'steps'; steps: Step[] }
  // A command with no AI (bash -c, in the topic's folder): its exit status decides,
  // and what it printed is posted as `says` decides.
  | { kind: 'script'; command: string; timeoutMs?: number }
  // A watcher kept running for its own sake ("keep the sync loop running"): its output
  // goes nowhere, and only its failures are said.
  | { kind: 'none' }

// One step of a plan, and where to go after it. Step numbers count from 1.
export interface Step {
  name: string
  kind: 'message' | 'script' | 'claude' | 'codex' | 'ask' | 'handoff'
  text?: string             // message
  command?: string          // script
  prompt?: string           // claude, codex
  question?: string         // ask
  options?: string[]
  thread?: number           // handoff: the topic
  topicName?: string
  brief?: string
  timeoutMs?: number        // script, codex
  onPass?: number | 'next' | 'stop'   // after it worked (default: the next one)
  onFail?: number | 'next' | 'stop'   // after it failed for good (default: stop, the run failed)
  retries?: number          // tries again this many times, told how it failed
}

// What one step did, kept with its run.
export interface StepResult {
  step: number              // from 1
  name: string
  ok: boolean
  output?: string
  error?: string
  attempt: number           // from 1
  startedAt: string
  endedAt?: string
}

// One line a watcher printed, and when; once a filter let it through, the value it
// looked at and why it passed.
export interface WatchEvent { at: string; text: string; value?: string; why?: string }

// Which events start a run (filters.ts): a test on the line, or on a field of its JSON.
export type RuleOp = 'above' | 'below' | 'crosses_above' | 'crosses_below' | 'change_pct' | 'changed' | 'contains' | 'matches'
export interface Rule {
  op: RuleOp
  field?: string          // a JSON path ("price", "data.last"); the whole line without one
  value?: number          // the threshold; for change_pct, the percent
  windowMs?: number       // change_pct: within this
  words?: string[]        // contains: any of these, any case
  pattern?: string        // matches: a regular expression, any case
}

// A cheap model asked, every so often, which of the events that came answer a question.
export interface AiFilter { question: string; everyMs: number }

// How a watcher's events may start runs: at most one run per cooldown and so many an
// hour, events that come meanwhile folded into the next run, and none older than the
// stale limit (a price move from an hour ago isn't news).
export interface EventLimits { cooldownMs: number; maxPerHour: number; staleMs: number }

// How much a Claude run says. A message task always posts its message.
export type Says = 'live' | 'result' | 'noteworthy' | 'problems' | 'never'
export type Sound = 'loud' | 'silent'
export type Where = 'home' | 'dm'
export type TaskState = 'active' | 'paused' | 'done' | 'expired' | 'deleted'
// Why a task is paused. Every pause says why, on its card.
export type PauseReason = 'person' | 'failures' | 'owner' | 'review'

export interface Task {
  id: string
  chat: string
  thread?: number         // the forum topic; absent in a DM or a group's General
  name: string
  trigger: Trigger
  tz: string              // IANA zone
  action: Action
  says: Says
  sound: Sound
  where: Where
  owner: string           // the person the task runs as
  ownerName?: string
  createdBy: string       // 'person:<id>' or 'run:<run id>'
  createdAt: string
  updatedAt: string
  state: TaskState
  pauseReason?: PauseReason
  nextDue?: string        // the next slot; absent when nothing is due
  until?: string          // no slot after this
  times?: number          // stop after this many runs
  runsDone: number
  failStreak: number
  sessionId?: string      // the task's own session, for session 'own'
  cardMsg?: number        // its card in the home topic, edited in place
  alertMsg?: number       // the failure alert being edited, while one is open
  alertAt?: string
  lastRunAt?: string
  lastMark?: RunMark      // the last run's mark, for lists
  // Watchers:
  limits?: Partial<EventLimits>   // the task's own; the defaults otherwise (eventLimits)
  eventsSeen?: number
  lastEventAt?: string
  lastEventRunAt?: string
  watchFails?: number     // the watcher's failures in a row
  watchError?: string     // the last of them, in words
  watchRetryAt?: string   // a streaming watcher that died starts again from here
  then?: { thread?: number; topicName?: string; brief?: string }  // on success, its result handed to this topic
  parent?: string         // a child task: the task whose run made it
  parentName?: string
  childDepth?: number     // 1 for a child, 2 for a child's child
  rule?: Rule
  ai?: AiFilter
  filterSeen?: number     // events the AI filter was asked about
  filterPassed?: number   // …and let through
  lastFilterAt?: string
  filterError?: string
}

export type RunState =
  | 'queued' | 'running'
  | 'succeeded' | 'failed' | 'timed_out' | 'canceled'
  | 'skipped'        // not run: still running, or missed while the bot was down
  | 'interrupted'    // the bridge stopped mid-run; never replayed on its own
  | 'deferred'       // a usage limit stopped it; not a failure
  | 'waiting'        // it asked a question nobody has answered yet; an answer carries it on

export type RunTrigger = 'schedule' | 'catchup' | 'manual' | 'event' | 'answer' | 'after'

// What a run says about itself through the report tool.
export type ReportOutcome = 'nothing_new' | 'done' | 'progress' | 'blocked' | 'needs_attention'

export interface Usage {
  model?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costUsd?: number        // the CLI's own estimate
  turns?: number
  durationMs?: number
}

export interface Run {
  id: string              // `${task}@${slot}`, or `${task}@manual-…`: unique, so a slot can't fire twice
  task: string
  slot?: string
  trigger: RunTrigger
  state: RunState
  reason?: string         // why it was skipped, deferred or failed
  startedAt?: string
  endedAt?: string
  outcome?: ReportOutcome
  notify?: boolean        // what the run asked for through report()
  summary?: string
  reportText?: string     // what report() asked to post, when it gave more than a summary
  resultPath?: string
  postedMsg?: number
  sessionId?: string
  usage?: Usage
  denials?: string[]      // actions the permission mode blocked
  lateMs?: number         // how late it started, for a catch-up
  events?: WatchEvent[]   // what set off an event run (the newest, at most eventsPerRun)
  folded?: number         // how many events it covers in all
  waitId?: string         // an answer run: the question it carries on from
  // An after run: the run of the other task that set it off.
  after?: { task: string; run: string; name: string; outcome: string; summary?: string; resultPath?: string; depth: number }
  stepAt?: number         // a plan's run: the step it is at (from 1)
  stepResults?: StepResult[]
  progressMsg?: number    // its progress message, edited as its steps go by
}

// Work handed to another topic of the same group: by a run (the handoff tool) or by a
// task whose definition says so (Task.then). It runs there as a turn of its own, in
// that topic's folder with its settings, as the person who handed it off.
export interface Handoff {
  id: string
  chat: string
  fromThread?: number
  toThread?: number
  brief: string
  files: string[]            // names in the target topic's inbox
  by: string                 // the person it runs as
  byName?: string
  fromTask?: string          // a task's run that handed it off
  depth: number              // 1 from a person or a task; one more each time it is handed on
  state: 'queued' | 'running' | 'done' | 'failed'
  createdAt: string
  endedAt?: string
  srcMsg?: number            // the line in the source topic, edited when it ends
  dstMsg?: number            // its header in the target topic
  error?: string
}

// A question a task's run asked a person (the ask tool). The run waits a few minutes
// for the answer; if none comes it stops, parked, and the answer carries it on later,
// in its own session. After a day the default answer is used, or the question let go.
export interface Wait {
  id: string
  task: string
  run: string
  chat: string
  thread?: number
  question: string
  options?: string[]
  defaultAnswer?: string
  askedMsg?: number
  askedAt: string
  deadline: string
  state: 'open' | 'parked' | 'answered' | 'expired'
  answer?: string
  answeredBy?: string
  answeredById?: string
  answeredAt?: string
  sessionId?: string      // the asking run's session, to carry on in
}

// One glyph per run, for lists and the strip on a card.
export type RunMark = 'posted' | 'quiet' | 'blocked' | 'failed' | 'skipped' | 'deferred' | 'interrupted' | 'running' | 'waiting'

export const LIMITS = {
  tasksPerTopic: 20,
  minEveryMs: 60_000,
  failAlertAt: 2,         // consecutive failures before an alert
  failPauseAt: 5,         // …and before the task pauses itself
  alertCooldownMs: 60 * 60_000,
  oneOffGraceMs: 12 * 60 * 60_000,   // a missed reminder still goes out, marked late, for this long
  graceMinMs: 2 * 60_000,            // a recurring slot may start this late, at least…
  graceMaxMs: 2 * 60 * 60_000,       // …and at most; half its period in between
  historyKept: 200,                  // runs kept per task
  // Watchers:
  watchCommandMax: 2000,
  eventTextMax: 2000,                // characters kept of one line
  pendingEventsKept: 100,            // events waiting for a run, per task
  eventsPerRun: 50,                  // events a run is given
  pollTimeoutMs: 5 * 60_000,         // a polled watcher must print and exit within this
  watchUpResetMs: 10 * 60_000,       // a streaming watcher up this long starts its failure count afresh
  watchBackoffMs: [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000],
  // Hand-offs:
  handoffDepthMax: 3,
  handoffsPerHour: 30,               // per group
  handoffRunsAtOnce: 2,
  // Child tasks, made by a task's own run:
  childrenPerParent: 3,
  childDepthMax: 2,
  childMaxMs: 7 * 24 * 60 * 60_000,  // a child ends with its parent, or after this
  afterDepthMax: 5,                  // tasks set off one after another
  // Plans:
  stepsMax: 12,
  stepRunsMax: 50,                   // step executions in one run, retries and loops included
  stepRetriesMax: 3,
  // Questions:
  askWaitMaxMs: 10 * 60_000,         // a run waits this long at most for an answer, then parks
  askKeepMs: 24 * 60 * 60_000,       // a parked question is kept this long
  // Scripts:
  scriptTimeoutMs: 30 * 60_000,
  scriptTimeoutMaxMs: 4 * 60 * 60_000,
}

// What a watcher's events may start, unless the task says otherwise: a Claude run at
// most every 5 minutes and 6 times an hour, a message every minute and 20 an hour.
export function eventLimits(t: Pick<Task, 'action' | 'limits'>): EventLimits {
  const claude = t.action.kind === 'claude'
  return {
    cooldownMs: t.limits?.cooldownMs ?? (claude ? 5 * 60_000 : 60_000),
    maxPerHour: t.limits?.maxPerHour ?? (claude ? 6 : 20),
    staleMs: t.limits?.staleMs ?? 10 * 60_000,
  }
}

export const isWatch = (t: Pick<Task, 'trigger'>): t is Pick<Task, 'trigger'> & { trigger: Extract<Trigger, { kind: 'watch' }> } => t.trigger.kind === 'watch'
export const isStreaming = (t: Pick<Task, 'trigger'>) => t.trigger.kind === 'watch' && !t.trigger.everyMs
// No slots of its own: a streaming watcher, or a task that runs after another.
export const hasNoSlots = (t: Pick<Task, 'trigger'>) => isStreaming(t) || t.trigger.kind === 'after'
