/**
 * Tier 1 — unit tests for the pure logic in lib.ts.
 *
 * Hermetic: no Telegram, no CLI, no tokens, no network. Run with `bun test`.
 * Cases are drawn from the regression list in FEEDBACK.md (the "No tests at all"
 * item): stream-json parsing, MarkdownV2/HTML escaping, mode/model normalization,
 * and the path/key helpers.
 */
import { test, expect, describe } from 'bun:test'
import {
  parseIdList, keyFor, sanitize, encodeCwd, parseDirs,
  allowedModes, normalizeMode, permissionArgs,
  normalizeModel, MODEL_DEFAULT,
  toolStep, renderSteps, renderStepsHtml, parseStreamLine, THINKING, type Step,
  needsRich, hasRtl, escapeMoneyDollars,
} from './lib'

describe('parseIdList', () => {
  test('splits, trims, drops empties', () => {
    expect([...parseIdList('1, 2 ,3')]).toEqual(['1', '2', '3'])
    expect([...parseIdList(' 42 ')]).toEqual(['42'])
  })
  test('empty / undefined → empty set', () => {
    expect(parseIdList('').size).toBe(0)
    expect(parseIdList(undefined).size).toBe(0)
    expect(parseIdList(',,').size).toBe(0)
  })
})

describe('keyFor', () => {
  test('topic id present', () => expect(keyFor(-100, 55)).toBe('-100:55'))
  test('undefined thread → :main (the general topic)', () => expect(keyFor(-100, undefined)).toBe('-100:main'))
  test('string chat id', () => expect(keyFor('abc', 1)).toBe('abc:1'))
})

describe('sanitize', () => {
  test('spaces and punctuation → dashes, trimmed', () => {
    expect(sanitize('Hello, World!')).toBe('Hello-World')
  })
  test('leading/trailing separators stripped', () => {
    expect(sanitize('  --foo--  ')).toBe('foo')
  })
  test('caps at 60 chars', () => {
    expect(sanitize('a'.repeat(100)).length).toBe(60)
  })
  test('empty-ish input falls back to "topic"', () => {
    expect(sanitize('')).toBe('topic')
    expect(sanitize('!!!')).toBe('topic')
  })
  test('unicode is NFKD-folded', () => {
    // a combining-accent form normalizes; non-word chars become a dash
    expect(sanitize('café')).toBe('cafe')
  })
})

describe('encodeCwd', () => {
  test('non-alphanumerics → dashes (matches ~/.claude/projects encoding)', () => {
    expect(encodeCwd('/home/george/xesious')).toBe('-home-george-xesious')
    expect(encodeCwd('a_b.c')).toBe('a-b-c')
  })
})

describe('parseDirs', () => {
  test('no argument → empty', () => {
    expect(parseDirs('/sessions')).toEqual([])
    expect(parseDirs('/sessions   ')).toEqual([])
  })
  test('space-separated', () => {
    expect(parseDirs('/sessions /a /b')).toEqual(['/a', '/b'])
  })
  test('comma-separated (paths may contain spaces)', () => {
    expect(parseDirs('/import /a b, /c d')).toEqual(['/a b', '/c d'])
  })
  test('newline-separated', () => {
    expect(parseDirs('/import /a\n/b')).toEqual(['/a', '/b'])
  })
})

describe('allowedModes / normalizeMode', () => {
  test('bypass hidden unless allowed', () => {
    expect(allowedModes(false)).toEqual(['plan', 'acceptEdits', 'auto'])
    expect(allowedModes(true)).toEqual(['plan', 'acceptEdits', 'auto', 'bypass'])
  })
  test('known modes normalize case-insensitively', () => {
    expect(normalizeMode('AUTO', { allowBypass: false })).toBe('auto')
    expect(normalizeMode('acceptedits', { allowBypass: false })).toBe('acceptEdits')
  })
  test('bypass rejected when not allowed, accepted when allowed', () => {
    expect(normalizeMode('bypass', { allowBypass: false })).toBeUndefined()
    expect(normalizeMode('bypassPermissions', { allowBypass: false })).toBeUndefined()
    expect(normalizeMode('bypass', { allowBypass: true })).toBe('bypass')
    expect(normalizeMode('bypasspermissions', { allowBypass: true })).toBe('bypass')
  })
  test('unknown → undefined', () => {
    expect(normalizeMode('yolo', { allowBypass: true })).toBeUndefined()
  })
})

