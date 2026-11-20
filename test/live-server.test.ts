// live/server.ts end to end: the real server, a fake Soniox (a local WebSocket the
// test drives), a stand-in claude, and a test client in the page's place.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, existsSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'

const TMP = mkdtempSync(join(tmpdir(), 'xesious-live-'))
const LINKS = join(TMP, 'live-links.json')
const CALLS = join(TMP, 'calls')
const PROMPTS = join(TMP, 'prompts.jsonl')
const UUID = '7f1c2a9e-0000-4000-8000-000000000001'
const D1 = 'device-one-aaaaaaaaaaaaaaaa', D2 = 'device-two-bbbbbbbbbbbbbbbb'
// The phone's wake-word spotter's built files: stand-ins, served as they are.
const KWS = join(TMP, 'kws')
mkdirSync(KWS)
for (const f of ['vosk.js', 'vosk-worker.js', 'vosk-model-small-en-us-0.15.tar.gz']) writeFileSync(join(KWS, f), `stand-in ${f}`)

// claude: records its prompt; SLOW… never answers (until killed), anything else
// answers one sentence.
const STUB = join(TMP, 'claude')
writeFileSync(STUB, `#!${process.execPath}
const a = process.argv.slice(2), p = a[a.indexOf('-p') + 1]
require('fs').appendFileSync(${JSON.stringify(PROMPTS)}, JSON.stringify({ prompt: p, perm: a[a.indexOf('--permission-mode') + 1] }) + '\\n')
const emit = o => process.stdout.write(JSON.stringify(o) + '\\n')
emit({ type: 'system', subtype: 'init', session_id: 'sess-1' })
if (p.startsWith('SLOW')) setTimeout(() => {}, 60000)
else { emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Answer one.' }] } }); emit({ type: 'result', session_id: 'sess-1', result: 'Answer one.' }) }
`)
chmodSync(STUB, 0o755)

// --- fake Soniox ---
let sonioxSock: ServerWebSocket<unknown> | null = null
let sonioxConfig: any = null
let sonioxBytes = 0
let finalizes = 0
const soniox = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response('no', { status: 400 }) },
  websocket: {
    open(ws) { sonioxSock = ws },
    message(ws, m) {
      if (typeof m !== 'string') { sonioxBytes += m.byteLength; return }
      if (m === '') return   // end of stream
      if (!sonioxConfig) { sonioxConfig = JSON.parse(m); return }
      if (JSON.parse(m).type === 'finalize') {
        finalizes++
        ws.send(JSON.stringify({ tokens: [...pendingTokens.map(t => ({ ...t, is_final: true })), { text: '<fin>', is_final: true }] }))
        pendingTokens = []
      }
    },
  },
})
let ms = 0
let pendingTokens: any[] = []
function partial(speaker: string, text: string) {
  pendingTokens = text.split(/(?= )/).map(w => ({ text: w, speaker, is_final: false, language: 'en', start_ms: (ms += 200) - 150, end_ms: ms }))
  sonioxSock!.send(JSON.stringify({ tokens: pendingTokens, total_audio_proc_ms: ms }))
}
// Soniox's progress during silence: the same pending words again, the audio moved on.
function progress(silentMs: number) {
  sonioxSock!.send(JSON.stringify({ tokens: pendingTokens, total_audio_proc_ms: ms + silentMs }))
}
function say(speaker: string, text: string) {
  const tokens = text.split(/(?= )/).map(w => ({ text: w, speaker, is_final: true, language: 'en', start_ms: (ms += 200) - 150, end_ms: ms }))
  sonioxSock!.send(JSON.stringify({ tokens: [...tokens, { text: '<end>', is_final: true }], total_audio_proc_ms: ms + 1000 }))
}

