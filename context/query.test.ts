import { test, expect } from 'bun:test'
import { languageNote, parseQuery, queryUser, QUERY_SYSTEM } from './query'

test('the prompt names what the words are for and keeps times', () => {
  expect(QUERY_SYSTEM).toContain('search query')
  expect(QUERY_SYSTEM).toContain('in March')
})

test('a chat in Arabic script gets a hint to give names in both scripts', () => {
  expect(languageNote('آخرین وضعیت پروژه چیه؟ project status رو چک کردی؟')).toContain('Arabic script')
  expect(languageNote('Какой сейчас статус проекта? проверь status пожалуйста')).toContain('Cyrillic script')
  expect(languageNote('what did we decide about the Friday demo?')).toBeUndefined()
  expect(languageNote('ok')).toBeUndefined()
})

test('the message and the talk before it are marked apart', () => {
  const u = queryUser('what about that?', 'Sara: the vendor sync is stuck again', 'hint')
  expect(u).toBe('hint\n\n<conversation>\nSara: the vendor sync is stuck again\n</conversation>\n\n<message>\nwhat about that?\n</message>')
  expect(queryUser('hi')).toBe('<message>\nhi\n</message>')
})

test("the chat's own terms come first, so a name is spelled the way the chat spells it", () => {
  expect(queryUser('اوریون رو چه پلنی هست؟', undefined, undefined, ['orion', 'helix'])).toBe('<chat_terms>\norion, helix\n</chat_terms>\n\n<message>\nاوریون رو چه پلنی هست؟\n</message>')
})

test('the reply is one line of words; anything unusable means "search as typed"', () => {
  expect(parseQuery('expense هزینه approve twice double approval\n')).toBe('expense هزینه approve twice double approval')
  expect(parseQuery('Query: "vendor sync stuck"')).toBe('vendor sync stuck')
  expect(parseQuery('\n\n  orion اوریون plan  ')).toBe('orion اوریون plan')
  expect(parseQuery('')).toBeUndefined()
  expect(parseQuery('x')).toBeUndefined()
})