describe('permissionArgs', () => {
  test('bypass → the dangerous flag only', () => {
    expect(permissionArgs('bypass', { allowBypass: true, allowedTools: 'Bash,Read' }))
      .toEqual(['--dangerously-skip-permissions'])
  })
  test('normal mode → permission-mode + allowedTools (raw mode passed through)', () => {
    expect(permissionArgs('auto', { allowBypass: false, allowedTools: 'Bash,Read' }))
      .toEqual(['--permission-mode', 'auto', '--allowedTools', 'Bash,Read'])
  })
  test('bypass requested but not allowed → treated as a normal mode string', () => {
    expect(permissionArgs('bypass', { allowBypass: false, allowedTools: 'Bash' }))
      .toEqual(['--permission-mode', 'bypass', '--allowedTools', 'Bash'])
  })
})

describe('normalizeModel', () => {
  test('default / reset / clear / empty → "" (clears the override)', () => {
    for (const s of [MODEL_DEFAULT, 'reset', 'clear', '', '  ']) {
      expect(normalizeModel(s)).toBe('')
    }
  })
  test('aliases normalize to lowercase alias', () => {
    expect(normalizeModel('Opus')).toBe('opus')
    expect(normalizeModel('haiku')).toBe('haiku')
  })
  test('full claude id passed through untouched', () => {
    expect(normalizeModel('claude-opus-4-8')).toBe('claude-opus-4-8')
    expect(normalizeModel('claude-sonnet-5')).toBe('claude-sonnet-5')
  })
  test('KNOWN GAP: a bracketed context-window suffix is rejected', () => {
    // The accept-regex /^claude[\w.-]*$/i has no `[` or `]`, so an id like
    // `claude-opus-4-8[1m]` (a real, current id) is treated as unknown. Documented
    // here rather than fixed, since Tier 1 only locks down existing behavior.
    expect(normalizeModel('claude-opus-4-8[1m]')).toBeUndefined()
  })
  test('unknown → undefined', () => {
    expect(normalizeModel('gpt-4')).toBeUndefined()
    expect(normalizeModel('turbo')).toBeUndefined()
  })
})

describe('toolStep', () => {
  test('Bash carries the command as detail', () => {
    expect(toolStep({ name: 'Bash', input: { command: 'ls -la' } }))
      .toEqual({ label: '⚙️ Running a command', detail: 'ls -la' })
  })
  test('Read/Edit label by basename', () => {
    expect(toolStep({ name: 'Read', input: { file_path: '/a/b/c.ts' } }).label).toBe('📖 Reading c.ts')
    expect(toolStep({ name: 'Write', input: { file_path: '/x/y.md' } }).label).toBe('✏️ Editing y.md')
  })
  test('Grep joins pattern and path', () => {
    expect(toolStep({ name: 'Grep', input: { pattern: 'foo', path: 'src' } }).detail).toBe('foo  in  src')
  })
  test('unknown tool falls back to generic label', () => {
    expect(toolStep({ name: 'Frobnicate', input: {} }).label).toBe('⚙️ Frobnicate')
  })
  test('missing name → "tool"', () => {
    expect(toolStep({}).label).toBe('⚙️ tool')
  })
})

describe('renderSteps (rich markdown)', () => {
  const steps: Step[] = [{ label: 'A & B', detail: 'echo <hi>' }]
  test('the headline leads the body', () => {
    expect(renderSteps(steps, 1, { progressDetail: false }).startsWith(THINKING)).toBe(true)
  })
  test('progressDetail off → bold label only, no collapsible', () => {
    const out = renderSteps(steps, 1, { progressDetail: false })
    expect(out).toContain('**A &amp; B**')
    expect(out).not.toContain('<details>')
  })
  test('progressDetail on → detail in a collapsible, escaped on both fronts', () => {
    const out = renderSteps(steps, 1, { progressDetail: true })
    expect(out).toContain('<details><summary>A &amp; B</summary>')
    expect(out).toContain('> echo &lt;hi&gt;')
  })
  test('detail longer than detailMax is clipped with an ellipsis', () => {
    const out = renderSteps([{ label: 'x', detail: 'y'.repeat(50) }], 1, { progressDetail: true, detailMax: 10 })
    expect(out).toContain('yyyyyyyyyy…')
    expect(out).not.toContain('y'.repeat(11))
  })
  test('step with no detail renders just the label even when detail is on', () => {
    const out = renderSteps([{ label: 'solo' }], 1, { progressDetail: true })
    expect(out).toBe(`${THINKING}\n\n**solo**`)
  })
  test('trimmed steps are still counted, not silently dropped', () => {
    const out = renderSteps([{ label: 'last' }], 5, { progressDetail: true })
    expect(out).toContain('_+4 earlier steps_')
    expect(renderSteps([{ label: 'last' }], 2, { progressDetail: true })).toContain('_+1 earlier step_')
  })
  test('a todo detail becomes a real task list, ticked where completed', () => {
    const step = toolStep({ name: 'TodoWrite', input: { todos: [
      { content: 'done thing', status: 'completed' },
      { content: 'next thing', status: 'pending' },
    ] } })
    const out = renderSteps([step], 1, { progressDetail: true })
    expect(out).toContain('- [x] done thing')
    expect(out).toContain('- [ ] next thing')
  })
  test('a link detail becomes a markdown link whose target stays whole', () => {
    const url = `https://example.com/${'a'.repeat(80)}`
    const out = renderSteps([toolStep({ name: 'WebFetch', input: { url } })], 1, { progressDetail: true })
    expect(out).toContain(`](${url})`)   // target unclipped — a clipped URL still looks like one
    expect(out).toContain('…]')          // only the visible text is shortened
  })
  test('a link detail that could break the markdown falls back to a quote', () => {
    const out = renderSteps([{ label: 'l', detail: 'https://x.test/a(b)c', kind: 'link' }], 1, { progressDetail: true })
    expect(out).not.toContain('](')
    expect(out).toContain('>')
  })
})

