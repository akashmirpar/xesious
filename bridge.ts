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
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, renameSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs'
import { dirname, join, isAbsolute, basename, extname, resolve, relative } from 'node:path'
import { homedir, tmpdir } from 'node:os'

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
loadDotenv(join(HERE, '.env'))

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`[fatal] ${name} is required (set it in the environment or .env)`); process.exit(1) }
  return v
}
function parseIdList(s: string | undefined): Set<string> {
  return new Set((s || '').split(',').map(x => x.trim()).filter(Boolean))
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
const CLAUDE_TIMEOUT_MS = Number(process.env.TG_CLAUDE_TIMEOUT_MS || 30 * 60 * 1000)
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
const TELEGRAM_PROFILE = process.env.TG_PROFILE ?? [
  "You are replying through a Telegram bridge on the user's phone, not in an IDE. Every turn:",
  '- Be concise and phone-first: short messages, short paragraphs, minimal preamble.',
  '- Write in your normal markdown; the bridge encodes it for Telegram (tables become aligned code blocks, headings become bold). Just keep code fences balanced.',
  '- If a request is ambiguous or needs a decision, ask one clarifying question and stop.',
  '- Assume no editor or file selection is open. Ignore any IDE/editor framing from earlier in this conversation; the user is in a chat.',
  `- Files the user sends are saved in ./${INBOX_DIR}/. To send a file back, put it in ./${OUTBOX_DIR}/ and it is delivered then cleared.`,
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

// Importing existing Claude Code sessions (the ones the IDE/CLI session picker
// shows) as topics. A directory's sessions live at CLAUDE_PROJECTS/<encoded>/<id>.jsonl.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const CLAUDE_PROJECTS = join(CLAUDE_DIR, 'projects')
const IMPORT_BACKFILL = Math.max(0, Number(process.env.TG_IMPORT_BACKFILL || 12))  // turns backfilled per session
const IMPORT_MAX_SESSIONS = Math.max(1, Number(process.env.TG_IMPORT_MAX || 10))   // cap topics created per /import
const REPLY_FILE_CHARS = Math.max(0, Number(process.env.TG_REPLY_FILE_CHARS || 6000)) // replies longer than this go as a .md file
const INTERRUPT_DEFAULT = /^(1|true|yes)$/i.test(process.env.TG_INTERRUPT || '')       // a new message interrupts the running one instead of queueing

// ---------------------------------------------------------------------------
// Persistent state:  sessions[(chat:topic)] = { sessionId, cwd }
//                    names[(chat:topic)]    = "human topic name"
// ---------------------------------------------------------------------------

type Entry = { sessionId?: string; prevSessionId?: string; cwd: string; updated?: string }
let sessions: Record<string, Entry> = {}
let names: Record<string, string> = {}
// "💭 thinking…" status messages for in-flight runs. If the process is killed
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
// Per-topic model override, switchable with /model. Empty string ⇒ fall back to
// TG_MODEL, and empty TG_MODEL ⇒ the account default (no --model flag at all).
let models: Record<string, string> = {}
const modelFor = (key: string) => models[key] ?? MODEL

function keyFor(chatId: number | string, threadId: number | undefined): string {
  return `${chatId}:${threadId ?? 'main'}`
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
    }
  } catch (e) { console.error(`[warn] could not read state (${e}); starting empty`) }
}
function saveState(): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({ sessions, names, pending, interruptMode, modes, models }, null, 2))
  } catch (e) { console.error(`[warn] could not write state: ${e}`) }
}

// The icon for topics the bridge creates. Telegram only accepts custom-emoji ids
// from its built-in "Topics" set (getForumTopicIconStickers), and 📁 is the only
// folder in it — so a topic reads as a folder. Overriding needs an id from that
// set, not an arbitrary emoji. (An icon_color alone just tints a letter bubble,
// which is why an earlier attempt at a "flat folder" never produced one.)
const TOPIC_ICON = process.env.TG_TOPIC_ICON || '5357315181649076022' // 📁

