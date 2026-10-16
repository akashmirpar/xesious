/**
 * store.ts — tasks, their runs, and the notes runs leave for a topic, in one SQLite
 * file (state/tasks.db). The bridge is its only writer.
 *
 * Each row keeps the whole record as JSON beside the few columns that are queried
 * (chat, topic, state, next due time), so a field added later needs no migration.
 * The columns are the truth for what they hold: state and next_due live there, not in
 * the JSON, so a claim can be a single guarded UPDATE.
 */
import { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { LIMITS, type Run, type Task, type TaskState } from './model'

const SCHEMA = 1

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

  private newId(table: 'tasks'): string {
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
}

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
  const a = t.action.kind === 'message' ? `m:${norm(t.action.text)}` : `c:${t.action.session}:${norm(t.action.prompt)}`
  const tr = t.trigger.kind === 'cron' ? `cron:${t.trigger.expr.trim().replace(/\s+/g, ' ')}`
    : t.trigger.kind === 'every' ? `every:${t.trigger.everyMs}`
    : `at:${t.trigger.at}`
  return `${tr}|${a}`
}
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
