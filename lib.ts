/**
 * lib.ts — pure, dependency-injected logic extracted from bridge.ts.
 *
 * Everything here is free of module-level config and side effects: functions that
 * need configuration take it as an explicit parameter rather than closing over a
 * top-level `const`. That is what makes this file unit-testable without importing
 * bridge.ts (which reads env and starts polling Telegram at module scope).
 *
 * bridge.ts imports these and keeps same-named thin wrappers that pass its own
 * constants, so its call sites are unchanged.
 */
import { basename } from 'node:path'

// ---------------------------------------------------------------------------
// ids / keys / paths
// ---------------------------------------------------------------------------

export function parseIdList(s: string | undefined): Set<string> {
  return new Set((s || '').split(',').map(x => x.trim()).filter(Boolean))
}

export function keyFor(chatId: number | string, threadId: number | undefined): string {
  return `${chatId}:${threadId ?? 'main'}`
}

export function sanitize(name: string): string {
  return name.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'topic'
}

export function encodeCwd(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-')
}

// Parse the args of /sessions or /import into directories. Space-separated, or
// comma/newline-separated when a path itself contains spaces.
export function parseDirs(text: string): string[] {
  const i = text.indexOf(' ')
  if (i === -1) return []
  const rest = text.slice(i + 1).trim()
  if (!rest) return []
  const parts = (rest.includes('\n') || rest.includes(',')) ? rest.split(/[\n,]+/) : rest.split(/\s+/)
  return parts.map(p => p.trim()).filter(Boolean)
}

// ---------------------------------------------------------------------------
// permission modes
// ---------------------------------------------------------------------------

export const ALL_MODES = ['plan', 'acceptEdits', 'auto', 'bypass'] as const
export const MODE_HELP: Record<string, string> = {
  plan: 'read-only — researches and proposes, never edits',
  acceptEdits: 'auto-approves edits + the TG_ALLOWED_TOOLS list',
  auto: 'classifier-gated autonomy — blocks destructive/irreversible calls',
  bypass: 'no permission checks at all (--dangerously-skip-permissions)',
}

// The modes offered/accepted. `bypass` is opt-in (TG_ALLOW_BYPASS): without it the
// mode is neither listed nor accepted as an argument.
export function allowedModes(allowBypass: boolean): string[] {
  return ALL_MODES.filter(m => m !== 'bypass' || allowBypass)
}

export function normalizeMode(m: string, opts: { allowBypass: boolean }): string | undefined {
  const s = m.trim().toLowerCase()
  if (s === 'bypass' || s === 'bypasspermissions') return opts.allowBypass ? 'bypass' : undefined
  return allowedModes(opts.allowBypass).find(x => x.toLowerCase() === s)
}

export function permissionArgs(mode: string, opts: { allowBypass: boolean; allowedTools: string }): string[] {
  // bypassPermissions is only honoured via its dedicated flag in -p runs.
  if (normalizeMode(mode, opts) === 'bypass') return ['--dangerously-skip-permissions']
  return ['--permission-mode', mode, '--allowedTools', opts.allowedTools]
}

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------

export const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const
export const MODEL_DEFAULT = 'default' // the label for "clear the override"

// Returns '' for the default (clears the override), the alias/id otherwise,
// undefined for something unrecognised.
export function normalizeModel(m: string): string | undefined {
  const s = m.trim().toLowerCase()
  if (s === MODEL_DEFAULT || s === 'reset' || s === 'clear' || s === '') return ''
  if ((MODEL_ALIASES as readonly string[]).includes(s)) return s
  // A full model id (e.g. claude-opus-4-8, or claude-opus-4-8[1m]). The bracketed
  // context-window suffix is a real, current form — it is often the id this bridge
  // itself runs on — and the old class had no [ or ], so those were rejected with
  // "Unknown model".
  //
  // Widened to admit brackets rather than to "claude followed by anything
  // non-whitespace": an over-permissive accept just moves the failure to run time,
  // where a bad id costs a whole turn instead of an instant, obvious rejection.
  // Anchored and length-bounded against pathological input.
  if (/^claude[\w.\-\[\]]{0,80}$/i.test(m.trim())) return m.trim()
  return undefined
}

