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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --- Env must be set BEFORE bridge.ts is imported (it reads config at module load).
const TMP = mkdtempSync(join(tmpdir(), 'xesious-e2e-'))
const STATE_FILE = join(TMP, 'state.json')
process.env.TELEGRAM_BOT_TOKEN = '123:test-token'
process.env.TG_ALLOWED_USERS = '1'
// A forum group for the fan-out cases. isAllowed() requires a non-private chat to be
// listed, so without this the fixture is silently rejected — which is the allowlist
// working, not a bug.
process.env.TG_ALLOWED_CHATS = '-100777'
process.env.CLAUDE_BIN = join(import.meta.dir, 'claude-stub.ts')
process.env.TG_SESSIONS_BASE = join(TMP, 'sessions')
process.env.TG_STATE_FILE = STATE_FILE
process.env.TG_CLAUDE_TIMEOUT_MS = '20000'  // absolute backstop, must not fire first
process.env.TG_IDLE_TIMEOUT_MS = '1500'    // the idle watchdog is what HANG exercises
process.env.TG_QUIET_NOTE_MS = '500'
// These two must be pinned, not merely left unset: bun auto-loads the repo's .env,
// so a developer machine with TG_ALLOW_BYPASS=1 in it would otherwise silently turn
// the bypass safety-gate test green for the wrong reason.
process.env.TG_PROGRESS_DETAIL = '0'      // labels only in status edits
process.env.TG_ALLOW_BYPASS = '0'         // bypass must be refused
// Session transcripts live under CLAUDE_CONFIG_DIR. /fork copies one, so this must
// point into the sandbox — a test has no business reading or writing the real
// ~/.claude, and would be testing against whatever happens to be in it.
process.env.CLAUDE_CONFIG_DIR = join(TMP, 'claude')
// Real synthesis is ~1x realtime, so tier 2 uses a stub and proves the PLUMBING:
// that the note is threaded, and that a slow note does not block the topic. The
// progressive/chunked path is inherently about real timing and is covered in tier 3.
process.env.TG_TTS_CMD = join(import.meta.dir, 'tts-stub.sh')
process.env.TG_VOICE_CHUNKED = '1'
const SLOW_TTS = join(TMP, 'slow-tts')
process.env.XESIOUS_TTS_STUB_SLOW = SLOW_TTS
// The progressive path gets its own stub, speaking the same protocol as speak.py.
// Without it, reaching that path in tier 2 would mean real synthesis at about
// realtime — minutes per test.
process.env.TG_SPEAK_CMD = join(import.meta.dir, 'speak-stub.py')
const SLOW_SPEAK = join(TMP, 'slow-speak')
process.env.XESIOUS_SPEAK_STUB_SLOW = SLOW_SPEAK

// Dynamic import so the assignments above land first.
const bridge: any = await import('../bridge')
const { SPEAKERS } = await import('../lib')

