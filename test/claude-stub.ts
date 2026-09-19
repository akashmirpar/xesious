#!/usr/bin/env bun
/**
 * Tier 2 test double for the `claude` CLI. bridge.ts spawns $CLAUDE_BIN with
 *   -p <prompt> --output-format stream-json --verbose [--resume <id>] [--model <m>] …
 * and reads NDJSON `stream-json` events off stdout. This stub emits canned events
 * chosen by the prompt text, so the whole model layer disappears: no API, no token,
 * deterministic output.
 *
 * Scenarios (the first whitespace-delimited word of the prompt):
 *   EMPTY  → init + a successful result with empty text  → bridge reports "no answer"
 *   NORESP → init + a result whose whole text is "No response requested." — the CLI
 *            queue-layer artefact that used to be posted verbatim as the reply
 *   ERROR  → init + result with is_error:true            → bridge marks the turn failed
 *   HANG   → init, then sleep past the test's timeout     → exercises the watchdog path
 *   BGPROC → init + a REAL backgrounded child process, then sleeps → exercises whether
 *            interrupting a run stops the tree it built, or orphans it
 *   PARTIAL→ init + a text block, then sleeps forever    → exercises interrupting a run
 *            that has already produced something
 *   LONG   → init + a result past TG_REPLY_FILE_CHARS, with a table in it
 *   TOOLS  → init + two tool_use steps + success
 *   MIDTEXT→ init + a substantive text block + a tool_use + a closing sign-off,
 *            i.e. the shape where the answer is written mid-turn and the bridge
 *            used to deliver only the sign-off
 *   (else) → init + one Bash tool_use + success
 *
 * Every successful result echoes what the stub was invoked with, in letters-only
 * tokens that survive MarkdownV2 escaping, so tests can assert on the reply:
 *   hadResume / noResume   — was --resume passed (session persistence round-trip)
 *   modelSet / modelDefault — was --model passed
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const val = (flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

const rawPrompt = val('-p') ?? ''
// The bridge wraps a user message in an attribution frame whose first line carries
// a per-process nonce. Strip it the way the real CLI's model would look past it,
// or every scenario token below would be shadowed by the marker.
// The marker is not always the FIRST line: a turn that follows a finished
// background task carries a bridge-authored preamble ahead of it. Find the marker
// wherever it is and take everything after it as the user's actual message.
const frameLine = rawPrompt.match(/\[xesious:[0-9a-f]+\] message from [^\n]*\n/)
const framed = Boolean(frameLine)
const carriedBg = /\[xesious:[0-9a-f]+\] a background task/.test(rawPrompt)
const prompt = frameLine
  ? rawPrompt.slice(rawPrompt.indexOf(frameLine[0]) + frameLine[0].length)
  : rawPrompt
const scenario = prompt.trim().split(/\s+/)[0] ?? ''
const resumeId = val('--resume')
const model = val('--model')
const effort = val('--effort')
const forked = argv.includes('--fork-session')
// A stable-ish session id derived from the resume arg: a new turn mints one, a
// resumed turn keeps reporting a session so bridge re-persists it.
//
// A FORK reports a different one, because that is what the real CLI does and it is
// the entire point of --fork-session: the run branches off the transcript it
// resumed. Echoing the parent's id back made every "the fork must not steal the
// topic's binding" assertion vacuous — the stolen id and the right id were the
// same string, so the theft was invisible to the tests that existed to catch it.
const sessionId = forked && resumeId ? `fork-of-${resumeId}` : (resumeId ?? 'sessTESTAAA')

const emit = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
const initLine = () => emit({ type: 'system', subtype: 'init', session_id: sessionId, model: model ?? 'claude-opus-5[1m]', claude_code_version: '2.1.219' })
const result = (extra: Record<string, unknown>) =>
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, ...extra })

const tag = `${resumeId ? 'hadResume' : 'noResume'} ${model ? 'modelSet' : 'modelDefault'} ${framed ? 'framed' : 'unframed'} ${effort ? 'effort' + effort : 'effortDefault'} ${forked ? 'forked' : 'notForked'} ${carriedBg ? 'sawBgResult' : 'noBgResult'}`

async function main() {
  // BEFORE initLine, because this call uses --output-format json and the caller does
  // a plain JSON.parse of the whole output. An init line ahead of it makes the parse
  // throw, the bridge falls back to the written text, and the test passes for the one
  // reason it must not: the path under test never ran.
  // The speech normaliser: one line in, one spoken line out. Deterministic, and
  // deliberately NOT a real normalisation — the assertion that matters is that the
  // synthesiser was handed `speak` while the page and index kept `text`, and a marker
  // proves that where a plausible rewrite could be mistaken for the original.
  if (/Rewrite the line below so a speech synthesiser/.test(rawPrompt)) {
    const line = (rawPrompt.match(/<line>\n([\s\S]*)\n<\/line>/)?.[1] ?? '').trim()
    result({ result: `SPOKEN(${line})` })
    return
  }

  initLine()

  if (scenario === 'HANG') {
    // Stay genuinely alive (a real timer — a bare pending promise wouldn't keep the
    // event loop up, and Bun would exit immediately) so the bridge's
    // CLAUDE_TIMEOUT_MS is what SIGKILLs us. That is the path under test.
    setTimeout(() => process.exit(0), 60_000)
    return
  }
  // A planning turn: the bridge asks for a split and parses FANOUT lines back.
  if (/Break the following task into at most/.test(prompt)) {
    result({ result: 'Here is a sensible split:\nFANOUT 1 | read | Survey it | Look at everything and report\nFANOUT 2 | write | Change it | Edit the files that need it' })
    return
  }
  if (/You are one part of a task that was split up/.test(prompt)) {
    const part = prompt.match(/Your part: ([^\n]+)/)?.[1] ?? 'unknown'
    result({ result: `PARTDONE ${part}` })
    return
  }
  if (/the parts have finished/i.test(prompt)) {
    result({ result: 'SYNTHESIS: combined answer' })
    return
  }
  if (scenario === 'BGPROC') {
    // Stand in for a tool call that backgrounds work: `nohup collector.py &`
    // returns instantly while the real job keeps running. Killing only this
    // process would leave it behind — which is the bug under test.
    const bg = spawn('sleep', ['300'], { stdio: 'ignore' })
    writeFileSync(join(process.cwd(), 'bgpid.txt'), String(bg.pid ?? 0))
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Started a background job.' }] } })
    setTimeout(() => process.exit(0), 60_000)
    return
  }
  if (scenario === 'PARTIAL') {
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Partway through: the sweep is at 160 of 245.' }] } })
    setTimeout(() => process.exit(0), 60_000)
    return
  }
  if (scenario === 'EMPTY') { result({ result: '' }); return }
  if (scenario === 'NORESP') { result({ result: 'No response requested.' }); return }
  if (scenario === 'ERROR') {
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, result: 'boom' })
    return
  }
  if (scenario === 'MIDTEXT') {
    const answer = 'Timing: the sweep has about one minute left, 160 of 245 done. ' +
      'The wallet fetch already finished, 2,874 trades. '.repeat(4)
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } })
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 0' } }] } })
    const signoff = "I'll report the final ranked sweep when the monitor fires."
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: signoff }] } })
    result({ result: signoff })
    return
  }
  if (scenario === 'SHORTHEADINGS') {
    // Two headings but few enough units that the stub makes ONE chunk, which is the
    // case with no full file to hang an index or a read-along off.
    result({ result: '## One\n\nA sentence.' })
    return
  }
  if (scenario === 'MIXED') {
    // THE PRODUCTION DIAGONAL, and the one combination no test covered when a user
    // lost 70% of an answer: some units need normalising and some do not, and the
    // answer is long enough that most of it arrives AFTER the first chunk's worth.
    //
    // CAPLONG had nothing to normalise, so the normaliser never ran; SYMBOLS had
    // everything to normalise, so `lead` covered every unit and there was no tail.
    // Each missed this from the opposite side. Here the first two sentences carry the
    // symbols and everything after them is plain prose in the tail.
    // Separate paragraphs, not one run of sentences: speechUnits batches sentences
    // into runs, so a single block collapses to a handful of units and there is no
    // tail left to lose — which would make this test pass for the wrong reason.
    const head = ['The pilot cost $100/yr, up from $1.', 'It ran 5-10 days at 2x speed.']
    const body = Array.from({ length: 24 },
      (_, i) => `Paragraph ${i + 1} is ordinary prose that needs no rewriting at all.`)
    result({ result: [...head, ...body, 'ZZ_LAST_WORDS_OF_THE_ANSWER.'].join('\n\n') })
    return
  }
  if (scenario === 'SYMBOLS') {
    // Long enough to be chunked, and every sentence carries something the phonemiser
    // is known to mangle, so the gate must select all of them.
    const line = (i: number) => `Item ${i} cost $100/yr, about 2x the ~5 day estimate.`
    result({ result: Array.from({ length: 12 }, (_, i) => line(i + 1)).join('\n\n') })
    return
  }
  if (scenario === 'CAPLONG') {
    // Well past the old 1400-character speech cap, with a marker at the very END.
    // The cap sliced mid-sentence and silently — a truncated answer synthesises
    // perfectly and sounds fine right up to where it stops — so the only way to see
    // it is to look at what was HANDED to the synthesiser and check the last words
    // of the answer are in it.
    const line = 'The quick brown fox jumps over the lazy dog. '
    result({ result: line.repeat(90) + '\n\nZZ_LAST_WORDS_OF_THE_ANSWER.' })
    return
  }
  if (scenario === 'LONGHEADINGS') {
    // Headed AND past the file threshold, which is the ONLY combination that earns a
    // read-along page: the page is a companion to answer.md/.html, so a structured
    // answer that still sits inline in the chat must not produce one.
    const body = (n: string) => `The ${n} section says a thing that runs on. `.repeat(60)
    result({ result: `## Alpha\n\n${body('first')}\n\n## Beta\n\n${body('second')}\n\n` +
      `## Gamma\n\n${body('third')}` })
    return
  }
  if (scenario === 'HEADINGS') {
    // A structured answer, for the speech path: the section index on the full voice
    // file and the read-along page both key off headings, and an answer without any
    // correctly produces neither.
    result({ result: '## Alpha\n\nThe first section says a thing.\n\n## Beta\n\n' +
      'The second section says another thing.\n\n## Gamma\n\nAnd the third wraps up.' })
    return
  }
  if (scenario === 'LONG') {
    const table = '| item | value |\n|---|---|\n' + Array.from({ length: 40 }, (_, i) => `| row ${i} | ${i * 7} |`).join('\n')
    result({ result: `# Report\n\n${table}\n\n` + 'Body text that pushes this past the file threshold. '.repeat(200) })
    return
  }
  if (scenario === 'TOOLS') {
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/etc/hosts' } }] } })
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }] } })
    result({ result: `ranTools ${tag}` })
    return
  }
  if (scenario === 'OUTBOX') {
    // Simulate Claude staging a file for delivery: cwd = the topic's dir, so ./outbox/
    // is exactly where the bridge's flushOutbox looks. It should send this as a document.
    mkdirSync('outbox', { recursive: true })
    writeFileSync(join('outbox', 'report.txt'), 'generated by the stub\n')
    result({ result: 'wroteOutbox' })
    return
  }
  // default: one tool step, then a success that echoes the invocation facts.
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'true' } }] } })
  result({ result: `okReply ${tag}` })
}

main()
