// live/server.ts with the bot's local API next to its links file: a call turn goes to
// the bot (POST /v1/live/turn) and its streamed answer comes back to the page. A
// stand-in bot API on a Unix socket plays the bridge's part.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'xesious-live-bot-'))
const LINKS = join(TMP, 'live-links.json')
const UUID = '7f1c2a9e-0000-4000-8000-0000000000b1'
const TOKEN = 'operator-token-for-the-test'
writeFileSync(join(TMP, 'xesious.token'), TOKEN + '\n')

// --- the bot's API ---
const asked: { auth: string | null; body: any }[] = []
let hungUp = 0
let topicsAsked = 0
const typed: any[] = []
const acted: any[] = []
// The open events stream, for the test to push what the bot would.
// One per page connected (a test may open a second page on the link).
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
let events: ReadableStreamDefaultController<Uint8Array> | null = null
const push = (o: unknown) => { for (const c of streams) try { c.enqueue(new TextEncoder().encode(JSON.stringify(o) + '\n')) } catch {} }
const bot = Bun.serve({
  unix: join(TMP, 'xesious.sock'),
  async fetch(req) {
    const url = new URL(req.url, 'http://local')
    if (url.pathname === '/v1/live/events') {
      if (url.searchParams.get('link') !== UUID) return Response.json({ error: 'no such live link' }, { status: 404 })
      let ctl: ReadableStreamDefaultController<Uint8Array>
      return new Response(new ReadableStream({
        start(c) { ctl = c; events = c; streams.add(c); c.enqueue(new TextEncoder().encode(JSON.stringify({ kind: 'runs', runs: [{ id: 'r0', chat: '-100777', topic: 'Backend', what: 'Fix the login page', at: Date.now() - 65_000 }] }) + '\n')) },
        cancel() { streams.delete(ctl); if (events === ctl) events = null },
      }), { headers: { 'content-type': 'application/x-ndjson' } })
    }
    if (url.pathname === '/v1/live/topics') {
      topicsAsked++
      return Response.json({ now: Date.now(), live: 99, origin: 12, topics: [
        { id: 99, name: 'Live' },
        { id: 12, name: 'Backend', working: [{ on: 'Fix the login page', step: '🔧 Bash', for: '1 min', steps: [] }], lastAt: Date.now() },
        { id: 'General', name: 'General', lastAt: Date.now() - 3600_000 },
      ] })
    }
    if (url.pathname === '/v1/live/answer' || url.pathname === '/v1/live/stop') {
      const body = await req.json(); acted.push({ path: url.pathname, body })
      return body.id === 'gone' ? Response.json({ error: 'That was answered already, or nobody answered in time.' }, { status: 409 }) : Response.json({ message: 'Allowed.' })
    }
    if (url.pathname === '/v1/live/photo') return new Response(`PHOTO ${url.searchParams.get('topic')}/${url.searchParams.get('id')}`)
    if (url.pathname === '/v1/live/messages') {
      return Response.json({ topic: Number(url.searchParams.get('topic')) || 'General', name: 'Backend', messages: [{ id: 5, t: 1, from: 'Tester', fromId: 1, text: 'Fix the login page' }] })
    }
    if (url.pathname === '/v1/live/say') {
      const body = await req.json()
      typed.push(body)
      return body.text === 'REFUSE' ? Response.json({ error: 'the topic "Gone" no longer exists in Telegram' }, { status: 410 }) : Response.json({ message: 'Sent.', message_id: 77 }, { status: 202 })
    }
    if (url.pathname !== '/v1/live/turn') return Response.json({ error: 'no' }, { status: 404 })
    const body = await req.json()
    asked.push({ auth: req.headers.get('authorization'), body })
    const enc = new TextEncoder()
    const line = (o: unknown) => enc.encode(JSON.stringify(o) + '\n')
    if (body.ask) return new Response(new ReadableStream({
      start(c) { c.enqueue(line({ type: 'text', text: 'Backend asks to delete the build folder. Allow it?' })); c.enqueue(line({ type: 'done', isError: false })); c.close() },
    }), { headers: { 'content-type': 'application/x-ndjson' } })
    if (body.notice) return new Response(new ReadableStream({
      start(c) { c.enqueue(line({ type: 'text', text: 'The login page is fixed.' })); c.enqueue(line({ type: 'done', isError: false })); c.close() },
    }), { headers: { 'content-type': 'application/x-ndjson' } })
    if (body.text.startsWith('OLD')) return Response.json({ error: 'this live link is older than call turns in the bot: send /live for a new one' }, { status: 409 })
    if (body.text.startsWith('SLOW')) {
      // queued, then nothing until the caller goes away
      return new Response(new ReadableStream({
        start(c) { c.enqueue(line({ type: 'queued' })) },
        cancel() { hungUp++ },
      }), { headers: { 'content-type': 'application/x-ndjson' } })
    }
    return new Response(new ReadableStream({
      start(c) {
        c.enqueue(line({ type: 'started' }))
        c.enqueue(line({ type: 'step', label: '🔎 Searched the history' }))
        c.enqueue(line({ type: 'text', text: 'From the bot.' }))
        c.enqueue(line({ type: 'done', isError: false }))
        c.close()
      },
    }), { headers: { 'content-type': 'application/x-ndjson' } })
  },
})

