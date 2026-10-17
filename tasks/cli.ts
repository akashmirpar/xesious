#!/usr/bin/env bun
/**
 * cli.ts — `xesious` for scripts and system cron on the bot's host: post into a chat
 * or topic, and list, pause or resume tasks. A thin client of the bridge's local API,
 * with the operator token from state/xesious.token (readable only by the bot's user).
 *
 *   bun tasks/cli.ts send --chat <id> [--topic <id or name>] [--silent] <text…>
 *   bun tasks/cli.ts notify [--silent] <text…>     (from a task's script: into its topic)
 *   bun tasks/cli.ts ask --chat <id> [--topic <t>] [--options a,b] [--wait <minutes>] <question…>
 *       prints the answer; exits with the option's number (0 for the first; 0 for an answer in
 *       one's own words), or 124 if nobody answered in time
 *   bun tasks/cli.ts run --chat <id> [--topic <t>] [--no-wait] <prompt…>   (a turn there; prints its result)
 *   bun tasks/cli.ts fire <task id> [payload…]       (runs that task now, given the payload)
 *   bun tasks/cli.ts tasks list [--chat <id>]
 *   bun tasks/cli.ts tasks pause <task id>
 *   bun tasks/cli.ts tasks resume <task id>
 *
 * XESIOUS_DIR points at the bot's folder when the script runs from elsewhere. Like the
 * bot, it finds the socket and the token next to TG_STATE_FILE, or the socket at
 * TG_API_SOCKET (bun reads them from the .env of the folder it runs in). A task's script
 * is given its own run's socket and token instead (XESIOUS_API_SOCK, XESIOUS_API_TOKEN).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { callApi } from './api'

const ROOT = process.env.XESIOUS_DIR || join(import.meta.dir, '..')
const STATE = process.env.TG_STATE_FILE ? dirname(process.env.TG_STATE_FILE) : join(ROOT, 'state')
const SOCK = process.env.XESIOUS_API_SOCK || process.env.TG_API_SOCKET || join(STATE, 'xesious.sock')
const TOKEN_FILE = join(STATE, 'xesious.token')

const USAGE = `usage:
  xesious send --chat <id> [--topic <id or name>] [--silent] <text…>
  xesious notify [--silent] <text…>        (from a task's script)
  xesious ask --chat <id> [--topic <t>] [--options a,b] [--wait <minutes>] <question…>
  xesious run --chat <id> [--topic <t>] [--no-wait] <prompt…>
  xesious fire <task id> [payload…]
  xesious tasks list [--chat <id>]
  xesious tasks pause <task id>
  xesious tasks resume <task id>`

export function parseArgs(argv: string[]): { cmd: string[]; flags: Record<string, string | true>; rest: string[] } {
  const flags: Record<string, string | true> = {}
  const pos: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--silent' || a === '--no-wait') flags[a.slice(2)] = true
    else if (a.startsWith('--')) { flags[a.slice(2)] = argv[i + 1] ?? ''; i++ }
    else pos.push(a)
  }
  const cmd = pos[0] === 'tasks' ? pos.slice(0, 2) : pos.slice(0, 1)
  return { cmd, flags, rest: pos.slice(cmd.length) }
}

async function main(): Promise<number> {
  const { cmd, flags, rest } = parseArgs(process.argv.slice(2))
  if (!cmd.length) { console.error(USAGE); return 2 }
  const runToken = process.env.XESIOUS_API_TOKEN
  if (!existsSync(SOCK) || (!runToken && !existsSync(TOKEN_FILE))) {
    console.error(`the bot isn't running here, or tasks are off (no ${SOCK})`)
    return 1
  }
  const token = runToken || readFileSync(TOKEN_FILE, 'utf8').trim()
  let r: { status: number; body: any }
  switch (cmd.join(' ')) {
    case 'send': {
      const text = rest.join(' ').trim()
      if (!flags.chat || !text) { console.error(USAGE); return 2 }
      r = await callApi(SOCK, token, 'POST', '/v1/send', { chat: String(flags.chat), topic: flags.topic === undefined ? undefined : String(flags.topic), text, silent: flags.silent === true })
      break
    }
    case 'ask': {
      const question = rest.join(' ').trim()
      if (!flags.chat || !question) { console.error(USAGE); return 2 }
      const options = typeof flags.options === 'string' ? flags.options.split(',').map(o => o.trim()).filter(Boolean) : []
      r = await callApi(SOCK, token, 'POST', '/v1/ask', { chat: String(flags.chat), topic: flags.topic === undefined ? undefined : String(flags.topic), question, options, wait_minutes: flags.wait === undefined ? undefined : Number(flags.wait) })
      if (r.status === 408) { console.error('nobody answered in time'); return 124 }
      if (r.status < 400) { console.log(r.body.answer); return r.body.index > 0 ? r.body.index : 0 }
      break
    }
    case 'run': {
      const prompt = rest.join(' ').trim()
      if (!flags.chat || !prompt) { console.error(USAGE); return 2 }
      r = await callApi(SOCK, token, 'POST', '/v1/run', { chat: String(flags.chat), topic: flags.topic === undefined ? undefined : String(flags.topic), prompt, wait: flags['no-wait'] !== true })
      if (r.status === 200) { console.log(r.body.result ?? ''); if (r.body.state !== 'done') { console.error(`it ${r.body.state}: ${r.body.error ?? ''}`); return 1 } return 0 }
      break
    }
    case 'fire': {
      const id = rest[0]
      if (!id) { console.error(USAGE); return 2 }
      r = await callApi(SOCK, token, 'POST', `/v1/tasks/${encodeURIComponent(id)}/fire`, { payload: rest.slice(1).join(' ') })
      break
    }
    case 'notify': {
      const text = rest.join(' ').trim()
      if (!text) { console.error(USAGE); return 2 }
      r = await callApi(SOCK, token, 'POST', '/v1/notify', { text, silent: flags.silent === true })
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
