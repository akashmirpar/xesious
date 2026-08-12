#!/usr/bin/env bun
/**
 * Offline replay for the "mid-turn text is deleted" problem (A1).
 *
 * The bridge delivers only the terminal `result` of a turn, so in any turn where
 * the model answers and then keeps working, the answer is discarded and the user
 * receives the closing summary. This measures how often that happens across every
 * transcript on disk, and — the point of the exercise — what each candidate rule
 * WOULD have delivered, so the rule is chosen from data rather than picked.
 *
 * Why this exists before the fix: the dropped text is strongly bimodal. Most of it
 * is inter-tool narration ("Let me check.") that nobody wants buzzing their phone,
 * and the value is in a small tail of real answers. Three separate reported cases
 * each broke a different length threshold — 590 chars mattered, 415 mattered, 658
 * was junk — so a threshold cannot be the mechanism.
 *
 *   bun test/replay-text-blocks.ts               # aggregates only
 *   bun test/replay-text-blocks.ts --samples 5   # plus excerpts, LOCAL USE ONLY
 *
 * Prints aggregates by default and never writes anything: these are private
 * conversations, and this repository is public.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SAMPLES = (() => {
  const i = process.argv.indexOf('--samples')
  return i >= 0 ? Number(process.argv[i + 1] ?? 3) : 0
})()

const ROOT = join(homedir(), '.claude', 'projects')

type Turn = { blocks: string[]; project: string }

function* transcripts(): Generator<string> {
  let projects: string[] = []
  try { projects = readdirSync(ROOT) } catch { return }
  for (const p of projects) {
    const dir = join(ROOT, p)
    let names: string[] = []
    try { names = readdirSync(dir) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      const f = join(dir, n)
      try { if (statSync(f).isFile()) yield f } catch {}
    }
  }
}

// A turn is one user message and every assistant text block that follows it.
//
// The subtlety that makes or breaks this measurement: a TOOL RESULT is also
// recorded as type:"user". Treating those as turn boundaries splits every agentic
// turn at each tool call, so no turn ever has more than one text block and the
// whole problem measures as nonexistent — the first version of this script
// reported 1 multi-block turn out of 2760. A genuine user message has string
// content, or array content with no tool_result block in it.
//
// (A <task-notification> also arrives as type:"user" and IS counted as a turn
// boundary here, because that is exactly how the model sees it — which is its own
// logged bug, A6.)
const isRealUserTurn = (o: any): boolean => {
  const c = o.message?.content
  if (typeof c === 'string') return true
  if (!Array.isArray(c)) return false
  return !c.some((b: any) => b?.type === 'tool_result')
}
function turnsOf(file: string): Turn[] {
  const project = file.split('/').slice(-2)[0]
  const out: Turn[] = []
  let cur: string[] | undefined
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return out }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let o: any
    try { o = JSON.parse(line) } catch { continue }
    if (o.type === 'user') {
      if (!isRealUserTurn(o)) continue          // a tool result, not a new turn
      if (cur) out.push({ blocks: cur, project }); cur = []; continue
    }
    if (o.type !== 'assistant' || !cur) continue
    const content = o.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type === 'text') {
        const t = String(b.text ?? '').trim()
        if (t) cur.push(t)
      }
    }
  }
  if (cur) out.push({ blocks: cur, project })
  return out
}

// ---------------------------------------------------------------------------
// candidate rules — each answers "which blocks would the user have received?"
// ---------------------------------------------------------------------------

// A closing promise is a sign-off, not an answer: it commits to future work and
// reports nothing. Where the delivered block is one of these, the substantive
// block before it is what the user was waiting for.
const SIGNOFF = /\b(i'?ll (report|update|let you know|come back|follow up)|will report|report back|when it (lands|finishes|completes)|monitoring|keep you posted|stand by)\b/i

// Deixis without an antecedent: the block opens by referring to work the user
// never saw, so it only parses if the preceding blocks were delivered.
const DEIXIS = /^(recorded|done|that'?s (fixed|done)|fixed|updated|added|removed|committed|restarted|noted)\b/i

const RULES: Record<string, (blocks: string[]) => string[]> = {
  'today (last block only)': b => b.slice(-1),
  'all blocks': b => b,
  'length >= 300': b => b.filter(x => x.length >= 300),
  'length >= 600': b => b.filter(x => x.length >= 600),
  // What I actually propose: the last block is the reply, and everything else goes
  // to the (retained) progress message. Promotion is the enhancement — when the
  // closing block is a sign-off or dangling reference, also deliver the last
  // substantive block before it, so a heuristic MISS costs a tap, not a message.
  'last + promote on signoff/deixis': b => {
    if (b.length < 2) return b.slice(-1)
    const last = b[b.length - 1]
    if (!SIGNOFF.test(last) && !DEIXIS.test(last)) return [last]
    const prior = [...b.slice(0, -1)].reverse().find(x => x.length >= 200)
    return prior ? [prior, last] : [last]
  },
}

// ---------------------------------------------------------------------------

const turns: Turn[] = []
let files = 0
for (const f of transcripts()) { files++; turns.push(...turnsOf(f)) }

const withText = turns.filter(t => t.blocks.length > 0)
const multi = withText.filter(t => t.blocks.length > 1)
const dropped = multi.flatMap(t => t.blocks.slice(0, -1))
const droppedChars = dropped.reduce((n, b) => n + b.length, 0)

console.log(`transcripts scanned      : ${files}`)
console.log(`turns that produced text : ${withText.length}`)
console.log(`turns with >1 text block : ${multi.length}` +
            (withText.length ? `  (${Math.round((multi.length / withText.length) * 100)}%)` : ''))
console.log(`blocks dropped today     : ${dropped.length}`)
console.log(`characters dropped today : ${droppedChars.toLocaleString()}`)

const sizes = dropped.map(b => b.length).sort((a, b) => a - b)
const pct = (p: number) => sizes.length ? sizes[Math.floor((sizes.length - 1) * p)] : 0
console.log(`dropped block size       : median ${pct(0.5)}, p90 ${pct(0.9)}, p99 ${pct(0.99)}, max ${sizes[sizes.length - 1] ?? 0}`)
console.log(`dropped blocks >= 600ch  : ${sizes.filter(n => n >= 600).length}`)

// How often is the delivered block itself the problem?
const signoffLast = multi.filter(t => SIGNOFF.test(t.blocks[t.blocks.length - 1])).length
const deixisLast = multi.filter(t => DEIXIS.test(t.blocks[t.blocks.length - 1])).length
const shorterThanDropped = multi.filter(t => {
  const last = t.blocks[t.blocks.length - 1].length
  return t.blocks.slice(0, -1).some(b => b.length > last)
}).length
console.log()
console.log(`multi-block turns whose FINAL block is…`)
console.log(`  a sign-off (promises future work) : ${signoffLast}`)
console.log(`  a dangling reference (deixis)     : ${deixisLast}`)
console.log(`  shorter than something it dropped : ${shorterThanDropped}`)

console.log()
console.log('what each rule would deliver, over the multi-block turns:')
for (const [name, rule] of Object.entries(RULES)) {
  let msgs = 0, chars = 0, lost = 0
  for (const t of multi) {
    const got = rule(t.blocks)
    msgs += got.length
    chars += got.reduce((n, b) => n + b.length, 0)
    lost += t.blocks.filter(b => !got.includes(b)).reduce((n, b) => n + b.length, 0)
  }
  console.log(`  ${name.padEnd(34)} messages ${String(msgs).padStart(6)}   delivered ${String(chars).padStart(9)}ch   still lost ${String(lost).padStart(9)}ch`)
}

if (SAMPLES > 0) {
  console.log(`\n--- ${SAMPLES} sample turns where the final block is a sign-off (LOCAL ONLY) ---`)
  for (const t of multi.filter(x => SIGNOFF.test(x.blocks[x.blocks.length - 1])).slice(0, SAMPLES)) {
    console.log(`\n[${t.project}] ${t.blocks.length} blocks`)
    console.log(`  DELIVERED (${t.blocks[t.blocks.length - 1].length}ch): ${JSON.stringify(t.blocks[t.blocks.length - 1].slice(0, 160))}`)
    const prior = [...t.blocks.slice(0, -1)].reverse().find(x => x.length >= 200)
    if (prior) console.log(`  DROPPED   (${prior.length}ch): ${JSON.stringify(prior.slice(0, 160))}`)
  }
}
