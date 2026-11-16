// live/tunnel.ts — a working https address for /live with no domain, no DNS and no
// nginx: the bridge starts the live server (live/server.ts) and a Cloudflare quick
// tunnel in front of it, on demand.
//
// `cloudflared tunnel --url http://127.0.0.1:<port>` dials OUT to Cloudflare and
// prints an https://<random>.trycloudflare.com address; visitors reach the server
// back through that connection. No port is opened on the host and the server keeps
// listening on 127.0.0.1 only. No Cloudflare account. The catch: the address is
// new every time the tunnel starts, so the bridge reads it and mints links from it.
//
// Both processes are detached and recorded in a state file (pid + port + address),
// so they outlive a bridge restart and the next /live re-adopts them — links sent
// before the restart keep working. Anything found dead is started again.
//
// cloudflared is a single static binary; if it is not on the PATH it is downloaded
// from Cloudflare's GitHub releases into ~/.local/bin — no root, no package manager.
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, chmodSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, arch } from 'node:os'

export type LiveState = { serverPid?: number; port?: number; tunnelPid?: number; url?: string; started?: string }
export type LiveResult = { url: string; fresh: boolean } | { error: string }
export type LiveOpts = {
  stateFile: string
  logDir: string
  serverCmd: string[]          // e.g. [bun, run, /abs/live/server.ts]
  // NOT the repo root: lib.sh tells the bridge apart from other bun processes by
  // their working directory, and a live server there would pass for a bridge.
  serverCwd: string
  serverEnv: NodeJS.ProcessEnv
  port?: number                // fixed LIVE_PORT; unset = any free port
  cloudflared?: string         // explicit binary (LIVE_CLOUDFLARED)
  installDir?: string          // where a downloaded cloudflared goes
  check?: (url: string) => Promise<boolean>
  published?: (host: string) => Promise<boolean>
  timeoutMs?: number           // per step: server up, tunnel address, page reachable
  dnsTimeoutMs?: number        // a new tunnel's name reaching public DNS
  log?: (s: string) => void
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/
const REGISTERED_RE = /Registered tunnel connection/
const SERVER_PORT_RE = /voice server on http:\/\/127\.0\.0\.1:(\d+)/
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function load(f: string): LiveState { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return {} } }
function save(f: string, s: LiveState): void { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(s, null, 2)) }

// Alive AND still the program we started: a recycled pid is someone else's.
function ours(pid: number | undefined, marker: string): boolean {
  if (!pid) return false
  try { process.kill(pid, 0) } catch { return false }
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(marker) } catch { return false }
}
function stop(pid: number | undefined, marker: string): void {
  if (ours(pid, marker)) try { process.kill(-pid!, 'SIGTERM') } catch { try { process.kill(pid!, 'SIGTERM') } catch {} }
}

