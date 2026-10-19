/**
 * render.ts — what tasks look like in Telegram: schedules in words, the card, a line
 * of /tasks, and run history. Pure functions returning Telegram HTML, so each
 * wording is tested without a bot.
 *
 * Times are written in the task's zone and wrapped in <tg-time>, which Telegram shows
 * in each reader's own zone and language; the written text is what older apps show.
 */
import { eventLimits, type Run, type RunMark, type Step, type StepResult, type Task, type Trigger, type Usage } from './model'
import { runsPerDay } from './schedule'
import { ruleText } from './filters'

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function parts(d: Date, tz: string) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d)
  const get = (t: string) => p.find(x => x.type === t)?.value ?? ''
  return { wd: get('weekday'), day: get('day'), mon: get('month'), hm: `${get('hour')}:${get('minute')}` }
}

// "Fri 16 Oct, 21:07" in tz.
export function whenText(d: Date, tz: string): string {
  const p = parts(d, tz)
  return `${p.wd} ${p.day} ${p.mon}, ${p.hm}`
}

// A time each reader sees in their own zone. format: Telegram's r|w?[dD]?[tT]? string.
export function tgTime(d: Date, tz: string, format = 'wdt'): string {
  return `<tg-time unix="${Math.floor(d.getTime() / 1000)}" format="${format}">${esc(whenText(d, tz))}</tg-time>`
}

const pad2 = (n: number) => String(n).padStart(2, '0')

// The schedule in words, for the kinds people actually ask for; anything else shows
// its cron expression rather than a paraphrase that might be wrong.
export function scheduleText(t: Trigger, tz: string): string {
  switch (t.kind) {
    case 'at': return `once, ${whenText(new Date(t.at), tz)}`
    case 'every': return `every ${durationText(t.everyMs)}`
    case 'cron': return cronText(t.expr)
    case 'watch': return t.everyMs ? `checks every ${durationText(t.everyMs)}` : 'watches continuously'
    case 'after': return `after “${t.name}” ${({ success: 'works', noteworthy: 'posts something', failure: 'fails', any: 'runs' } as const)[t.on]}`
    case 'webhook': return 'when fired (xesious fire, or its webhook)'
  }
}