describe('renderStepsHtml (pre-10.1 fallback)', () => {
  const steps: Step[] = [{ label: 'A & B', detail: 'echo <hi>' }]
  test('progressDetail off → bold label only, HTML-escaped, no blockquote', () => {
    const out = renderStepsHtml(steps, { progressDetail: false })
    expect(out).toBe(`${THINKING}\n<b>A &amp; B</b>`)
    expect(out).not.toContain('blockquote')
  })
  test('progressDetail on → detail in an expandable blockquote, escaped', () => {
    const out = renderStepsHtml(steps, { progressDetail: true })
    expect(out).toContain('<b>A &amp; B</b>')
    expect(out).toContain('<blockquote expandable>echo &lt;hi&gt;</blockquote>')
  })
  test('detail longer than detailMax is clipped with an ellipsis', () => {
    const out = renderStepsHtml([{ label: 'x', detail: 'y'.repeat(50) }], { progressDetail: true, detailMax: 10 })
    expect(out).toContain('yyyyyyyyyy…')
    expect(out).not.toContain('y'.repeat(11))
  })
})

describe('parseStreamLine', () => {
  const on = { progressDetail: true }
  const off = { progressDetail: false }

  test('blank and non-JSON lines yield nothing', () => {
    expect(parseStreamLine('', on)).toEqual([])
    expect(parseStreamLine('   ', on)).toEqual([])
    expect(parseStreamLine('not json', on)).toEqual([])
    expect(parseStreamLine('{ partial', on)).toEqual([])
  })

  test('init event carries the session id', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-123' })
    expect(parseStreamLine(line, on)).toEqual([{ kind: 'init', sessionId: 'sess-123' }])
  })

  test('init without session_id is ignored', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init' })
    expect(parseStreamLine(line, on)).toEqual([])
  })

  test('assistant tool_use → a step', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }] },
    })
    expect(parseStreamLine(line, on)).toEqual([
      { kind: 'step', step: { label: '⚙️ Running a command', detail: 'pwd' } },
    ])
  })

  test('thinking block emitted only when progressDetail is on', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
    })
    expect(parseStreamLine(line, on)).toEqual([{ kind: 'step', step: { label: '💭 Thinking', detail: 'hmm' } }])
    expect(parseStreamLine(line, off)).toEqual([])
  })

  test('empty thinking text produces no step', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '  ' }] } })
    expect(parseStreamLine(line, on)).toEqual([])
  })

  test('multiple content blocks in one assistant line → multiple steps', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'go' } },
      ] },
    })
    const out = parseStreamLine(line, on)
    expect(out.length).toBe(2)
    expect(out.every(e => e.kind === 'step')).toBe(true)
  })

  test('successful result', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', session_id: 's', is_error: false, result: '  done  ' })
    expect(parseStreamLine(line, on)).toEqual([{ kind: 'result', text: 'done', sessionId: 's', isError: false }])
  })

  test('is_error true → isError', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'boom' })
    expect(parseStreamLine(line, on)[0]).toMatchObject({ kind: 'result', isError: true })
  })

  test('non-success subtype → isError even if is_error is false', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: false, result: '' })
    expect(parseStreamLine(line, on)[0]).toMatchObject({ kind: 'result', isError: true, text: '' })
  })

  test('result with no text → empty string (bridge maps this to "(empty response)")', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', session_id: 's' })
    expect(parseStreamLine(line, on)[0]).toMatchObject({ text: '', isError: false })
  })
})

// ---------------------------------------------------------------------------
// rich-message routing
// ---------------------------------------------------------------------------

