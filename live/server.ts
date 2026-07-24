// live/server.ts — real-time voice chat over a secure WebSocket.
//
// Browser (live/index.html) captures the mic, does client-side VAD, and sends
// one audio blob per utterance. The server transcribes it (faster-whisper),
// runs the claude CLI, and streams the answer back sentence-by-sentence as
// Kokoro audio. Barge-in: the client stops playback and sends {type:'interrupt'}
// the moment you start talking again, and the server kills the in-flight run.
//
// It reuses the repo's voice/ scripts (stt.py, kokoro_tts.py) and the claude CLI
// — no API key. Put it behind nginx on app.besporesh.ir (WSS) and gate it with a
// passcode: this drives Claude on your server, so the URL alone must not be enough.
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const VOICE = join(HERE, '..', 'voice')
const PORT = Number(process.env.LIVE_PORT || 3060)
const PASSCODE = process.env.LIVE_PASSCODE || ''
const MODEL = process.env.LIVE_MODEL || 'haiku'         // fast lane for conversation
const HEAVY_MODEL = process.env.LIVE_HEAVY_MODEL || 'opus'
const CWD = process.env.LIVE_CWD || join(HERE, '..')
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'
const PERM = process.env.LIVE_PERMISSION_MODE || 'plan' // read-only by default; the web mouth shouldn't edit unasked
const PROFILE = process.env.LIVE_PROFILE ||
  'You are on a live VOICE call. Answer in one or two short spoken sentences — plain words, no markdown, no code blocks, no lists, no URLs read aloud. Be direct and conversational.'

if (!PASSCODE) { console.error('[live] refusing to start: set LIVE_PASSCODE in .env'); process.exit(2) }

// Strip the bot token / TG_ vars from anything we spawn, but keep the voice knobs.
function childEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(e)) if (k.startsWith('TELEGRAM_') || k.startsWith('TG_') || k.startsWith('LIVE_')) delete e[k]
  for (const k of ['TG_KOKORO_VOICE', 'TG_KOKORO_MODEL', 'TG_KOKORO_VOICES', 'TG_KOKORO_SPEED', 'TG_KOKORO_LANG', 'TG_STT_MODEL', 'TG_STT_LANG'])
    if (process.env[k]) e[k] = process.env[k]
  return e
}

// --- persistent STT+TTS worker (models stay hot across turns) ----------------
let worker: ReturnType<typeof spawn> | null = null
let reqId = 0
const pending = new Map<number, (v: any) => void>()
let readyResolve: () => void
let workerReady = new Promise<void>(r => (readyResolve = r))

function startWorker() {
  worker = spawn('python3', [join(HERE, 'worker.py')], { cwd: CWD, env: childEnv(), stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = ''
  worker.stdout!.on('data', d => {
    buf += d
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let m: any; try { m = JSON.parse(line) } catch { continue }
      if (m.fatal) { console.error(`[live] worker: ${m.fatal}`); continue }
      if (m.ready) { readyResolve(); console.log('[live] worker ready (whisper + kokoro loaded)') }
      else if (m.id != null) { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m) } }
    }
  })
  worker.on('exit', code => {
    console.error(`[live] worker exited (${code}); respawning`)
    for (const [, cb] of pending) cb({ error: 'worker died' }); pending.clear()
    workerReady = new Promise<void>(r => (readyResolve = r))
    worker = null; setTimeout(startWorker, 1000)
  })
}
function workerReq(req: any): Promise<any> {
  return new Promise(async res => {
    await workerReady
    const id = ++reqId; pending.set(id, res)
    try { worker!.stdin!.write(JSON.stringify({ ...req, id }) + '\n') } catch { pending.delete(id); res({ error: 'no worker' }) }
  })
}

