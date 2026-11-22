// live/server.ts — real-time voice chat over a WebSocket, one session per link.
//
// Hearing: the page (live/index.html) streams the mic to this server as 16 kHz mono
// PCM, and the server streams it on to Soniox (live/soniox.ts): Farsi and English,
// people told apart. What is heard is decided in live/call.ts (whose voice is "me",
// the answer's own echo, "stop", whether a sentence is finished), and the caller's words run a
// turn. Without SONIOX_API_KEY the page falls back to the browser's own speech
// recognition and sends text.
//
// When is a request finished? Not when Soniox
// thinks so: Soniox's own end-of-speech is off. A piece of speech ends after
// END_SILENCE_MS of quiet in the audio itself (live/vad.ts — not "no new words",
// which Soniox writes out up to a second late), or when the caller has been quiet that long
// while others keep talking; then it waits QUIET_MS more in case they go on, and up to MAX_WAIT_MS
// when the sentence sounds cut off. If they go on after it was sent, before Claude has
// said anything (MERGE_MS), the run is cancelled and it is asked again whole. While
// the talk button is held nothing is cut; letting go sends at once.
//
// Answering: each request runs inside the bot, as a turn in the link's topic (its
// session, queue, mode, tools, instructions and group memory), through the bot's
// local API (POST /v1/live/turn on state/xesious.sock), streamed back as it runs.
// Without that API (tasks off in the bot), the claude CLI runs here on the link's
// session instead, in the topic's permission mode but without the bot's tools.
// Each answer says which request it answers. Sentences are spoken as they come:
// English with Paradee, Farsi with Soniox's voice.
//
// Every call is recorded for debugging (live/recorder.ts): the mic audio, a trace of
// every step, and each spoken sentence, under state/live-calls/, kept 7 days.
//
// Auth is the LINK: the bridge's /live mints <address>/<uuid> bound to a Telegram
// topic's Claude session (state/live-links.json, shared on disk). It expires (an
// hour) and belongs to the first device that opens it (live/access.ts).
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { ServerWebSocket } from 'bun'
import { linkExpired, claimDevice, ownLink } from './access'
import { drainSentences } from './sentences'
import { SonioxStream, TokenTracker, type Turn } from './soniox'
import { requestTimings, summarize, latencyLine, readTrace } from './latency'
import { decideFast, fastAction, fastWorthAsking, type FastResult } from './fast'
import { OpusIn, isOpus } from './opus'
import { ARMED_MS, CallState, CALL_MODES, callWord, quietAfter, requestText, sendDecision, unclear, type CallMode, type Line } from './call'
import { kwsPhrases } from './kws'
import { CallRecorder, pruneCalls, pcmToWav } from './recorder'
import { Vad } from './vad'
import { usageOf } from '../lib'
import { UsageLedger } from '../usage'

const HERE = dirname(fileURLToPath(import.meta.url))
// The phone's wake-word spotter: Vosk in the browser (vosk-browser) with its small
// English model, set up once with live/kws-setup.sh, served at /kws/. Without them the
// page has no wake word while the mic is off, and everything else works as before.
const KWS_DIR = process.env.LIVE_KWS_DIR || join(HERE, '..', 'state', 'kws')
const KWS_MODEL = 'vosk-model-small-en-us-0.15.tar.gz'
const KWS_FILES: Record<string, string> = { 'vosk.js': 'text/javascript; charset=utf-8', 'vosk-worker.js': 'text/javascript; charset=utf-8', [KWS_MODEL]: 'application/gzip' }
const kwsReady = () => Object.keys(KWS_FILES).every(f => existsSync(join(KWS_DIR, f)))
const kwsFor = (wake: string[]) => {
  if (!kwsReady()) return undefined
  const phrases = kwsPhrases(wake)
  // bytes: so the page can show the first download as a percent even if the size header is lost on the way
  return phrases.length ? { model: `/kws/${KWS_MODEL}`, bytes: statSync(join(KWS_DIR, KWS_MODEL)).size, phrases, conf: KWS_CONF } : undefined
}
// A hit counts only when Vosk is this sure of "hey" (the phrase's first word; the
// browser build scores the last word at ~0.5 regardless). Tested 2026-11-19 in the
// browser on ~50 fast "Hey Lucy": 44/50 at 0.9, 47/50 with no cutoff.
const KWS_CONF = Number(process.env.LIVE_KWS_CONF ?? 0.9)
// A wake heard on the phone must be the wake phrase in what Soniox hears within this
// long; if not, the mic goes off again by itself (a false wake costs only these seconds).
const WOKE_CONFIRM_MS = Number(process.env.LIVE_WOKE_CONFIRM_MS ?? 8000)
// …and if nothing is asked this long after a wake, the mic goes off again (a wake from
// someone nearby kept it on 27 s, 2026-11-22). Longer while the caller is still talking.
const WOKE_IDLE_MS = Number(process.env.LIVE_WOKE_IDLE_MS ?? 10_000)
// The call's own page actions (mic off, mode, answers) decided by a fast decision model
// (live/fast.ts) instead of a Claude turn. Off with LIVE_FAST=0 or without a key.
const FAST = { key: process.env.OPENROUTER_API_KEY || '', models: (process.env.LIVE_FAST_MODELS || 'typesafe/jev-1.14,perplexity/pplx-decider-flash-v1.3:free').split(',').map(s => s.trim()).filter(Boolean), timeoutMs: Number(process.env.LIVE_FAST_TIMEOUT_MS ?? 1200), url: process.env.LIVE_FAST_URL || undefined }
const FAST_ON = !!FAST.key && process.env.LIVE_FAST !== '0'
const FAST_MIN = Number(process.env.LIVE_FAST_MIN ?? 0.9)
// How much longer than the quiet wait a request may wait for the fast decision.
const FAST_EXTRA_MS = Number(process.env.LIVE_FAST_EXTRA_MS ?? 300)
const PORT = Number(process.env.LIVE_PORT || 3060)
const DEFAULT_MODEL = process.env.LIVE_MODEL || 'sonnet'
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'
// The topic's own mode comes with the link (set by /live and kept current by /mode).
// LIVE_PERMISSION_MODE overrides it for every call.
const PERM_OVERRIDE = process.env.LIVE_PERMISSION_MODE || ''
const LINKS_FILE = process.env.LIVE_LINKS_FILE || join(HERE, '..', 'state', 'live-links.json')
// Each person's own call settings, kept across calls and links (a link lasts an hour):
// the words that call it in Assistant mode. Keyed by Telegram user id.
const PREFS_FILE = process.env.LIVE_PREFS_FILE || join(dirname(LINKS_FILE), 'live-prefs.json')
const WAKE_DEFAULT = process.env.LIVE_WAKE_WORDS || 'Lucy, Lucie, لوسی'
const parseWake = (s: string) => s.split(/[,،\n]/).map(w => w.trim().slice(0, 40)).filter(Boolean).slice(0, 10)
function loadPrefs(): Record<string, { wake?: string[]; others?: boolean }> {
  try { const p = JSON.parse(readFileSync(PREFS_FILE, 'utf8')); return p && typeof p === 'object' ? p : {} } catch { return {} }
}
function wakeFor(who: string): string[] {
  const p = loadPrefs()
  const w = Object.hasOwn(p, who) ? p[who]?.wake : undefined
  return Array.isArray(w) && w.length ? w.filter(x => typeof x === 'string').slice(0, 10) : parseWake(WAKE_DEFAULT)
}
// Whether others on the call may call it by name in Assistant mode: off unless set.
function othersFor(who: string): boolean { const p = loadPrefs(); return Object.hasOwn(p, who) && p[who]?.others === true }
function savePref(who: string, patch: { wake?: string[]; others?: boolean }): void {
  const p = loadPrefs()
  p[who] = { ...(Object.hasOwn(p, who) ? p[who] : {}), ...patch }
  try { const tmp = `${PREFS_FILE}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(p, null, 2), { mode: 0o600 }); renameSync(tmp, PREFS_FILE) }
  catch (e) { console.error(`[live] could not save prefs: ${e}`) }
}
const prefsKey = (ws: WS) => ws.data.me !== undefined ? `user:${ws.data.me}` : `link:${ws.data.uuid}`
const modeFrom = (v: unknown): CallMode | undefined => CALL_MODES.includes(v as CallMode) ? v as CallMode : undefined
// The bot's local API, and the token for it (the bot passes both when it starts this
// server; next to the links file otherwise).
const API_SOCK = process.env.LIVE_API_SOCK || join(dirname(LINKS_FILE), 'xesious.sock')
const API_TOKEN_FILE = process.env.LIVE_API_TOKEN_FILE || join(dirname(LINKS_FILE), 'xesious.token')
const CALLS_DIR = process.env.LIVE_CALLS_DIR || join(dirname(LINKS_FILE), 'live-calls')
const KEEP_DAYS = Number(process.env.LIVE_KEEP_DAYS ?? 7)
const TTS = process.env.LIVE_TTS !== 'off'
const SONIOX_KEY = process.env.SONIOX_API_KEY || ''
const SONIOX = {
  url: process.env.LIVE_SONIOX_URL || undefined,
  model: process.env.LIVE_SONIOX_MODEL || 'stt-rt-v6',
  languages: (process.env.LIVE_LANGUAGES || 'en,fa').split(',').map(s => s.trim()).filter(Boolean),
  // Soniox's own end-of-speech, off by default: it ended pieces at every natural
  // pause, and each piece went to Claude half-said.
  endpointMs: Number(process.env.LIVE_ENDPOINT_MS ?? 0),
  // Words Soniox should expect (its "context"). None unless set.
  terms: (process.env.LIVE_TERMS ?? '').split(',').map(s => s.trim()).filter(Boolean),
}
const END_SILENCE_MS = Number(process.env.LIVE_END_SILENCE_MS ?? 1300)
// A page that has sent nothing for this long is gone, whatever the connection says:
// its call is closed, and its Soniox stream with it, or the call never ends. The page
// pings every 20 s.
const STALE_MS = Number(process.env.LIVE_STALE_MS ?? 60_000)
// The page is told how much audio has arrived after each this much of it.
const ACK_BYTES = 32_000
const QUIET_MS = Number(process.env.LIVE_QUIET_MS ?? 1000)
// …or only this much when what was said already sounds finished (final punctuation, no
// word left hanging). On the recorded calls (2026-11-21), of 109 such pieces that went out
// as requests, 104 waited the full second for nothing; 2 went on 0.7–0.8 s later (sent
// early, then redone with the rest, as redoIfCut does), the rest sooner or caught by
// "still talking". Saves ~0.7 s on most requests.
const QUIET_DONE_MS = Math.min(Number(process.env.LIVE_QUIET_DONE_MS ?? 300), QUIET_MS)
// Sent too soon: if they go on within this long and Claude has not said anything yet,
// the run is cancelled and the whole thing is asked again as one request. People
// pause 3–5 s mid-sentence to think; waiting that long every time would
// slow every answer, so a request goes early and is redone when it was cut.
const MERGE_MS = Number(process.env.LIVE_MERGE_MS ?? 10_000)
const MAX_WAIT_MS = Number(process.env.LIVE_MAX_WAIT_MS ?? 6000)
const NOTICE_WAIT_MS = Number(process.env.LIVE_NOTICE_WAIT_MS ?? 30_000)
// How long a notice waits at most for an answer still playing on the page.
const PLAYING_WAIT_MS = 120_000
// The longest the desk may turn the mic off for, to come back on by itself: longer, and
// it may come on when the caller has forgotten it was off (the bot checks this too).
const MIC_OFF_MAX_MS = 3 * 60_000
const SONIOX_TTS_URL = process.env.LIVE_SONIOX_TTS_URL || 'https://tts-rt.soniox.com/tts'
const FARSI_VOICE = process.env.LIVE_FARSI_VOICE || 'Layla'   // Soniox has no Persian voice; this Arabic one reads Farsi
// English: Paradee, kept loaded on this machine (~0.1–0.4 s a sentence). Or kokoro (~6.5 s a sentence on this CPU), or the
// name of a Soniox voice (e.g. Grace: streamed, first audio ~0.4 s).
const ENGLISH_VOICE = process.env.LIVE_ENGLISH_VOICE || 'paradee'
const PARADEE_PY = process.env.LIVE_PARADEE_PYTHON || join(HERE, '..', 'voice', 'paradee', '.venv', 'bin', 'python')
// The bridge's usage ledger (usage.ts), shared on disk like the links: a call's turns
// count toward the same instance total. Off with TG_USAGE=0; never fatal.
let ledger: UsageLedger | undefined
try { if (!/^(0|false|no|off)$/i.test(process.env.TG_USAGE || '1')) ledger = new UsageLedger(process.env.TG_USAGE_DB || join(HERE, '..', 'state', 'usage.db')) }
catch (e) { console.error(`[live] usage ledger: ${e}`) }
const PROFILE = process.env.LIVE_PROFILE ||
  'You are on a live VOICE call. Answer in one or two short spoken sentences — plain words, no markdown, no code, no lists, no URLs read aloud. ' +
  'Be direct and conversational. Answer in the language of their message; they may mix languages. ' +
  // The same as SPEECH_NOTE in lib.ts (this server does not import it).
  'Their words come through speech recognition, which can mishear words, especially names, numbers, technical terms, and words in a different language from the rest. ' +
  'If they correct themselves part way through, the later version is what they mean. If something that matters is unclear, ask before acting on it.'

type LiveLink = { key: string; cwd: string; model?: string; sessionId?: string; created: string; updated?: string; used?: string; device?: string; permission?: string[]; desk?: string; user?: { id: number; name: string } }
function loadLinks(): Record<string, LiveLink> { try { return JSON.parse(readFileSync(LINKS_FILE, 'utf8')) } catch { return {} } }
// Written whole and renamed into place (the bridge writes this file too), private to this user.
function saveLinks(l: Record<string, LiveLink>) {
  try { const tmp = `${LINKS_FILE}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(l, null, 2), { mode: 0o600 }); renameSync(tmp, LINKS_FILE) }
  catch (e) { console.error(`[live] links: ${e}`) }
}
// Persist a link's advancing session id so the Telegram topic and the call stay in
// sync. The stamp is what tells the bridge the call is ahead of the topic — without
// it the topic's own session wins (see resumeIdFor in bridge.ts).
// The link is in use: it expires LINK_TTL_MIN after the last of these. Written at most
// once a minute.
const usedStamped = new Map<string, number>()
function stampUsed(uuid: string | undefined) {
  if (!uuid || Date.now() - (usedStamped.get(uuid) ?? 0) < 60_000) return
  const l = loadLinks(), link = ownLink(l, uuid)
  if (!link) return
  link.used = new Date().toISOString(); saveLinks(l)
  usedStamped.set(uuid, Date.now())
}
function syncSession(uuid: string, sessionId: string) { const l = loadLinks(), link = ownLink(l, uuid); if (link) { link.sessionId = sessionId; link.updated = new Date().toISOString(); saveLinks(l) } }
function permissionArgs(link: LiveLink | undefined): string[] {
  if (PERM_OVERRIDE) return ['--permission-mode', PERM_OVERRIDE]
  const p = link?.permission
  return Array.isArray(p) && p.length && p.every(a => typeof a === 'string') ? p : ['--permission-mode', 'default']
}

function childEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(e)) if (/^(TELEGRAM_|TG_|LIVE_|SONIOX_)/.test(k)) delete e[k]
  for (const k of ['TG_KOKORO_VOICE', 'TG_KOKORO_MODEL', 'TG_KOKORO_VOICES', 'TG_KOKORO_SPEED', 'TG_KOKORO_LANG'])
    if (process.env[k]) e[k] = process.env[k]
  return e
}

// --- local voices, each a long-lived Python worker with its model loaded ---------
// One JSON request per line in, one JSON answer per line out (live/worker.py for
// Kokoro, live/paradee_worker.py for Paradee). Restarted if it dies.
class VoiceWorker {
  private proc: ChildProcess | null = null
  private next = 0
  private waiting = new Map<number, (v: any) => void>()
  private ready!: Promise<void>
  private markReady!: () => void
  failed = ''
  constructor(private name: string, private cmd: string[], private env: NodeJS.ProcessEnv) { this.start() }
  private start() {
    this.ready = new Promise<void>(r => (this.markReady = r))
    const p = this.proc = spawn(this.cmd[0], this.cmd.slice(1), { cwd: join(HERE, '..'), env: this.env, stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    p.stdout!.on('data', d => {
      buf += d; let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        let m: any; try { m = JSON.parse(line) } catch { continue }
        if (m.fatal) { this.failed = m.fatal; console.error(`[live] ${this.name}: ${m.fatal}`); this.markReady() }
        else if (m.ready) { this.failed = ''; this.markReady(); console.log(`[live] ${this.name} ready`) }
        else if (m.id != null) { const cb = this.waiting.get(m.id); if (cb) { this.waiting.delete(m.id); cb(m) } }
      }
    })
    p.on('error', e => { this.failed = String(e); this.markReady() })
    p.on('exit', code => {
      for (const [, cb] of this.waiting) cb({ error: `${this.name} exited` })
      this.waiting.clear(); this.proc = null
      if (!this.failed) { console.error(`[live] ${this.name} exited (${code}); restarting`); setTimeout(() => this.start(), 1000) }
    })
  }
  async ask(req: Record<string, unknown>): Promise<any> {
    await this.ready
    if (this.failed || !this.proc) return { error: this.failed || `${this.name} is not running` }
    const id = ++this.next
    return new Promise(res => { this.waiting.set(id, res); try { this.proc!.stdin!.write(JSON.stringify({ ...req, id }) + '\n') } catch { this.waiting.delete(id); res({ error: 'write failed' }) } })
  }
}
function voiceEnv(): NodeJS.ProcessEnv {
  const e = childEnv()
  for (const k of Object.keys(process.env)) if (/^TG_(PARADEE|KOKORO)_/.test(k)) e[k] = process.env[k]
  return e
}
let kokoroWorker: VoiceWorker | null = null, paradeeWorker: VoiceWorker | null = null

// A spoken sentence: its audio as 16-bit PCM pieces, filled in as they are made.
type Voice = { text: string; voice: string; rate: number; chunks: Uint8Array[]; done: boolean; error?: string; started: number; firstMs?: number; wake?: () => void; abort: AbortController }
// The PCM inside a WAV file, and its rate.
function wavPcm(buf: Buffer): { pcm: Uint8Array; rate: number } {
  let i = 12, rate = 24000
  while (i + 8 <= buf.length) {
    const id = buf.toString('ascii', i, i + 4), size = buf.readUInt32LE(i + 4)
    if (id === 'fmt ') rate = buf.readUInt32LE(i + 12)
    if (id === 'data') return { pcm: new Uint8Array(buf.subarray(i + 8, Math.min(buf.length, i + 8 + size))), rate }
    i += 8 + size + (size % 2)
  }
  return { pcm: new Uint8Array(buf.subarray(44)), rate }
}
function put(v: Voice, pcm: Uint8Array) { if (!pcm.byteLength) return; if (v.firstMs === undefined) v.firstMs = Date.now() - v.started; v.chunks.push(pcm); v.wake?.() }
function finish(v: Voice, error?: string) { v.done = true; if (error) v.error = error; v.wake?.() }
// Local voices make the whole sentence, then it goes as one piece.
async function local(v: Voice, w: VoiceWorker, wav: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'live-out-'))
  const out = join(dir, wav ? 'a.wav' : 'a.pcm')
  try {
    const r = await w.ask({ cmd: 'tts', text: v.text, out })
    if ((r.ok) && existsSync(out)) {
      if (wav) { const { pcm, rate } = wavPcm(readFileSync(out)); v.rate = rate; put(v, pcm) }
      else { v.rate = r.rate || 24000; put(v, new Uint8Array(readFileSync(out))) }
      finish(v)
    } else finish(v, r.error || 'no audio')
  } catch (e) { finish(v, String(e)) } finally { rmSync(dir, { recursive: true, force: true }) }
}
// Soniox's voice, streamed — the first audio comes in ~0.5 s, the whole sentence
// takes several seconds, so it plays while it is still being made.
async function sonioxVoice(v: Voice, language: string, voice: string) {
  try {
    const r = await fetch(SONIOX_TTS_URL, {
      method: 'POST', signal: AbortSignal.any([v.abort.signal, AbortSignal.timeout(60_000)]),
      headers: { authorization: `Bearer ${SONIOX_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tts-rt-v2', language, voice, audio_format: 'pcm_s16le', sample_rate: 24000, text: v.text }),
    })
    if (!r.ok || !r.body) { finish(v, `Soniox voice answered ${r.status}: ${(await r.text()).slice(0, 200)}`); return }
    v.rate = 24000
    let left: Uint8Array | null = null
    for await (const part of r.body as any as AsyncIterable<Uint8Array>) {
      let b: Uint8Array = part
      if (left) { b = new Uint8Array(left.byteLength + part.byteLength); b.set(left); b.set(part, left.byteLength) }
      const even = b.byteLength - (b.byteLength % 2)
      left = even < b.byteLength ? b.slice(even) : null
      if (even) put(v, b.slice(0, even))
    }
    finish(v)
  } catch (e) { finish(v, v.abort.signal.aborted ? 'stopped' : String(e)) }
}
const FARSI = /[؀-ۿ]/
function synth(text: string): Voice {
  const v: Voice = { text, voice: '', rate: 24000, chunks: [], done: false, started: Date.now(), abort: new AbortController() }
  if (!TTS) { v.voice = 'off'; finish(v, 'voice off'); return v }
  const farsi = FARSI.test(text)
  if (!farsi && paradeeWorker && !paradeeWorker.failed) { v.voice = 'Paradee'; local(v, paradeeWorker, false); return v }
  if (!farsi && (kokoroWorker || !SONIOX_KEY)) { kokoroWorker ||= new VoiceWorker('kokoro', ['python3', join(HERE, 'worker.py')], voiceEnv()); v.voice = 'Kokoro'; local(v, kokoroWorker, true); return v }
  if (!SONIOX_KEY) { v.voice = 'none'; finish(v, 'no Farsi voice without SONIOX_API_KEY'); return v }
  const voice = farsi ? FARSI_VOICE : (/^(paradee|kokoro)$/i.test(ENGLISH_VOICE) ? 'Grace' : ENGLISH_VOICE)
  v.voice = `Soniox ${voice}`; sonioxVoice(v, farsi ? 'fa' : 'en', voice)
  return v
}


// A request: what the caller said, and the lines it came from (so its answer can point back).
// `notice` "ask:<id>": something in a topic waits on the caller (a permission, Claude's
// questions, a plan), said at a pause the same way.
// `notice`: not something the caller said, but the bot telling the call that work its front
// desk handed off has finished (the hand-off's id); it is spoken only at a pause.
type Req = { id: number; said: string; ids: number[]; text: string; background: string; notice?: string }
type Held = { texts: string[]; ids: number[]; since: number; timer?: ReturnType<typeof setTimeout>; waitingSaid?: string; background?: string
  // someone else's words are in it: never acted on by the fast path
  others?: boolean
  // the fast decision asked for these words while the quiet wait runs
  fast?: { text: string; result: Promise<FastResult> } }
type Conn = {
  authed: boolean; uuid?: string; cwd: string; model?: string; sessionId?: string; permission?: string[]
  run?: RunHandle; gen: number; queue: Req[]; reqs: number
  call?: CallState; rec?: CallRecorder; stt?: SonioxStream; tracker?: TokenTracker
  held: boolean; heldUntilFinal: boolean; endedFor?: number; hold: Held; speakStop?: () => void
  // The request running now: when it started, and whether Claude has said anything.
  current?: { req: Req; at: number; answered: boolean }
  vad?: Vad; endedForVoice?: number
  events?: AbortController   // the bot's stream of running work and notices
  // A call with a front desk (a group with topics): its topics go to the page, which
  // says which one is open (viewing: a topic id or "General"), and a turn says it too.
  desk?: boolean; viewing?: number | 'General'; topicsTimer?: ReturnType<typeof setInterval>; topicsSoon?: ReturnType<typeof setTimeout>
  // The Live topic's id (from the list), and the open topic's messages as last sent:
  // which topic, and its last activity then.
  liveId?: number | 'General'; shownMsgs?: { topic: number | 'General'; lastAt?: number }
  // This page's key to the group's photos (in their URLs), and its message budget.
  photoKey?: string; budget?: { n: number; since: number }
  me?: number   // the link's owner: what waits on them is told to the call
  got?: { bytes: number; wire: number; since: number }
  // the mic as Opus (live/opus.ts), made on its first Opus message
  opus?: OpusIn
  // the Cloudflare site the page's connection came in through (cf-ray), e.g. FRA
  edge?: string
  // All the audio received on this call, and how much of it the page has been told
  // of (heard_s): the page compares it with what it sent, and says so when its audio
  // is not getting here, instead of the call just going quiet.
  audioIn?: number; acked?: number
  // When the page last sent anything (it pings every 20 s).
  lastIn?: number
  // How answers arrive, picked on the page: spoken, a sound when one is ready, or
  // nothing (the text is on the page either way). Without speech none is made.
  answers: Answers
  // page actions the fast path did since the last request, for the desk to hear of
  fastDone?: string[]
  // A notice waiting for the page to finish playing an answer: the fallback, should the
  // page never say it has.
  queuedFor?: ReturnType<typeof setTimeout>
  // A wake heard on the phone, not yet confirmed by what Soniox heard.
  woke?: ReturnType<typeof setTimeout>
  // After a wake: the mic goes off again if nothing is asked (wokeIdle), counted from wokeAt.
  wokeIdle?: ReturnType<typeof setTimeout>; wokeAt?: number
  // when the caller last asked something (a request, or a page action done by the fast path)
  askedAt?: number
}
type Answers = 'voice' | 'sound' | 'silent'
const ANSWERS: Answers[] = ['voice', 'sound', 'silent']
const answersFrom = (v: unknown): Answers | undefined => ANSWERS.includes(v as Answers) ? v as Answers : undefined
type WS = ServerWebSocket<Conn>
// A running request, wherever it runs: stop() ends it at once.
type RunHandle = { stop: () => void }
// What a run reports, as it happens.
type RunEvents = {
  thinking: (text: string) => void
  tool: (label: string) => void
  text: (text: string) => void
  status: (text: string) => void
  end: (how: string, info?: Record<string, unknown>) => void
}
const out = (ws: WS, m: Record<string, unknown>) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)) }
const shown = (l: Line) => ({ id: l.id, speaker: l.speaker, text: l.text, role: l.role, language: l.language, unclear: l.unclear || undefined })

// The link still holds: not expired, not replaced by a newer /live. Picks up the
// session id the topic may have advanced in Telegram, and its current mode.
function linkHolds(ws: WS): boolean {
  const l = ownLink(loadLinks(), ws.data.uuid)
  if (!l || linkExpired(l)) { out(ws, { type: l ? 'expired' : 'denied' }); ws.data.rec?.trace('auth', l ? 'link expired mid-call' : 'link revoked mid-call'); ws.close(); return false }
  if (l.sessionId) ws.data.sessionId = l.sessionId
  ws.data.permission = permissionArgs(l)
  if (l.model) ws.data.model = l.model
  return true
}

// A request: run it now, or after the turn that is running (the queue goes as one).
function ask(ws: WS, said: string, ids: number[], how: string, carried = '') {
  const fresh = ws.data.call!.background(ws.data.hold.ids)
  const done = (ws.data.fastDone ?? []).splice(0).join('\n')
  const background = [done, carried, fresh].filter(Boolean).join('\n')
  const req: Req = { id: ++ws.data.reqs, said, ids, background, text: requestText(said, background) }
  ws.data.askedAt = Date.now()
  ws.data.rec?.trace('turn', `request ${req.id} (${how})${ws.data.run ? ', queued behind the running turn' : ''}`, { text: req.text })
  out(ws, { type: 'sent', ids, req: req.id, queued: !!ws.data.run })
  if (ws.data.run) { ws.data.queue.push(req); return }
  if (!linkHolds(ws)) return
  runTurn(ws, req)
}

// Stop everything: the run, what is queued, what is being read, what is held.
function stopAll(ws: WS, why: string) {
  ws.data.gen++
  ws.data.run?.stop()
  ws.data.run = undefined
  // The page shows each request as running until it hears it has ended.
  if (ws.data.current) out(ws, { type: 'turn_end', req: ws.data.current.req.id, stopped: true })
  for (const q of ws.data.queue) out(ws, { type: 'dropped', req: q.id, ids: q.ids })
  ws.data.current = undefined
  ws.data.queue = []
  clearTimeout(ws.data.queuedFor); ws.data.queuedFor = undefined
  clearHeld(ws)
  ws.data.speakStop?.()
  out(ws, { type: 'hush' })
  ws.data.rec?.trace('stop', why)
}

// What was asked while a turn ran goes next, as one request; a notice goes on its own.
// A notice also waits for the answer before it to finish playing on the page: started
// at once, it took the call from that answer and cut it off mid-sentence.
function runQueued(ws: WS, force = false) {
  clearTimeout(ws.data.queuedFor); ws.data.queuedFor = undefined
  if (!ws.data.queue.length || ws.data.run || ws.data.current) return
  if (ws.data.queue[0].notice && ws.data.call?.playing && !force) {
    // Played to its end, the page says so (and runQueued runs again); this is in case it never does.
    ws.data.queuedFor = setTimeout(() => runQueued(ws, true), PLAYING_WAIT_MS)
    return
  }
  const firstNotice = ws.data.queue.findIndex(r => r.notice)
  const n = firstNotice === 0 ? 1 : firstNotice < 0 ? ws.data.queue.length : firstNotice
  const q = ws.data.queue.splice(0, n)
  const next: Req = q.length === 1 ? q[0] : { id: q[q.length - 1].id, said: q.map(r => r.said).join('\n'), ids: q.flatMap(r => r.ids), text: q.map(r => r.text).join('\n\n'), background: q.map(r => r.background).filter(Boolean).join('\n') }
  if (linkHolds(ws)) runTurn(ws, next)
}
// A notice for the call: now, or after what the call is doing (an answer running, being
// spoken, or still playing on the page).
function noticeTurn(ws: WS, req: Req) {
  ws.data.queue.push(req)
  runQueued(ws)
}

// Run one request through claude, streaming events + spoken audio to the client.
function runTurn(ws: WS, req: Req) {
  const gen = ++ws.data.gen
  const alive = () => ws.data.gen === gen && ws.readyState === 1
  const rec = ws.data.rec, call = ws.data.call!
  const t0 = Date.now()
  let firstText = 0
  const model = ws.data.model || DEFAULT_MODEL
  const handle: RunHandle = { stop: () => {} }
  ws.data.run = handle
  ws.data.current = { req, at: Date.now(), answered: false }
  call.answerStarted()
  out(ws, { type: 'working', req: req.id, said: req.said, ids: req.ids, notice: !!req.notice || undefined })
  let textBuf = ''
  // Sentences are spoken in order, each streamed to the page as its audio is made;
  // the next one (at most AHEAD) is made while this one plays.
  const AHEAD = 2
  const texts: string[] = []      // sentences waiting to be started
  const voices: Voice[] = []      // started, in order
  let speaking = false
  ws.data.speakStop = () => { texts.length = 0; for (const v of voices) v.abort.abort(); voices.length = 0 }
  const startMore = () => { while (voices.length < AHEAD && texts.length) voices.push(synth(texts.shift()!)) }
  const say = (s: string) => {
    if (ws.data.current?.req === req) ws.data.current.answered = true
    out(ws, { type: 'bot', req: req.id, text: s })
    if (ws.data.answers !== 'voice') return
    call.speaking(s)
    texts.push(s); startMore(); pump()
  }
  // A notice is spoken at a pause: nobody talking, nothing of the caller's held. With none
  // within NOTICE_WAIT_MS it stays as text on the page (the page chimed already).
  let noticeSilent = false
  const pauseForNotice = async () => {
    const t = Date.now()
    while (alive() && Date.now() - t < NOTICE_WAIT_MS && (ws.data.vad?.speaking() || ws.data.held || ws.data.hold.texts.length)) await new Promise(r => setTimeout(r, 200))
    if (alive() && Date.now() - t >= NOTICE_WAIT_MS) { noticeSilent = true; rec?.trace('voice', 'notice not spoken: no pause') }
  }
  const pump = async () => {
    if (speaking) return; speaking = true
    if (req.notice && !noticeSilent) await pauseForNotice()
    while (voices.length && alive()) {
      const v = voices[0]
      if (noticeSilent) { v.abort.abort(); voices.shift(); startMore(); continue }
      let sent = 0, announced = false
      while (alive()) {
        while (sent < v.chunks.length && alive()) {
          if (!announced) { announced = true; call.speaking(v.text); out(ws, { type: 'audio', req: req.id, rate: v.rate }) }
          ws.send(v.chunks[sent++])
        }
        if (v.done || !alive()) break
        await new Promise<void>(r => (v.wake = r)); v.wake = undefined
      }
      if (voices[0] === v) voices.shift()
      startMore()
      if (!alive()) break
      if (v.error && !v.chunks.length) { rec?.trace('voice', `not spoken: ${v.error}`, { text: v.text }); continue }
      const all = new Uint8Array(v.chunks.reduce((n, c) => n + c.byteLength, 0)); let o = 0
      for (const c of v.chunks) { all.set(c, o); o += c.byteLength }
      rec?.answer(pcmToWav(all, v.rate), v.text)
      rec?.trace('voice', `${v.voice}: first audio after ${v.firstMs} ms, whole sentence ${Date.now() - v.started} ms${v.error ? ` (${v.error})` : ''}`)
    }
    speaking = false
  }
  const got: RunEvents = {
    thinking: t => { if (alive()) out(ws, { type: 'thinking', req: req.id, text: t }) },
    tool: label => { if (!alive()) return; out(ws, { type: 'tool', req: req.id, label }); rec?.trace('claude', `tool ${label}`) },
    text: t => {
      if (!alive()) return
      if (!firstText) { firstText = Date.now(); rec?.trace('claude', `first words after ${firstText - t0} ms`) }
      // A whole block of the answer (never a piece of one): its end ends a sentence.
      textBuf += t + '\n'
      const { done, rest } = drainSentences(textBuf); textBuf = rest
      for (const s of done) if (s) say(s)
    },
    status: t => { if (alive()) out(ws, { type: 'status', text: t }); rec?.trace('claude', t) },
    end: (how, info) => {
      if (ws.data.run === handle) ws.data.run = undefined
      rec?.trace('claude', `request ${req.id} done in ${Date.now() - t0} ms (${how})`, info ?? {})
      const tail = textBuf.trim()
      if (tail && alive()) say(tail)
      const iv = setInterval(() => {
        if (speaking || voices.length || texts.length) return
        clearInterval(iv)
        if (!alive()) return      // stopped, or cancelled to be asked again whole
        if (ws.data.current?.req === req) ws.data.current = undefined
        out(ws, { type: 'turn_end', req: req.id })
        runQueued(ws)
      }, 150)
    },
  }
  if (inBot()) {
    rec?.trace('claude', `request ${req.id} started in the bot (${model})`)
    handle.stop = viaBot(ws, req, model, got)
  } else {
    const perm = ws.data.permission || permissionArgs(undefined)
    rec?.trace('claude', `request ${req.id} started (${model}, ${perm.join(' ')})`)
    handle.stop = viaCli(ws, req, model, perm, got)
  }
}

// The bot's local API is there: the turn runs inside the bot.
function inBot(): boolean { return existsSync(API_SOCK) && existsSync(API_TOKEN_FILE) }

// The bot's stream of what is running in the call's group, while the page is open.
// Runs and their steps go to the page; a notice (front-desk work finished) chimes on
// the page and becomes a request of its own, spoken at a pause. Reconnects when the
// bot restarts.
function startEvents(ws: WS) {
  if (!inBot() || ws.data.events) return
  const ac = ws.data.events = new AbortController()
  void (async () => {
    while (!ac.signal.aborted && ws.readyState === 1) {
      try {
        const token = readFileSync(API_TOKEN_FILE, 'utf8').trim()
        const res = await fetch(`http://local/v1/live/events?link=${encodeURIComponent(ws.data.uuid ?? '')}`,
          { unix: API_SOCK, signal: ac.signal, headers: { authorization: `Bearer ${token}` } } as RequestInit)
        if (res.status === 404 || res.status === 410) return
        if (res.ok && res.body) {
          const reader = res.body.getReader(), dec = new TextDecoder()
          let buf = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let nl: number
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
              let ev: any; try { ev = JSON.parse(line) } catch { continue }
              onBotEvent(ws, ev)
            }
          }
        }
      } catch { /* the bot restarting, or the call ending */ }
      if (!ac.signal.aborted) await new Promise(r => setTimeout(r, 3000))
    }
  })()
}
// The group's topics and what each is doing, from the bot, to the page: when the call
// starts, soon after a run starts or ends, and every TOPICS_EVERY_MS for the rest
// (questions waiting, new messages).
const TOPICS_EVERY_MS = Number(process.env.LIVE_TOPICS_EVERY_MS) || 15_000
const botApi = (method: string, path: string, body?: unknown) => fetch(`http://local${path}`, {
  unix: API_SOCK, method, headers: { authorization: `Bearer ${readFileSync(API_TOKEN_FILE, 'utf8').trim()}`, 'content-type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
} as RequestInit)
async function sendTopics(ws: WS) {
  if (!ws.data.desk || !inBot() || ws.readyState !== 1) return
  try {
    const res = await botApi('GET', `/v1/live/topics?link=${encodeURIComponent(ws.data.uuid ?? '')}`)
    if (!res.ok) return
    const m = await res.json() as { live?: number | 'General'; topics?: { id: number | 'General'; lastAt?: number }[] }
    ws.data.liveId = m.live
    out(ws, { type: 'topics', ...m })
    // The open topic has something new: its messages again.
    const open = ws.data.viewing, t = m.topics?.find(x => x.id === open)
    if (open !== undefined && open !== m.live && t && (ws.data.shownMsgs?.topic !== open || ws.data.shownMsgs.lastAt !== t.lastAt)) void sendMessages(ws, t.lastAt)
  } catch { /* the bot restarting: the next round gets it */ }
}
// A topic's latest messages, for the page: the open one's, or another's it asks for
// ahead of opening it (the page keeps them, so a topic opens at once).
async function sendMessages(ws: WS, lastAt?: number, topic: number | 'General' | undefined = ws.data.viewing) {
  if (topic === undefined || topic === ws.data.liveId || !inBot()) return
  try {
    const res = await botApi('GET', `/v1/live/messages?link=${encodeURIComponent(ws.data.uuid ?? '')}&topic=${topic}&n=40`)
    if (!res.ok) return
    if (ws.data.viewing === topic) ws.data.shownMsgs = { topic, lastAt }
    out(ws, { type: 'messages', ...(await res.json() as Record<string, unknown>) })
  } catch {}
}
// A browser's call comes from the page this server served: its Origin is this host
// (as the tunnel or proxy passed it on). Clients that aren't browsers send none.
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return true
  let host: string
  try { host = new URL(origin).host } catch { return false }
  const ours = [req.headers.get('host'), req.headers.get('x-forwarded-host'), ...(process.env.LIVE_URL ? [new URL(process.env.LIVE_URL).host] : [])]
  return ours.some(h => !!h && h.toLowerCase() === host.toLowerCase())
}
// The photo keys of the pages open now, each to its link: a photo URL works only with
// the key of a page that is open (a link alone, leaked, opens no photos).
const photoKeys = new Map<string, string>()
// Enough for a person, not for a script: page messages other than audio, per 10 s.
function withinBudget(ws: WS): boolean {
  const b = ws.data.budget ??= { n: 0, since: Date.now() }
  if (Date.now() - b.since > 10_000) { b.n = 0; b.since = Date.now() }
  return ++b.n <= 60
}
function topicsSoon(ws: WS) {
  if (!ws.data.desk || ws.data.topicsSoon) return
  ws.data.topicsSoon = setTimeout(() => { ws.data.topicsSoon = undefined; void sendTopics(ws) }, 400)
}
function onBotEvent(ws: WS, ev: any) {
  if (ev.kind === 'run' || ev.kind === 'run_end' || ev.kind === 'notice' || ev.kind === 'wait' || ev.kind === 'wait_end') topicsSoon(ws)
  if (ev.kind === 'wait' && typeof ev.id === 'string' && ws.data.desk && (ev.person === '*' || String(ev.person) === String(ws.data.me))) {
    ws.data.rec?.trace('notice', `${ev.topic}: waits on you (${ev.what})`)
    out(ws, { type: 'ask', topic: ev.topic, thread: ev.thread ?? 'General', id: ev.id, what: ev.what })
    const req: Req = { id: ++ws.data.reqs, said: `❗ ${ev.topic}: ${ev.what === 'permission' ? 'asks for permission' : ev.what === 'plan' ? 'a plan is ready' : 'asks you'}`, ids: [], text: '', background: '', notice: `ask:${ev.id}` }
    noticeTurn(ws, req)
  }
  // Answered (anywhere) before the call got to it: it isn't said.
  if (ev.kind === 'wait_end' && typeof ev.id === 'string') ws.data.queue = ws.data.queue.filter(r => r.notice !== `ask:${ev.id}`)
  if (ev.kind === 'runs') out(ws, { type: 'work', runs: ev.runs })
  else if (ev.kind === 'show') { if (ws.data.desk) out(ws, { type: 'show', topic: ev.topic }) }
  // The desk turned the mic off, asked by voice ("mute the mic for a minute"): the
  // page does it, and turns it back on after ms (0: only the caller turns it on).
  else if (ev.kind === 'mic') {
    const ms = Number.isFinite(ev.ms) && ev.ms > 0 ? Math.min(ev.ms, MIC_OFF_MAX_MS) : 0
    ws.data.rec?.trace('page', ms ? `mic off by voice for ${Math.round(ms / 1000)} s` : 'mic off by voice')
    out(ws, { type: 'mic', on: false, ms })
  }
  // The desk switched the call's mode, asked by voice ("switch to assistant", "back to me").
  else if (ev.kind === 'call_mode') {
    const m = modeFrom(ev.mode)
    if (m && ws.data.call && ws.data.call.mode !== m) { ws.data.call.mode = m; ws.data.rec?.trace('page', `mode now: ${m} (asked by voice)`) }
    if (m) out(ws, { type: 'call_mode', mode: m, byVoice: true })
  }
  else if (ev.kind === 'play') { if (ws.data.desk) out(ws, { type: 'play', topic: ev.topic, id: ev.id, text: ev.text }) }
  else if (ev.kind === 'run') out(ws, { type: 'work', run: { id: ev.id, topic: ev.topic, thread: ev.thread ?? 'General', what: ev.what, at: ev.at } })
  else if (ev.kind === 'step') out(ws, { type: 'work_step', id: ev.id, step: ev.step })
  else if (ev.kind === 'run_end') out(ws, { type: 'work_end', id: ev.id, ok: ev.ok, stopped: ev.stopped })
  else if (ev.kind === 'notice' && typeof ev.handoff === 'string') {
    ws.data.rec?.trace('notice', `${ev.topic}: ${ev.ok ? 'done' : 'failed'}`, { line: ev.line })
    out(ws, { type: 'notice', topic: ev.topic, ok: ev.ok, line: ev.line })
    const req: Req = { id: ++ws.data.reqs, said: `🔔 ${ev.topic}: ${ev.ok ? 'done' : 'did not finish'}`, ids: [], text: '', background: '', notice: ev.handoff }
    noticeTurn(ws, req)
  }
}

