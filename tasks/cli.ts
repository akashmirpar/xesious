#!/usr/bin/env bun
/**
 * cli.ts — `xesious` for scripts and system cron on the bot's host: post into a chat
 * or topic, and list, pause or resume tasks. A thin client of the bridge's local API,
 * with the operator token from state/xesious.token (readable only by the bot's user).
 *
 *   bun tasks/cli.ts send --chat <id> [--topic <id or name>] [--silent] <text…>
 *   bun tasks/cli.ts tasks list [--chat <id>]
 *   bun tasks/cli.ts tasks pause <task id>
 *   bun tasks/cli.ts tasks resume <task id>
 *
 * XESIOUS_DIR points at the bot's folder when the script runs from elsewhere. Like the
 * bot, it finds the socket and the token next to TG_STATE_FILE, or the socket at
 * TG_API_SOCKET (bun reads them from the .env of the folder it runs in).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { callApi } from './api'

const ROOT = process.env.XESIOUS_DIR || join(import.meta.dir, '..')
const STATE = process.env.TG_STATE_FILE ? dirname(process.env.TG_STATE_FILE) : join(ROOT, 'state')
const SOCK = process.env.TG_API_SOCKET || join(STATE, 'xesious.sock')
const TOKEN_FILE = join(STATE, 'xesious.token')

const USAGE = `usage:
  xesious send --chat <id> [--topic <id or name>] [--silent] <text…>
  xesious tasks list [--chat <id>]
  xesious tasks pause <task id>
  xesious tasks resume <task id>`

export function parseArgs(argv: string[]): { cmd: string[]; flags: Record<string, string | true>; rest: string[] } {
  const flags: Record<string, string | true> = {}
  const pos: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--silent') flags.silent = true
    else if (a.startsWith('--')) { flags[a.slice(2)] = argv[i + 1] ?? ''; i++ }
    else pos.push(a)
  }
  const cmd = pos[0] === 'tasks' ? pos.slice(0, 2) : pos.slice(0, 1)
  return { cmd, flags, rest: pos.slice(cmd.length) }
}

async function main(): Promise<number> {
  const { cmd, flags, rest } = parseArgs(process.argv.slice(2))
  if (!cmd.length) { console.error(USAGE); return 2 }
  if (!existsSync(SOCK) || !existsSync(TOKEN_FILE)) {
    console.error(`the bot isn't running here, or tasks are off (no ${SOCK})`)
    return 1
  }
  const token = readFileSync(TOKEN_FILE, 'utf8').trim()
  let r: { status: number; body: any }
  switch (cmd.join(' ')) {
    case 'send': {
      const text = rest.join(' ').trim()
      if (!flags.chat || !text) { console.error(USAGE); return 2 }
      r = await callApi(SOCK, token, 'POST', '/v1/send', { chat: String(flags.chat), topic: flags.topic === undefined ? undefined : String(flags.topic), text, silent: flags.silent === true })
      break
    }
    case 'tasks list':
      r = await callApi(SOCK, token, 'GET', `/v1/tasks${flags.chat ? `?chat=${encodeURIComponent(String(flags.chat))}` : ''}`)
      if (r.status < 400) {
        for (const t of r.body.tasks ?? []) console.log(`${t.id}  ${t.state.padEnd(7)}  ${t.name} — ${t.schedule}${t.next_run ? ` · next ${t.next_run}` : ''}`)
        return 0
      }
      break
    case 'tasks pause':
    case 'tasks resume':
      if (!rest[0]) { console.error(USAGE); return 2 }
      r = await callApi(SOCK, token, 'POST', `/v1/tasks/${encodeURIComponent(rest[0])}/${cmd[1]}`, {})
      break
    default:
      console.error(USAGE)
      return 2
  }
  if (r.status >= 400) { console.error(`error: ${r.body?.error ?? r.status}`); return 1 }
  if (r.body?.message) console.log(r.body.message)
  return 0
}

if (import.meta.main) process.exit(await main())
