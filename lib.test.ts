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
  needsRich, hasRtl, escapeMoneyDollars, conflictAdvice,
  sanitizeProse, PROSE_RULES, isNonAnswer,
  isSignOff, isDanglingReference, promoteBlock,
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
  test('a bracketed context-window suffix is accepted (was a KNOWN GAP)', () => {
    // `claude-opus-4-8[1m]` is a real, current id — often the one this bridge runs
    // on — and the old accept-class had no `[` or `]`, so it answered "Unknown
    // model". This assertion used to pin the broken behaviour.
    expect(normalizeModel('claude-opus-4-8[1m]')).toBe('claude-opus-4-8[1m]')
    expect(normalizeModel('claude-sonnet-5[200k]')).toBe('claude-sonnet-5[200k]')
  })
  test('…without becoming a rubber stamp', () => {
    // An over-permissive accept just moves the failure to run time, where a bad id
    // costs a whole turn instead of an instant rejection.
    expect(normalizeModel('claude ' + 'x'.repeat(5))).toBeUndefined()   // whitespace
    expect(normalizeModel('claude-' + 'x'.repeat(200))).toBeUndefined() // length bound
    expect(normalizeModel('claude/../../etc/passwd')).toBeUndefined()
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

// ---------------------------------------------------------------------------
// polling conflicts
// ---------------------------------------------------------------------------

describe('conflictAdvice', () => {
  const opts = { ghostLimit: 2, waitMs: 40_000 }
  const joined = (n: number) => conflictAdvice(n, opts).join(' ')

  test('an early conflict is blamed on our own expiring poll', () => {
    for (const n of [1, 2]) {
      expect(joined(n)).toMatch(/own previous poll/i)
      expect(joined(n)).toContain('~30s')
      expect(conflictAdvice(n, opts)).toHaveLength(1)   // one line; this is routine
    }
  })
  test('past the reservation window it stops blaming a ghost', () => {
    const t = joined(3)
    expect(t).not.toMatch(/own previous poll/i)
    expect(t).toMatch(/no longer explains/i)
  })
  test('and it names what the token lock cannot see', () => {
    const t = joined(3)
    // The lock is per user and per machine, so these are the only cases left —
    // saying so is the whole point of distinguishing the two.
    expect(t).toMatch(/another user/i)
    expect(t).toMatch(/another machine/i)
    expect(t).toMatch(/we hold this token's lock/i)
  })
  test('it always says it keeps retrying, and how to actually fix it', () => {
    expect(joined(5)).toMatch(/still retrying/i)
    expect(joined(5)).toMatch(/its own token/i)
  })
  test('the wait and the elapsed total are reported in seconds, not milliseconds', () => {
    expect(joined(1)).toContain('40s')
    expect(joined(3)).toContain('120s')          // 3 rounds x 40s
    expect(joined(3)).not.toContain('40000')
  })
  test('ghostLimit is honoured as given', () => {
    expect(conflictAdvice(1, { ghostLimit: 0, waitMs: 40_000 }).join(' ')).toMatch(/no longer explains/i)
    expect(conflictAdvice(9, { ghostLimit: 99, waitMs: 40_000 }).join(' ')).toMatch(/own previous poll/i)
  })
})

// ---------------------------------------------------------------------------
// prose sanitisation
// ---------------------------------------------------------------------------

describe('sanitizeProse — one row of the table at a time', () => {
  describe("row: '~' — a lone tilde opens GFM strikethrough", () => {
    // The shape that keeps firing: "approximately-a-price" after a bracket or a
    // bold marker. The opener can only open (space then digit); the closer sits
    // between two punctuation characters, so it can close — and the two can be far
    // apart, striking out prose that contains no tilde at all.
    const src = 'output down to ~110m litres/day. Holding consumption flat means **~$8bn of imports** next year.'
    test('escapes a lone tilde on the MarkdownV2 path', () => {
      const out = sanitizeProse(src, 'markdownv2')
      expect(out).toContain('\\~110m')
      expect(out).toContain('\\~$8bn')
      expect(out).toContain('**')          // the bold must survive — it did not before
    })
    test('escapes it on the rich path too (GFM is the dialect there as well)', () => {
      expect(sanitizeProse('about ~5 items', 'rich')).toContain('\\~5')
    })
    test('leaves a real ~~strikethrough~~ alone', () => {
      expect(sanitizeProse('this is ~~struck~~ text', 'markdownv2')).toBe('this is ~~struck~~ text')
    })
    test('never touches a tilde inside code', () => {
      expect(sanitizeProse('run `cd ~/x` now', 'markdownv2')).toBe('run `cd ~/x` now')
      expect(sanitizeProse('```sh\ncd ~ && ls\n```', 'markdownv2')).toBe('```sh\ncd ~ && ls\n```')
      // …but prose on the far side of a fence is still handled
      expect(sanitizeProse('```sh\ncd ~\n```\nabout ~5', 'markdownv2')).toContain('\\~5')
    })
    test('an already-escaped tilde is not double-escaped', () => {
      expect(sanitizeProse('a \\~ b', 'markdownv2')).toBe('a \\~ b')
    })
  })

  describe("row: '$' — rich pairs $…$ per line as inline LaTeX", () => {
    test('money is escaped on the rich path only', () => {
      expect(sanitizeProse('it cost $5', 'rich')).toBe('it cost \\$5')
      expect(sanitizeProse('it cost $5', 'markdownv2')).toBe('it cost $5')  // MarkdownV2 has no math
    })
    test('a real formula survives', () => {
      expect(sanitizeProse('area is $x^2$ here', 'rich')).toBe('area is $x^2$ here')
    })
    test('display math is passed through as a protected region', () => {
      expect(sanitizeProse('$$a_1 + b^2$$', 'rich')).toBe('$$a_1 + b^2$$')
    })
  })

  test('every row in the table is exercised above', () => {
    // Guards the point of the table: adding a character must come with a test.
    expect(PROSE_RULES.map(r => r.char).sort()).toEqual(['$', '~'])
    for (const r of PROSE_RULES) expect(r.why.length).toBeGreaterThan(20)
  })
})

describe('regression: the reported strikethrough incidents', () => {
  // Synthetic, NOT the original transcripts: those are private user conversations
  // and this repository is public. Each reproduces the exact structural shape of
  // the reported failure, and the real blocks were verified against this code
  // out-of-tree.
  test('Instance 2 — two tildes inside one bold span (polymarket, 2026-08-04)', () => {
    const src = '**~200 shares (~$100) resting**'
    const out = sanitizeProse(src, 'markdownv2')
    expect(out).toBe('**\\~200 shares (\\~$100) resting**')
  })
  test('Instance 2 neighbour — spared only by accident, must still be escaped', () => {
    // This one rendered correctly before the fix, for the wrong reason: a `**`
    // boundary happened to sit between the tildes. That was thought to prevent
    // pairing; Instance 3 disproved it. Both must be escaped now.
    expect(sanitizeProse('**100 shares (~$50)**', 'markdownv2')).toBe('**100 shares (\\~$50)**')
  })
  test('Instance 3 — the pair crosses a sentence boundary (scratchpad, 2026-08-11)', () => {
    const src = 'gasoline output down to ~110m litres/day. Holding consumption flat means **~$8bn of gasoline imports** — more than the entire military budget.'
    const out = sanitizeProse(src, 'markdownv2')
    expect(out).toBe('gasoline output down to \\~110m litres/day. Holding consumption flat means **\\~$8bn of gasoline imports** — more than the entire military budget.')
    // Every surviving tilde must be backslash-escaped. Spelled out rather than
    // written as a lookbehind regex, which is unreadable at this level of quoting.
    for (let i = 0; i < out.length; i++) {
      if (out[i] === '~') expect(out[i - 1]).toBe('\\')
    }
  })
  test('the other 14 tildes in that message were already fine and stay fine', () => {
    for (const t of ['~25,300', '(~July 2026)', '~24.5m', '~18.3%', '~22×', '~40m', '~$120bn']) {
      expect(sanitizeProse(`about ${t} total`, 'markdownv2')).toContain('\\~')
    }
  })
})

describe('isNonAnswer', () => {
  test('the CLI queue artefact is not an answer', () => {
    expect(isNonAnswer('No response requested.')).toBe(true)
    expect(isNonAnswer('  no response requested  ')).toBe(true)   // trimmed, case-insensitive
    expect(isNonAnswer('No response requested')).toBe(true)       // with and without the stop
  })
  test('an empty turn is not an answer either', () => {
    expect(isNonAnswer('')).toBe(true)
    expect(isNonAnswer('   \n  ')).toBe(true)
  })
  test('a real answer that MENTIONS the phrase is still an answer', () => {
    // Only an entire message matches. A turn explaining the artefact must not be
    // swallowed by the check meant to catch it.
    expect(isNonAnswer('The CLI sometimes replies "No response requested." — here is why.')).toBe(false)
    expect(isNonAnswer('No response requested. But here is the answer anyway: 42')).toBe(false)
  })
  test('ordinary answers are answers', () => {
    expect(isNonAnswer('42')).toBe(false)
    expect(isNonAnswer('Done — the file is written.')).toBe(false)
  })
})

describe('promoteBlock — which block is really the reply', () => {
  const long = (tag: string) => `${tag}: ` + 'substantive content here. '.repeat(12)

  test('a sign-off does not stand on its own', () => {
    expect(isSignOff("I'll report back when it lands")).toBe(true)
    expect(isSignOff('Monitoring for the cache')).toBe(true)
    expect(isSignOff('The answer is 42.')).toBe(false)
  })
  test('a dangling reference points at work the reader never saw', () => {
    expect(isDanglingReference('Recorded in the skill.')).toBe(true)
    expect(isDanglingReference('Done — 5 files changed.')).toBe(true)
    expect(isDanglingReference('Recording studios cost money.')).toBe(false)  // word boundary
    expect(isDanglingReference('Here is the full breakdown.')).toBe(false)
  })
  test('promotes the substantive block behind a sign-off', () => {
    const blocks = ['Let me check.', long('answer'), "I'll report back when it lands"]
    expect(promoteBlock(blocks, "I'll report back when it lands")).toBe(long('answer'))
  })
  test('promotes behind a dangling reference too', () => {
    const blocks = [long('diagnosis'), 'Recorded in the skill.']
    expect(promoteBlock(blocks, 'Recorded in the skill.')).toBe(long('diagnosis'))
  })
  test('does nothing when the reply stands on its own', () => {
    const blocks = ['Let me check.', long('answer')]
    expect(promoteBlock(blocks, long('answer'))).toBeUndefined()
  })
  test('never promotes text the reply already contains (no double-posting)', () => {
    // The result event usually repeats the final block, and double-posting is a
    // bug this project has fixed once already.
    const body = long('answer')
    expect(promoteBlock([body, 'Done.'], `Done. ${body}`)).toBeUndefined()
  })
  test('skips narration and finds the substance further back', () => {
    const blocks = ['Let me check.', long('real'), 'Now the submit loop:', 'Done.']
    expect(promoteBlock(blocks, 'Done.')).toBe(long('real'))
  })
  test('a single-block turn is left alone', () => {
    expect(promoteBlock(['Done.'], 'Done.')).toBeUndefined()
    expect(promoteBlock([], '')).toBeUndefined()
  })
})

describe('parseStreamLine emits text blocks', () => {
  test('an assistant text block becomes a text event', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '  hello  ' }] } })
    expect(parseStreamLine(line, { progressDetail: false })).toEqual([{ kind: 'text', text: 'hello' }])
  })
  test('blank text yields nothing', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '   ' }] } })
    expect(parseStreamLine(line, { progressDetail: true })).toEqual([])
  })
  test('text is emitted regardless of progressDetail (it drives promotion)', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } })
    expect(parseStreamLine(line, { progressDetail: false })).toHaveLength(1)
  })
})