// The turn as a turn in the link's topic, inside the bot.
function viaBot(ws: WS, req: Req, model: string, got: RunEvents): () => void {
  const ac = new AbortController()
  void (async () => {
    let how = 'ok', info: Record<string, unknown> | undefined
    try {
      const token = readFileSync(API_TOKEN_FILE, 'utf8').trim()
      const res = await fetch('http://local/v1/live/turn', {
        unix: API_SOCK, method: 'POST', signal: ac.signal,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(req.notice?.startsWith('ask:') ? { link: ws.data.uuid, ask: req.notice.slice(4), model, voice: PROFILE }
          : req.notice ? { link: ws.data.uuid, notice: req.notice, model, voice: PROFILE }
          : { link: ws.data.uuid, text: req.text, model, voice: PROFILE, callMode: ws.data.call?.mode ?? 'interactive', ...(ws.data.viewing !== undefined ? { viewing: ws.data.viewing } : {}) }),
      } as RequestInit)
      if (!res.ok) {
        const b: any = await res.json().catch(() => ({}))
        how = `the bot refused it: ${b.error || `HTTP ${res.status}`}`
        got.status(`⚠️ ${b.error || `the bot refused this request (HTTP ${res.status})`}`)
      } else {
        const reader = res.body!.getReader(), dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
            let ev: any; try { ev = JSON.parse(line) } catch { continue }
            if (ev.type === 'queued') got.status('⏳ The topic is busy with another turn; this one is next.')
            else if (ev.type === 'step') { if (/^💭/.test(ev.label)) { if (ev.detail) got.thinking(ev.detail) } else got.tool(ev.label) }
            else if (ev.type === 'text' && ev.text) got.text(ev.text)
            // Where the turn's time went, in the bot: queued, getting ready to start,
            // claude starting (to its init event), to its first output, and its API time.
            else if (ev.type === 'timing') ws.data.rec?.trace('timing', `queued ${ev.queuedMs} ms, prepared ${ev.startMs} ms, ` +
              (ev.warm ? 'claude already running' : `claude up after ${ev.initMs ?? '?'} ms`) +
              `, first output after ${ev.firstMs ?? '?'} ms, whole turn ${ev.totalMs} ms` + (ev.apiMs !== undefined ? ` (model ${ev.apiMs} ms of it)` : ''), ev)
            else if (ev.type === 'done') {
              if (ev.stopped) how = 'stopped in the topic'
              else if (ev.isError) { how = 'error'; info = { result: String(ev.text ?? '').slice(0, 500) } }
            }
          }
        }
      }
    } catch (e) {
      if (ac.signal.aborted) how = 'stopped'
      else { how = 'the bot could not be reached'; info = { error: String((e as Error)?.message ?? e) }; got.status('⚠️ Could not reach the bot for this request.') }
    }
    got.end(how, info)
  })()
  return () => ac.abort()
}

