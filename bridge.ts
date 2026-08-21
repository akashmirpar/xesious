#!/usr/bin/env bun
/**
 * claude-tg-bridge — drive the Claude Code CLI from Telegram, one session per topic.
 *
 * Each (chat, forum-topic) maps to its own working DIRECTORY and its own
 * resumable Claude Code session. A message in a topic runs
 *   claude -p "<text>" --resume <session_id> --output-format json
 * inside that topic's directory; the reply is posted back into the same topic.
 *
 * Because each topic has a dedicated directory, you can also drop into it on the
 * server and continue the very same conversation:
 *   cd <TG_SESSIONS_BASE>/<topic-name> && claude --continue
 *
 * No API key: the CLI uses your existing claude.ai (Pro/Max) login.
 * No MCP / channels: this is a plain Telegram bot that shells out to `claude`.
 * History persists at ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * Config comes from the environment (and a sibling .env). See .env.example.
 */
import { Bot, InputFile, type Context } from 'grammy'
import { run, type RunnerHandle } from '@grammyjs/runner'
import telegramify from 'telegramify-markdown'
import { autoRetry } from '@grammyjs/auto-retry'
import { apiThrottler } from '@grammyjs/transformer-throttler'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, renameSync, mkdtempSync, rmSync, copyFileSync, readlinkSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname, join, isAbsolute, basename, extname, resolve, relative } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import {
  parseIdList, keyFor, sanitize, encodeCwd, parseDirs,
  MODE_HELP, allowedModes, MODEL_ALIASES, MODEL_DEFAULT, normalizeModel,
  EFFORT_LEVELS, EFFORT_DEFAULT, normalizeEffort,
  parseStreamLine, type Step, THINKING, RUN_RECORD, conflictAdvice, isNonAnswer, promoteBlock, stalenessNote,
  markdownToHtml, htmlDocument, lastEffortFrom, needsReplyLink,
  fanoutPlanPrompt, parseFanoutPlan, renderFanoutProposal, buildSynthesisPreamble,
  FANOUT_MARK, fanoutTopicName, topicLink, topicTag, messageLink, forkTopicName, filesPreamble,
  type FanoutPlanItem,
  frameUserMessage, attributionProfileLines,
  needsRich, hasRtl, sanitizeProse,
  normalizeMode as libNormalizeMode,
  permissionArgs as libPermissionArgs,
  renderSteps as libRenderSteps,
  renderStepsHtml as libRenderStepsHtml,
} from './lib'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HERE = import.meta.dir

function loadDotenv(path: string): void {
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}
// Defaults to the sibling .env. An isolated instance (e.g. the Tier 3 staging
// harness) can point this elsewhere — or at /dev/null — so it never inherits the
// production .env. Bun's own auto-load is disabled separately via --env-file.
loadDotenv(process.env.TG_ENV_FILE || join(HERE, '.env'))

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`[fatal] ${name} is required (set it in the environment or .env)`); process.exit(1) }
  return v
}

const TOKEN = requireEnv('TELEGRAM_BOT_TOKEN')
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'
const DEFAULT_WORKDIR = process.env.TG_WORKDIR || process.cwd()
// Root under which each topic gets its own directory (named after the topic).
const SESSIONS_BASE = process.env.TG_SESSIONS_BASE || join(homedir(), 'tg-topics')
const STATE_FILE = process.env.TG_STATE_FILE || join(HERE, 'state', 'sessions.json')
// Default posture per topic (override with /mode). `auto` over `acceptEdits`: the
// classifier still blocks destructive and irreversible calls, where acceptEdits
// waves through everything in TG_ALLOWED_TOOLS — Bash included — unexamined.
const PERMISSION_MODE = (process.env.TG_PERMISSION_MODE || 'auto').trim()
const ALLOWED_TOOLS =
  process.env.TG_ALLOWED_TOOLS ||
  'Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch,Agent,TodoWrite,NotebookEdit'
const MODEL = process.env.TG_MODEL?.trim() || ''
const REQUIRE_MENTION = /^(1|true|yes)$/i.test(process.env.TG_REQUIRE_MENTION || '')
// Absolute backstop only. This used to default to 30 minutes and was the sole
// watchdog, which SIGKILLed working turns and lost all their work — one real run
// did 17+ minutes of continuous tool calls. The idle watchdog below is what
// actually catches a hang, so this can be generous.
// Fleet default for reasoning effort; a topic's /effort overrides it. Validated at
// startup rather than passed through blindly — an unrecognised value would reach
// the CLI as a bad flag and fail every turn in every topic.
const EFFORT_TIER = normalizeEffort(process.env.TG_EFFORT ?? '') ?? (() => {
  console.error(`[warn] TG_EFFORT="${process.env.TG_EFFORT}" is not one of ${EFFORT_LEVELS.join(', ')} — ignoring it`)
  return ''
})()
const CLAUDE_TIMEOUT_MS = Number(process.env.TG_CLAUDE_TIMEOUT_MS || 4 * 60 * 60 * 1000)
// No stream event for this long means the child is hung rather than busy. It must
// exceed the longest plausible single tool call: events arrive per tool call, and
// a real one has spent 8+ minutes inside a single Bash step.
const IDLE_TIMEOUT_MS = Number(process.env.TG_IDLE_TIMEOUT_MS || 15 * 60 * 1000)
// How long a run may be quiet before the status message says so.
const QUIET_NOTE_MS = Number(process.env.TG_QUIET_NOTE_MS || 90 * 1000)
// The status message carries this from the moment it appears, not after a delay.
// A run is interruptible from its first second, so the control should be there from
// its first second — a button that materialises later is a control you have to
// notice arriving, exactly when you are already waiting on something.
const INTERRUPT_LABEL = '— Interrupt —'
// Every message that will WAIT gets the offer — there is no delay threshold.
//
// There used to be one, to keep a burst of messages from sprouting a button each.
// It made the feature inconsistent in exactly the wrong way: send a message just
// after a long task starts and it queued silently, while a later message got the
// offer, so the option appeared to depend on nothing you could see. The threshold
// existed to limit clutter, and the offer now deletes itself the moment its message
// is picked up, so there is no clutter left to limit.
//
// Deliberately NOT capped in number. These are temporary jobs — each runs and
// exits — unlike a warm session, which stays resident. The memory ceiling that
// bounds the warm-sessions item does not apply in the same way here, so a cap would
// be a restriction without a matching risk.
const PARALLEL_LABEL = '— Run this now —'
// How long a graceful shutdown will wait for in-flight runs before giving up on
// them. A deploy normally waits for idle before signalling, so this is the
// backstop for a SIGTERM that lands mid-run — and for the hung-child case, where
// the child never exits at all.
const DRAIN_MAX_MS = Number(process.env.TG_DRAIN_MAX_MS || 5 * 60 * 1000)

// What becomes of the live progress message when a run ends.
//   auto (default) — keep it when the turn said things that are not in the reply,
//                    delete it otherwise, so a simple turn leaves no clutter
//   keep / off     — always / never
// This is what makes mid-turn text safe to route into the status: nothing the
// model said is thrown away, it is one tap behind the record of the run.
const PROGRESS_KEEP = (process.env.TG_PROGRESS_KEEP || 'auto').toLowerCase()

// How long to wait out a polling 409, and how many rounds may still be blamed on
// our own expiring long-poll. 40s clears the ~30s server-side reservation; two
// rounds is 80s, comfortably past it, so anything beyond that is a real rival.
const CONFLICT_WAIT_MS = 40_000
const GHOST_CONFLICTS = 2
const ALLOWED_USERS = parseIdList(process.env.TG_ALLOWED_USERS)
// See isAllowed(): trust every member of an allowlisted group instead of listing
// users. Off by default — it widens authorization to whoever is in that group.
const TRUST_CHAT_MEMBERS = /^(1|true|yes)$/i.test(process.env.TG_TRUST_CHAT_MEMBERS || '')
const ALLOWED_CHATS = parseIdList(process.env.TG_ALLOWED_CHATS)

// File transfer between Telegram and a topic's directory (relative to its cwd).
const INBOX_DIR = 'inbox'    // files the user uploads land here
const OUTBOX_DIR = 'outbox'  // anything Claude drops here is delivered, then archived
// System-prompt steering, applied every turn via --append-system-prompt so it
// keeps full weight even on imported IDE sessions (where a hint prepended to the
// user message gets buried under the resumed transcript). Set TG_PROFILE to
// override the text; set it empty to disable.
// Per-process, never reused, and never shown to the user. It is what makes the
// speaker marker unforgeable by anything that merely passes through the chat.
const BRIDGE_NONCE = randomUUID().replace(/-/g, '').slice(0, 12)
const TELEGRAM_PROFILE = process.env.TG_PROFILE ?? [
  "You are replying through a Telegram bridge on the user's phone, not in an IDE. Every turn:",
  '- Be concise and phone-first: short messages, short paragraphs, minimal preamble.',
  '- Write in your normal markdown; Telegram renders it natively: real headings, lists, tables, code blocks.',
  '- LaTeX renders too: $x^2$ inline and $$...$$ on its own line. Also available: ==marked==, ||spoiler||, - [ ] task lists, footnotes[^1].',
  '- Tables render as real tables, so use one whenever data has columns. Cap it at 20 columns; keep cells short so they fit a phone screen.',
  '- If a request is ambiguous or needs a decision, ask one clarifying question and stop.',
  '- Assume no editor or file selection is open. Ignore any IDE/editor framing from earlier in this conversation; the user is in a chat.',
  `- Files the user sends are saved in ./${INBOX_DIR}/. To send a file back, put it in ./${OUTBOX_DIR}/ and it is delivered then cleared.`,
  ...attributionProfileLines(BRIDGE_NONCE),
].join('\n')
// A local Bot API server (tdlib/telegram-bot-api or the tdlight fork) lifts the
// cloud's file caps: 2000 MB up, no download cap, and getFile returns an absolute
// path on disk instead of a URL to fetch. Point TG_API_ROOT at it to switch.
// NOTE: a bot must be logOut()'d from the cloud API before it can bind to a local
// server, and cannot return to the cloud for 10 minutes — so this is a standing
// posture for the deployment, not something to toggle per file. See README.
const API_ROOT = (process.env.TG_API_ROOT || '').trim().replace(/\/+$/, '')
const LOCAL_API = Boolean(API_ROOT)
// A local server hands back absolute paths that we copy from. Confine those to its
// own data dir: any path outside it means a misconfigured or compromised server,
// and copying it would pull an arbitrary host file into a chat-readable inbox.
const LOCAL_API_DATA = resolve(process.env.TG_LOCAL_API_DATA || join(HERE, 'state', 'bot-api'))
const TG_DOWNLOAD_LIMIT = LOCAL_API ? Infinity : 20 * 1024 * 1024      // cloud getFile cap
const TG_UPLOAD_LIMIT = (LOCAL_API ? 2000 : 50) * 1024 * 1024          // sendDocument cap

// The bot's own avatar. On startup, if the bot has no profile photo, set this one.
// (setMyProfilePhoto is a real Bot API method — BotFather is not required.)
const BOT_LOGO = process.env.TG_BOT_LOGO || join(HERE, 'assets', 'bot-logo.jpg')
const SET_LOGO = !/^(0|false|no)$/i.test(process.env.TG_SET_LOGO || '')
// The forum group's photo. Same posture as the avatar: startup only fills it in
// when the group has none, so an existing photo is never taken over. /logo group
// sets it deliberately. Needs the bot to be an admin with can_change_info.
const GROUP_LOGO = process.env.TG_GROUP_LOGO || join(HERE, 'assets', 'group-logo.jpg')
const SET_GROUP_LOGO = !/^(0|false|no)$/i.test(process.env.TG_SET_GROUP_LOGO || '')
// Show the actual tool input (command, path, url) in the live status message,
// inside a collapsed <blockquote expandable>. Set 0 for the older terse labels.
// OPT-IN (TG_PROGRESS_DETAIL=1). The detail is the raw tool input — commands
// routinely carry secrets (tokens in curl URLs, DB passwords), and anything shown
// here is posted into the chat and kept in Telegram's history. Off by default.
const PROGRESS_DETAIL = /^(1|true|yes)$/i.test(process.env.TG_PROGRESS_DETAIL || '')

// Turn-based voice. When a topic is in voice mode: a voice note is transcribed
// and run as a prompt, and each answer is also spoken back as a voice message —
// so the whole loop is eyes-free. STT (faster-whisper) and TTS (piper/espeak-ng)
// run locally, no API key. All three commands are overridable.
// Live voice web client: /live mints a per-topic link at LIVE_URL/<uuid>, bound to
// this topic's Claude session. The uuid is the only secret — no password. The link
// map is shared on disk with the live server (live/server.ts).
const LIVE_URL = (process.env.LIVE_URL || 'https://app.besporesh.ir').replace(/\/+$/, '')
const LINKS_FILE = process.env.LIVE_LINKS_FILE || join(HERE, 'state', 'live-links.json')
type LiveLink = { key: string; cwd: string; model?: string; sessionId?: string; created: string }
function loadLinks(): Record<string, LiveLink> {
  try { return JSON.parse(readFileSync(LINKS_FILE, 'utf8')) } catch { return {} }
}
function saveLinks(l: Record<string, LiveLink>): void {
  try { mkdirSync(dirname(LINKS_FILE), { recursive: true }); writeFileSync(LINKS_FILE, JSON.stringify(l, null, 2)) } catch (e) { console.error(`[live-links] ${e}`) }
}
// The (single) live link bound to a topic, if any.
function linkForKey(key: string): { uuid: string; link: LiveLink } | null {
  const l = loadLinks()
  for (const [uuid, link] of Object.entries(l)) if (link.key === key) return { uuid, link }
  return null
}

const VOICE_DEFAULT = /^(1|true|yes)$/i.test(process.env.TG_VOICE || '')
const STT_CMD = process.env.TG_STT_CMD || `python3 ${join(HERE, 'voice', 'stt.py')}`
const TTS_CMD = process.env.TG_TTS_CMD || join(HERE, 'voice', 'tts.sh')
// A short answer is spoken verbatim; a long one is first summarized to a couple
// of sentences by a fast model so the voice note stays seconds, not minutes.
const VOICE_SUMMARY_MODEL = process.env.TG_VOICE_SUMMARY_MODEL || 'haiku'
const VOICE_SPEAK_MAX = Math.max(200, Number(process.env.TG_VOICE_MAX_CHARS || 1400))

// Importing existing Claude Code sessions (the ones the IDE/CLI session picker
// shows) as topics. A directory's sessions live at CLAUDE_PROJECTS/<encoded>/<id>.jsonl.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const CLAUDE_PROJECTS = join(CLAUDE_DIR, 'projects')
const IMPORT_BACKFILL = Math.max(0, Number(process.env.TG_IMPORT_BACKFILL || 12))  // turns backfilled per session
const IMPORT_MAX_SESSIONS = Math.max(1, Number(process.env.TG_IMPORT_MAX || 10))   // cap topics created per /import
const REPLY_FILE_CHARS = Math.max(0, Number(process.env.TG_REPLY_FILE_CHARS || 6000)) // replies longer than this go as a file
// Which file(s) a long reply is delivered as: md | html | both (default).
// Both, rather than swapping one for the other: the .md is the source of truth —
// it diffs, and it is what other tools want — while the .html is the one that is
// actually readable when double-clicked, which .md is not on macOS.
const REPLY_FILE_FORMAT = (() => {
  const v = (process.env.TG_REPLY_FILE_FORMAT || 'both').toLowerCase()
  if (v === 'md' || v === 'html' || v === 'both') return v
  console.error(`[warn] TG_REPLY_FILE_FORMAT="${v}" is not md|html|both — using both`)
  return 'both'
})()
const INTERRUPT_DEFAULT = /^(1|true|yes)$/i.test(process.env.TG_INTERRUPT || '')       // a new message interrupts the running one instead of queueing

// ---------------------------------------------------------------------------
// Persistent state:  sessions[(chat:topic)] = { sessionId, cwd }
//                    names[(chat:topic)]    = "human topic name"
// ---------------------------------------------------------------------------

// lastModel / lastCliVersion are OBSERVED from the previous run's init event, not
// predicted — hence the "last run" wording wherever they are shown.
type Entry = { sessionId?: string; prevSessionId?: string; cwd: string; updated?: string; lastModel?: string; lastCliVersion?: string; lastEffort?: string }
let sessions: Record<string, Entry> = {}
let names: Record<string, string> = {}
// "💭 Thinking…" status messages for in-flight runs. If the process is killed
// before a run finishes (e.g. a restart), the next startup deletes these so no
// orphaned status message is left dangling in a topic.
let pending: { chat: number; id: number }[] = []
// Per-topic "interrupt mode": a new message cancels the running run and starts
// the new one immediately, instead of queueing behind it. Defaults to TG_INTERRUPT.
let interruptMode: Record<string, boolean> = {}
const isInterrupt = (key: string) => interruptMode[key] ?? INTERRUPT_DEFAULT
// Per-topic permission mode, switchable from Telegram with /mode. Defaults to
// TG_PERMISSION_MODE.
let modes: Record<string, string> = {}
const modeFor = (key: string) => {
  const m = modes[key] ?? PERMISSION_MODE
  // A bypass persisted before the opt-in existed (or set via TG_PERMISSION_MODE)
  // must not silently keep taking effect once TG_ALLOW_BYPASS is off.
  return m === 'bypass' && !ALLOW_BYPASS ? 'auto' : m
}
// True when this topic is STORED as bypass but is being downgraded because the env
// var is absent. The downgrade is correct; doing it silently is not — a topic you
// deliberately set to bypass quietly runs in auto after a deploy that drops the
// var, and nothing ever says so.
const bypassDowngraded = (key: string) => modes[key] === 'bypass' && !ALLOW_BYPASS
// Per-topic model override, switchable with /model. Empty string ⇒ fall back to
// TG_MODEL, and empty TG_MODEL ⇒ the account default (no --model flag at all).
let models: Record<string, string> = {}
const modelFor = (key: string) => models[key] ?? MODEL

// Per-topic reasoning effort, sticky like /mode and /model. Absent falls back to
// TG_EFFORT; empty means pass no --effort and let the CLI decide.
let efforts: Record<string, string> = {}
const effortFor = (key: string) => efforts[key] ?? EFFORT_TIER
// What effort this topic is actually on. An override answers directly; otherwise
// report what the LAST RUN used, read from the session transcript — "default" on
// its own tells the user nothing, and the CLI does not report effort in the stream
// (verified against a live run: init carries model and permissionMode, not effort).
function effortLabel(key: string): string {
  const set = effortFor(key)
  if (set) return set
  const seen = observedEffort(key)
  return seen
    ? `${EFFORT_DEFAULT} → ${seen} (last run)`
    : `${EFFORT_DEFAULT} → chosen by the CLI (unknown until this topic has run once)`
}

// Read the tail of this topic's transcript for the effort of its most recent
// assistant message. Tail only: a transcript reaches megabytes and this is called
// to render a status line. Cached on the entry so repeated /status calls are free.
const EFFORT_TAIL_BYTES = 256 * 1024
function observedEffort(key: string): string | undefined {
  const e = sessions[key]
  if (!e?.sessionId || !e.cwd) return undefined
  try {
    const file = join(projectDir(e.cwd), `${e.sessionId}.jsonl`)
    const size = statSync(file).size
    const fd = openSync(file, 'r')
    try {
      const len = Math.min(size, EFFORT_TAIL_BYTES)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, Math.max(0, size - len))
      const found = lastEffortFrom(buf.toString('utf8'))
      if (found && found !== e.lastEffort) { sessions[key] = { ...e, lastEffort: found }; saveState() }
      return found ?? e.lastEffort
    } finally { closeSync(fd) }
  } catch { return e.lastEffort }
}
function effortText(key: string): string {
  return `Reasoning effort for this topic: ${effortLabel(key)}\n\n` +
    `Higher spends more thinking per turn — better on hard questions, slower and dearer on easy ones.\n\n` +
    `Tap to switch, or /effort <level>.`
}
function effortKeyboard(key: string) {
  const cur = effortFor(key)
  const rows = EFFORT_LEVELS.map(e => [{ text: `${e === cur ? '● ' : ''}${e}`, callback_data: `effort:${e}` }])
  rows.push([{ text: `${cur === '' ? '● ' : ''}${EFFORT_DEFAULT}`, callback_data: `effort:${EFFORT_DEFAULT}` }])
  return { inline_keyboard: rows }
}
// Per-topic voice mode (transcribe voice notes, speak answers). Toggle with /voice.
// Per-topic voice: 'full' (speak the whole answer) or 'summary' (speak a short
// summary). Absent falls back to TG_VOICE. Text is always the complete answer.
let voice: Record<string, string> = {}
function voiceMode(key: string): 'off' | 'full' | 'summary' {
  const v = voice[key]
  if (v === 'full' || v === 'summary') return v
  if (v === undefined) return VOICE_DEFAULT ? 'full' : 'off'
  return 'off'
}

