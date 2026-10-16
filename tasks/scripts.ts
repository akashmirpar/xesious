/**
 * scripts.ts — a task's script: a command with no AI, run with bash in its topic's
 * folder, at low priority, in its own process group, so a time limit ends it and
 * everything it started. Its exit status decides whether the run worked; what it
 * printed is what the runtime posts, as the task's `says` decides.
 */
import { spawn } from 'node:child_process'

export interface ScriptOutcome {
  code: number | null      // null: killed, or it couldn't start
  out: string              // the end of what it printed
  err: string              // the end of its stderr
  timedOut: boolean
  stopped?: boolean        // a person stopped it
  durationMs: number
}

const KEEP = 64 * 1024      // of each stream: the end is what matters

export function runScript(o: { command: string; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<ScriptOutcome> {
  const started = Date.now()
  return new Promise(resolve => {
    let out = ''
    let err = ''
    let timedOut = false
    let stopped = false
    let done = false
    const finish = (code: number | null) => {
      if (done) return
      done = true
      resolve({ code, out, err, timedOut, durationMs: Date.now() - started, ...(stopped ? { stopped } : {}) })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('nice', ['-n', '10', 'bash', '-c', o.command], { cwd: o.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: o.env })
    } catch (e) {
      err = String(e)
      finish(null)
      return
    }
    const group = (sig: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, sig) } catch {} }
    const end = () => { group('SIGTERM'); setTimeout(() => group('SIGKILL'), 5000) }
    const timer = setTimeout(() => { timedOut = true; end() }, o.timeoutMs)
    o.signal?.addEventListener('abort', () => { stopped = true; end() })
    child.stdout!.setEncoding('utf8')
    child.stderr!.setEncoding('utf8')
    child.stdout!.on('data', (s: string) => { out = (out + s).slice(-KEEP) })
    child.stderr!.on('data', (s: string) => { err = (err + s).slice(-KEEP) })
    child.on('error', e => { clearTimeout(timer); err = (err + String(e)).slice(-KEEP); finish(null) })
    child.on('close', code => {
      clearTimeout(timer)
      // Whatever it left in its group goes with it.
      group('SIGTERM')
      finish(timedOut || stopped ? null : code)
    })
  })
}

// What a script printed, as a code block for Telegram: the end of it when long, in a
// fence no line of it can close.
export function outputBlock(text: string, max = 3000): string {
  let t = text.replace(/\s+$/, '')
  if (t.length > max) t = `…\n${t.slice(-max)}`
  const runs = t.match(/`+/g)?.map(r => r.length) ?? []
  const fence = '`'.repeat(Math.max(3, ...runs.map(n => n + 1)))
  return `${fence}\n${t}\n${fence}`
}

// The last few lines of something, on one line, for a reason or a summary.
export function lastLines(text: string, n = 3, max = 300): string {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const s = lines.slice(-n).join(' · ')
  return s.length > max ? `…${s.slice(-(max - 1))}` : s
}