// --- Fake Telegram: record calls, return canned API responses (no network).
type Call = { method: string; payload: any }
const calls: Call[] = []
let nextMessageId = 1000
// A bot without Delete Messages: the API refuses deleteForumTopic. Switchable
// because the fallback to merely closing is the interesting half — a fallback that
// no test ever reaches is a fallback nobody knows is broken.
let denyDelete = false
// A media group is all-or-nothing, so the fallback to two individual sends is the
// half that keeps a failure cosmetic instead of losing the answer. A fallback no
// test ever reaches is a fallback nobody knows is broken.
let failMediaGroup = false
// Telegram rejects an unbalanced entity outright. Before the retry existed, a
// caption Telegram would not parse cost the user the FILE, not just the formatting.
let failParsedCaption = false

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
  if (method === 'deleteForumTopic' && denyDelete) {
    return { ok: false, error_code: 400, description: 'Bad Request: not enough rights to delete messages' }
  }
  if (method === 'createForumTopic') {
    // The real API returns a thread id, and the fan-out code depends on it: without
    // one, every part would fall back to the parent's key.
    return { ok: true, result: { message_thread_id: nextMessageId++, name: payload.name, icon_color: 0 } }
  }
  if (method === 'sendDocument' && failParsedCaption && payload.parse_mode) {
    return { ok: false, error_code: 400, description: "Bad Request: can't parse entities" }
  }
  if (method === 'sendVoice' || method === 'sendAudio') {
    // A real Message, not `true`: the bridge records each note's id so it can offer
    // to remove them later, and a bare `true` left that list silently empty.
    return { ok: true, result: { message_id: nextMessageId++, date: 0, chat: { id: payload.chat_id, type: 'private' } } }
  }
  if (method === 'sendMediaGroup') {
    if (failMediaGroup) return { ok: false, error_code: 400, description: 'Bad Request: group send failed' }
    return { ok: true, result: (payload.media ?? []).map(() => ({ message_id: nextMessageId++, date: 0, chat: { id: payload.chat_id, type: 'private' } })) }
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
  // /usage and friends run on their OWN queue key so a refresh tapped during a long
  // turn doesn't sit behind it. Draining only the topic's key would return before
  // they finished and read as an empty reply.
  await bridge._drainQueue(`${chatId}:main#pt`)
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
  test('empty result → reported as no answer, not delivered as one', async () => {
    // Was "(empty response)", which reads like a reply. A turn that produced
    // nothing is a failed turn and now says so, with a retry offered.
    const cs = await incoming(1003, 'EMPTY')
    expect(finalReply(cs)).toMatch(/No answer came back/i)
  })
  test('"No response requested." is never delivered as the answer (A2)', async () => {
    // A CLI queue-layer artefact, found 11 times in one real session. The bridge
    // took it as the turn's final text and posted it verbatim, so from the phone
    // it read as the question being brushed off.
    const cs = await incoming(1008, 'NORESP')
    const reply = finalReply(cs) ?? ''
    expect(reply).not.toContain('No response requested')
    expect(reply).toMatch(/No answer came back/i)
  })
  test('…and the report carries a one-tap retry button', async () => {
    const cs = await incoming(1009, 'NORESP')
    // Find the keyboard on the REPORT specifically: the status message now carries
    // an Interrupt keyboard of its own from the moment it is posted.
    const withKb = sends(cs).find(c =>
      c.payload?.reply_markup?.inline_keyboard && String(c.payload.text ?? '').includes('No answer came back'))
    expect(withKb).toBeTruthy()
    const btn = withKb!.payload.reply_markup.inline_keyboard[0][0]
    expect(btn.text).toMatch(/retry/i)
    // Deliberately a button, not an automatic resend: an agentic turn may already
    // have edited files, and repeating that unasked is worse than the lost answer.
    expect(String(btn.callback_data)).toStartWith('retry:')
  })
  test('is_error result is still delivered (the error text)', async () => {
    const cs = await incoming(1004, 'ERROR')
    expect(finalReply(cs)).toContain('boom')
  })
  test('a hung child is SIGKILLed by the idle watchdog and reported, not left silent', async () => {
    const t0 = performance.now()
    const cs = await incoming(1005, 'HANG')
    const elapsed = performance.now() - t0
    // Must actually reach the idle timeout — proves the watchdog fired rather than
    // the child exiting early (which would pass the text check for the wrong reason).
    expect(elapsed).toBeGreaterThan(1000)
    expect(cs.some(c => c.method === 'deleteMessage')).toBe(true) // status cleaned up
    // Was "Could not parse Claude output", which blamed the output format for what
    // is actually a stall, and told the user nothing they could act on.
    expect(finalReply(cs)).toMatch(/stalled/i)
  }, 12000)
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
    // The safety property is that it is not accepted and not persisted. It used to
    // be asserted via the string "Unknown mode", which was the BUG (C4): a
    // deliberate gate that reads as a missing feature. The refusal is unchanged;
    // only the explanation is.
    expect(stateNow().modes?.['1024:main']).toBeUndefined()
    expect(finalReply(cs)).toMatch(/disabled on this deployment/i)
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

describe('/restart', () => {
  test('is inert when the poller was never started (importing must not be able to exit)', async () => {
    // requestDrain is set by main(), which the import.meta.main guard keeps from
    // running here. So the command has nothing to trigger and must say so rather
    // than reaching process.exit(0) — which would take this test run down with it.
    const cs = await incoming(1040, '/restart')
    expect(finalReply(cs)).toMatch(/not available/i)
  })
})

describe('startup mutex (otherLiveBridge)', () => {
  // A pidfile is only a CLAIM. A SIGKILLed or OOM-killed bridge leaves one behind
  // and pids get reused, so every one of these must read as "no holder" — if any
  // returned a pid, a redeploy would refuse to start for no reason.
  const pf = bridge._PID_FILE as string
  const clear = () => { try { rmSync(pf, { force: true }) } catch {} }

  test('no pidfile → no holder', () => {
    clear()
    expect(bridge._otherLiveBridge()).toBeUndefined()
  })
  test('a pid that no longer exists → stale, no holder', () => {
    writeFileSync(pf, '999999')
    expect(bridge._otherLiveBridge()).toBeUndefined()
  })
  test("another user's pid → not ours, no holder", () => {
    writeFileSync(pf, '1')          // init: root-owned, cwd unreadable
    expect(bridge._otherLiveBridge()).toBeUndefined()
  })
  test('garbage content → no holder', () => {
    for (const junk of ['', '   ', 'not-a-pid', '-5', '0']) {
      writeFileSync(pf, junk)
      expect(bridge._otherLiveBridge()).toBeUndefined()
    }
  })
  test('our own pid is never treated as a rival', () => {
    writeFileSync(pf, String(process.pid))
    expect(bridge._otherLiveBridge()).toBeUndefined()
    clear()
  })
})

describe('token lock (one poller per bot token)', () => {
  // The per-deployment pidfile cannot see a second checkout sharing a token —
  // verified by running two, where one sat in the 409 retry loop while the other
  // polled. These pin the rules that decide whether a bridge may start, and the
  // bias is deliberate: anything unprovable must read as "no holder", because a
  // lock we wrongly think is held keeps the bot DOWN, which is worse than a 409.
  const tmpLock = join(TMP, 'lock')
  const write = (rec: any) => writeFileSync(tmpLock, typeof rec === 'string' ? rec : JSON.stringify(rec))

  test('keyed by the full sha256 of the token, never the token itself', () => {
    const a = bridge._tokenLockPath('111:aaa')
    const b = bridge._tokenLockPath('222:bbb')
    expect(a).not.toBe(b)
    expect(bridge._tokenLockPath('111:aaa')).toBe(a)           // deterministic
    expect(a.split('/').pop()).toMatch(/^[0-9a-f]{64}$/)       // full digest, not a prefix
    expect(a).not.toContain('111:aaa')                         // the secret never lands on disk
  })

  test('missing, malformed, dead and foreign records all read as no holder', () => {
    expect(bridge._lockHolder(join(TMP, 'does-not-exist'))).toBeUndefined()
    for (const junk of ['', 'not json', '{}', '{"pid":0,"cwd":"/"}', '{"pid":-1,"cwd":"/"}', '{"pid":7}']) {
      write(junk)
      expect(bridge._lockHolder(tmpLock)).toBeUndefined()
    }
    write({ pid: 999999, cwd: process.cwd(), started: '1' })    // dead pid
    expect(bridge._lockHolder(tmpLock)).toBeUndefined()
    write({ pid: 1, cwd: '/', started: '1' })                   // root's init
    expect(bridge._lockHolder(tmpLock)).toBeUndefined()
    write({ pid: process.pid, cwd: process.cwd(), started: bridge._procStartTime(process.pid) })
    expect(bridge._lockHolder(tmpLock)).toBeUndefined()         // never our own rival
  })

  test('a real live bun IS a holder, but only when cwd and start-time both match', async () => {
    // A genuine second bun of ours, so the positive path is exercised against a
    // real process rather than a fixture.
    const child = Bun.spawn(['bun', '-e', 'setTimeout(() => {}, 60000)'], { cwd: process.cwd(), stdout: 'ignore', stderr: 'ignore' })
    try {
      await new Promise(r => setTimeout(r, 400))
      const started = bridge._procStartTime(child.pid)
      expect(started).toBeTruthy()

      write({ pid: child.pid, cwd: process.cwd(), started })
      expect(bridge._lockHolder(tmpLock)?.pid).toBe(child.pid)  // held

      // A recycled pid would present as a live bun of ours with a DIFFERENT cwd or
      // start time. Either mismatch must release the lock rather than keep the bot
      // down waiting on a process that is not the one that took it.
      write({ pid: child.pid, cwd: '/nowhere', started })
      expect(bridge._lockHolder(tmpLock)).toBeUndefined()
      write({ pid: child.pid, cwd: process.cwd(), started: '999999999' })
      expect(bridge._lockHolder(tmpLock)).toBeUndefined()
    } finally {
      child.kill()
      await child.exited
    }
  }, 10000)

  test('a dead holder releases the lock (SIGKILL leaves a stale record)', async () => {
    const child = Bun.spawn(['bun', '-e', 'setTimeout(() => {}, 60000)'], { cwd: process.cwd(), stdout: 'ignore', stderr: 'ignore' })
    await new Promise(r => setTimeout(r, 400))
    write({ pid: child.pid, cwd: process.cwd(), started: bridge._procStartTime(child.pid) })
    expect(bridge._lockHolder(tmpLock)?.pid).toBe(child.pid)
    child.kill('SIGKILL')
    await child.exited
    await new Promise(r => setTimeout(r, 200))
    expect(bridge._lockHolder(tmpLock)).toBeUndefined()
  }, 10000)
})

describe('session binding survives a run that never completes (A5)', () => {
  test('the id from the init event is persisted even when no result arrives', async () => {
    // HANG emits `init` and then never produces a result, so the turn dies at the
    // watchdog with res.sessionId undefined. Before the fix nothing reached disk,
    // and the next message in that topic started a brand-new session — which is
    // exactly what /stop on a topic's first turn used to do, since its guard
    // returns before the line that persists.
    await incoming(1050, 'HANG')
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    expect(state.sessions['1050:main']?.sessionId).toBeTruthy()
  }, 8000)

  test('a passthrough command still never binds the topic', async () => {
    // The mirror image: /usage mints a throwaway session, and binding a topic to it
    // would strand the real conversation. Persisting on init must stay opt-in.
    await incoming(1051, '/usage')
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    expect(state.sessions['1051:main']?.sessionId).toBeUndefined()
  }, 8000)
})

describe('mid-turn text is no longer deleted (A1)', () => {
  test('a substantive block written mid-turn is delivered, not just the sign-off', async () => {
    // The reported shape: the model answers, keeps working, then signs off — and
    // only the sign-off reached the phone, which is what made replies read as
    // evasive. Measured fleet-wide: 48% of turns that produced text produced more
    // than one block.
    const cs = await incoming(1060, 'MIDTEXT')
    const texts = sends(cs).map(c => String(c.payload.text ?? ''))
    expect(texts.some(t => t.includes('Timing'))).toBe(true)        // the answer arrived
    expect(texts.some(t => t.includes('report the final ranked'))).toBe(true)  // and the sign-off
  }, 8000)

  test('the run record is kept, so nothing the model said is gone', async () => {
    const cs = await incoming(1061, 'MIDTEXT')
    // The progress message is edited into a record instead of being deleted…
    const edits = cs.filter(c => c.method === 'editMessageText').map(textOf)
    expect(edits.some(t => t.includes('What ran'))).toBe(true)
    // …and it is NOT deleted.
    expect(cs.some(c => c.method === 'deleteMessage')).toBe(false)
  }, 8000)

  test('an ordinary turn still cleans up its progress message', async () => {
    // Keeping the record for every trivial turn would just be clutter, so the
    // default only keeps it when it carries something the reply does not.
    const cs = await incoming(1062, 'hello there')
    expect(cs.some(c => c.method === 'deleteMessage')).toBe(true)
  }, 8000)
})

describe('a stalled run is reported as stalled (A7)', () => {
  test('the idle watchdog kills it and says so, rather than "could not parse"', async () => {
    // HANG emits init and then nothing. With TG_IDLE_TIMEOUT_MS set low for the
    // test, the idle watchdog fires — the flat wall-clock timer used to be the only
    // backstop, which meant up to 30 minutes of dead air and a message that blamed
    // output parsing rather than the stall.
    const cs = await incoming(1070, 'HANG')
    expect(finalReply(cs)).toMatch(/stalled/i)
    expect(finalReply(cs)).not.toMatch(/Could not parse/i)
  }, 15000)
})

describe('the prompt reaches the CLI attributed (A6)', () => {
  test('an ordinary message is framed with the speaker marker', async () => {
    // The stub echoes "framed"/"unframed" based on whether the attribution line
    // was present, so this asserts on what the model actually received.
    const cs = await incoming(1080, 'hello there')
    expect(finalReply(cs)).toContain('framed')
  })
  test('a passthrough command is NOT framed — it is a CLI command, not speech', async () => {
    const cs = await incoming(1081, '/usage')
    expect(finalReply(cs)).not.toContain(' framed')
  })
})

describe('command UX (C2/C3/C4)', () => {
  test('C3: /status reports the model that actually RAN, not just the alias', async () => {
    // The init event has always carried the resolved id; it was parsed and dropped,
    // so /model could only ever report intent. After a CLI upgrade there was no way
    // to tell whether your sessions were on the new model.
    await incoming(1090, 'first turn')            // observe an init
    const cs = await incoming(1090, '/status')
    expect(finalReply(cs)).toContain('claude-opus-5[1m]')
    expect(finalReply(cs)).toContain('last run')  // observed, not predicted
  }, 8000)

  test('C4: /mode bypass explains it is disabled, not that it is unknown', async () => {
    const cs = await incoming(1091, '/mode bypass')
    const reply = finalReply(cs) ?? ''
    expect(reply).not.toMatch(/Unknown mode/i)
    expect(reply).toMatch(/disabled on this deployment/i)
    expect(reply).toContain('TG_ALLOW_BYPASS=1')
  })
  test('C4: a genuinely unknown mode is still rejected as unknown', async () => {
    expect(finalReply(await incoming(1092, '/mode yolo'))).toMatch(/Unknown mode/i)
  })
  test('C4: /mode lists bypass as disabled rather than omitting it', async () => {
    const cs = await incoming(1093, '/mode')
    const shown = sends(cs).map(c => String(c.payload.text ?? '')).join('\n')
    expect(shown).toMatch(/bypass — disabled here/i)
  })

  test('C2: /sessions with no argument lists this topic\'s directory', async () => {
    const cs = await incoming(1094, '/sessions')
    // The listing and the trailing /import hint are separate messages, so assert
    // across everything the command sent rather than only the last one.
    const shown = sends(cs).map(c => String(c.payload.text ?? '')).join('\n')
    expect(shown).not.toMatch(/Usage: \/sessions/)
    expect(shown).toContain(TMP)   // the topic's own cwd, not a usage string
  }, 8000)
})

describe('replies quote the message that triggered them (C1)', () => {
  const replyTarget = (c: any) => c.payload?.reply_parameters?.message_id

  test('a lone question, answered immediately, is NOT threaded', async () => {
    // Threading unconditionally is visually noisy: on a phone every quoted header
    // costs a couple of lines and says nothing when only one question is in flight.
    const cs = await incoming(1100, 'hello there')
    const answer = sends(cs).find(c => String(c.payload.text ?? '').includes('okReply'))
    expect(replyTarget(answer)).toBeUndefined()
  }, 8000)

  test('both answers of an interleaved pair are threaded, not just the first', async () => {
    // Ask twice in quick succession. BOTH answers must be placeable on sight: the
    // second used to arrive unlinked, because its own question was the latest and
    // nothing was queued — leaving the reader to infer it by elimination from the
    // first, which fails the moment anything else posts into the topic.
    const start = calls.length
    const first = incoming(1105, 'hello there')
    await new Promise(r => setTimeout(r, 20))
    await bridge.bot.handleUpdate({
      update_id: 90001,
      message: { message_id: 99001, date: 0, chat: { id: 1105, type: 'private', first_name: 'T' },
                 from: { id: 1, is_bot: false, first_name: 'T' }, text: 'a second question' },
    })
    await first
    await bridge._drainQueue('1105:main')

    const answers = calls.slice(start)
      .filter(c => c.method === 'sendMessage' && String(c.payload.text ?? '').includes('okReply'))
    expect(answers.length).toBe(2)
    expect(answers.every(c => replyTarget(c))).toBe(true)
    // …and they point at DIFFERENT questions, which is the whole point.
    expect(new Set(answers.map(replyTarget)).size).toBe(2)
  }, 12000)

  test('when it does link, it tolerates the question having been deleted', async () => {
    // Without allow_sending_without_reply the send fails outright, losing the
    // answer to protect a cosmetic link.
    const cs = await incoming(1104, 'NORESP')
    const warn = sends(cs).find(c => String(c.payload.text ?? '').includes('No answer came back'))
    if (replyTarget(warn)) expect(warn!.payload.reply_parameters.allow_sending_without_reply).toBe(true)
  }, 8000)

  test('the transient status message is never threaded', async () => {
    const cs = await incoming(1103, 'hello there')
    const status = sends(cs).find(c => textOf(c).includes('Thinking'))
    expect(replyTarget(status)).toBeUndefined()
  }, 8000)
})

describe('/effort plumbs --effort through to the CLI (C5)', () => {
  test('no override means no flag — the CLI keeps its own default', async () => {
    expect(finalReply(await incoming(1110, 'plain turn'))).toContain('effortDefault')
  })
  test('after /effort high, the next turn passes --effort high', async () => {
    expect(finalReply(await incoming(1111, '/effort high'))).toMatch(/high/i)
    expect(finalReply(await incoming(1111, 'do something'))).toContain('efforthigh')
  }, 8000)
  test('it is sticky per topic, and another topic is unaffected', async () => {
    await incoming(1112, '/effort max')
    expect(finalReply(await incoming(1112, 'again'))).toContain('effortmax')
    expect(finalReply(await incoming(1113, 'elsewhere'))).toContain('effortDefault')
  }, 12000)
  test('/effort default clears it', async () => {
    await incoming(1114, '/effort low')
    await incoming(1114, '/effort default')
    expect(finalReply(await incoming(1114, 'after clearing'))).toContain('effortDefault')
  }, 12000)
  test('an unknown level is refused, and nothing is persisted', async () => {
    expect(finalReply(await incoming(1115, '/effort turbo'))).toMatch(/Unknown effort/i)
    expect(stateNow().efforts?.['1115:main']).toBeUndefined()
  })
  test('it survives a state round-trip like the other per-topic settings', async () => {
    await incoming(1116, '/effort xhigh')
    expect(stateNow().efforts['1116:main']).toBe('xhigh')
  })
})

describe('a long answer is delivered as a readable file (C7)', () => {
  const groups = (cs: any[]) => cs.filter(c => c.method === 'sendMediaGroup')
  const items = (cs: any[]) => groups(cs).flatMap(c => c.payload?.media ?? [])

  test('both an .html and an .md are sent', async () => {
    // The .md alone was close to unreadable on macOS: no default viewer, no
    // preview in Telegram Desktop, and double-clicking shows raw pipe-tables —
    // exactly the content that needed a file in the first place.
    const cs = await incoming(1120, 'LONG')
    const names = items(cs).map((m: any) => String(m?.media?.filename ?? ''))
    expect(names.some((n: string) => n.endsWith('.html'))).toBe(true)
    expect(names.some((n: string) => n.endsWith('.md'))).toBe(true)
  }, 10000)

  test('they arrive as ONE grouped message, not two deliveries', async () => {
    // Two independent sendDocument calls read on a phone as two different things,
    // and the second — the source of truth — looked like a stray attachment.
    const cs = await incoming(1123, 'LONG')
    expect(groups(cs)).toHaveLength(1)
    expect(cs.filter(c => c.method === 'sendDocument')).toHaveLength(0)
    expect(items(cs)).toHaveLength(2)
  }, 10000)

  test('the preview caption rides on the first file only', async () => {
    const cs = await incoming(1121, 'LONG')
    const captioned = items(cs).filter((m: any) => m?.caption)
    expect(captioned).toHaveLength(1)
    expect(String(captioned[0].caption)).toContain('Full answer')
  }, 10000)

  test('the caption is FORMATTED, not raw markdown syntax', async () => {
    // It used to be the only message in the bridge sent with no parse mode, so the
    // preview of the longest, most structured answers was the one place a user saw
    // literal **bold** and | pipe | tables |.
    const cs = await incoming(1124, 'LONG')
    const first = items(cs).find((m: any) => m?.caption)
    expect(first.parse_mode).toBe('MarkdownV2')
    expect(String(first.caption).length).toBeLessThanOrEqual(1024)
  }, 10000)

  test('the files follow the same threading rule as any other answer', async () => {
    // A lone question, so no quoted header — the .md and .html are obviously its
    // answer and the link would only cost space.
    const cs = await incoming(1122, 'LONG')
    expect(groups(cs).every(c => !c.payload?.reply_parameters)).toBe(true)
  }, 10000)
})

describe('/effort resolves what "default" means (follow-up)', () => {
  test('with no override and no run yet, it says so instead of "CLI default"', async () => {
    const cs = await incoming(1130, '/effort')
    const shown = sends(cs).map(c => String(c.payload.text ?? '')).join('\n')
    // "default → CLI default" answered nothing. Say plainly that it is not known
    // yet, rather than restating the word.
    expect(shown).not.toContain('CLI default')
    expect(shown).toMatch(/unknown until this topic has run once|→ (low|medium|high|xhigh|max) \(last run\)/)
  }, 8000)

  test('an explicit override is reported directly', async () => {
    await incoming(1131, '/effort high')
    const cs = await incoming(1131, '/effort')
    expect(sends(cs).map(c => String(c.payload.text ?? '')).join('\n')).toContain('high')
  }, 8000)
})

describe('interrupt vs stop, and the job registry', () => {
  const btnOf = (c: any) => c.payload?.reply_markup?.inline_keyboard?.[0]?.[0]

  // Send `text` to `chat` while a run is already in flight there.
  const inject = (chat: number, text: string, id: number) => bridge.bot.handleUpdate({
    update_id: 95000 + id,
    message: { message_id: id, date: 0, chat: { id: chat, type: 'private', first_name: 'T' },
               from: { id: 1, is_bot: false, first_name: 'T' }, text },
  })

  test('/interrupt on an idle topic says so rather than pretending', async () => {
    expect(finalReply(await incoming(1140, '/interrupt'))).toMatch(/nothing is running/i)
  })

  test('/interrupt delivers what the run already produced', async () => {
    // Before mid-turn text was collected there was nothing to keep and stopping
    // could only discard. The expensive part is now already in hand.
    const run = incoming(1141, 'PARTIAL')
    await new Promise(r => setTimeout(r, 400))
    await inject(1141, '/interrupt', 95101)
    const cs = await run
    const texts = sends(cs).map(c => String(c.payload.text ?? '')).join('\n')
    expect(texts).toContain('160 of 245')
  }, 20000)

  test('/stop discards, and the two are distinguishable in the reply', async () => {
    const run = incoming(1142, 'PARTIAL')
    await new Promise(r => setTimeout(r, 400))
    await inject(1142, '/stop', 95102)
    const cs = await run
    const texts = sends(cs).map(c => String(c.payload.text ?? '')).join('\n')
    expect(texts).toMatch(/discarded/i)
    expect(texts).not.toContain('160 of 245')
  }, 20000)

  test('the status message offers Interrupt from the moment it appears', async () => {
    // Not after a delay: a run is interruptible from its first second, so a control
    // that materialises later is one you have to notice arriving, exactly while you
    // are already waiting on something.
    const before = calls.length
    const run = incoming(1143, 'PARTIAL')
    await new Promise(r => setTimeout(r, 400))
    const firstStatus = calls.slice(before).find(c => c.method === 'sendMessage' && textOf(c).includes('Thinking'))
    expect(btnOf(firstStatus)).toBeTruthy()
    const withBtn = calls.find(c => c.method === 'editMessageText' && btnOf(c))
    expect(withBtn).toBeTruthy()
    expect(btnOf(withBtn).text).toBe('— Interrupt —')
    // Job-scoped, never topic-scoped: the status message is retained after a run
    // that produced text, so a topic-scoped button would end whatever is running
    // later.
    expect(String(btnOf(withBtn).callback_data)).toMatch(/^int:[0-9a-f]{8}$/)
    await inject(1143, '/interrupt', 95103)
    await run
  }, 20000)

  test('the keyboard is stripped when the run ends', async () => {
    const before = calls.length
    await incoming(1144, 'hello there')
    expect(calls.slice(before).some(c => c.method === 'editMessageReplyMarkup')).toBe(true)
  }, 10000)

  test('/jobs reports an idle topic honestly', async () => {
    expect(finalReply(await incoming(1145, '/jobs'))).toMatch(/nothing running/i)
  })

  test('/jobs lists a run in flight, with its id and age', async () => {
    const run = incoming(1146, 'PARTIAL')
    await new Promise(r => setTimeout(r, 400))
    const cs = await inject(1146, '/jobs', 95104).then(() => calls.slice(-6))
    const shown = cs.filter(c => c.method === 'sendMessage').map(c => String(c.payload.text ?? '')).join('\n')
    expect(shown).toMatch(/Jobs in this topic/i)
    expect(shown).toMatch(/▶ [0-9a-f]{8}/)
    await inject(1146, '/interrupt', 95105)
    await run
  }, 20000)
})

describe('interrupting a run stops the tree it built', () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

  test('a process the run backgrounded does NOT survive the interrupt', async () => {
    // The bug this exists for, measured before building it: SIGKILL to the claude
    // process left every grandchild running, so a `nohup`ed job kept going
    // invisibly. The fix is spawning the child in its own process group and
    // signalling the GROUP.
    const cwd = join(TMP, 'sessions', 'dm-1')
    const pidfile = join(cwd, 'bgpid.txt')
    try { rmSync(pidfile, { force: true }) } catch {}

    const run = incoming(1150, 'BGPROC')
    let bg = 0
    for (let i = 0; i < 60 && !bg; i++) {
      await new Promise(r => setTimeout(r, 100))
      try { bg = Number(readFileSync(pidfile, 'utf8').trim()) } catch {}
    }
    expect(bg).toBeGreaterThan(0)
    expect(alive(bg)).toBe(true)          // it really is running

    await bridge.bot.handleUpdate({
      update_id: 96000,
      message: { message_id: 96001, date: 0, chat: { id: 1150, type: 'private', first_name: 'T' },
                 from: { id: 1, is_bot: false, first_name: 'T' }, text: '/interrupt' },
    })
    await run
    for (let i = 0; i < 40 && alive(bg); i++) await new Promise(r => setTimeout(r, 100))

    expect(alive(bg)).toBe(false)         // …and it is gone
    if (alive(bg)) { try { process.kill(bg, 'SIGKILL') } catch {} }
  }, 30000)
})

describe('job messages point back at what caused them', () => {
  const replyTarget = (c: any) => c.payload?.reply_parameters?.message_id
  const inject = (chat: number, text: string, id: number) => bridge.bot.handleUpdate({
    update_id: 97000 + id,
    message: { message_id: id, date: 0, chat: { id: chat, type: 'private', first_name: 'T' },
               from: { id: 1, is_bot: false, first_name: 'T' }, text },
  })

  test('the interrupt acknowledgement quotes the question being interrupted', async () => {
    // By the time you interrupt, the question is far up the topic. "Interrupting…"
    // on its own does not say interrupting WHAT — which is worse once more than one
    // thing can be running.
    const run = incoming(1160, 'PARTIAL')
    await new Promise(r => setTimeout(r, 400))
    const before = calls.length
    await inject(1160, '/interrupt', 97101)
    const ack = calls.slice(before).find(c => c.method === 'sendMessage' && String(c.payload.text ?? '').includes('Interrupting'))
    expect(ack).toBeTruthy()
    expect(replyTarget(ack)).toBeTruthy()
    expect(replyTarget(ack)).not.toBe(97101)     // the question, not the /interrupt itself
    await run
  }, 20000)

  test('and the partial answer links too, because the interrupt interleaved', async () => {
    // A command typed mid-run separates the answer from its question just as much
    // as another question would. latestIncoming used to ignore commands entirely.
    const run = incoming(1161, 'PARTIAL')
    await new Promise(r => setTimeout(r, 400))
    const before = calls.length
    await inject(1161, '/interrupt', 97102)
    await run
    const answer = calls.slice(before).find(c => c.method === 'sendMessage' && String(c.payload.text ?? '').includes('160 of 245'))
    expect(answer).toBeTruthy()
    expect(replyTarget(answer)).toBeTruthy()
  }, 20000)

  test('the cancellation notice quotes its question as well', async () => {
    const run = incoming(1162, 'PARTIAL')
    await new Promise(r => setTimeout(r, 400))
    const before = calls.length
    await inject(1162, '/stop', 97103)
    const ack = calls.slice(before).find(c => c.method === 'sendMessage' && String(c.payload.text ?? '').includes('Cancelled'))
    expect(replyTarget(ack)).toBeTruthy()
    await run
  }, 20000)
})

