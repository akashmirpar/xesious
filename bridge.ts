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
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, renameSync, mkdtempSync, rmSync } from 'node:fs'
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
const PERMISSION_MODE = (process.env.TG_PERMISSION_MODE || 'acceptEdits').trim()
const ALLOWED_TOOLS =
  process.env.TG_ALLOWED_TOOLS ||
  'Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch,Agent,TodoWrite,NotebookEdit'
const MODEL = process.env.TG_MODEL?.trim() || ''
const REQUIRE_MENTION = /^(1|true|yes)$/i.test(process.env.TG_REQUIRE_MENTION || '')
const CLAUDE_TIMEOUT_MS = Number(process.env.TG_CLAUDE_TIMEOUT_MS || 30 * 60 * 1000)
const ALLOWED_USERS = parseIdList(process.env.TG_ALLOWED_USERS)
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
const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024 // Bot API getFile cap (download to us)
const TG_UPLOAD_LIMIT = 50 * 1024 * 1024   // Bot API sendDocument cap (upload to chat)

// Importing existing Claude Code sessions (the ones the IDE/CLI session picker
// shows) as topics. A directory's sessions live at CLAUDE_PROJECTS/<encoded>/<id>.jsonl.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const CLAUDE_PROJECTS = join(CLAUDE_DIR, 'projects')
const IMPORT_BACKFILL = Math.max(0, Number(process.env.TG_IMPORT_BACKFILL || 12))  // turns backfilled per session
const IMPORT_MAX_SESSIONS = Math.max(1, Number(process.env.TG_IMPORT_MAX || 10))   // cap topics created per /import
const REPLY_FILE_CHARS = Math.max(0, Number(process.env.TG_REPLY_FILE_CHARS || 6000)) // replies longer than this go as a .md file

// ---------------------------------------------------------------------------
// Persistent state:  sessions[(chat:topic)] = { sessionId, cwd }
//                    names[(chat:topic)]    = "human topic name"
// ---------------------------------------------------------------------------

type Entry = { sessionId?: string; cwd: string; updated?: string }
let sessions: Record<string, Entry> = {}
let names: Record<string, string> = {}
// "💭 thinking…" status messages for in-flight runs. If the process is killed
// before a run finishes (e.g. a restart), the next startup deletes these so no
// orphaned status message is left dangling in a topic.
let pending: { chat: number; id: number }[] = []

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
    }
  } catch (e) { console.error(`[warn] could not read state (${e}); starting empty`) }
}
function saveState(): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({ sessions, names, pending }, null, 2))
  } catch (e) { console.error(`[warn] could not write state: ${e}`) }
}

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

function permissionArgs(): string[] {
  const m = PERMISSION_MODE.toLowerCase()
  if (m === 'bypass' || m === 'bypasspermissions') return ['--dangerously-skip-permissions']
  return ['--permission-mode', PERMISSION_MODE, '--allowedTools', ALLOWED_TOOLS]
}

// Env for the claude subprocess: strip TELEGRAM_*/TG_* so the Claude Code
// process (and any installed telegram channel plugin) can't grab our bot token
// and start a competing getUpdates poll on it (causes 409 and kills the bridge).
function childEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(e)) if (k.startsWith('TELEGRAM_') || k.startsWith('TG_')) delete e[k]
  return e
}

// A short, clean status label for a streamed tool_use event. Deliberately does
// NOT echo raw commands or full paths (that's internal noise to the user) —
// just the kind of activity, with a file basename where useful.
function toolStep(b: any): string {
  const n = b?.name || 'tool'
  const i = b?.input || {}
  const base = (p: any) => (p ? basename(String(p)) : '')
  switch (n) {
    case 'Bash': return '⚙️ Running a command'
    case 'Read': return `📖 Reading ${base(i.file_path)}`.trimEnd()
    case 'Edit': case 'Write': case 'NotebookEdit': return `✏️ Editing ${base(i.file_path)}`.trimEnd()
    case 'Glob': case 'Grep': return '🔎 Searching the code'
    case 'WebFetch': case 'WebSearch': return '🌐 Looking something up'
    case 'Agent': case 'Task': return '🤖 Running a subagent'
    case 'TodoWrite': return '📝 Planning'
    default: return `⚙️ ${n}`
  }
}

