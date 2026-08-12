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
  // A full model id (e.g. claude-opus-4-8) — accept it as given.
  if (/^claude[\w.-]*$/i.test(m.trim())) return m.trim()
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
export function renderSteps(steps: Step[], total: number, opts: { progressDetail: boolean; detailMax?: number }): string {
  const detailMax = opts.detailMax ?? DETAIL_MAX
  const parts = steps.map(s => {
    const label = escapeRich(s.label)
    const d = opts.progressDetail ? (s.detail ?? '').trim() : ''
    if (!d) return `**${label}**`
    return `<details><summary>${label}</summary>\n\n${renderDetail(s, d, detailMax)}\n\n</details>`
  })
  const hidden = total - steps.length
  if (hidden > 0) parts.unshift(`_+${hidden} earlier step${hidden === 1 ? '' : 's'}_`)
  return [escapeRich(THINKING), ...parts].join('\n\n')
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

// A rich message reads $...$ as inline LaTeX, and it pairs the dollars line by
// line — so a sentence carrying two prices ("the $390B figure … a ~$5B/year
// business") renders everything between them as an unreadable formula, and eats
// the markdown in there with it. The money isn't what sent the message down this
// path: one table or task list anywhere in the answer drags every dollar sign in
// it along, so the escaping has to happen here and not in needsRich.
//
// Same test as the inline-formula detector: a span holding LaTeX punctuation is a
// formula and is left alone, anything else is money and gets its opening dollar
// escaped. Escaping only the opener matters — it leaves that dollar's partner free
// to open a real formula later on the line, so "costs $5 and $x^2$" keeps both.
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
// Code keeps its dollars: Telegram doesn't parse math inside a fence or a code
// span, and "\$HOME" in a shell snippet would be wrong to copy out. $$…$$ display
// math is passed through for the same reason the inline formulas are.
export function escapeMoneyDollars(text: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]+`|\$\$[\s\S]*?\$\$)/)
    .map((seg, i) => (i % 2 ? seg : seg.split('\n').map(escapeMoneyLine).join('\n')))
    .join('')
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