function sanitize(name: string): string {
  return name.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'topic'
}

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
const activeRuns = new Map<string, ChildProcess>()
const stopped = new Set<string>()
function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(task)
  queues.set(key, next.catch(() => {}))
  return next
}

// ---------------------------------------------------------------------------
// Run the Claude Code CLI for one prompt against a topic's session.
// ---------------------------------------------------------------------------

interface ClaudeResult { text: string; sessionId?: string; isError: boolean }

// The permission postures the bridge offers, in ascending autonomy. `auto` routes
// each tool call through Claude's classifier (blocks the irreversible/destructive
// ones, no prompting) — configure what it trusts via `autoMode` in
// ~/.claude/settings.json. `plan` researches and proposes without touching files.
const ALL_MODES = ['plan', 'acceptEdits', 'auto', 'bypass'] as const
// `bypass` (= --dangerously-skip-permissions) removes the last guardrail on a bot
// that runs as root, so it is opt-in: without TG_ALLOW_BYPASS=1 it is neither
// offered as a button nor accepted as an argument.
const ALLOW_BYPASS = /^(1|true|yes)$/i.test(process.env.TG_ALLOW_BYPASS || '')
const MODES: readonly string[] = ALL_MODES.filter(m => m !== 'bypass' || ALLOW_BYPASS)
const MODE_HELP: Record<string, string> = {
  plan: 'read-only — researches and proposes, never edits',
  acceptEdits: 'auto-approves edits + the TG_ALLOWED_TOOLS list',
  auto: 'classifier-gated autonomy — blocks destructive/irreversible calls',
  bypass: 'no permission checks at all (--dangerously-skip-permissions)',
}
function normalizeMode(m: string): string | undefined {
  const s = m.trim().toLowerCase()
  if (s === 'bypass' || s === 'bypasspermissions') return ALLOW_BYPASS ? 'bypass' : undefined
  return MODES.find(x => x.toLowerCase() === s)
}
function permissionArgs(mode: string): string[] {
  // bypassPermissions is only honoured via its dedicated flag in -p runs.
  if (normalizeMode(mode) === 'bypass') return ['--dangerously-skip-permissions']
  return ['--permission-mode', mode, '--allowedTools', ALLOWED_TOOLS]
}

// Model choices offered by /model. The CLI takes a bare alias or a full id; these
// are the aliases, plus 'default' meaning "no --model flag, use the account
// default". A full id typed as an argument is passed through untouched.
const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const
const MODEL_DEFAULT = 'default' // the label for "clear the override"
// Returns '' for the default (clears the override), the alias/id otherwise.
function normalizeModel(m: string): string | undefined {
  const s = m.trim().toLowerCase()
  if (s === MODEL_DEFAULT || s === 'reset' || s === 'clear' || s === '') return ''
  if ((MODEL_ALIASES as readonly string[]).includes(s)) return s
  // A full model id (e.g. claude-opus-4-8) — accept it as given.
  if (/^claude[\w.-]*$/i.test(m.trim())) return m.trim()
  return undefined
}

// Env for the claude subprocess: strip TELEGRAM_*/TG_* so the Claude Code
// process (and any installed telegram channel plugin) can't grab our bot token
// and start a competing getUpdates poll on it (causes 409 and kills the bridge).
function childEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(e)) if (k.startsWith('TELEGRAM_') || k.startsWith('TG_')) delete e[k]
  return e
}

// A status line for one streamed event: a short label, plus the detail of what
// was actually tried (the command, the path, the query). The label alone reads as
// generic — "running a command" doesn't say which — so the detail carries the
// substance and the renderer collapses it behind an expandable quote.
// Set TG_PROGRESS_DETAIL=0 to drop the detail and keep the terse labels only.
type Step = { label: string; detail?: string }