// audio blob (any container ffmpeg/whisper can read) -> transcript text
async function transcribe(audio: Buffer): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'live-in-'))
  const f = join(dir, 'utt.webm')
  try {
    writeFileSync(f, audio)
    const r = await workerReq({ cmd: 'stt', file: f })
    if (r.error) { console.error(`[live] stt: ${r.error}`); return '' }
    return (r.text || '').trim()
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// text -> WAV bytes (Kokoro af_heart by default)
async function synth(text: string): Promise<Buffer | null> {
  const dir = mkdtempSync(join(tmpdir(), 'live-out-'))
  const wav = join(dir, 'a.wav')
  try {
    const r = await workerReq({ cmd: 'tts', text, out: wav })
    if (r.ok && existsSync(wav)) return readFileSync(wav)
    if (r.error) console.error(`[live] tts: ${r.error}`)
    return null
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// Split streamed text into speakable sentences as they complete.
function drainSentences(buf: string): { done: string[]; rest: string } {
  const done: string[] = []
  let rest = buf
  const re = /[^.!?…]+[.!?…]+[\s]*/g
  let m: RegExpExecArray | null, last = 0
  while ((m = re.exec(buf))) { done.push(m[0].trim()); last = re.lastIndex }
  rest = buf.slice(last)
  return { done, rest }
}

type Conn = { authed: boolean; sessionId?: string; run?: ReturnType<typeof spawn>; gen: number }

const server = Bun.serve<Conn>({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === '/ws') {
      if (srv.upgrade(req, { data: { authed: false, gen: 0 } })) return
      return new Response('upgrade failed', { status: 400 })
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(readFileSync(join(HERE, 'index.html')), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    return new Response('not found', { status: 404 })
  },
  websocket: {
    maxPayloadLength: 32 * 1024 * 1024,
    open(ws) { ws.send(JSON.stringify({ type: 'hello' })) },
    close(ws) { try { ws.data.run?.kill('SIGKILL') } catch {} },
    async message(ws, raw) {
      // Control messages are JSON strings; audio utterances are binary.
      if (typeof raw === 'string') {
        let msg: any; try { msg = JSON.parse(raw) } catch { return }
        if (msg.type === 'auth') {
          ws.data.authed = msg.pass === PASSCODE
          ws.send(JSON.stringify(ws.data.authed ? { type: 'ready' } : { type: 'denied' }))
          if (!ws.data.authed) ws.close()
          return
        }
        if (!ws.data.authed) return
        if (msg.type === 'interrupt') { ws.data.gen++; try { ws.data.run?.kill('SIGKILL') } catch {}; ws.data.run = undefined }
        return
      }
      if (!ws.data.authed) return

      // A completed utterance arrived. Transcribe → claude → speak, tagged with a
      // generation number so a barge-in (which bumps gen) cancels this whole run.
      const gen = ++ws.data.gen
      const audio = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      const alive = () => ws.data.gen === gen && ws.readyState === 1

      const heard = await transcribe(audio)
      if (!alive()) return
      if (!heard) { ws.send(JSON.stringify({ type: 'nospeech' })); return }
      ws.send(JSON.stringify({ type: 'you', text: heard }))

      // Route: real work → heavy model, otherwise the fast one.
      const heavy = /\b(edit|write|change|fix|run|deploy|commit|refactor|build|delete|create|install|push)\b/i.test(heard)
      const model = heavy ? HEAVY_MODEL : MODEL
      const args = ['-p', heard, '--output-format', 'stream-json', '--verbose', '--model', model,
        '--permission-mode', PERM, '--append-system-prompt', PROFILE]
      if (ws.data.sessionId) args.push('--resume', ws.data.sessionId)

      const child = spawn(CLAUDE_BIN, args, { cwd: CWD, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
      ws.data.run = child
      let jsonBuf = '', textBuf = '', full = ''
      const speakQueue: string[] = []; let speaking = false
      const pump = async () => {
        if (speaking) return; speaking = true
        while (speakQueue.length && alive()) {
          const s = speakQueue.shift()!
          const wav = await synth(s)
          if (wav && alive()) ws.send(wav)
        }
        speaking = false
      }
      child.stdout.on('data', d => {
        jsonBuf += d
        let nl: number
        while ((nl = jsonBuf.indexOf('\n')) >= 0) {
          const line = jsonBuf.slice(0, nl); jsonBuf = jsonBuf.slice(nl + 1)
          if (!line.trim()) continue
          let ev: any; try { ev = JSON.parse(line) } catch { continue }
          // stream-json: assistant messages carry the text; result carries the final text.
          const t = ev?.message?.content?.filter?.((c: any) => c.type === 'text').map((c: any) => c.text).join('') ?? ''
          if (ev.type === 'assistant' && t) {
            textBuf += t; full += t
            const { done, rest } = drainSentences(textBuf); textBuf = rest
            for (const s of done) if (s) { speakQueue.push(s); ws.send(JSON.stringify({ type: 'bot', text: s })) }
            pump()
          } else if (ev.type === 'result') {
            ws.data.sessionId = ev.session_id || ws.data.sessionId
          }
        }
      })
      child.on('close', async () => {
        if (ws.data.run === child) ws.data.run = undefined
        const tail = (textBuf + '').trim()
        if (tail && alive()) { speakQueue.push(tail); ws.send(JSON.stringify({ type: 'bot', text: tail })); pump() }
        // wait out the queue, then tell the client the turn is over
        const iv = setInterval(() => { if (!speaking && !speakQueue.length) { clearInterval(iv); if (alive()) ws.send(JSON.stringify({ type: 'turn_end' })) } }, 150)
      })
    },
  },
})

startWorker()
console.log(`[live] voice server on http://127.0.0.1:${server.port}  model=${MODEL}/${HEAVY_MODEL}  cwd=${CWD}`)
