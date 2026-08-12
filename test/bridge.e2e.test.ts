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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
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
    const withKb = sends(cs).find(c => c.payload?.reply_markup?.inline_keyboard)
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