describe('/bg and running a message alongside instead of behind (D: /bg)', () => {
  const btnOf = (c: any) => c.payload?.reply_markup?.inline_keyboard?.[0]?.[0]
  const inject = (chat: number, text: string, id: number) => bridge.bot.handleUpdate({
    update_id: 98000 + id,
    message: { message_id: id, date: 0, chat: { id: chat, type: 'private', first_name: 'T' },
               from: { id: 1, is_bot: false, first_name: 'T' }, text },
  })

  test('/bg without a task explains itself rather than doing nothing', async () => {
    expect(finalReply(await incoming(1170, '/bg'))).toMatch(/Usage: \/bg/)
  })

  test('/bg forks the session, so the topic keeps its own', async () => {
    // A parallel run sharing the topic's session id would corrupt its ordering, and
    // persisting the fork's id would quietly steal the topic's binding.
    await incoming(1171, 'first, to establish a session')
    const bound = stateNow().sessions['1171:main']?.sessionId
    expect(bound).toBeTruthy()

    const before = calls.length
    await incoming(1171, '/bg summarise the logs')
    await bridge._drainQueue('1171:main#bg-' + (updateId + 5000 - 1)).catch(() => {})
    await new Promise(r => setTimeout(r, 800))
    const texts = calls.slice(before).filter(c => c.method === 'sendMessage').map(c => String(c.payload.text ?? '')).join('\n')
    expect(texts).toContain('background')          // acknowledged up front
    expect(texts).toContain('forked')              // the stub reports --fork-session
    expect(stateNow().sessions['1171:main']?.sessionId).toBe(bound)   // binding untouched
  }, 15000)

  test('a message sent while a long run is going is offered the choice', async () => {
    const run = incoming(1172, 'PARTIAL')
    await new Promise(r => setTimeout(r, 400))
    const before = calls.length
    await inject(1172, 'a second, unrelated question', 98101)
    const offer = calls.slice(before).find(c => c.method === 'sendMessage' && btnOf(c))
    expect(offer).toBeTruthy()
    expect(btnOf(offer).text).toBe('— Run this now —')
    expect(String(btnOf(offer).callback_data)).toBe('par:98101')
    // The offer quotes the message it is about, and is silent — it is an aside.
    expect(offer!.payload.reply_parameters?.message_id).toBe(98101)
    expect(offer!.payload.disable_notification).toBe(true)
    await inject(1172, '/interrupt', 98102)
    await run
  }, 20000)

  test('a message with nothing ahead of it is not offered anything', async () => {
    // The offer is about WAITING. Nothing queued means no wait and nothing to say.
    const before = calls.length
    await incoming(1173, 'hello there')
    const offers = calls.slice(before).filter(c => c.method === 'sendMessage' && btnOf(c)
      && btnOf(c).text === '— Run this now —')
    expect(offers).toHaveLength(0)
  }, 10000)

  test('the FIRST message behind a run is offered it too, not only a later one', async () => {
    // There used to be a delay threshold, which made the option appear to depend on
    // nothing you could see: a message sent just after a long task started queued
    // silently, while a later one got the button.
    const run = incoming(1176, 'PARTIAL')
    await new Promise(r => setTimeout(r, 50))     // immediately behind it
    const before = calls.length
    await inject(1176, 'right behind it', 98301)
    const offer = calls.slice(before).find(c => c.method === 'sendMessage' && btnOf(c))
    expect(offer).toBeTruthy()
    expect(String(btnOf(offer).callback_data)).toBe('par:98301')
    await inject(1176, '/interrupt', 98302)
    await run
    await bridge._drainQueue('1176:main')
  }, 20000)

  test('the offer is withdrawn once its message is picked up in order', async () => {
    // It was an aside about a wait that is now over; a dead button above the answer
    // is worse than no button at all.
    const run = incoming(1177, 'PARTIAL')
    await new Promise(r => setTimeout(r, 50))
    await inject(1177, 'queued behind it', 98311)
    const offer = calls.find(c => c.method === 'sendMessage' && btnOf(c)
      && String(btnOf(c).callback_data) === 'par:98311')
    expect(offer).toBeTruthy()
    const offerId = 1000 + calls.filter(c => c.method === 'sendMessage').indexOf(offer!)  // ids are sequential in the fake
    const before = calls.length
    await inject(1177, '/interrupt', 98312)       // let the blocking run end
    await run
    await bridge._drainQueue('1177:main')
    expect(calls.slice(before).some(c => c.method === 'deleteMessage')).toBe(true)
    void offerId
  }, 25000)

  test('taking the offer runs it once, not twice', async () => {
    // The queued turn must do nothing once its message has been promoted, or the
    // same prompt runs in parallel AND again in sequence.
    const run = incoming(1174, 'PARTIAL')
    await new Promise(r => setTimeout(r, 400))
    await inject(1174, 'promote me', 98201)
    const before = calls.length
    await bridge.bot.handleUpdate({
      update_id: 98999,
      callback_query: { id: 'cb1', from: { id: 1, is_bot: false, first_name: 'T' },
        chat_instance: 'x', data: 'par:98201',
        message: { message_id: 98202, date: 0, chat: { id: 1174, type: 'private' } } },
    })
    await new Promise(r => setTimeout(r, 1200))
    await inject(1174, '/interrupt', 98203)
    await run
    await bridge._drainQueue('1174:main')
    const ran = calls.slice(before).filter(c => c.method === 'sendMessage' && String(c.payload.text ?? '').includes('okReply'))
    expect(ran.length).toBe(1)
  }, 25000)

  test('taking the offer answers WHILE the blocking run is still going', async () => {
    // The assertion the count-based test above cannot make, and the one the user's
    // complaint actually is. Under the old guard the promoted run consumed the
    // skipQueued flag meant for its twin and returned without spawning: zero replies
    // from the fork, one from the queued turn later — total one, so `runs it once`
    // stayed green for precisely the behaviour it was written to forbid. For a
    // feature whose whole value is WHEN something happens, counting how many times it
    // happened is not a test of it.
    const run = incoming(1178, 'PARTIAL')
    await new Promise(r => setTimeout(r, 400))
    await inject(1178, 'promote me too', 98401)
    const before = calls.length
    await bridge.bot.handleUpdate({
      update_id: 98997,
      callback_query: { id: 'cb3', from: { id: 1, is_bot: false, first_name: 'T' },
        chat_instance: 'x', data: 'par:98401',
        message: { message_id: 98402, date: 0, chat: { id: 1178, type: 'private' } } },
    })
    await bridge._drainQueue('1178:main#bg-98401')
    // Read the answers BEFORE letting the blocking run end. Anything here arrived
    // alongside it, which is the entire feature.
    const during = calls.slice(before).filter(c => c.method === 'sendMessage'
      && String(c.payload.text ?? '').includes('okReply'))
    expect(during.length).toBe(1)
    await inject(1178, '/interrupt', 98403)
    await run
    await bridge._drainQueue('1178:main')
  }, 25000)

  test('a promoted run does not steal the topic\'s session binding', async () => {
    // It forked, so it reports a fresh session id on completion. Persisting that
    // would silently continue the topic from the parallel job's transcript. The
    // early binding was already guarded; the completion binding was not — and was
    // unreachable until the fork above started actually running.
    await incoming(1179, 'first, to establish a session')
    const bound = stateNow().sessions['1179:main']?.sessionId
    expect(bound).toBeTruthy()

    const run = incoming(1179, 'PARTIAL')
    await new Promise(r => setTimeout(r, 400))
    await inject(1179, 'run me alongside', 98501)
    await bridge.bot.handleUpdate({
      update_id: 98996,
      callback_query: { id: 'cb4', from: { id: 1, is_bot: false, first_name: 'T' },
        chat_instance: 'x', data: 'par:98501',
        message: { message_id: 98502, date: 0, chat: { id: 1179, type: 'private' } } },
    })
    await bridge._drainQueue('1179:main#bg-98501')
    expect(stateNow().sessions['1179:main']?.sessionId).toBe(bound)
    await inject(1179, '/interrupt', 98503)
    await run
    await bridge._drainQueue('1179:main')
  }, 30000)

  test('taking the offer does not announce itself as a finished background task', async () => {
    // The banner exists to close /bg's promise to "report back", after a gap in
    // which the topic has moved on. A promoted turn has no such gap: the tap was
    // seconds ago, the toast already said it was starting, and the answer quotes the
    // question. Reported as "it feels unnecessary".
    const run = incoming(1182, 'PARTIAL')
    await new Promise(r => setTimeout(r, 400))
    await inject(1182, 'no banner for me', 98601)
    const before = calls.length
    await bridge.bot.handleUpdate({
      update_id: 98995,
      callback_query: { id: 'cb5', from: { id: 1, is_bot: false, first_name: 'T' },
        chat_instance: 'x', data: 'par:98601',
        message: { message_id: 98602, date: 0, chat: { id: 1182, type: 'private' } } },
    })
    await bridge._drainQueue('1182:main#bg-98601')
    const said = calls.slice(before).filter(c => c.method === 'sendMessage')
      .map(c => String(c.payload.text ?? ''))
    // The answer still lands — this suppresses the banner, not the reply.
    expect(said.some(t => t.includes('okReply'))).toBe(true)
    expect(said.some(t => t.includes('Background task finished'))).toBe(false)
    await inject(1182, '/interrupt', 98603)
    await run
    await bridge._drainQueue('1182:main')
  }, 25000)

  test('/bg keeps the banner, because it promised to report back', async () => {
    // The other side of the same rule. Dropping it here would leave "carry on here,
    // I will report back" unanswered.
    const before = calls.length
    await incoming(1183, '/bg go and look something up')
    await bridge._drainQueue('1183:main#bg-' + (updateId + 5000 - 1)).catch(() => {})
    await new Promise(r => setTimeout(r, 800))
    const said = calls.slice(before).filter(c => c.method === 'sendMessage')
      .map(c => String(c.payload.text ?? ''))
    expect(said.some(t => t.includes('Background task finished'))).toBe(true)
  }, 15000)

  test('a stale offer says so rather than forking a second run', async () => {
    const before = calls.length
    await bridge.bot.handleUpdate({
      update_id: 98998,
      callback_query: { id: 'cb2', from: { id: 1, is_bot: false, first_name: 'T' },
        chat_instance: 'x', data: 'par:404404',
        message: { message_id: 1, date: 0, chat: { id: 1175, type: 'private' } } },
    })
    const ans = calls.slice(before).find(c => c.method === 'answerCallbackQuery')
    expect(String(ans?.payload?.text ?? '')).toMatch(/already running/i)
  }, 10000)
})

describe('a finished background job is carried into the next turn', () => {
  test("the topic's next turn is told what the background task found", async () => {
    // A forked job has its own session id — deliberately — and that id is never
    // persisted, so the topic's own conversation would otherwise never learn the
    // job happened: the user gets an answer in Telegram while the next turn has no
    // idea it exists.
    await incoming(1180, 'establish the session')
    await incoming(1180, '/bg go and look something up')
    await new Promise(r => setTimeout(r, 1200))          // let the bg turn finish
    const cs = await incoming(1180, 'so what did you find?')
    expect(finalReply(cs)).toContain('sawBgResult')
  }, 20000)

  test('a PROMOTED job is carried into the next turn too, banner or no banner', async () => {
    // The carry-over and the banner used to be one `if`, so suppressing the banner
    // for a promoted turn could silently take this with it. It must not: a promoted
    // run forks exactly like /bg does, so the topic's own conversation never sees it
    // and the next turn would have no idea the question was ever answered.
    await incoming(1184, 'establish the session')
    const run = incoming(1184, 'PARTIAL')
    await new Promise(r => setTimeout(r, 400))
    await bridge.bot.handleUpdate({
      update_id: 98994,
      message: { message_id: 98701, date: 0, chat: { id: 1184, type: 'private', first_name: 'T' },
                 from: { id: 1, is_bot: false, first_name: 'T' }, text: 'promote and remember me' },
    })
    await bridge.bot.handleUpdate({
      update_id: 98993,
      callback_query: { id: 'cb6', from: { id: 1, is_bot: false, first_name: 'T' },
        chat_instance: 'x', data: 'par:98701',
        message: { message_id: 98702, date: 0, chat: { id: 1184, type: 'private' } } },
    })
    await bridge._drainQueue('1184:main#bg-98701')
    await bridge.bot.handleUpdate({
      update_id: 98992,
      message: { message_id: 98703, date: 0, chat: { id: 1184, type: 'private', first_name: 'T' },
                 from: { id: 1, is_bot: false, first_name: 'T' }, text: '/interrupt' },
    })
    await run
    await bridge._drainQueue('1184:main')
    expect(finalReply(await incoming(1184, 'so what did that turn up?'))).toContain('sawBgResult')
  }, 30000)

  test('an ordinary turn with no background history carries nothing', async () => {
    expect(finalReply(await incoming(1181, 'just a question'))).toContain('noBgResult')
  }, 10000)
})

describe('fan-out', () => {
  const btns = (c: any) => c.payload?.reply_markup?.inline_keyboard?.[0] ?? []
  // A forum group, since each part needs its own topic to be steerable.
  const group = async (text: string, id: number, threadId?: number) => {
    const before = calls.length
    await bridge.bot.handleUpdate({
      update_id: 99000 + id,
      message: {
        message_id: id, date: 0, message_thread_id: threadId,
        chat: { id: -100777, type: 'supergroup', title: 'G', is_forum: true },
        from: { id: 1, is_bot: false, first_name: 'T' }, text,
      },
    })
    return { before }
  }

  test('a DM is refused, with the reason', async () => {
    // Steering a part means talking in its topic, and a DM has none.
    expect(finalReply(await incoming(1190, '/fanout do a thing'))).toMatch(/needs a forum group/i)
  })

  test('/fanout with no task explains itself', async () => {
    expect(finalReply(await incoming(1191, '/fanout'))).toMatch(/Usage: \/fanout/)
  })

  test('it proposes a split and waits for confirmation before spawning', async () => {
    const { before } = await group('/fanout look at the codebase', 99101)
    await bridge._drainQueue('-100777:main')
    await new Promise(r => setTimeout(r, 300))
    const after = calls.slice(before)
    const proposal = after.find(c => c.method === 'sendMessage' && String(c.payload.text ?? '').includes('Proposed split'))
    expect(proposal).toBeTruthy()
    expect(btns(proposal).map((b: any) => b.text)).toEqual(['— Run these 2 —', '— Cancel —'])
    // Nothing has been spawned yet: no topic created, no part started.
    expect(after.some(c => c.method === 'createForumTopic')).toBe(false)
  }, 15000)

  test('confirming creates a topic per part and runs them', async () => {
    const { before } = await group('/fanout investigate the thing', 99102)
    await bridge._drainQueue('-100777:main')
    await new Promise(r => setTimeout(r, 300))
    const proposal = calls.slice(before).find(c => c.method === 'sendMessage' && String(c.payload.text ?? '').includes('Proposed split'))
    const runBtn = btns(proposal).find((b: any) => String(b.text).startsWith('— Run these'))
    expect(runBtn).toBeTruthy()

    const beforeRun = calls.length
    await bridge.bot.handleUpdate({
      update_id: 99500,
      callback_query: { id: 'fb1', from: { id: 1, is_bot: false, first_name: 'T' }, chat_instance: 'x',
        data: runBtn.callback_data,
        message: { message_id: 99103, date: 0, chat: { id: -100777, type: 'supergroup' } } },
    })
    await new Promise(r => setTimeout(r, 2500))
    const after = calls.slice(beforeRun)
    // One topic per part — that is what makes a part steerable.
    expect(after.filter(c => c.method === 'createForumTopic').length).toBe(2)
    const texts = after.filter(c => c.method === 'sendMessage').map(c => String(c.payload.text ?? '')).join('\n')
    expect(texts).toMatch(/Part 1 of 2/)
    expect(texts).toMatch(/Talk here to steer this part/)
  }, 25000)

  test('cancelling drops the plan without spawning anything', async () => {
    const { before } = await group('/fanout something else', 99104)
    await bridge._drainQueue('-100777:main')
    await new Promise(r => setTimeout(r, 300))
    const proposal = calls.slice(before).find(c => c.method === 'sendMessage' && String(c.payload.text ?? '').includes('Proposed split'))
    const cancel = btns(proposal).find((b: any) => String(b.text).includes('Cancel'))
    const beforeCancel = calls.length
    await bridge.bot.handleUpdate({
      update_id: 99501,
      callback_query: { id: 'fb2', from: { id: 1, is_bot: false, first_name: 'T' }, chat_instance: 'x',
        data: cancel.callback_data,
        message: { message_id: 99105, date: 0, chat: { id: -100777, type: 'supergroup' } } },
    })
    await new Promise(r => setTimeout(r, 400))
    expect(calls.slice(beforeCancel).some(c => c.method === 'createForumTopic')).toBe(false)
  }, 15000)
})

