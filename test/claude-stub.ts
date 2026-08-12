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
const framed = /^\[xesious:[0-9a-f]+\] message from [^\n]*\n/.test(rawPrompt)
const prompt = framed ? rawPrompt.slice(rawPrompt.indexOf('\n') + 1) : rawPrompt
const scenario = prompt.trim().split(/\s+/)[0] ?? ''
const resumeId = val('--resume')
const model = val('--model')
const effort = val('--effort')
// A stable-ish session id derived from the resume arg: a new turn mints one, a
// resumed turn keeps reporting a session so bridge re-persists it.
const sessionId = resumeId ?? 'sessTESTAAA'

const emit = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
const initLine = () => emit({ type: 'system', subtype: 'init', session_id: sessionId, model: model ?? 'claude-opus-5[1m]', claude_code_version: '2.1.219' })
const result = (extra: Record<string, unknown>) =>
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, ...extra })

const tag = `${resumeId ? 'hadResume' : 'noResume'} ${model ? 'modelSet' : 'modelDefault'} ${framed ? 'framed' : 'unframed'} ${effort ? 'effort' + effort : 'effortDefault'}`

async function main() {
  initLine()

  if (scenario === 'HANG') {
    // Stay genuinely alive (a real timer — a bare pending promise wouldn't keep the
    // event loop up, and Bun would exit immediately) so the bridge's
    // CLAUDE_TIMEOUT_MS is what SIGKILLs us. That is the path under test.
    setTimeout(() => process.exit(0), 60_000)
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