type Client = { ws: WebSocket; got: any[]; all: any[]; wait: (pred: (m: any) => boolean, ms?: number) => Promise<any> }
let port = 0
async function client(): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const got: any[] = [], all: any[] = []
  const waiters: { pred: (m: any) => boolean; res: (m: any) => void }[] = []
  ws.onmessage = e => {
    if (typeof e.data !== 'string') return
    const m = JSON.parse(e.data); got.push(m); all.push(m)
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m) }
  }
  const wait = (pred: (m: any) => boolean, t = 8000) => new Promise<any>((res, rej) => {
    const hit = got.find(pred); if (hit) return res(hit)
    waiters.push({ pred, res }); setTimeout(() => rej(new Error(`timed out; got ${JSON.stringify(got.map(m => m.type))}`)), t)
  })
  await new Promise(r => (ws.onopen = r))
  ws.send(JSON.stringify({ type: 'auth', uuid: UUID, device: 'device-bot-turn-aaaaaaaaaaaa' }))
  return { ws, got, all, wait }
}

let server: ChildProcess
let A: Client
beforeAll(async () => {
  writeFileSync(LINKS, JSON.stringify({ [UUID]: { key: '-100777:12', desk: '-100777:99', cwd: TMP, created: new Date().toISOString(), user: { id: 1, name: 'Tester' } } }))
  const env: NodeJS.ProcessEnv = { ...process.env, LIVE_TOPICS_EVERY_MS: '60000', LIVE_PORT: '0', LIVE_TTS: 'off', LIVE_LINKS_FILE: LINKS, LIVE_CALLS_DIR: join(TMP, 'calls'), CLAUDE_BIN: '/nonexistent/claude', LIVE_FAST: '0' }
  delete env.SONIOX_API_KEY; delete env.LIVE_API_SOCK; delete env.LIVE_API_TOKEN_FILE
  server = spawn(process.execPath, ['run', join(import.meta.dir, '..', 'live', 'server.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  port = await new Promise<number>((res, rej) => {
    let buf = ''
    server.stdout!.on('data', d => { buf += d; const m = buf.match(/127\.0\.0\.1:(\d+)/); if (m) res(Number(m[1])) })
    setTimeout(() => rej(new Error(`server did not start: ${buf}`)), 10000)
  })
  A = await client()
  expect(await A.wait(m => m.type === 'ready')).toMatchObject({ desk: true })
})
afterAll(() => { server?.kill('SIGKILL'); bot.stop(true) })

test('a request goes to the bot, with the link and the voice instructions; its answer comes back', async () => {
  A.ws.send(JSON.stringify({ type: 'text', text: 'What is on the list?' }))
  const working = await A.wait(m => m.type === 'working')
  expect(await A.wait(m => m.type === 'tool')).toMatchObject({ req: working.req, label: '🔎 Searched the history' })
  expect(await A.wait(m => m.type === 'bot')).toEqual({ type: 'bot', req: working.req, text: 'From the bot.' })
  await A.wait(m => m.type === 'turn_end' && m.req === working.req)
  expect(asked[0].auth).toBe(`Bearer ${TOKEN}`)
  expect(asked[0].body).toMatchObject({ link: UUID, text: 'What is on the list?', model: 'sonnet' })
  expect(asked[0].body.voice).toContain('VOICE call')
})

test('the stop button hangs up on the bot, which stops the run there', async () => {
  A.got.length = 0
  A.ws.send(JSON.stringify({ type: 'text', text: 'SLOW one' }))
  expect((await A.wait(m => m.type === 'status')).text).toContain('busy with another turn')
  const working = await A.wait(m => m.type === 'working')
  A.ws.send(JSON.stringify({ type: 'interrupt' }))
  await A.wait(m => m.type === 'turn_end' && m.req === working.req && m.stopped)
  for (let i = 0; i < 40 && !hungUp; i++) await Bun.sleep(50)
  expect(hungUp).toBe(1)
})

test('what the bot refuses is said on the page', async () => {
  A.got.length = 0
  A.ws.send(JSON.stringify({ type: 'text', text: 'OLD link' }))
  expect((await A.wait(m => m.type === 'status')).text).toContain('send /live for a new one')
  const working = await A.wait(m => m.type === 'working')
  await A.wait(m => m.type === 'turn_end' && m.req === working.req)
})

test('what runs in the group shows on the page: the runs going on, their steps and their end', async () => {
  const snap = A.all.find(m => m.type === 'work' && m.runs)
  expect(events).not.toBeNull()
  expect(snap.runs[0]).toMatchObject({ id: 'r0', topic: 'Backend', what: 'Fix the login page' })
  push({ kind: 'run', chat: '-100777', id: 'r1', topic: 'Docs', what: 'Write the notes', at: Date.now() })
  expect((await A.wait(m => m.type === 'work' && m.run?.id === 'r1')).run).toMatchObject({ topic: 'Docs', what: 'Write the notes' })
  push({ kind: 'step', chat: '-100777', id: 'r1', step: '🔧 Bash: ls' })
  expect(await A.wait(m => m.type === 'work_step')).toMatchObject({ id: 'r1', step: '🔧 Bash: ls' })
  push({ kind: 'run_end', chat: '-100777', id: 'r1', ok: true, stopped: false })
  expect(await A.wait(m => m.type === 'work_end')).toMatchObject({ id: 'r1', ok: true })
})

test('a notice from the bot is shown, then asked of the front desk on its own, and its answer comes back', async () => {
  A.got.length = 0
  const n = asked.length
  push({ kind: 'notice', chat: '-100777', handoff: 'h-42', topic: 'Backend', ok: true, line: 'Fixed the login page' })
  expect(await A.wait(m => m.type === 'notice')).toMatchObject({ topic: 'Backend', ok: true, line: 'Fixed the login page' })
  const working = await A.wait(m => m.type === 'working')
  expect(working.said).toBe('🔔 Backend: done')
  expect(await A.wait(m => m.type === 'bot')).toMatchObject({ req: working.req, text: 'The login page is fixed.' })
  await A.wait(m => m.type === 'turn_end' && m.req === working.req)
  expect(asked[n].body).toMatchObject({ link: UUID, notice: 'h-42' })
  expect(asked[n].body.text).toBeUndefined()
})

test('a notice waits while the page still plays the answer before it, instead of cutting it off', async () => {
  A.ws.send(JSON.stringify({ type: 'playing', on: true }))
  await Bun.sleep(100)
  A.got.length = 0
  const n = asked.length
  push({ kind: 'notice', chat: '-100777', handoff: 'h-43', topic: 'Backend', ok: true, line: 'Fixed the login page' })
  await A.wait(m => m.type === 'notice')   // shown (and chimed) at once
  await Bun.sleep(600)
  expect(A.got.some(m => m.type === 'working')).toBe(false)
  expect(asked.length).toBe(n)
  A.ws.send(JSON.stringify({ type: 'playing', on: false }))
  const working = await A.wait(m => m.type === 'working')
  expect(working.said).toBe('🔔 Backend: done')
  await A.wait(m => m.type === 'turn_end' && m.req === working.req)
  expect(asked[n].body).toMatchObject({ notice: 'h-43' })
})

test('the desk turning the mic off reaches the page, never for more than 3 minutes', async () => {
  A.got.length = 0
  push({ kind: 'mic', chat: '-100777', ms: 60_000 })
  expect(await A.wait(m => m.type === 'mic')).toEqual({ type: 'mic', on: false, ms: 60_000 })
  A.got.length = 0
  push({ kind: 'mic', chat: '-100777', ms: 3_600_000 })
  expect(await A.wait(m => m.type === 'mic')).toEqual({ type: 'mic', on: false, ms: 180_000 })
  A.got.length = 0
  push({ kind: 'mic', chat: '-100777' })
  expect(await A.wait(m => m.type === 'mic')).toEqual({ type: 'mic', on: false, ms: 0 })
})

test("a call with a front desk gets the group's topics, again soon after a run starts or ends", async () => {
  const first = A.all.find(m => m.type === 'topics')
  expect(first).toMatchObject({ live: 99, origin: 12 })
  expect(first.topics.map((t: any) => t.name)).toEqual(['Live', 'Backend', 'General'])
  const n = topicsAsked, seen = A.all.filter(m => m.type === 'topics').length
  push({ kind: 'run', chat: '-100777', id: 'r9', topic: 'Docs', what: 'Write more', at: Date.now() })
  push({ kind: 'run_end', chat: '-100777', id: 'r9', ok: true, stopped: false })
  for (let i = 0; i < 40 && A.all.filter(m => m.type === 'topics').length === seen; i++) await Bun.sleep(50)
  expect(topicsAsked).toBe(n + 1)   // both events, one fetch
})

test('the topic open on the page goes with each request, so "this" means that one', async () => {
  A.ws.send(JSON.stringify({ type: 'view', topic: 'General' }))
  A.ws.send(JSON.stringify({ type: 'view', topic: 'nonsense' }))   // ignored
  A.got.length = 0
  const n = asked.length
  A.ws.send(JSON.stringify({ type: 'text', text: 'What is here?' }))
  const working = await A.wait(m => m.type === 'working' && m.said === 'What is here?')
  await A.wait(m => m.type === 'turn_end' && m.req === working.req)
  expect(asked[n].body).toMatchObject({ text: 'What is here?', viewing: 'General' })
  A.ws.send(JSON.stringify({ type: 'view', topic: 12 }))
  A.got.length = 0
  A.ws.send(JSON.stringify({ type: 'text', text: 'And here?' }))
  const w2 = await A.wait(m => m.type === 'working' && m.said === 'And here?')
  await A.wait(m => m.type === 'turn_end' && m.req === w2.req)
  expect(asked.at(-1)!.body).toMatchObject({ viewing: 12 })
})

test('an open call keeps its link alive: the link says when it was last used', () => {
  const l = JSON.parse(readFileSync(LINKS, 'utf8'))[UUID]
  expect(Date.now() - Date.parse(l.used)).toBeLessThan(60_000)
})

test('opening a topic brings its messages; typing into it goes to the bot as the person, and a refusal comes back', async () => {
  A.got.length = 0
  A.ws.send(JSON.stringify({ type: 'view', topic: 12 }))
  A.ws.send(JSON.stringify({ type: 'view', topic: 'General' }))
  A.ws.send(JSON.stringify({ type: 'view', topic: 12 }))
  const m = await A.wait(m => m.type === 'messages' && m.topic === 12)
  expect(m.messages[0]).toMatchObject({ from: 'Tester', text: 'Fix the login page' })
  A.ws.send(JSON.stringify({ type: 'type', topic: 12, text: '  Also the signup page  ' }))
  expect(await A.wait(m => m.type === 'typed')).toEqual({ type: 'typed', topic: 12, ok: true })
  expect(typed.at(-1)).toEqual({ link: UUID, topic: 12, text: 'Also the signup page' })
  A.got.length = 0
  A.ws.send(JSON.stringify({ type: 'type', topic: 12, text: 'REFUSE' }))
  expect(await A.wait(m => m.type === 'typed')).toMatchObject({ ok: false, error: expect.stringContaining('no longer exists') })
  A.ws.send(JSON.stringify({ type: 'type', topic: 'nope', text: 'x' }))   // not a topic: ignored
  await Bun.sleep(200)
  expect(typed.length).toBe(2)
})

test('a run starting is passed on with its topic id, for the page to light it up', async () => {
  A.got.length = 0
  push({ kind: 'run', chat: '-100777', id: 'r10', topic: 'Docs', thread: 31, what: 'Write', at: Date.now() })
  expect((await A.wait(m => m.type === 'work' && m.run?.id === 'r10')).run).toMatchObject({ thread: 31, topic: 'Docs' })
})

test('the front desk opening a topic reaches the page; the page can load a topic ahead of opening it', async () => {
  A.got.length = 0
  push({ kind: 'show', chat: '-100777', topic: 31 })
  expect(await A.wait(m => m.type === 'show')).toEqual({ type: 'show', topic: 31 })
  A.ws.send(JSON.stringify({ type: 'fetch', topic: 44 }))
  expect(await A.wait(m => m.type === 'messages' && m.topic === 44)).toMatchObject({ messages: [expect.objectContaining({ text: 'Fix the login page' })] })
})

test("a topic's photo is served with the key of a page that is open, not with the link itself", async () => {
  const pk = A.all.find(m => m.type === 'ready').pk
  expect(pk).toMatch(/^[0-9a-f-]{36}$/)
  const ok = await fetch(`http://127.0.0.1:${port}/photo/${pk}/12/5`)
  expect(ok.status).toBe(200)
  expect(await ok.text()).toBe('PHOTO 12/5')
  expect((await fetch(`http://127.0.0.1:${port}/photo/${UUID}/12/5`)).status).toBe(404)   // a leaked link opens no photos
  expect((await fetch(`http://127.0.0.1:${port}/icon/123`)).status).toBe(404)
})

// --- what the security audit asked for ---
async function bare(o: { origin?: string } = {}): Promise<{ ws: WebSocket; got: any[]; closed: Promise<number> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, o.origin ? { headers: { origin: o.origin } } as any : undefined)
  const got: any[] = []
  ws.onmessage = e => { if (typeof e.data === 'string') got.push(JSON.parse(e.data)) }
  const closed = new Promise<number>(r => { ws.onclose = e => r(e.code) })
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  return { ws, got, closed }
}
test('"__proto__" and other names that are on every object are no link', async () => {
  for (const uuid of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const c = await bare()
    c.ws.send(JSON.stringify({ type: 'auth', uuid, device: 'attacker-device-0000000000' }))
    await c.closed
    expect(c.got.map(m => m.type)).toContain('denied')
  }
})
test('a second sign-in on one connection closes it', async () => {
  const c = await bare()
  c.ws.send(JSON.stringify({ type: 'auth', uuid: UUID, device: 'device-bot-turn-aaaaaaaaaaaa' }))
  for (let i = 0; i < 40 && !c.got.some(m => m.type === 'ready'); i++) await Bun.sleep(50)
  c.ws.send(JSON.stringify({ type: 'auth', uuid: UUID, device: 'device-bot-turn-aaaaaaaaaaaa' }))
  await c.closed
  expect(c.got.filter(m => m.type === 'ready').length).toBe(1)
})
test("another site's page can't open a call; the page's own can", async () => {
  await expect(bare({ origin: 'https://evil.example' })).rejects.toBeDefined()
  const ok = await bare({ origin: `http://127.0.0.1:${port}` })
  ok.ws.close()
})
test('the page allows only itself: its scripts carry a nonce, the libraries come from here, no outside images', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/${UUID}`)
  const csp = r.headers.get('content-security-policy')!
  const nonce = csp.match(/'nonce-([0-9a-f]+)'/)![1]
  expect(csp).toContain(`img-src 'self' data: blob:`)
  expect(csp).toContain(`connect-src 'self'`)
  expect(csp).toContain(`frame-ancestors 'none'`)
  const html = await r.text()
  expect(html).not.toContain('cdn.jsdelivr.net')
  expect((html.match(/<script\b[^>]*>/g) ?? []).every(t => t.includes(`nonce="${nonce}"`))).toBe(true)
  const lib = await fetch(`http://127.0.0.1:${port}/vendor/purify.min.js`)
  expect(lib.status).toBe(200)
  expect(await lib.text()).toContain('DOMPurify')
  expect((await fetch(`http://127.0.0.1:${port}/vendor/../server.ts`)).headers.get('content-type')).toContain('text/html')   // only the two files
})
test('typed text past 20000 characters is refused; the links file is private to this user', async () => {
  A.got.length = 0
  A.ws.send(JSON.stringify({ type: 'text', text: 'x'.repeat(20_001) }))
  expect((await A.wait(m => m.type === 'status')).text).toContain('too long')
  expect(statSync(LINKS).mode & 0o777).toBe(0o600)
})

