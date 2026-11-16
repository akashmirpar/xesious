// live/server.ts: the page is told how much of its audio arrived, a page gone quiet
// has its call closed, and a stopped server records each call's end.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'xesious-live-stale-'))
const LINKS = join(TMP, 'live-links.json'), CALLS = join(TMP, 'calls')
const UUID = '7f1c2a9e-0000-4000-8000-0000000000aa', DEV = 'device-stale-aaaaaaaaaaaaaaaa'
let server: ChildProcess, port = 0

async function start(): Promise<void> {
  server = spawn(process.execPath, ['run', join(import.meta.dir, '..', 'live', 'server.ts')], {
    env: { ...process.env, LIVE_PORT: '0', LIVE_TTS: 'off', LIVE_LINKS_FILE: LINKS, LIVE_CALLS_DIR: CALLS, SONIOX_API_KEY: '', LIVE_STALE_MS: '800' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  port = await new Promise<number>((res, rej) => {
    let buf = ''
    server.stdout!.on('data', d => { buf += d; const m = buf.match(/127\.0\.0\.1:(\d+)/); if (m) res(Number(m[1])) })
    setTimeout(() => rej(new Error(`server did not start: ${buf}`)), 10000)
  })
}
beforeAll(async () => {
  writeFileSync(LINKS, JSON.stringify({ [UUID]: { key: 'chat:topic', cwd: TMP, created: new Date().toISOString(), permission: ['--permission-mode', 'auto'] } }))
  await start()
})
afterAll(() => { server?.kill('SIGKILL') })

async function page() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const got: any[] = []
  let closed = false
  ws.onmessage = e => { if (typeof e.data === 'string') got.push(JSON.parse(e.data)) }
  ws.onclose = () => { closed = true }
  await new Promise(r => (ws.onopen = r))
  ws.send(JSON.stringify({ type: 'auth', uuid: UUID, device: DEV }))
  for (let i = 0; i < 100 && !got.some(m => m.type === 'ready'); i++) await Bun.sleep(20)
  return { ws, got, closed: () => closed }
}
const newestTrace = () => {
  const d = readdirSync(CALLS).sort().at(-1)!
  return readFileSync(join(CALLS, d, 'trace.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
}

test('each second of audio that arrives is acknowledged, counting the whole call', async () => {
  const p = await page()
  for (let i = 0; i < 25; i++) p.ws.send(new Uint8Array(3200))   // 2.5 s
  for (let i = 0; i < 50 && p.got.filter(m => m.type === 'heard').length < 2; i++) await Bun.sleep(20)
  expect(p.got.filter(m => m.type === 'heard').map(m => m.s)).toEqual([1, 2])
  p.ws.close()
})

test('a page that sends nothing has its call closed and ended; one that pings stays', async () => {
  const quiet = await page(), alive = await page()
  const ping = setInterval(() => alive.ws.send(JSON.stringify({ type: 'ping' })), 200)
  try {
    for (let i = 0; i < 150 && !quiet.closed(); i++) await Bun.sleep(20)
    expect(quiet.closed()).toBe(true)
    expect(alive.closed()).toBe(false)
  } finally { clearInterval(ping) }
  alive.ws.close()
  await Bun.sleep(100)
  const all = readdirSync(CALLS).sort().map(d => readFileSync(join(CALLS, d, 'trace.jsonl'), 'utf8'))
  const closedOne = all.find(t => t.includes('nothing from the page for'))!
  expect(closedOne).toBeDefined()
  expect(closedOne.trim().split('\n').at(-1)).toContain('"msg":"ended"')
}, 10000)

test('a server told to stop records the end of each open call', async () => {
  const p = await page()
  const pinging = setInterval(() => { try { p.ws.send(JSON.stringify({ type: 'ping' })) } catch {} }, 200)
  await Bun.sleep(100)
  const exited = new Promise(r => server.once('exit', r))
  server.kill('SIGTERM')
  await exited
  clearInterval(pinging)
  const t = newestTrace()
  expect(t.map(l => l.msg).slice(-2)).toEqual(['server stopping (SIGTERM)', 'ended'])
})
