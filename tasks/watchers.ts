/**
 * watchers.ts — the programs tasks watch with, run and read by the bridge itself: no
 * systemd, no lingering, nothing to set up on the host.
 *
 * A polled watcher runs every so often as a child of the bridge; what it printed by
 * the time it exits is its events. A streaming watcher is started detached, in its own
 * process group, at low priority, through watch.sh, which stamps each line it prints
 * with the second and appends it to a file, and the bridge reads that file on from
 * where it left off. So a bridge restart leaves it running: the new bridge finds it by
 * its pid and the start time that proves the pid is still it, reads what it wrote
 * meanwhile, and the runtime drops what is stale. After a reboot the runtime starts it
 * again.
 *
 * A watcher outlives a restart, but not a bridge gone for good: the bridge touches a
 * heartbeat file every half minute while it has watchers, and watch.sh ends its group
 * once that is an hour old.
 *
 * Which watchers should run, and what a death means, is the runtime's to decide
 * (TaskRuntime.sync and onWatcherExit); this file only starts, stops and reads them.
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { join } from 'node:path'
import { LIMITS, type Task, type WatchEvent } from './model'
import type { TaskStore, WatchProc } from './store'

const WRAPPER = join(import.meta.dir, 'watch.sh')
const READ_EVERY_MS = 1000
const READ_MAX_BYTES = 1024 * 1024        // per watcher per read: a flood is read over several seconds
const OUT_ROTATE_BYTES = 2 * 1024 * 1024  // once read to the end, a bigger output file starts over
const ERR_ROTATE_BYTES = 1024 * 1024
const ERR_TAIL = 2000
const POLL_OUT_MAX = 1024 * 1024
const SAVE_EVERY_MS = 2000                // the read position is saved this often while lines come
const BEAT_EVERY_MS = 30_000
const EXIT_MARK = '\u0001exit '

export interface WatcherExit {
  code: number | null      // null: killed, or gone without saying
  err: string              // the end of its stderr
  upMs: number
  timedOut?: boolean
}
export interface PollResult extends WatcherExit { events: WatchEvent[] }

export interface WatcherDeps {
  store: TaskStore
  now(): Date
  log(s: string): void
  dir(task: Task): string           // where its files go (state/tasks/<id>)
  cwd(task: Task): string           // where it runs: the home topic's folder
  env(): NodeJS.ProcessEnv          // the environment, without the bot's secrets
  events(task: Task, events: WatchEvent[]): void
  exited(task: Task, how: WatcherExit): void
  heartbeat?: string                // the file watch.sh checks; absent: none (tests)
}

// The process behind a pid, from /proc: its state and its start time, or nothing.
function procOf(pid: number): { state: string; start: string } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return { state: f[0], start: f[19] }
  } catch { return undefined }
}

export function alive(p: Pick<WatchProc, 'pid' | 'startTicks'>): boolean {
  const s = procOf(p.pid)
  return !!s && s.state !== 'Z' && s.start === p.startTicks
}

function killGroup(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(-pid, sig) } catch {}
}

function tailOf(path: string, n = ERR_TAIL): string {
  try {
    const size = statSync(path).size
    const fd = openSync(path, 'r')
    try {
      const len = Math.min(size, n)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, size - len)
      return buf.toString('utf8')
    } finally { closeSync(fd) }
  } catch { return '' }
}

export class Watchers {
  private live = new Map<string, WatchProc>()
  private savedAt = new Map<string, number>()
  private timer?: ReturnType<typeof setInterval>
  private polls = 0
  private waitingPolls: (() => void)[] = []
  private beatAt = 0

  constructor(private d: WatcherDeps, private maxPolls = 2) {}

  // What the last bridge left running, picked up; what died meanwhile, read to its end
  // and reported, so the runtime decides whether to start it again.
  adopt(): void {
    this.beat(true)
    for (const { task, proc } of this.d.store.listWatchers()) {
      const t = this.d.store.getTask(task)
      const wanted = t && t.state === 'active' && t.trigger.kind === 'watch' && !t.trigger.everyMs && t.trigger.command === proc.command
      if (alive(proc)) {
        if (wanted) { this.live.set(task, proc); continue }
        killGroup(proc.pid, 'SIGTERM')
        this.d.store.setWatcher(task, undefined)
        continue
      }
      const r = this.read(task, proc)
      this.d.store.setWatcher(task, undefined)
      if (t && wanted) {
        if (r.events.length) this.d.events(t, r.events)
        this.d.exited(t, { code: r.exit ?? null, err: tailOf(proc.err), upMs: Date.now() - Date.parse(proc.startedAt) })
      }
    }
    this.arm()
  }

  list(): string[] { return [...this.live.keys()] }

  status(id: string): { running: boolean; since?: string } {
    const p = this.live.get(id)
    return p ? { running: true, since: p.startedAt } : { running: false }
  }

  // Running, with this command: started if it isn't, restarted if its command changed.
  // false if it could not be started.
  ensure(t: Task): boolean {
    if (t.trigger.kind !== 'watch' || t.trigger.everyMs) return false
    const cur = this.live.get(t.id)
    if (cur && cur.command === t.trigger.command) return true
    if (cur) this.stop(t.id)
    const dir = this.d.dir(t)
    mkdirSync(dir, { recursive: true })
    const out = join(dir, 'watch.out'), err = join(dir, 'watch.err')
    writeFileSync(out, '')
    if (existsSync(err) && statSync(err).size > ERR_ROTATE_BYTES) writeFileSync(err, '')
    let pid: number | undefined
    try {
      this.beat(true)
      const child = spawn('nice', ['-n', '10', 'bash', WRAPPER, out, err, t.trigger.command], {
        cwd: this.d.cwd(t), detached: true, stdio: 'ignore',
        env: { ...this.d.env(), PYTHONUNBUFFERED: '1', XESIOUS_TASK: t.id, ...(this.d.heartbeat ? { XESIOUS_HEARTBEAT: this.d.heartbeat } : {}) },
      })
      child.on('error', e => this.d.log(`[tasks] watcher for ${t.id} could not start: ${e}`))
      child.unref()
      pid = child.pid
    } catch (e) {
      this.d.log(`[tasks] watcher for ${t.id} could not start: ${e}`)
    }
    const start = pid ? procOf(pid)?.start : undefined
    if (!pid || !start) return false
    const proc: WatchProc = { pid, startTicks: start, startedAt: this.d.now().toISOString(), command: t.trigger.command, out, err, readPos: 0 }
    this.live.set(t.id, proc)
    this.d.store.setWatcher(t.id, proc)
    this.arm()
    return true
  }

  // Stopped on purpose: its group gets TERM, then KILL if it lingers. Not reported as
  // an exit.
  stop(id: string): void {
    const p = this.live.get(id) ?? this.d.store.getWatcher(id)
    this.live.delete(id)
    this.d.store.setWatcher(id, undefined)
    if (!p || !alive(p)) return
    killGroup(p.pid, 'SIGTERM')
    const later = setTimeout(() => { if (alive(p)) killGroup(p.pid, 'SIGKILL') }, 3000)
    ;(later as any).unref?.()
  }

  // The bridge is going: stop reading, leave them running for the next one.
  detach(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const [id, p] of this.live) this.d.store.setWatcher(id, p)
    this.live.clear()
  }

  // One pass: new lines from each, and the ones that ended.
  tick(): void {
    this.beat()
    for (const [id, p] of [...this.live]) {
      const t = this.d.store.getTask(id)
      if (!t) { this.stop(id); continue }
      const r = this.read(id, p)
      if (r.events.length) this.d.events(t, r.events)
      const ended = r.exit !== undefined || !alive(p)
      if (ended) {
        // Whatever it wrote last, then why it stopped.
        const rest = this.read(id, p)
        if (rest.events.length) this.d.events(t, rest.events)
        this.live.delete(id)
        this.d.store.setWatcher(id, undefined)
        this.d.exited(t, { code: r.exit ?? rest.exit ?? null, err: tailOf(p.err), upMs: Date.now() - Date.parse(p.startedAt) })
      } else if (r.read && Date.now() - (this.savedAt.get(id) ?? 0) > SAVE_EVERY_MS) {
        this.d.store.setWatcher(id, p)
        this.savedAt.set(id, Date.now())
      }
    }
    if (!this.live.size && this.timer) { clearInterval(this.timer); this.timer = undefined }
  }

  // A polled watcher, run once: at most a few at a time, each within the time limit.
  async poll(t: Task): Promise<PollResult> {
    if (this.polls >= this.maxPolls) await new Promise<void>(r => this.waitingPolls.push(r))
    this.polls++
    try { return await this.runPoll(t) } finally {
      this.polls--
      this.waitingPolls.shift()?.()
    }
  }

  private runPoll(t: Task): Promise<PollResult> {
    const command = t.trigger.kind === 'watch' ? t.trigger.command : ''
    const started = Date.now()
    return new Promise(resolve => {
      let out = ''
      let err = ''
      let timedOut = false
      let done = false
      const finish = (r: PollResult) => { if (!done) { done = true; resolve(r) } }
      let child: ReturnType<typeof spawn>
      try {
        child = spawn('nice', ['-n', '10', 'bash', '-c', command], {
          cwd: this.d.cwd(t), detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...this.d.env(), PYTHONUNBUFFERED: '1', XESIOUS_TASK: t.id },
        })
      } catch (e) {
        finish({ events: [], code: null, err: String(e), upMs: 0 })
        return
      }
      const timer = setTimeout(() => { timedOut = true; if (child.pid) killGroup(child.pid, 'SIGKILL') }, LIMITS.pollTimeoutMs)
      child.stdout!.setEncoding('utf8')
      child.stderr!.setEncoding('utf8')
      child.stdout!.on('data', (s: string) => { if (out.length < POLL_OUT_MAX) out += s })
      child.stderr!.on('data', (s: string) => { err = (err + s).slice(-ERR_TAIL) })
      child.on('error', e => { clearTimeout(timer); finish({ events: [], code: null, err: String(e), upMs: Date.now() - started }) })
      child.on('close', code => {
        clearTimeout(timer)
        const at = this.d.now().toISOString()
        const events = out.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim())
          .map(text => ({ at, text: text.slice(0, LIMITS.eventTextMax) }))
        finish({ events, code: timedOut ? null : code, err, upMs: Date.now() - started, ...(timedOut ? { timedOut } : {}) })
      })
    })
  }

  // The bridge is still here: watch.sh ends its watcher once this file is an hour old.
  private beat(now = false): void {
    const hb = this.d.heartbeat
    if (!hb || (!now && Date.now() - this.beatAt < BEAT_EVERY_MS)) return
    this.beatAt = Date.now()
    try {
      if (existsSync(hb)) utimesSync(hb, new Date(), new Date())
      else { mkdirSync(dirname(hb), { recursive: true }); writeFileSync(hb, '') }
    } catch (e) { this.d.log(`[tasks] heartbeat: ${e}`) }
  }

  private arm(): void {
    if (this.timer || !this.live.size) return
    this.timer = setInterval(() => { try { this.tick() } catch (e) { this.d.log(`[tasks] reading watchers: ${e}`) } }, READ_EVERY_MS)
    ;(this.timer as any).unref?.()
  }

  // New complete lines since the read position: the events, and the exit line if it
  // came. A line still being written waits for its newline.
  private read(id: string, p: WatchProc): { events: WatchEvent[]; exit?: number; read: boolean } {
    const events: WatchEvent[] = []
    let exit: number | undefined
    let fd: number
    try { fd = openSync(p.out, 'r') } catch { return { events, read: false } }
    let read = false
    try {
      const size = fstatSync(fd).size
      if (size < p.readPos) p.readPos = 0          // started over under us
      if (size === p.readPos) {
        if (size > OUT_ROTATE_BYTES) { truncateSync(p.out, 0); p.readPos = 0; this.d.store.setWatcher(id, p) }
        return { events, read }
      }
      const len = Math.min(size - p.readPos, READ_MAX_BYTES)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, p.readPos)
      const end = buf.lastIndexOf(0x0a)
      if (end < 0) return { events, read }
      read = true
      p.readPos += end + 1
      for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
        const tab = line.indexOf('\t')
        if (tab < 0) continue
        const sec = Number(line.slice(0, tab))
        const text = line.slice(tab + 1).replace(/\r$/, '')
        if (text.startsWith(EXIT_MARK)) { exit = Number(text.slice(EXIT_MARK.length)); continue }
        if (!text.trim()) continue
        const at = Number.isFinite(sec) ? new Date(sec * 1000) : this.d.now()
        events.push({ at: at.toISOString(), text: text.slice(0, LIMITS.eventTextMax) })
      }
    } finally { closeSync(fd) }
    return { events, exit, read }
  }
}
