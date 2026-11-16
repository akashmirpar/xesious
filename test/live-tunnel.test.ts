// live/tunnel.ts against stand-ins: a fake live server (a tiny Bun server that prints
// the real one's start line) and a fake cloudflared (prints a trycloudflare address
// and the registration line, then waits). Nothing reaches Cloudflare.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLive, liveState, stopLive, serverDown, type LiveOpts } from '../live/tunnel'

const TMP = mkdtempSync(join(tmpdir(), 'xesious-tunnel-'))
const SERVER = join(TMP, 'fake-server.ts')
writeFileSync(SERVER, `
const s = Bun.serve({ port: Number(process.env.LIVE_PORT || 0), hostname: '127.0.0.1',
  fetch: r => new URL(r.url).pathname === '/health' ? new Response('ok') : new Response('page') })
console.log('[live] voice server on http://127.0.0.1:' + s.port + '  links=x')
setInterval(() => {}, 1e9)
`)
const CF = join(TMP, 'cloudflared')
writeFileSync(CF, `#!/bin/sh
echo "INF Requesting new quick Tunnel on trycloudflare.com..." >&2
echo "INF |  https://fake-$$.trycloudflare.com  |" >&2
echo "INF Registered tunnel connection connIndex=0" >&2
while :; do sleep 1; done
`)
chmodSync(CF, 0o755)
const BROKEN = join(TMP, 'broken-cloudflared')
writeFileSync(BROKEN, `#!/bin/sh\necho "ERR failed to request quick Tunnel: 429 Too Many Requests" >&2\nexit 1\n`)
chmodSync(BROKEN, 0o755)

const STATE = join(TMP, 'state.json')
let reachable = true
const checked: string[] = []
const opts = (o: Partial<LiveOpts> = {}): LiveOpts => ({
  stateFile: STATE, logDir: TMP, serverCmd: [process.execPath, 'run', SERVER], serverCwd: TMP,
  serverEnv: { ...process.env }, cloudflared: CF, timeoutMs: 8000,
  check: async u => { checked.push(u); return reachable }, published: async () => true, ...o,
})
afterAll(() => { stopLive(STATE); rmSync(TMP, { recursive: true, force: true }) })

test('starts the server and a tunnel, and gives the tunnel address', async () => {
  const r = await ensureLive(opts())
  expect(r).toMatchObject({ fresh: true })
  const s = liveState(STATE)
  expect((r as any).url).toBe(s.url)
  expect(s.url).toMatch(/^https:\/\/fake-\d+\.trycloudflare\.com$/)
  expect(s.port).toBeGreaterThan(0)
  expect(await (await fetch(`http://127.0.0.1:${s.port}/health`)).text()).toBe('ok')
})

test('a second /live reuses what runs — same address, nothing restarted', async () => {
  const before = liveState(STATE)
  const r = await ensureLive(opts())
  expect(r).toEqual({ url: before.url!, fresh: false })
  expect(liveState(STATE)).toEqual(before)
})

test('two at once share one bring-up', async () => {
  stopLive(STATE)
  const [a, b] = await Promise.all([ensureLive(opts()), ensureLive(opts())])
  expect(a).toEqual(b)
})

test('a dead tunnel is replaced; the server is kept', async () => {
  const before = liveState(STATE)
  process.kill(-before.tunnelPid!, 'SIGKILL')
  await Bun.sleep(100)
  const r = await ensureLive(opts())
  const after = liveState(STATE)
  expect(after.serverPid).toBe(before.serverPid)
  expect(after.tunnelPid).not.toBe(before.tunnelPid)
  expect((r as any).url).toBe(after.url)
})

test('a dead server comes back on its port, behind the same tunnel — links already sent keep working', async () => {
  const before = liveState(STATE)
  process.kill(-before.serverPid!, 'SIGKILL')
  await Bun.sleep(100)
  expect(serverDown(STATE)).toBe(true)
  const r = await ensureLive(opts())
  const after = liveState(STATE)
  expect(serverDown(STATE)).toBe(false)
  expect(after.serverPid).not.toBe(before.serverPid)
  expect(after.port).toBe(before.port)
  expect(after.tunnelPid).toBe(before.tunnelPid)
  expect((r as any).url).toBe(before.url)
})

test('a tunnel that fails to start says why', async () => {
  stopLive(STATE)
  const r = await ensureLive(opts({ cloudflared: BROKEN }))
  expect((r as any).error).toContain('429 Too Many Requests')
})

test('a page that never answers through the tunnel is an error, not a link', async () => {
  stopLive(STATE)
  reachable = false
  try {
    const r = await ensureLive(opts({ timeoutMs: 1500 }))
    expect((r as any).error).toContain('does not answer')
  } finally { reachable = true }
})
