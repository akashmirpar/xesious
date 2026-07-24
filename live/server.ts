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
const DEFAULT_MODEL = process.env.LIVE_MODEL || 'haiku'
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'
const PERM = process.env.LIVE_PERMISSION_MODE || 'plan' // read-only by default; the web mouth shouldn't edit unasked
const LINKS_FILE = process.env.LIVE_LINKS_FILE || join(HERE, '..', 'state', 'live-links.json')
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

type Conn = { authed: boolean; uuid?: string; cwd: string; model?: string; sessionId?: string; run?: ChildProcess; gen: number }

// Run one turn of text through claude, streaming events + spoken audio to the client.
async function runTurn(ws: any, text: string) {
  const gen = ++ws.data.gen
  const alive = () => ws.data.gen === gen && ws.readyState === 1
  // note: the browser already rendered the user's text locally (client-side STT),
  // so we do NOT echo a {type:'you'} back — that was the double.
  const model = ws.data.model || DEFAULT_MODEL
  const args = ['-p', text, '--output-format', 'stream-json', '--verbose', '--model', model, '--permission-mode', PERM, '--append-system-prompt', PROFILE]
  if (ws.data.sessionId) args.push('--resume', ws.data.sessionId)
  const child = spawn(CLAUDE_BIN, args, { cwd: ws.data.cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  ws.data.run = child
  let jsonBuf = '', textBuf = ''
  const speakQueue: string[] = []; let speaking = false
  const pump = async () => {
    if (speaking) return; speaking = true
    while (speakQueue.length && alive()) { const s = speakQueue.shift()!; const wav = await synth(s); if (wav && alive()) ws.send(wav) }
    speaking = false
  }
  child.stdout!.on('data', d => {
    jsonBuf += d; let nl: number
    while ((nl = jsonBuf.indexOf('\n')) >= 0) {
      const line = jsonBuf.slice(0, nl); jsonBuf = jsonBuf.slice(nl + 1)
      if (!line.trim()) continue
      let ev: any; try { ev = JSON.parse(line) } catch { continue }
      if (ev.type === 'assistant' && Array.isArray(ev?.message?.content)) {
        for (const c of ev.message.content) {
          if (c.type === 'thinking' && c.thinking) ws.send(JSON.stringify({ type: 'thinking', text: c.thinking }))
          else if (c.type === 'tool_use') ws.send(JSON.stringify({ type: 'tool', name: c.name }))
          else if (c.type === 'text' && c.text) {
            textBuf += c.text
            const { done, rest } = drainSentences(textBuf); textBuf = rest
            for (const s of done) if (s) { speakQueue.push(s); ws.send(JSON.stringify({ type: 'bot', text: s })) }
            pump()
          }
        }
      } else if (ev.type === 'result') {
        if (ev.session_id) { ws.data.sessionId = ev.session_id; if (ws.data.uuid) syncSession(ws.data.uuid, ev.session_id) }
      }
    }
  })
  child.on('close', () => {
    if (ws.data.run === child) ws.data.run = undefined
    const tail = textBuf.trim()
    if (tail && alive()) { speakQueue.push(tail); ws.send(JSON.stringify({ type: 'bot', text: tail })); pump() }
    const iv = setInterval(() => { if (!speaking && !speakQueue.length) { clearInterval(iv); if (alive()) ws.send(JSON.stringify({ type: 'turn_end' })) } }, 150)
  })
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
          ws.data.authed = true; ws.data.uuid = msg.uuid; ws.data.cwd = link.cwd; ws.data.model = link.model; ws.data.sessionId = link.sessionId
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
