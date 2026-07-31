/**
 * Tier 2 — end-to-end tests of the real bridge, with both external dependencies
 * faked in-process:
 *   • the `claude` CLI  → test/claude-stub.ts (canned stream-json), via CLAUDE_BIN
 *   • Telegram          → a grammY API transformer that records every outgoing call
 *                         and returns canned results (no network, no token)
 *
 * A synthetic update is pushed through the *real* bot.handleUpdate(), so the actual
 * handler → handlePrompt → runStreaming → stream parser → Telegram-call pipeline runs.
 * We then assert on exactly what the user would have seen. Run with `bun test`.
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --- Env must be set BEFORE bridge.ts is imported (it reads config at module load).
const TMP = mkdtempSync(join(tmpdir(), 'xesious-e2e-'))
const STATE_FILE = join(TMP, 'state.json')
process.env.TELEGRAM_BOT_TOKEN = '123:test-token'
process.env.TG_ALLOWED_USERS = '1'
process.env.CLAUDE_BIN = join(import.meta.dir, 'claude-stub.ts')
process.env.TG_SESSIONS_BASE = join(TMP, 'sessions')
process.env.TG_STATE_FILE = STATE_FILE
process.env.TG_CLAUDE_TIMEOUT_MS = '1500' // keep the HANG scenario fast
// leave TG_PROGRESS_DETAIL unset → off by default (labels only in status edits)

// Dynamic import so the assignments above land first.
const bridge: any = await import('../bridge')

// --- Fake Telegram: record calls, return canned API responses (no network).
type Call = { method: string; payload: any }
const calls: Call[] = []
let nextMessageId = 1000

bridge.bot.api.config.use(async (_prev: any, method: string, payload: any) => {
  calls.push({ method, payload })
  if (method === 'getMe') {
    return {
      ok: true,
      result: {
        id: 42, is_bot: true, first_name: 'TestBot', username: 'testbot',
        can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
      },
    }
  }
  if (method === 'sendMessage' || method === 'editMessageText') {
    // editMessageText's real result can be a Message or true; bridge ignores it.
    return { ok: true, result: { message_id: nextMessageId++, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text } }
  }
  // deleteMessage, deleteWebhook, setMyCommands, everything else.
  return { ok: true, result: true }
})

beforeAll(async () => {
  await bridge.bot.init() // sets botInfo via the faked getMe
})
afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
})

// Push one private-chat text message through the real handler and wait for the
// fire-and-forget handlePrompt chain to drain. Returns the calls it produced.
let updateId = 1
async function incoming(chatId: number, text: string, fromId = 1): Promise<Call[]> {
  const before = calls.length
  await bridge.bot.handleUpdate({
    update_id: updateId++,
    message: {
      message_id: updateId + 5000,
      date: 0,
      chat: { id: chatId, type: 'private', first_name: 'T' },
      from: { id: fromId, is_bot: false, first_name: 'T' },
      text,
    },
  })
  await bridge._drainQueue(`${chatId}:main`)
  return calls.slice(before)
}

const sends = (cs: Call[]) => cs.filter(c => c.method === 'sendMessage')
const finalReply = (cs: Call[]): string | undefined => {
  const s = sends(cs)
  return s.length ? s[s.length - 1].payload.text : undefined
}

describe('a normal turn', () => {
  test('posts a status message, edits in tool steps, deletes it, and delivers the reply', async () => {
    const cs = await incoming(1001, 'hello there')
    // status "💭 thinking…" sent…
    expect(sends(cs).some(c => String(c.payload.text).includes('thinking'))).toBe(true)
    // …edited to show the tool step ("⚙️ Running a command" from the stub's Bash use)…
    expect(cs.some(c => c.method === 'editMessageText' && String(c.payload.text).includes('Running a command'))).toBe(true)
    // …deleted when the run finished…
    expect(cs.some(c => c.method === 'deleteMessage')).toBe(true)
    // …and the final answer delivered.
    expect(finalReply(cs)).toContain('okReply')
  })
})

describe('tool steps render into the status message', () => {
  test('a tool step renders into the status message', async () => {
    const cs = await incoming(1002, 'TOOLS please')
    const edits = cs.filter(c => c.method === 'editMessageText').map(c => String(c.payload.text)).join('\n')
    // The status is edited at most once per 4s (editStatus throttle), so within one
    // fast turn we're only guaranteed the first step renders — not every one. Whether
    // Read or Bash lands first depends on stdout chunking; either proves the
    // stream→step→status pipeline works. Multi-step rendering is covered
    // deterministically by renderSteps() in lib.test.ts.
    expect(edits).toMatch(/Reading|Running a command/)
    expect(finalReply(cs)).toContain('ranTools')
  })
})

describe('degenerate CLI outputs', () => {
  test('empty result → "(empty response)"', async () => {
    const cs = await incoming(1003, 'EMPTY')
    expect(finalReply(cs)).toContain('empty response')
  })
  test('is_error result is still delivered (the error text)', async () => {
    const cs = await incoming(1004, 'ERROR')
    expect(finalReply(cs)).toContain('boom')
  })
  test('a hung child is SIGKILLed at the timeout and reported, not left silent', async () => {
    const t0 = performance.now()
    const cs = await incoming(1005, 'HANG')
    const elapsed = performance.now() - t0
    // Must actually reach the ~1500ms timeout — proves the SIGKILL watchdog fired
    // rather than the child exiting early (which would pass the text check for the
    // wrong reason).
    expect(elapsed).toBeGreaterThan(1000)
    expect(cs.some(c => c.method === 'deleteMessage')).toBe(true) // status cleaned up
    expect(finalReply(cs)).toContain('Could not parse')          // the timeout path's message
  }, 8000)
})

describe('session persistence round-trip', () => {
  test('turn 1 runs --new, turn 2 resumes the id turn 1 minted, and it is on disk', async () => {
    const first = await incoming(1006, 'first message')
    expect(finalReply(first)).toContain('noResume')

    // The session id the stub returned must be persisted to the state file.
    expect(existsSync(STATE_FILE)).toBe(true)
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    expect(state.sessions['1006:main']?.sessionId).toBe('sessTESTAAA')

    const second = await incoming(1006, 'second message')
    expect(finalReply(second)).toContain('hadResume')
  })
})

describe('per-topic /model plumbs --model through to the CLI', () => {
  test('after /model opus, the next turn passes --model', async () => {
    const set = await incoming(1007, '/model opus')
    expect(sends(set).length).toBeGreaterThan(0) // confirmation reply
    const cs = await incoming(1007, 'do something')
    expect(finalReply(cs)).toContain('modelSet')
  })
})

describe('authorization gate', () => {
  test('a message from a non-allowlisted user produces no reply', async () => {
    const cs = await incoming(1008, 'let me in', /* fromId */ 2)
    expect(sends(cs).length).toBe(0)
    expect(cs.some(c => c.method === 'editMessageText')).toBe(false)
  })
})
