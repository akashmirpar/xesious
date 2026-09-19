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
import { Bot, InputFile, InputMediaBuilder, type Context } from 'grammy'
import { run, type RunnerHandle } from '@grammyjs/runner'
import telegramify from 'telegramify-markdown'
import { autoRetry } from '@grammyjs/auto-retry'
import { apiThrottler } from '@grammyjs/transformer-throttler'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, renameSync, mkdtempSync, rmSync, copyFileSync, readlinkSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname, join, isAbsolute, basename, extname, resolve, relative } from 'node:path'
import { homedir, tmpdir, freemem as osFreemem } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import {
  parseIdList, keyFor, sanitize, encodeCwd, parseDirs,
  MODE_HELP, allowedModes, MODEL_ALIASES, MODEL_DEFAULT, normalizeModel,
  EFFORT_LEVELS, EFFORT_DEFAULT, normalizeEffort,
  parseStreamLine, type Step, THINKING, RUN_RECORD, conflictAdvice, isNonAnswer, promoteBlock, stalenessNote,
  markdownToHtml, htmlDocument, previewCut, transcriptSpeech, lastEffortFrom, needsReplyLink,
  speechUnits, speechChunkSeconds, SPEAKERS, SPEAKER_PAGE, SPEAKER_DEFAULT, kokoroLang, isSpeakerId, speakerLabel,
  speechToc, fullAudioCaption, readAlongHtml, fmtDurationWords, speechEstimateSeconds, type SpeechUnit, type UnitTiming,
  needsSpeechNormalising,
  fanoutPlanPrompt, parseFanoutPlan, renderFanoutProposal, buildSynthesisPreamble,
  FANOUT_MARK, fanoutTopicName, topicLink, topicTag, messageLink, forkTopicName, filesPreamble,
  type FanoutPlanItem,
  frameUserMessage, attributionProfileLines,
  needsRich, sanitizeProse,
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
// The old 1400-character cap is gone: a long answer was cut off around a fifth of
// the way in, mid-sentence, with nothing said about it. It survives only as the
// SUMMARY-mode safety net, where a couple of sentences is the point.
const VOICE_SPEAK_MAX = Math.max(200, Number(process.env.TG_VOICE_MAX_CHARS || 1400))
// Progressive delivery: speak.py emits a voice note as soon as each chunk is ready
// rather than after the whole answer, so the first audio lands in ~40s instead of
// after everything. Kokoro only — it needs the raw-samples API to insert real
// silence and to concatenate the full file at the end.
// Overridable like TG_STT_CMD and TG_TTS_CMD, and for the same reason: tier 2 has to
// reach the progressive path without paying for real synthesis, which runs at about
// realtime and would make the suite minutes long.
const SPEAK_PY = process.env.TG_SPEAK_CMD || join(HERE, 'voice', 'speak.py')
const KOKORO_MODEL = process.env.TG_KOKORO_MODEL || join(HERE, 'voice', 'kokoro', 'kokoro-v1.0.onnx')
// The single knob for people who want one note however long it takes.
const VOICE_CHUNKED = !/^(0|false|no)$/i.test(process.env.TG_VOICE_CHUNKED || '')
// Whether the progressive notes are SENT by default. Off: synthesis is unchanged and
// still chunk-by-chunk, but the parts are held and only the full file goes out, so a
// spoken answer costs one status bubble instead of five messages of audio — four of
// them audio and the same audio twice over. On: today's behaviour for every answer.
// Per topic with /voice parts; this is only the fallback.
const VOICE_PARTS_DEFAULT = /^(1|true|yes)$/i.test(process.env.TG_VOICE_PARTS || '')
// NOTHING deletes a voice note on its own, and there is no setting that makes it.
//
// There was a TG_VOICE_TIDY knob, and briefly a rule that parts you had opted into
// were cleared once the full file landed — the reasoning being that you must be
// finished with them by then. You are not. The full file arrives exactly when a
// listener is most likely mid-chunk, and deleting the note that is playing stops
// playback dead. Asking for the parts is, if anything, a reason to expect them to
// stay. The 🧹 button on the full file is the only way they go, and that is a tap.
// A read-along page embeds its audio as a data: URI to stay self-contained, so its
// size grows with the answer. Past this it is skipped rather than silently producing
// a page tens of megabytes wide.
// How long an answer may be and still get a read-along page.
//
// This was a flat 20 minutes, and it fired SILENTLY on exactly the answers the page
// is most useful for — reported after a five-transcript answer arrived with its
// audio, its answer.md and its answer.html, and no page, the only trace being one
// line in bridge.log that you would have to ssh in to find.
//
// Twenty minutes was a guess, not a measurement, and it was nowhere near what
// actually breaks. The page embeds the .ogg as a base64 data: URI, so its size is
// what matters, and the hard limit on that is what Telegram will accept from a bot:
// TG_UPLOAD_LIMIT, 50 MB on the cloud API and 2000 MB with a local one. At speak.py's
// 32 kbps opus that is ~240 KB of audio per minute, ~320 KB per minute once base64
// has added its third — so the cloud cap is about 156 minutes of speech, not 20.
//
// Derived rather than hardcoded so a local Bot API server lifts it automatically.
// 0 still means "no read-along at all", which is the only thing this knob used to
// be able to express clearly.
const READALONG_BYTES_PER_MIN = 320 * 1024
const READALONG_MAX_MIN = Math.max(0, Number(
  process.env.TG_VOICE_READALONG_MAX_MIN || Math.floor(TG_UPLOAD_LIMIT / READALONG_BYTES_PER_MIN)))

// Importing existing Claude Code sessions (the ones the IDE/CLI session picker
// shows) as topics. A directory's sessions live at CLAUDE_PROJECTS/<encoded>/<id>.jsonl.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const CLAUDE_PROJECTS = join(CLAUDE_DIR, 'projects')
const IMPORT_BACKFILL = Math.max(0, Number(process.env.TG_IMPORT_BACKFILL || 12))  // turns backfilled per session
const IMPORT_MAX_SESSIONS = Math.max(1, Number(process.env.TG_IMPORT_MAX || 10))   // cap topics created per /import
const REPLY_FILE_CHARS = Math.max(0, Number(process.env.TG_REPLY_FILE_CHARS || 6000)) // replies longer than this go as a file
// The one question both the file delivery and the read-along page ask, so they can
// never drift apart: is this answer long enough to arrive as answer.md/.html?
// The read-along is a companion to those files — it is the same answer, laid out to
// be read while it is spoken — so an answer short enough to sit inline in the chat
// gets a voice note and nothing else. A 30-second reply does not need a document.
function answerGoesToFile(text: string): boolean {
  return !!REPLY_FILE_CHARS && text.length > REPLY_FILE_CHARS
}
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
// Per topic, like every other thing a user tunes. The speaker used to be a
// deployment-wide constant: voiceEnv() copied TG_KOKORO_VOICE out of the bridge's
// OWN environment, so changing it meant editing .env and restarting.
let speakers: Record<string, string> = {}
// Whether this topic wants the progressive notes SENT, not merely synthesised.
// Sticky per topic because the preference is stable — someone who wants parts wants
// them every time — with the status message's button as the per-answer override in
// whichever direction this is not.
let voiceParts: Record<string, boolean> = {}
function voiceMode(key: string): 'off' | 'full' | 'summary' {
  const v = voice[key]
  if (v === 'full' || v === 'summary') return v
  if (v === undefined) return VOICE_DEFAULT ? 'full' : 'off'
  return 'off'
}
function partsMode(key: string): boolean {
  const v = voiceParts[key]
  return v === undefined ? VOICE_PARTS_DEFAULT : v
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
      speakers = o.speakers ?? {}
      voiceParts = o.voiceParts ?? {}
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
    writeFileSync(STATE_FILE, JSON.stringify({ sessions, names, pending, interruptMode, modes, models, efforts, voice, speakers, voiceParts,
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
    dir = name ? uniqueTopicDir(sanitize(name), key, threadId) : join(SESSIONS_BASE, `topic-${threadId}`)
  }
  ensureDir(dir)
  sessions[key] = { ...(sessions[key] ?? {}), cwd: dir }
  saveState()
  return dir
}
// A directory for a NAMED topic that no other topic has already claimed.
//
// Two topics legitimately named "notes" would otherwise share one cwd — one git
// repo, one set of files, and (for anything the model drops in the shared root
// ./outbox/ rather than its own tagged subdir) one delivery race. So the plain
// name is used when it is free, and the thread id is appended when it is not:
// `notes`, then `notes-96`. The suffix is the topic's own id rather than a
// counter because that is the one value already guaranteed unique per chat, and
// it makes the directory traceable back to the topic that owns it.
//
// The check-then-claim looks racy and is not: resolveCwd is fully synchronous and
// writes sessions[key] before it returns, so no other topic can be resolved in
// between on a single-threaded runtime.
function uniqueTopicDir(base: string, key: string, threadId: number): string {
  const claimed = new Set<string>()
  for (const [k, e] of Object.entries(sessions)) if (k !== key && e?.cwd) claimed.add(resolve(e.cwd))
  const free = (d: string) => !claimed.has(resolve(d))
  const first = join(SESSIONS_BASE, base)
  if (free(first)) return first
  // Thread ids are unique within a chat but not across chats, so the id alone can
  // still land on a taken directory; the counter is the last resort, not the norm.
  const withId = join(SESSIONS_BASE, `${base}-${threadId}`)
  if (free(withId)) return withId
  for (let n = 2; n < 1000; n++) {
    const d = join(SESSIONS_BASE, `${base}-${threadId}-${n}`)
    if (free(d)) return d
  }
  return withId
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
// `key` is optional only because the STT side has no topic-specific settings. On
// the TTS side it is what turns the speaker from a deployment-wide constant into a
// per-topic choice: the topic's voice OVERRIDES what the bridge inherited.
function voiceEnv(key?: string): NodeJS.ProcessEnv {
  const e = childEnv()
  for (const k of ['TG_TTS_ENGINE', 'TG_KOKORO_VOICE', 'TG_KOKORO_MODEL', 'TG_KOKORO_VOICES', 'TG_KOKORO_SPEED', 'TG_KOKORO_LANG',
                   'TG_PIPER_VOICE', 'TG_PIPER_BIN', 'TG_ESPEAK_VOICE', 'TG_ESPEAK_WPM', 'TG_STT_MODEL', 'TG_STT_LANG', 'TG_FFMPEG']) {
    if (process.env[k]) e[k] = process.env[k]
  }
  const sp = key ? speakers[key] : undefined
  if (sp) {
    e.TG_KOKORO_VOICE = sp
    // Kokoro's lang must match the voice or pronunciation degrades — a British
    // voice read with en-us is the audible version of this bug.
    e.TG_KOKORO_LANG = kokoroLang(sp)
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
  // Skip the live status message entirely. For runs the user did not experience as
  // a "turn": /usage and friends take no model time, so the status flashed for two
  // seconds offering an Interrupt button for a run that does nothing.
  silent?: boolean
}
async function runStreaming(ctx: Context, threadId: number | undefined, key: string, prompt: string, cwd: string, resumeId?: string, mode: string = PERMISSION_MODE, model: string = MODEL, ro: RunOpts = {}): Promise<ClaudeResult> {
  const { onInit, effort = EFFORT_TIER, askedBy, fork, silent } = ro
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
  const status = silent ? null : await ctx.api.sendMessage(ctx.chat!.id, THINKING,
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
    // setEncoding, so a multi-byte character split across two reads is not corrupted:
    // without it each chunk is decoded on its own and a path or title outside ASCII
    // comes back mangled.
    child.stdout.setEncoding('utf8')
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
async function sendLegacyMd(ctx: Context, opts: any, text: string): Promise<number | undefined> {
  // sanitizeProse runs AFTER mdTablesToCode so a flattened table is already inside
  // a fence and counts as protected code, and BEFORE telegramify, which is the
  // thing that mis-handles a lone tilde.
  const parts = chunk(mdTablesToCode(text))
  let last: number | undefined
  for (const part of parts) {
    try {
      const m = await ctx.api.sendMessage(ctx.chat!.id, telegramify(sanitizeProse(part, 'markdownv2'), 'escape'), { ...opts, parse_mode: 'MarkdownV2' })
      last = m.message_id
    } catch {
      const m = await ctx.api.sendMessage(ctx.chat!.id, stripMd(part), opts).catch(e => { console.error(`[warn] sendMessage: ${e}`); return undefined })
      last = m?.message_id
    }
  }
  return parts.length === 1 ? last : undefined
}

// needsRich (the rich-vs-MarkdownV2 routing rule) and sanitizeProse
// (the one escaping stage per dialect) are pure, so they live in ./lib and are
// unit-tested there. The long note on WHY rich is rationed is on needsRich, and the
// character table is on PROSE_RULES.

// Send Claude's answer, as a Bot API 10.1 rich message when the content actually
// needs one. Rich markdown is the dialect the agent already writes, so apart from
// the dollars above no escaping pass is needed. If the call fails we drop to the
// MarkdownV2 path — formatting is best-effort, delivery is guaranteed.
// Returns the message id when the answer was exactly ONE message, so the voice note
// can be threaded to the answer rather than to the question. Several chunks, or a
// send that fell back to a path whose id we do not see, yields undefined and the
// caller threads to the question instead.
async function sendRich(ctx: Context, threadId: number | undefined, text: string, replyTo?: number): Promise<number | undefined> {
  noteBotMessage(keyFor(ctx.chat!.id, threadId))
  const opts: any = destOpts({ threadId, replyTo })
  const parts = chunk(text, RICH_MAX)
  let only: number | undefined
  for (const part of parts) {
    if (!needsRich(part)) { only = await sendLegacyMd(ctx, opts, part); continue }
    try {
      const m: any = await ctx.api.sendRichMessage(ctx.chat!.id, { markdown: sanitizeProse(part, 'rich') }, opts)
      only = m?.message_id
    } catch (e) {
      console.error(`[warn] sendRichMessage, falling back to MarkdownV2: ${e}`)
      only = await sendLegacyMd(ctx, opts, part)
    }
  }
  return parts.length === 1 ? only : undefined
}
function startTyping(ctx: Context, threadId: number | undefined): () => void {
  const opts = threadId ? { message_thread_id: threadId } : {}
  const ping = () => ctx.api.sendChatAction(ctx.chat!.id, 'typing', opts).catch(() => {})
  ping(); const id = setInterval(ping, 4500); return () => clearInterval(id)
}

// ---------------------------------------------------------------------------
// Permission-mode UI (/mode + its inline keyboard)
// ---------------------------------------------------------------------------

// The /voice keyboard. Deliberately the same three lines as modeKeyboard and the
// model and effort keyboards, because /voice being a plain-text menu you type back
// at was an inconsistency rather than a missing feature.
//
// Speakers go two per row, which breaks the one-per-row rule those keyboards follow
// — justified because a speaker label is three words, not a sentence, and eight of
// them one per row is a scroll.
function voiceText(key: string): string {
  const p = probeVoice()
  const sp = speakers[key] || SPEAKER_DEFAULT
  return `🎙 Voice — ${voiceMode(key)}\n` +
    `Engine: ${p.engine}${p.speak ? '' : ' (not available — tap Install below)'}\n` +
    `Speaker: ${speakerLabel(sp)} (${sp})\n` +
    `Parts: ${partsMode(key) ? 'on — every chunk as its own note' : 'off — one status message, then the full file'}\n\n` +
    `The complete answer always comes as text, whatever this is set to.\n` +
    `${SPEAKERS.length} English voices here; /voice speaker <id> also reaches the ` +
    `Spanish, French, Hindi, Italian, Japanese, Portuguese and Chinese ones.`
}
// Paged, because all 28 English voices are offered rather than a hand-picked few and
// 14 rows is a scroll. Two per row is a deliberate exception to the one-per-row rule
// the other keyboards follow: a speaker label is three short tokens, not a sentence.
function voiceKeyboard(key: string, offset?: number): any {
  const mode = voiceMode(key)
  const sp = speakers[key] || SPEAKER_DEFAULT
  const pages = Math.max(1, Math.ceil(SPEAKERS.length / SPEAKER_PAGE))
  // Opens on the page holding the CURRENT speaker, not page one. Otherwise a voice
  // that happens to sit on page two leaves the keyboard with nothing marked, and the
  // setting you are looking at appears not to be set.
  const cur = SPEAKERS.findIndex(v => v.id === sp)
  const dflt = cur < 0 ? 0 : Math.floor(cur / SPEAKER_PAGE) * SPEAKER_PAGE
  const off = Math.min(Math.max(0, offset ?? dflt), (pages - 1) * SPEAKER_PAGE)
  const rows: any[][] = [[
    { text: `${mode === 'full' ? '● ' : ''}Full`, callback_data: 'voice:full' },
    { text: `${mode === 'summary' ? '● ' : ''}Summary`, callback_data: 'voice:summary' },
    { text: `${mode === 'off' ? '● ' : ''}Off`, callback_data: 'voice:off' },
  ]]
  // A toggle rather than a pair, because this is one preference with two states and
  // the row above already spends three buttons on the mode.
  if (mode !== 'off') rows.push([{
    text: partsMode(key) ? '● Send every part' : 'Send every part',
    callback_data: `vpartset:${partsMode(key) ? 'off' : 'on'}`,
  }])
  const page = SPEAKERS.slice(off, off + SPEAKER_PAGE)
  for (let i = 0; i < page.length; i += 2) {
    rows.push(page.slice(i, i + 2).map(v => ({
      text: `${v.id === sp ? '● ' : ''}${v.label}`, callback_data: `vspk:${v.id}`,
    })))
  }
  if (pages > 1) {
    const nav: any[] = []
    if (off > 0) nav.push({ text: '‹ Prev', callback_data: `vspg:${off - SPEAKER_PAGE}` })
    nav.push({ text: `${Math.floor(off / SPEAKER_PAGE) + 1}/${pages}`, callback_data: 'spg:noop' })
    if (off + SPEAKER_PAGE < SPEAKERS.length) nav.push({ text: 'Next ›', callback_data: `vspg:${off + SPEAKER_PAGE}` })
    rows.push(nav)
  }
  if (!probeVoice().speak) rows.push([{ text: '⬇️ Install voice', callback_data: 'vinst:go' }])
  return { inline_keyboard: rows }
}

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
  // Unicode-aware for the same reason sanitize() is: \w is ASCII-only, so a Persian
  // upload named سند.docx used to be saved as `_ _ _.docx` — three underscores, no
  // way to tell two such files apart. Marks are kept so Devanagari survives; NFC
  // rather than NFKD so a kept mark isn't decomposed back out of the name.
  const base = basename(name || '').normalize('NFC').replace(/[^\p{L}\p{N}\p{M}._\- ]+/gu, '_').replace(/^[.\s]+/, '').trim()
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

// A file that is too big to send, described the way the user needs to hear it.
// Returns '' when the file is fine.
function tooBig(path: string): string {
  const size = statSync(path).size
  if (size <= TG_UPLOAD_LIMIT) return ''
  return `${basename(path)} is ${fmtBytes(size)} — over the ${fmtBytes(TG_UPLOAD_LIMIT)} bot upload limit.` +
    (LOCAL_API ? '' : `\nA local Bot API server raises this to 2000 MB (set TG_API_ROOT — see README).`)
}

// Send one file from disk to the chat/topic. Returns true on success.
//
// `captionMode` is the parse mode for the caption. It exists because the caption on
// a long answer used to be sent with NO parse mode at all, so the only message in
// the bridge that showed the user raw `**bold**` and `| pipe | tables |` was the
// preview of its longest, most heavily formatted replies. Passing a parse mode
// brings the risk that made it tempting to skip: Telegram rejects an unbalanced
// entity outright, and this call has no chunk-level retry the way sendRich does —
// so a rejected caption cost the user the FILE, not just the formatting. Hence the
// retry below, which drops the caption's markup rather than the delivery.
//
// `plainCaption` is the UNESCAPED source. The retry must not resend `caption`: that
// string is MarkdownV2, so without a parse mode the user reads its backslashes.
async function sendFile(ctx: Context, threadId: number | undefined, path: string, caption?: string, replyTo?: number, captionMode?: string, plainCaption?: string): Promise<boolean> {
  if (!existsSync(path) || !statSync(path).isFile()) { await send(ctx, threadId, `Not a file: ${path}`); return false }
  const big = tooBig(path)
  if (big) { await send(ctx, threadId, big); return false }
  const size = statSync(path).size
  noteBotMessage(keyFor(ctx.chat!.id, threadId))
  const opts: any = destOpts({ threadId, replyTo })
  if (caption) {
    opts.caption = caption.slice(0, 1024)
    if (captionMode) opts.parse_mode = captionMode
  }
  const doc = () => new InputFile(path, basename(path))
  try {
    await ctx.api.sendDocument(ctx.chat!.id, doc(), opts)
    console.log(`[file->] ${path} (${fmtBytes(size)})`)
    return true
  } catch (e) {
    if (!captionMode) { await send(ctx, threadId, `⚠️ could not send ${basename(path)}: ${e}`); return false }
    // Formatting is best-effort, delivery is not.
    console.error(`[warn] captioned sendDocument, retrying unformatted: ${e}`)
    delete opts.parse_mode
    if (caption) opts.caption = (plainCaption ?? stripMd(caption)).slice(0, CAPTION_MAX)
    try {
      await ctx.api.sendDocument(ctx.chat!.id, doc(), opts)
      console.log(`[file->] ${path} (${fmtBytes(size)}, caption unformatted)`)
      return true
    } catch (e2) { await send(ctx, threadId, `⚠️ could not send ${basename(path)}: ${e2}`); return false }
  }
}

// Send several files as ONE grouped message, caption on the first.
//
// Two files that are two renderings of a single answer used to arrive as two
// independent messages — the .html with the preview, then a bare .md underneath
// with no context, which on a phone reads as a stray attachment rather than the
// source of truth. A media group is how Telegram says "these belong together".
//
// The trade, stated because it constrains later work: a media group takes NO
// reply_markup, so a button on an answer has to live on its own message; and the
// group succeeds or fails as a unit, so every item is size-checked up front —
// one oversized file would otherwise fail the whole group with an opaque error.
// On any failure it falls back to sending them individually, because two messages
// is a cosmetic problem and a dropped answer is not.
// Returns the FIRST message id of the group, so a voice note can be threaded to the
// answer even when the answer was a file. Undefined when nothing was sent, or when
// the fallback path sent the files individually.
async function sendFileGroup(ctx: Context, threadId: number | undefined, paths: string[], caption?: string, replyTo?: number, captionMode?: string, plainCaption?: string): Promise<number | undefined> {
  const usable = paths.filter(p => existsSync(p) && statSync(p).isFile())
  if (usable.length === 0) return undefined
  const oversized = usable.map(tooBig).filter(Boolean)
  if (oversized.length) { await send(ctx, threadId, oversized.join('\n\n')); return undefined }
  if (usable.length === 1) { await sendFile(ctx, threadId, usable[0], caption, replyTo, captionMode, plainCaption); return undefined }

  const one = (p: string, i: number) => {
    const extra: any = {}
    if (i === 0 && caption) {
      extra.caption = caption.slice(0, 1024)
      if (captionMode) extra.parse_mode = captionMode
    }
    return InputMediaBuilder.document(new InputFile(p, basename(p)), extra)
  }
  noteBotMessage(keyFor(ctx.chat!.id, threadId))
  const opts: any = destOpts({ threadId, replyTo })
  try {
    const sent: any = await ctx.api.sendMediaGroup(ctx.chat!.id, usable.map(one), opts)
    console.log(`[file->] group ${usable.map(p => basename(p)).join(' + ')}`)
    return Array.isArray(sent) ? sent[0]?.message_id : undefined
  } catch (e) {
    console.error(`[warn] sendMediaGroup, falling back to individual sends: ${e}`)
    let first = true
    for (const p of usable) {
      await sendFile(ctx, threadId, p, first ? caption : undefined, replyTo, captionMode, first ? plainCaption : undefined)
      first = false
    }
    return undefined
  }
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

// Telegram's caption cap. The limit applies to the RENDERED text, so escaping
// inflates the string we measure and not what the user sees — measuring the escaped
// form is therefore conservative, which is the direction to be wrong in: a caption
// one character over is rejected, and rejection used to cost the file.
const CAPTION_MAX = 1024
// How much of the answer to preview. Deliberately below CAPTION_MAX to leave room
// for the "Full answer attached" line and for escaping.
const CAPTION_PREVIEW = 900

// Build the caption for a long answer: a preview that ends on a structure boundary,
// formatted the way every other message in the topic is, plus the size note.
// Falls back to plain text if the escaped form cannot be made to fit.
function answerCaption(text: string): { text: string; mode?: string; plain: string } {
  const note = `\n\n📄 Full answer (${text.length} chars) attached.`
  const body = (cut: string) => `${cut}${cut.length < text.length ? ' …' : ''}${note}`
  for (let budget = CAPTION_PREVIEW; budget >= 200; budget = Math.floor(budget * 0.75)) {
    const raw = body(previewCut(text, budget))
    // The same pipeline sendLegacyMd uses, for the same reason: a table has no
    // MarkdownV2 form, so it is flattened into a code block first — which captions
    // DO support — and sanitizeProse runs between the two stages, not around them.
    const md = telegramify(sanitizeProse(mdTablesToCode(raw), 'markdownv2'), 'escape')
    // `plain` is what the send falls back to if Telegram still refuses to parse.
    // It is built from the same slice, NOT from the escaped string, or the fallback
    // shows the user the backslashes the escaping added.
    if (md.length <= CAPTION_MAX) return { text: md, mode: 'MarkdownV2', plain: stripMd(raw).slice(0, CAPTION_MAX) }
  }
  // Nothing fit even at the smallest budget: send it unformatted rather than not
  // at all. stripMd is what sendLegacyMd falls back to, so it reads the same.
  const plain = stripMd(body(previewCut(text, 600))).slice(0, CAPTION_MAX)
  return { text: plain, plain }
}

// One-line note telling Claude how the bridge works: it's a live chat (so it can
// ask clarifying questions) and how files flow in/out.
// Run one prompt against a topic's session, post the reply, deliver the outbox.
// Deliver a Claude answer: inline (markdown) if short, else as an answer.md file
// with a preview caption — so a huge reply isn't a dozen chunked messages.
async function deliver(ctx: Context, threadId: number | undefined, text: string, replyTo?: number): Promise<number | undefined> {
  if (answerGoesToFile(text)) {
    const dir = mkdtempSync(join(tmpdir(), 'tg-'))
    try {
      // The HTML goes first when both are sent: it is the one the user opens, and
      // the caption preview belongs on the file they will actually read. The .md
      // follows as the source of truth.
      const files: string[] = []
      if (REPLY_FILE_FORMAT !== 'md') {
        const h = join(dir, 'answer.html')
        writeFileSync(h, htmlDocument('Answer', markdownToHtml(text)))
        files.push(h)
      }
      if (REPLY_FILE_FORMAT !== 'html') {
        const m = join(dir, 'answer.md')
        writeFileSync(m, text)
        files.push(m)
      }
      const cap = answerCaption(text)
      // The group's first message IS a thing to point at, so a long answer's voice
      // note hangs off the files rather than falling all the way back.
      return await sendFileGroup(ctx, threadId, files, cap.text, replyTo, cap.mode, cap.plain)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  return sendRich(ctx, threadId, text, replyTo)
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
function synthesize(text: string, ogg: string, key?: string): Promise<string | null> {
  return new Promise(resolve => {
    const child = spawn(TTS_CMD, [ogg], { env: voiceEnv(key), stdio: ['pipe', 'ignore', 'pipe'] })
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
    // No plan mode here either: the same shape as normaliseUnit, and the same reason —
    // there is nothing to plan about rewriting one reply into three sentences, and plan
    // mode is what produces a preamble about whether planning is needed.
    const args = ['-p', prompt, '--output-format', 'json', '--model', VOICE_SUMMARY_MODEL]
    const child = spawn(CLAUDE_BIN, args, { cwd: HERE, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.on('error', () => resolve(''))
    child.on('close', () => { try { resolve(String(JSON.parse(out).result ?? '').trim()) } catch { resolve('') } })
  })
}

// ---------------------------------------------------------------------------
// speech normalisation
// ---------------------------------------------------------------------------
//
// `$100/yr` is phonemised as "dollar one hundred slash er". Measured through the real
// phonemiser, so is `5-10` ("five dash ten"), `2x` ("two ex"), `~5` ("tilde five") and
// `src/lib.ts` read as its punctuation. Nothing normalises the text before espeak sees
// it: kokoro_onnx's own normalize_text is, in full, `return text.strip()`.
//
// Rule tables and WFST grammars were both tried against a real 18.5k-character answer
// from this bridge. Every one of them fixed the dollar sign and broke something else —
// "one dollars", "$1.2B" -> "one dollars and twenty cents bytes", `2x faster` ->
// "two times degrees Fahrenheit aster", `1,000` -> "thousand". A fast model got every
// case right, lost none of the 134 proper nouns in the sample, and is what ships here.
//
// Off by TG_VOICE_NORMALISE=0, which restores exactly today's audio.
let NORMALISE_SPEECH = (process.env.TG_VOICE_NORMALISE ?? '1') !== '0'
const NORMALISE_MODEL = process.env.TG_VOICE_NORMALISE_MODEL || VOICE_SUMMARY_MODEL
const NORMALISE_TIMEOUT_MS = Number(process.env.TG_VOICE_NORMALISE_TIMEOUT_MS || 60_000)
// How long the tail of an answer may wait to be normalised before it is spoken as
// written. Generous, because exceeding it means worse pronunciation for those units —
// while never reaching it would mean an answer that stops halfway, which is the bug
// this whole path is atoning for. A long answer measured 152s.
const NORMALISE_TAIL_MS = Number(process.env.TG_VOICE_NORMALISE_TAIL_MS || 300_000)
// Log every rewrite the model made, not only the ones thrown out. Off by default
// because it is a line per changed unit, but it is the difference between "a listener
// says a sentence was missing" and being able to answer that: the text handed to the
// synthesiser is the one artefact nothing kept, so after the fact there was no record
// anywhere on disk of what had actually been said. Confirming the second report was
// impossible for exactly this reason — /vtidy had already deleted the audio.
const NORMALISE_LOG = /^(1|true|yes)$/i.test(process.env.TG_VOICE_NORMALISE_LOG || '')

// Same unit, same audio — and cheap on a re-speak.
//
// The model is NOT deterministic: the same sentence came back as "line 674" on one run
// and "line six hundred seventy-four" on the next. Without this, replaying an answer
// would sound different from the first time it was read, which reads as a glitch.
// In-memory only, so a restart re-earns it; capped because an unbounded map on a
// long-lived process is a leak with extra steps.
const normCache = new Map<string, string>()
const NORM_CACHE_MAX = 2000
// Per-answer tallies, reset by normaliseUnits. Module-level because normaliseUnit is
// called from workers and threading a stats object through buys nothing: only one
// answer normalises at a time per topic, and the count is for the log, not for logic.
let changed = 0
let rejected = 0

// How many normalisation calls to run at once, decided from the machine rather than
// from a number someone has to tune.
//
// Measured: one `claude -p` call peaks at ~260 MB RSS. Half of what is AVAILABLE right
// now (not total, and not free — MemAvailable is the one that accounts for reclaimable
// cache) divided by a 300 MB allowance, so a 1 GB VPS lands on 1 and a large box lands
// on the cap. Read per answer rather than at boot: the box is also synthesising, and
// what it can spare changes.
//
// Capped at 8 because these are network-bound, not CPU-bound — past that the wall time
// stops improving and only the rate-limit risk grows.
function normaliseConcurrency(): number {
  let availMb = 0
  try {
    const m = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m)
    if (m) availMb = Number(m[1]) / 1024
  } catch {}
  // Not Linux, or /proc unreadable: os.freemem understates on Linux (it excludes
  // reclaimable cache) but it is the honest fallback everywhere else.
  if (!availMb) availMb = osFreemem() / 1024 / 1024
  return Math.max(1, Math.min(8, Math.floor((availMb * 0.5) / 300)))
}

const NORMALISE_PROMPT = [
  'Rewrite the line below so a speech synthesiser reads it aloud correctly.',
  'Output ONLY the rewritten line. No preamble, no quotes, no explanation.',
  '',
  'Rules:',
  '- Currency in spoken order with correct plural: $100 -> one hundred dollars, $1 -> one dollar,',
  '  $1.2B -> one point two billion dollars, $40/bbl -> forty dollars a barrel.',
  '- Ranges: 5-10 -> five to ten.',
  '- Units as words: km/h -> kilometres per hour, mb/d -> million barrels a day, T/yr -> trillion a year.',
  '- ~5 -> about five. 2x -> two times. #8 -> number eight. 50% -> fifty percent.',
  '- A file path or identifier: say the name, not the punctuation.',
  '- Dates: 2026-06-15 -> the fifteenth of June twenty twenty-six.',
  '- Leave ordinary prose EXACTLY as written. Never summarise, shorten, reword or add anything.',
  '  Every fact, name and number in the input must still be present in the output.',
  '- NEVER output the words: slash, backslash, tilde, underscore, asterisk, caret, hash,',
  '  or "dollar" before a number. They are how the synthesiser fails, not how anyone reads.',
  '  Say what the symbol MEANS instead — and/or is "and or", km/h is "kilometres per hour",',
  '  src/lib.ts is "lib dot t s" — or drop it if it means nothing aloud.',
  '- If nothing needs changing, output the line unchanged.',
].join('\n')

// One unit in, one spoken unit out. Never throws: every failure path returns the
// original, so the worst case is exactly the audio this bridge produces today.
function normaliseUnit(text: string): Promise<string> {
  const hit = normCache.get(text)
  if (hit !== undefined) return Promise.resolve(hit)
  return new Promise<string>(resolve => {
    // Delimited, and NOT introduced by a bare label. The prompt used to end with the
    // word `LINE:` and then the text — so a unit that itself opens `The honest caveat:`
    // read as another label in the same frame, and the model answered with what it took
    // to be the payload, dropping the label. Three reported failures in a row opened
    // with a colon clause; that is a prompt-shape bug, not a phoneme bug.
    //
    // And no `--permission-mode plan`. Plan mode invites the model to reason about
    // whether to plan, and a stateless one-line rewrite has nothing to plan. Measured
    // over 108 samples per arm on the units that actually reproduce: the shipped
    // combination was the ONLY arm to emit meta-commentary ("I've already provided the
    // rewritten line above. No further action is needed…") or multiline output at all,
    // and it was worst on faithfulness (4/108 against 1/108). Dropping plan mode also
    // takes ~2s off the median call.
    const args = ['-p', `${NORMALISE_PROMPT}\n\n<line>\n${text}\n</line>`, '--output-format', 'json',
                  '--model', NORMALISE_MODEL]
    // cwd: HERE and no --resume, for the reason summarizeForSpeech gives: a stateless
    // pass must not be able to touch or rebind the topic's session.
    const child = spawn(CLAUDE_BIN, args, { cwd: HERE, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    // DRAINED, not ignored. A pipe nobody reads fills at 64 KB and then blocks the
    // writer forever — so a child that decided to be chatty on stderr would hang here
    // until the 60s SIGKILL below, turning the fast path into a minute of silence for
    // that unit. Kept only as a tail, for the log line if it exits badly.
    let errTail = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', d => { errTail = (errTail + d).slice(-500) })
    let out = ''
    let settled = false
    const done = (v: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (v && v !== text) {
        if (normCache.size >= NORM_CACHE_MAX) normCache.delete(normCache.keys().next().value as string)
        normCache.set(text, v)
      }
      resolve(v || text)
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} ; done(text) }, NORMALISE_TIMEOUT_MS)
    child.stdout.on('data', d => (out += d))
    child.on('error', () => done(text))
    child.on('close', () => {
      let v = ''
      try { v = String(JSON.parse(out).result ?? '').trim() } catch {
        if (errTail.trim()) console.error(`[voice] normaliser: ${errTail.trim()}`)
      }
      // The delimiters are a frame, not content: an echoed `</line>` would be READ
      // ALOUD. Never observed in 12 samples, and one line to be sure of.
      v = v.replace(/^<line>\s*/i, '').replace(/\s*<\/line>$/i, '').trim()
      // A model that decided to explain itself, refuse, or write an essay is not
      // giving us a spoken line. Length is the cheap tell and it costs a unit, never
      // the answer: anything suspicious falls back to the written form.
      //
      // This is ALL that stands between the model and the listener, and it is blind to
      // the failure that was actually reported: a preamble standing in for the
      // paragraph is one line and SHORTER than its input, so it passes both tests.
      // Measured on this prompt shape — 0 of 92 samples — but the shape is what makes
      // that true, and it is not ours to hold still. See the FEEDBACK entry.
      if (v.includes('\n') || v.length > text.length * 3 + 80) {
        console.error(`[voice] normalise rejected (shape): ${JSON.stringify(text.slice(0, 60))} -> ${JSON.stringify(v.slice(0, 60))}`)
        rejected++
        v = ''
      } else if (v && v !== text) {
        changed++
        if (NORMALISE_LOG) console.log(`[voice] speak: ${JSON.stringify(text.slice(0, 80))} -> ${JSON.stringify(v.slice(0, 80))}`)
      }
      done(v)
    })
  })
}

// Annotate units in place with what the synthesiser should say.
//
// Two promises, because the caller does not need the whole answer to start speaking:
// `lead` settles once the first `upTo` units are decided, `all` once every one is.
// Measured on a long answer — 100 units, 61 of them needing the model, 8 at a time —
// that is 19s to the first note instead of 152s. On a short one the two settle
// together and the split costs nothing.
//
// NEITHER promise ever rejects. This stage is an enhancement whose fallback is the
// text as written, so a failure here must degrade the audio, never withhold it — and
// a rejection reaching the caller is precisely how 70% of an answer was once dropped.
function normaliseUnits(units: SpeechUnit[], upTo: number): { lead: Promise<void>; all: Promise<void> } {
  // One line saying what the stage actually did. `normalising 6/20 units` was the only
  // trace a run left, and it says what was ATTEMPTED — so a run that dropped a sentence
  // and a run that did not looked identical in the log.
  const report = () => console.log(`[voice] normalised ${changed} units, ${rejected} rejected`)
  if (!NORMALISE_SPEECH) return { lead: Promise.resolve(), all: Promise.resolve() }
  const todo = units.map((u, i) => i).filter(i => needsSpeechNormalising(units[i].text))
  if (!todo.length) return { lead: Promise.resolve(), all: Promise.resolve() }
  const width = normaliseConcurrency()
  let next = 0
  let leadLeft = todo.filter(i => i < upTo).length
  let resolveLead!: () => void
  const lead = new Promise<void>(r => { resolveLead = r })
  if (!leadLeft) resolveLead()
  const worker = async () => {
    for (;;) {
      const k = next++
      if (k >= todo.length) return
      const i = todo[k]
      try { units[i].speak = await normaliseUnit(units[i].text) } catch { /* speak the text */ }
      if (i < upTo && --leadLeft === 0) resolveLead()
    }
  }
  changed = 0
  rejected = 0
  console.log(`[voice] normalising ${todo.length}/${units.length} units, ${width} at a time`)
  // `todo` is in order, so the workers reach the lead units first and `lead` settles
  // as early as it can. resolveLead again at the end in case none of them were gated.
  const all = Promise.all(Array.from({ length: Math.min(width, todo.length) }, worker))
    .then(() => { report(); resolveLead() }, e => { console.error(`[voice] normalise: ${e}`); report(); resolveLead() })
  return { lead, all }
}

// What the box can actually do, asked rather than assumed.
//
// The reported failure: /voice on, then a message, and the answer came back as text
// with no hint anything was wrong. The bridge KNEW — synthesize console.errors the
// exit code — it just never told the person who asked. The log is the one place a
// phone user never looks.
type VoiceProbe = { speak: boolean; listen: boolean; engine: string; detail: string }
let probeCache: VoiceProbe | undefined
function probeVoice(force = false): VoiceProbe {
  if (probeCache && !force) return probeCache
  const kokoro = existsSync(KOKORO_MODEL) && existsSync(join(dirname(KOKORO_MODEL), 'voices-v1.0.bin'))
  const forced = (process.env.TG_TTS_ENGINE || '').toLowerCase()
  let engine = forced || (kokoro ? 'kokoro' : (process.env.TG_PIPER_VOICE ? 'piper' : 'espeak'))
  // ffmpeg is the one native tool, and it is used ONLY to encode the outgoing Opus —
  // so a box without it can still listen. Reporting the two directions separately is
  // the difference between "voice is broken" and "speaking is broken".
  const ff = !!(process.env.TG_FFMPEG && existsSync(process.env.TG_FFMPEG))
    || existsSync(join(HERE, 'voice', 'bin', 'ffmpeg'))
    || hasOnPath('ffmpeg')
  const enginePresent = engine === 'kokoro' ? kokoro
    : engine === 'piper' ? !!process.env.TG_PIPER_VOICE
    : hasOnPath('espeak-ng')
  const listen = pyHas('faster_whisper')
  const speak = ff && enginePresent && (engine !== 'kokoro' || pyHas('kokoro_onnx'))
  const missing: string[] = []
  if (!ff) missing.push('ffmpeg')
  if (!enginePresent) missing.push(`the ${engine} engine`)
  if (engine === 'kokoro' && !pyHas('kokoro_onnx')) missing.push('kokoro-onnx')
  if (!listen) missing.push('faster-whisper')
  probeCache = { speak, listen, engine, detail: missing.join(', ') }
  return probeCache
}
function hasOnPath(bin: string): boolean {
  try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true } catch { return false }
}
function pyHas(mod: string): boolean {
  try { execFileSync('python3', ['-c', `import ${mod}`], { stdio: 'ignore', timeout: 15000 }); return true } catch { return false }
}

// Installing is OFFERED, never done on its own. A bot that downloads 340MB because
// you tapped a toggle is a surprise; a button you chose to press is not.
let voiceSetupRunning = false
let voiceSetupFailed = false
async function offerVoiceInstall(ctx: Context, threadId: number | undefined): Promise<void> {
  if (voiceSetupRunning) { await send(ctx, threadId, '⏳ Voice setup is already running — I will say when it is ready.', true); return }
  if (voiceSetupFailed) {
    await send(ctx, threadId, '⚠️ Voice setup failed last time — see bridge.log, or run voice/setup.sh by hand.', true); return
  }
  await ctx.api.sendMessage(ctx.chat!.id, '🎙 Install the voice engine now? About 340 MB, a few minutes. The topic stays usable as text while it runs.', {
    ...destOpts({ threadId }), disable_notification: true,
    reply_markup: { inline_keyboard: [[{ text: '⬇️ Install voice', callback_data: 'vinst:go' }]] },
  }).catch(e => console.error(`[voice] offer: ${e}`))
}

// Runs voice/setup.sh detached. Never blocks a turn, and only ever one at a time.
async function runVoiceSetup(ctx: Context, threadId: number | undefined): Promise<void> {
  if (voiceSetupRunning) return
  voiceSetupRunning = true
  await send(ctx, threadId, '🎙 Setting up voice — a few minutes, ~340 MB. I will tell you when it is ready.', true)
  const child = spawn(join(HERE, 'voice', 'setup.sh'), [], { cwd: HERE, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  let tail = ''
  const keep = (d: any) => { tail = (tail + d).slice(-800) }
  child.stdout.on('data', keep); child.stderr.on('data', keep)
  child.on('error', e => { voiceSetupRunning = false; voiceSetupFailed = true; console.error(`[voice] setup spawn: ${e}`) })
  child.on('close', async code => {
    voiceSetupRunning = false
    const p = probeVoice(true)     // forced: the whole point is that disk changed
    if (code === 0 && p.speak) {
      await send(ctx, threadId, `🎙 Voice ready (${p.engine} · ${speakerLabel(SPEAKER_DEFAULT)}). Say something.`)
    } else {
      voiceSetupFailed = true
      await send(ctx, threadId, `⚠️ Voice setup did not finish${p.detail ? ` — still missing ${p.detail}` : ''}.\n${tail.split('\n').slice(-4).join('\n')}`)
    }
  })
}

// Said once per topic per bridge run.// Said once per topic per bridge run. The answer itself already arrived, so
// repeating this after every turn would turn a setup problem into a nag.
const warnedNoVoice = new Set<string>()
async function warnNoVoice(ctx: Context, threadId: number | undefined, key: string): Promise<void> {
  if (warnedNoVoice.has(key)) return
  warnedNoVoice.add(key)
  const p = probeVoice(true)
  await send(ctx, threadId,
    `⚠️ Voice is on, but I could not speak that answer${p.detail ? ` — missing ${p.detail}` : ''}. ` +
    `The text above is complete. Tap below to install what's needed, or run voice/setup.sh yourself.`,
    true)
  await offerVoiceInstall(ctx, threadId)
}

// A speech task, so it can be cancelled and tidied.
//
// Before this there was no handle on synthesis anywhere: speakChunked spawned the
// child and forgot it, /stop only ended tracked model jobs, and a ten-minute answer
// kept delivering notes with no way to stop short of killing the bridge.
type SpeechTask = {
  id: string
  key: string
  child?: ChildProcess
  dir: string
  chunkIds: number[]     // the notes sent so far, for tidying
  cancelled: boolean
  // The status bubble: `🎙 Speaking… ~5 min`, posted the moment synthesis starts and
  // deleted when the audio lands. It is also the home of the 🛑 button, which used to
  // ride on note 1 — a message that does not exist for the first ~30 seconds, so
  // during the slowest and least interruptible part of a run there was no way to stop
  // it at all.
  statusId?: number
  // Whether the progressive notes are being SENT. Synthesis is chunked either way;
  // this only decides whether each chunk becomes a message.
  sendParts: boolean
  // Chunks finished while sendParts was false. Held rather than dropped, so the
  // button can BACK-FILL: its whole value is the 30 seconds before the first note
  // exists, so a tap at t=60s has to send everything already made and then continue
  // live. Also the safety net — if no full file is ever produced, these are the
  // answer, and they go out regardless.
  held: { path: string; seconds?: number }[]
  // Installed by speakChunked so the callback can reach into the run's send queue.
  // Sends must stay on that one chain or they arrive out of order.
  release?: (why: string) => void
  // Whether the answer was long enough to go out as answer.md/.html. Decided from
  // the answer text at spawn time, not from the finished audio: a slow speaker can
  // make three minutes of a paragraph, and that paragraph still does not want a page.
  withFiles: boolean
}
// Kept AFTER the run finishes, deliberately. The tidy button rides on the full file,
// which is the last thing sent, so a task discarded when the child closed could never
// honour its own button — the tap arrived a moment too late, every time. Only the
// message ids are retained; the child reference is dropped.
const SPEECH_KEEP = 40
const speechTasks = new Map<string, SpeechTask>()
const speechByTopic = new Map<string, string>()   // topic key -> its current task

function cancelSpeech(key: string, reason = 'cancelled'): boolean {
  const id = speechByTopic.get(key)
  const t = id ? speechTasks.get(id) : undefined
  // speechByTopic is cleared when a run ends, so a finished task is not cancellable
  // even though its record is kept for tidying.
  if (!t || t.cancelled || !t.child) return false
  t.cancelled = true
  try { t.child?.kill('SIGTERM') } catch {}
  console.log(`[voice] ${reason} speech ${t.id} in ${key}`)
  return true
}

// Is the progressive path available? It needs Kokoro's raw-samples API, so it is
// gated on the model actually being on disk — the same test tts.sh makes when it
// picks an engine. Piper and espeak keep the single-note path.
function canChunk(): boolean {
  const forced = (process.env.TG_TTS_ENGINE || '').toLowerCase()
  if (forced && forced !== 'kokoro') return false
  if (!VOICE_CHUNKED || !existsSync(SPEAK_PY)) return false
  // The model check is about the DEFAULT implementation. An explicit TG_SPEAK_CMD
  // means the caller has supplied their own synthesiser, so requiring Kokoro's model
  // on disk would be checking a file that implementation may not use — and would
  // make the test suite pass or fail on whether this box happens to have a 311MB
  // download.
  return !!process.env.TG_SPEAK_CMD || existsSync(KOKORO_MODEL)
}

// Speak an answer as a SEQUENCE of voice notes, sending each as it is ready.
//
// Two things changed here and they are the point of the whole exercise. The answer
// is no longer truncated — a 1400-character cap cut a long reply off around a fifth
// of the way in, mid-sentence, saying nothing. And the notes arrive progressively:
// measured on this box, the first lands in ~43s where the whole thing takes 83s, and
// because synthesis runs at ~0.79x realtime every later note is ready before you
// finish the previous one. The complete file follows at the end for anyone who wants
// one file rather than a list.
//
// The notes are no longer SENT by default, and that is a different decision from how
// they are made. A long answer used to post six messages — the text, three voice
// notes, the full file, the read-along page — four of them audio and the same audio
// twice, because the parts exist only so you do not wait and are pure sediment once
// the full file lands. Scroll back through a day of that and the conversation is
// unreadable. So synthesis is untouched, still chunk by chunk, and the SENDING is
// what became opt-in: the chunks are held, the full file arrives at exactly the same
// moment it does today, and a button releases the parts for anyone who wants them.
async function speakChunked(ctx: Context, threadId: number | undefined, key: string, text: string, replyTo?: number): Promise<boolean> {
  const units = speechUnits(text)
  if (!units.length) return true
  const dir = mkdtempSync(join(tmpdir(), 'tg-tts-'))
  const wantParts = partsMode(key)
  const task: SpeechTask = { id: newJobId(), key, dir, chunkIds: [], cancelled: false, withFiles: answerGoesToFile(text),
                             sendParts: wantParts, held: [] }
  speechTasks.set(task.id, task)
  speechByTopic.set(key, task.id)
  // The status bubble, before a single sample exists. Two jobs: say what is happening
  // and for how long, and carry the 🛑 button from t=0 rather than from whenever note
  // one shows up.
  //
  // A short answer is one note and no full file, so there are no parts to offer and
  // the button would be a lie. Predicted from the estimate, because the real boundary
  // is decided by duration inside speak.py and is not knowable until the audio exists.
  //
  // Compared against HALF the first chunk, not the whole of it, because the estimate
  // is a floor rather than a guess. It measures the answer as WRITTEN, and what gets
  // spoken is the normalised form, which only ever grows: `$100/yr` is seven
  // characters that become "one hundred dollars per year", thirty. A symbol-dense
  // answer therefore speaks far longer than it reads, and comparing its written length
  // against the real boundary hides the button on exactly the answers long enough to
  // want it. The two errors are not symmetrical — a button shown needlessly back-fills
  // whatever exists, which for a one-note answer is that one note arriving a moment
  // early, while a button wrongly hidden leaves no way to ask for parts at all.
  const estimate = speechEstimateSeconds(units)
  const willChunk = estimate > speechChunkSeconds(0) / 2
  // Installed BEFORE the button is posted, because the wait for the lead units to be
  // normalised sits between here and the spawn and can run to twenty seconds — a
  // button that answers "already finished speaking" for the first twenty seconds of a
  // run is worse than no button. Nothing exists to back-fill yet, so setting the flag
  // is the whole job; the version installed alongside the send queue below replaces
  // this one and adds the back-fill.
  task.release = () => { task.sendParts = true }
  const statusRows: any[][] = []
  if (willChunk && !task.sendParts) statusRows.push([{ text: '▶️ Send it in parts', callback_data: `vparts:${task.id}` }])
  statusRows.push([{ text: '🛑 Stop speaking', callback_data: `vstop:${task.id}` }])
  await ctx.api.sendMessage(ctx.chat!.id, `🎙 Speaking… ~${fmtDurationWords(estimate)}`, {
    ...destOpts({ threadId, replyTo }),
    reply_markup: { inline_keyboard: statusRows },
  }).then((m: any) => { task.statusId = m?.message_id; noteBotMessage(key) })
    .catch(e => console.error(`[warn] voice status: ${e}`))
  // Only the units the FIRST chunk needs are waited for; the rest follow as soon as
  // they are ready. Estimated from characters because the real boundary is decided by
  // duration inside speak.py and is not knowable until the audio exists — measured at
  // ~12.6 spoken characters per second, so a 45s chunk is about 570 characters.
  //
  // This is what keeps the first note ~19s away on a long answer instead of ~152s.
  // Its first version also lost a user 70% of an answer, by making the tail write
  // conditional on the normaliser succeeding; see sendTail below, which cannot be
  // skipped. `expect` rides along so the far side can say whether it got everything.
  //
  // With normalisation OFF there is nothing to wait for, so there is no reason to
  // hand the answer over in two parts — everything goes in one write and the streamed
  // path is not entered at all. That is what makes TG_VOICE_NORMALISE=0 a real kill
  // switch: it restores the exact code path this bridge used before any of this
  // existed, rather than merely skipping the model while keeping the new plumbing.
  const leadChars = speechChunkSeconds(0) * 13
  let lead = 0, acc = 0
  if (NORMALISE_SPEECH) {
    while (lead < units.length && acc < leadChars) acc += units[lead++].text.length
  } else {
    lead = units.length
  }
  const { lead: leadReady, all: allReady } = normaliseUnits(units, lead)
  await leadReady
  const streaming = lead < units.length
  const req = JSON.stringify({ units: units.slice(0, lead), expect: units.length,
                               outdir: dir, chunks: [0, 1, 2].map(speechChunkSeconds),
                               ...(streaming ? { streaming: true } : {}) })
  return new Promise<boolean>(resolve => {
    const child = spawn('python3', [SPEAK_PY], { env: voiceEnv(key), stdio: ['pipe', 'pipe', 'pipe'] })
    task.child = child
    let err = '', buf = ''
    let n = 0
    let timings: UnitTiming[] = []
    // A single-chunk answer never produces a `full` line — the one note IS the whole
    // thing — so the index and the read-along would silently never appear for short
    // answers. Remembering the first chunk lets both happen anyway, without sending a
    // duplicate audio file of content already in the note above it.
    let onlyPath: string | undefined
    // Set when speak.py reports it synthesised fewer units than it was sent. The whole
    // reason this number crosses the pipe: audio cannot tell you what is missing from it.
    let shortRead: { spoke: number; expect: number } | undefined
    // Set when the `full` LINE IS PARSED, not when its send finishes. `done` arrives
    // on stdout immediately behind `full`, while the send is still sitting on the
    // queue — so a flag set inside the send callback was still false when the `done`
    // branch read it, and both paths queued a read-along. Two pages, every long
    // answer. The question here is "did the synthesiser produce a full file?", which
    // the parse answers and the send does not.
    let haveFull = false
    // Sends are chained rather than awaited inline: stdout must keep being read or
    // the child blocks on a full pipe, and the notes still have to arrive in order.
    let queue: Promise<void> = Promise.resolve()
    // Named so it cannot shadow the module-level send(ctx, threadId, text): this one
    // serialises Telegram sends, and the two are one keystroke apart.
    const later = (fn: () => Promise<void>) => { queue = queue.then(fn).catch(e => console.error(`[voice] send: ${e}`)) }

    // One place a part becomes a message, because there are now two callers: the live
    // chunk as it is synthesised, and the back-fill when the button releases what was
    // held. They must produce identical notes, and the part numbers must stay the
    // numbers speak.py produced them in.
    const sendPart = (part: number, path: string, seconds?: number) => later(async () => {
      if (task.cancelled) return
      const opts: any = destOpts({ threadId, replyTo })
      // No caption on the first note: a short answer is one note and a "part 1"
      // label on a thing with no part 2 is noise.
      //
      // No TIMESTAMP on any of them either. It used to read "part 3 — from 5:42",
      // and Telegram turns that M:SS into a seek — but the seek is relative to
      // THIS note, which holds 90 seconds starting at 5:42 and has no 5:42 in it.
      // Every tap was a dead link. A note is a position in the answer, not a
      // place you can jump to; the full file below is what you navigate.
      //
      // The 🛑 button is NOT here any more. It rode on note 1, which does not exist
      // for the first ~30 seconds — so during the slowest, least interruptible part
      // of a run there was no way to stop it. The status bubble exists from t=0 and
      // is the right home for it whether or not parts are ever sent.
      if (part > 1) opts.caption = `🎙 part ${part}`
      if (seconds) opts.duration = Math.round(seconds)
      const m: any = await ctx.api.sendVoice(ctx.chat!.id, new InputFile(path), opts)
      if (m?.message_id) task.chunkIds.push(m.message_id)
      noteBotMessage(key)
    })

    // Turn the parts on mid-run. The whole value of the button is the window before
    // the first note exists, so it has to BACK-FILL — a tap at t=60s sends every part
    // already finished and then the rest follow live. A switch that only affected
    // future chunks would be useless exactly when it is wanted.
    task.release = (why: string) => {
      if (task.sendParts) return
      task.sendParts = true
      const held = task.held.splice(0)
      console.log(`[voice] parts released (${why}) for ${task.id}: ${held.length} held`)
      // The held chunks are always parts 1..k — nothing was sent before them.
      held.forEach((h, i) => sendPart(i + 1, h.path, h.seconds))
    }

    child.stderr.on('data', d => (err += d))
    // setEncoding, so a multi-byte character split across two reads is not corrupted:
    // without it each chunk is decoded on its own and a path or title outside ASCII
    // comes back mangled.
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', d => {
      buf += d
      const lines = buf.split('\n'); buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim() || task.cancelled) continue
        let o: any; try { o = JSON.parse(line) } catch { continue }
        if (o.path) {
          n++
          const part = n
          if (part === 1) onlyPath = o.path
          // Held, not dropped. The file stays in the run's temp directory, which is
          // only removed once the send queue has drained, so a tap at t=60s can still
          // back-fill everything already made.
          if (!task.sendParts) { task.held.push({ path: o.path, seconds: o.seconds }); continue }
          sendPart(part, o.path, o.seconds)
        } else if (o.full) {
          // Taken here as well as from `done`, because the section index is built the
          // moment the full file is sent and `done` arrives after it.
          if (o.timings) timings = o.timings.map((t: number[]) => ({ start: t[0], end: t[1] }))
          haveFull = true
          later(async () => {
            if (task.cancelled) return
            // sendAudio, not sendVoice: a real player with seeking and a title, and
            // visibly a different thing from the chunk bubbles above it.
            const toc = speechToc(units, timings)
            const rows: any[][] = []
            // Offered, never done for you: the notes are what you have been listening
            // to, and this file arrives mid-chunk more often than not.
            if (task.chunkIds.length > 1) rows.push([{ text: '🧹 Remove the parts', callback_data: `vtidy:${task.id}` }])
            const m: any = await ctx.api.sendAudio(ctx.chat!.id, new InputFile(o.full), {
              ...destOpts({ threadId, replyTo }),
              // Words here too, for the same reason and for consistency with the
              // caption: nothing outside the section index should look tappable.
              title: `Full answer — ${fmtDurationWords(o.seconds)}`,
              performer: 'xesious',
              duration: Math.round(o.seconds || 0),
              // Timestamps that point at SECTIONS. Telegram makes each one a tappable
              // seek, so the old caption — whose only number was the total duration —
              // offered exactly one link, aimed at the last second of the audio.
              caption: fullAudioCaption(o.seconds, toc, CAPTION_MAX),
              ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}),
            } as any)
            noteBotMessage(key)
            // The status bubble has said everything it had to say, and the audio it
            // was standing in for is now above it. It cannot BECOME the audio — a
            // text message cannot be edited into a media one, editMessageMedia only
            // edits messages that already carry media — so it is deleted, which is
            // what makes the quiet path one bubble instead of five.
            await clearStatus(ctx, task)
            await sendReadAlong(ctx, threadId, key, task, units, timings, o.full, o.seconds, m?.message_id ?? replyTo)
          })
        } else if (o.done) {
          if (typeof o.expect === 'number' && typeof o.spoke === 'number' && o.spoke !== o.expect) {
            shortRead = { spoke: o.spoke, expect: o.expect }
          }
          // Always last, and separate from `full`: a one-note answer has no full file
          // but still has timings, and the read-along wants them just the same.
          timings = (o.timings || []).map((t: number[]) => ({ start: t[0], end: t[1] }))
          const seconds = o.seconds ?? 0
          const single = onlyPath
          if (!haveFull && single) {
            // No full file means the held notes ARE the answer — a short one is a
            // single note and nothing follows it. Releasing here is not a preference,
            // it is the difference between an answer and silence, so it happens
            // whatever the parts setting says. Queued before the caption edit below,
            // which needs the note to exist.
            task.release?.('no full file')
            later(async () => {
              if (task.cancelled) return
              await clearStatus(ctx, task)
              // The index goes onto the note itself: there is no second message to
              // put it on, and a lone note with no way to navigate it is the same
              // complaint one chunk smaller.
              const toc = speechToc(units, timings)
              const first = task.chunkIds[0]
              if (first && toc.length) {
                await ctx.api.editMessageCaption(ctx.chat!.id, first,
                  { caption: fullAudioCaption(seconds, toc, CAPTION_MAX) } as any).catch(() => {})
              }
              await sendReadAlong(ctx, threadId, key, task, units, timings, single, seconds, first ?? replyTo)
            })
          }
        }
      }
    })
    child.on('error', e => { console.error(`[voice] speak spawn: ${e}`); resolve(false) })
    child.on('close', code => {
      // A run that ended without a full file leaves the held notes as the only audio
      // there is. `done` covers the ordinary short answer; this covers the crash, the
      // non-zero exit and the truncated pipe, where holding them would turn a partial
      // answer into no answer at all. Queued before the drain below so the sends are
      // on the chain rather than racing the temp directory's removal.
      if (!task.cancelled && !haveFull && task.held.length) task.release?.(`exit ${code} with no full file`)
      queue.finally(async () => {
        if (task.cancelled) {
          await clearStatus(ctx, task)
          const kept = task.chunkIds.length
            ? `${task.chunkIds.length} note(s) already sent stay; `
            : 'Nothing had been sent yet; '
          await send(ctx, threadId, `🛑 Stopped speaking. ${kept}the text answer is complete above.`)
        }
        // Unconditional, and it has to be. The ordinary paths retire the bubble when
        // the audio lands, but a crash, a non-zero exit or a torn pipe reaches none of
        // them — and what survives is a message reading "🎙 Speaking…" with a live 🛑
        // on it, for a run that ended minutes ago. Idempotent: it clears statusId.
        await clearStatus(ctx, task)
        rmSync(dir, { recursive: true, force: true })
        task.child = undefined
        if (speechByTopic.get(key) === task.id) speechByTopic.delete(key)
        // Oldest out first; Map preserves insertion order. A tap on one evicted this
        // way is told the notes are no longer tracked rather than doing nothing.
        while (speechTasks.size > SPEECH_KEEP) {
          const oldest = speechTasks.keys().next().value as string
          if (oldest === task.id) break
          speechTasks.delete(oldest)
        }
        // Printed whenever there IS any, not only on a non-zero exit. speak.py skips a
        // unit it cannot synthesise and carries on — correct, one bad sentence must
        // not cost the answer — and writes a line about it to stderr. Gating that on
        // the exit code threw away the only record that anything had been dropped, on
        // exactly the runs where something had been.
        if (err.trim() && !task.cancelled) console.error(`[voice] speak stderr: ${err.trim().slice(-500)}`)
        if (code !== 0 && !task.cancelled) console.error(`[voice] speak exit ${code}`)
        // A cancelled run is not a failure: the user asked for it, and reporting it
        // as one would trigger the "voice could not speak" warning.
        // `n` is the number of CHUNKS, so `n > 0` said "some audio exists" and called
        // that success — which is how a run that spoke 6 of 20 units reported true and
        // the user was never told. `spoke` is the number of units speak.py actually
        // synthesised; short means short.
        if (!task.cancelled && shortRead) {
          console.error(`[voice] INCOMPLETE: spoke ${shortRead.spoke} of ${shortRead.expect} units`)
        }
        resolve(task.cancelled || (code === 0 && n > 0 && !shortRead))
      })
    })
    child.stdin.write(req + '\n')

    // THE TAIL ALWAYS GOES. Not "if the normaliser succeeded", not inside a swallowed
    // catch — the previous version made this conditional and a single rejection
    // anywhere upstream closed the pipe with 14 of 20 units unsent, which the user
    // received as a complete-looking "Full answer" ending mid-thought.
    //
    // Un-normalised is a fine outcome; unsent is not. If the normaliser has not
    // finished by the deadline the tail goes as written, which is exactly the audio
    // this bridge produced before normalisation existed.
    // Nothing was held back, so there is no second write and no end marker to wait
    // for: speak.py sees one complete request and an immediate EOF, exactly as it did
    // before streaming existed.
    if (!streaming) child.stdin.end()
    let tailSent = !streaming
    const sendTail = (why: string) => {
      if (tailSent) return
      tailSent = true
      clearTimeout(tailTimer)
      try {
        if (lead < units.length) child.stdin.write(JSON.stringify({ units: units.slice(lead) }) + '\n')
        child.stdin.write(JSON.stringify({ end: true }) + '\n')
        child.stdin.end()
      } catch (e) {
        // Logged, never swallowed: this is the one write whose loss costs the answer.
        console.error(`[voice] could not send the rest of the answer (${why}): ${e}`)
        try { child.stdin.end() } catch {}
      }
    }
    const tailTimer = streaming ? setTimeout(() => {
      console.error(`[voice] normalising the rest took over ${NORMALISE_TAIL_MS}ms — speaking it as written`)
      sendTail('deadline')
    }, NORMALISE_TAIL_MS) : undefined
    void allReady.then(() => sendTail('ready'), () => sendTail('normaliser failed'))
  })
}

// Retire the status bubble once the audio it announced has arrived.
//
// Deleted rather than edited, and it has to be a delete: a text message cannot be
// turned into a media one — editMessageMedia only edits messages that already contain
// media — so the bubble was never a placeholder the audio could grow into. It is a
// separate message with its own lifetime, and its lifetime ends here. That is the
// whole of "one bubble in the quiet path": the status goes, the audio stays.
//
// Falls back to stripping the buttons if the delete is refused (a bot may only delete
// its own messages, and only within 48 hours — both hold for a bubble minutes old, but
// a stale 🛑 is worse than a stale sentence).
async function clearStatus(ctx: Context, task: SpeechTask): Promise<void> {
  const id = task.statusId
  if (!id) return
  task.statusId = undefined
  if (await ctx.api.deleteMessage(ctx.chat!.id, id).then(() => true).catch(() => false)) return
  await ctx.api.editMessageReplyMarkup(ctx.chat!.id, id, { reply_markup: { inline_keyboard: [] } }).catch(() => {})
}

// Delete the chunk notes, leaving the full file. Never automatic unless asked for:
// the chunks exist to be listened to WHILE the rest is made, and deleting the one
// that is playing stops playback dead.
async function tidySpeech(ctx: Context, task: SpeechTask): Promise<number> {
  let gone = 0
  for (const id of task.chunkIds) {
    // A bot may only delete its own messages, and only within 48 hours. Both hold
    // for a note minutes old, but a failure here is not worth reporting.
    if (await ctx.api.deleteMessage(ctx.chat!.id, id).then(() => true).catch(() => false)) gone++
  }
  task.chunkIds = []
  return gone
}

// A page that plays the answer and highlights each block as it is spoken.
//
// AWAITED by its caller, not fired and forgotten: it reads the .ogg out of the temp
// directory that the close handler removes, and the send queue is the only thing
// holding that directory open. The timing
// is exact — every unit was synthesised, so its length is known — and the audio is
// embedded so the file works with no network, like the plain answer.html.
async function sendReadAlong(ctx: Context, threadId: number | undefined, key: string, task: SpeechTask,
                             units: SpeechUnit[], timings: UnitTiming[], oggPath: string,
                             seconds: number, replyTo?: number): Promise<void> {
  if (task.cancelled || !timings.length || !READALONG_MAX_MIN) return
  // Only for answers that ALSO arrived as answer.md/.html. Every voice note used to
  // get a page, so a thirty-second reply came with a document to open — the page is
  // for following a long answer, and a short one is just clutter with an attachment.
  if (!task.withFiles) return
  // Measured, not projected from the duration: the .ogg on disk is the thing that
  // becomes the page, and base64 adds a known third. Checking the real file also
  // means the page is never BUILT when it could not be sent — base64-ing 40 MB of
  // audio into a string first, only to throw it away, is the sort of thing that
  // takes a small VPS down.
  const oggBytes = statSync(oggPath).size
  const pageBytes = Math.ceil(oggBytes * 4 / 3) + 64 * 1024      // + the page around it
  const tooLong = seconds > READALONG_MAX_MIN * 60
  const tooBig = pageBytes > TG_UPLOAD_LIMIT
  if (tooLong || tooBig) {
    // SAID, not just logged. Three of the four ways this function can produce
    // nothing are decisions the user would accept instantly if told — "26 minutes,
    // the page would have been 9 MB" is a fine answer; silence is not, and from a
    // phone it is indistinguishable from the feature being broken.
    const why = tooBig
      ? `it would be ${(pageBytes / 1024 / 1024).toFixed(0)} MB, over the ${Math.round(TG_UPLOAD_LIMIT / 1024 / 1024)} MB Telegram accepts`
      : `${fmtDurationWords(seconds)} is over the ${READALONG_MAX_MIN} minute cap`
    console.log(`[voice] read-along skipped: ${why}`)
    await send(ctx, threadId, `📖 No read-along page for this one — ${why}. The full audio and the answer files above have everything.`, true, replyTo)
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'tg-read-'))
  try {
    const uri = `data:audio/ogg;base64,${readFileSync(oggPath).toString('base64')}`
    const file = join(dir, 'answer-readalong.html')
    writeFileSync(file, readAlongHtml('Answer', units, timings, uri))
    // Threaded to the full audio message, which is the closest Telegram allows to
    // sending the two together: sendMediaGroup refuses to mix an audio with a
    // document ("Documents and audio files can be only grouped in an album with
    // messages of the same type"), so one message holding both cannot be built.
    // The reply is what keeps them adjacent and visibly one thing.
    await sendFile(ctx, threadId, file,
      '📖 Read along with the full answer above — it highlights each part as it is spoken.', replyTo)
    noteBotMessage(key)
  } catch (e) { console.error(`[voice] read-along: ${e}`) }
  finally { rmSync(dir, { recursive: true, force: true }) }
}

// Speak an answer back as Telegram voice. Returns false when nothing could be
// spoken, so the caller can say so once rather than dropping to text in silence.
async function speakAnswer(ctx: Context, threadId: number | undefined, key: string, text: string, mode: 'full' | 'summary', replyTo?: number): Promise<boolean> {
  const clean = stripMd(text).trim()
  if (!clean) return true
  if (mode === 'summary') {
    // A couple of sentences by design, so it neither needs chunking nor the cap
    // lifted — the cap is the safety net for a summary that came back long.
    const speak = stripMd((await summarizeForSpeech(text)) || clean).trim().slice(0, VOICE_SPEAK_MAX)
    if (!speak) return true
    const dir = mkdtempSync(join(tmpdir(), 'tg-tts-'))
    try {
      const ogg = await synthesize(speak, join(dir, 'reply.ogg'), key)
      if (!ogg) return false
      await ctx.api.sendVoice(ctx.chat!.id, new InputFile(ogg), destOpts({ threadId, replyTo }))
        .catch(e => console.error(`[voice] sendVoice: ${e}`))
      noteBotMessage(key)
      return true
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  if (canChunk()) return speakChunked(ctx, threadId, key, text, replyTo)
  // Piper/espeak: one note, and the cap still applies because there is no way to
  // stream them. Said plainly rather than cut in silence — see the caller.
  const speak = stripMd(text).trim().slice(0, VOICE_SPEAK_MAX)
  const dir = mkdtempSync(join(tmpdir(), 'tg-tts-'))
  try {
    const ogg = await synthesize(speak, join(dir, 'reply.ogg'), key)
    if (!ogg) return false
    await ctx.api.sendVoice(ctx.chat!.id, new InputFile(ogg), destOpts({ threadId, replyTo }))
      .catch(e => console.error(`[voice] sendVoice: ${e}`))
    noteBotMessage(key)
    return true
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
  void enqueue(key, () => handlePrompt(ctx, topicId, key, brief, undefined, undefined, { background: true }))
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
    () => handlePrompt(ctx, f.parentThreadId, key, preamble, undefined, f.askedBy, { forceReplyLink: true, background: true, isSynthesis: true }))
    .then(() => cleanupFanout(ctx, f))
    .then(() => disposeFanoutTopics(ctx, f))
    .catch(e => console.error(`[fanout ${f.id}] synthesis: ${e}`))
}

// What KIND of turn this is. Named rather than four trailing booleans, because
// they had become unreadable at the call sites and that is not cosmetic: `/bg` and
// the `— Run this now —` promotion both read `..., undefined, id, true, true)`,
// byte-identical, and the bug that hid in there for three weeks was one of those
// positions meaning something different from what it looked like.
type PromptKind = {
  // Quote the question even when the topic is calm enough that needsReplyLink
  // would not bother.
  forceReplyLink?: boolean
  // Runs off the topic's serial queue, and FORKS, so it gets its own session id
  // rather than interleaving with the topic's conversation.
  background?: boolean
  // The run that writes a fan-out's combined answer. It IS the answer.
  isSynthesis?: boolean
  // A message pushed past the queue by `— Run this now —`. Background, but the
  // user is sitting there waiting for it — unlike /bg, which they detached.
  promoted?: boolean
}
async function handlePrompt(ctx: Context, threadId: number | undefined, key: string, prompt: string, mode?: string, replyTo?: number, kind: PromptKind = {}): Promise<void> {
  // Renamed off `promoted` on the way in, because `promoteBlock`'s result already
  // owns that name further down this function. Left as-is it SHADOWED this flag, so
  // the banner check below read a mid-turn text block where it meant a kind of turn
  // — and silently, since a string is a fine thing to negate. Caught by its own test,
  // which is the only reason it is not still in here.
  const { forceReplyLink = false, background = false, isSynthesis = false, promoted: promotedTurn = false } = kind
  // A message promoted to run in parallel has already been handled; its turn in the
  // queue must do nothing rather than run it a second time.
  //
  // `!background` is load-bearing, and its absence is why the button never once
  // worked: `par:` sets the flag and then forks the promoted run with the SAME id as
  // its replyTo, so the promoted run walked into the guard meant for its twin,
  // consumed the flag and returned before spawning anything — after telling the user
  // it had started. The guard is only ever about the QUEUED copy, which is always a
  // foreground turn; scoping it that way also keeps the other background callers that
  // pass a replyTo (/bg, the fan-out synthesis) out of a guard never aimed at them.
  if (!background && replyTo !== undefined && skipQueued.has(replyTo)) { skipQueued.delete(replyTo); return }
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
    //
    //
    // Never when the run FORKED. `res.sessionId` is then a branch off the topic's
    // conversation, and writing it back is exactly the theft the fork exists to
    // prevent: the topic would silently continue from the parallel job's transcript
    // instead of its own. `onInit` above was already guarded; this half was not, and
    // until the fix above it was unreachable, because no promoted run ever completed.
    //
    // The condition is `forked`, not `background`, and the difference is load-bearing.
    // `runStreaming` forks only when it also resumes (`fork && resumeId`, the
    // --fork-session line), so a background run in a topic with no session yet is not
    // a fork — it is that topic's first conversation. A fan-out part is exactly that
    // case: it runs with background = true in its OWN topic, and the topic exists to
    // be steered, which needs the part's session. Guarding on `background` alone
    // leaves every part topic unbound, so the first correction you type starts from
    // nothing.
    const forked = background && resumeId !== undefined
    if (res.sessionId && !forked) bindSession(res.sessionId)
    if (res.noAnswer) {
      await sendNoAnswer(ctx, threadId, key, prompt, replyLink())
      return
    }
    // When the turn's closing block only promises future work or refers to work
    // the user never saw, deliver the substantive block before it as well. The
    // rest of the turn's text is in the run record above, so this is an
    // enhancement rather than the mechanism: a miss costs a tap, not a message.
    const promotedBlock = promoteBlock(res.blocks ?? [], res.text)
    if (promotedBlock) await deliver(ctx, threadId, promotedBlock, replyLink())
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
    // A forked run is a dead end: the topic's own conversation never sees it, so
    // without this the next turn has no idea the job happened. Carried for every
    // detached job, promoted or not — the fan-out cases are excluded because their
    // results reach the topic by their own routes (a part binds its own session; a
    // synthesis IS the topic's answer).
    if (background && !owner && !isSynthesis) noteBgResult(key, res.text)
    // The BANNER is a narrower question than carrying the result, and its own
    // precondition is written above: a /bg result "arrives long after it was asked
    // for". That is what it is for — closing the promise /bg makes when it says
    // "carry on here, I will report back", after a gap in which the topic has moved
    // on and an old answer is easy to misread as a new one. It is silent by design,
    // so it costs scrollback rather than a notification.
    //
    // None of that holds for a promoted turn. You tapped a button seconds ago and
    // are watching for the answer; nothing promised to report back; and a background
    // answer always quotes its question (`link` is replyTo unconditionally, bypassing
    // needsReplyLink), so the one signal the banner adds is the one already there.
    // Reported as exactly that: "it feels unnecessary… I can know it is the answer by
    // the reply response". This is the third case that does not fit the premise, after
    // the fan-out part and the synthesis.
    if (background && !owner && !isSynthesis && !promotedTurn) {
      await send(ctx, threadId, `🌿 Background task finished.`, true, link)
    }
    const answerId = await deliver(ctx, threadId, res.text, link)
    await flushOutbox(ctx, threadId, cwd, key, link)
    // Speak the answer too when this topic is in voice mode.
    //
    // NOT awaited here, and not on this topic's queue. Synthesis was measured at 65s
    // for a note at the old cap, and it sat INSIDE the turn — so the next message you
    // sent waited on audio for an answer you already had in your hand, and the bridge
    // told you it was "still working on an earlier message" when that message was
    // finished. Turns are serialised because two `claude --resume` runs on one
    // transcript corrupt it; synthesis touches no session, no transcript and no cwd,
    // so it has no business on that queue. Its own key keeps notes for one topic in
    // order without holding up the topic itself.
    //
    // Threaded to the ANSWER when there was a single one, falling back to the
    // question: the note is another rendering of the answer, and it was the one send
    // in the file that bypassed destOpts entirely, so two turns in flight gave you
    // untethered audio bubbles with nothing to match them to.
    const vm = voiceMode(key)
    if (vm !== 'off' && !res.isError) {
      // `link` is NOT a usable fallback on its own: needsReplyLink deliberately
      // returns false for an ordinary lone question, so `link` is undefined exactly
      // when the topic is calm. Chaining to it meant that whenever deliver could not
      // name a single message — a long answer sent as a file group, or a reply long
      // enough to be chunked — the note replied to NOTHING. Reported from production
      // on a YouTube summary, which is precisely the long-answer case. The user's own
      // message is always there, and destOpts sets allow_sending_without_reply, so a
      // deleted question costs the reply and never the note.
      void enqueue(`${key}#voice`, () => speakAnswer(ctx, threadId, key, res.text, vm, answerId ?? link ?? replyTo)
        .then(ok => { if (!ok) void warnNoVoice(ctx, threadId, key) }))
    }
  } catch (e) {
    await send(ctx, threadId, `⚠️ ${e}`, false, replyLink())
  }
}

// Built-in CLI slash commands that the client answers by itself: they report
// (usage, cost, context) rather than prompt the model, so they cost nothing and
// take no turn. Anything that actually drives the model (/doctor) or that the
// bridge already owns (/status, /new, …) is deliberately not here.
const PASSTHROUGH = new Set(['/usage', '/cost', '/context'])

// /usage, /cost and /context are SNAPSHOTS of a moving number, not conversation.
// Every check used to be a permanent message, so looking at your limit five times
// in an evening buried the real work under five near-identical blocks. They now
// carry a Refresh button that re-runs the command and edits the same message.
//
// A refresh must NOT take the topic's queue key. Passthrough neither reads nor
// writes the topic's session, so it has no ordering to preserve — and on the topic's
// chain a refresh tapped during a long agentic turn just sits there, which is
// indistinguishable from a dead button. Its own key lets it answer in ~2s.
const passthroughQueueKey = (key: string) => `${key}#pt`

// In-flight guard, per message. Each tap is a whole `claude -p` — a ~2s start and a
// ~300 MB child — so a double-tap or a held button must not fan out into a queue of
// them. Keyed by the message being refreshed, not by topic, so two report messages
// in one topic stay independent.
const refreshing = new Set<string>()

// Forward one such command to the CLI and return what it printed. The session id it
// returns is NEVER stored: with --resume it's the same id anyway, and without one
// the CLI mints a throwaway that would otherwise bind this topic to an empty session.
// The button path goes through HERE rather than reaching for runStreaming directly,
// so that guarantee is made in one place instead of two.
async function runPassthrough(ctx: Context, threadId: number | undefined, key: string, text: string): Promise<string> {
  const cwd = resolveCwd(ctx, threadId)
  const res = await runStreaming(ctx, threadId, key, text, cwd, sessions[key]?.sessionId, modeFor(key), modelFor(key), { silent: true })
  return res.text
}

const refreshKb = (cmd: string) => ({ inline_keyboard: [[{ text: '🔄 Refresh', callback_data: `psx:${cmd.replace(/^\//, '')}` }]] })
// Stamped on every render so two taps a minute apart always differ. Without it a
// refresh that found the same numbers is rejected by Telegram as "message is not
// modified" and the button looks broken exactly when it is working.
const stamped = (body: string) => `${body}\n\n_updated ${new Date().toTimeString().slice(0, 8)}_`

async function handlePassthrough(ctx: Context, threadId: number | undefined, key: string, text: string): Promise<void> {
  let out: string
  try {
    out = await runPassthrough(ctx, threadId, key, text)
  } catch (e) { await send(ctx, threadId, `⚠️ ${e}`); return }
  if (stopped.has(key)) { stopped.delete(key); return }
  const cmd = text.trim().split(/\s+/)[0].toLowerCase().replace(/@\S+$/, '')
  const body = stamped(out.trim())
  // The button only goes on an answer that fits ONE message. A chunked report has
  // no single message to edit, and a Refresh that silently replaced the first of
  // four chunks would be worse than no button.
  if (chunk(body).length !== 1) { await deliver(ctx, threadId, out); return }
  noteBotMessage(key)
  const opts: any = { ...destOpts({ threadId }), reply_markup: refreshKb(cmd) }
  await ctx.api.sendMessage(ctx.chat!.id, telegramify(sanitizeProse(mdTablesToCode(body), 'markdownv2'), 'escape'),
    { ...opts, parse_mode: 'MarkdownV2' })
    .catch(() => ctx.api.sendMessage(ctx.chat!.id, stripMd(body), opts))
    .catch(e => console.error(`[warn] passthrough send: ${e}`))
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

// ---------------------------------------------------------------------------
// The /sessions picker
//
// /sessions used to print `965a503a · 162 turns · 3h ago` — an EIGHT-character
// prefix — while /resume did a literal existsSync(<arg>.jsonl) on the full 36-char
// uuid. So copying exactly what the bridge had just shown you and pasting it back
// failed. The command told you the answer in a form it then refused to accept, and
// the list wasn't even a code span, so on a phone you were hand-selecting hex out of
// a paragraph. Both halves are fixed: the list is tappable, and the typed form now
// resolves a prefix (see /resume).
//
// A tappable LINK cannot do this and it is worth writing down so nobody retries it:
// text links only open URLs; Telegram auto-linkifies a bare `/command` token but
// never its arguments, so a printed `/resume <id>` taps as a bare `/resume`, which
// is NOT a no-op — it swaps in prevSessionId and would rebind the topic to the wrong
// session. An inline keyboard is the only in-chat tap that carries a payload.
// ---------------------------------------------------------------------------

const LISTING_PAGE = 8
// Telegram renders a button label on one line and truncates what does not fit; 64
// is about what a phone shows before it starts cutting.
const BUTTON_LABEL_MAX = 64
type Listing = { dir: string; ids: string[]; labels: string[]; titles: string[] }
// Bounded, and lost on restart — a tap on a stale listing is told to run /sessions
// again rather than silently doing nothing. Keyed by a short token because
// callback_data caps at 64 bytes and an absolute path does not fit in one.
const listings = new Map<string, Listing>()
function newListing(dir: string, list: SessionInfo[]): string {
  const token = Math.random().toString(36).slice(2, 8)
  listings.set(token, {
    dir,
    ids: list.map(s => s.id),
    labels: list.map(s => `${s.id.slice(0, 8)} · ${s.turns} turns · ${ago(s.mtimeMs)}`),
    // What the session was ABOUT: its transcript summary, or failing that the first
    // thing you said in it. An id, a turn count and an age identify a session to the
    // filesystem and to nobody else — you cannot recognise your own conversation
    // from `d2b39072`, which made the picker as unusable as the listing it replaced.
    titles: list.map(s => s.title),
  })
  // Oldest out first; Map preserves insertion order.
  while (listings.size > 40) listings.delete(listings.keys().next().value as string)
  return token
}
const pageCount = (n: number) => Math.max(1, Math.ceil(n / LISTING_PAGE))

function listingText(token: string, offset: number): string {
  const L = listings.get(token)
  if (!L) return 'That listing has expired — run /sessions again.'
  const pages = pageCount(L.ids.length)
  const page = Math.floor(offset / LISTING_PAGE) + 1
  // Title first, because that is the line you actually read; the id, turn count and
  // age go underneath as the supporting detail. The number ties each entry to the
  // button below it.
  const body = L.labels.slice(offset, offset + LISTING_PAGE)
    .map((l, i) => `${offset + i + 1}. ${L.titles[offset + i]}\n   ${l}`).join('\n\n')
  return `Sessions in ${L.dir} (${L.ids.length}) — page ${page}/${pages}\n\n${body}\n\nTap one to bind this topic to it.`
}

function listingKb(token: string, offset: number): any {
  const L = listings.get(token)
  if (!L) return { inline_keyboard: [] }
  // One session per row, and the row says what the session was ABOUT. The number
  // matches the numbered entry above, which carries the id and the age; repeating
  // those here would spend the whole label on the part you cannot recognise.
  const rows: any[][] = L.titles.slice(offset, offset + LISTING_PAGE)
    .map((title, i) => {
      const n = offset + i + 1
      const room = BUTTON_LABEL_MAX - `${n}. `.length
      const t = title.length > room ? title.slice(0, room - 1).trimEnd() + '…' : title
      return [{ text: `${n}. ${t}`, callback_data: `res:${token}:${offset + i}` }]
    })
  const pages = pageCount(L.ids.length)
  if (pages > 1) {
    const page = Math.floor(offset / LISTING_PAGE) + 1
    const nav: any[] = []
    if (offset > 0) nav.push({ text: '‹ Prev', callback_data: `spg:${token}:${offset - LISTING_PAGE}` })
    nav.push({ text: `${page}/${pages}`, callback_data: 'spg:noop' })
    if (offset + LISTING_PAGE < L.ids.length) nav.push({ text: 'Next ›', callback_data: `spg:${token}:${offset + LISTING_PAGE}` })
    rows.push(nav)
  }
  return { inline_keyboard: rows }
}

// Bind a topic to a past session, with the validation /resume performs — the button
// is a shortcut to that command, not a way around its checks. Returns the line to
// show the user. Naming what it moved FROM as well as TO is deliberate: a silent
// rebind is indistinguishable from nothing having happened.
function bindPastSession(key: string, id: string, ctx: Context, threadId: number | undefined): string {
  const e = sessions[key] ?? (sessions[key] = { cwd: resolveCwd(ctx, threadId) })
  if (!existsSync(join(projectDir(e.cwd), `${id}.jsonl`))) {
    return `That session no longer exists in this topic's directory:\n${e.cwd}`
  }
  if (e.sessionId === id) return `Already on session ${id.slice(0, 8)} — nothing changed.`
  const from = e.sessionId
  e.prevSessionId = e.sessionId; e.sessionId = id; saveState()
  // prevSessionId holds exactly ONE step, so a second switch overwrites the original
  // binding and a bare /resume will not get it back. Say so rather than let it
  // surprise someone two switches later.
  return from
    ? `↩️ Switched from ${from.slice(0, 8)} to ${id.slice(0, 8)} — message to continue it.\nA bare /resume undoes this once; a second switch overwrites that.`
    : `↩️ Bound this topic to session ${id.slice(0, 8)} — message to continue it.`
}

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
          // transcriptSpeech strips OUR framing and the harness's injected blocks and
          // returns '' when a turn is nothing but scaffolding — so the label falls
          // through to the next turn rather than naming the session after a caveat
          // banner or a preamble about outbox directories.
          if (o.type === 'user' && !firstUser && !t.startsWith('⚙️')) firstUser = transcriptSpeech(t)
        }
      }
      out.push({
        id: f.replace(/\.jsonl$/, ''), file, mtimeMs: st.mtimeMs,
        // 200, not 80: the picker's MESSAGE has room for a real sentence and that is
        // what makes a session recognisable. The button truncates separately, since
        // it has one line to work with.
        title: (title || firstUser || '(untitled)').replace(/\s+/g, ' ').slice(0, 200), turns,
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
    // Speech is not a job — it runs on its own queue key, which is exactly why it did
    // not block the topic — so it has to be cancelled explicitly. Someone typing
    // /stop wants everything to stop; ending the model turn while ten minutes of
    // audio keeps arriving is the surprise this exists to remove.
    const spoke = cancelSpeech(key, '/stop')
    if (!running.length) {
      await send(ctx, threadId, spoke
        ? '⏹ Stopped speaking. Nothing else was running in this topic.'
        : 'Nothing is running in this topic right now.', true)
      return
    }
    stopped.add(key)
    for (const j of running) void endJob(j, 'discard')
    // Quote the question being cancelled. By the time you cancel, that message is
    // far up the topic, and "cancelled" on its own does not say cancelled WHAT.
    await send(ctx, threadId,
      `⏹ Cancelled — the run and everything it started are being stopped, and its answer is discarded.${spoke ? ' Speaking stopped too.' : ''}\nUse /interrupt instead to stop but keep the partial answer.`,
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
    const parts = text.split(/\s+/)
    const arg = parts[1]?.toLowerCase()
    // /voice speaker <id> is the escape hatch for the 46 voices the keyboard does
    // not show. Kokoro ships 54 and eight is what fits a phone.
    if (arg === 'speaker' || arg === 'voice') {
      const id = (parts[2] || '').toLowerCase()
      if (!id) {
        await send(ctx, threadId, `🎙 Speaker here: ${speakerLabel(speakers[key] || SPEAKER_DEFAULT)} (${speakers[key] || SPEAKER_DEFAULT})\n\nUsage: /voice speaker <id>, e.g. bm_george. Tap /voice for the shortlist.`)
        return
      }
      if (!isSpeakerId(id)) { await send(ctx, threadId, `Not a Kokoro voice id: ${id}. They look like af_heart or bm_george.`); return }
      speakers[key] = id; saveState()
      await send(ctx, threadId, `🎙 Speaker set to ${speakerLabel(id)} (${id}, ${kokoroLang(id)}).`)
      return
    }
    // Sticky, because the preference is stable: someone who wants the parts wants them
    // every time. The status bubble's button is the per-answer override in whichever
    // direction this is not.
    if (arg === 'parts') {
      const v = (parts[2] || '').toLowerCase()
      if (v !== 'on' && v !== 'off') {
        await send(ctx, threadId, `🎙 Parts here: ${partsMode(key) ? 'on' : 'off'}\n\n` +
          (partsMode(key)
            ? 'Each chunk arrives as its own voice note, then the full file.'
            : 'Only the full file is sent; tap ▶️ on the status message for the parts.') +
          '\n\nUsage: /voice parts on | off')
        return
      }
      voiceParts[key] = v === 'on'; saveState()
      await send(ctx, threadId, v === 'on'
        ? '🎙 Parts ON — every chunk arrives as it is made, then the full file. They are tidied away once it lands.'
        : '🎙 Parts OFF — one status message while I speak, then the full file. Tap ▶️ on it for the parts.')
      return
    }
    let next: 'off' | 'full' | 'summary' | undefined
    if (arg === 'off') next = 'off'
    else if (arg === 'on' || arg === 'full') next = 'full'
    else if (arg === 'summary' || arg === 'short' || arg === 'summarized') next = 'summary'
    else if (!arg) {
      // A keyboard, like /mode and /model and /effort. /voice was the last setting
      // that answered with a plain-text menu you had to type back at.
      await ctx.api.sendMessage(chatId, voiceText(key), { ...destOpts({ threadId }), reply_markup: voiceKeyboard(key) })
        .catch(e => console.error(`[warn] /voice: ${e}`))
      noteBotMessage(key)
      return
    } else { await send(ctx, threadId, 'Usage: /voice on | summary | off | parts on|off | speaker <id>'); return }
    if (next === 'off') delete voice[key]; else voice[key] = next
    saveState()
    await send(ctx, threadId,
      next === 'full' ? `🎙 Voice ON (full) — I speak the whole answer, and the complete answer also comes as text.`
      : next === 'summary' ? '🎙 Voice ON (summary) — I speak a short summary; the complete answer still comes as text.'
      : '🔇 Voice OFF — replies are text only.')
    // Probe HERE, not at the first answer. This is the moment you asked for voice
    // and are waiting to hear about it — the only moment where "this will not work"
    // is useful rather than annoying. Naming the engine on success matters as much:
    // it is the only way to learn you are on robotic espeak instead of Kokoro
    // without listening to a note and guessing.
    if (next !== 'off') {
      const p = probeVoice(true)
      if (!p.speak) {
        await send(ctx, threadId, `⚠️ …but text-to-speech is not available here${p.detail ? ` — missing ${p.detail}` : ''}.`, true)
        await offerVoiceInstall(ctx, threadId)
      } else {
        await send(ctx, threadId,
          `Engine: ${p.engine} · ${speakerLabel(speakers[key] || SPEAKER_DEFAULT)}` +
          (p.listen ? '' : '\n⚠️ Listening is unavailable (faster-whisper missing) — voice notes you send will not be transcribed.'), true)
      }
    }
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
      // A PREFIX is accepted, not just the full uuid. /sessions prints 8 characters
      // and this command used to demand all 36, so pasting back exactly what the
      // bridge had just shown you failed — the two commands contradicted each other.
      // Ambiguity fails loudly: silently picking one of two matching sessions is how
      // you end up continuing the wrong conversation without noticing.
      let id = arg
      if (!existsSync(join(projectDir(e.cwd), `${arg}.jsonl`))) {
        const hits = listSessions(e.cwd).filter(s => s.id.startsWith(arg))
        if (hits.length === 0) {
          await send(ctx, threadId, `No session ${arg} found for this topic's directory:\n${e.cwd}\n\nRun /sessions to pick one.`); return
        }
        if (hits.length > 1) {
          await send(ctx, threadId, `${arg} matches ${hits.length} sessions here:\n${hits.map(h => `  ${h.id}`).join('\n')}\n\nGive more characters, or run /sessions to pick one.`); return
        }
        id = hits[0].id
      }
      await send(ctx, threadId, bindPastSession(key, id, ctx, threadId))
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
      () => handlePrompt(ctx, threadId, key, task, undefined, msg.message_id, { forceReplyLink: true, background: true }))
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
      `voice: ${voiceMode(key)}${voiceMode(key) !== 'off' && partsMode(key) ? ' (parts)' : ''}\n\n` +
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
      const token = newListing(dir, list)
      await ctx.api.sendMessage(chatId, listingText(token, 0), {
        ...destOpts({ threadId }), reply_markup: listingKb(token, 0),
      }).catch(e => console.error(`[warn] /sessions: ${e}`))
      noteBotMessage(key)
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
    enqueue(passthroughQueueKey(key), () => handlePassthrough(ctx, threadId, key, text))
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
  // Every `[in]` line in the log is a message, so a tap used to be invisible: the log
  // could not tell "the button was never pressed" from "it was pressed and the run
  // died silently" — the two hypotheses that had to be separated to find the bug
  // above, which took a diagnosis instead of a glance.
  console.log(`[cb] ${data} key=${key}`)
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
      () => handlePrompt(ctx, rec.threadId, rec.key, rec.prompt, undefined, id, { forceReplyLink: true, background: true, promoted: true }))
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
    void enqueue(rec.key, () => handlePrompt(ctx, rec.threadId, rec.key, rec.prompt, undefined, rec.replyTo, { forceReplyLink: true }))
      .catch(e => console.error(`[error] retry ${rec.key}: ${e}`))
    return
  }
  if (data.startsWith('vstop:')) {
    const t = speechTasks.get(data.slice(6))
    if (!t || t.cancelled || !t.child) { await ctx.answerCallbackQuery({ text: 'That answer has already finished speaking.' }).catch(() => {}); return }
    // Answered before the kill: Telegram wants a reply within ten seconds and the
    // child may take a moment to die. Idempotent by the guard above, because this
    // button WILL be tapped twice.
    await ctx.answerCallbackQuery({ text: 'Stopping…' }).catch(() => {})
    cancelSpeech(t.key, 'user')
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    return
  }
  if (data.startsWith('vparts:')) {
    const t = speechTasks.get(data.slice(7))
    // speechByTopic is cleared when a run ends, and a finished task keeps its record
    // only so the tidy button can honour itself. Releasing parts into a run whose temp
    // directory has already been removed would upload nothing, slowly.
    if (!t || t.cancelled || speechByTopic.get(t.key) !== t.id) {
      await ctx.answerCallbackQuery({ text: 'That answer has already finished speaking.' }).catch(() => {}); return
    }
    if (t.sendParts) { await ctx.answerCallbackQuery({ text: 'Already sending the parts.' }).catch(() => {}); return }
    // Answered first: Telegram wants a reply inside ten seconds and the back-fill is a
    // run of uploads. Idempotent by the guard above and by release() itself, because
    // this button WILL be tapped twice.
    const waiting = t.held.length
    await ctx.answerCallbackQuery({ text: waiting ? `Sending ${waiting} part(s)…` : 'Parts on — they will arrive as they are made.' }).catch(() => {})
    t.release?.('button')
    // The offer is spent. The 🛑 stays, because there is still something to stop —
    // and this edits the message the button was tapped on, which IS the status bubble.
    await ctx.editMessageReplyMarkup({
      reply_markup: { inline_keyboard: [[{ text: '🛑 Stop speaking', callback_data: `vstop:${t.id}` }]] },
    }).catch(() => {})
    return
  }
  if (data.startsWith('vtidy:')) {
    const t = speechTasks.get(data.slice(6))
    if (!t) { await ctx.answerCallbackQuery({ text: 'Those notes are no longer tracked.' }).catch(() => {}); return }
    await ctx.answerCallbackQuery({ text: 'Removing the parts…' }).catch(() => {})
    const gone = await tidySpeech(ctx, t)
    // The button retires with the notes it removed; leaving it invites a tap that
    // can do nothing.
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    console.log(`[voice] tidied ${gone} note(s) for ${t.id}`)
    return
  }
  if (data.startsWith('voice:')) {
    const v = data.slice(6)
    if (v !== 'full' && v !== 'summary' && v !== 'off') { await ctx.answerCallbackQuery({ text: 'Unknown voice mode.' }).catch(() => {}); return }
    if (v === 'off') delete voice[key]; else voice[key] = v
    saveState()
    await ctx.answerCallbackQuery({ text: `Voice: ${v}` }).catch(() => {})
    await ctx.editMessageText(voiceText(key), { reply_markup: voiceKeyboard(key) }).catch(() => {})
    return
  }
  if (data.startsWith('vpartset:')) {
    const on = data.slice(9) === 'on'
    voiceParts[key] = on
    saveState()
    await ctx.answerCallbackQuery({ text: on ? 'Parts: on' : 'Parts: off' }).catch(() => {})
    await ctx.editMessageText(voiceText(key), { reply_markup: voiceKeyboard(key) }).catch(() => {})
    return
  }
  if (data.startsWith('vspg:')) {
    await ctx.answerCallbackQuery().catch(() => {})
    await ctx.editMessageText(voiceText(key), { reply_markup: voiceKeyboard(key, Number(data.slice(5)) || 0) }).catch(() => {})
    return
  }
  if (data.startsWith('vspk:')) {
    const id = data.slice(5)
    if (!isSpeakerId(id)) { await ctx.answerCallbackQuery({ text: 'Unknown speaker.' }).catch(() => {}); return }
    speakers[key] = id; saveState()
    await ctx.answerCallbackQuery({ text: `Speaker: ${speakerLabel(id)}` }).catch(() => {})
    await ctx.editMessageText(voiceText(key), { reply_markup: voiceKeyboard(key) }).catch(() => {})
    return
  }
  if (data === 'vinst:go') {
    // Only ever on an explicit tap. Answered immediately because setup takes minutes
    // and Telegram wants a callback answered within ten seconds.
    await ctx.answerCallbackQuery({ text: 'Starting voice setup…' }).catch(() => {})
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    void runVoiceSetup(ctx, ctx.callbackQuery.message?.message_thread_id)
    return
  }
  if (data === 'spg:noop') { await ctx.answerCallbackQuery().catch(() => {}); return }
  if (data.startsWith('spg:')) {
    const [token, off] = data.slice(4).split(':')
    if (!listings.has(token)) { await ctx.answerCallbackQuery({ text: 'That listing has expired — run /sessions again.', show_alert: true }).catch(() => {}); return }
    const offset = Math.max(0, Number(off) || 0)
    await ctx.answerCallbackQuery().catch(() => {})
    // Edit in place. A listing that reposts itself per page buries the topic, which
    // is the thing /sessions is supposed to help you dig out of.
    await ctx.editMessageText(listingText(token, offset), { reply_markup: listingKb(token, offset) }).catch(() => {})
    return
  }
  if (data.startsWith('res:')) {
    const [token, idxRaw] = data.slice(4).split(':')
    const L = listings.get(token)
    if (!L) { await ctx.answerCallbackQuery({ text: 'That listing has expired — run /sessions again.', show_alert: true }).catch(() => {}); return }
    const id = L.ids[Number(idxRaw)]
    if (!id) { await ctx.answerCallbackQuery({ text: 'That entry is gone.', show_alert: true }).catch(() => {}); return }
    const threadId = ctx.callbackQuery.message?.message_thread_id
    // /resume only ever looks in THIS topic's cwd, so a session listed from another
    // directory cannot be bound from here. Saying so is the whole fix — the old
    // listing offered those ids with nothing to indicate they were unusable.
    const cwd = sessions[key]?.cwd ?? resolveCwd(ctx, threadId)
    if (resolve(L.dir) !== resolve(cwd)) {
      await ctx.answerCallbackQuery({
        text: `That session lives in ${L.dir}, not this topic's directory. Run /cwd ${L.dir} first — note that resets this topic's history.`,
        show_alert: true,
      }).catch(() => {})
      return
    }
    const line = bindPastSession(key, id, ctx, threadId)
    await ctx.answerCallbackQuery({ text: line.slice(0, 200) }).catch(() => {})
    // The picker is dropped once a choice is made: a stale keyboard sitting above a
    // switched topic invites a second, accidental tap.
    await ctx.editMessageText(line, { reply_markup: { inline_keyboard: [] } }).catch(() => {})
    return
  }
  if (data.startsWith('psx:')) {
    const cmd = `/${data.slice(4)}`
    if (!PASSTHROUGH.has(cmd)) { await ctx.answerCallbackQuery({ text: 'Unknown report.' }).catch(() => {}); return }
    const msgId = ctx.callbackQuery.message?.message_id
    const guard = `${ctx.chat!.id}:${msgId}`
    if (refreshing.has(guard)) { await ctx.answerCallbackQuery({ text: 'Already refreshing…' }).catch(() => {}); return }
    refreshing.add(guard)
    // Answered before the run, not after: Telegram wants a reply within 10s and this
    // takes at least a CLI start, so the spinner must be cleared up front.
    await ctx.answerCallbackQuery({ text: 'Refreshing…' }).catch(() => {})
    const threadId = ctx.callbackQuery.message?.message_thread_id
    try {
      await enqueue(passthroughQueueKey(key), async () => {
        const out = await runPassthrough(ctx, threadId, key, cmd)
        const body = stamped(out.trim())
        if (chunk(body).length !== 1) {
          await ctx.answerCallbackQuery({ text: 'Too long to edit in place — sending it below.' }).catch(() => {})
          await deliver(ctx, threadId, out)
          return
        }
        // Edited in the modality it was sent in, or the message changes font mid-life.
        const markup = refreshKb(cmd)
        await ctx.editMessageText(telegramify(sanitizeProse(mdTablesToCode(body), 'markdownv2'), 'escape'),
          { parse_mode: 'MarkdownV2', reply_markup: markup })
          .catch(() => ctx.editMessageText(stripMd(body), { reply_markup: markup }))
      })
    } catch (e) {
      await ctx.answerCallbackQuery({ text: `Refresh failed: ${e}`, show_alert: true }).catch(() => {})
    } finally { refreshing.delete(guard) }
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
  // Checked once at boot, beside permission and api, so a deployment with TG_VOICE=1
  // learns its engine is missing here rather than after the first message.
  if (VOICE_DEFAULT) {
    const p = probeVoice(true)
    console.log(`     voice          : speak ${p.speak ? `yes (${p.engine})` : 'NO'} · listen ${p.listen ? 'yes' : 'NO'}` +
      (p.detail ? ` — missing ${p.detail}; run voice/setup.sh` : ''))
  }
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
export const _answerCaption = answerCaption
export const _probeVoice = probeVoice
export const _speakers = () => speakers
export const _listing = { make: newListing, text: listingText, kb: listingKb }
export const _listSessions = listSessions
export const _maybeSynthesise = maybeSynthesise
export const _normaliseUnits = normaliseUnits

// The kill switch, flippable from a test: an env read at import time cannot be
// exercised in-process, and a switch no test ever throws is a switch nobody knows works.
export function _setNormaliseSpeech(on: boolean): boolean {
  const was = NORMALISE_SPEECH
  NORMALISE_SPEECH = on
  return was
}

export function _drainQueue(key: string): Promise<unknown> { return queues.get(key) ?? Promise.resolve() }

// Guarded so the module can be imported by a test without starting a poller.
if (import.meta.main) main().catch(e => { console.error(`[fatal] ${e}`); process.exit(1) })
