// live/server.ts — real-time voice chat over a WebSocket, one session per link.
//
// The browser (live/index.html) does speech-to-text ITSELF (Web Speech API) and
// sends plain TEXT — fast, no audio upload. This server runs the claude CLI for
// that link's session and streams back the answer: thinking, tool use, and text
// as it arrives, plus Kokoro audio spoken sentence-by-sentence. Barge-in: the
// client sends {type:'interrupt'} and the in-flight run is killed.
//
// Auth is the LINK: the bridge's /live mints LIVE_URL/<uuid> bound to a Telegram
// topic's Claude session (state/live-links.json, shared on disk). The uuid is the
// only secret — no password. A persistent worker keeps Kokoro loaded for low TTS
// latency. Reuses voice/ — no API key.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.LIVE_PORT || 3060)
const DEFAULT_MODEL = process.env.LIVE_MODEL || 'haiku'   // the fast front
const HEAVY_MODEL = process.env.LIVE_HEAVY_MODEL || 'opus' // the real model for dispatched work
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'
const PERM = process.env.LIVE_PERMISSION_MODE || 'plan' // read-only by default; the web mouth shouldn't edit unasked
const LINKS_FILE = process.env.LIVE_LINKS_FILE || join(HERE, '..', 'state', 'live-links.json')
const JOBS_FILE = process.env.LIVE_JOBS_FILE || join(HERE, '..', 'state', 'live-jobs.json')
const PROFILE = process.env.LIVE_PROFILE ||
  'You are on a live VOICE call. Answer in one or two short spoken sentences — plain words, no markdown, no code, no lists, no URLs read aloud. Be direct and conversational.'

type LiveLink = { key: string; cwd: string; model?: string; sessionId?: string; created: string }
function loadLinks(): Record<string, LiveLink> { try { return JSON.parse(readFileSync(LINKS_FILE, 'utf8')) } catch { return {} } }
function saveLinks(l: Record<string, LiveLink>) { try { writeFileSync(LINKS_FILE, JSON.stringify(l, null, 2)) } catch (e) { console.error(`[live] links: ${e}`) } }
// Persist a link's advancing session id so the Telegram topic and the call stay in sync.
function syncSession(uuid: string, sessionId: string) { const l = loadLinks(); if (l[uuid]) { l[uuid].sessionId = sessionId; saveLinks(l) } }

function childEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(e)) if (k.startsWith('TELEGRAM_') || k.startsWith('TG_') || k.startsWith('LIVE_')) delete e[k]
  for (const k of ['TG_KOKORO_VOICE', 'TG_KOKORO_MODEL', 'TG_KOKORO_VOICES', 'TG_KOKORO_SPEED', 'TG_KOKORO_LANG'])
    if (process.env[k]) e[k] = process.env[k]
  return e
}

// --- persistent Kokoro worker (model stays hot) ------------------------------
let worker: ChildProcess | null = null
let reqId = 0
const pending = new Map<number, (v: any) => void>()
let readyResolve: () => void
let workerReady = new Promise<void>(r => (readyResolve = r))
function startWorker() {
  worker = spawn('python3', [join(HERE, 'worker.py')], { cwd: join(HERE, '..'), env: childEnv(), stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = ''
  worker.stdout!.on('data', d => {
    buf += d; let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let m: any; try { m = JSON.parse(line) } catch { continue }
      if (m.fatal) { console.error(`[live] worker: ${m.fatal}`); continue }
      if (m.ready) { readyResolve(); console.log('[live] worker ready (kokoro loaded)') }
      else if (m.id != null) { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m) } }
    }
  })
  worker.on('exit', code => { console.error(`[live] worker exited (${code}); respawning`); for (const [, cb] of pending) cb({ error: 'worker died' }); pending.clear(); workerReady = new Promise<void>(r => (readyResolve = r)); worker = null; setTimeout(startWorker, 1000) })
}
function workerReq(req: any): Promise<any> {
  return new Promise(async res => { await workerReady; const id = ++reqId; pending.set(id, res); try { worker!.stdin!.write(JSON.stringify({ ...req, id }) + '\n') } catch { pending.delete(id); res({ error: 'no worker' }) } })
}
async function synth(text: string): Promise<Buffer | null> {
  const dir = mkdtempSync(join(tmpdir(), 'live-out-'))
  const wav = join(dir, 'a.wav')
  try { const r = await workerReq({ cmd: 'tts', text, out: wav }); if (r.ok && existsSync(wav)) return readFileSync(wav); if (r.error) console.error(`[live] tts: ${r.error}`); return null }
  finally { rmSync(dir, { recursive: true, force: true }) }
}