function loadState(): void {
  try {
    if (existsSync(STATE_FILE)) {
      const o = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
      sessions = o.sessions ?? {}
      names = o.names ?? {}
      pending = o.pending ?? []
      interruptMode = o.interruptMode ?? {}
      modes = o.modes ?? {}
      models = o.models ?? {}
      efforts = o.efforts ?? {}
      voice = o.voice ?? {}
      // Plans proposed but not yet confirmed. A plan is just text until you tap
      // "run", and losing it to a restart made the button answer "that plan is no
      // longer available" for something the person had only just been offered.
      // Restored as pending: nothing was ever started, so there is nothing to adopt.
      for (const f of (o.fanoutPlans ?? []) as Fanout[]) fanouts.set(f.id, f)
      // migrate old boolean state: true → 'full', false/other → off
      for (const k of Object.keys(voice)) { const v: any = voice[k]; if (v === true) voice[k] = 'full'; else if (v !== 'full' && v !== 'summary') delete voice[k] }
    }
  } catch (e) { console.error(`[warn] could not read state (${e}); starting empty`) }
}
function saveState(): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({ sessions, names, pending, interruptMode, modes, models, efforts, voice,
      // Only the ones still awaiting a decision. A fan-out that has started cannot be
      // resumed — its parts were child processes and died with the bridge — so
      // persisting it would offer a button that could not honour itself.
      fanoutPlans: [...fanouts.values()].filter(f => f.children.every(c => c.status === 'pending')),
    }, null, 2))
  } catch (e) { console.error(`[warn] could not write state: ${e}`) }
}

// The icon for topics the bridge creates. Telegram only accepts custom-emoji ids
// from its built-in "Topics" set (getForumTopicIconStickers), and 📁 is the only
// folder in it — so a topic reads as a folder. Overriding needs an id from that
// set, not an arbitrary emoji. (An icon_color alone just tints a letter bubble,
// which is why an earlier attempt at a "flat folder" never produced one.)
const TOPIC_ICON = process.env.TG_TOPIC_ICON || '5357315181649076022' // 📁


// Resolve (and create) the working directory for a chat/topic. Once chosen for a
// key it is stored and stays stable, so its session always resumes correctly.
function resolveCwd(ctx: Context, threadId: number | undefined): string {
  const chat = ctx.chat!
  const key = keyFor(chat.id, threadId)
  const existing = sessions[key]?.cwd
  if (existing) return ensureDir(existing)

  let dir: string
  if (chat.type === 'private') {
    dir = join(SESSIONS_BASE, `dm-${ctx.from!.id}`)
  } else if (threadId === undefined) {
    dir = join(SESSIONS_BASE, `${chat.id}-general`)
  } else {
    const name = names[key]
    dir = join(SESSIONS_BASE, name ? sanitize(name) : `topic-${threadId}`)
  }
  ensureDir(dir)
  sessions[key] = { ...(sessions[key] ?? {}), cwd: dir }
  saveState()
  return dir
}
function ensureDir(dir: string): string {
  try { mkdirSync(dir, { recursive: true }) } catch (e) { console.error(`[warn] mkdir ${dir}: ${e}`) }
  return dir
}

// ---------------------------------------------------------------------------
// Per-topic serialization: same topic runs one prompt at a time (ordered
// --resume); different topics run in parallel.
// ---------------------------------------------------------------------------

const queues = new Map<string, Promise<unknown>>()
// The claude child currently running for a topic (for /stop), and topics whose
// run was deliberately killed via /stop (so we suppress the error reply).
// Written on a deliberate shutdown and consumed by the next startup. Its only job
// is to distinguish "we meant to stop" from "we crashed", which decides whether
// the updates that arrived while we were down are kept or dropped.
const CLEAN_EXIT_MARKER = join(dirname(STATE_FILE), '.clean-exit')

// This process's pid, published for the deploy scripts and — more importantly —
// used as a mutex so a second poller can never start against the same deployment.
//
// Scoped to the state file's directory rather than to the working directory, and
// that distinction is deliberate: what must not be duplicated is a *deployment*
// (one bot token, one getUpdates stream), not a checkout. The staging harness runs
// a second bridge from this very directory with its own token and its own
// TG_STATE_FILE, which is legitimate and must keep working.
const PID_FILE = join(dirname(STATE_FILE), 'bridge.pid')

// Does a live bridge already hold this deployment? Verified on the same three
// proofs lib.sh uses — alive, ours, and in this directory — because a pidfile is
// only a claim: a SIGKILLed or OOM-killed bridge leaves one behind, and pids get
// reused. A file that fails any proof is stale and gets overwritten.
// ---------------------------------------------------------------------------
// token lock — one poller per bot token
// ---------------------------------------------------------------------------
//
// Telegram permits exactly one open getUpdates per TOKEN, and the 409 it returns
// is the mild half of the problem. The update queue is server-side and shared per
// token, and each getUpdates confirms an offset for everything before it, so two
// pollers consume from the same queue: every message goes to whichever instance
// happens to be polling at that moment. A conversation silently splits across two
// processes with different session bindings, working directories and state files.
//
// PID_FILE above cannot see that. It is scoped to the state directory, so two
// checkouts of the same deployment each believe they are alone — verified by
// running two of them: both started, then one sat in the 40s 409 retry loop while
// the other polled. The lock therefore has to be keyed on what Telegram actually
// serialises on: the token.
//
// Keyed by the FULL sha256 digest, never the token itself (it is a secret, and it
// would otherwise appear in a filename). Full digest rather than a short prefix
// because a collision here would refuse to start an unrelated bot — the opposite
// trade-off from session names, where a short digest is merely cosmetic.
//
// Per-user by construction: the lock lives in $HOME, so it cannot detect the same
// token being duplicated by a DIFFERENT user. That limit is deliberate — a shared
// location such as /tmp would let any local user plant a lock and hold this bot
// down. Nor can it see a bridge on another machine; nothing local could.
const LOCK_DIR = join(homedir(), '.xesious', 'locks')
const EXIT_TOKEN_HELD = 3
const tokenLockPath = (token: string) => join(LOCK_DIR, createHash('sha256').update(token).digest('hex'))

type LockHolder = { pid: number; cwd: string; started: string }

// Field 22 of /proc/<pid>/stat is the process start time. comm (field 2) is
// parenthesised and may itself contain spaces and parens, so parse from the LAST
// ')' rather than splitting the whole line.
function procStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch { return undefined }
}

// Who holds this lock — or nobody. Every proof must land, and anything unprovable
// counts as STALE so we take the lock and accept a possible 409.
//
// That direction is deliberate. A 409 is disruptive but partially self-healing; a
// lock we wrongly believe is held keeps the bot down until a human deletes a file,
// which is the worse failure. So: a SIGKILLed or OOM-killed holder leaves a record
// whose pid is gone (stale), and a container where /proc hides the other process
// reads as stale too — falling back to the old behaviour rather than an outage.
function lockHolder(path: string): LockHolder | undefined {
  let rec: LockHolder
  try {
    rec = JSON.parse(readFileSync(path, 'utf8'))
    if (!Number.isInteger(rec?.pid) || rec.pid <= 0 || !rec.cwd) return undefined
  } catch { return undefined }
  if (rec.pid === process.pid) return undefined
  try {
    if (statSync(`/proc/${rec.pid}`).uid !== process.getuid?.()) return undefined
    if (readFileSync(`/proc/${rec.pid}/comm`, 'utf8').trim() !== 'bun') return undefined
    if (readlinkSync(`/proc/${rec.pid}/cwd`) !== rec.cwd) return undefined
    // Start time is what makes pid reuse unmistakable. Without it, a recycled pid
    // that happened to be another bun of ours in the same directory would read as
    // a live holder and keep this bridge down for no reason.
    if (procStartTime(rec.pid) !== rec.started) return undefined
    return rec
  } catch { return undefined }
}

function takeLock(path: string): void {
  try {
    mkdirSync(LOCK_DIR, { recursive: true, mode: 0o700 })
    const rec: LockHolder = { pid: process.pid, cwd: process.cwd(), started: procStartTime(process.pid) ?? '' }
    // Write-then-rename so a reader never sees a half-written record.
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 })
    renameSync(tmp, path)
  } catch {}
}

// Rotating the token changes the key, orphaning the old file. Sweep records whose
// holder is gone so the directory does not accumulate one per rotation. A live
// lock for any other token verifies and is left alone.
function pruneStaleLocks(keep: string): void {
  try {
    for (const name of readdirSync(LOCK_DIR)) {
      const p = join(LOCK_DIR, name)
      if (p === keep || name.endsWith('.tmp')) continue
      if (!lockHolder(p)) rmSync(p, { force: true })
    }
  } catch {}
}

function otherLiveBridge(): number | undefined {
  try {
    if (!existsSync(PID_FILE)) return undefined
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return undefined
    if (statSync(`/proc/${pid}`).uid !== process.getuid?.()) return undefined
    if (readlinkSync(`/proc/${pid}/cwd`) !== process.cwd()) return undefined
    if (readFileSync(`/proc/${pid}/comm`, 'utf8').trim() !== 'bun') return undefined
    return pid
  } catch {
    return undefined   // unreadable is unprovable, and unprovable is not a holder
  }
}

// Set by main(). Lets the /restart command trigger the same graceful drain the
// signal handlers use, without main()'s locals leaking out.
let requestDrain: ((why: string) => Promise<void>) | undefined

// A RUN, as a thing with a name — not just "the child process of this topic".
//
// activeRuns used to be Map<topicKey, ChildProcess>: exactly one run per topic,
// addressable only by the topic it lived in. That single shape is why several
// separate items in FEEDBACK.md were all blocked — you cannot background a task
// when the queue key IS the topic, cannot interrupt a specific run when there is
// no handle on one, and cannot list what is running when a run is not an entity.
//
// pgid is stored because the child is spawned in its own process group (see the
// spawn call): signalling the GROUP is what actually stops the work. Verified: a
// SIGKILL to the claude process alone leaves every grandchild running — the
// python3 job it started keeps going, invisibly, forever.
type RunOutcome = 'discard' | 'keep'
type Job = {
  id: string
  key: string
  threadId?: number
  prompt: string
  // The message that asked for this work. Everything the bridge later says ABOUT
  // this job — the interrupt acknowledgement, the cancellation notice, its files —
  // quotes it, because by then those messages are far from what caused them.
  askedBy?: number
  child: ChildProcess
  pgid: number
  startedAt: number
  outcome?: RunOutcome     // set when a human ends it early
  statusMsgId?: number
  steps: () => number
}
const jobs = new Map<string, Job>()
const jobsFor = (key: string) => [...jobs.values()].filter(j => j.key === key)
// Short, because callback_data caps at 64 bytes and the id has to fit in a button.
const newJobId = () => randomUUID().replace(/-/g, '').slice(0, 8)

// Signal a run's whole process group, falling back to the bare child if the group
// is gone. NEVER call this on a child spawned without `detached`: such a child
// shares the BRIDGE's process group, and a group signal would take the bridge down
// with it — verified while designing this.
function signalJob(job: Job, sig: NodeJS.Signals): boolean {
  // pgid<=0 means the child never got a pid (spawn failed) — process.kill(-0) would
  // signal the bridge's OWN process group and take the bridge down. Signal the
  // child directly instead (it likely never started, so this is usually a no-op).
  if (job.pgid > 0) { try { process.kill(-job.pgid, sig); return true } catch {} }
  try { job.child.kill(sig); return true } catch {}
  return false
}

// Members of a run's process group that are still alive. After the run ends these
// are, by construction, processes it left behind — no command-line guessing.
function groupSurvivors(pgid: number): number[] {
  const out: number[] = []
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
        const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        if (Number(after[2]) === pgid) out.push(Number(name))
      } catch {}
    }
  } catch {}
  return out.filter(p => p !== pgid)
}

// End a run early. `keep` stops it but delivers whatever it already produced;
// `discard` throws the turn away. Escalates politely — SIGINT lets the CLI flush
// its transcript, and only an unresponsive run earns SIGKILL.
async function endJob(job: Job, outcome: RunOutcome): Promise<void> {
  job.outcome = outcome
  signalJob(job, 'SIGINT')
  for (const [wait, sig] of [[3000, 'SIGTERM'], [2000, 'SIGKILL']] as const) {
    await new Promise(r => setTimeout(r, wait))
    if (!jobs.has(job.id)) return
    signalJob(job, sig)
  }
}

// pgid -> the job that owned it, for runs that ended while something they started
// is still alive. This is the only reliable way to see work that outlived a turn:
// a `nohup`ed collector returns instantly, so the step list moves on while the real
// work keeps going invisibly on the box.
const leftBehind = new Map<number, { id: string; key: string; at: number }>()

// Messages that were offered "run this now" and are still waiting their turn, and
// those that took the offer (whose queued turn must therefore do nothing).
const offered = new Map<number, { key: string; threadId?: number; prompt: string; offerMsgId?: number }>()
const skipQueued = new Set<number>()

// What a background job found, held until the topic's next ordinary turn.
//
// A forked job has its own session id — deliberately, since sharing the topic's
// would corrupt its ordering — and that id is never persisted, so the topic's own
// conversation never learns the job happened. Without this the user gets an answer
// in Telegram while the next turn in that topic has no idea it exists.
const bgNotes: Record<string, string[]> = {}
// Files uploaded with no caption, waiting to be mentioned to the model. A caption
// starts a turn and tells it there and then; without one nothing runs, so the file
// would otherwise sit on disk unmentioned until the user typed its path themselves.
const pendingFiles: Record<string, { abs: string; rel: string }[]> = {}
const noteBgResult = (key: string, text: string) => {
  (bgNotes[key] ??= []).push(text.length > 600 ? `${text.slice(0, 600)}…` : text)
  if (bgNotes[key].length > 3) bgNotes[key].shift()
}

// ---------------------------------------------------------------------------
// fan-out
// ---------------------------------------------------------------------------
//
// One request, split into parts that run at once, each in its own forum topic so it
// can be STEERED mid-flight — that is the whole reason children get topics rather
// than being N background jobs in one place. A topic is already bound to a session
// and a directory, so talking to a child needs no new machinery: you type in its
// topic and you are talking to that part.
//
// Parts that edit files get a git worktree each, because parallel agents in one
// checkout trample each other's edits and git state. Read-only parts share the
// parent directory, which is safe and avoids the setup cost for the common case.
const FANOUT_MAX = Number(process.env.TG_FANOUT_MAX || 6)
// Concurrency IS capped here, unlike /bg. The difference is who chooses the number:
// a /bg job is one deliberate act by a person, while a fan-out's width is proposed
// by a model, and eight live children is roughly 2.4 GB on a box with 7.9 GB and no
// swap. Batching is stated in the proposal rather than applied silently.
const FANOUT_CONCURRENCY = Number(process.env.TG_FANOUT_CONCURRENCY || 3)
// 🧪, from Telegram's approved topic-icon set. Only ids from that set are accepted,
// which is also why there is no leaf here: the set has no plant of any kind.
const FANOUT_TOPIC_ICON = process.env.TG_FANOUT_TOPIC_ICON || '5411138633765757782'

type FanoutChild = FanoutPlanItem & {
  topicId?: number
  key?: string
  jobKey?: string
  worktree?: string
  branch?: string
  result?: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'stopped'
}
type Fanout = {
  id: string
  badge: string
  parentKey: string
  parentThreadId?: number
  chatId: number
  askedBy?: number
  task: string
  children: FanoutChild[]
  // The one message listing every part, kept so it can be re-rendered as the parts
  // get their topics rather than frozen at the moment it was first sent.
  listMsgId?: number
  synthesised: boolean
}
const fanouts = new Map<string, Fanout>()
// child topic key -> the fan-out it belongs to, so a child finishing can find home.
const childOf = new Map<string, { fanoutId: string; n: number }>()

const stopped = new Set<string>()
// How many tasks are queued or running per topic, and the id of the most recent
// message the user sent there. Both feed needsReplyLink(): an answer only needs to
// quote its question when it could belong to more than one of them.
const inFlight: Record<string, number> = {}
const latestIncoming: Record<string, number> = {}
// Answers delivered per topic, and the value that counter held when each pending
// question arrived. The difference is "how many other answers landed while you
// waited", which is what tells a reader whether an answer can be placed on sight.
// Counted per TURN, not per message: a promoted mid-turn block and its reply both
// answer the same question, so they must not make each other look ambiguous.
const answerSeq: Record<string, number> = {}
const askSeq = new Map<number, number>()
// Any message the bridge posts pushes the reader further from the question they
// asked. Answers were counted; command replies, job acknowledgements and file
// deliveries were not — so a /interrupt and its reply could sit between a question
// and its answer while the answer still believed it was adjacent to the question.
// The transient status message is excluded: it is deleted (or becomes the run
// record) and never separates anything for long.
const noteBotMessage = (key: string) => { answerSeq[key] = (answerSeq[key] ?? 0) + 1 }

const noteAsk = (key: string, msgId?: number) => {
  if (msgId === undefined) return
  latestIncoming[key] = msgId
  askSeq.set(msgId, answerSeq[key] ?? 0)
  // The map only ever holds questions still awaiting an answer; consumed entries
  // are deleted at delivery. This is the backstop for anything that never gets one.
  if (askSeq.size > 200) askSeq.delete(askSeq.keys().next().value as number)
}

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  inFlight[key] = (inFlight[key] ?? 0) + 1
  const next = prev.catch(() => {}).then(task).finally(() => {
    inFlight[key] = Math.max(0, (inFlight[key] ?? 1) - 1)
  })
  queues.set(key, next.catch(() => {}))
  return next
}

// ---------------------------------------------------------------------------
// Run the Claude Code CLI for one prompt against a topic's session.
// ---------------------------------------------------------------------------

interface ClaudeResult { text: string; sessionId?: string; isError: boolean; noAnswer?: boolean; blocks?: string[] }

// The permission postures the bridge offers, in ascending autonomy. `auto` routes
// each tool call through Claude's classifier (blocks the irreversible/destructive
// ones, no prompting) — configure what it trusts via `autoMode` in
// ~/.claude/settings.json. `plan` researches and proposes without touching files.
// `bypass` (= --dangerously-skip-permissions) removes the last guardrail on a bot
// that runs as root, so it is opt-in: without TG_ALLOW_BYPASS=1 it is neither
// offered as a button nor accepted as an argument.
const ALLOW_BYPASS = /^(1|true|yes)$/i.test(process.env.TG_ALLOW_BYPASS || '')
const MODES: readonly string[] = allowedModes(ALLOW_BYPASS)
// Thin wrappers over ./lib that bind this process's config. MODE_HELP, MODEL_ALIASES,
// MODEL_DEFAULT and normalizeModel are imported directly (no config dependency).
const normalizeMode = (m: string) => libNormalizeMode(m, { allowBypass: ALLOW_BYPASS })
const permissionArgs = (mode: string) => libPermissionArgs(mode, { allowBypass: ALLOW_BYPASS, allowedTools: ALLOWED_TOOLS })

// Env for the claude subprocess: strip TELEGRAM_*/TG_* so the Claude Code
// process (and any installed telegram channel plugin) can't grab our bot token
// and start a competing getUpdates poll on it (causes 409 and kills the bridge).
function childEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(e)) if (k.startsWith('TELEGRAM_') || k.startsWith('TG_')) delete e[k]
  return e
}

// childEnv() scrubs every TG_ var (so the bot token never reaches a subprocess),
// but the voice helpers legitimately need a few of them — the Piper voice path,
// the whisper model/lang. Re-add just those for stt.py / tts.sh.
function voiceEnv(): NodeJS.ProcessEnv {
  const e = childEnv()
  for (const k of ['TG_TTS_ENGINE', 'TG_KOKORO_VOICE', 'TG_KOKORO_MODEL', 'TG_KOKORO_VOICES', 'TG_KOKORO_SPEED', 'TG_KOKORO_LANG',
                   'TG_PIPER_VOICE', 'TG_PIPER_BIN', 'TG_ESPEAK_VOICE', 'TG_ESPEAK_WPM', 'TG_STT_MODEL', 'TG_STT_LANG']) {
    if (process.env[k]) e[k] = process.env[k]
  }
  return e
}

// toolStep, the Step type and both status renderers live in ./lib. renderSteps and
// renderStepsHtml there take progressDetail as a parameter; bind this process's
// PROGRESS_DETAIL here.
const renderSteps = (steps: Step[], total: number, headline?: string, note?: string) => libRenderSteps(steps, total, { progressDetail: PROGRESS_DETAIL, headline, note })
const renderStepsHtml = (steps: Step[]) => libRenderStepsHtml(steps, { progressDetail: PROGRESS_DETAIL })

