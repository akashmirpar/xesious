/**
 * flows.ts — what one run set going, and what that set going in turn: a flow. The
 * links are the ones the bot made itself: hand-offs (to topics and to other bots,
 * each on to the next), the tasks that run after another, and the child tasks a run
 * made. A tree, shown on a task's card and under the 🔀 Flows button of /tasks:
 *
 *   Daily video · Fri 16 Oct, 09:00 ✅ → ➡️ Posting ✅ → ➡️ @statsbot in Stats ⏳
 *
 * Pure: the bridge hands it the group's tasks, runs and hand-offs.
 */
import type { Task, Run, Handoff } from './model'
import { esc, MARK, markOf, whenText } from './render'

export interface FlowSource {
  tasks: Task[]                                     // the group's, in every state but deleted
  runsOf(task: string): Run[]                       // newest first
  handoffs: Handoff[]                               // the group's, recent
  topicName(thread: number | undefined): string
  link(thread: number | undefined, msg: number): string | undefined
}

export interface FlowNode { html: string; at: string; children: FlowNode[] }

const HANDOFF_MARK: Record<Handoff['state'], string> = { queued: '⏳', running: '⏳', sent: '⏳', done: '✅', failed: '❌' }
// A flow stops growing here: deep chains are capped anyway, and a card must stay a card.
const MAX_NODES = 30
const MAX_DEPTH = 6
// Indentation that Telegram keeps.
const INDENT = '\u00a0\u00a0\u00a0\u00a0'

const linked = (html: string, link?: string) => link ? `<a href="${link}">${html}</a>` : html

export function runNode(run: Run, src: FlowSource, budget = { n: MAX_NODES }, depth = 0): FlowNode {
  const t = src.tasks.find(x => x.id === run.task)
  const when = run.startedAt ?? run.slot
  const label = `${run.trigger === 'after' ? '↪️ ' : ''}<b>${esc(t?.name ?? run.task)}</b>${when && t ? ` · ${esc(whenText(new Date(when), t.tz))}` : ''} ${MARK[markOf(run)]}`
  const link = run.postedMsg && t ? src.link(t.where === 'dm' ? undefined : t.thread, run.postedMsg) : undefined
  return { html: linked(label, link), at: when ?? '', children: depth >= MAX_DEPTH ? [] : childrenOfRun(run, src, budget, depth + 1) }
}

function childrenOfRun(run: Run, src: FlowSource, budget: { n: number }, depth: number): FlowNode[] {
  const out: { at: string; make: () => FlowNode }[] = []
  for (const h of src.handoffs) if (h.fromRun === run.id) out.push({ at: h.createdAt, make: () => handoffNode(h, src, budget, depth) })
  for (const t of src.tasks) {
    if (t.trigger.kind === 'after' && t.trigger.task === run.task) {
      for (const r of src.runsOf(t.id)) if (r.after?.run === run.id) out.push({ at: r.startedAt ?? r.slot ?? '', make: () => runNode(r, src, budget, depth) })
    }
    if (t.createdBy === `run:${run.id}`) out.push({ at: t.createdAt, make: () => childNode(t, src) })
  }
  return take(out, budget)
}

function take(out: { at: string; make: () => FlowNode }[], budget: { n: number }): FlowNode[] {
  out.sort((a, b) => a.at.localeCompare(b.at))
  const nodes: FlowNode[] = []
  for (const o of out) {
    if (budget.n <= 0) break
    budget.n--
    nodes.push(o.make())
  }
  return nodes
}

export function handoffNode(h: Handoff, src: FlowSource, budget = { n: MAX_NODES }, depth = 0): FlowNode {
  const to = src.topicName(h.toThread)
  const where = h.direction === 'in' ? `⬅️ @${h.peer} → ${to}` : h.peer ? `➡️ ${h.plain ? 'asked ' : ''}@${h.peer} in ${to}` : `➡️ ${to}`
  const link = h.resultLink ?? (h.dstMsg ? src.link(h.toThread, h.dstMsg) : undefined)
  const next = depth >= MAX_DEPTH ? [] : take(src.handoffs.filter(x => x.fromHandoff === h.id).map(x => ({ at: x.createdAt, make: () => handoffNode(x, src, budget, depth + 1) })), budget)
  return { html: linked(`${esc(where)} ${HANDOFF_MARK[h.state]}`, link), at: h.createdAt, children: next }
}