function drainSentences(buf: string): { done: string[]; rest: string } {
  const done: string[] = []; const re = /[^.!?…]+[.!?…]+[\s]*/g; let m: RegExpExecArray | null, last = 0
  while ((m = re.exec(buf))) { done.push(m[0].trim()); last = re.lastIndex }
  return { done, rest: buf.slice(last) }
}

type Conn = { authed: boolean; uuid?: string; key?: string; cwd: string; model?: string; sessionId?: string; ctx?: { role: string; text: string }[]; run?: ChildProcess; gen: number }

// A stateless fast-model call — no session, returns plain text.
function haiku(prompt: string, cwd: string): Promise<string> {
  return new Promise(resolve => {
    const child = spawn(CLAUDE_BIN, ['-p', prompt, '--output-format', 'json', '--model', DEFAULT_MODEL, '--permission-mode', 'plan'],
      { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout!.on('data', d => (out += d))
    child.on('error', () => resolve(''))
    child.on('close', () => { try { resolve(String(JSON.parse(out).result ?? '').trim()) } catch { resolve('') } })
  })
}

// Speak text: split into sentences, synth each (Kokoro), send audio + a {bot} line.
async function speak(ws: any, alive: () => boolean, text: string) {
  const clean = text.trim(); if (!clean) return
  const parts: string[] = []; const re = /[^.!?…]+[.!?…]+[\s]*/g; let mm: RegExpExecArray | null, last = 0
  while ((mm = re.exec(clean))) { parts.push(mm[0].trim()); last = re.lastIndex }
  const rest = clean.slice(last).trim(); if (rest) parts.push(rest)
  for (const s of parts) { if (!alive()) return; ws.send(JSON.stringify({ type: 'bot', text: s })); const wav = await synth(s); if (wav && alive()) ws.send(wav) }
}

// --- heavy-job queue (shared file with the bridge) ---
function loadJobs(): Record<string, any> { try { return JSON.parse(readFileSync(JOBS_FILE, 'utf8')) } catch { return {} } }
function saveJobs(j: any) { try { writeFileSync(JOBS_FILE, JSON.stringify(j, null, 2)) } catch (e) { console.error(`[live] jobs: ${e}`) } }
function enqueueJob(key: string, prompt: string, cwd: string, sessionId?: string): string {
  const id = 'job-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36)
  const j = loadJobs(); j[id] = { key, prompt, model: HEAVY_MODEL, cwd, sessionId, status: 'pending', created: new Date().toISOString() }; saveJobs(j)
  return id
}
function waitForJob(id: string, alive: () => boolean, timeoutMs = 300000): Promise<any> {
  const t0 = Date.now()
  return new Promise(resolve => {
    const iv = setInterval(() => {
      if (!alive() || Date.now() - t0 > timeoutMs) { clearInterval(iv); resolve(null); return }
      const j = loadJobs()[id]; if (j && j.status === 'done') { clearInterval(iv); resolve(j) }
    }, 800)
  })
}

// One turn: the fast front answers from context, or DISPATCHes real work to the
// heavy model (which runs in the bridge, posts to Telegram) and speaks a summary.
async function runTurn(ws: any, text: string) {
  const gen = ++ws.data.gen
  const alive = () => ws.data.gen === gen && ws.readyState === 1
  const ctx: { role: string; text: string }[] = ws.data.ctx || (ws.data.ctx = [])
  ctx.push({ role: 'user', text })

  const convo = ctx.slice(-12).map(m => (m.role === 'user' ? 'User' : 'You') + ': ' + m.text).join('\n')
  const frontPrompt =
    `You are a FAST voice assistant on a live call. Recent conversation:\n\n${convo}\n\n` +
    `Reply to the LAST user message spoken-style (1-2 short plain sentences, no markdown). Answer directly if you can ` +
    `from this conversation or general knowledge — INCLUDING follow-up questions about earlier answers. ONLY if it needs ` +
    `actually doing something on the computer (run a command, read/edit/create files, search the web or codebase, or heavy ` +
    `multi-step work) reply with exactly:\nDISPATCH: <clear standalone task>\nand nothing else.`
  const reply = await haiku(frontPrompt, ws.data.cwd)
  if (!alive()) return

  const m = reply.match(/^\s*DISPATCH:\s*([\s\S]+)/i)
  if (m && ws.data.key) {
    const task = m[1].trim()
    ws.send(JSON.stringify({ type: 'dispatch', task }))
    await speak(ws, alive, 'On it — running that on the full model. It will also appear in your Telegram chat.')
    const job = await waitForJob(enqueueJob(ws.data.key, task, ws.data.cwd, ws.data.sessionId), alive)
    if (!alive()) return
    if (job && job.result) {
      if (job.sessionId) ws.data.sessionId = job.sessionId
      ctx.push({ role: 'assistant', text: String(job.result).slice(0, 4000) })
      const summary = (await haiku(`In 1-2 short spoken sentences (no markdown), tell the user the upshot of this result:\n\n${String(job.result).slice(0, 6000)}`, ws.data.cwd)) || 'Done — see your Telegram chat for the details.'
      await speak(ws, alive, summary)
    } else {
      await speak(ws, alive, job?.error ? 'That hit an error — want me to try again?' : 'That is taking a while; it may still finish in your Telegram chat.')
    }
  } else {
    const answer = m ? m[1].trim() : reply
    ctx.push({ role: 'assistant', text: answer })
    await speak(ws, alive, answer)
  }
  if (alive()) ws.send(JSON.stringify({ type: 'turn_end' }))
  if (ctx.length > 16) ws.data.ctx = ctx.slice(-16)
}

const server = Bun.serve<Conn>({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === '/ws') { if (srv.upgrade(req, { data: { authed: false, cwd: join(HERE, '..'), gen: 0 } })) return; return new Response('upgrade failed', { status: 400 }) }
    // Any other path serves the page (the uuid lives in the path, read client-side).
    return new Response(readFileSync(join(HERE, 'index.html')), { headers: { 'content-type': 'text/html; charset=utf-8' } })
  },
  websocket: {
    maxPayloadLength: 4 * 1024 * 1024,
    open(ws) { ws.send(JSON.stringify({ type: 'hello' })) },
    close(ws) { try { ws.data.run?.kill('SIGKILL') } catch {} },
    async message(ws, raw) {
      if (typeof raw !== 'string') return // this build takes client-side text, not audio
      let msg: any; try { msg = JSON.parse(raw) } catch { return }
      if (msg.type === 'auth') {
        const link = msg.uuid ? loadLinks()[msg.uuid] : null
        if (link) {
          ws.data.authed = true; ws.data.uuid = msg.uuid; ws.data.key = link.key; ws.data.cwd = link.cwd; ws.data.model = link.model; ws.data.sessionId = link.sessionId; ws.data.ctx = []
          ws.send(JSON.stringify({ type: 'ready', where: link.cwd, model: link.model || DEFAULT_MODEL }))
        } else { ws.send(JSON.stringify({ type: 'denied' })); ws.close() }
        return
      }
      if (!ws.data.authed) return
      if (msg.type === 'interrupt') { ws.data.gen++; try { ws.data.run?.kill('SIGKILL') } catch {}; ws.data.run = undefined; return }
      if (msg.type === 'text' && typeof msg.text === 'string' && msg.text.trim()) {
        // fresh session id from disk (the topic may have advanced it in Telegram)
        if (ws.data.uuid) { const l = loadLinks()[ws.data.uuid]; if (l?.sessionId) ws.data.sessionId = l.sessionId }
        runTurn(ws, msg.text.trim())
      }
    },
  },
})

startWorker()
console.log(`[live] voice server on http://127.0.0.1:${server.port}  links=${LINKS_FILE}`)