// Run a prompt with streaming output, editing a single "status" message in the
// topic to show live tool-step progress, then return the final result.
// onInit fires as soon as the CLI announces its session id, before the turn
// finishes. Opt-in per caller and NOT done unconditionally here, because
// handlePassthrough must never bind a topic to the throwaway session that /usage
// and friends mint — see the note on that function.
// The tail parameters became an options object once there were five of them; a
// twelfth positional argument is how call sites start passing things in the wrong
// order silently.
type RunOpts = {
  onInit?: (sessionId: string) => void
  effort?: string
  askedBy?: number
  // Fork the resumed session instead of continuing it, so this run gets its own
  // session id and cannot interleave with the topic's own conversation. Required
  // for anything running in parallel with the topic.
  fork?: boolean
  queueKey?: string
}
async function runStreaming(ctx: Context, threadId: number | undefined, key: string, prompt: string, cwd: string, resumeId?: string, mode: string = PERMISSION_MODE, model: string = MODEL, ro: RunOpts = {}): Promise<ClaudeResult> {
  const { onInit, effort = EFFORT_TIER, askedBy, fork } = ro
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...permissionArgs(mode)]
  if (TELEGRAM_PROFILE.trim()) args.push('--append-system-prompt', TELEGRAM_PROFILE)
  if (resumeId) args.push('--resume', resumeId)
  if (model) args.push('--model', model)
  if (effort) args.push('--effort', effort)
  if (fork && resumeId) args.push('--fork-session')

  const opts: any = threadId ? { message_thread_id: threadId } : {}
  // Minted before the status message so its keyboard can name this run from the
  // start. If the spawn below fails the id never registers, and a tap on it is told
  // the task has already finished — which is true.
  const jobId = newJobId()
  const interruptKb = { inline_keyboard: [[{ text: INTERRUPT_LABEL, callback_data: `int:${jobId}` }]] }
  // Status is machine chatter, not an answer — post and edit it silently so only
  // the real reply buzzes the user's phone.
  const status = await ctx.api.sendMessage(ctx.chat!.id, THINKING,
    { ...opts, disable_notification: true, reply_markup: interruptKb }).catch(() => null)
  if (status) { pending.push({ chat: ctx.chat!.id, id: status.message_id }); saveState() }
  const steps: Step[] = []
  let lastEdit = 0, dirty = false
  // Reset by every stream event; drives both the staleness note and the watchdog.
  let lastEventAt = Date.now()
  // Set once the child is spawned; the status renderer uses it to offer Interrupt.
  let runningJob: Job | undefined
  const editStatus = async (force = false) => {
    if (!status || (!dirty && !force)) return
    const now = Date.now()
    if (!force && now - lastEdit < 4000) return
    lastEdit = now; dirty = false
    if (!steps.length) {
      await ctx.api.editMessageText(ctx.chat!.id, status.message_id, THINKING).catch(() => {})
      return
    }
    // Trim from the oldest until the body fits: slicing a rendered string mid-tag
    // would break the parse and lose the whole update. The summary still counts
    // every step, so trimming never misreports how much work was done.
    let shown = steps.slice(-12)
    const note = stalenessNote(Date.now() - lastEventAt, { quietMs: QUIET_NOTE_MS })
    let body = renderSteps(shown, steps.length, undefined, note)
    // Keyed by JOB id, never by topic. The status message is KEPT after a run that
    // produced mid-turn text, so a topic-scoped button would sit on an old record
    // and end whatever is running today. A tap on a finished job is told so.
    const markup = interruptKb
    while (body.length > 15000 && shown.length > 1) { shown = shown.slice(1); body = renderSteps(shown, steps.length, undefined, note) }
    try {
      // reply_markup has to ride on EVERY edit: an edit without it drops the
      // keyboard. Verified against the API that a rich message keeps its keyboard
      // across editMessageText.
      await ctx.api.raw.editMessageText({ chat_id: ctx.chat!.id, message_id: status.message_id, rich_message: { markdown: body }, ...(markup ? { reply_markup: markup } : {}) })
    } catch {
      // Same posture as sendRich: formatting is best-effort, the update is not.
      try {
        await ctx.api.editMessageText(ctx.chat!.id, status.message_id, renderStepsHtml(shown), { parse_mode: 'HTML', reply_markup: markup })
      } catch {
        const plain = [THINKING, ...shown.map(s => s.label)].join('\n').slice(0, 3500)
        await ctx.api.editMessageText(ctx.chat!.id, status.message_id, plain).catch(() => {})
      }
    }
  }
  const ticker = setInterval(() => void editStatus(), 4000)

  return await new Promise<ClaudeResult>(resolve => {
    let buf = '', err = '', finalText = '', sessionId: string | undefined, isError = false, got = false
    const textBlocks: string[] = []
    console.log(`[claude] stream in ${cwd}${resumeId ? ` (resume ${resumeId.slice(0, 8)})` : ' (new)'}`)
    // stdin = 'ignore' (/dev/null) so claude gets immediate EOF instead of waiting
    // for piped input (it otherwise warns "no stdin data received in 3s" and can
    // return without a parseable result).
    // detached: the child leads its OWN process group, so signalling that group
    // stops the whole tree it built. Without it the child sits in the bridge's
    // group — where a group signal would kill the bridge — and killing the child
    // alone orphans every grandchild it spawned.
    const child = spawn(CLAUDE_BIN, args, { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const job: Job = {
      id: jobId, key, threadId, prompt, child, pgid: child.pid ?? 0, askedBy,
      startedAt: Date.now(), statusMsgId: status?.message_id, steps: () => steps.length,
    }
    jobs.set(job.id, job)
    runningJob = job
    const timer = setTimeout(() => child.kill('SIGKILL'), CLAUDE_TIMEOUT_MS)
    // Keyed on stream events, not wall-clock: a long turn emits them steadily even
    // when each step takes minutes, while a hung child emits nothing at all.
    let stalled = false
    const idleTimer = setInterval(() => {
      if (Date.now() - lastEventAt < IDLE_TIMEOUT_MS) return
      stalled = true
      console.error(`[warn] no stream activity for ${Math.round((Date.now() - lastEventAt) / 1000)}s — killing a stalled run in ${cwd}`)
      child.kill('SIGKILL')
    // Poll relative to the window rather than at a fixed 10s: a short idle timeout
    // (as tests use) would otherwise never be checked before the deadline.
    }, Math.max(250, Math.min(10_000, Math.floor(IDLE_TIMEOUT_MS / 4))))
    child.stderr.on('data', d => (err += d))
    child.stdout.on('data', d => {
      buf += d
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        // Classification lives in ./lib (parseStreamLine); the side effects stay here.
        for (const ev of parseStreamLine(line, { progressDetail: PROGRESS_DETAIL })) {
          lastEventAt = Date.now()
          if (ev.kind === 'step') { steps.push(ev.step); dirty = true }
          else if (ev.kind === 'text') {
            // Keep every block for the promotion decision, and show it in the
            // progress message so it is never merely gone.
            textBlocks.push(ev.text)
            steps.push({ label: '💬 Said', detail: ev.text }); dirty = true; void editStatus()
          }
          else if (ev.kind === 'result') { got = true; sessionId = ev.sessionId; isError = ev.isError; finalText = ev.text }
          else if (ev.kind === 'init') {
            if (ev.model || ev.cliVersion) {
              const prev = sessions[key]?.lastModel
              sessions[key] = { ...(sessions[key] ?? { cwd }), lastModel: ev.model ?? sessions[key]?.lastModel, lastCliVersion: ev.cliVersion ?? sessions[key]?.lastCliVersion }
              saveState()
              // A change here is exactly the "did my upgrade take effect?" signal.
              if (prev && ev.model && prev !== ev.model) console.log(`[model] ${key}: ${prev} -> ${ev.model}`)
            }
            if (!sessionId) { sessionId = ev.sessionId; try { onInit?.(ev.sessionId) } catch {} }
          }
        }
      }
      void editStatus()
    })
    const finish = async (res: ClaudeResult) => {
      clearTimeout(timer); clearInterval(ticker); clearInterval(idleTimer)
      jobs.delete(job.id)
      // Anything still in this run's group outlived it. Record it so /jobs can say
      // so; a `setsid` escapee will not be here, which is why /jobs presents this
      // as what it is — what we can prove, not everything that might exist.
      const left = groupSurvivors(job.pgid)
      if (left.length) {
        leftBehind.set(job.pgid, { id: job.id, key, at: Date.now() })
        console.log(`[job ${job.id}] left ${left.length} process(es) running: ${left.slice(0, 8).join(', ')}`)
      }
      if (status) {
        pending = pending.filter(p => !(p.chat === ctx.chat!.id && p.id === status.message_id)); saveState()
        // Keep the progress message as the record of the run when it holds
        // something the reply does not. Deleting it the instant the answer lands
        // is why the reasoning was unavailable BOTH during and after a run — on a
        // phone the user is usually not watching in real time.
        const carriesMore = textBlocks.length > 1 || (textBlocks.length === 1 && !res.text.includes(textBlocks[0]))
        const keep = PROGRESS_KEEP === 'keep' || (PROGRESS_KEEP !== 'off' && carriesMore)
        // Whatever happens next, the run is over: the Interrupt button must go, or
        // a retained record keeps a dead control on it.
        await ctx.api.editMessageReplyMarkup(ctx.chat!.id, status.message_id).catch(() => {})
        if (keep && steps.length) {
          const body = renderSteps(steps.slice(-12), steps.length, RUN_RECORD)
          await ctx.api.raw.editMessageText({ chat_id: ctx.chat!.id, message_id: status.message_id, rich_message: { markdown: body } })
            .catch(async () => { await ctx.api.editMessageText(ctx.chat!.id, status.message_id, renderStepsHtml(steps.slice(-12)), { parse_mode: 'HTML' }).catch(() => {}) })
        } else {
          await ctx.api.deleteMessage(ctx.chat!.id, status.message_id).catch(() => {})
        }
      }
      resolve(res)
    }
    child.on('error', e => void finish({ text: `Failed to launch ${CLAUDE_BIN}: ${e}`, isError: true }))
    child.on('close', code => {
      console.log(`[claude] done (exit ${code}, ${steps.length} steps)`)
      // Ended early by a human: `keep` delivers what the turn already produced.
      // Before mid-turn text was collected there was nothing to keep and stopping
      // could only discard; now the expensive part is already in hand.
      if (job.outcome === 'keep') {
        // Deliberately NOT gated on `got`. Interrupting a blocked tool call makes
        // the CLI emit an error result on its way out, so `got` is true and the
        // normal path would deliver "(claude error)" — which is what a Tier 3 run
        // against the real CLI actually produced. A human ending a run early is not
        // an error, and what they asked for is whatever it had.
        const partial = textBlocks.join('\n\n').trim()
        void finish({
          text: partial || (got && !isError ? finalText : '') || '⏹ Interrupted before it produced anything.',
          sessionId, isError: false, blocks: textBlocks,
        })
        return
      }
      if (got) {
        // A turn that produced no answer is a failed turn, not a reply. Both the
        // empty result and the CLI queue layer's "No response requested." land
        // here; delivering either verbatim is what made questions look ignored.
        const noAnswer = !isError && isNonAnswer(finalText)
        if (noAnswer) console.error(`[warn] no answer for ${key}: ${JSON.stringify(finalText.slice(0, 60))}`)
        void finish({ text: finalText || (isError ? '(claude error)' : ''), sessionId, isError, noAnswer, blocks: textBlocks })
      }
      else if (stalled) void finish({
        text: `⚠️ The run stalled — nothing came back for ${Math.round(IDLE_TIMEOUT_MS / 60000)} minutes, so I stopped it. Nothing was delivered. Try again, or send /stop if it happens repeatedly.`,
        isError: true,
      })
      else void finish({ text: `Could not parse Claude output.\n\n${(err || `exit ${code}`).slice(-1500)}`, isError: true })
    })
  })
}

// ---------------------------------------------------------------------------
// Telegram I/O
// ---------------------------------------------------------------------------

