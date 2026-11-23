// The call's fast page actions (live/fast.ts): which requests are asked, what is sent,
// and what is made of the decision model's answer.
import { test, expect, afterAll } from 'bun:test'
import { decideFast, fastAction, fastWorthAsking, FAST_ACTIONS, type FastConfig } from '../live/fast'

let answer: unknown = {}
let status = 200
const seen: { auth: string | null; body: any }[] = []
const srv = Bun.serve({ port: 0, async fetch(req) { seen.push({ auth: req.headers.get('authorization'), body: await req.json() }); return Response.json(answer, { status }) } })
afterAll(() => { srv.stop(true) })
const cfg: FastConfig = { key: 'test-key', models: ['m1'], timeoutMs: 1000, url: `http://127.0.0.1:${srv.port}/decisions` }
const says = (choice: unknown, confidence = 0.99) => { status = 200; answer = { answers: { action: { type: 'choice', choice, confidence } }, usage: { cost: 0.0001 } } }

test('only short requests with no number in them are asked', () => {
  expect(fastWorthAsking('Turn the mic off.')).toBe(true)
  expect(fastWorthAsking('switch to assistant')).toBe(true)
  expect(fastWorthAsking('mic off for 2 minutes')).toBe(false)                                   // a time the page action can't carry
  expect(fastWorthAsking('count to three and then turn the microphone off please okay')).toBe(false)   // long: a request for the desk
  expect(fastWorthAsking('   ')).toBe(false)
})

test('what is sent: the words, the listed actions and the key, to the first model', async () => {
  says('mic_off'); seen.length = 0
  const r = await decideFast('Turn the mic off.', cfg)
  expect(r).toMatchObject({ action: 'mic_off', conf: 0.99, model: 'm1' })
  expect(seen).toHaveLength(1)
  expect(seen[0].auth).toBe('Bearer test-key')
  expect(Object.keys(seen[0].body).sort()).toEqual(['model', 'questions', 'state'])
  expect(seen[0].body.state).toContain('Said: "Turn the mic off."')
  expect(seen[0].body.questions.action.criteria).toEqual(FAST_ACTIONS)
})

test('a sure answer from the list is done on the page; "none" or an unsure one goes to the desk', async () => {
  says('mic_off', 0.95); expect(fastAction(await decideFast('mic off', cfg), 0.9)).toBe('mic_off')
  says('mic_off', 0.85); expect(fastAction(await decideFast('mic off', cfg), 0.9)).toBeNull()
  says('none', 0.99); expect(fastAction(await decideFast('what time is it', cfg), 0.9)).toBeNull()
  // the answers switch never came up on a real call: it needs more certainty
  says('answers_silent', 0.93); expect(fastAction(await decideFast('answer silently', cfg), 0.9)).toBeNull()
  says('answers_silent', 0.96); expect(fastAction(await decideFast('answer silently', cfg), 0.9)).toBe('answers_silent')
})

test('an answer that is not one of the listed actions, by name, is never acted on', async () => {
  // ["mic_off"] and "constructor" both passed an `in` check; an array then fell through
  // to the last branch of the page action and set the answers to silent.
  for (const bad of [['mic_off'], ['none'], 'constructor', '__proto__', 'toString', 'mic_on', 42, null, { mic_off: 1 }]) {
    says(bad)
    const r = await decideFast('mic off', cfg)
    expect('error' in r).toBe(true)
    expect(fastAction(r, 0.9)).toBeNull()
  }
})

test('a model that fails is passed over for the next; with none left the request goes to the desk', async () => {
  status = 500; answer = { error: 'down' }; seen.length = 0
  const r = await decideFast('mic off', { ...cfg, models: ['m1', 'm2'] })
  expect(seen.map(s => s.body.model)).toEqual(['m1', 'm2'])
  expect(r).toMatchObject({ error: 'm2: 500' })
  expect(fastAction(r, 0.9)).toBeNull()
})
