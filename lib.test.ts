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
  toolStep, renderSteps, parseStreamLine,
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

describe('renderSteps', () => {
  const steps = [{ label: 'A & B', detail: 'echo <hi>' }]
  test('progressDetail off → bold label only, HTML-escaped, no blockquote', () => {
    const out = renderSteps(steps, { progressDetail: false })
    expect(out).toBe('<b>A &amp; B</b>')
    expect(out).not.toContain('blockquote')
  })
  test('progressDetail on → detail in an expandable blockquote, escaped', () => {
    const out = renderSteps(steps, { progressDetail: true })
    expect(out).toContain('<b>A &amp; B</b>')
    expect(out).toContain('<blockquote expandable>echo &lt;hi&gt;</blockquote>')
  })
  test('detail longer than detailMax is clipped with an ellipsis', () => {
    const out = renderSteps([{ label: 'x', detail: 'y'.repeat(50) }], { progressDetail: true, detailMax: 10 })
    expect(out).toContain('yyyyyyyyyy…')
    expect(out).not.toContain('y'.repeat(11))
  })
  test('step with no detail renders just the label even when detail is on', () => {
    expect(renderSteps([{ label: 'solo' }], { progressDetail: true })).toBe('<b>solo</b>')
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