function childNode(t: Task, src: FlowSource): FlowNode {
  const state = t.state === 'active' ? 'running' : t.state === 'paused' ? 'paused' : 'ended'
  const link = t.cardMsg ? src.link(t.where === 'dm' ? undefined : t.thread, t.cardMsg) : undefined
  return { html: linked(`🌱 <b>${esc(t.name)}</b>`, link) + ` <i>(a task it made, ${state})</i>`, at: t.createdAt, children: [] }
}

// A hand-off nothing in a flow made: a person's turn's, a script's on the host, or
// another bot's.
function handoffRoot(h: Handoff, src: FlowSource): FlowNode {
  if (h.direction === 'in') return handoffNode(h, src)
  const task = h.fromTask ? src.tasks.find(t => t.id === h.fromTask) : undefined
  const head = (h as any).fromHost ? '⚙️ A script on the host'
    : task ? `<b>${esc(task.name)}</b>`
    : `💬 ${esc(src.topicName(h.fromThread))} · ${esc(h.byName ?? 'someone')}`
  return { html: head, at: h.createdAt, children: [handoffNode(h, src, { n: MAX_NODES }, 1)] }
}

// The flows of a group, or of one topic, since a time, newest first: each run of a task
// that set something going, and each hand-off that started one.
export function recentFlows(src: FlowSource, since: string, thread: number | undefined | 'all'): FlowNode[] {
  const roots: FlowNode[] = []
  const here = (th: number | undefined) => thread === 'all' || th === thread
  for (const t of src.tasks) {
    if (!here(t.thread)) continue
    for (const r of src.runsOf(t.id)) {
      // An after run shows under the run that set it off.
      if ((r.startedAt ?? r.slot ?? '') < since || r.after) continue
      const n = runNode(r, src)
      if (n.children.length) roots.push(n)
    }
  }
  for (const h of src.handoffs) {
    if (h.fromRun || h.fromHandoff || h.createdAt < since) continue
    if (!here(h.direction === 'in' ? h.toThread : h.fromThread) && !here(h.toThread)) continue
    roots.push(handoffRoot(h, src))
  }
  return roots.sort((a, b) => b.at.localeCompare(a.at))
}

// As lines: a chain joined by → while it doesn't fork; where it forks, each branch on
// a line of its own, indented under it (a fork at the very start: right under it).
export function flowHtml(root: FlowNode): string {
  const lines: string[] = []
  const walk = (n: FlowNode, indent: string, lead: string) => {
    let s = n.html
    let end = n
    while (end.children.length === 1) { end = end.children[0]; s += ` → ${end.html}` }
    lines.push(`${indent}${lead}${s}`)
    const deeper = lead || end !== n ? indent + INDENT : indent
    if (end.children.length > 1) for (const c of end.children) walk(c, deeper, '→ ')
  }
  walk(root, '', '')
  return lines.join('\n')
}

// For a card: where its last run's work went, on one line, when it went anywhere.
export function flowLine(root: FlowNode): string | undefined {
  if (!root.children.length) return undefined
  const path: string[] = []
  let cur = root
  while (cur.children.length) { cur = cur.children[0]; path.push(cur.html) }
  const count = (n: FlowNode): number => n.children.reduce((k, c) => k + 1 + count(c), 0)
  const more = count(root) - path.length
  return `🔀 Its last run → ${path.join(' → ')}${more ? ` <i>(+${more} more: 🔀 Flows, under /tasks)</i>` : ''}`
}

// The 🔀 Flows button's view: as many as fit in one message.
export function flowsHtml(head: string, flows: FlowNode[], maxChars = 3800): string {
  if (!flows.length) return `${head}\n\nNothing yet: a flow starts when a task's run hands work on, sets off a task that runs after it, or makes a task.`
  const out = [head]
  let len = head.length
  let shown = 0
  for (const f of flows) {
    const block = flowHtml(f)
    if (len + block.length + 2 > maxChars) break
    out.push(block)
    len += block.length + 2
    shown++
  }
  if (shown < flows.length) out.push(`<i>…and ${flows.length - shown} more.</i>`)
  return out.join('\n\n')
}
