/**
 * query.ts — the words the automatic recall searches with, written by a Claude model
 * instead of taken from the message as typed.
 *
 * A message and the history it points at rarely share their words: the question is
 * in one language and the thread in another, a name is transliterated in one and
 * spelled in Latin letters in the other, or the message says "that" and means what
 * was said just before it. A cheap model turns the message, and the talk just before
 * it, into one line of search words: the key terms, every name in the spellings the
 * chat is likely to use, and any time it names. Measured on a real mixed-language
 * history, searching with such words put the right conversation in the top results
 * far more often than the message as typed, for every engine.
 */

export const QUERY_SYSTEM = [
  "You write the search query for a search over a team chat's history (keyword and meaning search).",
  'You are given one message someone just sent in the chat, and the conversation just before it.',
  'Write one short line of search words: the few key terms of what the message asks about, both as the message writes them and in English,',
  "with every product, company, project or person name in the spellings the chat is likely to use — in Latin letters, and in the chat's own",
  'script when it uses another one. Leave out question words and generic words (issue, problem, fix, when, status) unless they are the point.',
  'Keep any time the message names ("in March", "last week"). Use the conversation only to work out what the message refers to.',
  'The conversation may start with the questions asked just before. When the message follows up on them or corrects the answer they got ("no,',
  'it was Sara", "on 3 March"), search for their subject, in their own words and numbers, together with what the message adds.',
  'You may be given terms the chat itself uses often: when the message names one of them in another script or spelling, write it the way the chat does.',
  'No filler words, no question words, no explanation: only the line.',
].join('\n')

// A hint about the chat's writing, from a sample of its text, when a good part of it
// is not in Latin letters: the model then gives names in both scripts. Says which
// script, not which language — the same script serves many.
const SCRIPTS: [string, RegExp][] = [
  ['Arabic', /\p{Script=Arabic}/gu], ['Cyrillic', /\p{Script=Cyrillic}/gu], ['Hebrew', /\p{Script=Hebrew}/gu],
  ['Greek', /\p{Script=Greek}/gu], ['Devanagari', /\p{Script=Devanagari}/gu], ['Bengali', /\p{Script=Bengali}/gu],
  ['Thai', /\p{Script=Thai}/gu], ['Han (Chinese characters)', /\p{Script=Han}/gu], ['Japanese kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/gu],
  ['Hangul', /\p{Script=Hangul}/gu], ['Georgian', /\p{Script=Georgian}/gu], ['Armenian', /\p{Script=Armenian}/gu],
  ['Tamil', /\p{Script=Tamil}/gu], ['Ethiopic', /\p{Script=Ethiopic}/gu],
]
export function languageNote(sample: string): string | undefined {
  const letters = sample.match(/\p{L}/gu)?.length ?? 0
  if (letters < 20) return undefined
  const [name, n] = SCRIPTS.map(([s, rx]) => [s, sample.match(rx)?.length ?? 0] as const).sort((a, b) => b[1] - a[1])[0]
  if (n / letters <= 0.2) return undefined
  return `Much of the chat is written in ${name} script; names and technical terms may appear in Latin letters too.`
}

export function queryUser(message: string, recent?: string, note?: string, terms?: string[]): string {
  return (note ? `${note}\n\n` : '') + (terms?.length ? `<chat_terms>\n${terms.join(', ')}\n</chat_terms>\n\n` : '') +
    (recent?.trim() ? `<conversation>\n${recent.trim()}\n</conversation>\n\n` : '') + `<message>\n${message.trim()}\n</message>`
}

// The query line from the model's reply; undefined when there is nothing usable, so
// the caller searches with the message as typed.
export function parseQuery(reply: string): string | undefined {
  const line = (reply ?? '').split('\n').map(l => l.trim()).find(Boolean)
  if (!line) return undefined
  const q = line.replace(/^(?:search\s*)?(?:query|words)\s*:\s*/i, '').replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim()
  return q.length >= 2 && q.length <= 500 ? q : undefined
}