// ---------------------------------------------------------------------------
// progress rendering
// ---------------------------------------------------------------------------

// kind steers how the detail is rendered: a URL becomes a tappable link and a todo
// list becomes real checkboxes, while everything else is quoted verbatim.
export type Step = { label: string; detail?: string; kind?: 'link' | 'todo' }

export function toolStep(b: any): Step {
  const n = b?.name || 'tool'
  const i = b?.input || {}
  const base = (p: any) => (p ? basename(String(p)) : '')
  const str = (v: any) => (v == null ? undefined : String(v))
  switch (n) {
    case 'Bash': return { label: '⚙️ Running a command', detail: str(i.command) }
    case 'Read': return { label: `📖 Reading ${base(i.file_path)}`.trimEnd(), detail: str(i.file_path) }
    case 'Edit': case 'Write': case 'NotebookEdit':
      return { label: `✏️ Editing ${base(i.file_path)}`.trimEnd(), detail: str(i.file_path) }
    case 'Glob': case 'Grep':
      return { label: '🔎 Searching the code', detail: [i.pattern, i.path].filter(Boolean).join('  in  ') || undefined }
    case 'WebFetch': case 'WebSearch':
      return { label: '🌐 Looking something up', detail: str(i.url ?? i.query ?? i.prompt), kind: i.url ? 'link' : undefined }
    case 'Agent': case 'Task':
      return { label: '🤖 Running a subagent', detail: str(i.description ?? i.prompt) }
    case 'TodoWrite': {
      // Carry each item's status through as a checkbox marker — the renderer turns
      // it into a real task list, so the step shows progress and not just a list.
      const todos = Array.isArray(i.todos)
        ? i.todos.map((t: any) => `[${t?.status === 'completed' ? 'x' : ' '}] ${t?.content ?? t}`).join('\n')
        : undefined
      return { label: '📝 Planning', detail: todos, kind: todos ? 'todo' : undefined }
    }
    default: return { label: `⚙️ ${n}`, detail: str(i.command ?? i.file_path ?? i.pattern) }
  }
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Rich markdown parses both markdown and arbitrary inline HTML, so raw tool output
// has to be neutralised on both fronts before it can be quoted back: HTML entities
// for the tag characters, backslashes for the markdown punctuation.
export const escapeRich = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/([\\`*_~=|#\[\]()!$^+-])/g, '\\$1')

// A rich message holds 32768 characters, so a detail no longer has to be cut to a
// single line the way it did when every step shared one HTML message.
export const DETAIL_MAX = 1200
const clip = (d: string, max: number) => (d.length > max ? `${d.slice(0, max)}…` : d)

// The run's headline. It stays at the top for the whole run and the steps append
// under it, so an update adds to the status instead of replacing what was there.
export const THINKING = '💭 Thinking…'
// What the progress message becomes once the run is over and it is kept as the
// record of what happened, rather than deleted.
export const RUN_RECORD = '🧾 What ran'

// Render one step's detail for the rich path.
// Markdown folds consecutive lines into one paragraph, which would run a todo list
// or a wrapped thought together; ending each line with two spaces is the GFM hard
// break, keeping the original lines without opening a paragraph gap between them.
// Commands, paths and patterns are quoted rather than set in monospace: the quote
// already marks them as machine text, and mixing fonts inside a paragraph is what
// makes Telegram's line spacing ripple (see the note on needsRich below).
// Takes the detail UNCLIPPED: a link's target has to stay whole, because clipping a
// URL yields one that still looks like a URL and silently goes to the wrong place.
// Only the visible text is shortened; every other kind is clipped as usual.
export function renderDetail(s: Step, raw: string, detailMax = DETAIL_MAX): string {
  if (s.kind === 'todo') {
    return clip(raw, detailMax).split('\n').map(l => {
      const m = l.match(/^\[([ xX])\]\s*(.*)$/)
      return m ? `- [${m[1].trim() ? 'x' : ' '}] ${escapeRich(m[2])}` : `- [ ] ${escapeRich(l)}`
    }).join('\n')
  }
  // A ')' would close the markdown link early, so anything odd stays a plain quote.
  if (s.kind === 'link' && /^https?:\/\/\S+$/.test(raw) && !raw.includes(')')) {
    return `[${escapeRich(raw.length > 60 ? `${raw.slice(0, 57)}…` : raw)}](${raw})`
  }
  return '> ' + escapeRich(clip(raw, detailMax)).split('\n').map(l => l.trim()).filter(Boolean).join('  \n> ')
}

// Render the step list for the live status message as rich markdown. Each step gets
// its own collapsed <details>: the summary is the step label, so the topic still
// reads as a plain list of what ran, and the arguments or the reasoning behind any
// one of them are a single tap away without expanding the rest.
// `total` is the number of steps the run has produced, which may exceed what is
// shown — trimming the oldest must not silently shrink the run's history.
export function renderSteps(steps: Step[], total: number, opts: { progressDetail: boolean; detailMax?: number; headline?: string }): string {
  const detailMax = opts.detailMax ?? DETAIL_MAX
  const parts = steps.map(s => {
    const label = escapeRich(s.label)
    const d = opts.progressDetail ? (s.detail ?? '').trim() : ''
    if (!d) return `**${label}**`
    return `<details><summary>${label}</summary>\n\n${renderDetail(s, d, detailMax)}\n\n</details>`
  })
  const hidden = total - steps.length
  if (hidden > 0) parts.unshift(`_+${hidden} earlier step${hidden === 1 ? '' : 's'}_`)
  return [escapeRich(opts.headline ?? THINKING), ...parts].join('\n\n')
}

// The pre-10.1 rendering, kept as the fallback: one expandable quote per step.
export function renderStepsHtml(steps: Step[], opts: { progressDetail: boolean; detailMax?: number }): string {
  const detailMax = opts.detailMax ?? DETAIL_MAX
  return [escapeHtml(THINKING), ...steps.map(s => {
    const label = `<b>${escapeHtml(s.label)}</b>`
    if (!opts.progressDetail || !s.detail) return label
    const d = s.detail.trim()
    if (!d) return label
    return `${label}\n<blockquote expandable>${escapeHtml(clip(d, detailMax))}</blockquote>`
  })].join('\n')
}


// ---------------------------------------------------------------------------
// rich-message routing
// ---------------------------------------------------------------------------

// TEMPORARY — REMOVE WHEN TELEGRAM FIXES THE BUGS BELOW.
//
// A rich message renders its plain paragraphs in a different font and line height
// from every other message in the chat, so a thread that mixes the two looks
// inconsistent, and rich text is broken outright for right-to-left scripts:
//   https://bugs.telegram.org/c/63677  taller bubbles / extra line spacing than the
//     same text sent normally (Desktop + iOS). CLOSED 2026-07-16 with no explanation
//     and no fix — so do NOT read "closed" here as "safe to remove this workaround".
//   https://bugs.telegram.org/c/62776  iOS ignores the user's Settings > Appearance
//     text size for rich text, plus odd padding and line spacing. Open.
//   https://bugs.telegram.org/c/62877  RTL (Persian/Arabic): table alignment breaks
//     and list bullets sit on the wrong side, on Android but not Desktop. Open.
// Verified here 2026-08-01: the SAME unformatted sentence sent through
// sendRichMessage and through sendMessage came back visibly different.
//
// So rich is spent only where it buys something MarkdownV2 genuinely cannot
// express — a table, a collapsible, a formula, a task list, a footnote, a spoiler.
// Ordinary prose, bold, italic, links, quotes, bullet lists and code blocks all
// render fine the old way and now stay there; so do headings, which MarkdownV2
// turns into bold. Once the rendering is consistent, delete needsRich/hasRtl and
// send everything as rich again.
//
// Detectors run on the text with code stripped out: a shell snippet is full of
// pipes and dollar signs, and matching those would send every command to the rich
// path for a table and a formula that aren't there.
const stripCode = (s: string) => s.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '')
const RICH_ONLY = [
  // Table: a header line, then a delimiter row on the VERY next line that itself
  // contains a pipe. Both conditions matter — GFM breaks a table at a blank line,
  // and a bare "---" under a line that merely happens to contain a pipe is a setext
  // heading, not a table. Telegram agrees: it parses that as a heading.
  /^[^\n]*\|[^\n]*\n(?=[^\n]*\|)[ \t:|-]*-[ \t:|-]*$/m,
  /<details|<summary|<tg-/i,                            // collapsible and custom blocks
  /\$\$[\s\S]+?\$\$|```math/,                           // display formula
  /\$[^$\n]*[\\^_{}][^$\n]*\$/,                         // inline formula (LaTeX-ish, not "$5")
  /^\s*[-*+]\s+\[[ xX]\]\s/m,                           // task list (MarkdownV2 drops the checkbox)
  /^\s*\[\^[^\]]+\]:/m,                                 // footnote definition
  /==[^=\n]+==|\|\|[^|\n]+\|\||<sub>|<sup>/i,           // marked, spoiler, sub/sup
]
export const needsRich = (s: string) => { const t = stripCode(s); return RICH_ONLY.some(re => re.test(t)) }
// Rich text mis-orders right-to-left scripts, so never use it for them. The last
// range stops at FEFC, the final Arabic presentation form: FEFF is the byte order
// mark, and a stray BOM in quoted text is not a reason to reformat the message.
export const hasRtl = (s: string) => /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/.test(s)

// ---------------------------------------------------------------------------
// prose sanitisation — ONE stage per output dialect
// ---------------------------------------------------------------------------
//
// Why this is a table rather than another patch. Three times in eight days the
// model wrote ordinary prose and a character in it was read as markup by whichever
// dialect the bridge was about to use: currency ($390B … ~$5B/year became one
// LaTeX span), then the "approximately" tilde twice, on a different path, where a
// stray pair struck out a whole sentence and ate the bold with it. Each was fixed
// where it was found — escapeRich here, telegramify(…, 'escape') there,
// escapeMoneyDollars bolted on — so nothing in the codebase knew the full set of
// characters that mean something in a given dialect, and the next one was always
// found by a user in production.
//
// So: one stage, one table, one test per row. Adding a character should be a row
// and a test, not an incident.
//
// The rules only ever see PROSE. Code is split out first and never touched: a
// shell snippet is full of pipes, dollars and tildes, and "\$HOME" would be wrong
// to copy out of a fence.

export type Dialect = 'markdownv2' | 'rich'

// Regions a rule must never enter, per dialect. Rich also parses $$…$$ as display
// math, which is real formatting rather than prose and is passed through whole.
const PROTECTED: Record<Dialect, RegExp> = {
  markdownv2: /(```[\s\S]*?```|`[^`\n]+`)/,
  rich:       /(```[\s\S]*?```|`[^`\n]+`|\$\$[\s\S]*?\$\$)/,
}

type ProseRule = {
  char: string          // the character, for test names and documentation
  dialects: Dialect[]
  why: string
  apply: (prose: string) => string
}

// A lone tilde opens GFM strikethrough. GFM needs the closer to be right-flanking:
// a tilde preceded by a space and followed by a digit ("~110m") can only OPEN,
// while one sitting between two punctuation characters ("(~$100", "**~$8bn") is
// both left- and right-flanking and can CLOSE. So the recurring shape is
// "approximately-a-price after a bracket or a bold marker" — exactly what prose
// about money writes constantly — and the two tildes can be far apart, crossing
// sentences, striking out text containing no tilde at all.
//
// Note what an earlier diagnosis got wrong: a `**` boundary between two tildes was
// thought to prevent pairing. It does not. Strikethrough wins, the bold loses, and
// the delimiters are emitted as literal asterisks.
const tildeRule: ProseRule = {
  char: '~',
  dialects: ['markdownv2', 'rich'],
  why: 'a lone ~ opens GFM strikethrough and can swallow an unbounded span of prose',
  // Two lookbehinds: skip a real ~~strikethrough~~, and skip a tilde the model
  // already escaped — double-escaping shows the user a stray backslash, which is
  // the same class of bug in the other direction. The money rule has always had
  // this guard; the first draft of this one did not, and a test caught it.
  apply: prose => prose.replace(/(?<!~)(?<!\\)~(?!~)/g, '\\~'),
}

// Rich text reads $…$ as inline LaTeX and pairs the dollars line by line, so a
// sentence carrying two prices renders everything between them as an unreadable
// formula. The money is not what sent the message down the rich path — one table
// anywhere drags every dollar in the answer along — so this belongs here and not
// in needsRich.
//
// A span holding LaTeX punctuation is a formula and is left whole; anything else
// is money and gets its OPENING dollar escaped. Escaping only the opener leaves
// its partner free to open a real formula later on the line, so "costs $5 and
// $x^2$" keeps both.
const LATEXISH = /[\\^_{}]/
function escapeMoneyLine(line: string): string {
  let out = '', i = 0
  while (i < line.length) {
    const open = line.indexOf('$', i)
    if (open < 0) { out += line.slice(i); break }
    if (line[open - 1] === '\\') { out += line.slice(i, open + 1); i = open + 1; continue }
    const close = line.indexOf('$', open + 1)
    if (close > 0 && LATEXISH.test(line.slice(open + 1, close))) {
      out += line.slice(i, close + 1); i = close + 1        // a formula — leave it whole
    } else {
      out += line.slice(i, open) + '\\$'; i = open + 1      // money
    }
  }
  return out
}

const moneyRule: ProseRule = {
  char: '$',
  dialects: ['rich'],
  why: 'rich text pairs $…$ per line as inline LaTeX, so two prices swallow the text between them',
  // Per line, because Telegram does not pair across a newline and neither should we.
  apply: prose => prose.split('\n').map(escapeMoneyLine).join('\n'),
}

export const PROSE_RULES: ProseRule[] = [tildeRule, moneyRule]

// AUDITED, DELIBERATELY NO RULE. Recorded so the audit is a decision rather than
// an omission, and so nobody re-opens it without new evidence:
//   #  and  >   at line start — these are a real heading and a real quote far more
//                often than they are prose. Escaping them would break the common
//                case to fix a rare one.
//   ==marked==  a model writing "x==y" outside code is rare, and escaping would
//                break the legitimate use, which needsRich explicitly routes for.
//   [^1]        footnote syntax essentially never appears in prose outside code.
//   |  above --- already handled in needsRich, whose table detector requires the
//                delimiter row to carry a pipe (a bare --- under a line containing
//                one is a setext heading, and Telegram agrees).
//   ||spoiler|| the plausible false positive is "A || B" as logical-or in prose.
//                Left alone for now: no observed instance, and a rule here would
//                break real spoilers. THIS IS THE MOST LIKELY NEXT ROW — add it
//                with evidence, as a row and a test.

// Neutralise prose for one dialect. Code regions are passed through untouched.
export function sanitizeProse(text: string, dialect: Dialect): string {
  const rules = PROSE_RULES.filter(r => r.dialects.includes(dialect))
  if (!rules.length) return text
  return text
    .split(PROTECTED[dialect])
    .map((seg, i) => {
      if (i % 2) return seg                    // protected: code, or display math
      let out = seg
      for (const r of rules) out = r.apply(out)
      return out
    })
    .join('')
}

// Kept as a named export: the money pass is one row of the table above, and the
// existing call sites and regression tests refer to it by this name.
export function escapeMoneyDollars(text: string): string {
  return text
    .split(PROTECTED.rich)
    .map((seg, i) => (i % 2 ? seg : moneyRule.apply(seg)))
    .join('')
}

// ---------------------------------------------------------------------------
// which block is the reply
// ---------------------------------------------------------------------------
//
// The bridge delivers the LAST thing the model said, which treats position as
// authority. That holds for a conversational turn and breaks for an agentic one:
// the model answers, keeps working, and signs off — and the sign-off is what gets
// delivered, so the reply reads as evasive precisely because it is a closing
// summary of a conversation whose substance was deleted.
//
// Every length threshold proposed for this failed against a real case: 590 chars
// mattered, 415 mattered, 658 was junk. The detectable property is not size, it is
// that the final block does not stand on its own — it either promises future work,
// or opens by referring to work the reader never saw.
//
// Measured over every transcript on disk (test/replay-text-blocks.ts): of 490
// multi-block turns, 53 end in a sign-off and 71 in a dangling reference.
// Promoting the prior block in those cases costs 72 extra messages fleet-wide,
// against 1,739 if every block were delivered.

// A closing promise reports nothing and commits to the future.
export function isSignOff(s: string): boolean {
  return /\b(i'?ll (report|update|let you know|come back|follow up)|will report|report back|when it (lands|finishes|completes)|monitoring|keep you posted|stand by)\b/i.test(s)
}

// Deixis without an antecedent: only parses if the preceding blocks were seen.
export function isDanglingReference(s: string): boolean {
  return /^(recorded|done|that'?s (fixed|done)|fixed|updated|added|removed|committed|restarted|noted)\b/i.test(s.trim())
}

// The substantive block to deliver BEFORE the reply, or undefined when the reply
// stands on its own. Deliberately conservative: this is an enhancement on top of
// keeping the full text in the progress message, so a miss costs the reader a tap
// rather than the message itself.
export function promoteBlock(blocks: string[], finalText: string, opts?: { minChars?: number }): string | undefined {
  const min = opts?.minChars ?? 200
  if (blocks.length < 2) return undefined
  const last = blocks[blocks.length - 1]
  if (!isSignOff(last) && !isDanglingReference(last)) return undefined
  // Skip anything the reply already contains: the result event usually repeats the
  // final block, and double-posting is a bug this project has fixed once already.
  for (let i = blocks.length - 2; i >= 0; i--) {
    const b = blocks[i]
    if (b.length >= min && b !== last && !finalText.includes(b)) return b
  }
  return undefined
}

// ---------------------------------------------------------------------------
// non-answers
// ---------------------------------------------------------------------------

// Some turns end without producing an answer, and the text they end with must not
// be shown to the user as though it were one.
//
// `No response requested.` is the case that prompted this: found 11 times in a
// single session, as an assistant message whose ENTIRE text is that sentence,
// with stop_reason "stop_sequence" and preceded by queue-operation records. It is
// an artefact of the CLI's queue layer, not a reply — but the bridge took it as
// the turn's final text and posted it verbatim, so from the phone it read as the
// question being brushed off. It is not topic-specific and it is not plan mode.
//
// Deliberately NOT auto-retried, though a verbatim resend does work. An agentic
// turn may already have edited files or run commands, so resending re-runs the
// prompt and can repeat those side effects; "a resend works" describes a HUMAN
// choosing to resend. The bridge surfaces it and offers the retry instead.
const NON_ANSWERS = [
  'no response requested.',
  'no response requested',
]

export function isNonAnswer(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return true                       // an empty turn is a non-answer too
  return NON_ANSWERS.includes(t.toLowerCase())
}

// ---------------------------------------------------------------------------
// polling conflicts (409)
// ---------------------------------------------------------------------------

// What to say when Telegram answers getUpdates with 409 — it has another open
// getUpdates for this token. Pure, so the wording is testable rather than being
// strings only a human can audit.
//
// The distinction this exists to draw only became available once the bridge takes
// a token lock at startup. Before that, every 409 got one generic guess. Now:
//
//   * Early conflicts are almost certainly THIS deployment's own previous poll. A
//     bridge that exits leaves its long-poll reserved server-side for ~30s, so a
//     restart routinely meets its own ghost. Waiting past the reservation clears
//     it, which is why this path self-heals instead of crash-looping.
//   * Once we have waited well past that window and are still being terminated, a
//     ghost no longer explains it. We hold the token lock, and the lock is scoped
//     per user and per token — so no bridge of THIS user on THIS machine can be
//     polling. That leaves exactly what the lock cannot see: the same token running
//     as another user on this box, or on another machine entirely.
//
// Both cases keep retrying, because either clears the moment the other side stops.
// Only the diagnosis changes, and it changes what a human should do about it.
export function conflictAdvice(n: number, opts: { ghostLimit: number; waitMs: number }): string[] {
  const secs = Math.round(opts.waitMs / 1000)
  if (n <= opts.ghostLimit) {
    return [`409 conflict (#${n}) — most likely this deployment's own previous poll, ` +
            `still reserved server-side for ~30s after a restart. Waiting ${secs}s for it to expire…`]
  }
  const waited = Math.round((n * opts.waitMs) / 1000)
  return [
    `409 conflict (#${n}) — a lingering poll of our own no longer explains this: ` +
      `we have waited about ${waited}s, well past the ~30s reservation.`,
    `we hold this token's lock, so no bridge of this user on this machine is polling it. ` +
      `That leaves the same TELEGRAM_BOT_TOKEN running as ANOTHER USER on this box, or on another machine.`,
    `still retrying every ${secs}s — this clears by itself once that instance stops. ` +
      `To fix it: stop that instance, or give this deployment its own token.`,
  ]
}

// ---------------------------------------------------------------------------
// stream-json parsing
// ---------------------------------------------------------------------------

// One meaningful event decoded from a single `claude --output-format stream-json`
// line. The side effects (pushing to a step list, editing the status message,
// resolving the run) stay in bridge.ts; the classification lives here so it can be
// tested against recorded fixtures.
export type StreamEvent =
  | { kind: 'step'; step: Step }
  | { kind: 'text'; text: string }
  | { kind: 'result'; text: string; sessionId?: string; isError: boolean }
  | { kind: 'init'; sessionId: string }

// Decode one NDJSON line into zero or more events. A blank or unparseable line
// yields none (the CLI can emit partial/non-JSON lines; the caller skips them).
export function parseStreamLine(line: string, opts: { progressDetail: boolean }): StreamEvent[] {
  if (!line.trim()) return []
  let o: any
  try { o = JSON.parse(line) } catch { return [] }
  const out: StreamEvent[] = []
  if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
    for (const b of o.message.content) {
      if (b?.type === 'tool_use') {
        out.push({ kind: 'step', step: toolStep(b) })
      } else if (b?.type === 'text') {
        // The model's own words, mid-turn. Previously ignored outright, so in any
        // turn where the model answered and then kept working, the answer was
        // discarded and the user received only the closing summary. Measured
        // across every transcript on disk: 48% of turns that produced text
        // produced more than one block, 393,916 characters in total.
        const t = String(b.text ?? '').trim()
        if (t) out.push({ kind: 'text', text: t })
      } else if (b?.type === 'thinking' && opts.progressDetail) {
        // The reasoning behind the next step — what the model is trying, not just
        // what it ran. Collapsed like any other detail.
        const t = String(b.thinking ?? '').trim()
        if (t) out.push({ kind: 'step', step: { label: '💭 Thinking', detail: t } })
      }
    }
  } else if (o.type === 'result') {
    out.push({
      kind: 'result',
      text: String(o.result ?? '').trim(),
      sessionId: o.session_id,
      isError: Boolean(o.is_error) || o.subtype !== 'success',
    })
  } else if (o.type === 'system' && o.subtype === 'init' && o.session_id) {
    out.push({ kind: 'init', sessionId: o.session_id })
  }
  return out
}