export function cronText(expr: string): string {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return `cron ${expr}`
  const [mi, h, dom, mon, dow] = f
  const fixed = /^\d+$/.test(mi) && /^\d+$/.test(h)
  if (!fixed) {
    if (/^\*\/\d+$/.test(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `every ${mi.slice(2)} minutes`
    if (/^\d+$/.test(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `every hour at :${pad2(Number(mi))}`
    return `cron ${expr}`
  }
  const at = `${pad2(Number(h))}:${pad2(Number(mi))}`
  if (mon !== '*') return `cron ${expr}`
  if (dom === '*' && dow === '*') return `every day at ${at}`
  if (dom === '*' && (dow === '1-5' || dow === 'MON-FRI')) return `weekdays at ${at}`
  if (dom === '*' && (dow === '0,6' || dow === '6,0' || dow === 'SAT,SUN')) return `weekends at ${at}`
  if (dom === '*' && /^[0-7]$/.test(dow)) return `every ${DAY_NAMES[Number(dow) % 7]} at ${at}`
  if (dow === '*' && /^\d+$/.test(dom)) return `on day ${Number(dom)} of each month at ${at}`
  return `cron ${expr}`
}

export function durationText(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min % (24 * 60) === 0) return min === 24 * 60 ? 'day' : `${min / (24 * 60)} days`
  if (min % 60 === 0) return min === 60 ? 'hour' : `${min / 60} hours`
  return min === 1 ? 'minute' : `${min} minutes`
}

// "2 h 5 min", "48 s"
export function elapsedText(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}

// ⏰ Scheduled · 🔔 Reminder · 👀 Watch · 📋 Digest
export function kindLabel(t: Task): string {
  if (t.action.kind === 'digest') return '📋 Digest'
  if (t.action.kind === 'steps') return '🪜 Plan'
  if (t.trigger.kind === 'after') return '↪️ After'
  if (t.trigger.kind === 'webhook') return '🔗 On call'
  if (t.trigger.kind === 'watch') return '👀 Watch'
  return t.action.kind === 'message' ? '🔔 Reminder' : '⏰ Scheduled'
}

const SAYS_TEXT: Record<Task['says'], string> = {
  live: 'shows its progress and posts the answer',
  result: 'posts the result',
  noteworthy: 'posts only when something is worth telling',
  problems: 'posts only problems',
  never: 'posts nothing (history only)',
}

const SCRIPT_SAYS: Record<Task['says'], string> = {
  live: 'posts what it prints',
  result: 'posts what it prints',
  noteworthy: 'posts only when it prints something',
  problems: 'posts only when it fails',
  never: 'posts nothing (history only)',
}

export function actionText(t: Task): string {
  const watch = t.trigger.kind === 'watch'
  if (t.action.kind === 'none') return 'keeps it running; says something only if it fails'
  if (t.action.kind === 'script') return `runs a command${watch ? ' when it sees something' : ''} · ${SCRIPT_SAYS[t.says]}`
  if (t.action.kind === 'digest') return t.action.of.length ? `lists what ${t.action.of.length === 1 ? 'a task' : `${t.action.of.length} tasks`} did, without Claude` : 'lists what the tasks in this topic did, without Claude'
  if (t.action.kind === 'steps') return `runs a plan of ${t.action.steps.length} step${t.action.steps.length === 1 ? '' : 's'} · ${SAYS_TEXT[t.says]}`
  if (t.action.kind === 'message') return watch ? 'sends a message when it sees something' : 'sends a message'
  const session = t.action.session === 'own' ? 'Claude, in its own session (remembers earlier runs)' : 'Claude, a fresh session each run'
  return `${watch ? `${session}, when it sees something` : session} · ${SAYS_TEXT[t.says]}`
}

// "about 5 runs a week" — so the cost of a frequent task is in plain sight. A
// watcher's runs depend on what it sees: its cap is what can be said.
export function frequencyText(t: Task, now = new Date()): string | undefined {
  if (t.trigger.kind === 'watch') {
    if (t.action.kind !== 'claude') return undefined
    const lim = eventLimits(t)
    return `at most ${lim.maxPerHour} run${lim.maxPerHour === 1 ? '' : 's'} an hour, ${elapsedText(lim.cooldownMs)} apart`
  }
  const perDay = runsPerDay(t.trigger, t.tz, now)
  if (perDay === undefined) return undefined
  const runs = (n: number) => `${n} run${n === 1 ? '' : 's'}`
  if (perDay >= 0.95) return `about ${runs(Math.round(perDay))} a day`
  const perWeek = perDay * 7
  if (perWeek >= 0.95) return `about ${runs(Math.round(perWeek))} a week`
  return `about ${runs(Math.max(1, Math.round(perDay * 30)))} a month`
}

export const MARK: Record<RunMark, string> = {
  posted: '✅', quiet: '🔇', blocked: '⚠️', failed: '❌', skipped: '⏭', deferred: '⏳', interrupted: '✂️', running: '⏳', waiting: '❔',
}

export function markOf(r: Run): RunMark {
  switch (r.state) {
    case 'queued': case 'running': return 'running'
    case 'failed': case 'timed_out': return 'failed'
    case 'skipped': return 'skipped'
    case 'deferred': return 'deferred'
    case 'interrupted': case 'canceled': return 'interrupted'
    case 'waiting': return 'waiting'
    case 'succeeded':
      if (r.outcome === 'blocked' || (r.denials?.length && !r.postedMsg)) return 'blocked'
      return r.postedMsg ? 'posted' : 'quiet'
  }
}

export function pauseText(t: Task): string {
  switch (t.pauseReason) {
    case 'failures': return 'paused after failing several times in a row'
    case 'owner': return 'paused: the person it runs as can no longer use this chat'
    case 'review': return 'paused for review'
    default: return 'paused'
  }
}

export function usageText(u: Usage | undefined): string {
  if (!u) return ''
  const bits: string[] = []
  if (u.model) bits.push(u.model.replace(/^claude-/, '').replace(/-\d{8}$/, ''))
  const tokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
  if (tokens) bits.push(tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k tokens` : `${tokens} tokens`)
  if (u.costUsd !== undefined) bits.push(`~$${u.costUsd < 0.01 ? u.costUsd.toFixed(3) : u.costUsd.toFixed(2)}`)
  return bits.join(' · ')
}

// How a streaming watcher is doing, from the supervisor: for the card.
export interface WatchStatus { running: boolean; since?: string }

// The card: one message per task in its home topic, edited when its state changes.
export function cardHtml(t: Task, runs: Run[], now = new Date(), watch?: WatchStatus, related?: string[], flow?: string): string {
  const lines: string[] = []
  lines.push(`${kindLabel(t)}: <b>${esc(t.name)}</b>`)
  const isWatch = t.trigger.kind === 'watch'
  // A watcher's times are its own; a zone means nothing for it.
  const sched = isWatch ? esc(scheduleText(t.trigger, t.tz)) : `${esc(scheduleText(t.trigger, t.tz))} <i>(${esc(t.tz)})</i>`
  const freq = t.action.kind === 'claude' ? frequencyText(t, now) : undefined
  lines.push([sched, esc(actionText(t)), t.action.kind === 'none' ? '' : t.sound === 'loud' ? '🔔 loud' : '🔕 silent', freq ? esc(freq) : ''].filter(Boolean).join(' · '))
  if (t.trigger.kind === 'watch') lines.push(`<code>${esc(clip(t.trigger.command, 200))}</code>`)
  if (t.rule) lines.push(`Only ${esc(ruleText(t.rule))}`)
  if (t.action.kind === 'script') lines.push(`${isWatch ? 'Then runs ' : ''}<code>${esc(clip(t.action.command, 200))}</code>`)
  if (related?.length) lines.push(`${t.action.kind === 'digest' ? 'Lists' : 'Watches'}: ${related.map(n => `<b>${esc(n)}</b>`).join(', ')}`)
  if (t.then) lines.push(`Then hands its result to <b>${esc(t.then.topicName ?? (t.then.thread === undefined ? 'General' : `topic ${t.then.thread}`))}</b>`)
  if (t.parent) lines.push(`Made by the task <b>${esc(t.parentName ?? t.parent)}</b>; it ends when that one does`)
  if (t.action.kind === 'steps') lines.push(...t.action.steps.map((st, i) => esc(stepLine(st, i + 1))))
  if (t.ai) {
    const n = t.filterSeen ? ` · ${t.filterSeen.toLocaleString('en-US')} considered, ${(t.filterPassed ?? 0).toLocaleString('en-US')} let through` : ''
    lines.push(`AI filter every ${esc(durationText(t.ai.everyMs))}: “${esc(clip(t.ai.question, 160))}”${n}`)
    if (t.filterError) lines.push(`⚠️ ${esc(t.filterError)}`)
  }
  if (t.action.kind === 'message') lines.push(`“${esc(t.action.text)}”`)
  if (t.state === 'paused') lines.push(`⏸ ${esc(pauseText(t))}`)
  else if (t.state === 'done') lines.push('✔️ done')
  else if (t.state === 'expired') lines.push('⌛ ended')
  else if (t.state === 'deleted') lines.push('🗑 deleted')
  else if (isWatch) {
    const seen = t.eventsSeen ? ` · ${t.eventsSeen.toLocaleString('en-US')} line${t.eventsSeen === 1 ? '' : 's'}, the last ${esc(whenText(new Date(t.lastEventAt ?? now.toISOString()), t.tz))}` : ''
    if (t.watchError) {
      const again = t.watchRetryAt && Date.parse(t.watchRetryAt) > now.getTime() ? ` · starts again ${tgTime(new Date(t.watchRetryAt), t.tz, 'r')}` : ''
      lines.push(`⚠️ ${esc(clip(t.watchError, 200))}${again}`)
    } else if (t.trigger.kind === 'watch' && t.trigger.everyMs) {
      if (t.nextDue) lines.push(`Next check: ${tgTime(new Date(t.nextDue), t.tz, 'r')}${seen}`)
    } else if (watch?.running) {
      lines.push(`👀 running since ${esc(whenText(new Date(watch.since ?? now.toISOString()), t.tz))}${seen}`)
    } else {
      lines.push('👀 starting')
    }
  } else if (t.nextDue) lines.push(`Next: ${tgTime(new Date(t.nextDue), t.tz)} (${tgTime(new Date(t.nextDue), t.tz, 'r')})`)
  if (t.until && (t.state === 'active' || t.state === 'paused')) lines.push(`Ends ${tgTime(new Date(t.until), t.tz)}`)
  const running = runs.find(r => r.state === 'running')
  if (running) lines.push(`⏳ running since ${esc(whenText(new Date(running.startedAt ?? now.toISOString()), t.tz))}`)
  const waiting = runs.find(r => r.state === 'waiting')
  if (waiting) lines.push(`❔ ${esc(clip(waiting.reason ?? 'waiting for an answer', 200))}`)
  const last = runs.find(r => r.state !== 'queued' && r.state !== 'running')
  if (runs.length) {
    const strip = runs.slice(0, 8).reverse().map(r => MARK[markOf(r)]).join('')
    const lastText = last
      ? `last: ${MARK[markOf(last)]} ${esc(whenText(new Date(last.startedAt ?? last.slot ?? now.toISOString()), t.tz))}${markOf(last) === 'quiet' ? ' · nothing new' : ''}`
      : ''
    lines.push([strip, lastText].filter(Boolean).join('  '))
  }
  if (flow) lines.push(flow)
  return lines.join('\n')
}

// What kind of task it is, at a glance.
export const kindIcon = (t: Task) => t.action.kind === 'steps' ? '🪜' : t.action.kind === 'digest' ? '📋' : t.trigger.kind === 'after' ? '↪️' : t.trigger.kind === 'webhook' ? '🔗' : t.trigger.kind === 'watch' ? '👀' : t.action.kind === 'message' ? '🔔' : '⏰'

// One line of /tasks.
export function listLine(t: Task, runs: Run[]): string {
  const last = runs.find(r => r.state !== 'queued')
  const mark = t.state === 'paused' ? '⏸' : last ? MARK[markOf(last)] : '·'
  const when = t.state === 'active' && t.nextDue && t.trigger.kind !== 'watch' ? ` · next ${tgTime(new Date(t.nextDue), t.tz)}` : t.state === 'paused' ? ' · paused' : ''
  const kind = kindIcon(t)
  // How it links to the rest: where it hands on, who made it.
  const flow = [
    t.then ? ` · then → ${esc(t.then.topicName ?? 'another topic')}` : '',
    t.parent ? ` · made by ${esc(t.parentName ?? t.parent)}` : '',
  ].join('')
  return `${mark} ${kind} <b>${esc(t.name)}</b> — ${esc(scheduleText(t.trigger, t.tz))}${when}${flow}`
}

// What the tasks used, from the 📊 Usage button: one line each, the most first, then
// the hand-offs' runs and the total.
export interface UsageLine { icon: string; name: string; runs: number; usage: Usage; note?: string }
const tokensOf = (u: Usage) => (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
const amountText = (runs: number, u: Usage) => {
  const n = tokensOf(u)
  const tokens = n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M tokens` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k tokens` : `${n} tokens`
  const cost = u.costUsd !== undefined ? ` · ~$${u.costUsd < 0.01 ? u.costUsd.toFixed(3) : u.costUsd.toFixed(2)}` : ''
  return `${runs} run${runs === 1 ? '' : 's'} · ${tokens}${cost}`
}
export function usageListHtml(head: string, lines: UsageLine[], maxChars = 3600): string {
  if (!lines.length) return `${head}

Nothing here used Claude in that time.`
  const sorted = [...lines].sort((a, b) => (b.usage.costUsd ?? 0) - (a.usage.costUsd ?? 0) || tokensOf(b.usage) - tokensOf(a.usage))
  const out = [head, '']
  let len = head.length
  let shown = 0
  for (const l of sorted) {
    const line = `${l.icon} <b>${esc(l.name)}</b>${l.note ? ` <i>(${esc(l.note)})</i>` : ''} · ${amountText(l.runs, l.usage)}`
    if (len + line.length > maxChars - 400) break
    out.push(line)
    len += line.length + 1
    shown++
  }
  if (shown < sorted.length) out.push(`<i>…and ${sorted.length - shown} more.</i>`)
  const runs = lines.reduce((n, l) => n + l.runs, 0)
  const all = lines.reduce<Usage>((s, l) => ({ costUsd: l.usage.costUsd === undefined && s.costUsd === undefined ? undefined : (s.costUsd ?? 0) + (l.usage.costUsd ?? 0),
    inputTokens: (s.inputTokens ?? 0) + tokensOf(l.usage) }), {})
  out.push('', `<b>In all</b>: ${amountText(runs, all)}`,
    "<i>~$ is Claude Code's own estimate at API prices; on a subscription, runs aren't billed one by one. Codex steps and AI filters aren't counted.</i>")
  return out.join('\n')
}

// A list of tasks, numbered: one topic's, or a whole group's under its topics. As
// much as fits in one message; the numbers shown are the ones its buttons open.
export interface TaskSection { title?: string; link?: string; items: { task: Task; runs: Run[] }[] }
export function taskListHtml(head: string, sections: TaskSection[], maxChars = 3600): { html: string; ids: string[]; more: number } {
  const out = [head]
  const ids: string[] = []
  let len = head.length
  let more = 0
  for (const s of sections) {
    const title = s.title ? (s.link ? `<b><a href="${s.link}">${esc(s.title)}</a></b>` : `<b>${esc(s.title)}</b>`) : ''
    let titled = !title
    for (const it of s.items) {
      const line = `${ids.length + 1}. ${listLine(it.task, it.runs)}`
      const add = (titled ? 0 : title.length + 2) + line.length + 1
      if (len + add > maxChars) { more++; continue }
      if (!titled) { out.push('', title); titled = true }
      out.push(line)
      len += add
      ids.push(it.task.id)
    }
  }
  if (more) out.push('', `…and ${more} more`)
  return { html: out.join('\n'), ids, more }
}

export function runLine(r: Run, tz: string): string {
  const at = r.startedAt ?? r.slot
  const bits: string[] = [MARK[markOf(r)], at ? esc(whenText(new Date(at), tz)) : '']
  if (r.trigger === 'manual') bits.push('run now')
  if (r.trigger === 'catchup') bits.push('caught up')
  if (r.trigger === 'event') bits.push((r.folded ?? 1) > 1 ? `${r.folded} events` : 'an event')
  if (r.trigger === 'fired') bits.push('fired')
  if (r.trigger === 'after') bits.push('after another')
  if (r.startedAt && r.endedAt) bits.push(elapsedText(new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime()))
  const u = usageText(r.usage)
  if (u) bits.push(esc(u))
  if (r.state === 'skipped') bits.push(esc(r.reason ?? 'skipped'))
  else if (r.state === 'deferred') bits.push(esc(r.reason ?? 'usage limit'))
  else if (r.state === 'failed' || r.state === 'timed_out' || r.state === 'interrupted' || r.state === 'waiting') bits.push(esc(clip(r.reason ?? r.state, 120)))
  else if (r.summary) bits.push(esc(clip(r.summary, 120)))
  else if (markOf(r) === 'quiet') bits.push('nothing new')
  if (r.denials?.length) bits.push(`blocked: ${esc(clip(r.denials.join(', '), 80))}`)
  return bits.filter(Boolean).join(' · ')
}

export function historyHtml(t: Task, runs: Run[]): string {
  if (!runs.length) return `<b>${esc(t.name)}</b>: no runs yet.`
  return [`<b>${esc(t.name)}</b>: the last ${runs.length} run${runs.length === 1 ? '' : 's'}`, ...runs.map(r => runLine(r, t.tz))].join('\n')
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

// --- what tasks did: digests and watchdogs -----------------------------------------

// A task and its runs since some time, newest first.
export interface Activity { task: Task; runs: Run[] }

const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`

// One line per task, for a digest posted in the topic (markdown): its runs since, by
// mark, what the last one said or why it failed, and what a watcher saw.
export function digestMarkdown(entries: Activity[], since: Date, tz: string): string {
  const lines = [`**Since ${whenText(since, tz)}**`]
  for (const { task: t, runs } of entries) {
    const done = runs.filter(r => r.state !== 'queued' && r.state !== 'running')
    const bits: string[] = []
    if (t.trigger.kind === 'watch' && t.eventsSeen) bits.push(`${plural(t.eventsSeen, 'line')} seen in all`)
    if (done.length) bits.push(`${plural(done.length, 'run')} ${done.slice(0, 12).reverse().map(r => MARK[markOf(r)]).join('')}`)
    else bits.push('no runs')
    const failed = done.filter(r => markOf(r) === 'failed')
    const last = done[0]
    let note = ''
    if (last && markOf(last) === 'failed') note = `last failed: ${clip(last.reason ?? 'failed', 160)}`
    else if (last?.summary) note = `“${clip(last.summary, 160)}”`
    if (failed.length && markOf(last!) !== 'failed') bits.push(plural(failed.length, 'failure'))
    if (t.state === 'paused') bits.push('⏸ paused')
    if (t.watchError) bits.push(`⚠️ ${clip(t.watchError, 120)}`)
    lines.push(`- **${t.name}** (${kindLabel(t).split(' ')[0]} ${scheduleText(t.trigger, tz)}): ${bits.join(' · ')}${note ? ` · ${note}` : ''}`)
  }
  if (entries.length === 0) lines.push('No tasks to report on.')
  return lines.join('\n')
}

// The same, as material for a watchdog's run: every run since, plainly.
export function watchedText(entries: Activity[], since: Date, tz: string): string {
  const out: string[] = []
  for (const { task: t, runs } of entries) {
    const head = [`${t.name} (id ${t.id}; ${scheduleText(t.trigger, t.tz)}; ${t.state}${t.pauseReason ? `, ${pauseText(t)}` : ''}`]
    if (t.failStreak) head.push(`${t.failStreak} failure(s) in a row`)
    if (t.trigger.kind === 'watch') head.push(`watcher: ${t.watchError ? `failing (${t.watchError})` : 'fine'}, ${plural(t.eventsSeen ?? 0, 'line')} seen${t.lastEventAt ? `, the last at ${whenText(new Date(t.lastEventAt), tz)}` : ''}`)
    out.push(`- ${head.join('; ')}):`)
    if (!runs.length) out.push(`    no runs since ${whenText(since, tz)}`)
    for (const r of runs.slice(0, 20)) {
      const at = r.startedAt ?? r.slot
      const len = r.startedAt && r.endedAt ? `, ${elapsedText(Date.parse(r.endedAt) - Date.parse(r.startedAt))}` : ''
      const said = r.state === 'failed' || r.state === 'timed_out' || r.state === 'skipped' || r.state === 'deferred' || r.state === 'interrupted' ? r.reason : r.summary
      out.push(`    ${at ? whenText(new Date(at), tz) : '?'} ${markOf(r)}${len}${said ? `: ${clip(said, 200)}` : ''}`)
    }
  }
  return out.join('\n')
}

// --- plans -------------------------------------------------------------------------

const STEP_KIND: Record<Step['kind'], string> = { message: 'message', script: 'command', claude: 'Claude', codex: 'Codex', ask: 'question', handoff: 'hand-off' }
const goText = (g: number | 'next' | 'stop' | undefined, dflt: string) => g === undefined ? dflt : g === 'next' ? 'the next' : g === 'stop' ? 'stop' : `step ${g}`

// "3. tests (command) · fails → step 5, 1 retry"
export function stepLine(st: Step, n: number): string {
  const bits: string[] = []
  if (st.onPass !== undefined && st.onPass !== 'next') bits.push(`passes → ${goText(st.onPass, 'the next')}`)
  if (st.onFail !== undefined && st.onFail !== 'stop') bits.push(`fails → ${goText(st.onFail, 'stop')}`)
  if (st.retries) bits.push(`${st.retries} ${st.retries === 1 ? 'retry' : 'retries'}`)
  if (st.kind === 'handoff' && st.topicName) bits.push(`to ${st.topicName}`)
  return `${n}. ${st.name} (${STEP_KIND[st.kind]})${bits.length ? ` · ${bits.join(', ')}` : ''}`
}

// How a plan's run went, step by step: the latest try of each step it ran, in order,
// and the one it is at. "✅ fetch · ✅ scope · ❌ tests ×2 · ⏳ fix"
export function stepsStrip(results: StepResult[], current?: { step: number; name: string }): string {
  const parts: string[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const tries = r.attempt > 1 ? ` ×${r.attempt}` : ''
    // A retry replaces the try before it in the strip.
    if (i + 1 < results.length && results[i + 1].step === r.step && results[i + 1].attempt === r.attempt + 1) continue
    parts.push(`${r.ok ? '✅' : '❌'} ${r.name}${tries}`)
  }
  if (current) parts.push(`⏳ ${current.name}`)
  return parts.join(' · ')
}
