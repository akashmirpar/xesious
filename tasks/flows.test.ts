import { test, expect, describe } from 'bun:test'
import { runNode, handoffNode, recentFlows, flowHtml, flowLine, flowsHtml, type FlowSource } from './flows'
import type { Handoff, Run, Task } from './model'

const task = (over: Partial<Task> = {}): Task => ({
  id: 'vid001', chat: '-100777', thread: 5, name: 'Daily video', tz: 'UTC',
  trigger: { kind: 'cron', expr: '0 9 * * *' }, action: { kind: 'claude', prompt: 'Make the video', session: 'fresh' },
  says: 'result', sound: 'silent', where: 'home', owner: '1', createdBy: 'person:1',
  createdAt: '2026-10-10T08:00:00.000Z', updatedAt: '2026-10-10T08:00:00.000Z', state: 'active', runsDone: 3, failStreak: 0, ...over,
})
const run = (over: Partial<Run> = {}): Run => ({ id: 'vid001@1', task: 'vid001', trigger: 'schedule', state: 'succeeded', startedAt: '2026-10-16T09:00:00.000Z', postedMsg: 40, ...over })
const handoff = (over: Partial<Handoff> = {}): Handoff => ({
  id: 'h00001', chat: '-100777', fromThread: 5, toThread: 6, brief: 'Post it', files: [], by: '1', byName: 'Ada', depth: 1,
  state: 'done', createdAt: '2026-10-16T09:05:00.000Z', dstMsg: 50, ...over,
})
const NAMES: Record<number, string> = { 5: 'Content', 6: 'Posting', 7: 'Stats' }
function source(tasks: Task[], runs: Run[], handoffs: Handoff[]): FlowSource {
  return {
    tasks, handoffs,
    runsOf: id => runs.filter(r => r.task === id).sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')),
    topicName: th => th === undefined ? 'General' : NAMES[th] ?? `topic ${th}`,
    link: (th, msg) => `https://t.me/c/777/${th ?? 1}/${msg}`,
  }
}
const text = (html: string) => html.replace(/<[^>]+>/g, '')
// The indent of a branch: spaces Telegram keeps.
const I = '\u00a0'.repeat(4)

describe('a flow', () => {
  test('a run, the hand-off it made and the one that made, a task that ran after it, a task it made', () => {
    const video = task()
    const stats = task({ id: 'sts001', name: 'Weekly stats', thread: 7, trigger: { kind: 'after', task: 'vid001', name: 'Daily video', on: 'success' } })
    const child = task({ id: 'kid001', name: 'Watch replies', thread: 5, createdBy: 'run:vid001@1', createdAt: '2026-10-16T09:10:00.000Z', cardMsg: 61 })
    const r = run()
    const after = run({ id: 'sts001@after-1', task: 'sts001', trigger: 'after', startedAt: '2026-10-16T09:20:00.000Z', postedMsg: 70,
      after: { task: 'vid001', run: 'vid001@1', name: 'Daily video', outcome: 'done', depth: 1 } })
    const posting = handoff({ fromTask: 'vid001', fromRun: 'vid001@1' })
    const onward = handoff({ id: 'h00002', fromThread: 6, toThread: 7, fromHandoff: 'h00001', peer: 'statsbot', direction: 'out', state: 'sent', createdAt: '2026-10-16T09:30:00.000Z', dstMsg: 80 })
    const src = source([video, stats, child], [r, after], [posting, onward])
    const root = runNode(r, src)
    const lines = text(flowHtml(root)).split('\n')
    expect(lines[0]).toBe('Daily video · Fri 16 Oct, 09:00 ✅')
    // Each branch on its own line, in the order they happened; a chain on one.
    expect(lines.slice(1)).toEqual([
      '→ ➡️ Posting ✅ → ➡️ @statsbot in Stats ⏳',
      '→ 🌱 Watch replies (a task it made, running)',
      '→ ↪️ Weekly stats · Fri 16 Oct, 09:20 ✅',
    ])
    // Each part links to where it is.
    const html = flowHtml(root)
    expect(html).toContain('<a href="https://t.me/c/777/5/40"><b>Daily video</b>')
    expect(html).toContain('<a href="https://t.me/c/777/6/50">➡️ Posting ✅</a>')
    expect(html).toContain('<a href="https://t.me/c/777/5/61">🌱 <b>Watch replies</b></a>')
    // On the card: the first path, and how many more.
    expect(text(flowLine(root)!)).toBe('🔀 Its last run → ➡️ Posting ✅ → ➡️ @statsbot in Stats ⏳ (+2 more: /tasks flows)')
    expect(flowLine(runNode(run({ id: 'vid001@0' }), src))).toBeUndefined()
  })

  test('a fork further down is indented under where it forks', () => {
    const r = run()
    const a = handoff({ fromRun: 'vid001@1' })
    const b = handoff({ id: 'h00002', fromHandoff: 'h00001', toThread: 7, createdAt: '2026-10-16T09:06:00.000Z' })
    const c = handoff({ id: 'h00003', fromHandoff: 'h00001', toThread: 5, state: 'failed', createdAt: '2026-10-16T09:07:00.000Z' })
    expect(text(flowHtml(runNode(r, source([task()], [r], [a, b, c]))))).toBe(
      `Daily video · Fri 16 Oct, 09:00 ✅ → ➡️ Posting ✅\n${I}→ ➡️ Stats ✅\n${I}→ ➡️ Content ❌`)
  })

  test('hand-offs to and from other bots say so', () => {
    const src = source([task()], [], [])
    expect(text(handoffNode(handoff({ peer: 'postingbot', direction: 'out', state: 'sent', resultLink: 'https://t.me/c/777/6/99' }), src).html)).toBe('➡️ @postingbot in Posting ⏳')
    expect(handoffNode(handoff({ peer: 'postingbot', direction: 'out', resultLink: 'https://t.me/c/777/6/99' }), src).html).toContain('href="https://t.me/c/777/6/99"')
    expect(text(handoffNode(handoff({ peer: 'weatherbot', direction: 'out', plain: true }), src).html)).toBe('➡️ asked @weatherbot in Posting ✅')
    expect(text(handoffNode(handoff({ peer: 'postingbot', direction: 'in', fromThread: undefined }), src).html)).toBe('⬅️ @postingbot → Posting ✅')
  })
})

