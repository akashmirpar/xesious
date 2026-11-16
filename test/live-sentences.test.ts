import { test, expect } from 'bun:test'
import { drainSentences } from '../live/sentences'

// Fed in pieces, as an answer streams: what is spoken, sentence by sentence.
function speak(pieces: string[]): string[] {
  let buf = '', out: string[] = []
  for (const p of pieces) { buf += p; const r = drainSentences(buf); out.push(...r.done); buf = r.rest }
  if (buf.trim()) out.push(buf.trim())
  return out
}

test('a point inside a number is not the end of a sentence, even when the answer arrives split there', () => {
  expect(speak(['The first 30 took 3.', '6 gigabytes at source. The rest is about 0.', '4 gigabytes.'])).toEqual([
    'The first 30 took 3.6 gigabytes at source.', 'The rest is about 0.4 gigabytes.'])
  expect(speak(['Version v1.2.3 is out, see example.com/a.b for more. Done!'])).toEqual(['Version v1.2.3 is out, see example.com/a.b for more.', 'Done!'])
})
test('sentences end at . ! ? … and the Persian question mark, with closing quotes; the last one when the answer ends', () => {
  expect(speak(['Is it ready? ', 'Yes! It said "done." Then', ' it stopped… آماده است؟ بله'])).toEqual(['Is it ready?', 'Yes!', 'It said "done."', 'Then it stopped…', 'آماده است؟', 'بله'])
  expect(speak(['Line one.\nLine two.'])).toEqual(['Line one.', 'Line two.'])
})