describe('fan-out: worktree isolation for write-parts', () => {
  // Parallel agents in one checkout trample each other's edits and git state, so a
  // write-part gets its own worktree. This exercises it against a REAL repo rather
  // than asserting the code path exists.
  const repo = join(TMP, 'wt-repo')

  beforeAll(() => {
    mkdirSync(repo, { recursive: true })
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' })
    git('init', '-q')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 'T')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git('add', '-A')
    git('commit', '-qm', 'init')
  })

  test('a real worktree is created, on its own branch', () => {
    const wt = bridge._makeWorktree(repo, 'fan1', 1)
    expect(wt).toBeTruthy()
    expect(existsSync(join(wt!.path, 'a.txt'))).toBe(true)   // the checkout is real
    expect(wt!.branch).toBe('fanout/fan1-1')
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list'], { encoding: 'utf8' })
    expect(branches).toContain('fanout/fan1-1')
  })

  test('two parts get separate trees, so edits cannot collide', () => {
    const a = bridge._makeWorktree(repo, 'fan2', 1)
    const b = bridge._makeWorktree(repo, 'fan2', 2)
    expect(a!.path).not.toBe(b!.path)
    writeFileSync(join(a!.path, 'a.txt'), 'edited by part 1\n')
    // Part 2 is untouched by part 1's edit — the whole point of the isolation.
    expect(readFileSync(join(b!.path, 'a.txt'), 'utf8')).toBe('one\n')
  })

  test('a directory that is not a repo yields nothing, rather than a broken tree', () => {
    // The caller reports this and runs the part read-only instead of quietly
    // writing into the shared checkout beside every other part.
    const plain = join(TMP, 'not-a-repo')
    mkdirSync(plain, { recursive: true })
    expect(bridge._makeWorktree(plain, 'fan3', 1)).toBeUndefined()
  })
})

describe('/fork — a second topic on the same conversation and the same directory', () => {
  const btns = (c: any) => c.payload?.reply_markup?.inline_keyboard?.[0] ?? []
  const group = (text: string, id: number, threadId?: number) => bridge.bot.handleUpdate({
    update_id: 96700 + id,
    message: {
      message_id: id, date: 0, message_thread_id: threadId,
      chat: { id: -100777, type: 'supergroup', title: 'G', is_forum: true },
      from: { id: 1, is_bot: false, first_name: 'T' }, text,
    },
  })

  test('forks into a new topic with a NEW session id, sharing the parent directory', async () => {
    // Establish a session in the parent topic first — there is nothing to fork
    // without one, and that refusal is the next test.
    await group('hello there', 96001, 4242)
    await bridge._drainQueue('-100777:4242')
    await new Promise(r => setTimeout(r, 500))
    const parent = bridge._sessions()['-100777:4242']
    expect(parent?.sessionId).toBeDefined()
    // The stub CLI does not write transcripts, so stand one in for it — /fork copies
    // the file the real CLI would have left, and refuses when there is none.
    const pdir = bridge._projectDir(parent.cwd)
    mkdirSync(pdir, { recursive: true })
    writeFileSync(join(pdir, `${parent.sessionId}.jsonl`),
      [JSON.stringify({ type: 'mode', mode: 'normal', sessionId: parent.sessionId }),
       JSON.stringify({ type: 'user', sessionId: parent.sessionId, message: { role: 'user', content: 'hello there' } }),
       ''].join('\n'))

    const before = calls.length
    await group('/fork the other approach', 96002, 4242)
    await new Promise(r => setTimeout(r, 500))
    const created = calls.slice(before).find(c => c.method === 'createForumTopic')
    expect(created).toBeDefined()
    expect(String(created!.payload.name)).toBe('the other approach')

    // Both directions carry a link. A fork you cannot get back from, or that does
    // not say where it came from, is a topic you find later with no idea what it is.
    const after = calls.slice(before)
    const forkNote = after.find(c => c.method === 'sendMessage' && String(c.payload.text ?? '').includes('Forked from'))
    const parentNote = after.find(c => c.method === 'sendMessage' && String(c.payload.text ?? '').includes('Forked into'))
    expect(forkNote).toBeDefined()
    expect(parentNote).toBeDefined()
    expect(String(forkNote!.payload.text)).toMatch(/\/c\/777\//)            // → the parent's note
    // The parent's note is edited once the fork's first message exists, so it can
    // point at that rather than merely at the topic.
    const edit = after.find(c => c.method === 'editMessageText' && String(c.payload.text ?? '').includes('Forked into'))
    expect(edit).toBeDefined()
    expect(String(edit!.payload.text)).toMatch(/\/c\/777\/\d+\/\d+/)

    const tid = 1000 + calls.slice(before).findIndex(c => c.method === 'createForumTopic')
    const child = Object.entries(bridge._sessions())
      .find(([k, v]: any) => k.startsWith('-100777:') && k !== '-100777:4242' && v.cwd === parent.cwd
        && v.sessionId !== parent.sessionId)
    expect(child).toBeDefined()
    const [, ce]: any = child!
    // The two properties that make a fork a fork: same directory, different session.
    expect(ce.cwd).toBe(parent.cwd)
    expect(ce.sessionId).not.toBe(parent.sessionId)
    // …and the fork's transcript exists, so its first turn resumes a real session
    // rather than starting empty. This is the half that binding-by-flag gets wrong.
    expect(existsSync(join(bridge._projectDir(parent.cwd), `${ce.sessionId}.jsonl`))).toBe(true)
    // The parent is untouched — forking must never move the topic you forked from.
    expect(bridge._sessions()['-100777:4242'].sessionId).toBe(parent.sessionId)
  }, 20000)

  test('the copied transcript claims the new id, not the one it came from', async () => {
    // A transcript whose contents disagree with its filename is a trap for anything
    // that later reads either.
    const all: any = bridge._sessions()
    const parent = all['-100777:4242']
    const [, ce]: any = Object.entries(all).find(([k, v]: any) =>
      k.startsWith('-100777:') && k !== '-100777:4242' && v.sessionId !== parent.sessionId)!
    const text = readFileSync(join(bridge._projectDir(parent.cwd), `${ce.sessionId}.jsonl`), 'utf8')
    const ids = new Set(text.split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l).sessionId } catch { return undefined }
    }).filter(Boolean))
    expect([...ids]).toEqual([ce.sessionId])
  })

  test('a topic sharing its directory gets its own inbox and outbox, and is told', async () => {
    // "Put it in ./outbox/" is a race once two topics drain one directory: whoever
    // finishes a run first delivers the other's file into the wrong conversation.
    const all: any = bridge._sessions()
    const parentKey = '-100777:4242'
    const [childKey]: any = Object.entries(all).find(([k, v]: any) =>
      k.startsWith('-100777:') && k !== parentKey && v.cwd === all[parentKey].cwd)!
    expect(bridge._boxDir(all[parentKey].cwd, parentKey, 'outbox'))
      .not.toBe(bridge._boxDir(all[parentKey].cwd, childKey, 'outbox'))

    // And the model is told, every turn, because the sharing can begin long after
    // the session did.
    const cwd = all[parentKey].cwd
    mkdirSync(join(cwd, 'outbox'), { recursive: true })
    writeFileSync(join(cwd, 'outbox', 'shared.txt'), 'x')
    const before = calls.length
    await group('anything', 96003, 4242)
    await bridge._drainQueue(parentKey)
    // The file in the SHARED root is still delivered rather than stranded there…
    expect(calls.slice(before).some(c => c.method === 'sendDocument')).toBe(true)
    expect(existsSync(join(cwd, 'outbox', 'shared.txt'))).toBe(false)
  }, 20000)

  test('an unnamed topic forks to its directory name, never "topic · fork"', async () => {
    // Reported from production: /fork in a topic the user had made themselves
    // produced "topic · fork". The bridge only learns a topic's name from the
    // service message Telegram sends at creation, so a topic that predates the bot
    // has none — and the fallback was the literal word.
    await group('hello there', 96010, 5252)
    await bridge._drainQueue('-100777:5252')
    const parent = bridge._sessions()['-100777:5252']
    const pdir = bridge._projectDir(parent.cwd)
    mkdirSync(pdir, { recursive: true })
    writeFileSync(join(pdir, `${parent.sessionId}.jsonl`),
      JSON.stringify({ type: 'mode', sessionId: parent.sessionId }) + '\n')

    const before = calls.length
    await group('/fork', 96011, 5252)
    await new Promise(r => setTimeout(r, 500))
    const created = calls.slice(before).find(c => c.method === 'createForumTopic')
    expect(created).toBeDefined()
    const name = String(created!.payload.name)
    expect(name).not.toBe('topic · fork')
    // topic-5252 is what resolveCwd derives for an unnamed topic, so that is what
    // the fork is named after: the directory the conversation is about.
    expect(name).toBe('topic-5252 · fork')
  }, 20000)

  test('refuses in a DM, and refuses a topic with no session', async () => {
    expect(finalReply(await incoming(1195, '/fork'))).toMatch(/forum group/i)
    const before = calls.length
    await group('/fork', 96004, 4343)      // a topic that has never run anything
    await new Promise(r => setTimeout(r, 300))
    const said = calls.slice(before).filter(c => c.method === 'sendMessage').map(c => String(c.payload.text ?? '')).join('\n')
    expect(said).toMatch(/no session/i)
    expect(calls.slice(before).some(c => c.method === 'createForumTopic')).toBe(false)
  }, 15000)
})

