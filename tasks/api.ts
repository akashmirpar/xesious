/**
 * api.ts — the bridge's local API: HTTP with JSON bodies on a Unix socket
 * (state/xesious.sock, readable only by the bot's user). The per-run MCP server and
 * the `xesious` CLI are thin clients of it, so every change to tasks and topics goes
 * through the bridge, its only writer.
 *
 * Every request carries a bearer token, and the token decides what the request may
 * touch. A run's token is minted when the run starts and revoked when it ends; it is
 * scoped to that run's chat, topic and person, so a tool call can't reach another
 * chat's tasks whatever arguments it passes. The operator token, in a file only the
 * bot's user can read, is for scripts on the host.
 *
 * Tokens limit reach and say who did what. They are not a wall around a model that
 * already has a shell as the same Unix user: the bridge's allowlist is that wall.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

export interface Scope {
  kind: 'run' | 'operator'
  chat?: string
  thread?: number
  person?: string
  personName?: string
  runKind?: 'interactive' | 'scheduled'
  taskId?: string        // a scheduled run: the task it belongs to
  runId?: string
  hub?: boolean          // a turn in the group's 🗂 Tasks topic, where every topic's tasks are managed
  jobId?: string         // the bridge's job for this run, so a wait on a person can hold its watchdog
}

export class TokenRegistry {
  private map = new Map<string, Scope>()
  mint(scope: Scope): string {
    const token = randomBytes(24).toString('hex')
    this.map.set(token, scope)
    return token
  }
  revoke(token: string | undefined): void { if (token) this.map.delete(token) }
  lookup(token: string | undefined): Scope | undefined { return token ? this.map.get(token) : undefined }
  addOperator(token: string): void { this.map.set(token, { kind: 'operator' }) }
  get size(): number { return this.map.size }
}

// The operator token, created on first start. Mode 0600, like the socket.
export function loadOperatorToken(path: string): string {
  if (existsSync(path)) {
    const t = readFileSync(path, 'utf8').trim()
    if (t) return t
  }
  mkdirSync(dirname(path), { recursive: true })
  const t = randomBytes(24).toString('hex')
  writeFileSync(path, t + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
  return t
}

export interface ApiRequest {
  method: string
  path: string
  params: Record<string, string>
  query: URLSearchParams
  body: any
}
export interface ApiReply { status: number; body: unknown }
export type ApiHandler = (scope: Scope, req: ApiRequest) => Promise<ApiReply> | ApiReply

export interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string               // '/v1/tasks/:id/pause'
  handler: ApiHandler
  operatorOnly?: boolean
}

const MAX_BODY = 256 * 1024

interface Compiled { method: string; re: RegExp; names: string[]; route: Route }
function compile(r: Route): Compiled {
  const names: string[] = []
  const re = new RegExp('^' + r.path.replace(/:([a-zA-Z]+)/g, (_, n) => { names.push(n); return '([^/]+)' }) + '$')
  return { method: r.method, re, names, route: r }
}

export const reply = (status: number, body: unknown): ApiReply => ({ status, body })
export const fail = (status: number, error: string): ApiReply => ({ status, body: { error } })

export interface ApiServer { stop(): void; readonly socket: string }

export function startApi(opts: { socket: string; tokens: TokenRegistry; routes: Route[]; log?: (s: string) => void }): ApiServer {
  const routes = opts.routes.map(compile)
  mkdirSync(dirname(opts.socket), { recursive: true })
  // A socket left by a bridge that died is just a file now; a live one would be ours.
  if (existsSync(opts.socket)) unlinkSync(opts.socket)
  const server = Bun.serve({
    unix: opts.socket,
    async fetch(req) {
      const url = new URL(req.url, 'http://local')
      const auth = req.headers.get('authorization') ?? ''
      const scope = opts.tokens.lookup(auth.replace(/^Bearer\s+/i, '').trim())
      if (!scope) return Response.json({ error: 'unknown or expired token' }, { status: 401 })
      const hit = routes.map(r => ({ r, m: r.method === req.method ? url.pathname.match(r.re) : null })).find(x => x.m)
      if (!hit) {
        const pathKnown = routes.some(r => r.re.test(url.pathname))
        return Response.json({ error: pathKnown ? `${req.method} not allowed here` : `no such endpoint: ${url.pathname}` }, { status: pathKnown ? 405 : 404 })
      }
      if (hit.r.route.operatorOnly && scope.kind !== 'operator') return Response.json({ error: 'operator token required' }, { status: 403 })
      let body: any = undefined
      if (req.method === 'POST' || req.method === 'PATCH') {
        const text = await req.text()
        if (text.length > MAX_BODY) return Response.json({ error: 'request body too large' }, { status: 413 })
        if (text.trim()) {
          try { body = JSON.parse(text) } catch { return Response.json({ error: 'body is not JSON' }, { status: 400 }) }
        }
      }
      const params: Record<string, string> = {}
      hit.r.names.forEach((n, i) => { params[n] = decodeURIComponent(hit.m![i + 1]) })
      try {
        const out = await hit.r.route.handler(scope, { method: req.method, path: url.pathname, params, query: url.searchParams, body: body ?? {} })
        return Response.json(out.body ?? {}, { status: out.status })
      } catch (e) {
        opts.log?.(`[api] ${req.method} ${url.pathname} failed: ${e}`)
        return Response.json({ error: String((e as Error)?.message ?? e) }, { status: 500 })
      }
    },
  })
  try { chmodSync(opts.socket, 0o600) } catch { /* not every platform lets a socket be chmod-ed */ }
  return {
    socket: opts.socket,
    stop() {
      server.stop(true)
      try { if (existsSync(opts.socket)) unlinkSync(opts.socket) } catch {}
    },
  }
}

// A client for the socket: what the MCP server and the CLI use.
export async function callApi(socket: string, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://local${path}`, {
    unix: socket, method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  } as any)
  const text = await res.text()
  let parsed: any = {}
  try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { error: text } }
  return { status: res.status, body: parsed }
}