describe('needsRich', () => {
  test('ordinary prose stays on the MarkdownV2 path', () => {
    expect(needsRich('Just a sentence with **bold**, a [link](https://x.test) and a list:\n- one\n- two')).toBe(false)
    expect(needsRich('# Heading\n\n> a quote\n\n`inline code`')).toBe(false)
  })
  test('a real table goes rich', () => {
    expect(needsRich('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(true)
  })
  test('a setext heading under a line containing a pipe is NOT a table', () => {
    // Telegram parses this as a heading, not a table — so must not trigger rich.
    expect(needsRich('costs a | b dollars\n---\nnext paragraph')).toBe(false)
  })
  test('a blank line between header and delimiter breaks the table', () => {
    expect(needsRich('| a | b |\n\n|---|---|')).toBe(false)
  })
  test('collapsibles, formulas, task lists, footnotes and spoilers go rich', () => {
    expect(needsRich('<details><summary>x</summary>y</details>')).toBe(true)
    expect(needsRich('$$a^2 + b^2$$')).toBe(true)
    expect(needsRich('the area $x^2$ is')).toBe(true)
    expect(needsRich('- [ ] todo')).toBe(true)
    expect(needsRich('[^1]: a footnote')).toBe(true)
    expect(needsRich('==marked== text')).toBe(true)
    expect(needsRich('||spoiler||')).toBe(true)
  })
  test('a price is not a formula', () => {
    expect(needsRich('it cost $5 and then $6')).toBe(false)
  })
  test('code is stripped before detecting: a shell snippet is not a table or a formula', () => {
    expect(needsRich('```sh\ncat a | b\n---\necho $HOME | wc -l\n```')).toBe(false)
    expect(needsRich('run `echo $x | tee f` first')).toBe(false)
  })
})

describe('hasRtl', () => {
  test('RTL text is kept off the rich path (Telegram mis-orders it)', () => {
    expect(hasRtl('سلام دنیا')).toBe(true)
    expect(hasRtl('שלום')).toBe(true)
  })
  test('latin text and a stray BOM are not RTL', () => {
    expect(hasRtl('plain ascii')).toBe(false)
    expect(hasRtl('quoted\uFEFFtext')).toBe(false)
  })
})

describe('escapeMoneyDollars', () => {
  test('a price is escaped so it cannot open a formula', () => {
    expect(escapeMoneyDollars('it cost $5')).toBe('it cost \\$5')
  })
  test('the regression: two prices in one sentence stay prices', () => {
    const src = 'The $390B/2025 figure from [McKinsey](https://x.com) is B2B. Actual is a **~$5B/year** business.'
    expect(escapeMoneyDollars(src)).toBe('The \\$390B/2025 figure from [McKinsey](https://x.com) is B2B. Actual is a **~\\$5B/year** business.')
  })
  test('a real inline formula is left alone', () => {
    expect(escapeMoneyDollars('the area is $x^2$ here')).toBe('the area is $x^2$ here')
    expect(escapeMoneyDollars('$\\frac{a}{b}$')).toBe('$\\frac{a}{b}$')
  })
  test('money and a formula on the same line both survive', () => {
    expect(escapeMoneyDollars('costs $5 and $x^2$')).toBe('costs \\$5 and $x^2$')
  })
  test('display math is passed through, prices around it are not', () => {
    expect(escapeMoneyDollars('cost $9:\n$$a_1 + b^2$$\nand $9 again')).toBe('cost \\$9:\n$$a_1 + b^2$$\nand \\$9 again')
  })
  test('code keeps its dollars', () => {
    expect(escapeMoneyDollars('run `echo $HOME` now')).toBe('run `echo $HOME` now')
    expect(escapeMoneyDollars('```sh\ncd $HOME && x=$1\n```')).toBe('```sh\ncd $HOME && x=$1\n```')
    expect(escapeMoneyDollars('```sh\necho $PATH\n```\nit cost $5')).toBe('```sh\necho $PATH\n```\nit cost \\$5')
  })
  test('dollars pair per line, matching Telegram', () => {
    expect(escapeMoneyDollars('a $5 here\nand $6 there')).toBe('a \\$5 here\nand \\$6 there')
  })
  test('an already-escaped dollar is not double-escaped', () => {
    expect(escapeMoneyDollars('a \\$5 and $6')).toBe('a \\$5 and \\$6')
  })
  test('table cells full of money survive', () => {
    expect(escapeMoneyDollars('| b402 | $467,095 | **$517,460** |'))
      .toBe('| b402 | \\$467,095 | **\\$517,460** |')
  })
  test('text with no dollars is returned untouched', () => {
    const src = '# Heading\n\n- [x] done\n\n> quote\n'
    expect(escapeMoneyDollars(src)).toBe(src)
  })
})