describe('the flows of a group', () => {
  const video = task()
  const draft = task({ id: 'drf001', name: 'Draft', thread: 6 })
  const r1 = run()
  const r0 = run({ id: 'vid001@0', startedAt: '2026-10-15T09:00:00.000Z' })    // set nothing going
  const r2 = run({ id: 'drf001@1', task: 'drf001', startedAt: '2026-10-16T11:00:00.000Z' })
  const old = run({ id: 'vid001@old', startedAt: '2026-10-01T09:00:00.000Z' })
  const hs = [
    handoff({ fromRun: 'vid001@1', fromTask: 'vid001' }),
    handoff({ id: 'h00002', fromRun: 'drf001@1', fromTask: 'drf001', fromThread: 6, toThread: 7, createdAt: '2026-10-16T11:01:00.000Z' }),
    handoff({ id: 'h00003', fromRun: 'vid001@old', createdAt: '2026-10-01T09:01:00.000Z' }),
    // A person's turn handed this one off; another bot handed that one in.
    handoff({ id: 'h00004', fromThread: 7, toThread: 5, createdAt: '2026-10-16T12:00:00.000Z', byName: 'Ben' }),
    handoff({ id: 'h00005', fromThread: undefined, toThread: 7, direction: 'in', peer: 'postingbot', createdAt: '2026-10-16T12:30:00.000Z' }),
  ]
  const src = source([video, draft], [r1, r0, r2, old], hs)

  test('the runs that set something going and the hand-offs that started one, newest first, since a time', () => {
    const flows = recentFlows(src, '2026-10-09T00:00:00.000Z', 'all').map(f => text(flowHtml(f)))
    expect(flows).toEqual([
      '⬅️ @postingbot → Stats ✅',
      '💬 Stats · Ben → ➡️ Content ✅',
      'Draft · Fri 16 Oct, 11:00 ✅ → ➡️ Stats ✅',
      'Daily video · Fri 16 Oct, 09:00 ✅ → ➡️ Posting ✅',
    ])
  })

  test("a topic's: what starts there, and what comes to it", () => {
    expect(recentFlows(src, '2026-10-09T00:00:00.000Z', 5).map(f => text(flowHtml(f)))).toEqual([
      '💬 Stats · Ben → ➡️ Content ✅',
      'Daily video · Fri 16 Oct, 09:00 ✅ → ➡️ Posting ✅',
    ])
  })

  test('as one message: as many as fit; none yet is said so', () => {
    const flows = recentFlows(src, '2026-10-09T00:00:00.000Z', 'all')
    const all = flowsHtml('<b>Flows</b>', flows)
    expect(all.split('\n\n')).toHaveLength(5)
    const short = flowsHtml('<b>Flows</b>', flows, 160)
    expect(short).toContain('<i>…and ')
    expect(flowsHtml('<b>Flows</b>', [])).toContain('Nothing yet')
  })
})
