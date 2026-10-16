/**
 * model.ts — what a task is, in the types the store, the scheduler, the local API,
 * the MCP server and the bridge share. The design is research/tasks/REPORT.md.
 *
 * A task is something the bot does on its own: trigger → (optional) filter → action.
 * Phase 1 has schedule triggers and two actions, a fixed message (a reminder) and a
 * Claude run. Watchers, filters, steps and hand-offs come later; the shapes leave room
 * for them without pretending they exist.
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

export type Action =
  | { kind: 'message'; text: string }
  // fresh: a new session each run, in the topic's folder. own: one session the task
  // keeps across its runs, so it remembers what earlier runs did.
  | { kind: 'claude'; prompt: string; session: 'fresh' | 'own' }

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
}

export type RunState =
  | 'queued' | 'running'
  | 'succeeded' | 'failed' | 'timed_out' | 'canceled'
  | 'skipped'        // not run: still running, or missed while the bot was down
  | 'interrupted'    // the bridge stopped mid-run; never replayed on its own
  | 'deferred'       // a usage limit stopped it; not a failure

export type RunTrigger = 'schedule' | 'catchup' | 'manual'

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
}

// One glyph per run, for lists and the strip on a card.
export type RunMark = 'posted' | 'quiet' | 'blocked' | 'failed' | 'skipped' | 'deferred' | 'interrupted' | 'running'

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
}