// No bot API: the claude CLI here, on the link's session.
function viaCli(ws: WS, req: Req, model: string, perm: string[], got: RunEvents): () => void {
  const args = ['-p', req.text, '--output-format', 'stream-json', '--verbose', '--model', model, ...perm, '--append-system-prompt', PROFILE]
  if (ws.data.sessionId) args.push('--resume', ws.data.sessionId)
  // For the usage ledger, as the bridge records it: whether this run started its
  // session, and the model it resolved to (usage.ts, costOf).
  const resumed = !!ws.data.sessionId
  let runModel: string | undefined, recorded = false
  const child = spawn(CLAUDE_BIN, args, { cwd: ws.data.cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  let jsonBuf = '', errBuf = ''
  child.stderr!.on('data', d => { errBuf = (errBuf + d).slice(-2000) })
  child.stdout!.on('data', d => {
    jsonBuf += d; let nl: number
    while ((nl = jsonBuf.indexOf('\n')) >= 0) {
      const line = jsonBuf.slice(0, nl); jsonBuf = jsonBuf.slice(nl + 1)
      if (!line.trim()) continue
      let ev: any; try { ev = JSON.parse(line) } catch { continue }
      if (ev.type === 'assistant' && Array.isArray(ev?.message?.content)) {
        for (const c of ev.message.content) {
          if (c.type === 'thinking' && c.thinking) got.thinking(c.thinking)
          else if (c.type === 'tool_use') got.tool(`🔧 ${c.name}`)
          else if (c.type === 'text' && c.text) got.text(c.text)
        }
      } else if (ev.type === 'system' && ev.subtype === 'init') {
        if (ev.model) runModel = String(ev.model)
      } else if (ev.type === 'result') {
        if (ev.session_id) { ws.data.sessionId = ev.session_id; if (ws.data.uuid) syncSession(ws.data.uuid, ev.session_id) }
        if (ev.is_error) ws.data.rec?.trace('claude', 'ended with an error', { result: String(ev.result ?? '').slice(0, 500) })
        const u = usageOf(ev)
        if (u) {
          // The link's key is the topic's, chat:thread — so a call counts toward its topic.
          const lk = ws.data.uuid ? ownLink(loadLinks(), ws.data.uuid)?.key : undefined
          const [chat, thread] = typeof lk === 'string' ? lk.split(':') : []
          ledger?.record({ ...u, model: runModel ?? u.model, kind: 'live', chat, thread: Number(thread) || undefined,
            ok: !ev.is_error, session: ev.session_id, fresh: !resumed && !recorded })
          recorded = true
        }
      }
    }
  })
  child.on('close', code => got.end(`exit ${code}`, code ? { stderr: errBuf.slice(-500) } : undefined))
  return () => { try { child.kill('SIGKILL') } catch {} }
}

// --- holding the caller's words until the request is finished ---------------------------
function clearHeld(ws: WS) {
  const h = ws.data.hold
  if (h.timer) clearTimeout(h.timer)
  ws.data.hold = { texts: [], ids: [], since: 0 }
}
function scheduleFlush(ws: WS, ms = QUIET_MS) {
  const h = ws.data.hold
  if (h.timer) clearTimeout(h.timer)
  h.timer = setTimeout(() => flush(ws, false), ms)
}
function flush(ws: WS, force: boolean) {
  const h = ws.data.hold
  if (h.timer) { clearTimeout(h.timer); h.timer = undefined }
  if (!h.texts.length || ws.readyState !== 1) return
  if (ws.data.held && !force) return                  // letting go of the button sends it
  const call = ws.data.call!, tracker = ws.data.tracker
  const text = h.texts.join(' ')
  // Still talking: the caller's words are coming in, or there is voice in the audio and it isn't
  // someone else's (whose words would be in the open piece).
  const mineOpen = !!tracker && call.main !== null && tracker.openWordEnd(call.main) !== null
  const othersOpen = !!tracker && call.main !== null && tracker.openWordEnd(call.main, true) !== null
  const stillTalking = mineOpen || (!!ws.data.vad?.speaking() && !othersOpen)
  const d = sendDecision({ text, waitedMs: Date.now() - h.since, stillTalking, force, maxWaitMs: MAX_WAIT_MS })
  if (!d.send) {
    if (h.waitingSaid !== d.why) { h.waitingSaid = d.why; ws.data.rec?.trace('decide', d.why, { text }) }
    out(ws, { type: 'waiting', ids: h.ids })
    scheduleFlush(ws)
    return
  }
  ws.data.rec?.trace('decide', `send: ${d.why}`, { text })
  const ids = h.ids, carried = h.background || '', fast = h.fast?.text === text && !h.others ? h.fast.result : undefined
  clearHeld(ws)
  for (const id of ids) { const l = call.line(id); if (l) l.sent = true }
  const how = force ? 'talk button' : 'your voice'
  if (!fast) { ask(ws, text, ids, how, carried); return }
  void (async () => {
    const r = await Promise.race([fast, Bun.sleep(FAST_EXTRA_MS).then(() => null)])
    if (ws.readyState !== 1) return
    const act = r ? fastAction(r, FAST_MIN) : null
    const rec = ws.data.rec
    if (!r) rec?.trace('fast', `no answer within the wait: to the desk`, { text })
    else if ('error' in r) rec?.trace('fast', `failed after ${r.ms} ms (${r.error}): to the desk`, { text })
    else rec?.trace('fast', `${r.model}: ${r.action} ${r.conf.toFixed(2)} in ${r.ms} ms${act ? ': done on the page' : ': to the desk'}`, { text, cost: r.cost })
    if (act && doFast(ws, act, text)) return
    ask(ws, text, ids, how, carried)
  })()
}

// A page action decided by the fast path: done here, as the desk's tool would, and the
// desk is told with the next request. False when there is nothing to do.
function doFast(ws: WS, act: NonNullable<ReturnType<typeof fastAction>>, said: string): boolean {
  const call = ws.data.call!, rec = ws.data.rec
  let done = ''
  if (act === 'mic_off') {
    rec?.trace('page', 'mic off by voice')
    out(ws, { type: 'mic', on: false, ms: 0 })
    done = 'turned the mic off'
  } else if (act === 'mode_assistant' || act === 'mode_interactive') {
    const m: CallMode = act === 'mode_assistant' ? 'assistant' : 'interactive'
    if (call.mode !== m) { call.mode = m; rec?.trace('page', `mode now: ${m} (asked by voice)`) }
    out(ws, { type: 'call_mode', mode: m, byVoice: true })
    done = `switched the call to ${m} mode`
  } else {
    const a = act === 'answers_voice' ? 'voice' : act === 'answers_sound' ? 'sound' : 'silent'
    if (ws.data.answers !== a) { ws.data.answers = a; rec?.trace('page', `answers now: ${a === 'voice' ? 'spoken' : a === 'sound' ? 'a sound when ready' : 'silent'} (asked by voice)`) }
    if (a !== 'voice') { ws.data.speakStop?.(); out(ws, { type: 'hush' }) }
    out(ws, { type: 'answers', mode: a, byVoice: true })
    done = `set answers to ${a === 'voice' ? 'spoken' : a === 'sound' ? 'a sound when ready' : 'silent (text only)'}`
  }
  ws.data.askedAt = Date.now()
  ;(ws.data.fastDone ??= []).push(`you: ${said}\n(done on the page, without you: ${done})`)
  return true
}

// The caller went on talking after the request was sent, and Claude has not said anything
// yet: it was cut. Cancel the run and hold the whole thing as one request again.
function redoIfCut(ws: WS): boolean {
  const cur = ws.data.current
  if (!cur || !ws.data.run || cur.answered || ws.data.hold.texts.length) return false
  const after = Date.now() - cur.at
  if (after > MERGE_MS) return false
  ws.data.gen++
  ws.data.run.stop()
  ws.data.run = undefined
  ws.data.current = undefined
  ws.data.speakStop?.()
  const h = ws.data.hold
  h.texts = [cur.req.said]; h.ids = [...cur.req.ids]; h.since = cur.at; h.background = cur.req.background
  out(ws, { type: 'retract', req: cur.req.id, ids: cur.req.ids })
  ws.data.rec?.trace('decide', `you went on ${(after / 1000).toFixed(1)} s after request ${cur.req.id} was sent, before any answer: it is cancelled and will be asked again with the rest`, { text: cur.req.said })
  return true
}

// --- hearing (Soniox) ---------------------------------------------------------
// Soniox is told to expect the wake words. Without it, in a noisy place "Hey Lucy" came
// out as Farsi «خیلی چیز» every time (2026-11-20), so the phone's wake looked false and
// the request uncalled; with it, all were "Hey Lucy", and no "Lucy" appeared in calls
// without one.
function sonioxTerms(wake: string[]): string[] {
  const t = [...SONIOX.terms]
  for (const w of wake.map(x => x.trim()).filter(Boolean)) t.push(w, ...(/^[\p{Script=Latin}\s'-]+$/u.test(w) ? [`Hey ${w}`] : []))
  return [...new Set(t)].slice(0, 50)
}
function startHearing(ws: WS) {
  const rec = ws.data.rec!, call = ws.data.call!
  const tracker = ws.data.tracker = new TokenTracker()
  let firstWords = true
  ws.data.stt = new SonioxStream({ ...SONIOX, key: SONIOX_KEY, terms: sonioxTerms(call.wake) }, {
    connected: n => {
      tracker.reset(); ws.data.endedFor = undefined
      if (n > 1 && call.main !== null) { call.reset(); out(ws, { type: 'main', speaker: null }); out(ws, { type: 'status', text: 'reconnected to speech recognition — the first voice now is "you" again (tap a line to change)' }) }
      rec.trace('soniox', n > 1 ? 'reconnected; speaker numbers start over' : 'connected', { model: SONIOX.model, languages: SONIOX.languages, endpoint_ms: SONIOX.endpointMs, end_silence_ms: END_SILENCE_MS, quiet_ms: QUIET_MS, quiet_done_ms: QUIET_DONE_MS, max_wait_ms: MAX_WAIT_MS })
    },
    status: s => { rec.trace('soniox', s); out(ws, { type: 'status', text: s }) },
    fatal: s => { rec.trace('soniox', `stopped: ${s}`); out(ws, { type: 'status', text: `speech recognition stopped: ${s}` }) },
    message: m => {
      const r = tracker.push(m)
      if (firstWords && r.live.length) { firstWords = false; rec.trace('soniox', 'first words back', { text: r.live.map(t => t.text).join(' ') }) }
      out(ws, { type: 'live', turns: r.live.map(t => ({ ...t, role: ws.data.held || t.speaker === call.main ? 'me' : 'other' })) })
      // Called by name and now saying the request: keep waiting for it.
      if (call.main !== null && tracker.openWordEnd(call.main) !== null) call.keepArmed()
      // the caller started again: what is held waits for the rest.
      if (call.main !== null && tracker.openWordEnd(call.main) !== null && ws.data.hold.texts.length) scheduleFlush(ws)
      if (call.shouldHush(r.live)) {
        ws.data.speakStop?.(); out(ws, { type: 'hush' })
        rec.trace('speaker', `speaker ${call.main} (you) talked over the answer, so the reading stops`, { text: r.live.map(t => t.text).join(' ') })
      }
      // A wake on the phone, confirmed as the words come (a long sentence may not end in time).
      if (ws.data.woke && r.live.some(t => wakeIn(call, t.text, t.confidence))) wakeConfirmed(ws, 'in the words still coming')
      if (r.done) { heard(ws, r.done, r.finalized); return }
      // In a busy room the audio is never quiet: end the piece when the caller has been quiet
      // END_SILENCE_MS while someone else keeps talking (their later words prove the
      // gap is real, not Soniox being late). Silence itself is judged on the audio,
      // in the audio handler. Not while the button is held.
      if (ws.data.held) return
      let why = ''
      if (call.main !== null) {
        const mine = tracker.openWordEnd(call.main), others = tracker.openWordEnd(call.main, true), q = tracker.quietMs(call.main)
        if (mine !== null && others !== null && others > mine && q !== null && q >= END_SILENCE_MS) why = `you (speaker ${call.main}) have been quiet ${q} ms while others talk`
      }
      const end = tracker.openWordEnd()
      if (why && end !== ws.data.endedFor) { ws.data.endedFor = end ?? undefined; rec.trace('soniox', `${why}: ending the piece`); ws.data.stt!.finalize() }
    },
  })
}

// The wake phrase, said clearly: an unclear "Hi, Lucy." (0.66) from someone nearby
// confirmed a wake (2026-11-22). Whoever said it: at the start of a call Soniox's
// speaker numbers are shaky, and a caller's own clear "Hey Lucy." came as speaker 2. A
// clear one from someone else is caught by the mic going off when nothing is asked.
function wakeIn(call: CallState, text: string, confidence?: number): boolean {
  return !!callWord(text, call.wake) && !unclear(text, confidence)
}
// After a wake: nothing asked within WOKE_IDLE_MS (and not still talking), the mic goes
// off again. The page does so only while the mic is on because of the wake.
function wokeIdle(ws: WS, at: number, ms = WOKE_IDLE_MS, more = 5) {
  clearTimeout(ws.data.wokeIdle)
  ws.data.wokeAt = at
  ws.data.wokeIdle = setTimeout(() => {
    ws.data.wokeIdle = undefined
    if ((ws.data.askedAt ?? 0) >= at || ws.readyState !== 1) return
    const call = ws.data.call, t = ws.data.tracker
    const talking = ws.data.hold.texts.length > 0 || (!!t && !!call && call.main !== null && t.openWordEnd(call.main) !== null) || !!ws.data.vad?.speaking()
    if (talking && more > 0) return wokeIdle(ws, at, 3000, more - 1)
    ws.data.rec?.trace('voice', `nothing asked after the wake: mic off again`)
    out(ws, { type: 'mic', on: false, ms: 0, why: 'nothing_asked' })
  }, ms)
}
function wakeConfirmed(ws: WS, where: string) {
  clearTimeout(ws.data.woke); ws.data.woke = undefined
  ws.data.rec!.trace('voice', `wake confirmed ${where}: the mic stays on`)
}

function heard(ws: WS, turns: Turn[], finalized: boolean) {
  const call = ws.data.call!, rec = ws.data.rec!
  const held = ws.data.held || ws.data.heldUntilFinal
  const release = ws.data.heldUntilFinal && finalized
  if (finalized) ws.data.heldUntilFinal = false
  const before = call.main
  const r = call.heard(turns, { held, busy: !!ws.data.run, assembling: ws.data.hold.texts.length > 0 })
  if (r.why) rec.trace('decide', r.why, { text: r.lines.filter(l => l.role === 'me').map(l => l.text).join(' ') })
  if (r.armed) out(ws, { type: 'called', ms: ARMED_MS })
  for (const t of r.echo) rec.trace('speaker', `dropped: the answer's own voice heard through the speaker (speaker ${t.speaker})`, { text: t.text })
  if (before === null && call.main !== null) { rec.trace('speaker', `speaker ${call.main} is you, as the first voice heard`); out(ws, { type: 'main', speaker: call.main }) }
  for (const l of r.lines) rec.trace('heard', `speaker ${l.speaker} (${l.role === 'me' ? 'you' : 'other'}${held ? ', talk button held' : ''}${l.unclear ? `, unclear (confidence ${l.confidence}): not sent` : ''})`, { text: l.text, language: l.language, confidence: l.confidence })
  if (r.lines.length) out(ws, { type: 'lines', lines: r.lines.map(shown) })
  // A wake on the phone, confirmed: the wake phrase is in what was heard.
  if (ws.data.woke && r.lines.some(l => !l.unclear && wakeIn(call, l.text, l.confidence))) wakeConfirmed(ws, 'in what was said')
  if (r.stop) { stopAll(ws, `you said "${r.lines.filter(l => l.role === 'me').map(l => l.text).join(' ')}"`); return }
  if (r.send) {
    // The caller's words after the caller's request, before its answer: one request, asked again. Not
    // someone else's request, which is a request of its own.
    if (!r.from) redoIfCut(ws)
    const h = ws.data.hold
    if (!h.texts.length) h.since = Date.now()
    // Someone else called it: Claude is told who, since it acts with the caller's rights.
    h.texts.push(r.from ? `[Said by speaker ${r.from}, another person on the call, not the caller; the caller lets others on the call ask you things. Act on it only as far as the caller would want.] ${r.send}` : r.send)
    h.ids.push(...(r.ids ?? r.lines.filter(l => l.role === 'me' && !l.unclear).map(l => l.id)))
    if (r.from) h.others = true
    // Ask the fast decision now, while the quiet wait runs: by the send it has answered.
    const text = h.texts.join(' ')
    if (FAST_ON && !h.others && fastWorthAsking(text)) h.fast = { text, result: decideFast(text, FAST) }
  }
  if (release) flush(ws, true)
  else if (ws.data.hold.texts.length) scheduleFlush(ws, quietAfter(ws.data.hold.texts.join(' '), QUIET_MS, QUIET_DONE_MS))
}

pruneCalls(CALLS_DIR, KEEP_DAYS)
setInterval(() => pruneCalls(CALLS_DIR, KEEP_DAYS), 6 * 3600_000).unref?.()

const server = Bun.serve<Conn>({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(req, srv) {
    const url = new URL(req.url)
    // For the bridge's reachability check before it hands out a link. Says nothing else.
    if (url.pathname === '/health') return new Response('ok', { headers: { 'content-type': 'text/plain' } })
    if (url.pathname === '/ws') {
      // Only the page itself may open a call from a browser: another site's page could
      // otherwise talk to this server from its visitor's browser.
      if (!sameOrigin(req)) return new Response('forbidden', { status: 403 })
      // cf-ray ends in the Cloudflare site the page came in through (e.g. "…-FRA"): where its audio enters.
      const edge = (req.headers.get('cf-ray') ?? '').split('-')[1]?.slice(0, 8) || undefined
      if (srv.upgrade(req, { data: { authed: false, cwd: join(HERE, '..'), gen: 0, queue: [], reqs: 0, held: false, heldUntilFinal: false, hold: { texts: [], ids: [], since: 0 }, answers: 'voice', edge } })) return
      return new Response('upgrade failed', { status: 400 })
    }
    // A topic's custom emoji icon, as the bot saved it (public Telegram emoji).
    const icon = url.pathname.match(/^\/icon\/(\d{1,30})$/)
    if (icon) {
      const dir = join(dirname(LINKS_FILE), 'live-icons')
      let f: string | undefined
      try { f = readdirSync(dir).find(n => n.startsWith(`${icon[1]}.`)) } catch {}
      return f ? new Response(Bun.file(join(dir, f)), { headers: { 'cache-control': 'public, max-age=86400' } }) : new Response('no', { status: 404 })
    }
    // A photo in a topic, for a page open on that link (its device holds the link).
    const photo = url.pathname.match(/^\/photo\/([0-9a-f-]{36})\/(General|\d{1,9})\/(\d{1,12})$/)
    if (photo) {
      const uuid = photoKeys.get(photo[1])
      if (!uuid || !inBot()) return new Response('no', { status: 404 })
      return botApi('GET', `/v1/live/photo?link=${encodeURIComponent(uuid)}&topic=${photo[2]}&id=${photo[3]}`)
        .then(r => r.ok ? new Response(r.body, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' } }) : new Response('no', { status: r.status }))
        .catch(() => new Response('no', { status: 502 }))
    }
    // An answer's voice note, for a page open on that link (?as=mp3 where Opus won't play).
    const voice = url.pathname.match(/^\/voice\/([0-9a-f-]{36})\/(General|\d{1,9})\/(\d{1,12})$/)
    if (voice) {
      const uuid = photoKeys.get(voice[1])
      if (!uuid || !inBot()) return new Response('no', { status: 404 })
      const mp3 = url.searchParams.get('as') === 'mp3'
      return botApi('GET', `/v1/live/voice?link=${encodeURIComponent(uuid)}&topic=${voice[2]}&id=${voice[3]}${mp3 ? '&as=mp3' : ''}`)
        .then(r => r.ok ? new Response(r.body, { headers: { 'content-type': mp3 ? 'audio/mpeg' : 'audio/ogg', 'cache-control': 'private, max-age=3600' } }) : new Response('no', { status: r.status }))
        .catch(() => new Response('no', { status: 502 }))
    }
    // The page's Markdown renderer and its sanitiser, served from here (live/vendor),
    // not a CDN: a compromised CDN would otherwise run inside the call.
    // The wake-word spotter's files (KWS_DIR).
    const kwsFile = url.pathname.match(/^\/kws\/([\w.-]+)$/)?.[1]
    if (kwsFile && KWS_FILES[kwsFile] && existsSync(join(KWS_DIR, kwsFile))) return new Response(Bun.file(join(KWS_DIR, kwsFile)), { headers: { 'content-type': KWS_FILES[kwsFile], 'cache-control': 'public, max-age=604800' } })
    const vendor = url.pathname.match(/^\/vendor\/(marked\.min\.js|purify\.min\.js)$/)
    if (vendor) return new Response(Bun.file(join(HERE, 'vendor', vendor[1])), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' } })
    // Any other path serves the page (the uuid lives in the path, read client-side),
    // with a policy that lets it load nothing but itself and its fonts, and talk to
    // nothing but this server: no outside images (an answer's Markdown can't send
    // anything out through one), no outside scripts, not framed.
    const nonce = randomUUID().replace(/-/g, '')
    const page = readFileSync(join(HERE, 'index.html'), 'utf8').replace(/<script(?=[ >])/g, `<script nonce="${nonce}"`)
    return new Response(page, { headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
      'content-security-policy': [
        `default-src 'none'`, `script-src 'self' 'nonce-${nonce}' blob:`, `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
        `font-src https://fonts.gstatic.com`, `img-src 'self' data: blob:`, `connect-src 'self'`, `media-src 'self' blob:`, `worker-src 'self'`,
        `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`,
      ].join('; '),
    } })
  },
  websocket: {
    // Mic audio comes in 3.2 kB pieces and the page's messages are small.
    maxPayloadLength: 64 * 1024,
    open(ws) { ws.data.lastIn = Date.now(); open.add(ws); ws.send(JSON.stringify({ type: 'hello' })) },
    close(ws) {
      open.delete(ws)
      ws.data.run?.stop()
      ws.data.events?.abort()
      clearInterval(ws.data.topicsTimer); clearTimeout(ws.data.topicsSoon); clearTimeout(ws.data.queuedFor); clearTimeout(ws.data.woke); clearTimeout(ws.data.wokeIdle)
      if (ws.data.photoKey) photoKeys.delete(ws.data.photoKey)
      clearHeld(ws)
      ws.data.stt?.close()
      ws.data.opus?.free()
      const rec = ws.data.rec
      if (rec) {
        const s = summarize(requestTimings(readTrace(rec.dir)))
        if (s.requests) rec.trace('latency', latencyLine(s), s)
        rec.close()
      }
    },
    message(ws, raw) {
      // One bad message must not take the server — and every call on it — down.
      ws.data.lastIn = Date.now()
      try { onMessage(ws, raw) } catch (e) {
        console.error(`[live] message failed: ${e instanceof Error ? e.stack : e}`)
        ws.data.rec?.trace('error', `server error: ${e instanceof Error ? e.message : e}`)
      }
    },
  },
})
// Mic audio (16 kHz mono 16-bit PCM) in: the recording, the page's count, Soniox, the quiet.
function audioIn(ws: WS, pcm: Uint8Array) {
  ws.data.rec?.audio(pcm)
  ws.data.audioIn = (ws.data.audioIn ?? 0) + pcm.byteLength
  if (ws.data.audioIn - (ws.data.acked ?? 0) >= ACK_BYTES) { ws.data.acked = ws.data.audioIn; out(ws, { type: 'heard', s: +(ws.data.audioIn / 32000).toFixed(1) }) }
  // How much audio arrives, every 10 s (beside the page's own count of what it sent).
  const h = ws.data.got ??= { bytes: 0, wire: 0, since: Date.now() }
  h.bytes += pcm.byteLength
  if (Date.now() - h.since >= 10_000) { ws.data.rec?.trace('audio', `received ${(h.bytes / 32000).toFixed(1)} s of audio in ${((Date.now() - h.since) / 1000).toFixed(1)} s`, { kbit_s: Math.round(h.wire * 8 / (Date.now() - h.since)) }); ws.data.got = { bytes: 0, wire: 0, since: Date.now() } }
  if (!ws.data.stt) return
  ws.data.stt.send(pcm)
  // End the piece of speech after END_SILENCE_MS of quiet in the audio — once
  // per quiet stretch, and not while the button is held.
  const vad = ws.data.vad!
  const wasSpeaking = vad.speaking()
  vad.push(pcm)
  if (!wasSpeaking && vad.speaking() && ws.data.hold.texts.length) scheduleFlush(ws)   // the caller started again
  const quiet = vad.quietMs()
  if (!ws.data.held && Number.isFinite(quiet) && quiet >= END_SILENCE_MS) {
    const voiceAt = vad.position - quiet
    if (voiceAt !== ws.data.endedForVoice) {
      ws.data.endedForVoice = voiceAt
      ws.data.rec?.trace('soniox', `${Math.round(quiet)} ms of quiet in the audio: ending the piece`, { noise_floor: Math.round(vad.noiseFloor) })
      ws.data.stt.finalize()
    }
  }
}

function onMessage(ws: WS, raw: string | Buffer) {
  {
    {
      // Mic audio: 16 kHz mono 16-bit PCM, or Opus (live/opus.ts) decoded to it.
      if (typeof raw !== 'string') {
        if (!ws.data.authed) return
        const msg = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
        const g = ws.data.got ??= { bytes: 0, wire: 0, since: Date.now() }
        g.wire += msg.byteLength
        if (isOpus(msg)) {
          if (!ws.data.opus) { ws.data.opus = new OpusIn(pcm => { try { audioIn(ws, pcm) } catch (e) { ws.data.rec?.trace('error', `audio: ${e instanceof Error ? e.message : e}`) } }); ws.data.rec?.trace('audio', 'the mic comes as Opus') }
          if (!ws.data.opus.push(msg) && ws.data.opus.errors === 1) ws.data.rec?.trace('error', 'a piece of Opus audio was malformed: dropped')
          return
        }
        audioIn(ws, msg)
        return
      }
      let msg: any; try { msg = JSON.parse(raw) } catch { return }
      if (msg.type === 'auth') {
        // Once per connection: a second one would start a second call on it, and leave
        // the first one's timers keeping the link alive after the page has gone.
        if (ws.data.authed) { ws.close(); return }
        const links = loadLinks()
        const link = ownLink(links, msg.uuid)
        if (!link) { out(ws, { type: 'denied' }); ws.close(); return }
        if (linkExpired(link)) { out(ws, { type: 'expired' }); ws.close(); return }
        const device = claimDevice(link, msg.device)
        if (device === 'other' || device === 'missing') { out(ws, { type: device === 'other' ? 'other_device' : 'denied' }); ws.close(); return }
        if (device === 'bound') saveLinks(links)
        Object.assign(ws.data, { authed: true, uuid: msg.uuid, cwd: link.cwd, model: link.model, sessionId: link.sessionId, permission: permissionArgs(link), answers: answersFrom(msg.answers) ?? 'voice' })
        ws.data.call = new CallState()
        ws.data.vad = new Vad()
        ws.data.rec = new CallRecorder(CALLS_DIR, msg.uuid, {
          topic: link.key, cwd: link.cwd, model: link.model || DEFAULT_MODEL, permission: ws.data.permission, stt: SONIOX_KEY ? 'soniox' : 'browser',
          soniox: SONIOX_KEY ? { model: SONIOX.model, languages: SONIOX.languages, endpoint_ms: SONIOX.endpointMs, end_silence_ms: END_SILENCE_MS, quiet_ms: QUIET_MS, quiet_done_ms: QUIET_DONE_MS, max_wait_ms: MAX_WAIT_MS } : undefined,
          agent: String(msg.agent || '').slice(0, 300),
        })
        ws.data.rec.trace('auth', device === 'bound' ? 'link opened; this device now holds it' : 'link opened by its device', { answers: ws.data.answers, edge: ws.data.edge ?? 'direct', ...(msg.net && typeof msg.net === 'object' ? { net: msg.net } : {}) })
        startEvents(ws)
        stampUsed(msg.uuid)
        ws.data.photoKey = randomUUID(); photoKeys.set(ws.data.photoKey, msg.uuid)
        ws.data.me = link.user?.id
        ws.data.call.mode = modeFrom(msg.mode) ?? 'interactive'
        ws.data.call.wake = wakeFor(prefsKey(ws))
        ws.data.call.othersMayCall = othersFor(prefsKey(ws))
        if (SONIOX_KEY) startHearing(ws)   // after the wake words: Soniox is told to expect them
        ws.data.rec.trace('page', `mode: ${ws.data.call.mode}`, { wake: ws.data.call.wake, others_may_call: ws.data.call.othersMayCall })
        // While open: the link is in use; and a link revoked (a new /live) or expired
        // closes the page, not just its next turn.
        if (link.desk) {
          ws.data.desk = true
          void sendTopics(ws)
          ws.data.topicsTimer = setInterval(() => { if (!linkHolds(ws)) return; stampUsed(ws.data.uuid); void sendTopics(ws) }, TOPICS_EVERY_MS)
        } else ws.data.topicsTimer = setInterval(() => { if (linkHolds(ws)) stampUsed(ws.data.uuid) }, 60_000)
        const mode = ws.data.permission!.includes('--dangerously-skip-permissions') ? 'bypass' : ws.data.permission![ws.data.permission!.indexOf('--permission-mode') + 1]
        out(ws, { type: 'ready', where: link.cwd, model: link.model || DEFAULT_MODEL, mode, callMode: ws.data.call.mode, wake: ws.data.call.wake, others: ws.data.call.othersMayCall, stt: SONIOX_KEY ? 'soniox' : 'browser', audio: ['pcm', 'opus'], desk: !!link.desk, pk: ws.data.photoKey, ...(link.user ? { me: link.user.id } : {}), ...(SONIOX_KEY && kwsFor(ws.data.call.wake) ? { kws: kwsFor(ws.data.call.wake) } : {}) })
        return
      }
      if (!ws.data.authed) return
      if (msg.type !== 'ping' && !withinBudget(ws)) { if (ws.data.budget!.n === 61) ws.data.rec?.trace('page', 'too many messages: dropping them for a few seconds'); return }
      const call = ws.data.call!, rec = ws.data.rec!
      switch (msg.type) {
        case 'interrupt': stopAll(ws, 'stop button'); return
        // Browser speech recognition (no Soniox key), or typed.
        case 'text': {
          if (typeof msg.text !== 'string' || !msg.text.trim()) return
          if (msg.text.length > 20_000) { out(ws, { type: 'status', text: 'too long to send (at most 20000 characters)' }); return }
          ask(ws, msg.text.trim(), [], 'text'); return
        }
        // The mic button held (or Space): what is said is the caller's, pauses don't cut it,
        // and letting go sends it.
        case 'hold':
          ws.data.held = !!msg.on
          rec.trace('page', msg.on ? 'talking (button held)' : 'button let go')
          if (msg.on) { if (ws.data.hold.timer) clearTimeout(ws.data.hold.timer) }
          else {
            ws.data.heldUntilFinal = true
            if (ws.data.stt) ws.data.stt.finalize(); else flush(ws, true)
            // Nothing new was said: send what is held anyway.
            setTimeout(() => { if (ws.data.heldUntilFinal) { ws.data.heldUntilFinal = false; flush(ws, true) } }, 2500)
          }
          return
        // A tap on a line: that voice is the caller, or send that one line.
        case 'me': {
          const l = call.line(Number(msg.id))
          if (!l) return
          call.setMain(l.speaker)
          for (const x of call.lines) x.role = x.speaker === l.speaker ? 'me' : 'other'
          rec.trace('speaker', `you picked speaker ${l.speaker} as you`, { text: l.text })
          out(ws, { type: 'main', speaker: l.speaker })
          return
        }
        case 'send': {
          const l = call.line(Number(msg.id))
          if (!l) return
          l.sent = true
          ask(ws, l.text, [l.id], `picked line from speaker ${l.speaker}`)
          return
        }
        // How answers arrive. Leaving voice stops what is being read now.
        // Interactive or Assistant, switched on the page.
        case 'mode': {
          const m = modeFrom(msg.mode)
          if (!m || m === call.mode) return
          call.mode = m
          rec.trace('page', `mode now: ${m}`)
          out(ws, { type: 'call_mode', mode: m })
          return
        }
        // The words that call it in Assistant mode: this person's, for every call.
        case 'wake': {
          const w = parseWake(String(msg.words ?? ''))
          if (!w.length) { out(ws, { type: 'wake', words: call.wake, error: 'needs at least one word' }); return }
          call.wake = w
          savePref(prefsKey(ws), { wake: w })
          rec.trace('page', 'wake words changed (Soniox expects them from its next connection)', { wake: w })
          ws.data.stt?.setTerms(sonioxTerms(w))
          out(ws, { type: 'wake', words: w, ...(SONIOX_KEY ? { kws: kwsFor(w) ?? null } : {}) })
          return
        }
        // Whether others on the call may call it by name (Assistant mode): this person's, kept.
        case 'others': {
          call.othersMayCall = msg.on === true
          savePref(prefsKey(ws), { others: call.othersMayCall })
          rec.trace('page', `others on the call ${call.othersMayCall ? 'may' : 'may not'} call it by name`)
          out(ws, { type: 'others', on: call.othersMayCall })
          return
        }
        case 'answers': {
          const a = answersFrom(msg.mode)
          if (!a || a === ws.data.answers) return
          ws.data.answers = a
          rec.trace('page', `answers now: ${a === 'voice' ? 'spoken' : a === 'sound' ? 'a sound when ready' : 'silent'}`)
          if (a !== 'voice') { ws.data.speakStop?.(); out(ws, { type: 'hush' }) }
          return
        }
        // The topic open on the page: "this" and "here" on the call mean that one.
        case 'view': {
          const v = msg.topic === 'General' ? 'General' : Number.isInteger(msg.topic) && msg.topic > 0 ? msg.topic as number : undefined
          if (!ws.data.desk || v === undefined || v === ws.data.viewing) return
          ws.data.viewing = v
          rec.trace('page', `viewing topic ${v}`)
          void sendMessages(ws)
          return
        }
        // Answering what waits on the caller in a topic, from the page; and stopping a run.
        case 'answer': {
          if (!ws.data.desk || typeof msg.id !== 'string' || msg.id.length > 40 || !inBot()) return
          const body = { link: ws.data.uuid, id: msg.id, ...(typeof msg.allow === 'boolean' ? { allow: msg.allow } : {}), ...(msg.go === true ? { go: true } : {}),
            ...(Array.isArray(msg.answers) ? { answers: msg.answers.slice(0, 4) } : {}) }
          rec.trace('page', `answered ${msg.id}`, { answer: JSON.stringify(body).slice(0, 300) })
          void botApi('POST', '/v1/live/answer', body).then(async r => {
            const b: any = await r.json().catch(() => ({}))
            out(ws, { type: 'answered', id: msg.id, ok: r.ok, ...(r.ok ? { message: b.message } : { error: String(b.error ?? r.status).slice(0, 160) }) })
            topicsSoon(ws)
          }).catch(() => out(ws, { type: 'answered', id: msg.id, ok: false, error: 'the bot could not be reached' }))
          return
        }
        case 'stop_run': {
          if (!ws.data.desk || typeof msg.run !== 'string' || msg.run.length > 64 || !inBot()) return
          rec.trace('page', `stop run ${msg.run}`)
          void botApi('POST', '/v1/live/stop', { link: ws.data.uuid, run: msg.run }).then(async r => {
            const b: any = await r.json().catch(() => ({}))
            out(ws, { type: 'stopped_run', run: msg.run, ok: r.ok, ...(r.ok ? {} : { error: String(b.error ?? r.status).slice(0, 160) }) })
            topicsSoon(ws)
          }).catch(() => {})
          return
        }
        // Another topic's messages, ahead of opening it.
        case 'fetch': {
          const t = msg.topic === 'General' ? 'General' : Number.isInteger(msg.topic) && msg.topic > 0 ? msg.topic as number : undefined
          if (ws.data.desk && t !== undefined) void sendMessages(ws, undefined, t)
          return
        }
        // Typed into the open topic: it goes there as the caller's message, through the bot.
        case 'type': {
          const topic = msg.topic === 'General' ? 'General' : Number.isInteger(msg.topic) && msg.topic > 0 ? msg.topic as number : undefined
          const text = typeof msg.text === 'string' ? msg.text.trim() : ''
          if (!ws.data.desk || topic === undefined || !text || !inBot()) return
          rec.trace('page', `typed into topic ${topic}`, { text: text.slice(0, 500) })
          void (async () => {
            let error: string | undefined
            try {
              const res = await botApi('POST', '/v1/live/say', { link: ws.data.uuid, topic, text: text.slice(0, 20_000) })
              if (!res.ok) error = String((await res.json().catch(() => ({})) as any).error ?? `the bot answered ${res.status}`)
            } catch (e) { error = 'the bot could not be reached' }
            if (error) { rec.trace('page', `not sent: ${error}`); error = error.slice(0, 160) }
            out(ws, { type: 'typed', topic, ok: !error, ...(error ? { error } : {}) })
            if (!error) { void sendMessages(ws); topicsSoon(ws) }
          })()
          return
        }
        // The words of an answer the page is about to play (its voice note): what the mic will hear back.
        case 'echo': call.speaking(String(msg.text ?? '').slice(0, 8000)); return
        // The phone heard the wake phrase while the mic was off and turned the mic on,
        // sending the seconds before it first. Soniox must hear the wake phrase in them,
        // or the mic goes off again (heard() confirms it).
        case 'woke': {
          clearTimeout(ws.data.woke)
          const said = String(msg.keyword ?? '').slice(0, 80)
          rec.trace('voice', `wake phrase heard on the phone (${said}): mic on`)
          wokeIdle(ws, Date.now())
          ws.data.woke = setTimeout(() => {
            ws.data.woke = undefined
            clearTimeout(ws.data.wokeIdle); ws.data.wokeIdle = undefined
            rec.trace('voice', `false wake: no wake word heard within ${WOKE_CONFIRM_MS / 1000} s, mic off again; what was heard since is dropped`)
            out(ws, { type: 'mic', on: false, ms: 0, why: 'false_wake' })
            // Its words would otherwise wait in the open piece and join the next request.
            const t = ws.data.tracker, stt = ws.data.stt
            if (t && stt) { t.dropBefore(Math.max(stt.sentMs, t.openWordEnd() ?? 0)); stt.finalize() }
          }, WOKE_CONFIRM_MS)
          return
        }
        case 'playing': call.setPlaying(!!msg.on); rec.trace('page', msg.on ? 'playing the answer' : 'answer playback ended'); if (!msg.on) runQueued(ws); return
        // What the page saw: mic on/off, permission refused, playback trouble…
        case 'trace': {
          const extra = msg.extra && typeof msg.extra === 'object' && JSON.stringify(msg.extra).length <= 2000 ? { extra: msg.extra } : {}
          rec.trace('page', String(msg.msg || '').slice(0, 500), extra); return
        }
        case 'ping': return   // keeps the connection busy, so nothing on the way closes it as idle
        // The page's round-trip check (every 2 s), answered at once: its time comes back as sent.
        case 'rtt': out(ws, { type: 'rtt', t: Number(msg.t) || 0 }); return
      }
    }
  }
}
// Close the connections whose page has gone quiet.
const open = new Set<WS>()
function sweepStale(now = Date.now()): number {
  let n = 0
  for (const ws of open) {
    if (now - (ws.data.lastIn ?? now) < STALE_MS) continue
    ws.data.rec?.trace('connection', `nothing from the page for ${Math.round((now - ws.data.lastIn!) / 1000)} s: closing the call`)
    open.delete(ws); n++
    try { ws.close() } catch {}
  }
  return n
}
setInterval(() => sweepStale(), Math.min(15_000, Math.max(200, STALE_MS / 4)))
// Stopped (a restart, the watchdog): each open call records its end, which a killed
// server never did.
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => {
  for (const ws of open) { ws.data.rec?.trace('connection', `server stopping (${sig})`); ws.data.rec?.close(); try { ws.close(1012, 'restarting') } catch {} }
  process.exit(0)
})
process.on('uncaughtException', e => console.error(`[live] uncaught: ${e instanceof Error ? e.stack : e}`))
process.on('unhandledRejection', e => console.error(`[live] unhandled: ${e instanceof Error ? e.stack : e}`))

if (TTS && /^paradee$/i.test(ENGLISH_VOICE)) paradeeWorker = new VoiceWorker('paradee', [PARADEE_PY, join(HERE, 'paradee_worker.py')], voiceEnv())
if (TTS && /^kokoro$/i.test(ENGLISH_VOICE)) kokoroWorker = new VoiceWorker('kokoro', ['python3', join(HERE, 'worker.py')], voiceEnv())
console.log(`[live] voice server on http://127.0.0.1:${server.port}  links=${LINKS_FILE}  hearing=${SONIOX_KEY ? `soniox ${SONIOX.model}` : 'browser'}  fast=${FAST_ON ? FAST.models[0] : 'off'}`)