const MAX = 4000
// A rich message holds far more than a plain one (32768 chars, 500 blocks), so it
// is chunked much less often — which matters because a split mid-table would cut
// the table in half.
const RICH_MAX = 30000
// Split into <=max-char messages WITHOUT breaking a code block: if a ``` fence is
// still open at a chunk boundary, close it here and reopen it in the next chunk,
// so telegramify never sees an unbalanced fence (the main cause of broken renders).
function chunk(text: string, max = MAX): string[] {
  const chunks: string[] = []
  let cur: string[] = []
  let len = 0
  let inFence = false
  const push = () => { chunks.push(cur.join('\n') + (inFence ? '\n```' : '')); cur = inFence ? ['```'] : []; len = inFence ? 4 : 0 }
  for (const raw of text.split('\n')) {
    const pieces = raw.length > max ? (raw.match(new RegExp(`.{1,${max}}`, 'g')) || [raw]) : [raw]
    for (const line of pieces) {
      if (len + line.length + 1 > max && cur.length) push()
      if (/^\s*```/.test(line)) inFence = !inFence
      cur.push(line); len += line.length + 1
    }
  }
  if (cur.length) chunks.push(cur.join('\n') + (inFence ? '\n```' : ''))
  return chunks
}

// Strip markdown markers to clean readable text — the fallback when Telegram
// rejects the MarkdownV2, so a failed parse never shows raw ** or backticks.
function stripMd(s: string): string {
  return s
    .replace(/```[^\n]*\n?/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
}
// quiet=true sends without a notification — for status, acks and other bookkeeping
// the user doesn't need buzzed about. Answers and warnings stay loud.
// Where a message goes, and what it is answering. Every reply used to be a loose
// message in the thread — the bridge never set reply_parameters anywhere — which
// was tolerable while runs were strictly serialised and one message produced one
// answer. It is not any more: a turn can now deliver a promoted mid-turn block AND
// its reply, /restart and the retry button post asynchronously, and interrupt mode
// already lets an answer arrive after a newer message. Threading makes the topic
// self-documenting: tap any answer to jump to the question.
//
// allow_sending_without_reply matters — if the user deleted the message we are
// answering, the send would otherwise fail outright and the answer would be lost
// to protect a cosmetic link.
type Dest = { threadId?: number; replyTo?: number }
function destOpts(d: Dest): any {
  return {
    ...(d.threadId ? { message_thread_id: d.threadId } : {}),
    ...(d.replyTo ? { reply_parameters: { message_id: d.replyTo, allow_sending_without_reply: true } } : {}),
  }
}

async function send(ctx: Context, threadId: number | undefined, text: string, quiet = false, replyTo?: number): Promise<void> {
  noteBotMessage(keyFor(ctx.chat!.id, threadId))
  const opts: any = destOpts({ threadId, replyTo })
  if (quiet) opts.disable_notification = true
  for (const part of chunk(text)) {
    await ctx.api.sendMessage(ctx.chat!.id, part, opts).catch(e => console.error(`[warn] sendMessage: ${e}`))
  }
}

// Telegram has no tables — convert each markdown table into an aligned monospace
// code block so columns line up. The agent writes normal markdown; the bridge
// encodes it for Telegram.
function mdTablesToCode(text: string): string {
  const lines = text.split('\n')
  // Same rule as the table detector above: the delimiter row must carry a pipe, or
  // a "---" setext underline turns the prose above it into a code block.
  const isSep = (l: string) => l.includes('|') && /^[ \t:|-]*-[ \t:|-]*$/.test(l)
  const cells = (l: string) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim())
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].includes('|') && i + 1 < lines.length && isSep(lines[i + 1])) {
      const rows: string[][] = [cells(lines[i])]
      let j = i + 2
      while (j < lines.length && lines[j].includes('|') && lines[j].trim()) { rows.push(cells(lines[j])); j++ }
      const ncol = Math.max(...rows.map(r => r.length))
      const w = new Array(ncol).fill(0)
      for (const r of rows) for (let c = 0; c < ncol; c++) w[c] = Math.max(w[c], (r[c] || '').length)
      const body = rows.map(r => Array.from({ length: ncol }, (_, c) => (r[c] || '').padEnd(w[c])).join('  ').trimEnd()).join('\n')
      out.push('```\n' + body + '\n```')
      i = j
    } else { out.push(lines[i]); i++ }
  }
  return out.join('\n')
}

// The MarkdownV2 path. This is the DEFAULT for ordinary prose, not a fallback —
// see the note on needsRich. Tables have no MarkdownV2 equivalent, so they are
// flattened to aligned code blocks first, and a chunk Telegram still refuses to
// parse is resent as plain text.
async function sendLegacyMd(ctx: Context, opts: any, text: string): Promise<void> {
  // sanitizeProse runs AFTER mdTablesToCode so a flattened table is already inside
  // a fence and counts as protected code, and BEFORE telegramify, which is the
  // thing that mis-handles a lone tilde.
  for (const part of chunk(mdTablesToCode(text))) {
    try {
      await ctx.api.sendMessage(ctx.chat!.id, telegramify(sanitizeProse(part, 'markdownv2'), 'escape'), { ...opts, parse_mode: 'MarkdownV2' })
    } catch {
      await ctx.api.sendMessage(ctx.chat!.id, stripMd(part), opts).catch(e => console.error(`[warn] sendMessage: ${e}`))
    }
  }
}

// needsRich and hasRtl (the rich-vs-MarkdownV2 routing rules) and sanitizeProse
// (the one escaping stage per dialect) are pure, so they live in ./lib and are
// unit-tested there. The long note on WHY rich is rationed is on needsRich, and the
// character table is on PROSE_RULES.

// Send Claude's answer, as a Bot API 10.1 rich message when the content actually
// needs one. Rich markdown is the dialect the agent already writes, so apart from
// the dollars above no escaping pass is needed. If the call fails we drop to the
// MarkdownV2 path — formatting is best-effort, delivery is guaranteed.
async function sendRich(ctx: Context, threadId: number | undefined, text: string, replyTo?: number): Promise<void> {
  noteBotMessage(keyFor(ctx.chat!.id, threadId))
  const opts: any = destOpts({ threadId, replyTo })
  for (const part of chunk(text, RICH_MAX)) {
    if (!needsRich(part) || hasRtl(part)) { await sendLegacyMd(ctx, opts, part); continue }
    try {
      await ctx.api.sendRichMessage(ctx.chat!.id, { markdown: sanitizeProse(part, 'rich') }, opts)
    } catch (e) {
      console.error(`[warn] sendRichMessage, falling back to MarkdownV2: ${e}`)
      await sendLegacyMd(ctx, opts, part)
    }
  }
}
function startTyping(ctx: Context, threadId: number | undefined): () => void {
  const opts = threadId ? { message_thread_id: threadId } : {}
  const ping = () => ctx.api.sendChatAction(ctx.chat!.id, 'typing', opts).catch(() => {})
  ping(); const id = setInterval(ping, 4500); return () => clearInterval(id)
}

// ---------------------------------------------------------------------------
// Permission-mode UI (/mode + its inline keyboard)
// ---------------------------------------------------------------------------

const MODE_EMOJI: Record<string, string> = { plan: '📋', acceptEdits: '✏️', auto: '🤖', bypass: '⚠️' }

function modeText(key: string): string {
  const cur = modeFor(key)
  const warn = bypassDowngraded(key)
    ? `\n\n⚠️ This topic is set to bypass, but bypass is disabled on this deployment, so it is running as ${cur}. Set TG_ALLOW_BYPASS=1 and restart to restore it.`
    : ''
  // Listed as disabled rather than omitted: a gate you cannot see reads as a
  // missing feature. Kept off the keyboard either way — a mode that removes every
  // guardrail should cost a typed word, not a mis-tap.
  const gated = ALLOW_BYPASS ? '' : `\n⚠️ bypass — disabled here (set TG_ALLOW_BYPASS=1)`
  return `Permission mode for this topic: ${MODE_EMOJI[cur] ?? ''} ${cur}\n${MODE_HELP[cur] ?? ''}${warn}\n\n` +
    MODES.map(m => `${MODE_EMOJI[m]} ${m} — ${MODE_HELP[m]}`).join('\n') + gated +
    `\n\nTap to switch, or /mode <name>.`
}
// One button per row: four side by side get squeezed to unreadable stubs on a
// phone, which is the only screen this bot is used from.
function modeKeyboard(key: string) {
  const cur = modeFor(key)
  return {
    inline_keyboard: MODES.map(m => [{
      text: `${m === cur ? '● ' : ''}${MODE_EMOJI[m]} ${m}`,
      callback_data: `mode:${m}`,
    }]),
  }
}

// Human label for the model currently in effect for a topic.
function modelLabel(key: string): string {
  const m = modelFor(key)
  if (m) return m
  return MODEL ? `${MODEL_DEFAULT} → TG_MODEL (${MODEL})` : `${MODEL_DEFAULT} → system default`
}
// Intent AND reality. The label above is what you asked for; this appends what the
// CLI actually resolved to on the previous run, which is the only way to answer
// "am I on the new Opus?" — an alias tells you nothing after an upgrade.
function modelLine(key: string): string {
  const e = sessions[key]
  if (!e?.lastModel) return modelLabel(key)
  const ver = e.lastCliVersion ? `, CLI ${e.lastCliVersion}` : ''
  return `${modelLabel(key)}  →  ${e.lastModel} (last run${ver})`
}
// What "default" resolves to. When TG_MODEL is set it's that; otherwise the bridge
// passes no --model flag and the CLI uses whatever Claude itself defaults to — the
// model in ~/.claude/settings.json, or the account/plan default.
function defaultExplainer(): string {
  return MODEL
    ? `"${MODEL_DEFAULT}" uses TG_MODEL (${MODEL}).`
    : `"${MODEL_DEFAULT}" runs no --model flag, so Claude uses your system default: the model set in ~/.claude/settings.json, or your account default.`
}
function modelText(key: string): string {
  return `Model for this topic: ${modelLine(key)}\n\n` +
    `${defaultExplainer()}\n\n` +
    `Every model works in any /mode (plan, auto, …). Tap to switch, or /model <alias|full-id>.`
}
function modelKeyboard(key: string) {
  const cur = modelFor(key)
  const rows = MODEL_ALIASES.map(m => [{ text: `${m === cur ? '● ' : ''}${m}`, callback_data: `model:${m}` }])
  rows.push([{ text: `${cur === '' ? '● ' : ''}${MODEL_DEFAULT}`, callback_data: `model:${MODEL_DEFAULT}` }])
  return { inline_keyboard: rows }
}

// Gate on the SENDER's id, never the room.
function isAllowed(ctx: Context): boolean {
  const chat = ctx.chat
  if (!chat) return false
  const userId = String(ctx.from?.id ?? '')
  // Opt-in (TG_TRUST_CHAT_MEMBERS=1): treat membership of an allowlisted GROUP as
  // authorization, so you don't have to enumerate every member. Everyone who can
  // be added to that group can then drive Claude as this bot's user — which is why
  // it is off by default. DMs are never covered: a private chat id is the sender's,
  // so it could only match by being listed in TG_ALLOWED_CHATS explicitly.
  if (TRUST_CHAT_MEMBERS && chat.type !== 'private') return ALLOWED_CHATS.has(String(chat.id))
  if (!ALLOWED_USERS.has(userId)) return false
  if (chat.type === 'private') return true
  return ALLOWED_CHATS.has(String(chat.id))
}

// ---------------------------------------------------------------------------
// Two topics can legitimately point at one directory — that is what /fork is — and
// then `./outbox/` is no longer "this conversation's outbox" but a drop point two
// conversations share. Whoever finishes a run first delivers whatever is in it, so
// the fork's file lands in the parent's topic. Same for `./inbox/`: a file you sent
// to one topic shows up as material in the other.
//
// So a topic that shares its directory gets its own subdirectory inside each, and is
// told about it. A topic with the directory to itself keeps the plain paths — the
// common case should not pay for the rare one.
function topicsSharing(cwd: string, key: string): boolean {
  const target = resolve(cwd)
  for (const [k, e] of Object.entries(sessions)) {
    if (k !== key && e?.cwd && resolve(e.cwd) === target) return true
  }
  return false
}

function boxDir(cwd: string, key: string, box: string): string {
  return topicsSharing(cwd, key) ? join(cwd, box, topicTag(key)) : join(cwd, box)
}

// Files: receive (Telegram -> topic/inbox) and send (topic/outbox -> Telegram).
// ---------------------------------------------------------------------------

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// Strip path components and unsafe chars; keep a sensible name + extension.
function safeName(name: string, fallbackExt = ''): string {
  const base = basename(name || '').normalize('NFKD').replace(/[^\w.\- ]+/g, '_').replace(/^[.\s]+/, '').trim()
  return (base || `file${fallbackExt}`).slice(0, 120)
}

// A path inside dir that doesn't collide (foo.txt -> foo-1.txt -> foo-2.txt …).
function uniquePath(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return join(dir, name)
  const ext = extname(name), stem = name.slice(0, name.length - ext.length)
  for (let i = 1; ; i++) { const p = join(dir, `${stem}-${i}${ext}`); if (!existsSync(p)) return p }
}

// The downloadable attachment on a message, if any (largest size for photos).
function pickAttachment(msg: any): { fileId: string; name: string; size: number } | null {
  const d = msg.document; if (d) return { fileId: d.file_id, name: d.file_name || 'document', size: d.file_size || 0 }
  if (msg.photo?.length) { const p = msg.photo[msg.photo.length - 1]; return { fileId: p.file_id, name: `photo-${p.file_unique_id}.jpg`, size: p.file_size || 0 } }
  const v = msg.video; if (v) return { fileId: v.file_id, name: v.file_name || `video-${v.file_unique_id}.mp4`, size: v.file_size || 0 }
  const a = msg.animation; if (a) return { fileId: a.file_id, name: a.file_name || `animation-${a.file_unique_id}.mp4`, size: a.file_size || 0 }
  const au = msg.audio; if (au) return { fileId: au.file_id, name: au.file_name || `audio-${au.file_unique_id}.mp3`, size: au.file_size || 0 }
  const vo = msg.voice; if (vo) return { fileId: vo.file_id, name: `voice-${vo.file_unique_id}.ogg`, size: vo.file_size || 0 }
  const vn = msg.video_note; if (vn) return { fileId: vn.file_id, name: `videonote-${vn.file_unique_id}.mp4`, size: vn.file_size || 0 }
  return null
}

// Download a Telegram file into a topic's inbox. Returns the saved absolute path.
async function receiveFile(ctx: Context, att: { fileId: string; name: string; size: number }, cwd: string, key: string): Promise<string> {
  if (att.size && att.size > TG_DOWNLOAD_LIMIT)
    throw new Error(
      `file is ${fmtBytes(att.size)}, over the ${fmtBytes(TG_DOWNLOAD_LIMIT)} the cloud Bot API lets bots fetch.\n` +
      `To lift this, run a local Bot API server and set TG_API_ROOT (see README) — or copy the file to ${cwd}/${INBOX_DIR}/ directly.`)
  const file = await ctx.api.getFile(att.fileId)
  if (!file.file_path) throw new Error('Telegram returned no file_path')
  const dest = uniquePath(ensureDir(boxDir(cwd, key, INBOX_DIR)), safeName(att.name, extname(file.file_path)))
  // A local server in --local mode has already written the file to its own disk
  // and hands back an absolute path; there is nothing to download.
  if (LOCAL_API && isAbsolute(file.file_path) && existsSync(file.file_path)) {
    const src = resolve(file.file_path)
    if (src !== LOCAL_API_DATA && !src.startsWith(LOCAL_API_DATA + '/'))
      throw new Error(`refusing to copy ${src}: outside the local Bot API data dir (${LOCAL_API_DATA})`)
    copyFileSync(src, dest)
  } else {
    const base = LOCAL_API ? API_ROOT : 'https://api.telegram.org'
    const res = await fetch(`${base}/file/bot${TOKEN}/${file.file_path}`)
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`)
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  }
  console.log(`[file<-] ${dest} (${fmtBytes(statSync(dest).size)})`)
  return dest
}

// Send one file from disk to the chat/topic. Returns true on success.
async function sendFile(ctx: Context, threadId: number | undefined, path: string, caption?: string, replyTo?: number): Promise<boolean> {
  if (!existsSync(path) || !statSync(path).isFile()) { await send(ctx, threadId, `Not a file: ${path}`); return false }
  const size = statSync(path).size
  if (size > TG_UPLOAD_LIMIT) {
    await send(ctx, threadId, `${basename(path)} is ${fmtBytes(size)} — over the ${fmtBytes(TG_UPLOAD_LIMIT)} bot upload limit.` +
      (LOCAL_API ? '' : `\nA local Bot API server raises this to 2000 MB (set TG_API_ROOT — see README).`))
    return false
  }
  noteBotMessage(keyFor(ctx.chat!.id, threadId))
  const opts: any = destOpts({ threadId, replyTo })
  if (caption) opts.caption = caption.slice(0, 1024)
  try {
    await ctx.api.sendDocument(ctx.chat!.id, new InputFile(path, basename(path)), opts)
    console.log(`[file->] ${path} (${fmtBytes(size)})`)
    return true
  } catch (e) { await send(ctx, threadId, `⚠️ could not send ${basename(path)}: ${e}`); return false }
}

// After a run, deliver anything Claude left in the topic's outbox, then archive
// each sent file to outbox/.sent so it isn't delivered twice.
async function flushOutbox(ctx: Context, threadId: number | undefined, cwd: string, key: string, replyTo?: number): Promise<void> {
  // This topic's own outbox first, then the shared root — which is drained too
  // rather than left to strand files, since a model that ignored the note (or a
  // delivery that failed earlier) would otherwise leave them there forever.
  const own = boxDir(cwd, key, OUTBOX_DIR)
  const root = join(cwd, OUTBOX_DIR)
  for (const dir of own === root ? [root] : [own, root]) await drainOutbox(ctx, threadId, dir)
}

async function drainOutbox(ctx: Context, threadId: number | undefined, dir: string): Promise<void> {
  if (!existsSync(dir)) return
  let names: string[]
  try { names = readdirSync(dir) } catch { return }
  const sentDir = join(dir, '.sent')
  for (const n of names) {
    if (n.startsWith('.')) continue
    const p = join(dir, n)
    let st; try { st = statSync(p) } catch { continue }
    // Subdirectories are other topics' outboxes — never this one's to deliver.
    if (!st.isFile()) continue
    // Claim it BEFORE sending: two topics sharing this directory can flush at the
    // same moment, and a rename is the only step of the two that is atomic. The
    // loser gets ENOENT and moves on rather than sending the same file twice.
    const claimed = uniquePath(ensureDir(sentDir), n)
    try { renameSync(p, claimed) } catch { continue }
    if (!await sendFile(ctx, threadId, claimed)) {
      // Put it back, or a failed send silently swallows the file.
      try { renameSync(claimed, p) } catch (e) { console.error(`[warn] restore outbox ${n}: ${e}`) }
    }
  }
}

// One-line note telling Claude how the bridge works: it's a live chat (so it can
// ask clarifying questions) and how files flow in/out.
// Run one prompt against a topic's session, post the reply, deliver the outbox.
// Deliver a Claude answer: inline (markdown) if short, else as an answer.md file
// with a preview caption — so a huge reply isn't a dozen chunked messages.
async function deliver(ctx: Context, threadId: number | undefined, text: string, replyTo?: number): Promise<void> {
  if (REPLY_FILE_CHARS && text.length > REPLY_FILE_CHARS) {
    const dir = mkdtempSync(join(tmpdir(), 'tg-'))
    try {
      // The HTML goes first when both are sent: it is the one the user opens, and
      // the caption preview belongs on the file they will actually read. The .md
      // follows as the source of truth.
      const caption = `${text.slice(0, 900).trimEnd()} …\n\n📄 Full answer (${text.length} chars) attached.`
      let first = true
      if (REPLY_FILE_FORMAT !== 'md') {
        const h = join(dir, 'answer.html')
        writeFileSync(h, htmlDocument('Answer', markdownToHtml(text)))
        await sendFile(ctx, threadId, h, first ? caption : undefined, replyTo)
        first = false
      }
      if (REPLY_FILE_FORMAT !== 'html') {
        const m = join(dir, 'answer.md')
        writeFileSync(m, text)
        await sendFile(ctx, threadId, m, first ? caption : undefined, replyTo)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  } else {
    await sendRich(ctx, threadId, text, replyTo)
  }
}

// ---------------------------------------------------------------------------
// Voice (turn-based): transcribe inbound audio, speak outbound answers.
// ---------------------------------------------------------------------------

// STT_CMD <audio-file> -> transcript on stdout. '' on any failure (logged).
function transcribe(path: string): Promise<string> {
  return new Promise(resolve => {
    const parts = STT_CMD.split(/\s+/)
    const child = spawn(parts[0], [...parts.slice(1), path], { env: voiceEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', e => { console.error(`[voice] stt spawn: ${e}`); resolve('') })
    child.on('close', code => {
      if (!out.trim() && code !== 0) console.error(`[voice] stt exit ${code}: ${err.slice(-300)}`)
      resolve(out.trim())
    })
  })
}

// TTS_CMD <out.ogg>, text on stdin -> the ogg path, or null on failure.
function synthesize(text: string, ogg: string): Promise<string | null> {
  return new Promise(resolve => {
    const child = spawn(TTS_CMD, [ogg], { env: voiceEnv(), stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', d => (err += d))
    child.on('error', e => { console.error(`[voice] tts spawn: ${e}`); resolve(null) })
    child.on('close', code => {
      if (code === 0 && existsSync(ogg)) resolve(ogg)
      else { console.error(`[voice] tts exit ${code}: ${err.slice(-300)}`); resolve(null) }
    })
    child.stdin.write(text); child.stdin.end()
  })
}

// A stateless fast-model pass that turns a full answer into a couple of spoken
// sentences. It never --resumes the topic session, so it can't pollute or rebind
// it, and runs read-only (plan) so it can't touch anything.
function summarizeForSpeech(answer: string): Promise<string> {
  const prompt =
    'Rewrite the following assistant reply as a SHORT spoken summary for text-to-speech: ' +
    '1-3 plain sentences, no markdown, no code, no lists, no URLs or ids read out. Convey the ' +
    'outcome and any decision the user must make. If it is already short, lightly rephrase for the ear.\n\n---\n' +
    answer.slice(0, 6000)
  return new Promise(resolve => {
    const args = ['-p', prompt, '--output-format', 'json', '--model', VOICE_SUMMARY_MODEL, '--permission-mode', 'plan']
    const child = spawn(CLAUDE_BIN, args, { cwd: HERE, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.on('error', () => resolve(''))
    child.on('close', () => { try { resolve(String(JSON.parse(out).result ?? '').trim()) } catch { resolve('') } })
  })
}

// Speak an answer back as a Telegram voice message. Short answers verbatim; long
// ones summarized first so the note stays a few seconds.
async function speakAnswer(ctx: Context, threadId: number | undefined, text: string, mode: 'full' | 'summary'): Promise<void> {
  const clean = stripMd(text).trim()
  if (!clean) return
  // 'summary' → a short spoken summary; 'full' → the whole answer read out (capped
  // by VOICE_SPEAK_MAX so a very long answer doesn't become a multi-minute note —
  // the complete answer is always available as text regardless).
  let speak = mode === 'summary' ? ((await summarizeForSpeech(text)) || clean) : clean
  speak = stripMd(speak).trim().slice(0, VOICE_SPEAK_MAX)
  if (!speak) return
  const dir = mkdtempSync(join(tmpdir(), 'tg-tts-'))
  try {
    const ogg = await synthesize(speak, join(dir, 'reply.ogg'))
    if (ogg) {
      const opts: any = threadId ? { message_thread_id: threadId } : {}
      await ctx.api.sendVoice(ctx.chat!.id, new InputFile(ogg), opts).catch(e => console.error(`[voice] sendVoice: ${e}`))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// Prompts kept so a "no answer" can be retried with one tap. In memory only and
// capped: a retry after a restart is not worth persisting state for, and the
// button says so rather than silently doing nothing.
const retryPrompts = new Map<string, { key: string; threadId?: number; prompt: string; replyTo?: number }>()
const RETRY_MAX = 50

// A turn that came back with nothing is reported as such, with the offer to run it
// again. Deliberately a button rather than an automatic resend: the turn may
// already have edited files or run commands, and repeating those without being
// asked is worse than the missing answer.
async function sendNoAnswer(ctx: Context, threadId: number | undefined, key: string, prompt: string, replyTo?: number): Promise<void> {
  const opts: any = destOpts({ threadId, replyTo })
  const msg = await ctx.api.sendMessage(ctx.chat!.id,
    '⚠️ No answer came back for that message. Nothing was lost — tap to send it again.',
    { ...opts, reply_markup: { inline_keyboard: [[{ text: '🔁 Retry', callback_data: 'retry:pending' }]] } }
  ).catch(() => null)
  if (!msg) return
  if (retryPrompts.size >= RETRY_MAX) retryPrompts.delete(retryPrompts.keys().next().value as string)
  retryPrompts.set(String(msg.message_id), { key, threadId, prompt, replyTo })
  await ctx.api.editMessageReplyMarkup(ctx.chat!.id, msg.message_id, {
    reply_markup: { inline_keyboard: [[{ text: '🔁 Retry', callback_data: `retry:${msg.message_id}` }]] },
  }).catch(() => {})
}

// Create the worktree a write-part runs in. Isolation is the point: without it,
// two parts editing the same checkout corrupt each other's work and git state.
// Returns undefined when the directory is not a git repo, which the caller reports
// rather than silently running the part in the parent directory.
function isGitRepo(dir: string): boolean {
  try { execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { stdio: 'ignore' }); return true } catch { return false }
}

function makeWorktree(baseDir: string, fanoutId: string, n: number): { path: string; branch: string } | undefined {
  if (!isGitRepo(baseDir)) return undefined
  const branch = `fanout/${fanoutId}-${n}`
  const path = join(baseDir, '.fanout', `${fanoutId}-${n}`)
  try {
    mkdirSync(dirname(path), { recursive: true })
    execFileSync('git', ['-C', baseDir, 'worktree', 'add', '-b', branch, path], { stdio: 'ignore' })
    return { path, branch }
  } catch (e) {
    console.error(`[fanout] worktree for part ${n} failed: ${e}`)
    return undefined
  }
}

// Start whichever parts are next, up to the concurrency cap.
async function pumpFanout(ctx: Context, f: Fanout): Promise<void> {
  const running = f.children.filter(c => c.status === 'running').length
  let slots = Math.max(0, FANOUT_CONCURRENCY - running)
  for (const child of f.children) {
    if (slots <= 0) break
    if (child.status !== 'pending') continue
    slots--
    child.status = 'running'
    void startFanoutChild(ctx, f, child).catch(e => {
      console.error(`[fanout ${f.id}] part ${child.n} failed to start: ${e}`)
      child.status = 'failed'
      void maybeSynthesise(ctx, f)
    })
  }
}

// Give a part its own topic, its own directory if it writes, and set it running.
async function startFanoutChild(ctx: Context, f: Fanout, child: FanoutChild): Promise<void> {
  const parentCwd = sessions[f.parentKey]?.cwd ?? resolveCwd(ctx, f.parentThreadId)
  let cwd = parentCwd
  if (child.mode === 'write') {
    // A worktree where there is a repo to make one from, and otherwise nothing —
    // the part still runs, and still writes, in the shared directory. Downgrading it
    // to read-only meant a directory that is not a repo could not use fan-out for
    // the thing fan-out is for, and the warning explained a refusal nobody asked
    // for. Isolation is a nicety here; doing the work is the point.
    const wt = makeWorktree(parentCwd, f.id, child.n)
    if (wt) { cwd = wt.path; child.worktree = wt.path; child.branch = wt.branch }
  }

  // A topic per part is what makes steering possible: type in it and you are
  // talking to that part's own session.
  let topicId: number | undefined
  try {
    // A custom emoji from Telegram's OWN approved set (getForumTopicIconStickers),
    // deliberately not the deployment's usual topic icon: in a group with other work
    // going on, fan-out parts have to be tellable apart at a glance. It has to be
    // one of those ids — an arbitrary emoji is rejected — and it is create-time only,
    // since editForumTopic cannot change it afterwards.
    const t = await ctx.api.createForumTopic(f.chatId, fanoutTopicName(child.title),
      { icon_custom_emoji_id: FANOUT_TOPIC_ICON })
    topicId = t.message_thread_id
  } catch (e) {
    console.error(`[fanout ${f.id}] could not create a topic for part ${child.n}: ${e}`)
  }
  // If the topic could not be created, the parts must still be kept apart. Falling
  // back to keyFor(chat, undefined) would give every part the PARENT's key: they
  // would share one session, overwrite each other's bookkeeping, and the last one
  // to finish would be the only result. A synthetic key keeps their sessions and
  // directories distinct; only the delivery lands in the parent topic.
  const key = topicId !== undefined ? keyFor(f.chatId, topicId) : `${f.parentKey}#part-${f.id}-${child.n}`
  child.topicId = topicId
  child.key = key
  void refreshFanoutParts(ctx, f)
  sessions[key] = { ...(sessions[key] ?? {}), cwd }
  saveState()
  childOf.set(key, { fanoutId: f.id, n: child.n })

  const brief = [
    `You are one part of a task that was split up and is being worked in parallel.`,
    `Your part only — do not attempt the others, and do not wait for them.`,
    child.mode === 'write' && child.worktree
      ? `You are in your own git worktree on branch ${child.branch}; edit freely here.`
      : child.mode === 'write'
        // No repo, so no worktree, so no isolation: the other parts are writing in
        // this same directory. It has to know that, or two parts will edit one file
        // and the last write wins silently.
        ? `Edit freely, but this directory is NOT isolated — the other parts are working in it too. Touch only the files your part needs, and do not reorganise anything shared.`
        : `Treat this as read-only: investigate and report, do not edit files.`,
    ``,
    `The overall request was: ${f.task}`,
    ``,
    `Your part: ${child.brief}`,
    ``,
    `Finish with a self-contained summary of what you found or did. It will be read`,
    `on its own, alongside the other parts, by a final step that writes the answer.`,
  ].join('\n')

  // Issued before the part's turn so it heads the topic, but deliberately NOT
  // awaited before it: awaiting here yields to the event loop, and a message typed
  // into the topic in that gap landed in the queue AHEAD of the part's own work.
  // The part then ran second and overwrote the correction with its original task.
  const intro = send(ctx, topicId, `${FANOUT_MARK} Part ${child.n} of ${f.children.length} — ${child.title}\n\nTalk here to steer this part.`, true)

  // The part's own turn goes in the TOPIC's queue, not a private one of its own.
  // With a separate queue, a message typed in the topic ran CONCURRENTLY with the
  // part — two turns against one session, and the later one to finish won, which is
  // how a correction could vanish. Sharing the queue makes a correction what it
  // looks like: the next turn.
  child.jobKey = key
  void enqueue(key, () => handlePrompt(ctx, topicId, key, brief, undefined, undefined, false, true))
    .then(() => finishFanoutChild(ctx, f, child))
    .catch(e => { console.error(`[fanout ${f.id}] part ${child.n}: ${e}`); child.status = 'failed'; void maybeSynthesise(ctx, f) })
  await intro
}

// A part is done when its job chain settles; its result was captured on the way out.
async function finishFanoutChild(ctx: Context, f: Fanout, child: FanoutChild): Promise<void> {
  if (child.status === 'running') child.status = child.result ? 'done' : 'failed'
  await pumpFanout(ctx, f)
  await maybeSynthesise(ctx, f)
}

// One message listing every part, rather than one message per part. N separate
// announcements bury the topic they are posted in, which is the topic you are
// trying to keep usable.
async function announceFanoutParts(ctx: Context, f: Fanout): Promise<void> {
  const m = await ctx.api.sendMessage(f.chatId,
    telegramify(sanitizeProse(renderFanoutParts(f), 'markdownv2'), 'escape'), {
      ...destOpts({ threadId: f.parentThreadId, replyTo: f.askedBy }),
      parse_mode: 'MarkdownV2', disable_notification: true,
    }).catch(() => null)
  if (m) f.listMsgId = m.message_id
}

// The list as it stands right now.
//
// A part has no topic yet for two ordinary reasons: it is queued behind the
// concurrency cap, or its topic is still being created. Neither is a failure, and
// reporting them as "no topic could be created" was wrong twice over — the message
// was written before the topics existed, so it accused Telegram of failing at
// something it had not been asked to do yet.
function renderFanoutParts(f: Fanout): string {
  const lines = f.children.map(c => {
    const label = `${FANOUT_MARK} ${c.n}/${f.children.length} ${c.title}`
    const link = topicLink(f.chatId, c.topicId)
    if (link) return `[${label}](${link})`
    // Settled without ever getting one: it really did run outside a topic, on its
    // own synthetic key, and there is nothing to link to.
    const ran = c.status === 'done' || c.status === 'failed' || c.status === 'stopped'
    return `${label} — ${ran ? 'ran without a topic of its own' : 'starting…'}`
  })
  return `Running ${f.children.length} parts:\n${lines.join('\n')}`
}

// Re-render the list in place as parts get their topics. Parts start in waves when
// there are more of them than the concurrency cap, so this message is only ever
// complete some time after it is first posted.
async function refreshFanoutParts(ctx: Context, f: Fanout): Promise<void> {
  if (f.listMsgId === undefined) return
  await ctx.api.editMessageText(f.chatId, f.listMsgId,
    telegramify(sanitizeProse(renderFanoutParts(f), 'markdownv2'), 'escape'),
    { parse_mode: 'MarkdownV2' },
  ).catch(() => {})   // unchanged text is an error to Telegram, and is fine here
}

// Put a part back in flight. Called before every turn in a part's topic: a part you
// are talking to is not a part that has finished, whatever it said last time.
function markFanoutChildLive(key: string): void {
  const owner = childOf.get(key)
  if (!owner) return
  const f = fanouts.get(owner.fanoutId)
  const child = f?.children.find(c => c.n === owner.n)
  if (child && child.status !== 'pending' && child.status !== 'running') child.status = 'running'
}

// A part was interrupted from its own topic. The parent stops waiting for it to
// finish on its own, but must not treat it as done either — the work was cut off
// mid-way, and an answer built from it would be built from half a part.
async function noteFanoutChildInterrupted(ctx: Context, key: string): Promise<void> {
  const owner = childOf.get(key)
  if (!owner) return
  const f = fanouts.get(owner.fanoutId)
  const child = f?.children.find(c => c.n === owner.n)
  if (!f || !child || f.synthesised) return
  child.status = 'stopped'
  // Without the button an abandoned part would hold the whole fan-out open forever,
  // which is a worse failure than an incomplete answer you asked for.
  await ctx.api.sendMessage(f.chatId,
    `⏸ Part ${child.n} (${child.title}) was interrupted, so the answer is waiting on it. Steer it in its own topic and it will be included when it finishes.`,
    { ...destOpts({ threadId: f.parentThreadId, replyTo: f.askedBy }), disable_notification: true,
      reply_markup: { inline_keyboard: [[{ text: '— Combine without it —', callback_data: `fanf:${f.id}` }]] } },
  ).catch(() => {})
}

// A part changed after the answer was written. Say so and offer to redo it.
async function offerRecombine(ctx: Context, f: Fanout, child: FanoutChild): Promise<void> {
  // Its topic was closed when the answer was written, and a closed topic is
  // read-only for everyone but an admin. Steering it makes it live again, so reopen
  // it — otherwise the first correction is also the last one you can make.
  if (child.topicId !== undefined) await ctx.api.reopenForumTopic(f.chatId, child.topicId).catch(() => {})
  await ctx.api.sendMessage(f.chatId,
    `↻ Part ${child.n} (${child.title}) changed after the combined answer was written.`,
    { ...destOpts({ threadId: f.parentThreadId, replyTo: f.askedBy }), disable_notification: true,
      reply_markup: { inline_keyboard: [[{ text: '— Combine again —', callback_data: `fanr:${f.id}` }]] } },
  ).catch(() => {})
}

// Where a write-part's work actually lives. Without this the branches are invisible
// and the whole point of isolating them is lost — you cannot merge what you cannot
// find.
function fanoutBranchReport(f: Fanout): string {
  const wrote = f.children.filter(c => c.branch)
  if (!wrote.length) return ''
  return '\n\nBranches created:\n' + wrote.map(c => `• \`${c.branch}\` — ${c.title}  (${c.worktree})`).join('\n')
}

// Tidy up once the answer is written: close each child topic (never delete — the
// history is the record of how the part was reached), and remove a worktree only if
// git agrees it is clean. A dirty worktree holds uncommitted work, so it is left
// alone and reported rather than forced away.
// What becomes of the part topics once the answer is written.
//
//   ask (default) — leave them alone and offer a button in the parent topic. You
//                   decide when you are finished reading them; nothing is destroyed
//                   behind your back.
//   delete        — remove them as soon as the answer is written.
//   close         — keep them, closed and read-only.
//   keep          — leave them open and say nothing.
//
// Deleting used to be automatic. It is destructive — the part's working-out goes
// with it, and the combined answer becomes the only record — and whether a part is
// worth reading is a judgement only the person reading it can make. Read at call
// time so it can be changed without a restart.
function topicDisposal(): 'ask' | 'delete' | 'close' | 'keep' {
  const v = (process.env.TG_FANOUT_TOPICS || 'ask').toLowerCase()
  return v === 'delete' || v === 'close' || v === 'keep' ? v : 'ask'
}

// Dispose of the part topics, falling back rather than giving up: deleting needs
// Delete Messages and closing needs Manage Topics, and a bot that has neither must
// still leave a way to clear up by hand instead of an unexplained mess.
async function disposeFanoutTopics(ctx: Context, f: Fanout, force?: 'delete' | 'close'): Promise<void> {
  const mode = force ?? topicDisposal()
  if (mode === 'keep') return
  const live = f.children.filter(c => c.topicId !== undefined)
  if (!live.length) return
  // The default: leave the topics exactly as they are and put the decision in the
  // parent topic, where the answer is. Tapping it comes back through here with the
  // disposal forced, so there is one code path rather than two.
  if (mode === 'ask') {
    await ctx.api.sendMessage(f.chatId,
      `The ${live.length} part topic${live.length === 1 ? '' : 's'} from this fan-out are still open.`,
      { ...destOpts({ threadId: f.parentThreadId, replyTo: f.askedBy }), disable_notification: true,
        reply_markup: { inline_keyboard: [[{ text: '— Done, delete subtopics —', callback_data: `fanc:${f.id}` }]] } },
    ).catch(() => {})
    return
  }
  let done = 0
  for (const c of live) {
    if (mode === 'delete'
      && await ctx.api.deleteForumTopic(f.chatId, c.topicId!).then(() => true).catch(() => false)) { done++; continue }
    if (await ctx.api.closeForumTopic(f.chatId, c.topicId!).then(() => true).catch(() => false)) done++
  }
  if (done === live.length) return
  const left = live.length - done
  await ctx.api.sendMessage(f.chatId,
    `${left} part topic${left === 1 ? '' : 's'} could not be cleared up automatically — the bot needs Delete Messages, or Manage Topics to close them.`,
    { ...destOpts({ threadId: f.parentThreadId, replyTo: f.askedBy }), disable_notification: true,
      reply_markup: { inline_keyboard: [[{ text: '— Remove the part topics —', callback_data: `fanc:${f.id}` }]] } },
  ).catch(() => {})
}

async function cleanupFanout(ctx: Context, f: Fanout): Promise<void> {
  const kept: string[] = []
  const keeping = topicDisposal() !== 'delete'   // 'ask' keeps them until you say otherwise
  for (const c of f.children) {
    // Only worth saying where the topic will survive to be read. Posting it into a
    // topic that is about to be deleted is a message written to be thrown away.
    if (c.topicId !== undefined && keeping) {
      await send(ctx, c.topicId, `✅ This part is finished and folded into the answer in the parent topic.`, true).catch(() => {})
    }
    if (c.worktree) {
      try {
        execFileSync('git', ['-C', c.worktree, 'worktree', 'remove', c.worktree], { stdio: 'ignore' })
      } catch {
        kept.push(`\`${c.branch}\` (${c.worktree})`)   // uncommitted work lives here
      }
    }
  }
  if (kept.length) {
    await send(ctx, f.parentThreadId,
      `Left these worktrees in place because they still have uncommitted changes:\n` +
      kept.map(k => `• ${k}`).join('\n'), true, f.askedBy)
  }
}

// When every part has settled, write the single answer — automatically, in the
// parent topic, from the parts' own summaries.
async function maybeSynthesise(ctx: Context, f: Fanout): Promise<void> {
  if (f.synthesised) return
  // 'stopped' waits too: it means a part was interrupted and is being taken over by
  // hand, and the answer would otherwise be written from work that was cut off.
  if (f.children.some(c => c.status === 'pending' || c.status === 'running' || c.status === 'stopped')) return
  f.synthesised = true
  const parts = f.children.map(c => ({ title: c.title, status: c.status, result: c.result }))
  const okCount = parts.filter(p => p.status === 'done').length
  // Only say anything when there is something to say. "All parts finished" adds
  // nothing when the combined answer is about to arrive anyway — but a part that
  // FAILED, or a branch holding work, must not be silent, which is why this is
  // conditional rather than simply deleted.
  const failed = f.children.length - okCount
  const branches = fanoutBranchReport(f)
  if (failed > 0 || branches) {
    await send(ctx, f.parentThreadId,
      (failed > 0 ? `⚠️ ${failed} of ${f.children.length} parts did not complete; the answer below is missing their work.` : '') + branches,
      true, f.askedBy)
  }
  const preamble = buildSynthesisPreamble(f.task, parts)
  const key = f.parentKey
  void enqueue(`${key}#fanout-synth-${f.id}`,
    () => handlePrompt(ctx, f.parentThreadId, key, preamble, undefined, f.askedBy, true, true, true))
    .then(() => cleanupFanout(ctx, f))
    .then(() => disposeFanoutTopics(ctx, f))
    .catch(e => console.error(`[fanout ${f.id}] synthesis: ${e}`))
}

async function handlePrompt(ctx: Context, threadId: number | undefined, key: string, prompt: string, mode?: string, replyTo?: number, forceReplyLink = false, background = false, isSynthesis = false): Promise<void> {
  // A message promoted to run in parallel has already been handled; its turn in the
  // queue must do nothing rather than run it a second time.
  if (replyTo !== undefined && skipQueued.has(replyTo)) { skipQueued.delete(replyTo); return }
  if (replyTo !== undefined) {
    // Its turn came up, so the offer is spent. Withdraw the message rather than
    // leaving it in the history: it was an aside about a wait that is now over, and
    // a dead button sitting above the answer is worse than no button at all.
    const o = offered.get(replyTo)
    if (o?.offerMsgId) await ctx.api.deleteMessage(ctx.chat!.id, o.offerMsgId).catch(() => {})
    offered.delete(replyTo)
  }
  // A turn in a part's topic means that part is live again — you are steering it, or
  // picking it up after interrupting it. Mark it before the turn, not after: while it
  // is settled the parent is free to write the answer, and it would be writing from
  // the result you are in the middle of replacing.
  markFanoutChildLive(key)

  const cwd = resolveCwd(ctx, threadId)
  // Attribute the message before it reaches the model. Only here: handlePassthrough
  // and /compact send literal CLI commands, which are not somebody speaking.
  // Hand over anything a background job found since the last turn, as
  // bridge-authored context rather than as something the user said.
  const carried = !background && bgNotes[key]?.length ? bgNotes[key].splice(0) : []
  const preamble = carried.length
    ? carried.map(t => `[xesious:${BRIDGE_NONCE}] a background task you started in this topic has finished. Its result:\n${t}`).join('\n\n') + '\n\n'
    : ''
  // Same idea for files that arrived without a caption. Foreground turns only: a
  // background job was asked for something specific and should not inherit an
  // upload that happened while it ran.
  const arrived = !background && pendingFiles[key]?.length ? pendingFiles[key].splice(0) : []
  // A shared directory changes where files go, and the model only knows what it is
  // told: the standing profile says "./outbox/", which is a race when two topics
  // drain one directory. Said every turn rather than once at fork time, because the
  // sharing can start (or stop) long after this session began.
  const shareNote = topicsSharing(cwd, key)
    ? `[xesious:${BRIDGE_NONCE}] this directory is shared with another topic (a fork). Files sent to THIS conversation are in ./${INBOX_DIR}/${topicTag(key)}/, and anything you want delivered here goes in ./${OUTBOX_DIR}/${topicTag(key)}/ — not the shared ./${OUTBOX_DIR}/ itself.\n\n`
    : ''
  const framed = shareNote + filesPreamble(BRIDGE_NONCE, arrived) + preamble + frameUserMessage(prompt, {
    nonce: BRIDGE_NONCE,
    name: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || ctx.from?.username,
    id: ctx.from?.id,
  })
  // If this topic has a live link, the shared link is the source of truth for the
  // session id, so a conversation held over the live web call continues here (and
  // vice-versa). Otherwise use the topic's own stored id.
  const linked = linkForKey(key)
  const resumeId = linked?.link.sessionId ?? sessions[key]?.sessionId
  // Bind the session the moment the CLI announces it, not only when the turn
  // completes. The completion path below is guarded by `stopped`, and that guard
  // returns BEFORE the line that persists — so a run killed with /stop on a
  // topic's very first turn wrote nothing to disk, and the next message started a
  // brand-new session with no history. That is the reported "after /stop the bot
  // doesn't know the history". The id is available from the init event at the
  // start of the run, so there is no reason to wait for the end of it.
  // Decided once, at DELIVERY time rather than on arrival: what has landed in the
  // topic while this turn ran is exactly what makes the answer hard to place. Once
  // per turn, so a promoted block and its reply agree and neither makes the other
  // look ambiguous.
  const asked = replyTo !== undefined ? askSeq.get(replyTo) : undefined
  let linkDecided: number | undefined
  let linkResolved = false
  const replyLink = () => {
    if (!linkResolved) {
      linkResolved = true
      linkDecided = needsReplyLink({
        replyTo,
        latestIncoming: latestIncoming[key],
        inFlight: inFlight[key] ?? 0,
        answersSince: asked === undefined ? 0 : (answerSeq[key] ?? 0) - asked,
        force: forceReplyLink,
      }) ? replyTo : undefined
      // This turn is now one of the answers a later question has to see.
      answerSeq[key] = (answerSeq[key] ?? 0) + 1
      if (replyTo !== undefined) askSeq.delete(replyTo)
    }
    return linkDecided
  }

  const bindSession = (sessionId: string) => {
    sessions[key] = { ...sessions[key], cwd, sessionId, updated: new Date().toISOString() }
    saveState()
    if (linked) { const l = loadLinks(); if (l[linked.uuid]) { l[linked.uuid].sessionId = sessionId; saveLinks(l) } }
  }
  try {
    const res = await runStreaming(ctx, threadId, key, framed, cwd, resumeId, mode ?? modeFor(key), modelFor(key), { onInit: background ? undefined : bindSession, effort: effortFor(key), askedBy: replyTo, fork: background })
    if (stopped.has(key)) {
      stopped.delete(key)
      // Interrupting a part is not the same as the part finishing. It means you are
      // taking it over, so the parent waits instead of writing an answer from work
      // you just stopped — with a way out, so an abandoned part cannot strand the
      // whole fan-out.
      await noteFanoutChildInterrupted(ctx, key)
      return
    }
    // Still persist on completion: a resumed turn reports the same id, and this
    // refreshes `updated`. Binding already happened above for a fresh session.
    if (res.sessionId) bindSession(res.sessionId)
    if (res.noAnswer) {
      await sendNoAnswer(ctx, threadId, key, prompt, replyLink())
      return
    }
    // When the turn's closing block only promises future work or refers to work
    // the user never saw, deliver the substantive block before it as well. The
    // rest of the turn's text is in the run record above, so this is an
    // enhancement rather than the mechanism: a miss costs a tap, not a message.
    const promoted = promoteBlock(res.blocks ?? [], res.text)
    if (promoted) await deliver(ctx, threadId, promoted, replyLink())
    // A background result arrives long after it was asked for, with anything in
    // between, so it always quotes its question and says what it is.
    const link = background ? replyTo : replyLink()
    // Every turn in a child topic updates that part's result, not just its first
    // one. Steering a part is the reason parts get their own topics at all — if the
    // correction did not replace the answer, the combined result would be built
    // from what the part said BEFORE you fixed it, which is worse than not being
    // able to steer.
    const owner = childOf.get(key)
    if (owner) {
      const f = fanouts.get(owner.fanoutId)
      const child = f?.children.find(c => c.n === owner.n)
      if (f && child) {
        if (res.text.trim()) child.result = res.text
        if (f.synthesised) {
          // Corrected after the answer was already written: offer to redo it rather
          // than silently leaving a combined answer that no longer matches its parts.
          child.status = 'done'
          if (res.text.trim()) await offerRecombine(ctx, f, child)
        } else {
          // Settle it through the normal path, so a steering turn can be what
          // completes the fan-out — the parent was waiting on this part.
          await finishFanoutChild(ctx, f, child)
        }
      }
    }
    // A fan-out's synthesis IS the answer and needs no banner announcing itself. An
    // ordinary /bg result does: it arrives long after it was asked for.
    if (background && !owner && !isSynthesis) {
      noteBgResult(key, res.text)
      await send(ctx, threadId, `🌿 Background task finished.`, true, link)
    }
    await deliver(ctx, threadId, res.text, link)
    await flushOutbox(ctx, threadId, cwd, key, link)
    // Speak the answer too when this topic is in voice mode.
    const vm = voiceMode(key); if (vm !== 'off' && !res.isError) await speakAnswer(ctx, threadId, res.text, vm)
  } catch (e) {
    await send(ctx, threadId, `⚠️ ${e}`, false, replyLink())
  }
}

// Built-in CLI slash commands that the client answers by itself: they report
// (usage, cost, context) rather than prompt the model, so they cost nothing and
// take no turn. Anything that actually drives the model (/doctor) or that the
// bridge already owns (/status, /new, …) is deliberately not here.
const PASSTHROUGH = new Set(['/usage', '/cost', '/context'])

// Forward one such command to the CLI and post what it printed. The session id it
// returns is NEVER stored: with --resume it's the same id anyway, and without one
// the CLI mints a throwaway that would otherwise bind this topic to an empty session.
async function handlePassthrough(ctx: Context, threadId: number | undefined, key: string, text: string): Promise<void> {
  const cwd = resolveCwd(ctx, threadId)
  try {
    const res = await runStreaming(ctx, threadId, key, text, cwd, sessions[key]?.sessionId, modeFor(key), modelFor(key))
    if (stopped.has(key)) { stopped.delete(key); return }
    await deliver(ctx, threadId, res.text)
  } catch (e) {
    await send(ctx, threadId, `⚠️ ${e}`)
  }
}

// ---------------------------------------------------------------------------
// Discover & import existing Claude Code sessions (what the IDE/CLI picker shows).
// A directory's sessions live at CLAUDE_PROJECTS/<encoded-cwd>/<id>.jsonl.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Claude encodes a cwd by replacing every non-alphanumeric char with '-'.
// encodeCwd and parseDirs live in ./lib.
function projectDir(dir: string): string { return join(CLAUDE_PROJECTS, encodeCwd(dir)) }

// Copy a session's transcript into a NEW session id, and hand back the id.
//
// This is what makes /fork honest. The alternative is to bind the new topic to the
// PARENT's id and pass --fork-session on its first run, which the CLI supports —
// but then two topics are bound to one id until that first message, and three
// things go wrong with that: the fork branches from wherever the parent has got to
// by then rather than from where you typed /fork; a message to each at the same
// time has two processes resuming one transcript; and if the "fork me first" flag
// is ever lost — a restart, or any path that runs the topic without it — the fork
// silently APPENDS to the parent's session, so both topics share one conversation
// and neither reports an error. Copying the file removes the window entirely:
// there are two ids from the first second, and no flag to lose.
//
// Every line carries its own sessionId, so they are rewritten as we go — a
// transcript whose contents disagree with its filename is asking for trouble later.
function forkTranscript(cwd: string, sessionId: string): string | undefined {
  const src = join(projectDir(cwd), `${sessionId}.jsonl`)
  if (!existsSync(src)) return undefined
  const newId = randomUUID()
  const dst = join(projectDir(cwd), `${newId}.jsonl`)
  try {
    const out = readFileSync(src, 'utf8').split('\n').map(line => {
      if (!line.trim()) return line
      try {
        const o = JSON.parse(line)
        if (o && typeof o === 'object' && 'sessionId' in o) { o.sessionId = newId; return JSON.stringify(o) }
        return line
      } catch { return line }   // not JSON we understand: carry it over untouched
    }).join('\n')
    writeFileSync(dst, out)
    return newId
  } catch (e) {
    console.error(`[fork] could not copy ${src}: ${e}`)
    return undefined
  }
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 90) return `${Math.round(s)}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 36 * 3600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

// Flatten a message's content (string or block array) to plain text. Tool calls
// are shown compactly; tool results / thinking / images are dropped for readability.
function blockText(content: any): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (typeof b === 'string') parts.push(b)
    else if (b?.type === 'text' && b.text) parts.push(b.text)
    else if (b?.type === 'tool_use') parts.push(`⚙️ ${b.name}`)
  }
  return parts.join('\n').trim()
}

interface SessionInfo { id: string; file: string; mtimeMs: number; title: string; turns: number }

// List the sessions stored for a directory, newest first.
function listSessions(dir: string): SessionInfo[] {
  const pd = projectDir(dir)
  if (!existsSync(pd)) return []
  const out: SessionInfo[] = []
  for (const f of readdirSync(pd)) {
    if (!f.endsWith('.jsonl')) continue
    const file = join(pd, f)
    try {
      const st = statSync(file); if (!st.isFile()) continue
      let title = '', firstUser = '', turns = 0
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        let o: any; try { o = JSON.parse(line) } catch { continue }
        if (o.type === 'summary' && o.summary && !title) title = String(o.summary)
        if (o.type === 'user' || o.type === 'assistant') {
          const t = blockText(o.message?.content)
          if (!t) continue
          turns++
          if (o.type === 'user' && !firstUser && !t.startsWith('⚙️')) firstUser = t
        }
      }
      out.push({
        id: f.replace(/\.jsonl$/, ''), file, mtimeMs: st.mtimeMs,
        title: (title || firstUser || '(untitled)').replace(/\s+/g, ' ').slice(0, 80), turns,
      })
    } catch {}
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

// Render the last n user/assistant turns of a session as Telegram-ready lines.
function renderTurns(file: string, n: number): string[] {
  const turns: string[] = []
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let o: any; try { o = JSON.parse(line) } catch { continue }
      if (o.type !== 'user' && o.type !== 'assistant') continue
      const t = blockText(o.message?.content)
      if (t) turns.push(`${o.type === 'user' ? '👤' : '🤖'} ${t}`)
    }
  } catch {}
  return n > 0 ? turns.slice(-n) : turns
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

loadState()
export const bot = new Bot(TOKEN, API_ROOT ? { client: { apiRoot: API_ROOT } } : undefined)
// Stay within Telegram's limits (~20 msgs/min per group): the throttler queues
// outbound calls, and auto-retry waits out any 429 instead of dropping messages.
bot.api.config.use(apiThrottler())
bot.api.config.use(autoRetry({ maxRetryAttempts: 5, maxDelaySeconds: 60 }))
let botUsername = ''

bot.on('message', async ctx => {
  const msg = ctx.message
  if (!msg || !ctx.from || ctx.from.is_bot) return
  const chatId = ctx.chat.id
  const threadId = msg.message_thread_id

  // Capture forum-topic names from service messages so we can name directories.
  const created = (msg as any).forum_topic_created
  const edited = (msg as any).forum_topic_edited
  if (created?.name && threadId !== undefined) { names[keyFor(chatId, threadId)] = created.name; saveState(); return }
  if (edited?.name && threadId !== undefined) { names[keyFor(chatId, threadId)] = edited.name; saveState(); return }
  // A topic created before the bot joined, or while it was down, never produced
  // that service message and so has no name here at all. Messages in a topic carry
  // its creation as their reply_to, so learn it from there when we don't know it —
  // incidental, so no early return.
  const viaReply = (msg as any).reply_to_message?.forum_topic_created?.name
  if (viaReply && threadId !== undefined && !names[keyFor(chatId, threadId)]) {
    names[keyFor(chatId, threadId)] = viaReply; saveState()
  }

  // File uploads: save into this topic's inbox. A caption (if any) runs as a prompt.
  // Voice note (or round video) → transcribe → run as a prompt, when the topic is
  // in voice mode. handlePrompt then speaks the answer back. Otherwise it falls
  // through to the generic attachment path (saved to inbox).
  if ((msg.voice || msg.video_note) && voiceMode(keyFor(chatId, threadId)) !== 'off') {
    if (!isAllowed(ctx)) return
    const vKey = keyFor(chatId, threadId)
    const att = pickAttachment(msg)!
    console.log(`[in] chat=${chatId} topic=${threadId ?? '-'} from=${ctx.from.id} 🎙 voice (${fmtBytes(att.size)})`)
    for (const j of jobsFor(vKey)) if (isInterrupt(vKey)) { stopped.add(vKey); void endJob(j, 'discard') }
    enqueue(vKey, async () => {
      const cwd = resolveCwd(ctx, threadId)
      let saved: string
      try { saved = await receiveFile(ctx, att, cwd, vKey) }
      catch (e) { await send(ctx, threadId, `⚠️ couldn't save the voice note: ${e}`); return }
      const heard = await transcribe(saved)
      if (!heard) { await send(ctx, threadId, '🎙 Sorry — I couldn’t make out that voice note. Try again, a bit closer to the mic.'); return }
      await send(ctx, threadId, `🎙 “${heard}”`, true) // show what was heard, so a mis-hear is visible
      await handlePrompt(ctx, threadId, vKey, heard)
    }).catch(e => console.error(`[error] voice task ${keyFor(chatId, threadId)}: ${e}`))
    return
  }

  const attachment = pickAttachment(msg)
  if (attachment) {
    if (!isAllowed(ctx)) return
    const aKey = keyFor(chatId, threadId)
    const caption = msg.caption?.trim()
    console.log(`[in] chat=${chatId} topic=${threadId ?? '-'} from=${ctx.from.id} file=${attachment.name} (${fmtBytes(attachment.size)})`)
    enqueue(aKey, async () => {
      const cwd = resolveCwd(ctx, threadId)
      let saved: string
      try { saved = await receiveFile(ctx, attachment, cwd, aKey) }
      catch (e) { await send(ctx, threadId, `⚠️ couldn't save file: ${e}`); return }
      if (caption) {
        await handlePrompt(ctx, threadId, aKey, `[The user attached a file, saved at ${saved} (./${relative(cwd, saved)}).]\n\n${caption}`, undefined, ctx.message?.message_id)
      } else {
        // A receipt, not an instruction. The next turn is told about the file by
        // the bridge, so there is nothing for the user to do — asking them to
        // repeat a path back was bookkeeping the bridge was already doing.
        const rel = `./${relative(cwd, saved)}`
        ;(pendingFiles[aKey] ??= []).push({ abs: saved, rel })
        await send(ctx, threadId, `📎 Saved → ${rel}`, true)
      }
    }).catch(e => console.error(`[error] file task ${aKey}: ${e}`))
    return
  }

  const text = msg.text?.trim()
  if (!text) return
  const key = keyFor(chatId, threadId)
  console.log(`[in] chat=${chatId}(${ctx.chat.type}) topic=${threadId ?? '-'} from=${ctx.from.id} ${JSON.stringify(text).slice(0, 100)}`)

  const cmd = text.startsWith('/') ? text.split(/\s+/)[0].replace(/@.*$/, '').toLowerCase() : ''
  // Track EVERY inbound message, commands included. A /interrupt typed while a
  // turn runs is as much of a separator as another question would be, and an
  // answer arriving after it is no longer adjacent to what it answers.
  if (cmd) latestIncoming[keyFor(ctx.chat!.id, threadId)] = msg.message_id

  // Ungated: only reveals the caller's own ids.
  if (cmd === '/whoami' || cmd === '/id') {
    await send(ctx, threadId,
      `your user id: ${ctx.from.id}\nchat id: ${chatId} (${ctx.chat.type})\ntopic id: ${threadId ?? '(none / general)'}`)
    return
  }
  if (cmd === '/help') {
    await send(ctx, threadId,
      `claude-tg-bridge — one Claude session per topic.\n\n` +
      `Send any text to talk to Claude in this topic.\n\n` +
      `Send a file to drop it in this topic's ./${INBOX_DIR}/; ask Claude to put a file in ` +
      `./${OUTBOX_DIR}/ to have it sent back.\n\n` +
      `/whoami — show ids (for the allowlist)\n/new (or /clear) — fresh session here (old one kept; /resume to undo)\n` +
      `/resume [id] — restore the previous session, or bind a past session id\n` +
      `/compact [focus] — summarize this topic's history to free up context\n` +
      `/stop — cancel the running task and discard its answer\n` +
      `/interrupt — stop it early but keep what it produced (or on|off for the sticky mode)\n` +
      `/bg <task> — run it alongside this topic instead of blocking it\n` +
      `/fanout <task> — split it into parts, run them in parallel topics, then combine\n` +
      `/jobs — what is running here, and what earlier runs left behind\n` +
      `/restart — restart the bridge; in-flight tasks finish first\n` +

      `/voice [on|summary|off] — speak answers back; full or summarized (text is always complete)\n` +
      `/live — get a private link to a real-time voice call bound to this session\n` +
      `/mode [${MODES.join('|')}] — permission mode for this topic (tap to switch)${ALLOW_BYPASS ? '' : '; bypass exists but is disabled here'}\n` +
      `/model [${MODEL_ALIASES.join('|')}] — model for this topic (tap to switch)\n` +
      `/effort [${EFFORT_LEVELS.join('|')}] — reasoning effort for this topic (tap to switch)\n` +
      `/plan <task> — one read-only turn: propose without editing\n` +
      `/logo bot|group — set the bot's avatar / this group's photo\n` +
      `/get <path> — send a file from this topic's directory back to you\n` +
      `/cwd <abs-path> — set this topic's working directory\n/status — session id + directory + mode\n\n` +
      `Claude's own commands, forwarded as-is:\n${[...PASSTHROUGH].join(' · ')}\n\n` +
      `Bring existing Claude sessions in from the IDE/CLI:\n` +
      `/sessions <dir…> — list the sessions stored for one or more directories\n` +
      `/fork [name] — continue this conversation in a second topic, from here (same directory)\n` +
      `/import <dir…> — make a topic for each session there (bound + backfilled)\n` +
      `/history [N] — re-post the last N turns of this topic's session`)
    return
  }

  if (!isAllowed(ctx)) { if (cmd) await send(ctx, threadId, `Not authorized. Send /whoami to get the id to allowlist.`); return }

  if (REQUIRE_MENTION && ctx.chat.type !== 'private' && !cmd) {
    const mentioned = (botUsername && text.toLowerCase().includes('@' + botUsername.toLowerCase())) ||
      msg.reply_to_message?.from?.username === botUsername
    if (!mentioned) return
  }

  if (cmd === '/restart') {
    if (!requestDrain) { await send(ctx, threadId, 'Restart is not available in this process.', true); return }
    const n = jobs.size
    await send(ctx, threadId, n > 0
      ? `♻️ Restarting — finishing ${n} run${n === 1 ? '' : 's'} first. Messages you send while I'm down will still be picked up.`
      : `♻️ Restarting — back in a moment. Messages you send while I'm down will still be picked up.`)
    // Deliberately not awaited. The drain stops the runner, and the runner waits
    // for its handlers to return — awaiting our own shutdown from inside a handler
    // would deadlock.
    void requestDrain(`/restart from ${ctx.from?.id ?? 'unknown'}`)
    return
  }
  // Two different things, which used to be one. /stop throws the turn away;
  // /interrupt stops it early and delivers what it already produced. The reply says
  // which happened, because the difference matters and used to be invisible.
  if (cmd === '/stop' || cmd === '/cancel') {
    const running = jobsFor(key)
    if (!running.length) { await send(ctx, threadId, 'Nothing is running in this topic right now.', true); return }
    stopped.add(key)
    for (const j of running) void endJob(j, 'discard')
    // Quote the question being cancelled. By the time you cancel, that message is
    // far up the topic, and "cancelled" on its own does not say cancelled WHAT.
    await send(ctx, threadId,
      `⏹ Cancelled — the run and everything it started are being stopped, and its answer is discarded.\nUse /interrupt instead to stop but keep the partial answer.`,
      false, running.length === 1 ? running[0].askedBy : undefined)
    return
  }
  if (cmd === '/interrupt') {
    const arg = text.split(/\s+/)[1]?.toLowerCase()
    // Bare /interrupt now DOES something. It used to be a toggle only, which is
    // the complaint on record: "the name promises an action and delivers a
    // setting". on|off still sets the sticky mode.
    if (!arg) {
      const running = jobsFor(key)
      if (!running.length) { await send(ctx, threadId, 'Nothing is running in this topic right now.', true); return }
      for (const j of running) void endJob(j, 'keep')
      await send(ctx, threadId, '⏹ Interrupting — I will send whatever the run produced before it stopped.',
        false, running.length === 1 ? running[0].askedBy : undefined)
      return
    }
    const next = arg === 'on' ? true : arg === 'off' ? false : !isInterrupt(key)
    interruptMode[key] = next
    saveState()
    await send(ctx, threadId, next
      ? '⚡ Interrupt mode ON — a new message cancels the running task and starts immediately; its reply arrives as a new message.'
      : '⏸ Interrupt mode OFF — messages queue and run one at a time.')
    return
  }
  if (cmd === '/voice') {
    const arg = text.split(/\s+/)[1]?.toLowerCase()
    let next: 'off' | 'full' | 'summary' | undefined
    if (arg === 'off') next = 'off'
    else if (arg === 'on' || arg === 'full') next = 'full'
    else if (arg === 'summary' || arg === 'short' || arg === 'summarized') next = 'summary'
    else if (!arg) {
      await send(ctx, threadId,
        `🎙 Voice here: ${voiceMode(key)}\n\n` +
        `/voice on — speak the full answer\n` +
        `/voice summary — speak a short summary\n` +
        `/voice off — text only\n\n` +
        `Either way, the complete answer always comes as text.`)
      return
    } else { await send(ctx, threadId, 'Usage: /voice on | summary | off'); return }
    if (next === 'off') delete voice[key]; else voice[key] = next
    saveState()
    await send(ctx, threadId,
      next === 'full' ? '🎙 Voice ON (full) — I speak the whole answer, and the complete answer also comes as text.'
      : next === 'summary' ? '🎙 Voice ON (summary) — I speak a short summary; the complete answer still comes as text.'
      : '🔇 Voice OFF — replies are text only.')
    return
  }
  if (cmd === '/live') {
    const cwd = resolveCwd(ctx, threadId)
    const links = loadLinks()
    for (const [u, l] of Object.entries(links)) if (l.key === key) delete links[u] // one link per topic
    const uuid = randomUUID()
    links[uuid] = { key, cwd, model: models[key], sessionId: sessions[key]?.sessionId, created: new Date().toISOString() }
    saveLinks(links)
    await send(ctx, threadId,
      `🎙 Live voice call for *this* session:\n${LIVE_URL}/${uuid}\n\n` +
      `Open it on your phone — no password, the link itself is the key, so keep it private (anyone with it talks as you). ` +
      `It continues this exact conversation, in ${cwd}. Send /live again for a fresh link (revokes this one).`)
    return
  }
  // Startup only fills in a MISSING photo; this is how you replace one on purpose.
  if (cmd === '/logo') {
    const what = (text.split(/\s+/)[1] || '').toLowerCase()
    if (what !== 'bot' && what !== 'group') {
      await send(ctx, threadId, `Usage: /logo bot | /logo group\n\nSets the avatar from ${BOT_LOGO} (bot) or ${GROUP_LOGO} (group).\nOn startup these are only applied when the bot/group has no photo at all; this command replaces an existing one.`)
      return
    }
    const path = what === 'bot' ? BOT_LOGO : GROUP_LOGO
    if (!existsSync(path)) { await send(ctx, threadId, `⚠️ no image at ${path} — set ${what === 'bot' ? 'TG_BOT_LOGO' : 'TG_GROUP_LOGO'}.`); return }
    if (what === 'group' && ctx.chat.type === 'private') { await send(ctx, threadId, 'Run /logo group inside the group whose photo you want to set.'); return }
    try {
      if (what === 'bot') await setBotLogo()
      else await setGroupLogo(chatId)
      await send(ctx, threadId, `✅ ${what} photo set from ${path}`)
    } catch (e) {
      await send(ctx, threadId, `⚠️ could not set the ${what} photo: ${e}` +
        (what === 'group' ? '\n(the bot needs to be an admin with "change group info")' : ''))
    }
    return
  }
  if (cmd === '/mode') {
    const arg = text.split(/\s+/)[1]
    if (arg) {
      const m = normalizeMode(arg)
      if (!m) {
        // bypass EXISTS and is implemented; it is gated behind TG_ALLOW_BYPASS
        // because the bot runs as root. Answering "Unknown mode" made a deliberate
        // gate look like a missing feature, so a user who knew the CLI flag existed
        // read it as "this bridge can't do that" and stopped. Say which it is.
        if (/^bypass(permissions)?$/i.test(arg.trim())) {
          await send(ctx, threadId,
            '⚠️ bypass exists but is disabled on this deployment.\n\n' +
            'It removes every permission check (--dangerously-skip-permissions) and this bot runs as root, ' +
            'so it is opt-in: set TG_ALLOW_BYPASS=1 in .env and restart to enable it.')
          return
        }
        await send(ctx, threadId, `Unknown mode "${arg}". One of: ${MODES.join(', ')}`); return
      }
      modes[key] = m; saveState()
      await send(ctx, threadId, `${MODE_EMOJI[m]} Mode for this topic: ${m} — ${MODE_HELP[m]}`)
      return
    }
    await ctx.api.sendMessage(ctx.chat.id, modeText(key), {
      ...(threadId ? { message_thread_id: threadId } : {}),
      reply_markup: modeKeyboard(key),
    }).catch(e => console.error(`[warn] /mode: ${e}`))
    return
  }
  if (cmd === '/effort') {
    const arg = text.split(/\s+/)[1]
    if (arg) {
      const e = normalizeEffort(arg)
      if (e === undefined) { await send(ctx, threadId, `Unknown effort "${arg}". One of: ${EFFORT_LEVELS.join(', ')}, or "${EFFORT_DEFAULT}".`); return }
      if (e) efforts[key] = e; else delete efforts[key]
      saveState()
      await send(ctx, threadId, `🎚️ Reasoning effort for this topic: ${effortLabel(key)}`)
      return
    }
    await ctx.api.sendMessage(ctx.chat.id, effortText(key), {
      ...(threadId ? { message_thread_id: threadId } : {}),
      reply_markup: effortKeyboard(key),
    }).catch(e => console.error(`[warn] /effort: ${e}`))
    return
  }
  if (cmd === '/model') {
    const arg = text.split(/\s+/)[1]
    if (arg) {
      const m = normalizeModel(arg)
      if (m === undefined) { await send(ctx, threadId, `Unknown model "${arg}". Try: ${MODEL_ALIASES.join(', ')}, a full id (claude-…), or "${MODEL_DEFAULT}".`); return }
      if (m) models[key] = m; else delete models[key]
      saveState()
      await send(ctx, threadId, `🧠 Model for this topic: ${modelLabel(key)}` + (m ? '' : `\n${defaultExplainer()}`))
      return
    }
    await ctx.api.sendMessage(ctx.chat.id, modelText(key), {
      ...(threadId ? { message_thread_id: threadId } : {}),
      reply_markup: modelKeyboard(key),
    }).catch(e => console.error(`[warn] /model: ${e}`))
    return
  }
  if (cmd === '/plan') {
    const arg = text.slice(text.indexOf(' ') + 1).trim()
    if (!arg || !text.includes(' ')) { await send(ctx, threadId, `Usage: /plan <what you want>\n\nRuns one read-only turn: Claude researches and proposes, without editing. Reply "go ahead" to carry it out in this topic's usual mode (${modeFor(key)}).`); return }
    for (const j of jobsFor(key)) if (isInterrupt(key)) { stopped.add(key); void endJob(j, 'discard') }
    // One-shot: the topic's sticky mode is untouched, so the follow-up executes.
    noteAsk(key, msg.message_id)
    enqueue(key, () => handlePrompt(ctx, threadId, key, arg, 'plan', msg.message_id))
      .catch(e => console.error(`[error] plan task ${key}: ${e}`))
    return
  }
  if (cmd === '/new' || cmd === '/reset' || cmd === '/clear') {
    const e = sessions[key]
    if (e?.sessionId) { e.prevSessionId = e.sessionId; delete e.sessionId; saveState() }
    await send(ctx, threadId, e?.prevSessionId
      ? `🧹 Fresh session started. The old one is kept (${e.prevSessionId.slice(0, 8)}) — send /resume to restore it. Nothing was deleted.`
      : '🧹 Fresh session for this topic.')
    return
  }
  if (cmd === '/resume') {
    const arg = text.split(/\s+/)[1]?.trim()
    const e = sessions[key] ?? (sessions[key] = { cwd: resolveCwd(ctx, threadId) })
    if (arg) {
      if (!existsSync(join(projectDir(e.cwd), `${arg}.jsonl`))) {
        await send(ctx, threadId, `No session ${arg} found for this topic's directory:\n${e.cwd}`); return
      }
      e.prevSessionId = e.sessionId; e.sessionId = arg; saveState()
      await send(ctx, threadId, `↩️ Bound this topic to session ${arg.slice(0, 8)} — message to continue it.`)
    } else if (e.prevSessionId) {
      const restore = e.prevSessionId
      e.prevSessionId = e.sessionId; e.sessionId = restore; saveState()
      await send(ctx, threadId, `↩️ Restored session ${restore.slice(0, 8)} — message to continue it.`)
    } else {
      await send(ctx, threadId, 'Usage: /resume <session-id> — bind this topic to a past session. (No id = undo the last /new.)')
    }
    return
  }
  if (cmd === '/compact') {
    const e = sessions[key]
    if (!e?.sessionId) { await send(ctx, threadId, 'No session in this topic yet — nothing to compact.'); return }
    const instr = text.replace(/^\/compact(@\S+)?\s*/i, '').trim()  // optional focus instructions
    enqueue(key, async () => {
      const res = await runStreaming(ctx, threadId, key, `/compact${instr ? ' ' + instr : ''}`, e.cwd, e.sessionId)
      if (stopped.has(key)) { stopped.delete(key); return }
      if (res.sessionId) { sessions[key] = { cwd: e.cwd, sessionId: res.sessionId, updated: new Date().toISOString() }; saveState() }
      await send(ctx, threadId, res.isError
        ? `⚠️ Compact failed: ${res.text.slice(0, 300)}`
        : '🗜️ Compacted — this topic’s history is summarized (memory kept). Carry on.')
    }).catch(err => console.error(`[error] compact ${key}: ${err}`))
    return
  }
  if (cmd === '/fanout' || cmd === '/split') {
    const task = text.slice(text.indexOf(' ') + 1).trim()
    if (!task || !text.includes(' ')) {
      await send(ctx, threadId, 'Usage: /fanout <task> — I will propose a split, you confirm, then the parts run in parallel in their own topics.', true)
      return
    }
    if (ctx.chat.type === 'private') {
      // Each part needs its own topic to be steerable, and a DM has none.
      await send(ctx, threadId, 'Fan-out needs a forum group: each part gets its own topic so you can steer it. In a DM, use /bg instead.', true)
      return
    }
    // A PLANNING turn first. Decomposition is the model's job; spawning, tracking
    // and reporting are the bridge's — a turn that launches its own children
    // orphans them when it exits.
    // Kept so it can be withdrawn: it describes work that is over the moment the
    // proposal appears, and leaving it behind is the same clutter as a spent offer.
    const thinking = await ctx.api.sendMessage(ctx.chat.id, '🧠 Working out how to split that…',
      { ...destOpts({ threadId, replyTo: msg.message_id }), disable_notification: true }).catch(() => null)
    void enqueue(key, async () => {
      const cwd = resolveCwd(ctx, threadId)
      const res = await runStreaming(ctx, threadId, key, fanoutPlanPrompt(task, FANOUT_MAX), cwd,
        sessions[key]?.sessionId, 'plan', modelFor(key), { effort: effortFor(key), fork: true })
      const items = parseFanoutPlan(res.text, { max: FANOUT_MAX })
      if (thinking) await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {})
      if (!items.length) {
        await send(ctx, threadId, `I could not turn that into a parallel split. Here is what came back:\n\n${res.text.slice(0, 1500)}`, false, msg.message_id)
        return
      }
      const f: Fanout = {
        id: newJobId(), parentKey: key, parentThreadId: threadId, chatId: ctx.chat!.id,
        askedBy: msg.message_id, task, badge: FANOUT_MARK, synthesised: false,
        children: items.map(i => ({ ...i, status: 'pending' as const })),
      }
      fanouts.set(f.id, f)
      saveState()
      // Through telegramify with a parse mode: this text is markdown, and a raw
      // sendMessage renders its asterisks and underscores literally.
      await ctx.api.sendMessage(ctx.chat!.id,
        telegramify(sanitizeProse(renderFanoutProposal(items, { cap: FANOUT_CONCURRENCY, isolated: isGitRepo(resolveCwd(ctx, threadId)) }), 'markdownv2'), 'escape'), {
        ...destOpts({ threadId, replyTo: msg.message_id }), parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: [[
          { text: `— Run these ${items.length} —`, callback_data: `fan:${f.id}` },
          { text: '— Cancel —', callback_data: `fanx:${f.id}` },
        ]] },
      }).catch(() => {})
    }).catch(e => console.error(`[error] fanout plan ${key}: ${e}`))
    return
  }
  if (cmd === '/bg') {
    const task = text.slice(text.indexOf(' ') + 1).trim()
    if (!task || !text.includes(' ')) {
      await send(ctx, threadId, 'Usage: /bg <task> — runs it alongside this topic instead of blocking it.', true)
      return
    }
    // Its own queue key, so it never joins the topic's serial chain; and forked, so
    // it gets its own session id rather than interleaving with the topic's
    // conversation. That id is never persisted — otherwise a parallel job would
    // quietly steal the topic's binding.
    await send(ctx, threadId, '🌿 Running that in the background — carry on here, I will report back.', true, msg.message_id)
    void enqueue(`${key}#bg-${msg.message_id}`,
      () => handlePrompt(ctx, threadId, key, task, undefined, msg.message_id, true, true))
      .catch(e => console.error(`[error] bg ${key}: ${e}`))
    return
  }
  if (cmd === '/jobs' || cmd === '/ps') {
    const running = jobsFor(key)
    const lines: string[] = []
    for (const j of running) {
      const mins = Math.round((Date.now() - j.startedAt) / 60000)
      const kids = groupSurvivors(j.pgid).length
      lines.push(`▶ ${j.id} — running ${mins}m, ${j.steps()} steps` + (kids ? `, ${kids} process${kids === 1 ? '' : 'es'}` : '') +
        `\n   ${j.prompt.replace(/^\[xesious:[^\]]*\][^\n]*\n/, '').slice(0, 80).replace(/\s+/g, ' ')}`)
    }
    // Anything still alive in a FINISHED run's group is, by construction, work it
    // left behind — no command-line pattern matching, no guessing. Reported rather
    // than killed: ending something we cannot prove we own is how the deploy
    // scripts used to take down other people's bridges.
    const leftovers = [...leftBehind.entries()].filter(([, v]) => v.key === key)
    for (const [pgid, v] of leftovers) {
      const alive = groupSurvivors(pgid)
      if (!alive.length) { leftBehind.delete(pgid); continue }
      lines.push(`⏳ ${alive.length} process${alive.length === 1 ? '' : 'es'} left running by job ${v.id} (pids ${alive.slice(0, 6).join(', ')})` +
        `\n   /kill ${v.id} to stop them`)
    }
    await send(ctx, threadId, lines.length
      ? `Jobs in this topic:\n\n${lines.join('\n\n')}`
      : 'Nothing running in this topic, and nothing left behind.', true)
    return
  }
  if (cmd === '/kill') {
    const id = text.split(/\s+/)[1]
    const entry = [...leftBehind.entries()].find(([, v]) => v.id === id && v.key === key)
    if (!entry) { await send(ctx, threadId, `No leftover processes recorded for job "${id ?? ''}" here. /jobs lists them.`, true); return }
    const [pgid, v] = entry
    const alive = groupSurvivors(pgid)
    for (const pid of alive) { try { process.kill(pid, 'SIGTERM') } catch {} }
    leftBehind.delete(pgid)
    await send(ctx, threadId, `Sent SIGTERM to ${alive.length} process${alive.length === 1 ? '' : 'es'} left by job ${v.id}.`)
    return
  }
  if (cmd === '/status') {
    const e = sessions[key]
    await send(ctx, threadId,
      `directory: ${e?.cwd ?? resolveCwd(ctx, threadId)}\n` +
      `session: ${e?.sessionId ?? '(none yet)'}\n` +
      `mode: ${modeFor(key)}${bypassDowngraded(key) ? ' (stored: bypass — disabled on this deployment)' : ''}\n` +
      `model: ${modelLine(key)}\n` +
      `effort: ${effortLabel(key)}\n` +
      `voice: ${voiceMode(key)}\n\n` +
      `resume on the server:\n  cd "${e?.cwd ?? resolveCwd(ctx, threadId)}" && claude --continue`)
    return
  }
  if (cmd === '/cwd') {
    const arg = text.slice(text.indexOf(' ') + 1).trim()
    if (!arg || !isAbsolute(arg) || !existsSync(arg) || !statSync(arg).isDirectory()) {
      await send(ctx, threadId, `Usage: /cwd <absolute-existing-directory>`); return
    }
    sessions[key] = { cwd: arg } // new dir => new session
    saveState()
    await send(ctx, threadId, `Working directory for this topic set to:\n${arg}\n(history reset)`)
    return
  }
  if (cmd === '/get') {
    const arg = text.slice(text.indexOf(' ') + 1).trim()
    if (!arg || arg.startsWith('/')) { await send(ctx, threadId, `Usage: /get <path>  (relative to this topic's directory, or absolute)`); return }
    const cwd = resolveCwd(ctx, threadId)
    const target = isAbsolute(arg) ? arg : resolve(cwd, arg)
    await sendFile(ctx, threadId, target)
    return
  }
  if (cmd === '/sessions') {
    // No argument means this topic's own directory, which is almost always what you
    // want from inside a topic — seeing what exists here in order to /resume one.
    // Printing a usage string instead made the common case the unsupported one.
    const dirs = parseDirs(text)
    if (!dirs.length) dirs.push(sessions[key]?.cwd ?? resolveCwd(ctx, threadId))
    for (const dir of dirs) {
      if (!isAbsolute(dir) || !existsSync(dir)) { await send(ctx, threadId, `skipped (not an absolute existing path): ${dir}`); continue }
      const list = listSessions(dir)
      if (!list.length) { await send(ctx, threadId, `${dir}\n  no sessions (looked in ${projectDir(dir)})`); continue }
      const body = list.slice(0, 30).map((s, i) => `${i + 1}. ${s.id.slice(0, 8)} · ${s.turns} turns · ${ago(s.mtimeMs)}\n   ${s.title}`).join('\n\n')
      await send(ctx, threadId, `Sessions in ${dir} (${list.length}):\n\n${body}`)
    }
    await send(ctx, threadId, `Run /import <dir> [dir2 …] to make a topic per session.`, true)
    return
  }
  if (cmd === '/fork') {
    if (ctx.chat.type !== 'supergroup') { await send(ctx, threadId, 'Run /fork inside the forum group — a fork needs its own topic, and topics are a supergroup feature.'); return }
    const e = sessions[key]
    if (!e?.sessionId) { await send(ctx, threadId, 'Nothing to fork yet — this topic has no session. Message me once first.'); return }
    const cwd = resolveCwd(ctx, threadId)
    const newId = forkTranscript(cwd, e.sessionId)
    if (!newId) { await send(ctx, threadId, `Could not fork: no transcript for session ${e.sessionId.slice(0, 8)} in ${projectDir(cwd)}.`); return }
    const name = forkTopicName({ label: text.split(/\s+/).slice(1).join(' '), parentName: names[key], cwd })
    let tid: number
    try {
      const topic = await ctx.api.createForumTopic(chatId, name, TOPIC_ICON ? { icon_custom_emoji_id: TOPIC_ICON } : {})
      tid = topic.message_thread_id
    } catch (err) { await send(ctx, threadId, `Could not create the topic: ${err}`); return }
    const tkey = keyFor(chatId, tid)
    // The same directory, deliberately: the conversation being forked is ABOUT the
    // files in it, and its transcript is full of their absolute paths. A fork
    // pointed somewhere else would remember files it cannot see.
    sessions[tkey] = { cwd, sessionId: newId, updated: new Date().toISOString() }
    names[tkey] = name
    // Carry the topic's settings, or a fork silently drops to defaults and looks
    // like the model got worse.
    if (modes[key]) modes[tkey] = modes[key]
    if (models[key]) models[tkey] = models[key]
    if (efforts[key]) efforts[tkey] = efforts[key]
    if (voice[key]) voice[tkey] = voice[key]
    saveState()
    const tag = topicTag(tkey)
    // Both directions get a link, and the order is what makes that possible: the
    // parent's note has to exist before the fork can point at it, and the fork's
    // first message has to exist before the parent can point at that. So: post the
    // parent's note, post the fork's with a link back to it, then edit the parent's
    // to carry the link forward. A fork you cannot get back from — or that you
    // cannot tell where it came from — is a topic you will find later with no idea
    // what it is.
    const md = (text: string) => telegramify(sanitizeProse(text, 'markdownv2'), 'escape')
    const topic = topicLink(chatId, tid)
    const parentNote = await ctx.api.sendMessage(chatId, md(`🍴 Forked into ${topic ? `[${name}](${topic})` : name}. This topic is unchanged.`),
      { ...destOpts({ threadId, replyTo: msg.message_id }), parse_mode: 'MarkdownV2', disable_notification: true }).catch(() => null)

    const back = parentNote ? messageLink(chatId, threadId, parentNote.message_id) : undefined
    const from = names[key] ?? 'the topic it came from'
    const forkNote = await ctx.api.sendMessage(chatId, md(
      `🍴 Forked from ${back ? `[${from}](${back})` : from} — everything said there up to now is context here, and the two carry on separately from this point.\n\n` +
      `Same directory: \`${cwd}\`\n` +
      `Because it is shared, files for THIS topic go in \`./${OUTBOX_DIR}/${tag}/\` and what you send here lands in \`./${INBOX_DIR}/${tag}/\`.`),
      { ...destOpts({ threadId: tid }), parse_mode: 'MarkdownV2', disable_notification: true }).catch(() => null)

    const into = forkNote ? messageLink(chatId, tid, forkNote.message_id) : topic
    if (parentNote && into) {
      await ctx.api.editMessageText(chatId, parentNote.message_id,
        md(`🍴 Forked into [${name}](${into}). This topic is unchanged.`),
        { parse_mode: 'MarkdownV2' }).catch(() => {})
    }
    return
  }
  if (cmd === '/import') {
    const dirs = parseDirs(text)
    if (!dirs.length) { await send(ctx, threadId, 'Usage: /import <dir> [dir2 …]  (space-, comma- or newline-separated)'); return }
    if (ctx.chat.type !== 'supergroup') { await send(ctx, threadId, 'Run /import inside the forum group — topics are a supergroup feature.'); return }
    // Gather (dir, session) candidates across all dirs, skipping already-bound ones.
    const candidates: { dir: string; s: SessionInfo }[] = []
    for (const dir of dirs) {
      if (!isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) { await send(ctx, threadId, `skipped (not a directory): ${dir}`); continue }
      const bound = new Set(Object.entries(sessions).filter(([k, e]) => k.startsWith(`${chatId}:`) && e.cwd === dir).map(([, e]) => e.sessionId))
      for (const s of listSessions(dir)) if (!bound.has(s.id)) candidates.push({ dir, s })
    }
    if (!candidates.length) { await send(ctx, threadId, 'No new sessions to import (none found, or all already imported).'); return }
    candidates.sort((a, b) => b.s.mtimeMs - a.s.mtimeMs) // newest first, across all dirs
    const capped = candidates.slice(0, IMPORT_MAX_SESSIONS)
    // An import is a bulk operation: a topic, a bind note and a dozen backfilled
    // turns each. Notifying on every one of those buzzes the phone ~100 times, so
    // the whole run is silent except the final tally.
    await send(ctx, threadId, `Importing ${capped.length} session(s) from ${dirs.length} dir(s)${candidates.length > capped.length ? ` (newest ${capped.length} of ${candidates.length})` : ''}…`, true)
    let ok = 0
    for (const { dir, s } of capped) {
      try {
        const name = `${basename(dir)} · ${s.title}`.slice(0, 120)
        const topic = await ctx.api.createForumTopic(chatId, name, TOPIC_ICON ? { icon_custom_emoji_id: TOPIC_ICON } : {})
        const tid = topic.message_thread_id
        const tkey = keyFor(chatId, tid)
        sessions[tkey] = { cwd: dir, sessionId: s.id, updated: new Date().toISOString() }
        names[tkey] = name
        saveState()
        await send(ctx, tid, `📂 Bound to session ${s.id.slice(0, 8)} · ${dir}\n${s.turns} turns total — last ${Math.min(IMPORT_BACKFILL, s.turns)} below. Message here to continue it.`, true)
        for (const t of renderTurns(s.file, IMPORT_BACKFILL)) { await send(ctx, tid, t, true); await sleep(350) }
        ok++
        await sleep(500)
      } catch (e) { await send(ctx, threadId, `⚠️ couldn't import ${s.id.slice(0, 8)}: ${e}`) }
    }
    await send(ctx, threadId, `✅ Imported ${ok}/${capped.length} session(s).`)
    return
  }
  if (cmd === '/history') {
    const e = sessions[key]
    if (!e?.sessionId) { await send(ctx, threadId, 'No bound session in this topic yet — message me once, or /import one here.'); return }
    const n = Math.min(Math.max(parseInt(text.split(/\s+/)[1] || '15', 10) || 15, 1), 60)
    const file = join(projectDir(e.cwd), `${e.sessionId}.jsonl`)
    if (!existsSync(file)) { await send(ctx, threadId, `Session transcript not found:\n${file}`); return }
    const turns = renderTurns(file, n)
    // Re-posted history is a wall of old messages — never worth a notification each.
    await send(ctx, threadId, `— last ${turns.length} turns of ${e.sessionId.slice(0, 8)} —`, true)
    for (const t of turns) { await send(ctx, threadId, t, true); await sleep(300) }
    return
  }
  // Client-side CLI commands (/usage, /cost, …) — forward them rather than
  // rejecting: `claude -p "/usage"` answers them for free, without a turn.
  if (PASSTHROUGH.has(cmd)) {
    enqueue(key, () => handlePassthrough(ctx, threadId, key, text))
      .catch(e => console.error(`[error] passthrough ${key}: ${e}`))
    return
  }
  if (cmd) { await send(ctx, threadId, `Unknown command. Try /help`, true); return }

  // Interrupt mode: cancel the run in progress so this message starts immediately
  // (its reply arrives as a new message, after the interrupted one stops).
  if (isInterrupt(key) && jobsFor(key).length) {
    stopped.add(key)
    for (const j of jobsFor(key)) void endJob(j, 'discard')
  }
  noteAsk(key, msg.message_id)
  // You rarely know in advance that a task will be long; what you know is that you
  // are now stuck behind one. So the choice is offered at that moment rather than
  // requiring /bg up front. Doing nothing queues, exactly as before.
  // Anything already queued or running here means this message waits — which is
  // the only condition that matters, and it is true from the first second.
  if ((inFlight[key] ?? 0) > 0) {
    const ahead = jobsFor(key)[0]
    const waited = ahead ? Math.max(1, Math.round((Date.now() - ahead.startedAt) / 1000)) : 0
    const how = waited >= 90 ? `${Math.round(waited / 60)}m` : `${waited}s`
    const offer = await ctx.api.sendMessage(ctx.chat.id,
      ahead ? `⏳ Still working on an earlier message (${how}). This one will run after it.`
            : `⏳ Something is already queued here. This one will run after it.`,
      { ...destOpts({ threadId, replyTo: msg.message_id }), disable_notification: true,
        reply_markup: { inline_keyboard: [[{ text: PARALLEL_LABEL, callback_data: `par:${msg.message_id}` }]] } },
    ).catch(() => null)
    offered.set(msg.message_id, { key, threadId, prompt: text, offerMsgId: offer?.message_id })
  }
  enqueue(key, () => handlePrompt(ctx, threadId, key, text, undefined, msg.message_id))
    .catch(e => console.error(`[error] task ${key}: ${e}`))
})

// The bot cannot set a group photo the moment it's added — it isn't an admin yet,
// and the chat usually isn't allowlisted yet either. The promotion is the first
// point where it's actually possible, so retry there rather than making the user
// restart the bridge to pick it up.
bot.on('my_chat_member', async ctx => {
  const status = ctx.myChatMember.new_chat_member.status
  if (status !== 'administrator') return
  await ensureGroupLogo(ctx.chat.id)
})

// The /mode keyboard. The topic is taken from the message the button lives on,
// so callback_data only has to carry the mode (it's capped at 64 bytes).
bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data
  if (!isAllowed(ctx)) { await ctx.answerCallbackQuery({ text: 'Not authorized.', show_alert: true }).catch(() => {}); return }
  const key = keyFor(ctx.chat!.id, ctx.callbackQuery.message?.message_thread_id)
  if (data.startsWith('fanc:')) {
    const f = fanouts.get(data.slice(5))
    if (!f) { await ctx.answerCallbackQuery({ text: 'That fan-out is no longer available.', show_alert: true }).catch(() => {}); return }
    const before = f.children.filter(c => c.topicId !== undefined).length
    // Forced: the button says delete, so it deletes regardless of the default.
    await disposeFanoutTopics(ctx, f, 'delete')
    await ctx.answerCallbackQuery({ text: `Deleted ${before} part topic${before === 1 ? '' : 's'}.` }).catch(() => {})
    // Rewritten rather than removed. It said the topics were still open, which your
    // tap has just made false — but deleting it takes the record with it, and weeks
    // later "where did those topics go" has no answer in the chat. So it becomes the
    // record: what happened, who decided it, and how many went.
    const done = `✅ Fan-out finished — you deleted ${before} part topic${before === 1 ? '' : 's'}. The combined answer above is what remains of them.`
    const edited = await ctx.editMessageText(done, { reply_markup: { inline_keyboard: [] } })
      .then(() => true).catch(() => false)
    if (!edited) await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    return
  }
  if (data.startsWith('fanf:')) {
    const f = fanouts.get(data.slice(5))
    if (!f) { await ctx.answerCallbackQuery({ text: 'That fan-out is no longer available.', show_alert: true }).catch(() => {}); return }
    // Whatever an interrupted part managed to say still counts; one that said
    // nothing is reported as not completed rather than quietly dropped.
    for (const c of f.children) if (c.status === 'stopped') c.status = c.result ? 'done' : 'failed'
    await ctx.answerCallbackQuery({ text: 'Combining what the parts have.' }).catch(() => {})
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    await maybeSynthesise(ctx, f)
    return
  }
  if (data.startsWith('fanr:')) {
    const f = fanouts.get(data.slice(5))
    if (!f) { await ctx.answerCallbackQuery({ text: 'That fan-out is no longer available.', show_alert: true }).catch(() => {}); return }
    await ctx.answerCallbackQuery({ text: 'Combining again…' }).catch(() => {})
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    f.synthesised = false
    await maybeSynthesise(ctx, f)
    return
  }
  if (data.startsWith('fanx:')) {
    const f = fanouts.get(data.slice(5))
    if (f) { fanouts.delete(f.id); saveState() }
    await ctx.answerCallbackQuery({ text: 'Dropped.' }).catch(() => {})
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    return
  }
  if (data.startsWith('fan:')) {
    const f = fanouts.get(data.slice(4))
    if (!f) {
      // Plans made before this version were only ever in memory, so a restart lost
      // them. Say which it is rather than leaving it looking arbitrary.
      await ctx.answerCallbackQuery({
        text: 'That plan is gone — it was proposed before the bridge last restarted, or it has already been run. Send /fanout again to get a fresh plan.',
        show_alert: true }).catch(() => {})
      return
    }
    if (f.children.some(c => c.status !== 'pending')) { await ctx.answerCallbackQuery({ text: 'Already running.' }).catch(() => {}); return }
    await ctx.answerCallbackQuery({ text: `Starting ${f.children.length} parts…` }).catch(() => {})
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    // Announce BEFORE starting anything. The parts get their topics as they start,
    // and each one re-renders this message — but a re-render that happens before the
    // message exists is a no-op, which left the list frozen on its first draft.
    await announceFanoutParts(ctx, f)
    await pumpFanout(ctx, f)
    saveState()          // no longer pending, so no longer restorable — drop it
    await refreshFanoutParts(ctx, f)   // catch any part that started before its turn
    return
  }
  if (data.startsWith('par:')) {
    const id = Number(data.slice(4))
    const rec = offered.get(id)
    // The offer goes stale the moment its turn comes up, which is why handlePrompt
    // drops the entry as it starts. Better to say so than to fork a second run of
    // something already running.
    if (!rec) { await ctx.answerCallbackQuery({ text: 'That one is already running.' }).catch(() => {}); return }
    offered.delete(id)
    skipQueued.add(id)                       // its queued turn must now do nothing
    await ctx.answerCallbackQuery({ text: 'Starting it now, alongside the other run.' }).catch(() => {})
    // Remove the offer entirely; a stripped-but-present aside is still clutter.
    if (rec.offerMsgId) await ctx.api.deleteMessage(ctx.chat!.id, rec.offerMsgId).catch(() => {})
    else await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    void enqueue(`${rec.key}#bg-${id}`,
      () => handlePrompt(ctx, rec.threadId, rec.key, rec.prompt, undefined, id, true, true))
      .catch(e => console.error(`[error] parallel ${rec.key}: ${e}`))
    return
  }
  if (data.startsWith('int:')) {
    const job = jobs.get(data.slice(4))
    if (!job) { await ctx.answerCallbackQuery({ text: 'That task already finished.', show_alert: true }).catch(() => {}); return }
    await ctx.answerCallbackQuery({ text: 'Interrupting — sending what it has so far…' }).catch(() => {})
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})   // one tap only
    void endJob(job, 'keep')
    return
  }
  if (data.startsWith('retry:')) {
    const rec = retryPrompts.get(data.slice(6))
    if (!rec) { await ctx.answerCallbackQuery({ text: 'That request has expired — send it again.', show_alert: true }).catch(() => {}); return }
    retryPrompts.delete(data.slice(6))
    await ctx.answerCallbackQuery({ text: 'Retrying…' }).catch(() => {})
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})   // one tap only
    void enqueue(rec.key, () => handlePrompt(ctx, rec.threadId, rec.key, rec.prompt, undefined, rec.replyTo, true))
      .catch(e => console.error(`[error] retry ${rec.key}: ${e}`))
    return
  }
  if (data.startsWith('effort:')) {
    const e = normalizeEffort(data.slice(7))
    if (e === undefined) { await ctx.answerCallbackQuery({ text: 'Unknown effort.' }).catch(() => {}); return }
    if (e) efforts[key] = e; else delete efforts[key]
    saveState()
    await ctx.answerCallbackQuery({ text: `Effort: ${effortLabel(key)}` }).catch(() => {})
    await ctx.editMessageText(effortText(key), { reply_markup: effortKeyboard(key) }).catch(() => {})
    return
  }
  if (data.startsWith('mode:')) {
    const m = normalizeMode(data.slice(5))
    if (!m) { await ctx.answerCallbackQuery({ text: 'Unknown mode.' }).catch(() => {}); return }
    modes[key] = m; saveState()
    await ctx.answerCallbackQuery({ text: `Mode: ${m}` }).catch(() => {})
    await ctx.editMessageText(modeText(key), { reply_markup: modeKeyboard(key) }).catch(() => {})
  } else if (data.startsWith('model:')) {
    const m = normalizeModel(data.slice(6))
    if (m === undefined) { await ctx.answerCallbackQuery({ text: 'Unknown model.' }).catch(() => {}); return }
    if (m) models[key] = m; else delete models[key]
    saveState()
    await ctx.answerCallbackQuery({ text: `Model: ${m || MODEL_DEFAULT}` }).catch(() => {})
    await ctx.editMessageText(modelText(key), { reply_markup: modelKeyboard(key) }).catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Startup — single clean start. A 409 means another instance owns the token;
// we exit with a clear message rather than fight it (only one poller per token).
// ---------------------------------------------------------------------------

// Give the bot its default avatar if it has none. Telegram exposes the bot's own
// photos through getUserProfilePhotos on its own id, and setMyProfilePhoto sets
// them — no BotFather round-trip. Never fatal: a bot with no picture still works.
async function ensureBotLogo(botId: number): Promise<void> {
  if (!SET_LOGO) return
  try {
    const photos = await bot.api.getUserProfilePhotos(botId, { limit: 1 })
    if (photos.total_count > 0) return
    if (!existsSync(BOT_LOGO)) { console.log(`[warn] no bot logo at ${BOT_LOGO} (set TG_BOT_LOGO, or TG_SET_LOGO=0)`); return }
    await setBotLogo()
    console.log(`[ok] set bot profile photo from ${BOT_LOGO}`)
  } catch (e) { console.error(`[warn] could not set bot logo: ${e}`) }
}
const setBotLogo = () => bot.api.setMyProfilePhoto({ type: 'static', photo: new InputFile(BOT_LOGO) })
const setGroupLogo = (chatId: number | string) => bot.api.setChatPhoto(chatId, new InputFile(GROUP_LOGO))

// Give each allowed group a photo if it has none. Deliberately never replaces an
// existing one — a group's photo belongs to the people in it, and a bot restart
// is not consent to change it. /logo group is the way to say so explicitly.
// Needs the bot to be an admin with can_change_info; a failure is only logged.
async function ensureGroupLogo(id: number | string): Promise<void> {
  if (!SET_GROUP_LOGO || !existsSync(GROUP_LOGO)) return
  if (!ALLOWED_CHATS.has(String(id))) return // never redecorate a group we don't serve
  try {
    const chat = await bot.api.getChat(id)
    if (chat.type === 'private' || (chat as any).photo) return
    await setGroupLogo(id)
    console.log(`[ok] set group photo for ${id} from ${GROUP_LOGO}`)
  } catch (e) { console.error(`[warn] could not set group photo for ${id}: ${e}`) }
}
async function ensureGroupLogos(): Promise<void> {
  for (const id of ALLOWED_CHATS) await ensureGroupLogo(id)
}

async function main() {
  const me = await bot.api.getMe()
  botUsername = me.username
  await ensureBotLogo(me.id)
  await ensureGroupLogos()
  console.log(`[ok] @${me.username} up`)
  console.log(`     claude bin     : ${CLAUDE_BIN}`)
  console.log(`     sessions base  : ${SESSIONS_BASE}`)
  console.log(`     default cwd    : ${DEFAULT_WORKDIR}`)
  console.log(`     permission     : ${PERMISSION_MODE}`)
  console.log(`     api            : ${API_ROOT || 'https://api.telegram.org (cloud)'}`)
  console.log(`     allowed users  : ${[...ALLOWED_USERS].join(', ') || '(none — set TG_ALLOWED_USERS!)'}`)
  console.log(`     allowed chats  : ${[...ALLOWED_CHATS].join(', ') || '(none)'}`)
  console.log(`     trust chat mem : ${TRUST_CHAT_MEMBERS ? 'yes (any member of an allowed chat)' : 'no'}`)
  // With no users AND no chat-member trust, isAllowed() rejects everyone: the bot
  // polls happily while silently dropping every message. That looked like "the bot
  // died" once already, so make it unmistakable rather than a passing warning.
  if (ALLOWED_USERS.size === 0 && !TRUST_CHAT_MEMBERS) {
    console.error('[FATAL] TG_ALLOWED_USERS is empty and TG_TRUST_CHAT_MEMBERS is off —')
    console.error('        nothing can authorize, so every message would be dropped silently.')
    console.error('        Set TG_ALLOWED_USERS=<your id> (DM the bot /whoami), or TG_TRUST_CHAT_MEMBERS=1.')
    process.exit(2)
  }

  // Clear stale pending updates (e.g. a message buffered before a restart) so
  // we don't reprocess old messages on startup.
  // Refuse to become a second poller. Telegram allows one getUpdates per token, so
  // two bridges on one deployment produce the 409 that start.sh's sleeps and
  // respawn.sh's back-off exist to survive. Declining here makes the collision
  // impossible for this deployment instead of merely recoverable.
  const other = otherLiveBridge()
  if (other) {
    console.error(`[fatal] another bridge (pid ${other}) is already serving this deployment in ${process.cwd()}`)
    console.error(`[fatal] refusing to start a second poller — stop it first, or redeploy with ./update.sh`)
    process.exit(1)
  }
  try { mkdirSync(dirname(PID_FILE), { recursive: true }); writeFileSync(PID_FILE, String(process.pid)) } catch {}

  // And refuse to be a second poller for this TOKEN, wherever it runs from. The
  // check above only covers this deployment; two checkouts sharing a token each
  // pass it and then fight over the same update queue.
  const lockPath = tokenLockPath(TOKEN)
  const holder = lockHolder(lockPath)
  if (holder) {
    console.error(`[fatal] another bridge (pid ${holder.pid}) in ${holder.cwd} is already polling this bot token`)
    console.error(`[fatal] two pollers share one update queue, so messages would be split between them — refusing to start`)
    console.error(`[fatal] stop that instance, or give this deployment its own TELEGRAM_BOT_TOKEN`)
    try { rmSync(PID_FILE, { force: true }) } catch {}
    try { rmSync(tokenLockPath(TOKEN), { force: true }) } catch {}
    process.exit(EXIT_TOKEN_HELD)
  }
  takeLock(lockPath)
  pruneStaleLocks(lockPath)

  // Drop the backlog only when we did NOT shut down cleanly. A deliberate restart
  // is a window in which a user's message would otherwise vanish silently — and
  // /restart makes that window a routine event rather than a rare one. After a
  // crash the backlog is still dropped: replaying a queue into a build that just
  // died is the worse risk.
  let cleanRestart = false
  try {
    if (existsSync(CLEAN_EXIT_MARKER)) { cleanRestart = true; rmSync(CLEAN_EXIT_MARKER, { force: true }) }
  } catch {}
  if (cleanRestart) console.log('[ok] clean restart — keeping messages received while down')
  await bot.api.deleteWebhook({ drop_pending_updates: !cleanRestart }).catch(() => {})

  // Delete any "💭 Thinking…" status messages orphaned by a restart that killed
  // a run mid-flight, so no dangling status is left in a topic.
  if (pending.length) {
    for (const p of pending) await bot.api.deleteMessage(p.chat, p.id).catch(() => {})
    console.log(`[ok] cleaned ${pending.length} orphaned status message(s)`)
    pending = []; saveState()
  }

  // Resilient polling via @grammyjs/runner. The runner treats a 409 as fatal
  // (normally it means a real second instance). In our case a 409 right after a
  // restart is the PREVIOUS process's long-poll still reserved server-side
  // (~30s). So on 409 we wait it out and resume — this self-heals the cycle
  // instead of crash-looping. A genuine second poller just keeps it waiting.
  //
  // Since we now hold a token lock, the two causes can be told apart after a few
  // rounds: see conflictAdvice() in ./lib for which is which and why the advice
  // differs. Retrying is correct either way, so only the diagnosis changes.
  let handle: RunnerHandle | undefined
  let conflicts = 0

  // Graceful drain. The previous handler stopped polling and then exited at once,
  // which abandoned every in-flight `claude` child and threw away replies that had
  // been paid for but not yet delivered. Nothing in the bridge prevented that — the
  // only thing that did was update.sh externally polling /proc for an idle moment
  // before signalling. So the guarantee lived in a shell script inferring state
  // from the outside, while the process holding the job registry and queues (the actual
  // answer) did nothing with them.
  //
  // Now: stop accepting new messages, let the runs that are already going finish
  // and deliver, then exit 0. Exiting 0 matters — respawn.sh reads it to decide
  // whether to come back immediately or wait out the 409 back-off.
  let draining = false
  const drain = async (why: string): Promise<void> => {
    if (draining) return
    draining = true
    console.log(`[drain] ${why} — not accepting new messages; ${jobs.size} run(s) in flight`)
    try { await handle?.stop() } catch {}          // stop fetching updates
    const deadline = Date.now() + DRAIN_MAX_MS
    while (jobs.size > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 250))
    if (jobs.size > 0) {
      // A hung child never exits, so this cap is the difference between a bounded
      // shutdown and one that hangs forever holding the token.
      console.error(`[drain] cap reached with ${jobs.size} run(s) still active — exiting anyway`)
    } else {
      // A run can be finished while its reply is still being sent; the queue chain
      // is what tracks that, so wait on it too.
      await Promise.allSettled([...queues.values()])
      console.log('[drain] all runs finished and delivered')
    }
    try { writeFileSync(CLEAN_EXIT_MARKER, new Date().toISOString()) } catch {}
    try { rmSync(PID_FILE, { force: true }) } catch {}
    console.log('[bye]')
    process.exit(0)
  }
  requestDrain = drain
  process.once('SIGINT', () => void drain('SIGINT'))
  process.once('SIGTERM', () => void drain('SIGTERM'))
  process.once('SIGHUP', () => void drain('SIGHUP'))

  for (let attempt = 1; ; attempt++) {
    handle = run(bot)
    console.log(`[ok] polling Telegram${attempt > 1 ? ` (resumed #${attempt})` : ''}`)
    try {
      await handle.task()
      return // stopped cleanly
    } catch (e: any) {
      if (!(e?.error_code === 409 || String(e).includes('409'))) throw e
      try { await handle.stop() } catch {}
      conflicts++
      // Print the full explanation once, when the diagnosis actually changes, then
      // stay terse — this loop can run for hours and the log has other readers.
      if (conflicts <= GHOST_CONFLICTS || conflicts === GHOST_CONFLICTS + 1) {
        for (const line of conflictAdvice(conflicts, { ghostLimit: GHOST_CONFLICTS, waitMs: CONFLICT_WAIT_MS })) {
          console.error(`[warn] ${line}`)
        }
      } else {
        console.error(`[warn] 409 conflict (#${conflicts}) — still held by an instance outside this user/machine; retrying`)
      }
      await new Promise(r => setTimeout(r, CONFLICT_WAIT_MS))
    }
  }
}
// Test seam (bridge.e2e.test.ts): await a topic's queue so a test can wait out the
// fire-and-forget handlePrompt chain kicked off by an incoming message. The bot only
// starts polling when this file is run directly, never when it is imported.
// Test seam (bridge.e2e.test.ts): the startup mutex's staleness rules decide
// whether a redeploy is allowed to proceed, so they are worth pinning directly.
export function _otherLiveBridge(): number | undefined { return otherLiveBridge() }
export const _tokenLockPath = tokenLockPath
export const _lockHolder = lockHolder
export const _procStartTime = procStartTime
export const _PID_FILE = PID_FILE

export const _makeWorktree = makeWorktree
export const _disposeFanoutTopics = disposeFanoutTopics
export const _fanouts = fanouts
export const _sessions = () => sessions
export const _projectDir = projectDir
export const _boxDir = boxDir
export const _maybeSynthesise = maybeSynthesise

export function _drainQueue(key: string): Promise<unknown> { return queues.get(key) ?? Promise.resolve() }

// Guarded so the module can be imported by a test without starting a poller.
if (import.meta.main) main().catch(e => { console.error(`[fatal] ${e}`); process.exit(1) })