function toolStep(b: any): Step {
  const n = b?.name || 'tool'
  const i = b?.input || {}
  const base = (p: any) => (p ? basename(String(p)) : '')
  const str = (v: any) => (v == null ? undefined : String(v))
  switch (n) {
    case 'Bash': return { label: '⚙️ Running a command', detail: str(i.command) }
    case 'Read': return { label: `📖 Reading ${base(i.file_path)}`.trimEnd(), detail: str(i.file_path) }
    case 'Edit': case 'Write': case 'NotebookEdit':
      return { label: `✏️ Editing ${base(i.file_path)}`.trimEnd(), detail: str(i.file_path) }
    case 'Glob': case 'Grep':
      return { label: '🔎 Searching the code', detail: [i.pattern, i.path].filter(Boolean).join('  in  ') || undefined }
    case 'WebFetch': case 'WebSearch':
      return { label: '🌐 Looking something up', detail: str(i.url ?? i.query ?? i.prompt) }
    case 'Agent': case 'Task':
      return { label: '🤖 Running a subagent', detail: str(i.description ?? i.prompt) }
    case 'TodoWrite': {
      const todos = Array.isArray(i.todos) ? i.todos.map((t: any) => `• ${t?.content ?? t}`).join('\n') : undefined
      return { label: '📝 Planning', detail: todos }
    }
    default: return { label: `⚙️ ${n}`, detail: str(i.command ?? i.file_path ?? i.pattern) }
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Render the step list for the live status message as HTML: bold label, and the
// detail tucked into a collapsed expandable quote so the topic stays scannable
// but the actual attempt is one tap away.
const DETAIL_MAX = 250
function renderSteps(steps: Step[]): string {
  return steps.map(s => {
    const label = `<b>${escapeHtml(s.label)}</b>`
    if (!PROGRESS_DETAIL || !s.detail) return label
    const d = s.detail.trim()
    if (!d) return label
    const clipped = d.length > DETAIL_MAX ? `${d.slice(0, DETAIL_MAX)}…` : d
    return `${label}\n<blockquote expandable>${escapeHtml(clipped)}</blockquote>`
  }).join('\n')
}

// Run a prompt with streaming output, editing a single "status" message in the
// topic to show live tool-step progress, then return the final result.
async function runStreaming(ctx: Context, threadId: number | undefined, key: string, prompt: string, cwd: string, resumeId?: string, mode: string = PERMISSION_MODE, model: string = MODEL): Promise<ClaudeResult> {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...permissionArgs(mode)]
  if (TELEGRAM_PROFILE.trim()) args.push('--append-system-prompt', TELEGRAM_PROFILE)
  if (resumeId) args.push('--resume', resumeId)
  if (model) args.push('--model', model)

  const opts: any = threadId ? { message_thread_id: threadId } : {}
  // Status is machine chatter, not an answer — post and edit it silently so only
  // the real reply buzzes the user's phone.
  const status = await ctx.api.sendMessage(ctx.chat!.id, '💭 thinking…', { ...opts, disable_notification: true }).catch(() => null)
  if (status) { pending.push({ chat: ctx.chat!.id, id: status.message_id }); saveState() }
  const steps: Step[] = []
  let lastEdit = 0, dirty = false
  const editStatus = async (force = false) => {
    if (!status || (!dirty && !force)) return
    const now = Date.now()
    if (!force && now - lastEdit < 4000) return
    lastEdit = now; dirty = false
    if (!steps.length) {
      await ctx.api.editMessageText(ctx.chat!.id, status.message_id, '💭 thinking…').catch(() => {})
      return
    }
    // Trim from the oldest until the HTML body fits: slicing a rendered string
    // mid-tag would break the parse and lose the whole update.
    let shown = steps.slice(-9)
    let body = renderSteps(shown)
    while (body.length > 3500 && shown.length > 1) { shown = shown.slice(1); body = renderSteps(shown) }
    try {
      await ctx.api.editMessageText(ctx.chat!.id, status.message_id, body, { parse_mode: 'HTML' })
    } catch {
      // Same posture as sendRich: formatting is best-effort, the update is not.
      const plain = shown.map(s => s.label).join('\n').slice(0, 3500)
      await ctx.api.editMessageText(ctx.chat!.id, status.message_id, plain).catch(() => {})
    }
  }
  const ticker = setInterval(() => void editStatus(), 4000)

  return await new Promise<ClaudeResult>(resolve => {
    let buf = '', err = '', finalText = '', sessionId: string | undefined, isError = false, got = false
    console.log(`[claude] stream in ${cwd}${resumeId ? ` (resume ${resumeId.slice(0, 8)})` : ' (new)'}`)
    // stdin = 'ignore' (/dev/null) so claude gets immediate EOF instead of waiting
    // for piped input (it otherwise warns "no stdin data received in 3s" and can
    // return without a parseable result).
    const child = spawn(CLAUDE_BIN, args, { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    activeRuns.set(key, child)
    const timer = setTimeout(() => child.kill('SIGKILL'), CLAUDE_TIMEOUT_MS)
    child.stderr.on('data', d => (err += d))
    child.stdout.on('data', d => {
      buf += d
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let o: any; try { o = JSON.parse(line) } catch { continue }
        if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
          for (const b of o.message.content) {
            if (b?.type === 'tool_use') { steps.push(toolStep(b)); dirty = true }
            // The reasoning behind the next step — what the model is trying, not
            // just what it ran. Collapsed like any other detail.
            else if (b?.type === 'thinking' && PROGRESS_DETAIL) {
              const t = String(b.thinking ?? '').trim()
              if (t) { steps.push({ label: '💭 Thinking', detail: t }); dirty = true }
            }
          }
        } else if (o.type === 'result') {
          got = true; sessionId = o.session_id
          isError = Boolean(o.is_error) || o.subtype !== 'success'
          finalText = String(o.result ?? '').trim()
        } else if (o.type === 'system' && o.subtype === 'init' && o.session_id) {
          sessionId ||= o.session_id
        }
      }
      void editStatus()
    })
    const finish = async (res: ClaudeResult) => {
      clearTimeout(timer); clearInterval(ticker)
      activeRuns.delete(key)
      if (status) {
        pending = pending.filter(p => !(p.chat === ctx.chat!.id && p.id === status.message_id)); saveState()
        await ctx.api.deleteMessage(ctx.chat!.id, status.message_id).catch(() => {})
      }
      resolve(res)
    }
    child.on('error', e => void finish({ text: `Failed to launch ${CLAUDE_BIN}: ${e}`, isError: true }))
    child.on('close', code => {
      console.log(`[claude] done (exit ${code}, ${steps.length} steps)`)
      if (got) void finish({ text: finalText || (isError ? '(claude error)' : '(empty response)'), sessionId, isError })
      else void finish({ text: `Could not parse Claude output.\n\n${(err || `exit ${code}`).slice(-1500)}`, isError: true })
    })
  })
}

// ---------------------------------------------------------------------------
// Telegram I/O
// ---------------------------------------------------------------------------

const MAX = 4000
// Split into <=MAX-char messages WITHOUT breaking a code block: if a ``` fence is
// still open at a chunk boundary, close it here and reopen it in the next chunk,
// so telegramify never sees an unbalanced fence (the main cause of broken renders).
function chunk(text: string): string[] {
  const chunks: string[] = []
  let cur: string[] = []
  let len = 0
  let inFence = false
  const push = () => { chunks.push(cur.join('\n') + (inFence ? '\n```' : '')); cur = inFence ? ['```'] : []; len = inFence ? 4 : 0 }
  for (const raw of text.split('\n')) {
    const pieces = raw.length > MAX ? (raw.match(new RegExp(`.{1,${MAX}}`, 'g')) || [raw]) : [raw]
    for (const line of pieces) {
      if (len + line.length + 1 > MAX && cur.length) push()
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
async function send(ctx: Context, threadId: number | undefined, text: string, quiet = false): Promise<void> {
  const opts: any = threadId ? { message_thread_id: threadId } : {}
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
  const isSep = (l: string) => l.includes('|') && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l)
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

// Send Claude's answer with Telegram markdown rendering (code blocks, bold,
// lists, links). Tables are converted to aligned code blocks first; if MarkdownV2
// still fails to parse we resend that chunk as plain text — formatting is
// best-effort, delivery is guaranteed.
async function sendRich(ctx: Context, threadId: number | undefined, text: string): Promise<void> {
  const opts: any = threadId ? { message_thread_id: threadId } : {}
  for (const part of chunk(mdTablesToCode(text))) {
    try {
      await ctx.api.sendMessage(ctx.chat!.id, telegramify(part, 'escape'), { ...opts, parse_mode: 'MarkdownV2' })
    } catch {
      await ctx.api.sendMessage(ctx.chat!.id, stripMd(part), opts).catch(e => console.error(`[warn] sendMessage: ${e}`))
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
  return `Permission mode for this topic: ${MODE_EMOJI[cur] ?? ''} ${cur}\n${MODE_HELP[cur] ?? ''}\n\n` +
    MODES.map(m => `${MODE_EMOJI[m]} ${m} — ${MODE_HELP[m]}`).join('\n') +
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
// What "default" resolves to. When TG_MODEL is set it's that; otherwise the bridge
// passes no --model flag and the CLI uses whatever Claude itself defaults to — the
// model in ~/.claude/settings.json, or the account/plan default.
function defaultExplainer(): string {
  return MODEL
    ? `"${MODEL_DEFAULT}" uses TG_MODEL (${MODEL}).`
    : `"${MODEL_DEFAULT}" runs no --model flag, so Claude uses your system default: the model set in ~/.claude/settings.json, or your account default.`
}
function modelText(key: string): string {
  return `Model for this topic: ${modelLabel(key)}\n\n` +
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
async function sendFile(ctx: Context, threadId: number | undefined, path: string, caption?: string): Promise<boolean> {
  if (!existsSync(path) || !statSync(path).isFile()) { await send(ctx, threadId, `Not a file: ${path}`); return false }
  const size = statSync(path).size
  if (size > TG_UPLOAD_LIMIT) {
    await send(ctx, threadId, `${basename(path)} is ${fmtBytes(size)} — over the ${fmtBytes(TG_UPLOAD_LIMIT)} bot upload limit.` +
      (LOCAL_API ? '' : `\nA local Bot API server raises this to 2000 MB (set TG_API_ROOT — see README).`))
    return false
  }
  const opts: any = threadId ? { message_thread_id: threadId } : {}
  if (caption) opts.caption = caption.slice(0, 1024)
  try {
    await ctx.api.sendDocument(ctx.chat!.id, new InputFile(path, basename(path)), opts)
    console.log(`[file->] ${path} (${fmtBytes(size)})`)
    return true
  } catch (e) { await send(ctx, threadId, `⚠️ could not send ${basename(path)}: ${e}`); return false }
}

// After a run, deliver anything Claude left in the topic's outbox, then archive
// each sent file to outbox/.sent so it isn't delivered twice.
async function flushOutbox(ctx: Context, threadId: number | undefined, cwd: string): Promise<void> {
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
async function deliver(ctx: Context, threadId: number | undefined, text: string): Promise<void> {
  if (REPLY_FILE_CHARS && text.length > REPLY_FILE_CHARS) {
    const dir = mkdtempSync(join(tmpdir(), 'tg-'))
    const p = join(dir, 'answer.md')
    try {
      writeFileSync(p, text)
      await sendFile(ctx, threadId, p, `${text.slice(0, 900).trimEnd()} …\n\n📄 Full answer (${text.length} chars) attached.`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  } else {
    await sendRich(ctx, threadId, text)
  }
}

async function handlePrompt(ctx: Context, threadId: number | undefined, key: string, prompt: string, mode?: string): Promise<void> {
  const cwd = resolveCwd(ctx, threadId)
  const resumeId = sessions[key]?.sessionId
  try {
    const res = await runStreaming(ctx, threadId, key, prompt, cwd, resumeId, mode ?? modeFor(key), modelFor(key))
    if (stopped.has(key)) { stopped.delete(key); return } // killed via /stop — status already cleared, no reply
    if (res.sessionId) { sessions[key] = { ...sessions[key], cwd, sessionId: res.sessionId, updated: new Date().toISOString() }; saveState() }
    await deliver(ctx, threadId, res.text)
    await flushOutbox(ctx, threadId, cwd)
  } catch (e) {
    await send(ctx, threadId, `⚠️ ${e}`)
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
function encodeCwd(dir: string): string { return dir.replace(/[^a-zA-Z0-9]/g, '-') }
function projectDir(dir: string): string { return join(CLAUDE_PROJECTS, encodeCwd(dir)) }

// Parse the args of /sessions or /import into directories. Space-separated, or
// comma/newline-separated when a path itself contains spaces.
function parseDirs(text: string): string[] {
  const i = text.indexOf(' ')
  if (i === -1) return []
  const rest = text.slice(i + 1).trim()
  if (!rest) return []
  const parts = (rest.includes('\n') || rest.includes(',')) ? rest.split(/[\n,]+/) : rest.split(/\s+/)
  return parts.map(p => p.trim()).filter(Boolean)
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
const bot = new Bot(TOKEN, API_ROOT ? { client: { apiRoot: API_ROOT } } : undefined)
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
        await handlePrompt(ctx, threadId, aKey, `[The user attached a file, saved at ${saved} (./${relative(cwd, saved)}).]\n\n${caption}`)
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
      `/interrupt [on|off] — new messages cancel the running task instead of queueing\n` +
      `/mode [${MODES.join('|')}] — permission mode for this topic (tap to switch)\n` +
      `/model [${MODEL_ALIASES.join('|')}] — model for this topic (tap to switch)\n` +
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
      if (!m) { await send(ctx, threadId, `Unknown mode "${arg}". One of: ${MODES.join(', ')}`); return }
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
    enqueue(key, () => handlePrompt(ctx, threadId, key, arg, 'plan'))
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
      `mode: ${modeFor(key)}\n` +
      `model: ${modelLabel(key)}\n\n` +
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
    const dirs = parseDirs(text)
    if (!dirs.length) { await send(ctx, threadId, 'Usage: /sessions <dir> [dir2 …]  (space-, comma- or newline-separated)'); return }
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
  enqueue(key, () => handlePrompt(ctx, threadId, key, text))
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
  await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(() => {})

  // Delete any "💭 thinking…" status messages orphaned by a restart that killed
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
  let handle: RunnerHandle | undefined
  const stop = async () => { console.log('\n[bye]'); try { await handle?.stop() } catch {} ; process.exit(0) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  for (let attempt = 1; ; attempt++) {
    handle = run(bot)
    console.log(`[ok] polling Telegram${attempt > 1 ? ` (resumed #${attempt})` : ''}`)
    try {
      await handle.task()
      return // stopped cleanly
    } catch (e: any) {
      if (!(e?.error_code === 409 || String(e).includes('409'))) throw e
      try { await handle.stop() } catch {}
      console.error('[warn] 409 conflict — likely a prior instance’s lingering poll. Waiting 40s to clear, then resuming…')
      await new Promise(r => setTimeout(r, 40000))
    }
  }
}
main().catch(e => { console.error(`[fatal] ${e}`); process.exit(1) })
