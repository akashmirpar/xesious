/**
 * store.ts — tasks, their runs, the notes runs leave for a topic, the watchers the
 * bridge keeps running and the events waiting for a run, in one SQLite file
 * (state/tasks.db). The bridge is its only writer.
 *
 * Each row keeps the whole record as JSON beside the few columns that are queried
 * (chat, topic, state, next due time), so a field added later needs no migration.
 * The columns are the truth for what they hold: state and next_due live there, not in
 * the JSON, so a claim can be a single guarded UPDATE.
 */
import { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { LIMITS, type Handoff, type Run, type Task, type TaskState, type Wait, type WatchEvent } from './model'
import type { RuleState } from './filters'

const SCHEMA = 4

// A streaming watcher as the bridge started it: enough to find it again after a
// restart (its pid, and the start time that proves the pid is still it) and to read on
// from where the last bridge left off.
export interface WatchProc {
  pid: number
  startTicks: string      // /proc/<pid>/stat start time
  startedAt: string
  command: string         // what it runs: a changed command restarts it
  out: string             // its output, one timestamped line per line it printed
  err: string             // its stderr
  readPos: number         // how far out has been read
}

type NewTask = Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'runsDone' | 'failStreak' | 'state'> & { state?: TaskState }

export class TaskStore {
  readonly db: Database

  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 3000')
    this.migrate()
  }

  close(): void { this.db.close() }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const v = Number((this.db.query("SELECT value FROM meta WHERE key = 'schema'").get() as any)?.value ?? 0)
    if (v >= SCHEMA) return
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, chat TEXT NOT NULL, thread INTEGER, state TEXT NOT NULL,
        next_due TEXT, doc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_home ON tasks (chat, thread);
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks (state, next_due);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, task TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT, doc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_task ON runs (task, started_at);
      CREATE INDEX IF NOT EXISTS runs_open ON runs (state);
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, text TEXT NOT NULL,
        created_at TEXT NOT NULL, taken_at TEXT
      );
      CREATE INDEX IF NOT EXISTS notes_key ON notes (key, taken_at);
      CREATE TABLE IF NOT EXISTS watchers (task TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, stage TEXT NOT NULL, doc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task ON events (task, stage, id);
      CREATE TABLE IF NOT EXISTS rule_state (task TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS waits (id TEXT PRIMARY KEY, task TEXT NOT NULL, state TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS waits_state ON waits (state);
      CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, chat TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS handoffs_chat ON handoffs (chat, created_at);
    `)
    this.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA))
  }

  // --- meta: small values the bridge keeps here rather than in sessions.json -------

  getMeta(key: string): string | undefined {
    return (this.db.query('SELECT value FROM meta WHERE key = ?').get(key) as any)?.value
  }
  setMeta(key: string, value: string | undefined): void {
    if (value === undefined) this.db.query('DELETE FROM meta WHERE key = ?').run(key)
    else this.db.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
  }

  // --- tasks ---------------------------------------------------------------------

  private newId(table: 'tasks' | 'waits' | 'handoffs'): string {
    for (;;) {
      // Six base-36 characters: short enough for a card's buttons and to type, and two
      // billion of them.
      const id = BigInt('0x' + randomBytes(5).toString('hex')).toString(36).padStart(6, '0').slice(-6)
      if (!this.db.query(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) return id
    }
  }

  createTask(input: NewTask, now = new Date()): Task {
    const task: Task = {
      ...input, id: this.newId('tasks'), state: input.state ?? 'active',
      createdAt: now.toISOString(), updatedAt: now.toISOString(), runsDone: 0, failStreak: 0,
    }
    this.db.query('INSERT INTO tasks (id, chat, thread, state, next_due, doc) VALUES (?, ?, ?, ?, ?, ?)')
      .run(task.id, task.chat, task.thread ?? null, task.state, task.nextDue ?? null, JSON.stringify(docOf(task)))
    return task
  }

  getTask(id: string): Task | undefined {
    const row = this.db.query('SELECT * FROM tasks WHERE id = ?').get(id) as any
    return row ? taskOf(row) : undefined
  }

  // Tasks in a chat, or one topic of it (thread null = the chat's General / a DM).
  // Deleted tasks are left out unless asked for.
  listTasks(f: { chat?: string; thread?: number | null; states?: TaskState[] } = {}): Task[] {
    const where: string[] = []
    const args: any[] = []
    if (f.chat !== undefined) { where.push('chat = ?'); args.push(f.chat) }
    if (f.thread !== undefined) {
      if (f.thread === null) where.push('thread IS NULL')
      else { where.push('thread = ?'); args.push(f.thread) }
    }
    const states = f.states ?? ['active', 'paused', 'done', 'expired']
    where.push(`state IN (${states.map(() => '?').join(',')})`)
    args.push(...states)
    const rows = this.db.query(`SELECT * FROM tasks WHERE ${where.join(' AND ')}`).all(...args) as any[]
    return rows.map(taskOf).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  updateTask(id: string, patch: Partial<Task>, now = new Date()): Task | undefined {
    const cur = this.getTask(id)
    if (!cur) return undefined
    const next: Task = { ...cur, ...patch, id: cur.id, updatedAt: now.toISOString() }
    // An explicit undefined clears a field; spread keeps it as a key, so drop it.
    for (const k of Object.keys(patch) as (keyof Task)[]) if (patch[k] === undefined) delete (next as any)[k]
    this.db.query('UPDATE tasks SET chat = ?, thread = ?, state = ?, next_due = ?, doc = ? WHERE id = ?')
      .run(next.chat, next.thread ?? null, next.state, next.nextDue ?? null, JSON.stringify(docOf(next)), id)
    return next
  }

  // Active tasks whose slot has come.
  dueTasks(now: Date): Task[] {
    const rows = this.db.query("SELECT * FROM tasks WHERE state = 'active' AND next_due IS NOT NULL AND next_due <= ?")
      .all(now.toISOString()) as any[]
    return rows.map(taskOf).sort((a, b) => (a.nextDue ?? '').localeCompare(b.nextDue ?? ''))
  }

  // The earliest due time among active tasks, for the loop's timer.
  earliestDue(): string | undefined {
    return (this.db.query("SELECT MIN(next_due) AS d FROM tasks WHERE state = 'active' AND next_due IS NOT NULL").get() as any)?.d ?? undefined
  }

  // Move a task past the slot it is about to run, but only if nobody did already: the
  // slot moves only from what the caller saw. Two ticks, or two processes, can never
  // both take it.
  claim(id: string, expectDue: string, nextDue: string | undefined): boolean {
    const r = this.db.query("UPDATE tasks SET next_due = ? WHERE id = ? AND state = 'active' AND next_due = ?")
      .run(nextDue ?? null, id, expectDue)
    return r.changes === 1
  }

  countInTopic(chat: string, thread: number | undefined): number {
    const r = thread === undefined
      ? this.db.query("SELECT COUNT(*) AS n FROM tasks WHERE chat = ? AND thread IS NULL AND state IN ('active','paused')").get(chat)
      : this.db.query("SELECT COUNT(*) AS n FROM tasks WHERE chat = ? AND thread = ? AND state IN ('active','paused')").get(chat, thread)
    return Number((r as any)?.n ?? 0)
  }

  // A task that already does this, in this topic: asking twice must not make two.
  findDuplicate(chat: string, thread: number | undefined, probe: Pick<Task, 'trigger' | 'action'>): Task | undefined {
    const key = dupKey(probe)
    return this.listTasks({ chat, thread: thread ?? null, states: ['active', 'paused'] }).find(t => dupKey(t) === key)
  }

  // --- runs --------------------------------------------------------------------

  // false when a run with this id exists: that slot has run, or is running.
  insertRun(run: Run): boolean {
    const r = this.db.query('INSERT OR IGNORE INTO runs (id, task, state, started_at, doc) VALUES (?, ?, ?, ?, ?)')
      .run(run.id, run.task, run.state, run.startedAt ?? null, JSON.stringify(runDoc(run)))
    if (r.changes === 1) this.trimRuns(run.task)
    return r.changes === 1
  }

  getRun(id: string): Run | undefined {
    const row = this.db.query('SELECT * FROM runs WHERE id = ?').get(id) as any
    return row ? runOf(row) : undefined
  }

  updateRun(id: string, patch: Partial<Run>): Run | undefined {
    const cur = this.getRun(id)
    if (!cur) return undefined
    const next: Run = { ...cur, ...patch, id: cur.id }
    for (const k of Object.keys(patch) as (keyof Run)[]) if (patch[k] === undefined) delete (next as any)[k]
    this.db.query('UPDATE runs SET state = ?, started_at = ?, doc = ? WHERE id = ?')
      .run(next.state, next.startedAt ?? null, JSON.stringify(runDoc(next)), id)
    return next
  }

  // Newest first. Runs that never started (skipped) sort by their slot.
  runsFor(task: string, limit = 20): Run[] {
    const rows = this.db.query('SELECT * FROM runs WHERE task = ?').all(task) as any[]
    return rows.map(runOf)
      .sort((a, b) => (b.startedAt ?? b.slot ?? '').localeCompare(a.startedAt ?? a.slot ?? ''))
      .slice(0, limit)
  }

  // Runs a restart left open: queued or running when the bridge stopped.
  openRuns(): Run[] {
    return (this.db.query("SELECT * FROM runs WHERE state IN ('queued','running')").all() as any[]).map(runOf)
  }

  private trimRuns(task: string): void {
    const ids = (this.db.query('SELECT id FROM runs WHERE task = ? ORDER BY started_at DESC, id DESC').all(task) as any[]).map(r => r.id)
    const drop = ids.slice(LIMITS.historyKept)
    for (const id of drop) this.db.query('DELETE FROM runs WHERE id = ?').run(id)
  }

  // --- notes for a topic's next turn ---------------------------------------------
  // A run that posted something leaves a short note, so the topic's own conversation
  // can answer "what did the report say?" — kept here, not in memory, so a restart
  // between the run and the next message doesn't lose it.

  addNote(key: string, text: string, now = new Date()): void {
    this.db.query('INSERT INTO notes (key, text, created_at) VALUES (?, ?, ?)').run(key, text, now.toISOString())
    // At most the five newest untaken notes per topic: older ones are stale context.
    const old = this.db.query('SELECT id FROM notes WHERE key = ? AND taken_at IS NULL ORDER BY id DESC LIMIT -1 OFFSET 5').all(key) as any[]
    for (const r of old) this.db.query('DELETE FROM notes WHERE id = ?').run(r.id)
  }

  // The topic's untaken notes, oldest first, marked taken.
  takeNotes(key: string, now = new Date()): string[] {
    const rows = this.db.query('SELECT id, text FROM notes WHERE key = ? AND taken_at IS NULL ORDER BY id').all(key) as any[]
    for (const r of rows) this.db.query('UPDATE notes SET taken_at = ? WHERE id = ?').run(now.toISOString(), r.id)
    return rows.map(r => r.text)
  }

  peekNotes(key: string): string[] {
    return (this.db.query('SELECT text FROM notes WHERE key = ? AND taken_at IS NULL ORDER BY id').all(key) as any[]).map(r => r.text)
  }

  // --- watchers the bridge keeps running ---------------------------------------

  getWatcher(task: string): WatchProc | undefined {
    const row = this.db.query('SELECT doc FROM watchers WHERE task = ?').get(task) as any
    return row ? JSON.parse(row.doc) : undefined
  }
  setWatcher(task: string, p: WatchProc | undefined): void {
    if (!p) this.db.query('DELETE FROM watchers WHERE task = ?').run(task)
    else this.db.query('INSERT OR REPLACE INTO watchers (task, doc) VALUES (?, ?)').run(task, JSON.stringify(p))
  }
  listWatchers(): { task: string; proc: WatchProc }[] {
    return (this.db.query('SELECT task, doc FROM watchers').all() as any[]).map(r => ({ task: r.task, proc: JSON.parse(r.doc) }))
  }

  // --- events waiting ------------------------------------------------------------
  // What a watcher printed, kept until it is used: 'ready' events wait for a run (one
  // already going, a cooldown or the hourly cap holds them, and they are folded into
  // the next run); 'candidate' ones wait for the AI filter's next batch. Only the
  // newest are kept.

  addEvents(task: string, events: WatchEvent[], stage: EventStage = 'ready'): void {
    const q = this.db.query('INSERT INTO events (task, stage, doc) VALUES (?, ?, ?)')
    for (const e of events) q.run(task, stage, JSON.stringify(e))
    const old = this.db.query('SELECT id FROM events WHERE task = ? AND stage = ? ORDER BY id DESC LIMIT -1 OFFSET ?').all(task, stage, LIMITS.pendingEventsKept) as any[]
    for (const r of old) this.db.query('DELETE FROM events WHERE id = ?').run(r.id)
  }
  // Oldest first, and gone from here.
  takeEvents(task: string, stage: EventStage = 'ready'): WatchEvent[] {
    const rows = this.db.query('SELECT id, doc FROM events WHERE task = ? AND stage = ? ORDER BY id').all(task, stage) as any[]
    this.db.query('DELETE FROM events WHERE task = ? AND stage = ?').run(task, stage)
    return rows.map(r => JSON.parse(r.doc))
  }
  countEvents(task: string, stage: EventStage = 'ready'): number {
    return Number((this.db.query('SELECT COUNT(*) AS n FROM events WHERE task = ? AND stage = ?').get(task, stage) as any)?.n ?? 0)
  }
  tasksWithEvents(stage: EventStage = 'ready'): string[] {
    return (this.db.query('SELECT DISTINCT task FROM events WHERE stage = ?').all(stage) as any[]).map(r => r.task)
  }
  dropEvents(task: string): void { this.db.query('DELETE FROM events WHERE task = ?').run(task) }

  // --- rule state --------------------------------------------------------------------

  getRuleState(task: string): RuleState {
    const row = this.db.query('SELECT doc FROM rule_state WHERE task = ?').get(task) as any
    return row ? JSON.parse(row.doc) : {}
  }
  setRuleState(task: string, st: RuleState): void {
    this.db.query('INSERT OR REPLACE INTO rule_state (task, doc) VALUES (?, ?)').run(task, JSON.stringify(st))
  }

  // --- questions a run asked -----------------------------------------------------

  createWait(w: Omit<Wait, 'id'>): Wait {
    const wait: Wait = { ...w, id: this.newId('waits') }
    this.db.query('INSERT INTO waits (id, task, state, doc) VALUES (?, ?, ?, ?)').run(wait.id, wait.task, wait.state, JSON.stringify(wait))
    return wait
  }
  getWait(id: string): Wait | undefined {
    const row = this.db.query('SELECT doc FROM waits WHERE id = ?').get(id) as any
    return row ? JSON.parse(row.doc) : undefined
  }
  updateWait(id: string, patch: Partial<Wait>): Wait | undefined {
    const cur = this.getWait(id)
    if (!cur) return undefined
    const next: Wait = { ...cur, ...patch, id }
    for (const k of Object.keys(patch) as (keyof Wait)[]) if (patch[k] === undefined) delete (next as any)[k]
    this.db.query('UPDATE waits SET state = ?, doc = ? WHERE id = ?').run(next.state, JSON.stringify(next), id)
    return next
  }
  // Questions still waiting for an answer, oldest first.
  openWaits(): Wait[] {
    return (this.db.query("SELECT doc FROM waits WHERE state IN ('open','parked')").all() as any[]).map(r => JSON.parse(r.doc))
      .sort((a: Wait, b: Wait) => a.askedAt.localeCompare(b.askedAt))
  }
  // The question asked in this message, if it is one still waiting.
  waitByMessage(chat: string, msg: number): Wait | undefined {
    return this.openWaits().find(w => w.chat === chat && w.askedMsg === msg)
  }
  waitsForRun(run: string): Wait[] {
    return (this.db.query('SELECT doc FROM waits').all() as any[]).map(r => JSON.parse(r.doc)).filter((w: Wait) => w.run === run)
  }

  // --- hand-offs between topics ------------------------------------------------------

  createHandoff(h: Omit<Handoff, 'id'>): Handoff {
    const handoff: Handoff = { ...h, id: this.newId('handoffs') }
    this.db.query('INSERT INTO handoffs (id, chat, state, created_at, doc) VALUES (?, ?, ?, ?, ?)').run(handoff.id, handoff.chat, handoff.state, handoff.createdAt, JSON.stringify(handoff))
    return handoff
  }
  getHandoff(id: string): Handoff | undefined {
    const row = this.db.query('SELECT doc FROM handoffs WHERE id = ?').get(id) as any
    return row ? JSON.parse(row.doc) : undefined
  }
  updateHandoff(id: string, patch: Partial<Handoff>): Handoff | undefined {
    const cur = this.getHandoff(id)
    if (!cur) return undefined
    const next: Handoff = { ...cur, ...patch, id }
    for (const k of Object.keys(patch) as (keyof Handoff)[]) if (patch[k] === undefined) delete (next as any)[k]
    this.db.query('UPDATE handoffs SET state = ?, doc = ? WHERE id = ?').run(next.state, JSON.stringify(next), id)
    return next
  }
  // A group's hand-offs since a time, newest first.
  handoffsSince(chat: string, since: string): Handoff[] {
    return (this.db.query('SELECT doc FROM handoffs WHERE chat = ? AND created_at >= ? ORDER BY created_at DESC').all(chat, since) as any[]).map(r => JSON.parse(r.doc))
  }
  // Those a restart left queued or running.
  openHandoffs(): Handoff[] {
    return (this.db.query("SELECT doc FROM handoffs WHERE state IN ('queued','running')").all() as any[]).map(r => JSON.parse(r.doc))
  }
  // Those sent to another bot and not yet answered.
  sentHandoffs(): Handoff[] {
    return (this.db.query("SELECT doc FROM handoffs WHERE state = 'sent'").all() as any[]).map(r => JSON.parse(r.doc))
  }
  // A hand-off between bots, by its tag and the way it went.
  handoffByTag(tag: string, direction: 'out' | 'in', peer?: string): Handoff | undefined {
    return (this.db.query('SELECT doc FROM handoffs').all() as any[]).map(r => JSON.parse(r.doc))
      .find((h: Handoff) => h.peerTag === tag && h.direction === direction && (peer === undefined || h.peer === peer))
  }
}

export type EventStage = 'ready' | 'candidate'

// The JSON part: everything except what the columns hold.
function docOf(t: Task): Omit<Task, 'id' | 'chat' | 'thread' | 'state' | 'nextDue'> {
  const { id, chat, thread, state, nextDue, ...rest } = t
  return rest
}
function taskOf(row: any): Task {
  const doc = JSON.parse(row.doc)
  const t: Task = { ...doc, id: row.id, chat: row.chat, state: row.state }
  if (row.thread !== null && row.thread !== undefined) t.thread = Number(row.thread)
  if (row.next_due) t.nextDue = row.next_due
  return t
}
function runDoc(r: Run): Omit<Run, 'id' | 'task' | 'state' | 'startedAt'> {
  const { id, task, state, startedAt, ...rest } = r
  return rest
}
function runOf(row: any): Run {
  const r: Run = { ...JSON.parse(row.doc), id: row.id, task: row.task, state: row.state }
  if (row.started_at) r.startedAt = row.started_at
  return r
}

function dupKey(t: Pick<Task, 'trigger' | 'action'>): string {
  const a = t.action.kind === 'message' ? `m:${norm(t.action.text)}`
    : t.action.kind === 'claude' ? `c:${t.action.session}:${norm(t.action.prompt)}`
    : t.action.kind === 'script' ? `s:${norm(t.action.command)}`
    : t.action.kind === 'digest' ? `d:${[...t.action.of].sort().join(',')}`
    : t.action.kind === 'steps' ? `p:${norm(JSON.stringify(t.action.steps))}`
    : 'none'
  const tr = t.trigger.kind === 'cron' ? `cron:${t.trigger.expr.trim().replace(/\s+/g, ' ')}`
    : t.trigger.kind === 'every' ? `every:${t.trigger.everyMs}`
    : t.trigger.kind === 'watch' ? `watch:${norm(t.trigger.command)}:${t.trigger.everyMs ?? 'stream'}`
    : t.trigger.kind === 'after' ? `after:${t.trigger.task}:${t.trigger.on}`
    : t.trigger.kind === 'webhook' ? 'webhook'
    : `at:${t.trigger.at}`
  const f = (t as Task).rule || (t as Task).ai ? `|${JSON.stringify((t as Task).rule ?? null)}|${norm((t as Task).ai?.question ?? '')}` : ''
  return `${tr}|${a}${f}`
}
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
