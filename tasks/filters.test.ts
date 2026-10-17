import { test, expect, describe } from 'bun:test'
import { applyRule, fieldOf, numberOf, parseFilterAnswer, ruleError, ruleText, toRule, filterUser, type RuleState } from './filters'
import type { Rule, WatchEvent } from './model'

const at = (sec: number) => new Date(Date.UTC(2026, 9, 16, 12, 0, 0) + sec * 1000).toISOString()
const ev = (text: string, sec = 0): WatchEvent => ({ at: at(sec), text })
// The events of a list that pass, in order, with one state across them.
function run(rule: Rule, lines: [string, number?][]) {
  const st: RuleState = {}
  return lines.map(([text, sec]) => applyRule(rule, st, ev(text, sec ?? 0)))
}
const passes = (rule: Rule, lines: [string, number?][]) => run(rule, lines).map(r => r.pass)

describe('what a rule looks at', () => {
  test('a field of the JSON, nested and in lists; or the whole line', () => {
    expect(fieldOf('{"price": 298.5}', 'price')).toBe('298.5')
    expect(fieldOf('{"data": {"last": 3}, "items": [{"t": "a"}, {"t": "b"}]}', 'items.1.t')).toBe('b')
    expect(fieldOf('{"data": {"last": 3}}', 'data')).toBe('{"last":3}')
    expect(fieldOf('not json', 'price')).toBeUndefined()
    expect(fieldOf('{"price": null}', 'price')).toBeUndefined()
    expect(fieldOf('price 298', undefined)).toBe('price 298')
  })

  test('a number: the value itself, or the first number in a line', () => {
    expect(numberOf('298.5')).toBe(298.5)
    expect(numberOf(' -3e2 ')).toBe(-300)
    expect(numberOf('price 298 (was 301)')).toBe(298)
    expect(numberOf('no numbers here')).toBeUndefined()
  })
})

describe('rules', () => {
  test('above and below: every event past the value', () => {
    expect(passes({ op: 'below', value: 300 }, [['301'], ['299'], ['298']])).toEqual([false, true, true])
    const r = run({ op: 'above', field: 'price', value: 300 }, [['{"price": 301}']])[0]
    expect(r).toEqual({ pass: true, value: '301', why: 'price is 301, above 300' })
  })

  test('crosses: once when it goes past, and again only after it came back', () => {
    const rule: Rule = { op: 'crosses_below', field: 'price', value: 300 }
    const p = (n: number) => [`{"price": ${n}}`] as [string]
    expect(passes(rule, [p(305), p(299), p(297), p(301), p(296)])).toEqual([false, true, false, false, true])
    // Already past it when the watcher starts: that is news once.
    expect(passes(rule, [p(290), p(289)])).toEqual([true, false])
    expect(run(rule, [p(305), p(299)])[1].why).toBe('price went below 300: 299')
  })

  test('change_pct: a move of X% within the window, either way; measured afresh after it fires', () => {
    const rule: Rule = { op: 'change_pct', value: 1, windowMs: 3 * 60_000 }
    const r = run(rule, [['100', 0], ['100.4', 60], ['99.2', 120], ['99.0', 150], ['100.1', 170]])
    expect(r.map(x => x.pass)).toEqual([false, false, true, false, true])
    expect(r[2].why).toBe('the value moved −1.20% in 1 min (100.4 → 99.2)')
    // Outside the window, the old value no longer counts.
    expect(passes(rule, [['100', 0], ['101.5', 200]])).toEqual([false, false])
  })

  test('changed: from the first value on, each one that differs', () => {
    expect(passes({ op: 'changed', field: 'status' }, [['{"status":"ok"}'], ['{"status":"ok"}'], ['{"status":"down"}'], ['{"status":"down"}']]))
      .toEqual([false, false, true, false])
  })

  test('contains and matches, any case', () => {
    const c = run({ op: 'contains', words: ['outage', 'degraded'] }, [['All systems normal'], ['Partial OUTAGE in one region']])
    expect(c.map(x => x.pass)).toEqual([false, true])
    expect(c[1].why).toBe('mentions “outage”')
    expect(passes({ op: 'matches', pattern: 'release v\\d+\\.\\d+' }, [['nothing'], ['Release v2.3 is out']])).toEqual([false, true])
  })

  test('a changed rule starts afresh', () => {
    const st: RuleState = {}
    applyRule({ op: 'crosses_below', value: 300 }, st, ev('299'))
    expect(st.armed).toBe(false)
    expect(applyRule({ op: 'crosses_below', value: 290 }, st, ev('289')).pass).toBe(true)
  })
})

describe('checking and showing a rule', () => {
  test('what is wrong, said so it can be fixed', () => {
    expect(ruleError({ op: 'wobbles' })).toContain('rule.op is one of')
    expect(ruleError({ op: 'below' })).toContain('rule.value')
    expect(ruleError({ op: 'change_pct', value: 1 })).toContain('window_minutes')
    expect(ruleError({ op: 'contains', words: [] })).toContain('rule.words')
    expect(ruleError({ op: 'matches', pattern: '(' })).toContain('not a valid regular expression')
    expect(ruleError({ op: 'changed' })).toBeUndefined()
  })

  test('stored as given, and said in words', () => {
    expect(toRule({ op: 'change_pct', value: 1, window_minutes: 3, field: 'p' })).toEqual({ op: 'change_pct', field: 'p', value: 1, windowMs: 180_000 })
    expect(ruleText(toRule({ op: 'crosses_below', field: 'price', value: 300 }))).toBe('when price goes below 300')
    expect(ruleText(toRule({ op: 'change_pct', value: 1, window_minutes: 3 }))).toBe('when the value moves 1% within 3 min')
    expect(ruleText(toRule({ op: 'contains', words: ['a', 'b'] }))).toBe('when it mentions “a”, “b”')
  })
})

describe('the AI filter', () => {
  test('the items are numbered, each on one line', () => {
    expect(filterUser('Is it big?', ['one\ntwo', 'three'])).toBe('Question: Is it big?\n\nItems:\n1. one two\n2. three')
  })

  test("its answer is read defensively: around other text, items it made up are left out", () => {
    expect(parseFilterAnswer('Sure: {"pass":[{"n":2,"why":"a new outage"}]} hope this helps', 3)).toEqual([{ n: 2, why: 'a new outage' }])
    expect(parseFilterAnswer('{"pass":[{"n":7},{"n":1,"why":"x"},{"n":1,"why":"again"}]}', 3)).toEqual([{ n: 1, why: 'x' }])
    expect(parseFilterAnswer('{"pass":[]}', 3)).toEqual([])
    expect(parseFilterAnswer('I cannot tell', 3)).toBeUndefined()
    expect(parseFilterAnswer('{"items": []}', 3)).toBeUndefined()
  })
})