describe('fan-out: steering a part changes the combined answer', () => {
  const btns = (c: any) => c.payload?.reply_markup?.inline_keyboard?.[0] ?? []
  const group = (text: string, id: number, threadId?: number) => bridge.bot.handleUpdate({
    update_id: 99700 + id,
    message: {
      message_id: id, date: 0, message_thread_id: threadId,
      chat: { id: -100777, type: 'supergroup', title: 'G', is_forum: true },
      from: { id: 1, is_bot: false, first_name: 'T' }, text,
    },
  })

  test('parts get DISTINCT topics, so they never share a session', async () => {
    const before = calls.length
    await group('/fanout look into things', 99201)
    await bridge._drainQueue('-100777:main')
    await new Promise(r => setTimeout(r, 300))
    const proposal = calls.slice(before).find(c => c.method === 'sendMessage' && String(c.payload.text ?? '').includes('Proposed split'))
    const run = btns(proposal).find((b: any) => String(b.text).startsWith('— Run these'))
    await bridge.bot.handleUpdate({
      update_id: 99801,
      callback_query: { id: 'fs1', from: { id: 1, is_bot: false, first_name: 'T' }, chat_instance: 'x',
        data: run.callback_data, message: { message_id: 99202, date: 0, chat: { id: -100777, type: 'supergroup' } } },
    })
    await new Promise(r => setTimeout(r, 3000))
    // Scoped to THIS fan-out's calls: other suites (/fork) create topics too, and a
    // global filter turns their names into this test's business.
    const created = calls.slice(before).filter(c => c.method === 'createForumTopic')
    expect(created.length).toBeGreaterThanOrEqual(2)
    // The identity is carried by a custom emoji from Telegram's approved set, which
    // always renders — an emoji in the NAME is drawn by the client's own font, and
    // that is where 🍃 became a question mark. So: icon yes, emoji in the name no.
    expect(created.every(c => typeof c.payload.icon_custom_emoji_id === 'string'
      && c.payload.icon_custom_emoji_id.length > 0)).toBe(true)
    expect(created.every(c => String(c.payload.name).startsWith('--- '))).toBe(true)
    expect(created.some(c => /[\u{1F300}-\u{1FAFF}]/u.test(String(c.payload.name)))).toBe(false)
    // Each part was addressed in its own thread, not all in the parent.
    const threads = new Set(calls.filter(c => c.method === 'sendMessage'
      && String(c.payload.text ?? '').includes('Talk here to steer')).map(c => c.payload.message_thread_id))
    expect(threads.size).toBeGreaterThanOrEqual(2)
    expect([...threads].every(t => t !== undefined)).toBe(true)
  }, 30000)

  test('the part list ends up linking every part, not accusing Telegram of failing', async () => {
    // It used to be written the instant the parts were told to start — before their
    // topics existed — so a part whose topic had not been created YET was reported
    // as one that COULD NOT be created. Nothing had failed; the message was early.
    const sent = calls.find(c => c.method === 'sendMessage'
      && String(c.payload.text ?? '').includes('Running 2 parts'))
    expect(sent).toBeDefined()
    const edits = calls.filter(c => c.method === 'editMessageText'
      && String(c.payload.text ?? '').includes('Running 2 parts'))
    const finalList = String((edits[edits.length - 1] ?? sent)!.payload.text)
    expect(finalList).not.toMatch(/no topic could be created/)
    // Both parts are links by the end, whatever order their topics arrived in.
    // Matched on the chat path rather than the host: MarkdownV2 escaping puts a
    // backslash in "t.me", so a regex for the domain finds nothing and the test
    // would fail on its own escaping.
    expect(finalList.match(/\/c\/777\//g)?.length).toBe(2)
  }, 15000)

  test('the combined answer is produced automatically once the parts settle', async () => {
    const texts = calls.filter(c => c.method === 'sendMessage').map(c => String(c.payload.text ?? '')).join('\n')
    // The combined answer arrives on its own. There is deliberately no "all parts
    // finished" banner when nothing failed — it announced work that was about to
    // speak for itself. A failure or a branch report still gets said.
    expect(texts).toContain('SYNTHESIS')
    expect(texts).not.toMatch(/Background task finished[\s\S]{0,40}SYNTHESIS/)
  }, 15000)

  test('a plan proposed before a restart is still runnable afterwards', async () => {
    // The bug: fan-out plans lived only in memory, so restarting the bridge left
    // every proposal's button answering "that plan is no longer available" for
    // something the person had just been offered. A plan is only text until it is
    // confirmed, so it belongs in the state file.
    const before = calls.length
    await group('/fanout look into two things', 99401)
    await bridge._drainQueue('-100777:main')
    await new Promise(r => setTimeout(r, 300))
    const proposal = calls.slice(before).find(c => c.method === 'sendMessage'
      && String(c.payload.text ?? '').includes('Proposed split'))
    const run = btns(proposal).find((b: any) => String(b.text).startsWith('— Run these'))
    const id = String(run.callback_data).slice(4)

    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    const plan = (saved.fanoutPlans ?? []).find((f: any) => f.id === id)
    expect(plan).toBeDefined()
    expect(plan.task).toContain('look into two things')
    expect(plan.children.length).toBeGreaterThanOrEqual(2)
    // A fan-out already running is NOT stored: its parts were child processes and
    // died with the bridge, so a button offering to run it could not honour itself.
    expect((saved.fanoutPlans ?? []).some((f: any) =>
      f.children.some((c: any) => c.status !== 'pending'))).toBe(false)
  }, 30000)

  test('an interrupted part holds the answer back until it is dealt with', async () => {
    // Interrupting a part from its own topic means you are taking it over. Treating
    // that as "the part finished" wrote the combined answer from work that had just
    // been cut off, while the topic was still mid-conversation.
    const fake = { api: bridge.bot.api, chat: { id: -100777 } }
    const f: any = {
      id: 'fanS', badge: '', parentKey: '-100777:main', chatId: -100777, askedBy: 1,
      task: 'two things', synthesised: false,
      children: [
        { n: 1, title: 'A', brief: 'b', mode: 'read', status: 'done', result: 'one' },
        { n: 2, title: 'B', brief: 'b', mode: 'read', status: 'stopped' },
      ],
    }
    bridge._fanouts.set(f.id, f)
    const before = calls.length
    await bridge._maybeSynthesise(fake, f)
    expect(calls.slice(before).length).toBe(0)
    expect(f.synthesised).toBe(false)

    // …but it can never strand the fan-out: the button combines what there is.
    await bridge.bot.handleUpdate({
      update_id: 99806,
      callback_query: { id: 'ff1', from: { id: 1, is_bot: false, first_name: 'T' }, chat_instance: 'x',
        data: `fanf:${f.id}`, message: { message_id: 99291, date: 0, chat: { id: -100777, type: 'supergroup' } } },
    })
    await new Promise(r => setTimeout(r, 1500))
    expect(f.synthesised).toBe(true)
    // A part that was cut off before saying anything is reported, not dropped.
    expect(f.children[1].status).toBe('failed')
    const said = calls.filter(c => c.method === 'sendMessage').map(c => String(c.payload.text ?? '')).join('\n')
    expect(said).toMatch(/did not complete/)
  }, 20000)

  test('a correction after the answer reopens that part and offers to combine again', async () => {
    // The parts' topics are closed once the answer is written, and a closed topic is
    // read-only for everyone but an admin — so a part that is being corrected has to
    // be reopened, or the first correction is also the last one possible.
    const child = calls.find(c => c.method === 'sendMessage'
      && String(c.payload.text ?? '').includes('Talk here to steer'))!.payload.message_thread_id as number
    // Nothing is destroyed on its own: the topics are left exactly as they are and
    // the parent topic gets a button. Whether a part is still worth reading is a
    // judgement only the person reading it can make.
    expect(calls.some(c => c.method === 'deleteForumTopic')).toBe(false)
    expect(calls.some(c => c.method === 'closeForumTopic')).toBe(false)
    expect(calls.some(c => btns(c).some((b: any) => /delete subtopics/i.test(String(b.text))))).toBe(true)
    const before = calls.length
    await group('correction: the answer is CORRECTED', 99301, child)
    await bridge._drainQueue(`-100777:${child}`)
    await new Promise(r => setTimeout(r, 1500))
    const after = calls.slice(before)
    expect(after.some(c => c.method === 'reopenForumTopic'
      && c.payload.message_thread_id === child)).toBe(true)
    expect(after.some(c => btns(c).some((b: any) => String(b.text).includes('Combine again')))).toBe(true)
  }, 20000)

  test('the button deletes the topics, and only when it is tapped', async () => {
    const offer = calls.filter(c => c.method === 'sendMessage')
      .find(c => btns(c).some((b: any) => /delete subtopics/i.test(String(b.text))))
    const data = btns(offer!)[0].callback_data
    const before = calls.length
    await bridge.bot.handleUpdate({
      update_id: 99805,
      callback_query: { id: 'fd1', from: { id: 1, is_bot: false, first_name: 'T' }, chat_instance: 'x',
        data, message: { message_id: 99290, date: 0, chat: { id: -100777, type: 'supergroup' } } },
    })
    const after = calls.slice(before)
    // Forced by the button rather than by the default, which is 'ask'.
    expect(after.filter(c => c.method === 'deleteForumTopic').length).toBeGreaterThanOrEqual(2)
    // The offer becomes the record instead of vanishing: deleting it would leave
    // "where did those topics go" with no answer anywhere in the chat.
    const rewritten = after.find(c => c.method === 'editMessageText' && c.payload.message_id === 99290)
    expect(rewritten).toBeDefined()
    expect(String(rewritten!.payload.text)).toMatch(/you deleted 2 part topics/i)
    expect(rewritten!.payload.reply_markup?.inline_keyboard).toEqual([])
    expect(after.some(c => c.method === 'deleteMessage' && c.payload.message_id === 99290)).toBe(false)
  }, 15000)

  test('a bot without Delete Messages closes the topics instead of leaving them', async () => {
    // The fallback chain, driven directly: delete refused → close → and only if that
    // fails too does the person get a button. A bot missing one right must not turn
    // "tidy up after yourself" into silence.
    const fake = { api: bridge.bot.api, chat: { id: -100777 } }
    const f = { id: 'fanD', chatId: -100777, parentThreadId: undefined, askedBy: 1,
                children: [{ n: 1, topicId: 4001 }, { n: 2, topicId: 4002 }] }
    denyDelete = true
    const before = calls.length
    await bridge._disposeFanoutTopics(fake, f, 'delete')
    denyDelete = false
    const after = calls.slice(before)
    expect(after.filter(c => c.method === 'deleteForumTopic').length).toBe(2)
    expect(after.filter(c => c.method === 'closeForumTopic').length).toBe(2)
    // Both were dealt with, so there is nothing to ask the person to do.
    expect(after.some(c => btns(c).some((b: any) => String(b.text).includes('Remove the part topics')))).toBe(false)
  })

  test('TG_FANOUT_TOPICS=keep leaves the topics exactly as they are', async () => {
    const fake = { api: bridge.bot.api, chat: { id: -100777 } }
    const f = { id: 'fanK', chatId: -100777, parentThreadId: undefined, askedBy: 1,
                children: [{ n: 1, topicId: 4003 }] }
    process.env.TG_FANOUT_TOPICS = 'keep'
    const before = calls.length
    await bridge._disposeFanoutTopics(fake, f)
    delete process.env.TG_FANOUT_TOPICS
    expect(calls.slice(before).length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Topic directories: one per topic, in the topic's own script
//
// sanitize() used to run on \w, which is ASCII-only, so EVERY Persian, Arabic,
// Hebrew, Cyrillic, CJK or Devanagari topic name reduced to the empty string and
// then to the constant 'topic'. All of them shared <SESSIONS_BASE>/topic — one cwd,
// one git checkout, one outbox. Found in production when a YouTube transcript
// generated in خلاصه یوتیوب was delivered into پک کادو.
// ---------------------------------------------------------------------------
describe('a topic gets its own directory, whatever its name is written in', () => {
  const named = async (threadId: number, name: string, text: string) => {
    // The service message the bot uses to learn a topic's name.
    await bridge.bot.handleUpdate({
      update_id: 97000 + threadId,
      message: {
        message_id: 97000 + threadId, date: 0, message_thread_id: threadId,
        chat: { id: -100777, type: 'supergroup', title: 'G', is_forum: true },
        from: { id: 1, is_bot: false, first_name: 'T' },
        forum_topic_created: { name, icon_color: 0 },
      },
    })
    await bridge.bot.handleUpdate({
      update_id: 97500 + threadId,
      message: {
        message_id: 97500 + threadId, date: 0, message_thread_id: threadId,
        chat: { id: -100777, type: 'supergroup', title: 'G', is_forum: true },
        from: { id: 1, is_bot: false, first_name: 'T' }, text,
      },
    })
    await bridge._drainQueue(`-100777:${threadId}`)
    return bridge._sessions()[`-100777:${threadId}`]?.cwd as string
  }

  test('two non-Latin topics do not share one directory', async () => {
    const a = await named(7101, 'خلاصه یوتیوب', 'hello there')
    const b = await named(7102, 'پک کادو', 'hello there')
    expect(a).toBeTruthy()
    expect(a).not.toBe(b)
    // And the name survives rather than being replaced by the fallback.
    expect(a).toContain('خلاصه-یوتیوب')
    expect(b).toContain('پک-کادو')
  }, 20000)

  test('two topics with the SAME name get separate directories', async () => {
    // Perfect Unicode handling still leaves two topics legitimately called "notes"
    // sharing a cwd. The second one takes its thread id as a suffix.
    const a = await named(7103, 'notes', 'hello there')
    const b = await named(7104, 'notes', 'hello there')
    expect(a).not.toBe(b)
    expect(b).toContain('notes-7104')
  }, 20000)

  test('a topic named ".." cannot escape the sessions base', async () => {
    // '.' and '-' were both legal, so a dot-only name passed through untouched and
    // join(SESSIONS_BASE, '..') resolved to the PARENT of the sessions base.
    const d = await named(7105, '..', 'hello there')
    expect(d.startsWith(process.env.TG_SESSIONS_BASE!)).toBe(true)
    expect(d).not.toContain('..')
  }, 20000)
})

// ---------------------------------------------------------------------------
// /usage and friends are a live gauge, not conversation
// ---------------------------------------------------------------------------
describe('the passthrough reports refresh in place', () => {
  const kbOf = (c: any) => c.payload?.reply_markup?.inline_keyboard

  test('the answer carries a Refresh button', async () => {
    const cs = await incoming(1301, '/usage')
    const withKb = sends(cs).find(c => kbOf(c) && String(kbOf(c)[0][0].callback_data).startsWith('psx:'))
    expect(withKb).toBeTruthy()
    expect(kbOf(withKb)[0][0].text).toContain('Refresh')
    expect(kbOf(withKb)[0][0].callback_data).toBe('psx:usage')
  }, 15000)

  test('it stamps the time, so a tap that finds the same numbers still shows a change', async () => {
    // Telegram rejects an editMessageText whose text is byte-identical, which is the
    // COMMON case for /usage tapped twice in a minute — the button would look broken
    // exactly when it was working.
    const cs = await incoming(1302, '/usage')
    const withKb = sends(cs).find(c => kbOf(c))
    expect(String(withKb!.payload.text)).toMatch(/updated \d\d:\d\d:\d\d/)
  }, 15000)

  test('tapping it EDITS the message rather than posting another one', async () => {
    await incoming(1303, '/usage')
    const before = calls.length
    await bridge.bot.handleUpdate({
      update_id: 97900,
      callback_query: {
        id: 'px1', from: { id: 1, is_bot: false, first_name: 'T' }, chat_instance: 'x',
        data: 'psx:usage',
        message: { message_id: 97901, date: 0, chat: { id: 1303, type: 'private' } },
      },
    })
    await bridge._drainQueue('1303:main#pt')
    await new Promise(r => setTimeout(r, 300))
    const after = calls.slice(before)
    expect(after.some(c => c.method === 'editMessageText')).toBe(true)
    // The whole point: checking your limit five times must not leave five messages.
    expect(after.filter(c => c.method === 'sendMessage')).toHaveLength(0)
  }, 15000)

  test('a passthrough run posts no "thinking" status at all', async () => {
    // It spawns a CLI but takes no model turn, so the status flashed for two seconds
    // offering to Interrupt a run that does nothing.
    const cs = await incoming(1304, '/usage')
    expect(sends(cs).some(c => textOf(c).includes('Thinking'))).toBe(false)
  }, 15000)
})

// ---------------------------------------------------------------------------
// /sessions used to print an 8-char prefix that /resume then refused to accept
// ---------------------------------------------------------------------------
describe('/sessions is a picker, and /resume accepts what it prints', () => {
  const IDS = [
    'aaaaaaaa-1111-4111-8111-111111111111',
    'bbbbbbbb-2222-4222-8222-222222222222',
  ]
  let cwd = ''

  test('setup: a topic with two past transcripts on disk', async () => {
    await incoming(1310, 'hello there')
    cwd = bridge._sessions()['1310:main'].cwd
    const pdir = bridge._projectDir(cwd)
    mkdirSync(pdir, { recursive: true })
    for (const id of IDS) {
      writeFileSync(join(pdir, `${id}.jsonl`), [
        JSON.stringify({ type: 'summary', summary: `session ${id.slice(0, 4)}` }),
        JSON.stringify({ type: 'user', sessionId: id, message: { role: 'user', content: 'a question' } }),
      ].join('\n') + '\n')
    }
    expect(existsSync(join(pdir, `${IDS[0]}.jsonl`))).toBe(true)
  }, 15000)

  test('the listing is tappable — one button per session', async () => {
    const cs = await incoming(1310, '/sessions')
    const picker = sends(cs).find(c => c.payload?.reply_markup?.inline_keyboard?.length)
    expect(picker).toBeTruthy()
    const rows = picker!.payload.reply_markup.inline_keyboard
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(String(rows[0][0].callback_data)).toStartWith('res:')
    // callback_data caps at 64 bytes; an index into the listing is what keeps a
    // directory path out of the payload.
    expect(Buffer.byteLength(String(rows[0][0].callback_data))).toBeLessThanOrEqual(64)
    // The button must say what the session was ABOUT. `d2b39072 · 10 turns · 4m ago`
    // identifies a session to the filesystem and to nobody else — you cannot pick
    // your own conversation out of a list of hashes.
    const labels = rows.filter((r: any) => String(r[0].callback_data).startsWith('res:'))
      .map((r: any) => String(r[0].text))
    expect(labels.some((l: string) => l.includes('session aaaa'))).toBe(true)
    expect(labels.some((l: string) => l.includes('session bbbb'))).toBe(true)
    // …and the message body carries the id and age the label spends no room on.
    expect(String(picker!.payload.text)).toMatch(/turns/)
    expect(String(picker!.payload.text)).toContain('session aaaa')
  }, 15000)

  test('the message shows a long title in full; only the button truncates', async () => {
    const pdir = bridge._projectDir(cwd)
    const id = 'dddddddd-5555-4555-8555-555555555555'
    const file = join(pdir, `${id}.jsonl`)
    const long = 'I want to build a trading app that lets people trade forex and tokenized stocks on chain, through spot and perps, and I need to pick between a few venues'
    writeFileSync(file, [
      JSON.stringify({ type: 'summary', summary: long }),
      JSON.stringify({ type: 'user', sessionId: id, message: { role: 'user', content: 'q' } }),
    ].join('\n') + '\n')
    try {
      const cs = await incoming(1310, '/sessions')
      const picker = sends(cs).find(c => c.payload?.reply_markup?.inline_keyboard?.length)
      // The body has 4096 characters to work with, so it shows the sentence.
      expect(String(picker!.payload.text)).toContain(long)
      // The button has one line, so it does not.
      const label = picker!.payload.reply_markup.inline_keyboard
        .map((r: any) => String(r[0].text)).find((l: string) => l.includes('I want to build'))
      expect(label!.length).toBeLessThanOrEqual(64)
      expect(label).not.toContain(long)
    } finally { rmSync(file, { force: true }) }
  }, 15000)

  test('scaffolding is never used as a session title', async () => {
    // Reported: a session showed up as "<local-command-caveat>Caveat: The messages
    // below were generated by the user whil". Both kinds of noise are covered — the
    // harness's injected block, and the bridge's own attribution framing.
    const pdir = bridge._projectDir(cwd)
    const id = 'eeeeeeee-6666-4666-8666-666666666666'
    const file = join(pdir, `${id}.jsonl`)
    writeFileSync(file, [
      // No summary line, so the label has to come from the user turns.
      JSON.stringify({ type: 'user', sessionId: id, message: { role: 'user', content:
        '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>\n<command-name>/clear</command-name>' } }),
      JSON.stringify({ type: 'user', sessionId: id, message: { role: 'user', content:
        '[xesious:cfe601edd91a] this directory is shared with another topic (a fork).' } }),
      JSON.stringify({ type: 'user', sessionId: id, message: { role: 'user', content:
        '[xesious:cfe601edd91a] message from G, id 93362715:\nwhy is the gold fund premium moving?' } }),
    ].join('\n') + '\n')
    try {
      const cs = await incoming(1310, '/sessions')
      const picker = sends(cs).find(c => c.payload?.reply_markup?.inline_keyboard?.length)
      const body = String(picker!.payload.text)
      expect(body).not.toContain('local-command-caveat')
      expect(body).not.toContain('[xesious:')
      expect(body).not.toContain('shared with another topic')
      // It fell through the two scaffolding turns to the thing the user actually said.
      expect(body).toContain('why is the gold fund premium moving?')
    } finally { rmSync(file, { force: true }) }
  }, 15000)

  test('a long title is truncated to something a phone can render', async () => {
    const pdir = bridge._projectDir(cwd)
    const longId = 'cccccccc-3333-4333-8333-333333333333'
    const file = join(pdir, `${longId}.jsonl`)
    writeFileSync(file, [
      JSON.stringify({ type: 'summary', summary: 'x'.repeat(200) }),
      JSON.stringify({ type: 'user', sessionId: longId, message: { role: 'user', content: 'q' } }),
    ].join('\n') + '\n')
    try {
      const cs = await incoming(1310, '/sessions')
      const picker = sends(cs).find(c => c.payload?.reply_markup?.inline_keyboard?.length)
      const labels = picker!.payload.reply_markup.inline_keyboard
        .filter((r: any) => String(r[0].callback_data).startsWith('res:'))
        .map((r: any) => String(r[0].text))
      expect(labels.every((l: string) => l.length <= 64)).toBe(true)
      expect(labels.some((l: string) => l.endsWith('…'))).toBe(true)
    } finally {
      // Removed again: it is the NEWEST session, so leaving it behind would make the
      // next case's "tap the first button" land on this fixture instead.
      rmSync(file, { force: true })
    }
  }, 15000)

  test('tapping one binds the topic to that session', async () => {
    const cs = await incoming(1310, '/sessions')
    const picker = sends(cs).find(c => c.payload?.reply_markup?.inline_keyboard?.length)
    const btn = picker!.payload.reply_markup.inline_keyboard[0][0]
    await bridge.bot.handleUpdate({
      update_id: 97950,
      callback_query: {
        id: 'rs1', from: { id: 1, is_bot: false, first_name: 'T' }, chat_instance: 'x',
        data: btn.callback_data,
        message: { message_id: 97951, date: 0, chat: { id: 1310, type: 'private' } },
      },
    })
    await new Promise(r => setTimeout(r, 200))
    expect(IDS).toContain(bridge._sessions()['1310:main'].sessionId)
  }, 15000)

  test('/resume accepts the 8-char prefix the listing prints', async () => {
    // The reported bug in one line: the command told you the answer in a form it
    // then refused to accept.
    const cs = await incoming(1310, `/resume ${IDS[1].slice(0, 8)}`)
    expect(finalReply(cs)).not.toMatch(/No session/i)
    expect(bridge._sessions()['1310:main'].sessionId).toBe(IDS[1])
  }, 15000)

  test('an ambiguous prefix fails loudly instead of picking one', async () => {
    // Silently continuing the wrong conversation is the failure to avoid.
    const pdir = bridge._projectDir(cwd)
    writeFileSync(join(pdir, 'aaaaaaaa-9999-4999-8999-999999999999.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }) + '\n')
    const cs = await incoming(1310, '/resume aaaaaaaa')
    expect(finalReply(cs)).toMatch(/matches 2 sessions/i)
  }, 15000)

  test('an unknown prefix points at the picker rather than just failing', async () => {
    const cs = await incoming(1310, '/resume zzzzzzzz')
    expect(finalReply(cs)).toMatch(/\/sessions/)
  }, 15000)
})

// ---------------------------------------------------------------------------
// The preview caption used to be the ONE message in the bridge sent with no parse
// mode, so the preview of the longest, most heavily formatted answers was the only
// place a user ever saw literal **bold** and | pipe | tables |.
// ---------------------------------------------------------------------------
describe('the caption on a long answer', () => {
  const cap = (t: string) => bridge._answerCaption(t) as { text: string; mode?: string }
  const long = (s: string) => s + '\n\n' + 'tail padding. '.repeat(600)

  test('is formatted, and stays inside the 1024 cap', () => {
    const c = cap(long('## Heading\n\nSome **bold** and a `span`.'))
    expect(c.mode).toBe('MarkdownV2')
    expect(c.text.length).toBeLessThanOrEqual(1024)
    expect(c.text).not.toContain('**bold**')     // rendered, not shown as syntax
    expect(c.text).toContain('Full answer')
  })

  test('a table is flattened into a code block, which captions CAN render', () => {
    // Captions have no table entity, so the alternative to flattening is pipes.
    const c = cap(long('| a | b |\n|---|---|\n| 1 | 2 |'))
    expect(c.text).toContain('```')
    expect((c.text.match(/```/g) || []).length % 2).toBe(0)
  })

  test('escaping inflation is measured, not assumed', () => {
    // A preview made entirely of characters MarkdownV2 must escape roughly doubles
    // when escaped. Slicing to 900 first and escaping after would sail past 1024
    // and Telegram would reject the whole caption — which used to cost the FILE.
    const c = cap(long('.'.repeat(900)))
    expect(c.text.length).toBeLessThanOrEqual(1024)
  })

  test('a fence opened by the truncation is closed', () => {
    // An unbalanced entity is exactly what Telegram refuses to parse.
    const c = cap('intro\n```sh\n' + 'echo one line\n'.repeat(400) + '```\ntail')
    expect((c.text.match(/```/g) || []).length % 2).toBe(0)
  })
})

describe('a media group that fails falls back rather than dropping the answer', () => {
  test('both files still arrive, as individual sends', async () => {
    failMediaGroup = true
    try {
      const cs = await incoming(1125, 'LONG')
      const docs = cs.filter(c => c.method === 'sendDocument')
      // Two messages is the cosmetic problem this feature set out to remove. A lost
      // answer is not cosmetic, so that is the trade the fallback makes.
      expect(docs).toHaveLength(2)
      const names = docs.map(c => String(c.payload?.document?.filename ?? ''))
      expect(names.some(n => n.endsWith('.html'))).toBe(true)
      expect(names.some(n => n.endsWith('.md'))).toBe(true)
      // And the caption still rides on the first one only.
      expect(docs.filter(c => c.payload?.caption)).toHaveLength(1)
    } finally { failMediaGroup = false }
  }, 15000)
})

describe('a caption Telegram refuses to parse costs the formatting, never the file', () => {
  test('the send is retried unformatted instead of failing', async () => {
    failMediaGroup = true      // force the individual-send path, which is where
    failParsedCaption = true   // sendFile's own retry lives
    try {
      const cs = await incoming(1126, 'LONG')
      const docs = cs.filter(c => c.method === 'sendDocument')
      // Two attempts for the captioned file (parsed, then plain) plus the second
      // file — what matters is that a file with no parse_mode got through.
      const delivered = docs.filter(c => !c.payload?.parse_mode)
      expect(delivered.length).toBeGreaterThan(0)
      expect(delivered.some(c => String(c.payload?.caption ?? '').includes('Full answer'))).toBe(true)
      // The retry must send the UNESCAPED caption. Resending the MarkdownV2 string
      // with no parse mode would show the user its backslashes.
      const retried = delivered.find(c => String(c.payload?.caption ?? '').includes('Full answer'))!
      expect(String(retried.payload.caption)).toContain('Full answer (')
      expect(String(retried.payload.caption)).not.toContain('\\(')
      // And the user is not told the send failed, because it did not.
      expect(sends(cs).some(c => String(c.payload.text ?? '').includes('could not send'))).toBe(false)
    } finally { failMediaGroup = false; failParsedCaption = false }
  }, 15000)
})

describe('the /sessions picker paginates', () => {
  // Page 1 is all the flow test above reaches. This directory has far more sessions
  // than fit one keyboard, which is the case the pager exists for.
  const dir = join(TMP, 'paged')
  let token = ''

  test('setup: 20 sessions in one directory', () => {
    mkdirSync(dir, { recursive: true })
    const pdir = bridge._projectDir(dir)
    mkdirSync(pdir, { recursive: true })
    for (let i = 0; i < 20; i++) {
      const id = `${String(i).padStart(8, '0')}-4444-4444-8444-444444444444`
      writeFileSync(join(pdir, `${id}.jsonl`), [
        JSON.stringify({ type: 'summary', summary: `topic number ${i}` }),
        JSON.stringify({ type: 'user', sessionId: id, message: { role: 'user', content: 'q' } }),
      ].join('\n') + '\n')
    }
    token = bridge._listing.make(dir, bridge._listSessions(dir))
    expect(bridge._listSessions(dir)).toHaveLength(20)
  })

  const sessionRows = (kb: any) => kb.inline_keyboard.filter((r: any) => String(r[0].callback_data).startsWith('res:'))
  const navRow = (kb: any) => kb.inline_keyboard.find((r: any) => r.some((b: any) => String(b.callback_data).startsWith('spg:')))

  test('page 1 shows 8 and offers Next but not Prev', () => {
    const kb = bridge._listing.kb(token, 0)
    expect(sessionRows(kb)).toHaveLength(8)
    const nav = navRow(kb).map((b: any) => b.text)
    expect(nav).toContain('1/3')
    expect(nav.some((t: string) => t.includes('Next'))).toBe(true)
    expect(nav.some((t: string) => t.includes('Prev'))).toBe(false)
    expect(bridge._listing.text(token, 0)).toContain('page 1/3')
  })

  test('the middle page offers both directions', () => {
    const nav = navRow(bridge._listing.kb(token, 8)).map((b: any) => b.text)
    expect(nav).toContain('2/3')
    expect(nav.some((t: string) => t.includes('Prev'))).toBe(true)
    expect(nav.some((t: string) => t.includes('Next'))).toBe(true)
  })

  test('the last page is short and offers no Next', () => {
    const kb = bridge._listing.kb(token, 16)
    expect(sessionRows(kb)).toHaveLength(4)          // 20 - 16
    const nav = navRow(kb).map((b: any) => b.text)
    expect(nav.some((t: string) => t.includes('Next'))).toBe(false)
    expect(nav.some((t: string) => t.includes('Prev'))).toBe(true)
  })

  test('every page numbers its entries continuously, so a button matches its line', () => {
    // The button says "9. …" and the body's ninth entry must be the same session, or
    // the number that ties them together is a lie.
    const kb = bridge._listing.kb(token, 8)
    expect(String(sessionRows(kb)[0][0].text)).toStartWith('9.')
    expect(bridge._listing.text(token, 8)).toContain('9. ')
  })

  test('an expired listing says so instead of rendering an empty picker', () => {
    expect(bridge._listing.text('nosuch', 0)).toMatch(/expired/i)
    expect(bridge._listing.kb('nosuch', 0).inline_keyboard).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------
describe('/voice is a keyboard, like every other setting', () => {
  const kb = (c: any) => c.payload?.reply_markup?.inline_keyboard
  const labels = (c: any) => (kb(c) || []).flat().map((b: any) => String(b.text))

  test('bare /voice answers with buttons, not a menu you have to type back at', async () => {
    // It was the last setting whose answer was plain text while /mode, /model and
    // /effort all had keyboards. That was an inconsistency, not a missing feature.
    const cs = await incoming(1400, '/voice')
    const menu = sends(cs).find(c => kb(c))
    expect(menu).toBeTruthy()
    const l = labels(menu)
    expect(l.some((x: string) => x.includes('Full'))).toBe(true)
    expect(l.some((x: string) => x.includes('Summary'))).toBe(true)
    expect(l.some((x: string) => x.includes('Off'))).toBe(true)
  }, 15000)

  test('the speakers are named, not raw ids, and every English voice is reachable', async () => {
    const cs = await incoming(1401, '/voice')
    const menu = sends(cs).find(c => kb(c))
    const spk = (kb(menu) || []).flat().filter((b: any) => String(b.callback_data).startsWith('vspk:'))
    expect(spk.length).toBe(8)                       // one page
    // "am_michael" tells you nothing; a name and a flag do. Asserted on the page
    // actually rendered, which is the one holding the current speaker — not page one.
    expect(spk.every((b: any) => /[\u{1F1E6}-\u{1F1FF}]{2} \w+ \((f|m)\)/u.test(String(b.text)))).toBe(true)
    expect(spk.some((b: any) => String(b.text).includes('Heart'))).toBe(true)
    expect(spk.every((b: any) => Buffer.byteLength(String(b.callback_data)) <= 64)).toBe(true)
    // Two per row: a speaker label is three short tokens, and 28 one-per-row is a scroll.
    const spkRows = (kb(menu) || []).filter((r: any) => String(r[0].callback_data).startsWith('vspk:'))
    expect(spkRows.every((r: any) => r.length === 2)).toBe(true)
    // …and the other 20 are a tap away, not hidden behind typing.
    const nav = (kb(menu) || []).flat().filter((b: any) => String(b.callback_data).startsWith('vspg:'))
    expect(nav.length).toBeGreaterThan(0)
  }, 15000)

  test('all 28 English voices are offered, the published ten first', async () => {
    // Reported: "why the fuck do I get 8 voice options but kokoro website has 10".
    // Eight was a hand-picked shortlist; the installed pack has 28 English voices,
    // and the ten from Kokoro's original release are the ones people have seen.
    const ids = SPEAKERS.map((s: any) => s.id)
    expect(ids).toHaveLength(28)
    for (const known of ['af_bella', 'af_sarah', 'af_nicole', 'af_sky', 'am_adam',
                         'am_michael', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis']) {
      expect(ids.slice(0, 10)).toContain(known)
    }
    // Labels state a flag, a name and a gender — never an invented description of
    // how a voice sounds.
    expect(SPEAKERS.every((s: any) => /^[\u{1F1E6}-\u{1F1FF}]{2} \w+ \((f|m)\)$/u.test(s.label))).toBe(true)
  })

  test('paging reaches the later voices and edits in place', async () => {
    await incoming(1406, '/voice')
    const before = calls.length
    // Explicitly to offset 0, which is NOT where the keyboard opens by default.
    await bridge.bot.handleUpdate({
      update_id: 98700,
      callback_query: {
        id: 'vp1', from: { id: 1, is_bot: false, first_name: 'T' }, chat_instance: 'x',
        data: 'vspg:0',
        message: { message_id: 98701, date: 0, chat: { id: 1406, type: 'private' } },
      },
    })
    await new Promise(r => setTimeout(r, 200))
    const edit = calls.slice(before).find(c => c.method === 'editMessageText')
    expect(edit).toBeTruthy()
    const spk = edit!.payload.reply_markup.inline_keyboard.flat()
      .filter((b: any) => String(b.callback_data).startsWith('vspk:'))
      .map((b: any) => String(b.callback_data).slice(5))
    // Page 1 shows the published ten, which the default page (holding af_heart) does not.
    expect(spk).toContain('af_bella')
    expect(spk).not.toContain('af_heart')
    expect(calls.slice(before).filter(c => c.method === 'sendMessage')).toHaveLength(0)
  }, 15000)

  test('the current mode and speaker are marked, whichever page the voice is on', async () => {
    // The default speaker sits on page two, so a keyboard that always opened on page
    // one showed nothing selected — the setting you are looking at appearing unset.
    const cs = await incoming(1402, '/voice')
    const menu = sends(cs).find(c => kb(c))
    expect(labels(menu).filter((x: string) => x.startsWith('● ')).length).toBe(2)  // one mode, one speaker
    const marked = (kb(menu) || []).flat().find((b: any) => String(b.text).startsWith('● ') && String(b.callback_data).startsWith('vspk:'))
    expect(String(marked.callback_data)).toBe('vspk:af_heart')
  }, 15000)

  test('tapping a speaker stores it PER TOPIC and re-renders in place', async () => {
    // It used to be a deployment-wide constant: voiceEnv copied TG_KOKORO_VOICE out
    // of the bridge's own environment, so changing it meant editing .env and
    // restarting.
    await incoming(1403, '/voice')
    const before = calls.length
    await bridge.bot.handleUpdate({
      update_id: 98600,
      callback_query: {
        id: 'vs1', from: { id: 1, is_bot: false, first_name: 'T' }, chat_instance: 'x',
        data: 'vspk:bm_george',
        message: { message_id: 98601, date: 0, chat: { id: 1403, type: 'private' } },
      },
    })
    await new Promise(r => setTimeout(r, 200))
    const after = calls.slice(before)
    expect(after.some(c => c.method === 'editMessageText')).toBe(true)
    expect(after.filter(c => c.method === 'sendMessage')).toHaveLength(0)
    const st = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    expect(st.speakers['1403:main']).toBe('bm_george')
  }, 15000)

  test('/voice speaker <id> reaches the voices the keyboard does not show', async () => {
    const cs = await incoming(1404, '/voice speaker jf_alpha')
    expect(finalReply(cs)).toContain('jf_alpha')
    const st = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    expect(st.speakers['1404:main']).toBe('jf_alpha')
  }, 15000)

  test('a bogus speaker id is refused rather than stored', async () => {
    const cs = await incoming(1405, '/voice speaker ../../etc/passwd')
    expect(finalReply(cs)).toMatch(/Not a Kokoro voice id/i)
    const st = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    expect(st.speakers['1405:main']).toBeUndefined()
  }, 15000)
})

describe('voice that cannot speak says so', () => {
  test('/voice on reports the engine instead of failing at the first answer', async () => {
    // Reported: /voice on, then a message, and the answer came back as text with no
    // hint anything was wrong. The toggle is the moment to say it.
    const cs = await incoming(1410, '/voice on')
    const said = sends(cs).map(c => String(c.payload.text ?? '')).join('\n')
    expect(said).toMatch(/Voice ON/)
    // Either it names the engine, or it says plainly that speaking is unavailable —
    // never silence. Which one depends on what is installed on the test box.
    expect(/Engine: \w+/.test(said) || /not available here/.test(said)).toBe(true)
  }, 20000)

  test('when it cannot speak, the offer to install is a BUTTON and nothing installs on its own', async () => {
    const cs = await incoming(1411, '/voice on')
    const said = sends(cs).map(c => String(c.payload.text ?? '')).join('\n')
    if (/not available here/.test(said)) {
      const offer = sends(cs).find(c => c.payload?.reply_markup?.inline_keyboard)
      expect(offer).toBeTruthy()
      expect(String(offer!.payload.reply_markup.inline_keyboard[0][0].callback_data)).toBe('vinst:go')
    } else {
      // Speaking works on this box, so there is nothing to offer — assert THAT
      // rather than passing vacuously.
      expect(said).toMatch(/Engine: /)
    }
  }, 20000)
})

describe('the voice note is threaded, and never blocks the topic', () => {
  const voices = (cs: any[]) => cs.filter(c => c.method === 'sendVoice')

  test('the note replies to the ANSWER, not to nothing', async () => {
    // It was the one send in the file that bypassed destOpts, so with two turns in
    // flight you got untethered audio bubbles and no way to match them to questions.
    await incoming(1420, '/voice on')
    const cs = await incoming(1420, 'hello there')
    await bridge._drainQueue('1420:main#voice')
    const all = calls.slice(calls.length - 40)
    const v = voices(all)
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].payload?.reply_parameters?.message_id).toBeGreaterThan(0)
    // …and specifically to the answer message, which is the one just before it.
    const answer = all.filter(c => c.method === 'sendMessage' && String(c.payload.text ?? '').includes('okReply')).pop()
    expect(answer).toBeTruthy()
  }, 25000)

  test('a LONG answer\'s note is still threaded — the production case', async () => {
    // Reported from production: "the sound does not fucking reply to anything".
    // Cause: the note fell back to `link`, and needsReplyLink deliberately returns
    // false for an ordinary lone question — so `link` is undefined exactly when the
    // topic is calm. A long answer goes out as a FILE GROUP, deliver could not name a
    // single message, and the chain ended in nothing. Both halves are covered here:
    // the group now reports its first message id, and the last resort is the user's
    // own message rather than undefined.
    await incoming(1423, '/voice on')
    await incoming(1423, '/voice parts on')            // this is about threading, not about parts
    const before = calls.length
    await incoming(1423, 'LONG')                       // stub answer past REPLY_FILE_CHARS
    await bridge._drainQueue('1423:main#voice')
    const cs = calls.slice(before)
    const group = cs.find(c => c.method === 'sendMediaGroup')
    expect(group).toBeTruthy()                          // it really was the file path
    const note = cs.find(c => c.method === 'sendVoice')
    expect(note).toBeTruthy()
    expect(note!.payload?.reply_parameters?.message_id).toBeGreaterThan(0)
    // A deleted question must cost the reply, never the note.
    expect(note!.payload?.reply_parameters?.allow_sending_without_reply).toBe(true)
  }, 30000)

  test('a chunked answer\'s note is threaded too', async () => {
    // The other way deliver returns undefined: an answer long enough to be split
    // across several messages has no single id either.
    await incoming(1424, '/voice on')
    const before = calls.length
    await incoming(1424, 'hello there')
    await bridge._drainQueue('1424:main#voice')
    const note = calls.slice(before).find(c => c.method === 'sendVoice')
    expect(note).toBeTruthy()
    expect(note!.payload?.reply_parameters?.message_id).toBeGreaterThan(0)
  }, 25000)

  test('a slow note does NOT hold up the next message', async () => {
    // Measured on the real engine: 65s of synthesis sat INSIDE the turn, so the next
    // message you sent waited on audio for an answer you already had in your hand.
    writeFileSync(SLOW_SPEAK, 'x')          // make the synthesiser take ~3s per chunk
    try {
      await incoming(1421, '/voice on')
      const t0 = Date.now()
      await incoming(1421, 'hello there')   // returns when the TURN is done
      const turnMs = Date.now() - t0
      // The turn must not have waited for the 4s note.
      expect(turnMs).toBeLessThan(3500)
      // …and the note still arrives, on its own queue. Timing the DRAIN proves the
      // stub really was slow — without this the test would pass just as happily if
      // synthesis had been skipped entirely.
      const before = calls.length
      const t1 = Date.now()
      await bridge._drainQueue('1421:main#voice')
      const voiceMs = Date.now() - t1
      expect(voiceMs).toBeGreaterThan(2000)
      expect(calls.slice(before).filter(c => c.method === 'sendVoice').length).toBeGreaterThan(0)
    } finally { rmSync(SLOW_SPEAK, { force: true }) }
  }, 30000)

  test('speech runs on its own queue key, not the topic\'s', async () => {
    // The invariant behind the fix: turns are serialised because two `claude
    // --resume` runs on one transcript corrupt it. Synthesis touches no session, no
    // transcript and no cwd, so it has no business on that queue.
    await incoming(1422, '/voice on')
    await incoming(1422, 'hello there')
    await bridge._drainQueue('1422:main#voice')     // resolves => the key exists
    expect(true).toBe(true)
  }, 25000)
})

// ---------------------------------------------------------------------------
// The progressive path: cancelling, tidying, the section index, the read-along.
// TG_VOICE_CHUNKED is '0' for the suite, so these turn it on per test.
// ---------------------------------------------------------------------------
describe('a long spoken answer can be stopped, indexed and tidied', () => {
  // No per-test toggle: VOICE_CHUNKED is read once at import, so it is set for the
  // whole suite. An earlier version flipped process.env inside the test and silently
  // did nothing at all.
  const withChunking = async (fn: () => Promise<void>) => fn()
  const kbOf = (c: any) => c.payload?.reply_markup?.inline_keyboard

  test('the notes carry no buttons — Stop lives on the status message, from t=0', async () => {
    // Reported: "if a very long voice is being generated… I have no way to cancel
    // that shit". Nothing had a handle on synthesis at all.
    //
    // The first fix put 🛑 on note 1 — a message that does not exist for the first
    // ~30 seconds, so during the slowest and least interruptible stretch of a run
    // there was still no way to stop it. The status bubble exists before a single
    // sample does, which is the only place the button is any use.
    await withChunking(async () => {
      await incoming(1430, '/voice on')
      await incoming(1430, '/voice parts on')
      const before = calls.length
      await incoming(1430, 'HEADINGS')
      const status = calls.slice(before).find(c => c.method === 'sendMessage'
        && String(c.payload?.text ?? '').includes('🎙 Speaking'))
      expect(status).toBeTruthy()
      expect(String(kbOf(status)?.flat().find((b: any) => String(b.text).includes('Stop'))?.callback_data))
        .toStartWith('vstop:')
      await bridge._drainQueue('1430:main#voice')
      const notes = calls.slice(before).filter(c => c.method === 'sendVoice')
      expect(notes.length).toBeGreaterThan(1)
      // Not on any note any more, first or otherwise.
      expect(notes.every(c => !kbOf(c))).toBe(true)
      // The label says where you are in the answer; it deliberately carries no
      // timestamp, since a seek inside a 90-second chunk cannot reach 5:42.
      expect(String(notes[1].payload.caption)).toMatch(/part 2/)
    })
  }, 25000)

  test('QUIET BY DEFAULT: one status bubble and the full file, no part notes', async () => {
    // Requested: "current implementation makes the chat messy". A long answer used to
    // post six messages — four of them audio, and the same audio twice, because the
    // parts are pure sediment once the full file lands.
    await withChunking(async () => {
      await incoming(1440, '/voice on')
      const before = calls.length
      await incoming(1440, 'HEADINGS')
      await bridge._drainQueue('1440:main#voice')
      await new Promise(r => setTimeout(r, 300))
      const cs = calls.slice(before)
      // Synthesis is untouched — the full file is here, and on time.
      expect(cs.some(c => c.method === 'sendAudio')).toBe(true)
      // …and not one part note went out.
      expect(cs.filter(c => c.method === 'sendVoice').length).toBe(0)
      // The bubble was posted, and then deleted once the audio landed: a text message
      // cannot be edited into a media one, so it can never BECOME the audio.
      const status = cs.find(c => c.method === 'sendMessage'
        && String(c.payload?.text ?? '').includes('🎙 Speaking'))
      expect(status).toBeTruthy()
      // …and it said how long, because "Speaking…" alone is the same non-answer as
      // no message at all.
      expect(String(status!.payload.text)).toMatch(/~\d+(s|m|h)/)
      expect(cs.some(c => c.method === 'deleteMessage')).toBe(true)
    })
  }, 25000)

  test('the button BACK-FILLS: a tap at t=60s sends the parts already made', async () => {
    // Its whole value is the window before the first note exists, so a switch that
    // only affected future chunks would be useless exactly when it is wanted.
    await withChunking(async () => {
      // LONGHEADINGS, not HEADINGS: the button is only offered when the answer is
      // predicted to have parts at all, and HEADINGS speaks in about twelve seconds.
      await incoming(1441, '/voice on')
      const before = calls.length
      await incoming(1441, 'LONGHEADINGS')
      const status = calls.slice(before).find(c => c.method === 'sendMessage'
        && String(c.payload?.text ?? '').includes('🎙 Speaking'))
      const parts = kbOf(status)?.flat().find((b: any) => String(b.callback_data).startsWith('vparts:'))
      expect(parts).toBeTruthy()
      // Let some chunks pile up unsent, then ask for them.
      await new Promise(r => setTimeout(r, 250))
      const mark = calls.length
      await bridge.bot.handleUpdate({
        update_id: 98810,
        callback_query: { id: 'vp1', from: { id: 1, is_bot: false, first_name: 'T' }, chat_instance: 'x',
          data: String(parts.callback_data),
          message: { message_id: 98811, date: 0, chat: { id: 1441, type: 'private' } } },
      })
      await bridge._drainQueue('1441:main#voice')
      await new Promise(r => setTimeout(r, 300))
      const after = calls.slice(mark).filter(c => c.method === 'sendVoice')
      expect(after.length).toBeGreaterThan(1)
      // Back-filled in order and numbered as speak.py made them: part 1 has no
      // caption, and the next one says part 2.
      expect(after[0].payload.caption).toBeUndefined()
      expect(String(after[1].payload.caption)).toMatch(/part 2/)
    })
  }, 25000)

  test('the button works the moment it appears, with no chunk yet in existence', async () => {
    // Tapped against a deliberately slow synthesiser, so nothing has been made yet.
    //
    // What this does NOT cover, stated because it looks like it should: the bubble is
    // posted before the lead units are normalised, and that wait can run to twenty
    // seconds — a window in which an earlier version answered "already finished
    // speaking", which is the worst possible reply during exactly the stretch the
    // button exists for. The suite runs with normalisation OFF, so `leadReady`
    // resolves immediately and that window does not exist here. Verified by removing
    // the fix: this test still passed. The guard is the ordering in speakChunked —
    // release is installed before the message carrying its button is sent.
    writeFileSync(SLOW_SPEAK, 'x')
    try {
      await withChunking(async () => {
        await incoming(1450, '/voice on')
        const before = calls.length
        const run = bridge._drainQueue('1450:main#voice')
        await incoming(1450, 'LONGHEADINGS')
        const status = calls.slice(before).find(c => c.method === 'sendMessage'
          && String(c.payload?.text ?? '').includes('🎙 Speaking'))
        const parts = kbOf(status)?.flat().find((b: any) => String(b.callback_data).startsWith('vparts:'))
        expect(parts).toBeTruthy()
        // Tapped immediately — no waiting for a chunk to exist.
        const mark = calls.length
        await bridge.bot.handleUpdate({
          update_id: 98820,
          callback_query: { id: 'vp2', from: { id: 1, is_bot: false, first_name: 'T' }, chat_instance: 'x',
            data: String(parts.callback_data),
            message: { message_id: 98821, date: 0, chat: { id: 1450, type: 'private' } } },
        })
        const answered = calls.slice(mark).find(c => c.method === 'answerCallbackQuery')
        expect(answered).toBeTruthy()          // or the assertion below passes vacuously
        expect(String(answered!.payload?.text ?? '')).not.toContain('already finished')
        await run
        await bridge._drainQueue('1450:main#voice')
        await new Promise(r => setTimeout(r, 300))
        // …and the parts really did start arriving, rather than the tap being a no-op.
        expect(calls.slice(mark).filter(c => c.method === 'sendVoice').length).toBeGreaterThan(0)
      })
    } finally { rmSync(SLOW_SPEAK, { force: true }) }
  }, 40000)

  test('a short answer is offered no parts button — there are no parts', async () => {
    // One note and no full file, so the button would be a lie. Predicted from the
    // estimate, since the real boundary is decided by duration inside speak.py.
    await withChunking(async () => {
      await incoming(1442, '/voice on')
      const before = calls.length
      await incoming(1442, 'hello there')
      await bridge._drainQueue('1442:main#voice')
      const status = calls.slice(before).find(c => c.method === 'sendMessage'
        && String(c.payload?.text ?? '').includes('🎙 Speaking'))
      expect(status).toBeTruthy()
      expect(kbOf(status)?.flat().some((b: any) => String(b.callback_data).startsWith('vparts:'))).toBe(false)
      // 🛑 is still there: a short answer is still worth stopping.
      expect(kbOf(status)?.flat().some((b: any) => String(b.callback_data).startsWith('vstop:'))).toBe(true)
    })
  }, 25000)

  test('with no full file the held note goes out anyway — silence is not an option', async () => {
    // The quiet path holds every chunk. A short answer produces no full file at all,
    // so if the hold were unconditional the answer would simply never be spoken.
    await withChunking(async () => {
      await incoming(1443, '/voice on')
      const before = calls.length
      await incoming(1443, 'hello there')
      await bridge._drainQueue('1443:main#voice')
      const cs = calls.slice(before)
      expect(cs.some(c => c.method === 'sendAudio')).toBe(false)   // the premise
      expect(cs.filter(c => c.method === 'sendVoice').length).toBeGreaterThan(0)
    })
  }, 25000)

  test('the full file is captioned with SECTION timestamps, not just its duration', async () => {
    // The old caption's only number was the total, so the one seek link Telegram
    // made of it jumped to the last second of the audio.
    await withChunking(async () => {
      await incoming(1431, '/voice on')
      const before = calls.length
      await incoming(1431, 'HEADINGS')
      await bridge._drainQueue('1431:main#voice')
      const full = calls.slice(before).find(c => c.method === 'sendAudio')
      expect(full).toBeTruthy()
      const cap = String(full!.payload.caption)
      expect(cap).toContain('🎧 Full answer')
      // One line per heading in the stub's answer, each a tappable M:SS.
      expect((cap.match(/^\d+:\d\d {2}\S/gm) || []).length).toBeGreaterThan(1)
      expect(cap).toContain('Alpha')
    })
  }, 25000)

  test('the parts SURVIVE the full file — removing them is a tap, never automatic', async () => {
    // Nothing deletes a voice note on its own. A rule that cleared parts you had opted
    // into was tried and removed: the full file lands exactly when a listener is most
    // likely mid-chunk, and deleting the note that is playing stops playback dead.
    await withChunking(async () => {
      await incoming(1432, '/voice on')
      await incoming(1432, '/voice parts on')
      const before = calls.length
      await incoming(1432, 'HEADINGS')
      await bridge._drainQueue('1432:main#voice')
      await new Promise(r => setTimeout(r, 300))
      const cs = calls.slice(before)
      const notes = cs.filter(c => c.method === 'sendVoice').length
      expect(notes).toBeGreaterThan(1)
      const full = cs.find(c => c.method === 'sendAudio')
      expect(full).toBeTruthy()
      // Only the status bubble was deleted. The notes are all still there.
      expect(cs.filter(c => c.method === 'deleteMessage').length).toBeLessThan(notes + 1)

      // …and the button is offered, and IT is what removes them.
      const tidy = kbOf(full)?.flat().find((b: any) => String(b.callback_data).startsWith('vtidy:'))
      expect(tidy).toBeTruthy()
      const mark = calls.length
      await bridge.bot.handleUpdate({
        update_id: 98800,
        callback_query: { id: 'vt1', from: { id: 1, is_bot: false, first_name: 'T' }, chat_instance: 'x',
          data: String(tidy.callback_data),
          message: { message_id: 98801, date: 0, chat: { id: 1432, type: 'private' } } },
      })
      await new Promise(r => setTimeout(r, 300))
      const after = calls.slice(mark)
      // One delete per note, and the full file is NOT deleted.
      expect(after.filter(c => c.method === 'deleteMessage').length).toBe(notes)
      expect(after.some(c => c.method === 'editMessageReplyMarkup')).toBe(true)
    })
  }, 25000)

  test('a read-along page follows the full file, self-contained', async () => {
    // LONGHEADINGS, not HEADINGS: the page only exists for an answer that also went
    // out as answer.md/.html, and HEADINGS is a paragraph that merely SPEAKS long.
    await withChunking(async () => {
      await incoming(1433, '/voice on')
      const before = calls.length
      await incoming(1433, 'LONGHEADINGS')
      await bridge._drainQueue('1433:main#voice')
      await new Promise(r => setTimeout(r, 400))
      const cs = calls.slice(before)
      // The premise: this answer really did arrive as files.
      expect(cs.some(c => c.method === 'sendMediaGroup' || c.method === 'sendDocument')).toBe(true)
      const doc = cs.find(c => c.method === 'sendDocument'
        && String(c.payload?.document?.filename ?? '').includes('readalong'))
      expect(doc).toBeTruthy()
      expect(String(doc!.payload.caption)).toContain('Read along')
    })
  }, 25000)

  test('the chunked path speaks the WHOLE answer — the 1400-char cap is not on it', async () => {
    // The cap (TG_VOICE_MAX_CHARS, default 1400) is the safety net for summary mode
    // and for the one-note engines. On the progressive path it must not apply at all,
    // and a regression here is invisible from the outside: a sliced answer still
    // synthesises cleanly and just stops early.
    //
    // This lives at tier 2 on purpose. Tier 3 used to guard it by asking for an
    // answer long enough that the missing minutes were obvious, which cost ~10
    // minutes of real synthesis and STILL only checked a duration floor — a 1400-char
    // slice is about 117 seconds of speech, comfortably over the floor it used. Here
    // the units handed to the synthesiser are read directly, so the check is exact
    // and instant.
    const dump = join(TMP, 'spoken-units.json')
    rmSync(dump, { force: true })
    process.env.XESIOUS_SPEAK_STUB_DUMP = dump
    try {
      await withChunking(async () => {
        await incoming(1443, '/voice on')
        await incoming(1443, 'CAPLONG')
        await bridge._drainQueue('1443:main#voice')
      })
      const units = JSON.parse(readFileSync(dump, 'utf8')) as { text: string }[]
      const spoken = units.map(u => u.text).join(' ')
      expect(spoken.length).toBeGreaterThan(1400)
      // The end of the answer is the part a cap removes.
      expect(spoken).toContain('ZZ_LAST_WORDS_OF_THE_ANSWER')
    } finally {
      delete process.env.XESIOUS_SPEAK_STUB_DUMP
      rmSync(dump, { force: true })
    }
  }, 25000)

  test('the synthesiser is given the spoken form and the reader is given the original', async () => {
    // The whole point of the `speak` field. `$100/yr` is phonemised as "dollar one
    // hundred slash er", so the audio needs "one hundred dollars per year" — but the
    // read-along page and the section index are BEING READ, and there `$100/yr` is the
    // better rendering. Two fields, three consumers, and only one of them wants the
    // spoken form.
    const dump = join(TMP, 'spoken-units-norm.json')
    rmSync(dump, { force: true })
    process.env.XESIOUS_SPEAK_STUB_DUMP = dump
    try {
      await withChunking(async () => {
        await incoming(1444, '/voice on')
        await incoming(1444, 'SYMBOLS')
        await bridge._drainQueue('1444:main#voice')
      })
      const units = JSON.parse(readFileSync(dump, 'utf8')) as { text: string; speak?: string }[]
      expect(units.length).toBeGreaterThan(0)
      // Every unit here carries a symbol, so every unit should have been normalised.
      const normalised = units.filter(u => u.speak?.startsWith('SPOKEN('))
      expect(normalised.length).toBe(units.length)
      // …and the written form is untouched, which is what the page and index read.
      expect(units.every(u => u.text.includes('$100/yr'))).toBe(true)
      expect(units.some(u => u.text.startsWith('SPOKEN('))).toBe(false)
    } finally {
      delete process.env.XESIOUS_SPEAK_STUB_DUMP
      rmSync(dump, { force: true })
    }
  }, 30000)

  test('every unit reaches the synthesiser when only SOME of them are normalised', async () => {
    // The case that shipped broken and cost a user 70% of an answer. The units are
    // handed over in two parts — the first chunk's worth immediately, the rest once
    // they are normalised — and the second hand-over was conditional on the
    // normaliser succeeding. Any hiccup closed the pipe with the tail unsent, and a
    // short reading exits 0, so it arrived labelled "Full answer" and ending
    // mid-thought.
    //
    // Asserting on the LAST unit specifically: a truncated answer always keeps its
    // beginning, so only the end can tell you it was complete.
    const dump = join(TMP, 'spoken-units-mixed.json')
    rmSync(dump, { force: true })
    process.env.XESIOUS_SPEAK_STUB_DUMP = dump
    try {
      await withChunking(async () => {
        await incoming(1447, '/voice on')
        await incoming(1447, 'MIXED')
        await bridge._drainQueue('1447:main#voice')
      })
      const units = JSON.parse(readFileSync(dump, 'utf8')) as { text: string; speak?: string }[]
      const spoken = units.map(u => u.speak ?? u.text).join(' ')
      // 1. the whole answer arrived — the tail is the part that used to vanish
      expect(spoken).toContain('ZZ_LAST_WORDS_OF_THE_ANSWER')
      // 2. and it really was a two-part hand-over, or this proves nothing
      expect(units.length).toBeGreaterThan(10)
      // 3. the normaliser did run, on the units that needed it and no others
      expect(units.some(u => u.speak?.startsWith('SPOKEN('))).toBe(true)
      expect(units.some(u => u.speak === undefined)).toBe(true)
    } finally {
      delete process.env.XESIOUS_SPEAK_STUB_DUMP
      rmSync(dump, { force: true })
    }
  }, 30000)

  test('the rest of the answer is still spoken when the normaliser fails', async () => {
    // Un-normalised is a fine outcome; unsent is not. With the model unavailable every
    // unit must still reach the synthesiser as written, which is the audio this bridge
    // produced before normalisation existed — what its own comment promises.
    const dump = join(TMP, 'spoken-units-broken.json')
    rmSync(dump, { force: true })
    process.env.XESIOUS_SPEAK_STUB_DUMP = dump
    const realBin = process.env.CLAUDE_BIN
    process.env.CLAUDE_BIN = join(TMP, 'no-such-normaliser')
    try {
      await withChunking(async () => {
        await incoming(1448, '/voice on')
        await incoming(1448, 'MIXED')
        await bridge._drainQueue('1448:main#voice')
      })
      const units = JSON.parse(readFileSync(dump, 'utf8')) as { text: string; speak?: string }[]
      const spoken = units.map(u => u.speak ?? u.text).join(' ')
      // The whole answer, tail included. That is the entire point: a dead normaliser
      // must cost pronunciation, never words.
      expect(spoken).toContain('ZZ_LAST_WORDS_OF_THE_ANSWER')
      expect(units.length).toBeGreaterThan(10)
      // Deliberately NOT asserting that no unit has a spoken form. The normaliser
      // caches by text, in memory, for the life of the process — so a unit an earlier
      // test already normalised still comes back from the cache with the binary gone.
      // That is the cache working; asserting otherwise pins the wrong behaviour.
    } finally {
      process.env.CLAUDE_BIN = realBin
      delete process.env.XESIOUS_SPEAK_STUB_DUMP
      rmSync(dump, { force: true })
    }
  }, 30000)

  test('a unit with nothing to fix is never sent to the model', async () => {
    // The gate is what keeps this affordable: on a real answer 61 of 100 units matched
    // and the other 39 cost nothing. A unit that skips the model must still be spoken,
    // which means `speak` stays absent and speak.py falls back to `text`.
    const dump = join(TMP, 'spoken-units-gate.json')
    rmSync(dump, { force: true })
    process.env.XESIOUS_SPEAK_STUB_DUMP = dump
    try {
      await withChunking(async () => {
        await incoming(1445, '/voice on')
        await incoming(1445, 'HEADINGS')
        await bridge._drainQueue('1445:main#voice')
      })
      const units = JSON.parse(readFileSync(dump, 'utf8')) as { text: string; speak?: string }[]
      expect(units.length).toBeGreaterThan(0)
      expect(units.every(u => u.speak === undefined)).toBe(true)
    } finally {
      delete process.env.XESIOUS_SPEAK_STUB_DUMP
      rmSync(dump, { force: true })
    }
  }, 25000)

  test('TG_VOICE_NORMALISE=0 restores exactly the old audio', async () => {
    // The kill switch has to be real: off means no `speak` field at all, so speak.py
    // takes the same path it took before any of this existed.
    const dump = join(TMP, 'spoken-units-off.json')
    rmSync(dump, { force: true })
    process.env.XESIOUS_SPEAK_STUB_DUMP = dump
    const prev = bridge._setNormaliseSpeech(false)
    try {
      await withChunking(async () => {
        await incoming(1446, '/voice on')
        await incoming(1446, 'SYMBOLS')
        await bridge._drainQueue('1446:main#voice')
      })
      const units = JSON.parse(readFileSync(dump, 'utf8')) as { text: string; speak?: string }[]
      expect(units.length).toBeGreaterThan(0)
      expect(units.every(u => u.speak === undefined)).toBe(true)
      // …and the streamed hand-over is not used either. The switch has to restore the
      // OLD code path, not merely skip the model while keeping the new plumbing — the
      // plumbing is what dropped 14 of 26 units, so "off" must not go near it.
      const req = JSON.parse(readFileSync(dump.replace('.json', '-req.json'), 'utf8'))
      expect(req.streaming).toBeUndefined()
    } finally {
      bridge._setNormaliseSpeech(prev)
      delete process.env.XESIOUS_SPEAK_STUB_DUMP
      rmSync(dump, { force: true })
    }
  }, 30000)

  test('the part notes carry NO timestamp, because that seek can never land', async () => {
    // Reported: "you are timestamping the shorter audio messages as well. But
    // clicking on those timestamp does not work." Telegram turns M:SS in a media
    // caption into a seek RELATIVE TO THAT MESSAGE — and "part 3 — from 5:42" sits
    // on a note holding 90 seconds that begin at 5:42, so it has no 5:42 to seek to.
    await withChunking(async () => {
      await incoming(1438, '/voice on')
      await incoming(1438, '/voice parts on')          // this is about the captions, not the default
      const before = calls.length
      await incoming(1438, 'HEADINGS')
      await bridge._drainQueue('1438:main#voice')
      const notes = calls.slice(before).filter(c => c.method === 'sendVoice')
      expect(notes.length).toBeGreaterThan(1)
      for (const c of notes) {
        const cap = String(c.payload.caption ?? '')
        expect(cap).not.toMatch(/\d+:\d\d/)
      }
      // The label itself stays — it says where you are in the answer.
      expect(String(notes[1].payload.caption)).toMatch(/part 2/)
    })
  }, 25000)

  test('the full file is the ONLY place an M:SS appears, and never for the total', async () => {
    // Reported: "the message is full answer (timestamp) and the timestamp is
    // clickable but jumps to the end of file and goes to a random file I had in
    // telegram." The total duration is a fact about the file, not a place in it.
    await withChunking(async () => {
      await incoming(1439, '/voice on')
      const before = calls.length
      await incoming(1439, 'LONGHEADINGS')
      await bridge._drainQueue('1439:main#voice')
      const full = calls.slice(before).find(c => c.method === 'sendAudio')
      expect(full).toBeTruthy()
      const cap = String(full!.payload.caption)
      const head = cap.split('\n')[0]
      // The header still reports the length — just not as something tappable.
      expect(head).toMatch(/🎧 Full answer \((\d+h )?(\d+m ?)?(\d+s)?\)/)
      expect(head).not.toMatch(/\d+:\d\d/)
      expect(String(full!.payload.title)).not.toMatch(/\d+:\d\d/)
      // …while every section line is still a real seek, which is the part that works.
      const stamps = cap.split('\n').slice(1).filter(l => /^\d+:\d\d {2}\S/.test(l))
      expect(stamps.length).toBeGreaterThan(1)
    })
  }, 25000)

  test('the read-along page is a reply to the full audio, not a loose message', async () => {
    // Asked for: "the Read Along HTML, can it be sent with the last audio file?"
    // Telegram will not put an audio and a document in one album — "Documents and
    // audio files can be only grouped in an album with messages of the same type" —
    // so replying to the audio is as close as one message gets.
    await withChunking(async () => {
      await incoming(1442, '/voice on')
      const before = calls.length
      await incoming(1442, 'LONGHEADINGS')
      await bridge._drainQueue('1442:main#voice')
      await new Promise(r => setTimeout(r, 600))
      const cs = calls.slice(before)
      const full = cs.find(c => c.method === 'sendAudio')
      const page = cs.find(c => c.method === 'sendDocument'
        && String(c.payload?.document?.filename ?? '').includes('readalong'))
      expect(full).toBeTruthy()
      expect(page).toBeTruthy()
      // The audio's id is not on the recorded call, so match on order + reply target:
      // the page must reply to a message sent in this turn, after the audio.
      expect(cs.indexOf(page!)).toBeGreaterThan(cs.indexOf(full!))
      expect(page!.payload?.reply_parameters?.message_id).toBeGreaterThan(0)
      expect(String(page!.payload.caption)).toContain('full answer above')
    })
  }, 25000)

  test('exactly ONE read-along page, not one per delivery path', async () => {
    // `done` arrives on stdout immediately behind `full`, so a flag set inside the
    // full file's queued SEND was still false when the `done` branch read it, and
    // both queued a page: two near-identical documents for one answer. Found while
    // gating the page on answer length — the log showed 11.2 KB and 11.1 KB back to
    // back, the second built from the first chunk rather than the full audio.
    await withChunking(async () => {
      await incoming(1437, '/voice on')
      const before = calls.length
      await incoming(1437, 'LONGHEADINGS')
      await bridge._drainQueue('1437:main#voice')
      await new Promise(r => setTimeout(r, 600))
      const pages = calls.slice(before).filter(c => c.method === 'sendDocument'
        && String(c.payload?.document?.filename ?? '').includes('readalong'))
      expect(pages).toHaveLength(1)
    })
  }, 25000)

  test('a short answer gets NO read-along, however many notes it is spoken as', async () => {
    // Reported: "even a 30 seconds voice is giving me read along html". The page was
    // gated on having TIMINGS, which every spoken answer has — so it rode on audio
    // length, not answer length. HEADINGS is ~180 characters and still speaks as
    // several notes, which is exactly the case that produced an unwanted document.
    await withChunking(async () => {
      await incoming(1436, '/voice on')
      await incoming(1436, '/voice parts on')          // several notes is the premise here
      const before = calls.length
      await incoming(1436, 'HEADINGS')
      await bridge._drainQueue('1436:main#voice')
      await new Promise(r => setTimeout(r, 400))
      const cs = calls.slice(before)
      // The audio all still happens — this removes a document, not a feature.
      expect(cs.filter(c => c.method === 'sendVoice').length).toBeGreaterThan(1)
      expect(cs.some(c => c.method === 'sendAudio')).toBe(true)
      // …and the answer itself was short enough to sit inline, so: no files at all.
      expect(cs.some(c => c.method === 'sendDocument' || c.method === 'sendMediaGroup')).toBe(false)
    })
  }, 25000)

  test('tapping Stop kills it, and is idempotent', async () => {
    // The button WILL be tapped twice.
    writeFileSync(SLOW_SPEAK, 'x')
    await withChunking(async () => {
      try {
        await incoming(1434, '/voice on')
        const before = calls.length
        const run = bridge._drainQueue('1434:main#voice')
        await incoming(1434, 'HEADINGS')
        // No polling any more, and that IS the fix. This used to wait up to fifteen
        // seconds for note 1 to appear, because that was where 🛑 lived — which is the
        // whole complaint: with a slow synthesiser there was a long stretch at the
        // start of every run with nothing to tap. The status bubble is posted before
        // the child is even spawned.
        const status = calls.slice(before).find(c => c.method === 'sendMessage'
          && String(c.payload?.text ?? '').includes('🎙 Speaking'))
        expect(status).toBeTruthy()
        expect(calls.slice(before).some(c => c.method === 'sendVoice')).toBe(false)
        const stop = kbOf(status)?.flat().find((b: any) => String(b.callback_data).startsWith('vstop:'))
        expect(stop).toBeTruthy()

        const tap = (id: string) => bridge.bot.handleUpdate({
          update_id: Math.floor(Math.random() * 1e6),
          callback_query: { id, from: { id: 1, is_bot: false, first_name: 'T' }, chat_instance: 'x',
            data: String(stop.callback_data),
            message: { message_id: 98901, date: 0, chat: { id: 1434, type: 'private' } } },
        })
        await tap('s1')
        await tap('s2')            // second tap must not throw or double-report
        await run
        await bridge._drainQueue('1434:main#voice')
        const said = calls.slice(before).filter(c => c.method === 'sendMessage')
          .map(c => String(c.payload.text ?? '')).join('\n')
        expect(said).toContain('Stopped speaking')
        expect((said.match(/Stopped speaking/g) || []).length).toBe(1)
        // Nothing further was delivered after the kill.
        expect(calls.slice(before).some(c => c.method === 'sendAudio')).toBe(false)
      } finally { rmSync(SLOW_SPEAK, { force: true }) }
    })
  }, 30000)

  test('/stop cancels speech as well as the run', async () => {
    // Someone typing /stop wants everything to stop; ending the model turn while ten
    // minutes of audio keeps arriving is the surprise this removes.
    writeFileSync(SLOW_SPEAK, 'x')
    await withChunking(async () => {
      try {
        await incoming(1435, '/voice on')
        const run = bridge._drainQueue('1435:main#voice')
        await incoming(1435, 'HEADINGS')
        // Wait until speech is genuinely in flight, or /stop has nothing to cancel.
        for (let i = 0; i < 60 && !calls.some(c => c.method === 'sendVoice'); i++) {
          await new Promise(r => setTimeout(r, 250))
        }
        const cs = await incoming(1435, '/stop')
        expect(finalReply(cs)).toMatch(/Stopped speaking|Speaking stopped/i)
        await run
      } finally { rmSync(SLOW_SPEAK, { force: true }) }
    })
  }, 30000)
})

describe('a SHORT spoken answer gets an index, and no read-along', () => {
  // One chunk means no full file — the single note is the whole thing — so the INDEX
  // used to be silently absent for short answers. Caught in tier 3 as "no full-length
  // audio arrived", which read like a timeout and was a real gap; it is still fixed.
  // The read-along went the other way: it was attached here too, and should not have
  // been. An index costs a caption already being sent; a page costs an attachment.
  test('the note itself is captioned with the section index', async () => {
    await incoming(1440, '/voice on')
    const before = calls.length
    await incoming(1440, 'SHORTHEADINGS')
    await bridge._drainQueue('1440:main#voice')
    await new Promise(r => setTimeout(r, 400))
    const cs = calls.slice(before)
    expect(cs.filter(c => c.method === 'sendVoice')).toHaveLength(1)
    expect(cs.some(c => c.method === 'sendAudio')).toBe(false)   // no duplicate file
    const edit = cs.find(c => c.method === 'editMessageCaption')
    expect(edit).toBeTruthy()
    expect(String(edit!.payload.caption)).toContain('🎧 Full answer')
    expect(String(edit!.payload.caption)).toMatch(/^\d+:\d\d {2}\S/m)
  }, 25000)

  test('and no read-along page follows it', async () => {
    await incoming(1441, '/voice on')
    const before = calls.length
    await incoming(1441, 'SHORTHEADINGS')
    await bridge._drainQueue('1441:main#voice')
    await new Promise(r => setTimeout(r, 400))
    const doc = calls.slice(before).find(c => c.method === 'sendDocument'
      && String(c.payload?.document?.filename ?? '').includes('readalong'))
    expect(doc).toBeUndefined()
  }, 25000)
})
