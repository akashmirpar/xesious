#!/usr/bin/env bun
/**
 * mcp.ts — the bot's own tools for Claude: tasks (things the bot does later or on a
 * schedule and reports in Telegram) and the chat's topics. The CLI starts one for each
 * run, next to the history server, through --mcp-config.
 *
 * A thin client of the bridge's local API (api.ts): every call goes to the socket with
 * this run's token, and the bridge decides what that token may touch. The chat and
 * topic come from the token, never from arguments.
 *
 *   XESIOUS_API_SOCK   the bridge's socket
 *   XESIOUS_API_TOKEN  this run's token
 *   XESIOUS_RUN_KIND   interactive (a person's message) or scheduled (a task's own run)
 *
 * The same minimal JSON-RPC over stdio as context/mcp.ts.
 */
import { callApi } from './api'

const SOCK = process.env.XESIOUS_API_SOCK || ''
const TOKEN = process.env.XESIOUS_API_TOKEN || ''
const KIND = process.env.XESIOUS_RUN_KIND === 'scheduled' ? 'scheduled' : 'interactive'

// Versions this server implements: tools only, which every one of them has. Answer
// with one of these, never by echoing whatever a newer client asks for.
const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
export const negotiate = (asked?: string) => (asked && SUPPORTED.includes(asked) ? asked : SUPPORTED[0])

const WHEN_PROPS = {
  in_minutes: { type: 'number', description: 'Run once, this many minutes from now.' },
  at: { type: 'string', description: 'Run once at this local time in tz, "YYYY-MM-DD HH:MM".' },
  every_minutes: { type: 'number', description: 'Run again and again, this many minutes apart.' },
  start: { type: 'string', description: 'With every_minutes: the first run, "YYYY-MM-DD HH:MM" in tz (default: one interval from now).' },
  cron: { type: 'string', description: 'A five-field cron expression, read in tz: "7 21 * * *" every day at 21:07, "7 9 * * 1-5" weekdays at 09:07, "0 10 * * 6" Saturdays at 10:00.' },
}

const WATCH_PROPS = {
  watch: {
    type: 'object',
    description: "Instead of a time: watch something, with a small program in this topic's folder that the bot runs for you. Write the program first and run it once yourself to show it works and what it prints; then give its command here. " +
      "Every line it prints is an event, so print one line per thing worth knowing and nothing else (JSON or text; flush each line: python print(..., flush=True)). Errors go to stderr. " +
      "With every_minutes the bot runs it that often and it should print what it finds and exit (a page, an API). Without, the bot keeps it running (a websocket, a stream): it should reconnect by itself. " +
      "The bot restarts it if it dies, and tells the topic if it keeps failing. Keep it light: heavy work belongs in the prompt.",
    properties: {
      command: { type: 'string', description: 'Run with bash in this topic\'s folder, e.g. "python3 watchers/price.py".' },
      every_minutes: { type: 'number', description: 'Run it this often (at least 1), instead of keeping it running.' },
    },
    required: ['command'],
  },
  keep_running: { type: 'boolean', description: 'With watch, and neither message nor prompt: just keep the program running ("keep the sync loop running"); only its failures are reported.' },
  cooldown_minutes: { type: 'number', description: "For a watcher: at least this long between runs (default 5 for a prompt, 1 for a message). Events that come meanwhile are folded into the next run." },
  max_per_hour: { type: 'number', description: 'For a watcher: at most this many runs an hour (default 6 for a prompt, 20 for a message).' },
  stale_minutes: { type: 'number', description: 'For a watcher: events older than this are dropped, e.g. after a restart (default 10).' },
  rule: {
    type: 'object',
    description: 'For a watcher: only events that pass this test start a run; free and exact, so prefer it to an AI filter where it can decide. ' +
      'op: above or below (every event past value); crosses_above or crosses_below (once, when it goes past value, and again only after it came back); ' +
      'change_pct (moved at least value % within window_minutes, either way, e.g. 1 within 3); changed (differs from the last one); contains (any of words, any case); matches (a regular expression, any case). ' +
      'field: a JSON path into the line ("price", "data.last") when the watcher prints JSON; without it the whole line, and for the number tests the first number in it. Give null to remove it.',
    properties: {
      op: { type: 'string', enum: ['above', 'below', 'crosses_above', 'crosses_below', 'change_pct', 'changed', 'contains', 'matches'] },
      field: { type: 'string' },
      value: { type: 'number' },
      window_minutes: { type: 'number' },
      words: { type: 'array', items: { type: 'string' } },
      pattern: { type: 'string' },
    },
    required: ['op'],
  },
  watch_tasks: {
    type: 'array', items: { type: 'string' },
    description: 'With a prompt: other tasks in this chat (ids or names) whose runs since the last run come with each run, so it can check on them. ' +
      'A watchdog ("each morning check the backup and the sync tasks, tell me only if something is off"): it says noteworthy by default, so it speaks only when something looks wrong. Also for a summary written by Claude ("every evening, sum up what the news tasks found").',
  },
  digest: {
    type: 'object',
    description: 'Instead of message, prompt or script: a list of what other tasks did since the last digest, made without Claude: their runs, results, failures, what watchers saw. Posted silently. ' +
      'of: task ids or names; leave it out for every other task in this topic. Give it a schedule ("every evening at 21:07"). For a summary written by Claude instead, give a prompt with watch_tasks.',
    properties: { of: { type: 'array', items: { type: 'string' } } },
  },
  ai_filter: {
    type: 'object',
    description: 'For a watcher, for what no rule can decide: every every_minutes (default 5) a small model reads the events that came (after the rule, if there is one) and lets through only those that answer question yes, each with why. ' +
      'One small call per batch, and only when events came. For noisy feeds: "Does this suggest a major cloud outage is starting, not commentary or old news?" Give null to remove it.',
    properties: { question: { type: 'string' }, every_minutes: { type: 'number' } },
    required: ['question'],
  },
}