// Run a prompt with streaming output, editing a single "status" message in the
// topic to show live tool-step progress, then return the final result.
async function runStreaming(ctx: Context, threadId: number | undefined, key: string, prompt: string, cwd: string, resumeId?: string): Promise<ClaudeResult> {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...permissionArgs()]
  if (TELEGRAM_PROFILE.trim()) args.push('--append-system-prompt', TELEGRAM_PROFILE)
  if (resumeId) args.push('--resume', resumeId)
  if (MODEL) args.push('--model', MODEL)

  const opts: any = threadId ? { message_thread_id: threadId } : {}
  const status = await ctx.api.sendMessage(ctx.chat!.id, '💭 thinking…', opts).catch(() => null)
  if (status) { pending.push({ chat: ctx.chat!.id, id: status.message_id }); saveState() }
  const steps: string[] = []
  let lastEdit = 0, dirty = false
  const editStatus = async (force = false) => {
    if (!status || (!dirty && !force)) return
    const now = Date.now()
    if (!force && now - lastEdit < 4000) return
    lastEdit = now; dirty = false
    const body = (steps.length ? steps.slice(-9).join('\n') : '💭 thinking…').slice(0, 3500)
    await ctx.api.editMessageText(ctx.chat!.id, status.message_id, body).catch(() => {})
  }
  const ticker = setInterval(() => void editStatus(), 4000)

  return await new Promise<ClaudeResult>(resolve => {
    let buf = '', err = '', finalText = '', sessionId: string | undefined, isError = false, got = false
    console.log(`[claude] stream in ${cwd}${resumeId ? ` (resume ${resumeId.slice(0, 8)})` : ' (new)'}`)
    const child = spawn(CLAUDE_BIN, args, { cwd, env: childEnv() })
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
          for (const b of o.message.content) if (b?.type === 'tool_use') { steps.push(toolStep(b)); dirty = true }
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
function chunk(text: string): string[] {
  const parts: string[] = []
  let rest = text
  while (rest.length > MAX) {
    let cut = rest.lastIndexOf('\n', MAX)
    if (cut < MAX * 0.5) cut = MAX
    parts.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest.length) parts.push(rest)
  return parts
}
async function send(ctx: Context, threadId: number | undefined, text: string): Promise<void> {
  const opts = threadId ? { message_thread_id: threadId } : {}
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
      await ctx.api.sendMessage(ctx.chat!.id, part, opts).catch(e => console.error(`[warn] sendMessage: ${e}`))
    }
  }
}
function startTyping(ctx: Context, threadId: number | undefined): () => void {
  const opts = threadId ? { message_thread_id: threadId } : {}
  const ping = () => ctx.api.sendChatAction(ctx.chat!.id, 'typing', opts).catch(() => {})
  ping(); const id = setInterval(ping, 4500); return () => clearInterval(id)
}

// Gate on the SENDER's id, never the room.
function isAllowed(ctx: Context): boolean {
  const userId = String(ctx.from?.id ?? '')
  if (!ALLOWED_USERS.has(userId)) return false
  const chat = ctx.chat
  if (!chat) return false
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
    throw new Error(`file is ${fmtBytes(att.size)}; Telegram lets bots fetch at most ${fmtBytes(TG_DOWNLOAD_LIMIT)}`)
  const file = await ctx.api.getFile(att.fileId)
  if (!file.file_path) throw new Error('Telegram returned no file_path')
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`)
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`)
  const buf = Buffer.from(await res.arrayBuffer())
  const dest = uniquePath(ensureDir(join(cwd, INBOX_DIR)), safeName(att.name, extname(file.file_path)))
  writeFileSync(dest, buf)
  console.log(`[file<-] ${dest} (${fmtBytes(buf.length)})`)
  return dest
}

