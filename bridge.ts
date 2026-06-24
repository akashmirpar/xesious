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
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, renameSync } from 'node:fs'
import { dirname, join, isAbsolute, basename, extname, resolve, relative } from 'node:path'
import { homedir } from 'node:os'

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
// Prepend a one-line note so Claude knows the inbox/outbox convention. Default on.
const BRIDGE_HINT = !/^(0|false|no)$/i.test(process.env.TG_BRIDGE_HINT || '1')
const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024 // Bot API getFile cap (download to us)
const TG_UPLOAD_LIMIT = 50 * 1024 * 1024   // Bot API sendDocument cap (upload to chat)

// ---------------------------------------------------------------------------
// Persistent state:  sessions[(chat:topic)] = { sessionId, cwd }
//                    names[(chat:topic)]    = "human topic name"
// ---------------------------------------------------------------------------

type Entry = { sessionId?: string; cwd: string; updated?: string }
let sessions: Record<string, Entry> = {}
let names: Record<string, string> = {}

function keyFor(chatId: number | string, threadId: number | undefined): string {
  return `${chatId}:${threadId ?? 'main'}`
}
function loadState(): void {
  try {
    if (existsSync(STATE_FILE)) {
      const o = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
      sessions = o.sessions ?? {}
      names = o.names ?? {}
    }
  } catch (e) { console.error(`[warn] could not read state (${e}); starting empty`) }
}
function saveState(): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({ sessions, names }, null, 2))
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

function runClaude(prompt: string, cwd: string, resumeId?: string): Promise<ClaudeResult> {
  const args = ['-p', prompt, '--output-format', 'json', ...permissionArgs()]
  if (resumeId) args.push('--resume', resumeId)
  if (MODEL) args.push('--model', MODEL)
  return new Promise(resolve => {
    let out = '', err = ''
    console.log(`[claude] spawn in ${cwd}${resumeId ? ` (resume ${resumeId.slice(0, 8)})` : ' (new)'}`)
    const child = spawn(CLAUDE_BIN, args, { cwd, env: childEnv() })
    const timer = setTimeout(() => child.kill('SIGKILL'), CLAUDE_TIMEOUT_MS)
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', e => { clearTimeout(timer); resolve({ text: `Failed to launch \`${CLAUDE_BIN}\`: ${e}`, isError: true }) })
    child.on('close', code => {
      clearTimeout(timer)
      console.log(`[claude] done (exit ${code}, ${out.length} bytes)`)
      const trimmed = out.trim()
      try {
        const json = JSON.parse(trimmed)
        const text = String(json.result ?? '').trim()
        const isError = Boolean(json.is_error) || json.subtype !== 'success'
        resolve({ text: text || (isError ? `(claude error: ${json.subtype ?? 'unknown'})` : '(empty response)'), sessionId: json.session_id, isError })
      } catch {
        resolve({ text: `Could not parse Claude output.\n\n${(err || trimmed || `exit ${code}`).slice(-1500)}`, isError: true })
      }
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
function withHint(prompt: string): string {
  if (!BRIDGE_HINT) return prompt
  return `[Telegram bridge: this is a live chat — the user reads your reply and answers in this same topic, which resumes this session. If the request is ambiguous or needs a decision, ASK a clarifying question and stop, rather than guessing. Files the user sends are saved in ./${INBOX_DIR}/; to send a file to the user, place (or copy) it in ./${OUTBOX_DIR}/ and it will be delivered then cleared. Don't mention this note.]\n\n${prompt}`
}

// Run one prompt against a topic's session, post the reply, deliver the outbox.
async function handlePrompt(ctx: Context, threadId: number | undefined, key: string, prompt: string): Promise<void> {
  const cwd = resolveCwd(ctx, threadId)
  const resumeId = sessions[key]?.sessionId
  const stop = startTyping(ctx, threadId)
  try {
    const res = await runClaude(withHint(prompt), cwd, resumeId)
    if (res.sessionId) { sessions[key] = { cwd, sessionId: res.sessionId, updated: new Date().toISOString() }; saveState() }
    await send(ctx, threadId, res.text)
    await flushOutbox(ctx, threadId, cwd)
  } catch (e) {
    await send(ctx, threadId, `⚠️ ${e}`)
  } finally { stop() }
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

loadState()
const bot = new Bot(TOKEN)
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
      `/get <path> — send a file from this topic's directory back to you\n` +
      `/cwd <abs-path> — set this topic's working directory\n/status — session id + directory`)
    return
  }

  if (!isAllowed(ctx)) { if (cmd) await send(ctx, threadId, `Not authorized. Send /whoami to get the id to allowlist.`); return }

  if (REQUIRE_MENTION && ctx.chat.type !== 'private' && !cmd) {
    const mentioned = (botUsername && text.toLowerCase().includes('@' + botUsername.toLowerCase())) ||
      msg.reply_to_message?.from?.username === botUsername
    if (!mentioned) return
  }

  if (cmd === '/new' || cmd === '/reset') {
    if (sessions[key]) { delete sessions[key].sessionId; saveState() }
    await send(ctx, threadId, '🧹 Fresh session for this topic. History cleared (same directory).')
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