const TASK_FIELDS = {
  name: { type: 'string', description: "A short name for the task's card, e.g. 'Nightly news'." },
  message: { type: 'string', description: 'For a reminder: the exact text the bot sends at the time. For a watcher: the text sent for each event: {event} is the line the watcher printed, {value} what its rule looked at, {why} why it passed.' },
  prompt: { type: 'string', description: "For work Claude does when the task runs: a complete, self-contained instruction. The run starts without this conversation, in this topic's folder and with its instructions. For a watcher, the events that set it off come with the run." },
  script: {
    type: 'object',
    description: "Instead of message or prompt: a command the bot runs, with no AI, for work a command does (a backup, a sync, a health check). Run with bash in this topic's folder; status 0 is success. " +
      'What it prints is posted as says decides: result (the default) posts its output; noteworthy only when it printed something; problems only when it fails (every failure, loud); never nothing. ' +
      'It gets $XESIOUS_CLI (bun "$XESIOUS_CLI" notify "halfway" posts in this topic) and, set off by a watcher, $XESIOUS_EVENTS, a JSON file of the events.',
    properties: {
      command: { type: 'string', description: 'e.g. "bash scripts/backup.sh"' },
      timeout_minutes: { type: 'number', description: 'Stopped after this long (default 30, at most 240).' },
    },
    required: ['command'],
  },
  ...WHEN_PROPS,
  ...WATCH_PROPS,
  tz: { type: 'string', description: "The person's IANA time zone, e.g. Europe/Berlin. Work it out from what you know of them and this conversation; if you can't tell, ask them before creating the task." },
  session: { type: 'string', enum: ['fresh', 'own'], description: "For a Claude run. fresh (the default): each run starts without memory of earlier runs. own: the task keeps one session across its runs, for tasks that must remember what they did before (\"don't repeat yesterday's topics\")." },
  says: { type: 'string', enum: ['live', 'result', 'noteworthy', 'problems', 'never'], description: 'For a Claude run, how much it posts. live: its progress and the answer. result (the default): the answer. noteworthy: only when the run reports something worth telling (for checks and monitors). problems: only failures. never: nothing, only history.' },
  sound: { type: 'string', enum: ['loud', 'silent'], description: 'loud notifies; silent posts without a sound. Default: loud for reminders and for noteworthy or problems; for results, silent in groups and loud in a private chat.' },
  deliver_to: { type: 'string', enum: ['topic', 'dm'], description: "Where it posts: this topic (the default) or the person's private chat with the bot." },
  until: { type: 'string', description: 'Optional: no runs after this local time, "YYYY-MM-DD HH:MM" in tz. Only when the person wants it to end; give an empty string to remove an end.' },
  times: { type: 'number', description: 'Optional: stop after this many runs.' },
}

const id = { id: { type: 'string', description: 'The task id, from task_list or the card.' } }
const topicRef = { type: 'string', description: "A topic's id or name, from topic_list. Leave out for this topic." }