// Send one file from disk to the chat/topic. Returns true on success.
async function sendFile(ctx: Context, threadId: number | undefined, path: string, caption?: string): Promise<boolean> {
  if (!existsSync(path) || !statSync(path).isFile()) { await send(ctx, threadId, `Not a file: ${path}`); return false }
  const size = statSync(path).size
  if (size > TG_UPLOAD_LIMIT) { await send(ctx, threadId, `${basename(path)} is ${fmtBytes(size)} — over Telegram's ${fmtBytes(TG_UPLOAD_LIMIT)} bot upload limit.`); return false }
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

async function handlePrompt(ctx: Context, threadId: number | undefined, key: string, prompt: string): Promise<void> {
  const cwd = resolveCwd(ctx, threadId)
  const resumeId = sessions[key]?.sessionId
  try {
    const res = await runStreaming(ctx, threadId, key, prompt, cwd, resumeId)
    if (stopped.has(key)) { stopped.delete(key); return } // killed via /stop — status already cleared, no reply
    if (res.sessionId) { sessions[key] = { cwd, sessionId: res.sessionId, updated: new Date().toISOString() }; saveState() }
    await deliver(ctx, threadId, res.text)
    await flushOutbox(ctx, threadId, cwd)
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
const bot = new Bot(TOKEN)
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
        await send(ctx, threadId, `📎 Saved → ${saved}\n(in ./${relative(cwd, saved)} — reference it in your next message)`)
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
      `/whoami — show ids (for the allowlist)\n/new — fresh session here\n` +
      `/compact [focus] — summarize this topic's history to free up context\n` +
      `/stop — cancel the task currently running in this topic\n` +
      `/get <path> — send a file from this topic's directory back to you\n` +
      `/cwd <abs-path> — set this topic's working directory\n/status — session id + directory\n\n` +
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
    else await send(ctx, threadId, 'Nothing is running in this topic right now.')
    return
  }
  if (cmd === '/new' || cmd === '/reset') {
    if (sessions[key]) { delete sessions[key].sessionId; saveState() }
    await send(ctx, threadId, '🧹 Fresh session for this topic. History cleared (same directory).')
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
      `session: ${e?.sessionId ?? '(none yet)'}\n\n` +
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
    await send(ctx, threadId, `Run /import <dir> [dir2 …] to make a topic per session.`)
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
    await send(ctx, threadId, `Importing ${capped.length} session(s) from ${dirs.length} dir(s)${candidates.length > capped.length ? ` (newest ${capped.length} of ${candidates.length})` : ''}…`)
    let ok = 0
    for (const { dir, s } of capped) {
      try {
        const name = `${basename(dir)} · ${s.title}`.slice(0, 120)
        const topic = await ctx.api.createForumTopic(chatId, name)
        const tid = topic.message_thread_id
        const tkey = keyFor(chatId, tid)
        sessions[tkey] = { cwd: dir, sessionId: s.id, updated: new Date().toISOString() }
        names[tkey] = name
        saveState()
        await send(ctx, tid, `📂 Bound to session ${s.id.slice(0, 8)} · ${dir}\n${s.turns} turns total — last ${Math.min(IMPORT_BACKFILL, s.turns)} below. Message here to continue it.`)
        for (const t of renderTurns(s.file, IMPORT_BACKFILL)) { await send(ctx, tid, t); await sleep(350) }
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
    await send(ctx, threadId, `— last ${turns.length} turns of ${e.sessionId.slice(0, 8)} —`)
    for (const t of turns) { await send(ctx, threadId, t); await sleep(300) }
    return
  }
  if (cmd) { await send(ctx, threadId, `Unknown command. Try /help`); return }

  enqueue(key, () => handlePrompt(ctx, threadId, key, text))
    .catch(e => console.error(`[error] task ${key}: ${e}`))
})

// ---------------------------------------------------------------------------
// Startup — single clean start. A 409 means another instance owns the token;
// we exit with a clear message rather than fight it (only one poller per token).
// ---------------------------------------------------------------------------

async function main() {
  const me = await bot.api.getMe()
  botUsername = me.username
  console.log(`[ok] @${me.username} up`)
  console.log(`     claude bin     : ${CLAUDE_BIN}`)
  console.log(`     sessions base  : ${SESSIONS_BASE}`)
  console.log(`     default cwd    : ${DEFAULT_WORKDIR}`)
  console.log(`     permission     : ${PERMISSION_MODE}`)
  console.log(`     allowed users  : ${[...ALLOWED_USERS].join(', ') || '(none — set TG_ALLOWED_USERS!)'}`)
  console.log(`     allowed chats  : ${[...ALLOWED_CHATS].join(', ') || '(none)'}`)
  if (ALLOWED_USERS.size === 0) console.log(`[warn] allowlist empty: DM the bot /whoami, add your id, restart.`)

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
