import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TokenRegistry, startApi, callApi, loadOperatorToken, reply, fail, type Scope } from './api'

const dir = mkdtempSync(join(tmpdir(), 'xesious-api-'))
const sock = join(dir, 'x.sock')
const tokens = new TokenRegistry()
const seen: { scope: Scope; params: any; body: any; query: string }[] = []
let api: ReturnType<typeof startApi>
let runToken = ''
let opToken = ''

beforeAll(() => {
  opToken = loadOperatorToken(join(dir, 'xesious.token'))
  tokens.addOperator(opToken)
  runToken = tokens.mint({ kind: 'run', chat: '-100777', thread: 5, person: '1', runKind: 'interactive' })
  api = startApi({
    socket: sock, tokens,
    routes: [
      { method: 'GET', path: '/v1/tasks/:id', handler: (scope, q) => { seen.push({ scope, params: q.params, body: q.body, query: q.query.toString() }); return reply(200, { id: q.params.id }) } },
      { method: 'POST', path: '/v1/tasks', handler: (scope, q) => { seen.push({ scope, params: q.params, body: q.body, query: '' }); return reply(201, { got: q.body }) } },
      { method: 'POST', path: '/v1/send', operatorOnly: true, handler: () => reply(200, { sent: true }) },
      { method: 'GET', path: '/v1/boom', handler: () => { throw new Error('kaboom') } },
      { method: 'GET', path: '/v1/no', handler: () => fail(409, 'not now') },
    ],
  })
})
afterAll(() => { api.stop(); rmSync(dir, { recursive: true, force: true }) })

describe('the local API', () => {
  test('the socket and the operator token are readable only by the bot\'s user', () => {
    expect(statSync(sock).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'xesious.token')).mode & 0o777).toBe(0o600)
    expect(loadOperatorToken(join(dir, 'xesious.token'))).toBe(opToken)
    expect(readFileSync(join(dir, 'xesious.token'), 'utf8').trim()).toBe(opToken)
  })

  test('no token, or an unknown one: 401', async () => {
    expect((await callApi(sock, '', 'GET', '/v1/tasks/abc')).status).toBe(401)
    expect((await callApi(sock, 'nope', 'GET', '/v1/tasks/abc')).status).toBe(401)
  })

  test("a run's token reaches its handler with the run's scope; path params are decoded", async () => {
    const r = await callApi(sock, runToken, 'GET', '/v1/tasks/a%20b?where=topic')
    expect(r).toEqual({ status: 200, body: { id: 'a b' } })
    const last = seen.at(-1)!
    expect(last.scope).toEqual({ kind: 'run', chat: '-100777', thread: 5, person: '1', runKind: 'interactive' })
    expect(last.query).toBe('where=topic')
  })

  test('JSON bodies in, JSON out, with the handler\'s status', async () => {
    expect(await callApi(sock, runToken, 'POST', '/v1/tasks', { name: 'x' })).toEqual({ status: 201, body: { got: { name: 'x' } } })
    expect((await callApi(sock, runToken, 'GET', '/v1/no')).body).toEqual({ error: 'not now' })
  })

  test('a revoked token stops working', async () => {
    const t = tokens.mint({ kind: 'run', chat: '-100777' })
    expect((await callApi(sock, t, 'GET', '/v1/tasks/x')).status).toBe(200)
    tokens.revoke(t)
    expect((await callApi(sock, t, 'GET', '/v1/tasks/x')).status).toBe(401)
  })

  test('operator-only endpoints refuse a run token', async () => {
    expect((await callApi(sock, runToken, 'POST', '/v1/send', {})).status).toBe(403)
    expect((await callApi(sock, opToken, 'POST', '/v1/send', {})).status).toBe(200)
  })

  test('errors: unknown path 404, wrong method 405, bad JSON 400, a handler that throws 500', async () => {
    expect((await callApi(sock, runToken, 'GET', '/v1/nowhere')).status).toBe(404)
    expect((await callApi(sock, runToken, 'DELETE', '/v1/tasks/x')).status).toBe(405)
    const bad = await fetch('http://local/v1/tasks', { unix: sock, method: 'POST', headers: { authorization: `Bearer ${runToken}` }, body: '{nope' } as any)
    expect(bad.status).toBe(400)
    const boom = await callApi(sock, runToken, 'GET', '/v1/boom')
    expect(boom.status).toBe(500)
    expect(boom.body.error).toContain('kaboom')
  })
})
