import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { TokenRegistry, startApi, reply, fail, type Scope } from './api'
import { negotiate, routeOf, toolsFor } from './mcp'
import { parseArgs } from './cli'

const dir = mkdtempSync(join(tmpdir(), 'xesious-mcp-'))
const sock = join(dir, 'x.sock')
const tokens = new TokenRegistry()
const calls: { scope: Scope; method: string; path: string; body: any }[] = []
let api: ReturnType<typeof startApi>

beforeAll(() => {
  const record = (status: number, body: any) => (scope: Scope, q: any) => { calls.push({ scope, method: q.method, path: q.path, body: q.body }); return reply(status, body) }
  api = startApi({
    socket: sock, tokens,
    routes: [
      { method: 'POST', path: '/v1/tasks', handler: (s, q) => q.body.tz ? record(201, { message: 'Created.', task: { id: 'ab12cd' } })(s, q) : fail(400, 'tz is required') },
      { method: 'POST', path: '/v1/report', handler: record(200, { recorded: true }) },
      { method: 'GET', path: '/v1/tasks/:id', handler: record(200, { task: { id: 'self' } }) },
    ],
  })
})
afterAll(() => { api.stop(); rmSync(dir, { recursive: true, force: true }) })

// The real server, as the CLI would start it.
function server(kind: 'interactive' | 'scheduled', scope: Scope) {
  const token = tokens.mint(scope)
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [join(import.meta.dir, 'mcp.ts')], {
    env: { ...process.env, XESIOUS_API_SOCK: sock, XESIOUS_API_TOKEN: token, XESIOUS_RUN_KIND: kind },
  }) as any
  let buf = ''
  const waiting = new Map<number, (v: any) => void>()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d: string) => {
    buf += d
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1)
      waiting.get(msg.id)?.(msg); waiting.delete(msg.id)
    }
  })
  let n = 0
  const rpc = (method: string, params?: any) => new Promise<any>(res => {
    const id = ++n
    waiting.set(id, res)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  return { rpc, close: () => child.kill() }
}

describe('the tasks MCP server', () => {
  test('answers with a protocol version it implements, never an unknown one echoed back', async () => {
    expect(negotiate('2025-11-25')).toBe('2025-11-25')
    expect(negotiate('2025-06-18')).toBe('2025-06-18')
    expect(negotiate('2026-07-28')).toBe('2025-11-25')
    expect(negotiate(undefined)).toBe('2025-11-25')
    const s = server('interactive', { kind: 'run', chat: '-100777', person: '1', runKind: 'interactive' })
    const r = await s.rpc('initialize', { protocolVersion: '2026-07-28' })
    expect(r.result.protocolVersion).toBe('2025-11-25')
    expect(r.result.serverInfo.name).toBe('xesious-tasks')
    // The newer clients' stateless discovery isn't spoken; they fall back to initialize.
    expect((await s.rpc('server/discover')).error.code).toBe(-32601)
    s.close()
  })

  test('a person\'s run gets the task and topic tools; a scheduled run gets report, notify and its own task', async () => {
    const a = server('interactive', { kind: 'run', chat: '-100777', person: '1', runKind: 'interactive' })
    const names = (await a.rpc('tools/list')).result.tools.map((t: any) => t.name)
    expect(names).toEqual(['task_create', 'task_list', 'task_get', 'task_update', 'task_pause', 'task_resume', 'task_delete', 'task_run_now', 'topic_list', 'topic_create', 'topic_rename', 'topic_set_cwd', 'handoff'])
    a.close()
    expect(toolsFor('scheduled').map(t => t.name)).toEqual(['task_create', 'task_propose', 'report', 'ask', 'notify', 'task_get', 'task_pause', 'task_done', 'handoff'])
    // approve is there only for a run that is the permission host, where Claude Code calls it.
    expect(toolsFor('interactive', true).map(t => t.name).at(-1)).toBe('approve')
    expect(toolsFor('scheduled', true).map(t => t.name).at(-1)).toBe('approve')
    // The descriptions steer away from the CLI's own to-do list and session crons.
    expect(toolsFor('interactive')[0].description).toContain('NOT TaskCreate')
    expect(toolsFor('interactive')[0].description).toContain('CronCreate')
  })

  test('a tool call goes to the socket with the run\'s token, and an API error comes back as a tool error', async () => {
    const scope: Scope = { kind: 'run', chat: '-100777', thread: 5, person: '1', runKind: 'interactive' }
    const s = server('interactive', scope)
    const ok = await s.rpc('tools/call', { name: 'task_create', arguments: { tz: 'UTC', message: 'm', in_minutes: 5 } })
    expect(ok.result.isError).toBeUndefined()
    expect(ok.result.content[0].text).toContain('Created.')
    expect(calls.at(-1)).toMatchObject({ scope, method: 'POST', path: '/v1/tasks', body: { tz: 'UTC', message: 'm', in_minutes: 5 } })
    const bad = await s.rpc('tools/call', { name: 'task_create', arguments: { message: 'm' } })
    expect(bad.result.isError).toBe(true)
    expect(bad.result.content[0].text).toBe('Error: tz is required')
    const unknown = await s.rpc('tools/call', { name: 'report', arguments: {} })
    expect(unknown.result.isError).toBe(true)
    s.close()
  })

  test('a scheduled run\'s calls name its own task', async () => {
    const s = server('scheduled', { kind: 'run', chat: '-100777', runKind: 'scheduled', taskId: 'ab12cd', runId: 'ab12cd@1' })
    await s.rpc('tools/call', { name: 'report', arguments: { outcome: 'done', notify: true, summary: 'ok' } })
    expect(calls.at(-1)).toMatchObject({ path: '/v1/report', body: { outcome: 'done', notify: true, summary: 'ok' } })
    await s.rpc('tools/call', { name: 'task_get', arguments: {} })
    expect(calls.at(-1)!.path).toBe('/v1/tasks/self')
    // An id reaches the bridge, which lets it read only a task this one watches.
    await s.rpc('tools/call', { name: 'task_get', arguments: { id: 'zzz' } })
    expect(calls.at(-1)!.path).toBe('/v1/tasks/zzz')
    // What changes a task names its own, whatever it is given.
    expect(routeOf('task_pause', { id: 'zzz' }, 'scheduled').path).toBe('/v1/tasks/self/pause')
    expect(routeOf('task_done', { id: 'zzz' }, 'scheduled').path).toBe('/v1/tasks/self/done')
    s.close()
  })
})

test('which endpoint each tool calls', () => {
  expect(routeOf('task_update', { id: 'a b', name: 'x' }, 'interactive')).toEqual({ method: 'PATCH', path: '/v1/tasks/a%20b', body: { name: 'x' } })
  expect(routeOf('task_list', { where: 'chat' }, 'interactive')).toEqual({ method: 'GET', path: '/v1/tasks?where=chat' })
  expect(routeOf('topic_set_cwd', { path: '/srv/x' }, 'interactive')).toEqual({ method: 'PATCH', path: '/v1/topics/this', body: { cwd: '/srv/x' } })
  expect(routeOf('task_done', {}, 'scheduled')).toEqual({ method: 'POST', path: '/v1/tasks/self/done', body: {} })
})

test('the CLI reads its flags', () => {
  expect(parseArgs(['send', '--chat', '-100777', '--topic', 'Deploys', '--silent', 'Build', 'done'])).toEqual({
    cmd: ['send'], flags: { chat: '-100777', topic: 'Deploys', silent: true }, rest: ['Build', 'done'],
  })
  expect(parseArgs(['tasks', 'pause', 'ab12cd'])).toEqual({ cmd: ['tasks', 'pause'], flags: {}, rest: ['ab12cd'] })
})

test('the CLI reads its words and its flags', () => {
  expect(parseArgs(['ask', '--chat', '-100', '--options', 'Yes,No', 'Ship', 'it?'])).toEqual({ cmd: ['ask'], flags: { chat: '-100', options: 'Yes,No' }, rest: ['Ship', 'it?'] })
  expect(parseArgs(['run', '--no-wait', '--chat', '1', 'go'])).toEqual({ cmd: ['run'], flags: { 'no-wait': true, chat: '1' }, rest: ['go'] })
  expect(parseArgs(['fire', 'ab12cd', 'v1'])).toEqual({ cmd: ['fire'], flags: {}, rest: ['ab12cd', 'v1'] })
})
