// The phrases the phone's wake-word spotter listens for, from the call's wake words.
import { test, expect } from 'bun:test'
import { kwsPhrases } from '../live/kws'

test('"hey" before each wake word in Latin letters, once each; Farsi and digits left out', () => {
  expect(kwsPhrases(['Lucy', 'Lucie', 'لوسی'])).toEqual(['hey lucy', 'hey lucie'])
  expect(kwsPhrases(['  hey,  Lucy! ', 'lucy', 'OK Nova'])).toEqual(['hey lucy', 'ok nova'])
  expect(kwsPhrases(['لوسی', 'R2D2', ' , '])).toEqual([])
})
