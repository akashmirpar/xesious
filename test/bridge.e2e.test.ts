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
  if (method === 'createForumTopic') {
    // The real API returns a thread id, and the fan-out code depends on it: without
    // one, every part would fall back to the parent's key.
    return { ok: true, result: { message_thread_id: nextMessageId++, name: payload.name, icon_color: 0 } }
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
  const docs = (cs: any[]) => cs.filter(c => c.method === 'sendDocument')

  test('both an .html and an .md are sent', async () => {
    // The .md alone was close to unreadable on macOS: no default viewer, no
    // preview in Telegram Desktop, and double-clicking shows raw pipe-tables —
    // exactly the content that needed a file in the first place.
    const cs = await incoming(1120, 'LONG')
    const names = docs(cs).map(c => String(c.payload?.document?.filename ?? ''))
    expect(names.some(n => n.endsWith('.html'))).toBe(true)
    expect(names.some(n => n.endsWith('.md'))).toBe(true)
  }, 10000)

  test('the preview caption rides on the first file only', async () => {
    const cs = await incoming(1121, 'LONG')
    const captioned = docs(cs).filter(c => c.payload?.caption)
    expect(captioned).toHaveLength(1)
    expect(String(captioned[0].payload.caption)).toContain('Full answer')
  }, 10000)

  test('the files follow the same threading rule as any other answer', async () => {
    // A lone question, so no quoted header — the .md and .html are obviously its
    // answer and the link would only cost space.
    const cs = await incoming(1122, 'LONG')
    expect(docs(cs).every(c => !c.payload?.reply_parameters)).toBe(true)
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
    const created = calls.filter(c => c.method === 'createForumTopic')
    expect(created.length).toBeGreaterThanOrEqual(2)
    // Each part was addressed in its own thread, not all in the parent.
    const threads = new Set(calls.filter(c => c.method === 'sendMessage'
      && String(c.payload.text ?? '').includes('Talk here to steer')).map(c => c.payload.message_thread_id))
    expect(threads.size).toBeGreaterThanOrEqual(2)
    expect([...threads].every(t => t !== undefined)).toBe(true)
  }, 30000)

  test('the combined answer is produced automatically once the parts settle', async () => {
    const texts = calls.filter(c => c.method === 'sendMessage').map(c => String(c.payload.text ?? '')).join('\n')
    // The combined answer arrives on its own. There is deliberately no "all parts
    // finished" banner when nothing failed — it announced work that was about to
    // speak for itself. A failure or a branch report still gets said.
    expect(texts).toContain('SYNTHESIS')
    expect(texts).not.toMatch(/Background task finished[\s\S]{0,40}SYNTHESIS/)
  }, 15000)

  test('a correction after the answer reopens that part and offers to combine again', async () => {
    // The parts' topics are closed once the answer is written, and a closed topic is
    // read-only for everyone but an admin — so a part that is being corrected has to
    // be reopened, or the first correction is also the last one possible.
    const child = calls.find(c => c.method === 'sendMessage'
      && String(c.payload.text ?? '').includes('Talk here to steer'))!.payload.message_thread_id as number
    expect(calls.some(c => c.method === 'closeForumTopic')).toBe(true)
    const before = calls.length
    await group('correction: the answer is CORRECTED', 99301, child)
    await bridge._drainQueue(`-100777:${child}`)
    await new Promise(r => setTimeout(r, 1500))
    const after = calls.slice(before)
    expect(after.some(c => c.method === 'reopenForumTopic'
      && c.payload.message_thread_id === child)).toBe(true)
    expect(after.some(c => btns(c).some((b: any) => String(b.text).includes('Combine again')))).toBe(true)
  }, 20000)
})
