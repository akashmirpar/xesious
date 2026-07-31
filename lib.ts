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

export type Step = { label: string; detail?: string }

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
      return { label: '🌐 Looking something up', detail: str(i.url ?? i.query ?? i.prompt) }
    case 'Agent': case 'Task':
      return { label: '🤖 Running a subagent', detail: str(i.description ?? i.prompt) }
    case 'TodoWrite': {
      const todos = Array.isArray(i.todos) ? i.todos.map((t: any) => `• ${t?.content ?? t}`).join('\n') : undefined
      return { label: '📝 Planning', detail: todos }
    }
    default: return { label: `⚙️ ${n}`, detail: str(i.command ?? i.file_path ?? i.pattern) }
  }
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const DETAIL_MAX = 250

// Render the step list for the live status message as HTML: bold label, and the
// detail tucked into a collapsed expandable quote so the topic stays scannable
// but the actual attempt is one tap away.
export function renderSteps(steps: Step[], opts: { progressDetail: boolean; detailMax?: number }): string {
  const detailMax = opts.detailMax ?? DETAIL_MAX
  return steps.map(s => {
    const label = `<b>${escapeHtml(s.label)}</b>`
    if (!opts.progressDetail || !s.detail) return label
    const d = s.detail.trim()
    if (!d) return label
    const clipped = d.length > detailMax ? `${d.slice(0, detailMax)}…` : d
    return `${label}\n<blockquote expandable>${escapeHtml(clipped)}</blockquote>`
  }).join('\n')
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