test("what waits on the link's owner is told on the call and shown; someone else's is not", async () => {
  A.got.length = 0
  const n = asked.length
  push({ kind: 'wait', chat: '-100777', thread: 12, topic: 'Backend', id: 'w1', person: '1', what: 'permission' })
  expect(await A.wait(m => m.type === 'ask')).toMatchObject({ topic: 'Backend', thread: 12, id: 'w1', what: 'permission' })
  const working = await A.wait(m => m.type === 'working' && m.said === '❗ Backend: asks for permission')
  expect(await A.wait(m => m.type === 'bot' && m.req === working.req)).toMatchObject({ text: 'Backend asks to delete the build folder.' })
  await A.wait(m => m.type === 'turn_end' && m.req === working.req)
  expect(asked[n].body).toMatchObject({ link: UUID, ask: 'w1' })
  A.got.length = 0
  push({ kind: 'wait', chat: '-100777', thread: 12, topic: 'Backend', id: 'w2', person: '2', what: 'questions' })
  await Bun.sleep(300)
  expect(A.got.some(m => m.type === 'ask')).toBe(false)
  expect(asked.length).toBe(n + 1)
})

test('answers and Stop from the page go to the bot; a refusal comes back', async () => {
  A.got.length = 0
  A.ws.send(JSON.stringify({ type: 'answer', id: 'w1', allow: true }))
  expect(await A.wait(m => m.type === 'answered')).toMatchObject({ id: 'w1', ok: true, message: 'Allowed.' })
  A.ws.send(JSON.stringify({ type: 'answer', id: 'q1', answers: [2, [1, 3], 'my own words'] }))
  await A.wait(m => m.type === 'answered' && m.id === 'q1')
  expect(acted.at(-1)).toEqual({ path: '/v1/live/answer', body: { link: UUID, id: 'q1', answers: [2, [1, 3], 'my own words'] } })
  A.ws.send(JSON.stringify({ type: 'answer', id: 'gone', allow: false }))
  expect(await A.wait(m => m.type === 'answered' && m.id === 'gone')).toMatchObject({ ok: false, error: expect.stringContaining('answered already') })
  A.ws.send(JSON.stringify({ type: 'stop_run', run: 'job-abc' }))
  await A.wait(m => m.type === 'stopped_run')
  expect(acted.at(-1)).toEqual({ path: '/v1/live/stop', body: { link: UUID, run: 'job-abc' } })
})