const INTERACTIVE_TOOLS = [
  {
    name: 'task_create',
    description: "Create a task: something this bot does on its own later, again and again, or when something happens, and reports here in Telegram. Use it whenever the person wants something to happen later, on a schedule or on a change: \"remind me in two hours to…\", \"every night at 9, summarize the news\", \"tell me when the price drops below 300\", \"keep the sync running\". This is the bot's scheduler. It is NOT TaskCreate or TodoWrite, which are your private to-do list for this turn and do nothing later; and don't use CronCreate or /loop for this either. " +
      'Give message for a reminder (the bot sends exactly that text), or prompt for work Claude should do each time it runs. ' +
      "For the time give exactly one of in_minutes, at, every_minutes or cron, and let the bot do the date arithmetic. When the person gives an approximate time (\"around 9\", \"every morning\"), choose an off-minute such as 09:07 rather than 09:00. " +
      'To act when something happens, give watch instead of a time: a program you write that prints a line for each thing worth knowing. ' +
      "Afterwards the bot posts the task's card with its details and buttons, so keep your own reply to one short line.",
    inputSchema: { type: 'object', properties: { ...TASK_FIELDS, topic: { type: 'string', description: "Optional: the topic it lives in (id or name, from topic_list; \"General\" too), when not this one. It posts there and runs in that topic's folder." } }, required: ['tz'] },
  },
  {
    name: 'task_list',
    description: "List the bot's tasks: in this topic (the default) or in the whole chat, with each one's schedule, next run and last result.",
    inputSchema: { type: 'object', properties: { where: { type: 'string', enum: ['topic', 'chat'] } } },
  },
  { name: 'task_get', description: "One task's definition and its last runs.", inputSchema: { type: 'object', properties: id, required: ['id'] } },
  {
    name: 'task_update',
    description: "Change a task: its id, and only what changes (the same fields as task_create). A new time replaces the old schedule. Use this when the person asks to change a task (\"make it 10:00\", \"make it silent\", \"only tell me if something is wrong\").",
    inputSchema: { type: 'object', properties: { ...id, ...TASK_FIELDS }, required: ['id'] },
  },
  { name: 'task_pause', description: 'Pause a task: it stops running until someone resumes it.', inputSchema: { type: 'object', properties: id, required: ['id'] } },
  { name: 'task_resume', description: 'Resume a paused task. It continues from now; runs it missed while paused are not made up.', inputSchema: { type: 'object', properties: id, required: ['id'] } },
  { name: 'task_delete', description: 'Delete a task.', inputSchema: { type: 'object', properties: id, required: ['id'] } },
  { name: 'task_run_now', description: 'Run a task once now, as a test or because the person asked; its schedule is unchanged.', inputSchema: { type: 'object', properties: id, required: ['id'] } },
  {
    name: 'topic_list',
    description: "List this chat's forum topics that the bot knows: id, name, working folder, permission mode and model.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'topic_create',
    description: "Create a forum topic in this chat for a new piece of work, so the person doesn't have to make it by hand. Optional cwd: an absolute path to an existing folder it works in (default: a new folder of its own). Optional like: a topic (id or name) whose settings to copy.",
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, cwd: { type: 'string' }, like: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'topic_rename',
    description: 'Rename a forum topic in this chat.',
    inputSchema: { type: 'object', properties: { topic: topicRef, name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'topic_set_cwd',
    description: "Set a topic's working folder: an absolute path to an existing folder. Its conversation then starts fresh in that folder, as with /cwd. For this topic itself, the change takes effect after this turn.",
    inputSchema: { type: 'object', properties: { topic: topicRef, path: { type: 'string' } }, required: ['path'] },
  },
]

const SCHEDULED_TOOLS = [
  {
    name: 'report',
    description: "Say what this run found or did, once, before you finish. notify: true to post it (the bot posts text if you give one, otherwise your summary), false to stay silent, for example when a check found nothing new. Whether anything is posted also follows the task's own setting, and failures are reported by the bot itself. outcome: nothing_new, done, progress, blocked (you couldn't do it; say why in the summary) or needs_attention.",
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['nothing_new', 'done', 'progress', 'blocked', 'needs_attention'] },
        notify: { type: 'boolean' },
        summary: { type: 'string', description: 'One line on what this run found or did; it goes in the run history.' },
        text: { type: 'string', description: 'Optional: the full message to post, when notify is true. Without it the bot posts your final answer.' },
      },
      required: ['outcome', 'notify', 'summary'],
    },
  },
  {
    name: 'ask',
    description: "Ask the person a question and wait for the answer, when you can't go on without them: a choice, a missing detail, a go-ahead. Posted in the task's topic, mentioning its owner; options become buttons, and they can also reply in their own words. " +
      "You get the answer back here if it comes within wait_minutes (at most 10). If it doesn't, stop: call report with outcome blocked, saying what you are waiting for. The task then carries on from where you stopped, in this session, when they answer (up to a day later; after that default is used if you gave one).",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, description: 'Up to 8 short answers to choose from.' },
        default: { type: 'string', description: 'Used if nobody answers within a day.' },
        wait_minutes: { type: 'number', description: 'How long to wait here, 1 to 10 (default 10).' },
      },
      required: ['question'],
    },
  },
  {
    name: 'notify',
    description: "Post a short message in this task's topic now, in the middle of the run: a milestone or a warning. Your final result is posted by the bot, so don't repeat it here.",
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, silent: { type: 'boolean' } }, required: ['text'] },
  },
  { name: 'task_get', description: "This task's own definition and its last runs; with id, one of the tasks it watches.", inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Leave out for this task.' } } } },
  { name: 'task_pause', description: 'Pause this task until a person resumes it, for example when what it watches no longer exists.', inputSchema: { type: 'object', properties: {} } },
  { name: 'task_done', description: "Finish this task for good: its work is complete and it shouldn't run again.", inputSchema: { type: 'object', properties: {} } },
]

