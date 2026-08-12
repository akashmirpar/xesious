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
// These two must be pinned, not merely left unset: bun auto-loads the repo's .env,
// so a developer machine with TG_ALLOW_BYPASS=1 in it would otherwise silently turn
// the bypass safety-gate test green for the wrong reason.
process.env.TG_PROGRESS_DETAIL = '0'      // labels only in status edits
process.env.TG_ALLOW_BYPASS = '0'         // bypass must be refused

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
// The status message is edited as a Bot API 10.1 rich message, whose body travels in
// rich_message.markdown rather than text; plain edits (and the fallbacks) still use
// text. Read either, so an assertion about what the user saw doesn't depend on which
// path the bridge took.
const textOf = (c: Call): string => String(c.payload?.rich_message?.markdown ?? c.payload?.text ?? '')
const finalReply = (cs: Call[]): string | undefined => {
  const s = sends(cs)
  return s.length ? s[s.length - 1].payload.text : undefined
}

describe('a normal turn', () => {
  test('posts a status message, edits in tool steps, deletes it, and delivers the reply', async () => {
    const cs = await incoming(1001, 'hello there')
    // status "💭 Thinking…" sent…
    expect(sends(cs).some(c => textOf(c).includes('Thinking'))).toBe(true)
    // …edited to show the tool step ("⚙️ Running a command" from the stub's Bash use)…
    expect(cs.some(c => c.method === 'editMessageText' && textOf(c).includes('Running a command'))).toBe(true)
    // …deleted when the run finished…
    expect(cs.some(c => c.method === 'deleteMessage')).toBe(true)
    // …and the final answer delivered.
    expect(finalReply(cs)).toContain('okReply')
  })
})

describe('tool steps render into the status message', () => {
  test('a tool step renders into the status message', async () => {
    const cs = await incoming(1002, 'TOOLS please')
    const edits = cs.filter(c => c.method === 'editMessageText').map(textOf).join('\n')
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

// ---------------------------------------------------------------------------
// Feature / regression coverage. Each block pins a user-facing feature's real
// behaviour, so a future change that breaks it fails here instead of in prod.
// Add a block whenever a feature ships. Chat ids 1020+ keep topics isolated.
// ---------------------------------------------------------------------------

const stateNow = () => JSON.parse(readFileSync(STATE_FILE, 'utf8'))

describe('session lifecycle: /new and /resume', () => {
  test('/new starts a fresh session so the next turn does NOT --resume', async () => {
    const bind = await incoming(1020, 'bind a session')
    expect(finalReply(bind)).toContain('noResume')            // first turn is new
    expect(stateNow().sessions['1020:main'].sessionId).toBe('sessTESTAAA')

    const nw = await incoming(1020, '/new')
    expect(finalReply(nw)).toMatch(/Fresh session/i)
    expect(stateNow().sessions['1020:main'].sessionId).toBeUndefined()  // cleared

    const after = await incoming(1020, 'after new')
    expect(finalReply(after)).toContain('noResume')           // proves it reset
  })

  test('/resume restores the session /new set aside (next turn --resumes)', async () => {
    await incoming(1021, 'bind')
    await incoming(1021, '/new')
    const r = await incoming(1021, '/resume')
    expect(finalReply(r)).toMatch(/Restored session/i)
    const cont = await incoming(1021, 'continue')
    expect(finalReply(cont)).toContain('hadResume')           // resuming again
  })
})

describe('/status reports the topic state', () => {
  test('shows directory, mode, and model', async () => {
    const r = finalReply(await incoming(1022, '/status')) || ''
    expect(r).toContain('directory:')
    expect(r).toContain('dm-1')          // the private-chat cwd (dm-<userId>)
    expect(r).toContain('mode: auto')    // default permission mode
  })
})

describe('/mode: switch permission posture + bypass safety gate', () => {
  test('/mode plan switches and persists, and /status reflects it', async () => {
    expect(finalReply(await incoming(1023, '/mode plan'))).toMatch(/plan/i)
    expect(stateNow().modes['1023:main']).toBe('plan')
    expect(finalReply(await incoming(1023, '/status'))).toContain('mode: plan')
  })

  test('bypass is REFUSED when TG_ALLOW_BYPASS is off (root-safety guard)', async () => {
    const cs = await incoming(1024, '/mode bypass')
    expect(finalReply(cs)).toMatch(/Unknown mode/i)           // not accepted
    expect(stateNow().modes?.['1024:main']).toBeUndefined()   // and not persisted
  })
})

describe('unknown command', () => {
  test('is rejected with a hint, not run as a prompt', async () => {
    const cs = await incoming(1025, '/frobnicate')
    expect(finalReply(cs)).toContain('Unknown command')
    expect(cs.some(c => c.method === 'deleteMessage')).toBe(false)  // no run happened
  })
})

describe('file delivery: a file staged in ./outbox/ is sent back', () => {
  test('the staged file goes out as a document, plus the text reply', async () => {
    const cs = await incoming(1030, 'OUTBOX')
    expect(finalReply(cs)).toContain('wroteOutbox')                 // the answer text
    expect(cs.some(c => c.method === 'sendDocument')).toBe(true)    // the file itself
  })
})