// The page answers through `base`: /health is a fixed "ok" from live/server.ts.
export async function pageAnswers(base: string, timeoutMs = 8000): Promise<boolean> {
  try {
    const r = await fetch(`${base.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    return r.ok && (await r.text()).trim() === 'ok'
  } catch { return false }
}

// Is a new hostname in public DNS yet? Asked over DNS-over-HTTPS, NOT through the
// host's resolver: looking a brand-new trycloudflare name up too early caches its
// "no such host" locally for a minute (the zone's negative TTL is 60 s), and every
// check in that minute fails although the tunnel works.
export async function inPublicDns(host: string): Promise<boolean> {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,
      { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) })
    const j: any = await r.json()
    return j.Status === 0 && Array.isArray(j.Answer) && j.Answer.length > 0
  } catch { return false }
}

// Wait until `re` appears in the log past `from`; null on timeout or when the process
// has exited. Returns the match. Exit is known from the child itself, not from
// ours(): just after spawn the process has not exec'd yet and its command line is
// still the bridge's, so the marker check would call it dead.
async function waitInLog(file: string, from: number, re: RegExp, exited: () => boolean, timeoutMs: number): Promise<RegExpMatchArray | null> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    let text = ''
    try { text = readFileSync(file, 'utf8').slice(from) } catch {}
    const m = text.match(re)
    if (m) return m
    if (exited()) {
      try { const m2 = readFileSync(file, 'utf8').slice(from).match(re); if (m2) return m2 } catch {}
      return null
    }
    await sleep(250)
  }
  return null
}
function logTail(file: string, from: number, lines = 3): string {
  try {
    return readFileSync(file, 'utf8').slice(from).trim().split('\n').slice(-lines).join(' | ').slice(0, 400)
  } catch { return '' }
}
function startLogged(cmd: string[], cwd: string, env: NodeJS.ProcessEnv, log: string): { pid: number; from: number; exited: () => boolean } {
  mkdirSync(dirname(log), { recursive: true })
  let from = 0
  try { from = statSync(log).size } catch {}
  const fd = openSync(log, 'a')
  try {
    const child = spawn(cmd[0], cmd.slice(1), { cwd, env, detached: true, stdio: ['ignore', fd, fd] })
    let gone = false
    child.on('error', () => { gone = true })
    child.on('exit', () => { gone = true })
    child.unref()
    if (!child.pid) throw new Error(`could not start ${cmd[0]}`)
    return { pid: child.pid, from, exited: () => gone }
  } finally { closeSync(fd) }
}

// --- cloudflared: found, or downloaded once ---------------------------------
export function findCloudflared(o: Pick<LiveOpts, 'cloudflared' | 'installDir'>): string | null {
  if (o.cloudflared) return existsSync(o.cloudflared) ? o.cloudflared : null
  const onPath = Bun.which('cloudflared')
  if (onPath) return onPath
  const local = join(o.installDir || join(homedir(), '.local', 'bin'), 'cloudflared')
  return existsSync(local) ? local : null
}
async function installCloudflared(dir: string, log: (s: string) => void): Promise<string> {
  const a = arch() === 'x64' ? 'amd64' : arch() === 'arm64' ? 'arm64' : arch() === 'arm' ? 'arm' : ''
  if (process.platform !== 'linux' || !a) throw new Error(`no cloudflared download for ${process.platform}/${arch()} — install it and put it on the PATH`)
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${a}`
  const dest = join(dir, 'cloudflared'), part = `${dest}.part`
  log(`[live] downloading cloudflared from ${url}`)
  mkdirSync(dir, { recursive: true })
  const r = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!r.ok) throw new Error(`downloading cloudflared failed: HTTP ${r.status}`)
  // Read whole, then written: Bun.write(part, r) never finishes on this redirected
  // download (Bun 1.3.14). ~40 MB, once.
  writeFileSync(part, new Uint8Array(await r.arrayBuffer()))
  chmodSync(part, 0o755)
  try { execFileSync(part, ['--version'], { timeout: 15_000, stdio: 'pipe' }) }
  catch (e) { rmSync(part, { force: true }); throw new Error(`the downloaded cloudflared does not run: ${e}`) }
  renameSync(part, dest)
  log(`[live] cloudflared installed at ${dest}`)
  return dest
}

// --- the whole thing ---------------------------------------------------------
async function bringUp(o: LiveOpts): Promise<LiveResult> {
  const log = o.log || (() => {})
  const check = o.check || ((u: string) => pageAnswers(u))
  const published = o.published || inPublicDns
  const timeout = o.timeoutMs ?? 45_000
  const SERVER = 'server.ts', TUNNEL = 'cloudflared'
  let s = load(o.stateFile)

  // 1. The live server, on 127.0.0.1. A dead one comes back on the same port, so
  // the tunnel — and every link already sent — keeps working.
  if (!(ours(s.serverPid, SERVER) && s.port && await pageAnswers(`http://127.0.0.1:${s.port}`, 3000))) {
    stop(s.serverPid, SERVER)
    const logFile = join(o.logDir, 'live-server.log')
    const tryPort = async (port: number) => {
      const { pid, from, exited } = startLogged(o.serverCmd, o.serverCwd, { ...o.serverEnv, LIVE_PORT: String(port) }, logFile)
      const m = await waitInLog(logFile, from, SERVER_PORT_RE, exited, timeout)
      if (!m) stop(pid, SERVER)
      return m ? { pid, port: Number(m[1]) } : { error: logTail(logFile, from) || 'no output' }
    }
    let r = await tryPort(o.port ?? s.port ?? 0)
    if ('error' in r && !o.port && s.port) r = await tryPort(0)    // the old port is taken
    if ('error' in r) return { error: `the live server did not start (${r.error})` }
    if (r.port !== s.port) { stop(s.tunnelPid, TUNNEL); s = {} }  // its address pointed at the old port
    s = { ...s, serverPid: r.pid, port: r.port, started: new Date().toISOString() }
    save(o.stateFile, s)
    log(`[live] server pid ${r.pid} on 127.0.0.1:${s.port}`)
  }

  // 2. The tunnel: the one already running, if it still reaches the page.
  if (s.url && ours(s.tunnelPid, TUNNEL) && await check(s.url)) return { url: s.url, fresh: false }
  stop(s.tunnelPid, TUNNEL)
  let bin = findCloudflared(o)
  if (!bin) {
    try { bin = await installCloudflared(o.installDir || join(homedir(), '.local', 'bin'), log) }
    catch (e) { return { error: String(e instanceof Error ? e.message : e) } }
  }
  const logFile = join(o.logDir, 'live-tunnel.log')
  const { pid, from, exited } = startLogged([bin, 'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${s.port}`], o.serverCwd, o.serverEnv, logFile)
  const urlMatch = await waitInLog(logFile, from, URL_RE, exited, timeout)
  // The address is printed before the tunnel is connected; checking it before the
  // connection is registered only earns a 502 or an unknown host.
  const registered = urlMatch && !exited() && await waitInLog(logFile, from, REGISTERED_RE, exited, timeout)
  if (!urlMatch || !registered) {
    stop(pid, TUNNEL)
    return { error: `the Cloudflare tunnel did not come up (${logTail(logFile, from) || 'no output'})` }
  }
  const url = urlMatch[0]
  s = { ...s, tunnelPid: pid, url }
  save(o.stateFile, s)
  log(`[live] tunnel pid ${pid} at ${url}`)

  // 3. A brand-new hostname takes a while to be published; only then is it looked up
  // here (see inPublicDns).
  const host = new URL(url).hostname
  // Usually seconds; once it took over 45 s, so this wait is longer.
  let end = Date.now() + Math.max(timeout, o.dnsTimeoutMs ?? 120_000)
  while (!await published(host)) {
    if (Date.now() > end) return { error: `the tunnel is up at ${url} but its name is not in DNS yet — try /live again in a minute` }
    await sleep(2000)
  }
  end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check(url)) return { url, fresh: true }
    await sleep(1500)
  }
  return { error: `the tunnel is up at ${url} but the page does not answer through it yet — try /live again in a minute` }
}

// One bring-up at a time: two /live sent together share it.
let inflight: Promise<LiveResult> | null = null
export function ensureLive(o: LiveOpts): Promise<LiveResult> {
  return inflight ??= bringUp(o).catch(e => ({ error: String(e instanceof Error ? e.message : e) })).finally(() => { inflight = null })
}

// The live server was started and has died since: the bridge's watchdog brings it
// back (on the same port, so open pages can reconnect through the same tunnel).
export function serverDown(stateFile: string): boolean {
  const s = load(stateFile)
  return !!s.serverPid && !ours(s.serverPid, 'server.ts')
}

// What runs now, for tests and for stopping it by hand.
export function liveState(stateFile: string): LiveState { return load(stateFile) }
export function stopLive(stateFile: string): void {
  const s = load(stateFile)
  stop(s.tunnelPid, 'cloudflared')
  stop(s.serverPid, 'server.ts')
  save(stateFile, {})
}