export const toolsFor = (kind: 'interactive' | 'scheduled') => (kind === 'scheduled' ? SCHEDULED_TOOLS : INTERACTIVE_TOOLS)

const enc = encodeURIComponent

// Which endpoint each tool calls.
export function routeOf(name: string, a: any, kind: 'interactive' | 'scheduled'): { method: string; path: string; body?: unknown } {
  const self = kind === 'scheduled'
  const tid = self ? 'self' : enc(String(a.id ?? ''))
  const { id: _drop, ...rest } = a ?? {}
  switch (name) {
    case 'task_create': return { method: 'POST', path: '/v1/tasks', body: rest }
    case 'task_list': return { method: 'GET', path: `/v1/tasks${a?.where ? `?where=${enc(a.where)}` : ''}` }
    case 'task_get': return { method: 'GET', path: `/v1/tasks/${self && a?.id ? enc(String(a.id)) : tid}` }
    case 'task_update': return { method: 'PATCH', path: `/v1/tasks/${tid}`, body: rest }
    case 'task_pause': return { method: 'POST', path: `/v1/tasks/${tid}/pause`, body: {} }
    case 'task_resume': return { method: 'POST', path: `/v1/tasks/${tid}/resume`, body: {} }
    case 'task_delete': return { method: 'DELETE', path: `/v1/tasks/${tid}` }
    case 'task_run_now': return { method: 'POST', path: `/v1/tasks/${tid}/run`, body: {} }
    case 'task_done': return { method: 'POST', path: '/v1/tasks/self/done', body: {} }
    case 'report': return { method: 'POST', path: '/v1/report', body: a }
    case 'notify': return { method: 'POST', path: '/v1/notify', body: a }
    case 'ask': return { method: 'POST', path: '/v1/ask', body: a }
    case 'topic_list': return { method: 'GET', path: '/v1/topics' }
    case 'topic_create': return { method: 'POST', path: '/v1/topics', body: a }
    case 'topic_rename': return { method: 'PATCH', path: `/v1/topics/${enc(String(a?.topic ?? 'this'))}`, body: { name: a?.name } }
    case 'topic_set_cwd': return { method: 'PATCH', path: `/v1/topics/${enc(String(a?.topic ?? 'this'))}`, body: { cwd: a?.path } }
  }
  throw new Error(`unknown tool ${name}`)
}

async function call(name: string, args: any): Promise<{ text: string; isError: boolean }> {
  if (!toolsFor(KIND).some(t => t.name === name)) throw new Error(`unknown tool ${name}`)
  if (!SOCK || !TOKEN) throw new Error('the tasks server was started without the bridge socket or a token')
  const r = routeOf(name, args ?? {}, KIND)
  const res = await callApi(SOCK, TOKEN, r.method, r.path, r.body)
  if (res.status >= 400) return { text: `Error: ${res.body?.error ?? `HTTP ${res.status}`}`, isError: true }
  const { message, ...rest } = res.body ?? {}
  return { text: [message, JSON.stringify(rest)].filter(Boolean).join('\n'), isError: false }
}

const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg
  if (id === undefined) return
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: negotiate(params?.protocolVersion), capabilities: { tools: {} }, serverInfo: { name: 'xesious-tasks', version: '1.0.0' } } })
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: toolsFor(KIND) } })
    } else if (method === 'tools/call') {
      const r = await call(params?.name, params?.arguments ?? {})
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) } })
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} })
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
    }
  } catch (e) {
    if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${(e as Error)?.message ?? e}` }], isError: true } })
    else send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e) } })
  }
}

if (import.meta.main) {
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d: string) => {
    buf += d
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg: any
      try { msg = JSON.parse(line) } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue }
      void handle(msg)
    }
  })
  process.stdin.on('end', () => process.exit(0))
}