// --- the page ---
type Client = { ws: WebSocket; got: any[]; wait: (pred: (m: any) => boolean, ms?: number) => Promise<any> }
let port = 0
async function client(device: string, uuid = UUID): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const got: any[] = []
  const waiters: { pred: (m: any) => boolean; res: (m: any) => void }[] = []
  ws.onmessage = e => {
    if (typeof e.data !== 'string') return
    const m = JSON.parse(e.data); got.push(m)
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m) }
  }
  const wait = (pred: (m: any) => boolean, t = 8000) => new Promise<any>((res, rej) => {
    const hit = got.find(pred); if (hit) return res(hit)
    waiters.push({ pred, res }); setTimeout(() => rej(new Error(`timed out; got ${JSON.stringify(got.map(m => m.type))}`)), t)
  })
  await new Promise(r => (ws.onopen = r))
  ws.send(JSON.stringify({ type: 'auth', uuid, device }))
  return { ws, got, wait }
}
const prompts = () => existsSync(PROMPTS) ? readFileSync(PROMPTS, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []

let server: ChildProcess
beforeAll(async () => {
  writeFileSync(LINKS, JSON.stringify({ [UUID]: { key: 'chat:topic', cwd: TMP, created: new Date().toISOString(), permission: ['--permission-mode', 'auto'] } }))
  server = spawn(process.execPath, ['run', join(import.meta.dir, '..', 'live', 'server.ts')], {
    env: { ...process.env, LIVE_PORT: '0', LIVE_TTS: 'off', LIVE_LINKS_FILE: LINKS, LIVE_CALLS_DIR: CALLS, CLAUDE_BIN: STUB,
      SONIOX_API_KEY: 'test-key', LIVE_SONIOX_URL: `ws://127.0.0.1:${soniox.port}`, LIVE_QUIET_MS: '150', LIVE_MAX_WAIT_MS: '1500', LIVE_END_SILENCE_MS: '1300',
      LIVE_KWS_DIR: KWS, LIVE_WOKE_CONFIRM_MS: '1200' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  port = await new Promise<number>((res, rej) => {
    let buf = ''
    server.stdout!.on('data', d => { buf += d; const m = buf.match(/127\.0\.0\.1:(\d+)/); if (m) res(Number(m[1])) })
    setTimeout(() => rej(new Error(`server did not start: ${buf}`)), 10000)
  })
})
afterAll(() => { server?.kill('SIGKILL'); soniox.stop(true) })

let A: Client
test('the first device takes the link; a second device is refused', async () => {
  A = await client(D1)
  expect(await A.wait(m => m.type === 'ready')).toMatchObject({ stt: 'soniox' })
  expect(JSON.parse(readFileSync(LINKS, 'utf8'))[UUID].device).toMatch(/^[0-9a-f]{64}$/)
  const B = await client(D2)
  await B.wait(m => m.type === 'other_device')
})

test('the page is told what its wake spotter listens for ("hey" before each wake word it can spell), and gets its files', async () => {
  const ready = A.got.find(m => m.type === 'ready')
  expect(ready.kws).toEqual({ model: '/kws/vosk-model-small-en-us-0.15.tar.gz', bytes: 'stand-in vosk-model-small-en-us-0.15.tar.gz'.length, phrases: ['hey lucy', 'hey lucie'], conf: 0.9 })
  const model = await fetch(`http://127.0.0.1:${port}/kws/vosk-model-small-en-us-0.15.tar.gz`)
  expect(model.headers.get('content-type')).toBe('application/gzip')
  expect(await model.text()).toBe('stand-in vosk-model-small-en-us-0.15.tar.gz')
  expect((await fetch(`http://127.0.0.1:${port}/kws/vosk-worker.js`)).headers.get('content-type')).toContain('javascript')
  // nothing else from that folder, and nothing outside it
  expect((await fetch(`http://127.0.0.1:${port}/kws/..%2Flive-links.json`)).headers.get('content-type')).toContain('text/html')
  expect((await fetch(`http://127.0.0.1:${port}/kws/secret.txt`)).headers.get('content-type')).toContain('text/html')
  const page = await fetch(`http://127.0.0.1:${port}/${UUID}`)
  expect(page.headers.get('content-security-policy')).toContain(`worker-src 'self'`)
})

test('mic audio reaches Soniox with the key, both languages and speakers on', async () => {
  A.ws.send(new Uint8Array(3200))
  for (let i = 0; i < 40 && sonioxBytes < 3200; i++) await Bun.sleep(50)
  expect(sonioxBytes).toBe(3200)
  expect(sonioxConfig).toMatchObject({ api_key: 'test-key', model: 'stt-rt-v6', language_hints: ['en', 'fa'], enable_speaker_diarization: true, sample_rate: 16000,
    enable_endpoint_detection: false })
  expect(sonioxConfig.context).toBeUndefined()   // no "expected words" unless LIVE_TERMS is set
})


test('a wake heard on the phone that Soniox did not hear is a false wake: the mic goes off again', async () => {
  const traceNow = () => readFileSync(join(CALLS, readdirSync(CALLS)[0], 'trace.jsonl'), 'utf8')
  A.got.length = 0
  A.ws.send(JSON.stringify({ type: 'woke', keyword: 'HEY_LUCY' }))
  expect(await A.wait(m => m.type === 'mic', 4000)).toEqual({ type: 'mic', on: false, ms: 0, why: 'false_wake' })
  expect(traceNow()).toContain('wake phrase heard on the phone (HEY_LUCY)')
  expect(traceNow()).toContain('false wake')
})

test('the first voice is "you" and runs a turn in the topic\'s mode; the answer says what it answers', async () => {
  say('1', 'What time is it?')
  expect(await A.wait(m => m.type === 'main')).toEqual({ type: 'main', speaker: '1' })
  const l = (await A.wait(m => m.type === 'lines')).lines[0]
  expect(l).toMatchObject({ speaker: '1', role: 'me', text: 'What time is it?' })
  const sent = await A.wait(m => m.type === 'sent')
  const working = await A.wait(m => m.type === 'working')
  expect(working).toMatchObject({ req: sent.req, said: 'What time is it?', ids: [l.id] })
  expect(await A.wait(m => m.type === 'bot')).toEqual({ type: 'bot', req: sent.req, text: 'Answer one.' })
  await A.wait(m => m.type === 'turn_end' && m.req === sent.req)
  expect(prompts()[0]).toEqual({ prompt: 'What time is it?', perm: 'auto' })
})

test('others are shown, not sent, and go along as background', async () => {
  A.got.length = 0
  say('2', 'We land at nine.')
  const other = (await A.wait(m => m.type === 'lines')).lines[0]
  expect(other).toMatchObject({ speaker: '2', role: 'other' })
  await Bun.sleep(300)
  expect(prompts()).toHaveLength(1)

  A.got.length = 0
  say('1', 'When do we land?')
  await A.wait(m => m.type === 'turn_end')
  const p = prompts()[1].prompt
  expect(p.startsWith('When do we land?')).toBe(true)
  expect(p).toContain('speaker 2: We land at nine.')
})

test('a sentence cut off at a pause waits for the rest, and goes as one request', async () => {
  A.got.length = 0
  const n = prompts().length
  say('1', 'Then send the report to—')
  await A.wait(m => m.type === 'waiting')
  await Bun.sleep(300)
  expect(prompts()).toHaveLength(n)
  say('1', 'the whole team.')
  await A.wait(m => m.type === 'turn_end')
  expect(prompts()[n].prompt).toBe('Then send the report to— the whole team.')
})

test('a cut-off sentence still goes once the wait is over', async () => {
  A.got.length = 0
  const n = prompts().length
  say('1', 'Tell me about')
  await A.wait(m => m.type === 'turn_end', 5000)
  expect(prompts()[n].prompt).toBe('Tell me about')
})

// 100 ms of 16 kHz audio: a tone at speech loudness, or silence.
const chunk = (loud: boolean) => { const b = new Int16Array(1600); if (loud) for (let i = 0; i < 1600; i++) b[i] = Math.round(3000 * Math.sin(i / 5)); return new Uint8Array(b.buffer) }
test('quiet in the audio ends a piece — not a gap in the words, which Soniox writes out late', async () => {
  const before = finalizes
  for (let i = 0; i < 5; i++) A.ws.send(chunk(true))
  partial('1', 'Is anyone there')
  progress(3000)                          // Soniox is late with words: no effect any more
  for (let i = 0; i < 10; i++) A.ws.send(chunk(false))   // 1 s of quiet: not yet
  await Bun.sleep(200)
  expect(finalizes).toBe(before)
  for (let i = 0; i < 6; i++) A.ws.send(chunk(false))    // past 1.3 s
  for (let i = 0; i < 40 && finalizes === before; i++) await Bun.sleep(50)
  expect(finalizes).toBe(before + 1)
  const w = await A.wait(m => m.type === 'working' && m.said === 'Is anyone there', 5000)
  await A.wait(m => m.type === 'turn_end' && m.req === w.req)
})

test('going on after a request was sent, before any answer, asks again with the whole thing', async () => {
  A.got.length = 0
  const n = prompts().length
  say('1', 'SLOW I am at the station.')          // sent after the pause; Claude is slow to answer
  const first = await A.wait(m => m.type === 'working')
  say('1', 'Which platform is my train?')
  const gone = await A.wait(m => m.type === 'retract')
  expect(gone.req).toBe(first.req)
  const again = await A.wait(m => m.type === 'working' && m.req !== first.req)
  expect(again.said).toBe('SLOW I am at the station. Which platform is my train?')
  const whole = 'SLOW I am at the station. Which platform is my train?'
  for (let i = 0; i < 40 && prompts().at(-1)?.prompt !== whole; i++) await Bun.sleep(50)
  expect(prompts().at(-1)!.prompt).toBe(whole)   // (the cut run may have been killed before it got going)
  A.ws.send(JSON.stringify({ type: 'interrupt' }))
  await A.wait(m => m.type === 'hush')
})

test('tapping a line makes that voice "you"; letting go of the talk button ends the piece', async () => {
  A.got.length = 0
  say('2', 'Actually I am the one talking.')
  const line = (await A.wait(m => m.type === 'lines')).lines[0]
  expect(line.role).toBe('other')
  A.ws.send(JSON.stringify({ type: 'me', id: line.id }))
  expect(await A.wait(m => m.type === 'main')).toEqual({ type: 'main', speaker: '2' })
  const before = finalizes
  A.ws.send(JSON.stringify({ type: 'hold', on: true }))
  A.ws.send(JSON.stringify({ type: 'hold', on: false }))
  for (let i = 0; i < 40 && finalizes === before; i++) await Bun.sleep(50)
  expect(finalizes).toBe(before + 1)
})

test("what the caller said before the caller's voice was picked is not sent on its own, but goes along with their next request", async () => {
  A.got.length = 0
  const n = prompts().length
  expect(prompts().map(p => p.prompt)).not.toContain('Actually I am the one talking.')
  say('2', 'Do what I just said.')
  const sent = await A.wait(m => m.type === 'sent')
  await A.wait(m => m.type === 'turn_end' && m.req === sent.req)
  expect(prompts()).toHaveLength(n + 1)
  const p = prompts()[n].prompt
  expect(p.startsWith('Do what I just said.')).toBe(true)
  expect(p).toContain('you: Actually I am the one talking.')
})

test('"stop" stops the running turn', async () => {
  A.got.length = 0
  say('2', 'SLOW research this for me.')
  await A.wait(m => m.type === 'working')
  say('2', 'Stop, stop.')
  await A.wait(m => m.type === 'hush')
  expect(prompts().map(p => p.prompt)).not.toContain('Stop, stop.')
})

test('answers can come without speech: shown on the page, no voice made; back to spoken, the voice is made again', async () => {
  const traceNow = () => readFileSync(join(CALLS, readdirSync(CALLS)[0], 'trace.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const unspoken = () => traceNow().filter(t => t.stage === 'voice' && /^not spoken: voice off/.test(t.msg)).length
  const turn = async (text: string) => {
    A.got.length = 0
    A.ws.send(JSON.stringify({ type: 'text', text }))
    const w = await A.wait(m => m.type === 'working' && m.said === text)
    expect(await A.wait(m => m.type === 'bot' && m.req === w.req)).toMatchObject({ text: 'Answer one.' })
    await A.wait(m => m.type === 'turn_end' && m.req === w.req)
  }
  for (const mode of ['silent', 'sound']) {
    A.ws.send(JSON.stringify({ type: 'answers', mode }))
    const before = unspoken()
    await turn(`A quiet question (${mode})?`)
    expect(unspoken()).toBe(before)   // no voice was even asked for
  }
  A.ws.send(JSON.stringify({ type: 'answers', mode: 'voice' }))
  const before = unspoken()
  await turn('A spoken question?')
  expect(unspoken()).toBe(before + 1)   // asked for (and off in this test)
  const changes = traceNow().filter(t => /^answers now/.test(t.msg)).map(t => t.msg)
  expect(changes).toEqual(['answers now: silent', 'answers now: a sound when ready', 'answers now: spoken'])
})

test("Assistant mode: the caller's talk without its name is not sent; called by name, it is, with the talk before it; the wake words are the caller's, kept", async () => {
  const main = () => '2'   // picked above
  const traceNow = () => readFileSync(join(CALLS, readdirSync(CALLS)[0], 'trace.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  A.ws.send(JSON.stringify({ type: 'mode', mode: 'assistant' }))
  await A.wait(m => m.type === 'call_mode' && m.mode === 'assistant')
  A.got.length = 0
  const n = prompts().length
  say(main(), 'We should ship on Friday.')
  await A.wait(m => m.type === 'lines')
  await Bun.sleep(600)
  expect(A.got.some(m => m.type === 'sent')).toBe(false)
  expect(prompts().length).toBe(n)
  say(main(), 'Lucy, what time is it?')
  const sent = await A.wait(m => m.type === 'sent')
  await A.wait(m => m.type === 'turn_end' && m.req === sent.req)
  const p = prompts().at(-1).prompt as string
  expect(p.startsWith('what time is it?')).toBe(true)
  expect(p).toContain('you: We should ship on Friday.')
  // The words that call it: changed on the page, kept for this person (here: the link).
  A.ws.send(JSON.stringify({ type: 'wake', words: 'Hanna, حنا' }))
  expect(await A.wait(m => m.type === 'wake' && m.words[0] === 'Hanna')).toMatchObject({ words: ['Hanna', 'حنا'] })
  expect(JSON.parse(readFileSync(join(TMP, 'live-prefs.json'), 'utf8'))[`link:${UUID}`]).toEqual({ wake: ['Hanna', 'حنا'] })
  // Its name alone: the page is told it is listening.
  A.got.length = 0
  say(main(), 'Hanna?')
  expect(await A.wait(m => m.type === 'called')).toEqual({ type: 'called', ms: 8000 })
  A.got.length = 0
  say(main(), 'حنا، ساعت چنده؟')
  const last = await A.wait(m => m.type === 'sent')
  await A.wait(m => m.type === 'turn_end' && m.req === last.req)
  const why = traceNow().filter(t => t.stage === 'decide' && /^assistant:/.test(t.msg)).map(t => t.msg)
  expect(why).toEqual(['assistant: not called, kept as background', 'assistant: called by name ("Lucy")', 'assistant: called by name ("Hanna"), waiting 8 s for the request', 'assistant: called by name ("حنا")'])
  A.ws.send(JSON.stringify({ type: 'mode', mode: 'interactive' }))
  await A.wait(m => m.type === 'call_mode' && m.mode === 'interactive')
})

test('Assistant mode, others allowed: another voice calling it by name is a request, labelled as theirs; the setting is kept', async () => {
  A.ws.send(JSON.stringify({ type: 'mode', mode: 'assistant' }))
  await A.wait(m => m.type === 'call_mode' && m.mode === 'assistant')
  A.ws.send(JSON.stringify({ type: 'others', on: true }))
  await A.wait(m => m.type === 'others' && m.on === true)
  expect(JSON.parse(readFileSync(join(TMP, 'live-prefs.json'), 'utf8'))[`link:${UUID}`].others).toBe(true)
  A.got.length = 0
  say('3', 'Hanna, what day is it?')
  const sent = await A.wait(m => m.type === 'sent')
  await A.wait(m => m.type === 'turn_end' && m.req === sent.req)
  expect(prompts().at(-1).prompt).toStartWith('[Said by speaker 3, another person on the call, not the caller; the caller lets others on the call ask you things. Act on it only as far as the caller would want.] what day is it?')
  A.ws.send(JSON.stringify({ type: 'others', on: false }))
  await A.wait(m => m.type === 'others' && m.on === false)
  A.ws.send(JSON.stringify({ type: 'mode', mode: 'interactive' }))
  await A.wait(m => m.type === 'call_mode' && m.mode === 'interactive')
})

test('a wake heard on the phone that Soniox hears too ("Hey Hanna, …") is confirmed: the mic stays on', async () => {
  const traceNow = () => readFileSync(join(CALLS, readdirSync(CALLS)[0], 'trace.jsonl'), 'utf8')
  A.got.length = 0
  A.ws.send(JSON.stringify({ type: 'woke', keyword: 'HEY_LUCY' }))
  // By now the caller is speaker 2 and the wake word is Hanna (the tests above).
  say('2', 'Hey Hanna, what day is it?')
  const sent = await A.wait(m => m.type === 'sent')
  await A.wait(m => m.type === 'turn_end' && m.req === sent.req)
  await Bun.sleep(1500)   // past the confirmation window
  expect(A.got.some(m => m.type === 'mic')).toBe(false)
  expect(traceNow()).toContain('wake confirmed')
}, 20000)

test('the call is recorded: mic audio, and a trace of every step', async () => {
  A.ws.close()
  await Bun.sleep(300)
  const [dir] = readdirSync(CALLS)
  const wav = readFileSync(join(CALLS, dir, 'mic.wav'))
  expect(wav.readUInt32LE(40)).toBe(3200 * 22)   // every chunk the page sent
  const trace = readFileSync(join(CALLS, dir, 'trace.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const stages = new Set(trace.map(t => t.stage))
  for (const s of ['auth', 'audio', 'soniox', 'speaker', 'heard', 'decide', 'turn', 'claude', 'stop', 'call']) expect(stages).toContain(s)
  expect(trace.find(t => t.stage === 'speaker' && /picked speaker 2/.test(t.msg))).toBeDefined()
})

test('an expired link is refused at the door', async () => {
  const l = JSON.parse(readFileSync(LINKS, 'utf8'))
  l[UUID].created = new Date(Date.now() - 2 * 3600_000).toISOString()
  l[UUID].used = new Date(Date.now() - 2 * 3600_000).toISOString()   // not used for two hours either
  writeFileSync(LINKS, JSON.stringify(l))
  const C = await client(D1)
  await C.wait(m => m.type === 'expired')
})
