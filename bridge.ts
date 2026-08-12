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
import { spawn, type ChildProcess } from 'node:child_process'
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
      // migrate old boolean state: true → 'full', false/other → off
      for (const k of Object.keys(voice)) { const v: any = voice[k]; if (v === true) voice[k] = 'full'; else if (v !== 'full' && v !== 'summary') delete voice[k] }
    }
  } catch (e) { console.error(`[warn] could not read state (${e}); starting empty`) }
}
function saveState(): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({ sessions, names, pending, interruptMode, modes, models, efforts, voice }, null, 2))
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

const activeRuns = new Map<string, ChildProcess>()
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
async function runStreaming(ctx: Context, threadId: number | undefined, key: string, prompt: string, cwd: string, resumeId?: string, mode: string = PERMISSION_MODE, model: string = MODEL, onInit?: (sessionId: string) => void, effort: string = EFFORT_TIER): Promise<ClaudeResult> {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...permissionArgs(mode)]
  if (TELEGRAM_PROFILE.trim()) args.push('--append-system-prompt', TELEGRAM_PROFILE)
  if (resumeId) args.push('--resume', resumeId)
  if (model) args.push('--model', model)
  if (effort) args.push('--effort', effort)

  const opts: any = threadId ? { message_thread_id: threadId } : {}
  // Status is machine chatter, not an answer — post and edit it silently so only
  // the real reply buzzes the user's phone.
  const status = await ctx.api.sendMessage(ctx.chat!.id, THINKING, { ...opts, disable_notification: true }).catch(() => null)
  if (status) { pending.push({ chat: ctx.chat!.id, id: status.message_id }); saveState() }
  const steps: Step[] = []
  let lastEdit = 0, dirty = false
  // Reset by every stream event; drives both the staleness note and the watchdog.
  let lastEventAt = Date.now()
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
    while (body.length > 15000 && shown.length > 1) { shown = shown.slice(1); body = renderSteps(shown, steps.length, undefined, note) }
    try {
      await ctx.api.raw.editMessageText({ chat_id: ctx.chat!.id, message_id: status.message_id, rich_message: { markdown: body } })
    } catch {
      // Same posture as sendRich: formatting is best-effort, the update is not.
      try {
        await ctx.api.editMessageText(ctx.chat!.id, status.message_id, renderStepsHtml(shown), { parse_mode: 'HTML' })
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
    const child = spawn(CLAUDE_BIN, args, { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    activeRuns.set(key, child)
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
      activeRuns.delete(key)
      if (status) {
        pending = pending.filter(p => !(p.chat === ctx.chat!.id && p.id === status.message_id)); saveState()
        // Keep the progress message as the record of the run when it holds
        // something the reply does not. Deleting it the instant the answer lands
        // is why the reasoning was unavailable BOTH during and after a run — on a
        // phone the user is usually not watching in real time.
        const carriesMore = textBlocks.length > 1 || (textBlocks.length === 1 && !res.text.includes(textBlocks[0]))
        const keep = PROGRESS_KEEP === 'keep' || (PROGRESS_KEEP !== 'off' && carriesMore)
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
async function receiveFile(ctx: Context, att: { fileId: string; name: string; size: number }, cwd: string): Promise<string> {
  if (att.size && att.size > TG_DOWNLOAD_LIMIT)
    throw new Error(
      `file is ${fmtBytes(att.size)}, over the ${fmtBytes(TG_DOWNLOAD_LIMIT)} the cloud Bot API lets bots fetch.\n` +
      `To lift this, run a local Bot API server and set TG_API_ROOT (see README) — or copy the file to ${cwd}/${INBOX_DIR}/ directly.`)
  const file = await ctx.api.getFile(att.fileId)
  if (!file.file_path) throw new Error('Telegram returned no file_path')
  const dest = uniquePath(ensureDir(join(cwd, INBOX_DIR)), safeName(att.name, extname(file.file_path)))
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
async function flushOutbox(ctx: Context, threadId: number | undefined, cwd: string, replyTo?: number): Promise<void> {
  const dir = join(cwd, OUTBOX_DIR)
  if (!existsSync(dir)) return
  let names: string[]
  try { names = readdirSync(dir) } catch { return }
  const sentDir = join(dir, '.sent')
  for (const n of names) {
    if (n.startsWith('.')) continue
    const p = join(dir, n)
    let st; try { st = statSync(p) } catch { continue }
    if (!st.isFile()) continue
    if (await sendFile(ctx, threadId, p))
      try { renameSync(p, uniquePath(ensureDir(sentDir), n)) } catch (e) { console.error(`[warn] archive outbox ${n}: ${e}`) }
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

async function handlePrompt(ctx: Context, threadId: number | undefined, key: string, prompt: string, mode?: string, replyTo?: number, forceReplyLink = false): Promise<void> {
  const cwd = resolveCwd(ctx, threadId)
  // Attribute the message before it reaches the model. Only here: handlePassthrough
  // and /compact send literal CLI commands, which are not somebody speaking.
  const framed = frameUserMessage(prompt, {
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
    const res = await runStreaming(ctx, threadId, key, framed, cwd, resumeId, mode ?? modeFor(key), modelFor(key), bindSession, effortFor(key))
    if (stopped.has(key)) { stopped.delete(key); return } // killed via /stop — status already cleared, no reply
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
    const link = replyLink()
    await deliver(ctx, threadId, res.text, link)
    await flushOutbox(ctx, threadId, cwd, link)
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

  // File uploads: save into this topic's inbox. A caption (if any) runs as a prompt.
  // Voice note (or round video) → transcribe → run as a prompt, when the topic is
  // in voice mode. handlePrompt then speaks the answer back. Otherwise it falls
  // through to the generic attachment path (saved to inbox).
  if ((msg.voice || msg.video_note) && voiceMode(keyFor(chatId, threadId)) !== 'off') {
    if (!isAllowed(ctx)) return
    const vKey = keyFor(chatId, threadId)
    const att = pickAttachment(msg)!
    console.log(`[in] chat=${chatId} topic=${threadId ?? '-'} from=${ctx.from.id} 🎙 voice (${fmtBytes(att.size)})`)
    if (isInterrupt(vKey) && activeRuns.has(vKey)) { stopped.add(vKey); activeRuns.get(vKey)!.kill('SIGKILL') }
    enqueue(vKey, async () => {
      const cwd = resolveCwd(ctx, threadId)
      let saved: string
      try { saved = await receiveFile(ctx, att, cwd) }
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
      try { saved = await receiveFile(ctx, attachment, cwd) }
      catch (e) { await send(ctx, threadId, `⚠️ couldn't save file: ${e}`); return }
      if (caption) {
        await handlePrompt(ctx, threadId, aKey, `[The user attached a file, saved at ${saved} (./${relative(cwd, saved)}).]\n\n${caption}`, undefined, ctx.message?.message_id)
      } else {
        await send(ctx, threadId, `📎 Saved → ${saved}\n(in ./${relative(cwd, saved)} — reference it in your next message)`, true)
      }
    }).catch(e => console.error(`[error] file task ${aKey}: ${e}`))
    return
  }

  const text = msg.text?.trim()
  if (!text) return
  const key = keyFor(chatId, threadId)
  console.log(`[in] chat=${chatId}(${ctx.chat.type}) topic=${threadId ?? '-'} from=${ctx.from.id} ${JSON.stringify(text).slice(0, 100)}`)

  const cmd = text.startsWith('/') ? text.split(/\s+/)[0].replace(/@.*$/, '').toLowerCase() : ''

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
      `/stop — cancel the task currently running in this topic\n` +
      `/restart — restart the bridge; in-flight tasks finish first\n` +
      `/interrupt [on|off] — new messages cancel the running task instead of queueing\n` +
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
    const n = activeRuns.size
    await send(ctx, threadId, n > 0
      ? `♻️ Restarting — finishing ${n} run${n === 1 ? '' : 's'} first. Messages you send while I'm down will still be picked up.`
      : `♻️ Restarting — back in a moment. Messages you send while I'm down will still be picked up.`)
    // Deliberately not awaited. The drain stops the runner, and the runner waits
    // for its handlers to return — awaiting our own shutdown from inside a handler
    // would deadlock.
    void requestDrain(`/restart from ${ctx.from?.id ?? 'unknown'}`)
    return
  }
  if (cmd === '/stop' || cmd === '/cancel') {
    const child = activeRuns.get(key)
    if (child) { stopped.add(key); child.kill('SIGKILL'); await send(ctx, threadId, '🛑 Stopped the running task.') }
    else await send(ctx, threadId, 'Nothing is running in this topic right now.', true)
    return
  }
  if (cmd === '/interrupt') {
    const arg = text.split(/\s+/)[1]?.toLowerCase()
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
    if (isInterrupt(key) && activeRuns.has(key)) { stopped.add(key); activeRuns.get(key)!.kill('SIGKILL') }
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
  if (isInterrupt(key) && activeRuns.has(key)) {
    stopped.add(key)
    activeRuns.get(key)!.kill('SIGKILL')
  }
  noteAsk(key, msg.message_id)
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
  // from the outside, while the process holding activeRuns and queues (the actual
  // answer) did nothing with them.
  //
  // Now: stop accepting new messages, let the runs that are already going finish
  // and deliver, then exit 0. Exiting 0 matters — respawn.sh reads it to decide
  // whether to come back immediately or wait out the 409 back-off.
  let draining = false
  const drain = async (why: string): Promise<void> => {
    if (draining) return
    draining = true
    console.log(`[drain] ${why} — not accepting new messages; ${activeRuns.size} run(s) in flight`)
    try { await handle?.stop() } catch {}          // stop fetching updates
    const deadline = Date.now() + DRAIN_MAX_MS
    while (activeRuns.size > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 250))
    if (activeRuns.size > 0) {
      // A hung child never exits, so this cap is the difference between a bounded
      // shutdown and one that hangs forever holding the token.
      console.error(`[drain] cap reached with ${activeRuns.size} run(s) still active — exiting anyway`)
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

export function _drainQueue(key: string): Promise<unknown> { return queues.get(key) ?? Promise.resolve() }

// Guarded so the module can be imported by a test without starting a poller.
if (import.meta.main) main().catch(e => { console.error(`[fatal] ${e}`); process.exit(1) })
