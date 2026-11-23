// The live page's hearing, without the network: Soniox's token stream, the call's
// decisions about whose words count, and the call recording.
import { test, expect, describe } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, existsSync, utimesSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TokenTracker, splitTurns, configMessage, type Token } from '../live/soniox'
import { CallState, isStopPhrase, words, requestText, looksUnfinished, sendDecision, unclear, quietAfter, isCorrection, FOLLOW_MS } from '../live/call'
import { CallRecorder, pruneCalls } from '../live/recorder'
import { Vad, rms } from '../live/vad'

const tok = (text: string, speaker: string, end: number, is_final = true, language = 'en'): Token =>
  ({ text, speaker, start_ms: end - 60, end_ms: end, is_final, language })

describe('Soniox tokens', () => {
  test("each turn carries the mean of Soniox's confidence in its words", () => {
    const t = [{ ...tok('Yes', '1', 100), confidence: 0.3 }, { ...tok('.', '1', 120), confidence: 0.99 }, { ...tok(' Go', '2', 300), confidence: 0.9 }, { ...tok(' on', '2', 400), confidence: 0.8 }]
    expect(splitTurns(t).map(x => x.confidence)).toEqual([0.3, 0.85])   // punctuation doesn't count
  })
  test('words are grouped by speaker, in order', () => {
    expect(splitTurns([tok('Hel', '1', 100), tok('lo', '1', 200), tok(' there', '2', 300), tok(' you', '1', 400)]))
      .toEqual([{ speaker: '1', text: 'Hello', language: 'en' }, { speaker: '2', text: 'there', language: 'en' }, { speaker: '1', text: 'you', language: 'en' }])
  })
  test('pending words are shown but only <end> finishes a piece', () => {
    const t = new TokenTracker()
    let r = t.push({ tokens: [tok('Hi', '1', 300), tok(' the', '1', 500, false)], total_audio_proc_ms: 600 })
    expect(r.done).toBeNull()
    expect(r.live).toEqual([{ speaker: '1', text: 'Hi the', language: 'en' }])
    // pending words are re-sent in full; the old pending ones are replaced
    r = t.push({ tokens: [tok(' there', '1', 700, false)], total_audio_proc_ms: 800 })
    expect(r.live[0].text).toBe('Hi there')
    r = t.push({ tokens: [tok(' there', '1', 700), { text: '<end>', is_final: true }], total_audio_proc_ms: 1700 })
    expect(r.done).toEqual([{ speaker: '1', text: 'Hi there', language: 'en' }])
    expect(r.finalized).toBe(false)
    expect(t.push({ tokens: [] }).live).toEqual([])
  })
  test('<fin> answers a finalize we asked for', () => {
    const t = new TokenTracker()
    t.push({ tokens: [tok('Stop', '1', 300)] })
    const r = t.push({ tokens: [{ text: '<fin>', is_final: true }] })
    expect(r.done).toEqual([{ speaker: '1', text: 'Stop', language: 'en' }])
    expect(r.finalized).toBe(true)
  })
  test("how long the caller has been quiet while someone else keeps talking", () => {
    const t = new TokenTracker()
    t.push({ tokens: [tok('Book', '1', 1000), tok(' a', '1', 1200), tok(' table', '1', 1500)], total_audio_proc_ms: 1600 })
    t.push({ tokens: [tok(' and the TV goes on', '2', 3400, false)], total_audio_proc_ms: 3500 })
    expect(t.quietMs('1')).toBe(2000)
    expect(t.quietMs('3')).toBeNull()
    expect(t.openWordEnd('1', true)).toBe(3400)
    expect(t.silenceMs()).toBe(100)
  })
  test('silence is measured from the last word anyone said in the open piece', () => {
    const t = new TokenTracker()
    expect(t.silenceMs()).toBeNull()
    t.push({ tokens: [tok('Hello', '1', 900, false)], total_audio_proc_ms: 1000 })
    // Soniox keeps reporting during silence, with the audio position moving on
    t.push({ tokens: [tok('Hello', '1', 900, false)], total_audio_proc_ms: 2400 })
    expect(t.silenceMs()).toBe(1500)
  })
  test("a false wake's words are dropped: those held, and those Soniox sends later", () => {
    const t = new TokenTracker()
    t.push({ tokens: [tok('Some', '1', 300), tok(' TV', '1', 600, false)], total_audio_proc_ms: 700 })
    t.dropBefore(1000)
    expect(t.push({ tokens: [tok(' talk', '1', 900, false)] }).live).toEqual([])
    // finalized later, and the next wake's words after it
    let r = t.push({ tokens: [tok(' TV', '1', 600), tok(' talk', '1', 900), { text: '<fin>', is_final: true }] })
    expect(r.done).toEqual([])
    r = t.push({ tokens: [tok('Hey', '1', 1300), tok(' Lucy', '1', 1600), { text: '<end>', is_final: true }] })
    expect(r.done).toEqual([{ speaker: '1', text: 'Hey Lucy', language: 'en' }])
    t.reset()   // a new connection: word times start over
    expect(t.push({ tokens: [tok('Hi', '1', 200, false)] }).live[0].text).toBe('Hi')
  })
  test('the config asks for both languages, speakers, and the key', () => {
    const c = configMessage({ key: 'k', model: 'stt-rt-v6', languages: ['en', 'fa'], endpointMs: 100 })
    expect(c).toMatchObject({ api_key: 'k', model: 'stt-rt-v6', audio_format: 'pcm_s16le', sample_rate: 16000, language_hints: ['en', 'fa'],
      enable_speaker_diarization: true, enable_endpoint_detection: true, max_endpoint_delay_ms: 500 })
    expect(configMessage({ key: 'k', model: 'm', languages: ['en'], endpointMs: 0 }).enable_endpoint_detection).toBe(false)
  })
})

describe('whose words count', () => {
  const T = (speaker: string | null, text: string) => ({ speaker, text })
  test('the first voice is the caller; others are shown, not sent', () => {
    const c = new CallState()
    let r = c.heard([T('1', 'What time is it in Tokyo?')])
    expect(c.main).toBe('1')
    expect(r.send).toBe('What time is it in Tokyo?')
    r = c.heard([T('2', 'I want pizza tonight'), T('1', 'and in Paris?')])
    expect(r.lines.map(l => l.role)).toEqual(['other', 'me'])
    expect(r.send).toBe('and in Paris?')
  })
  test(`someone else spoke first: picking the caller's voice moves "me"`, () => {
    const c = new CallState()
    c.heard([T('2', 'Is this thing on?')])
    expect(c.main).toBe('2')
    c.setMain('1')
    expect(c.heard([T('1', 'Read my calendar')]).send).toBe('Read my calendar')
    expect(c.heard([T('2', 'Order me a taxi')]).send).toBeNull()
  })
  test("with the talk button held, whatever is said is the caller's", () => {
    const c = new CallState(); c.setMain('1')
    expect(c.heard([T('3', 'Turn the lights off')], { held: true }).send).toBe('Turn the lights off')
  })
  test('"stop" alone, in either language, is a stop, not a request', () => {
    for (const s of ['Stop.', 'stop please', 'Cancel!', 'Stop, stop.', 'Shut up.', 'بس', 'بس بس', 'وایسا', 'صبر کن']) expect(isStopPhrase(s)).toBe(true)
    for (const s of ['stop the timer at five', 'بس که خسته‌ام']) expect(isStopPhrase(s)).toBe(false)
    const c = new CallState(); c.setMain('1')
    const r = c.heard([T('1', 'Stop.')], { busy: true })
    expect(r.stop).toBe(true)
    expect(r.send).toBeNull()
  })
  test("the answer heard back through the phone's speaker is dropped", () => {
    let now = 1000
    const c = new CallState(() => now); c.setMain('1')
    c.speaking('The weather in Berlin is sunny and mild today.')
    c.setPlaying(true)
    let r = c.heard([T('2', 'the weather in Berlin is sunny and mild')])
    expect(r.echo).toHaveLength(1)
    expect(r.lines).toEqual([])
    // the speaker that read it is not mistaken for a new main voice either
    expect(c.main).toBe('1')
    // a few seconds after playback ends, the same words are someone's again
    c.setPlaying(false); now += 5000
    r = c.heard([T('1', 'Berlin is sunny today')])
    expect(r.send).toBe('Berlin is sunny today')
  })
  test("a reply that reuses the answer's words is the caller's, not its echo", () => {
    const c = new CallState(); c.setMain('1')
    c.speaking('If you mean small umbrellas, one bag could hold about two or three of them.')
    c.speaking('Probably none, since an umbrella is longer than a bag.')
    c.setPlaying(true)
    expect(c.heard([{ speaker: '1', text: 'What about a small umbrella?' }]).send).toBe('What about a small umbrella?')
    // the answer itself, misheard a little, is still echo
    expect(c.heard([{ speaker: '2', text: 'one bag could hold about two or three' }]).echo).toHaveLength(1)
    // a single word from the answer: echo only when Soniox wasn't sure
    expect(c.heard([{ speaker: '1', text: 'Bag.', confidence: 0.6 }]).echo).toHaveLength(1)
    expect(c.heard([{ speaker: '1', text: 'Umbrellas.', confidence: 0.97 }]).send).toBe('Umbrellas.')
  })
  test('words that stopped the answer are never then dropped as its echo', () => {
    const c = new CallState(); c.setMain('1')
    c.speaking('What about you try a small umbrella instead.'); c.setPlaying(true)
    expect(c.shouldHush([{ speaker: '1', text: 'No wait what about a small umbrella instead' }])).toBe(true)
    expect(c.heard([{ speaker: '1', text: 'What about a small umbrella instead' }]).send).toBe('What about a small umbrella instead')
  })
  test('nobody becomes "me" from words heard while the answer plays', () => {
    const c = new CallState()
    c.speaking('Hello there.'); c.setPlaying(true)
    c.heard([T('4', 'completely different words here')])
    expect(c.main).toBeNull()
  })
  test("two new words of the caller's over the answer stop the reading; its own words do not", () => {
    const c = new CallState(); c.setMain('1')
    c.speaking('Your next meeting is at three with the design team.'); c.setPlaying(true)
    expect(c.shouldHush([T('1', 'next meeting is at three')])).toBe(false)
    expect(c.shouldHush([T('2', 'hold on a moment')])).toBe(false)
    expect(c.shouldHush([T('1', 'hold on')])).toBe(true)
    expect(c.shouldHush([T('1', 'wait')])).toBe(true)
    c.setPlaying(false)
    expect(c.shouldHush([T('1', 'hold on')])).toBe(false)
  })
  test("others' words go along once, as background", () => {
    const c = new CallState(); c.setMain('1')
    c.heard([T('2', 'We land at nine'), T('3', 'Gate B12')])
    const bg = c.background()
    expect(bg).toBe('speaker 2: We land at nine\nspeaker 3: Gate B12')
    expect(c.background()).toBe('')
    expect(requestText('When do we land?', bg)).toContain('[Background, not a request')
    expect(requestText('Hi', '')).toBe('Hi')
  })
  test("the caller's words heard as someone else, then picked as the caller's, go along with their next request, not on their own", () => {
    const c = new CallState()
    c.heard([T('1', 'Mm-hmm')])                       // a throat-clear became "me"
    c.background()                                   // …and was asked
    const r = c.heard([T('2', 'Look up the train times to the coast')])
    expect(r.send).toBeNull()                        // someone else: not sent
    // "This is me" on speaker 2: nothing is sent yet…
    c.setMain('2'); for (const x of c.lines) x.role = x.speaker === '2' ? 'me' : 'other'
    // …and the caller's next words carry it, labelled as the caller's.
    const next = c.heard([T('2', 'Do what I just said')])
    expect(next.send).toBe('Do what I just said')
    for (const l of next.lines) l.sent = true
    const bg = c.background()
    expect(bg).toBe('you: Look up the train times to the coast')
    expect(c.background()).toBe('')
    expect(requestText(next.send!, bg)).toContain('"you" is the caller')
  })
  test('a sentence that sounds cut off waits for the rest; a finished one goes', () => {
    for (const s of ['Then send the report to—', 'I want the button,', 'tell me about', 'Book a table for', 'یه یادداشت بنویس و', 'what is the'])
      expect(looksUnfinished(s)).toBe(true)
    for (const s of ['Is the train on time today?', 'Stop.', 'Thanks!', 'فردا هوا بارونیه؟', 'He said "hi."'])
      expect(looksUnfinished(s)).toBe(false)
    // Even with a full stop, a word that leads into more is still cut off.
    for (const s of ['Send the summary and.', 'Put it in the.', 'Check the price because.', 'این فایل رو.', 'برو به.'])
      expect(looksUnfinished(s)).toBe(true)
    // Pronouns and words English leaves at the end finish a sentence: each of these
    // endings waited 6 s for nothing on real calls.
    for (const s of ['Can you check this?', 'Read it to me.', 'Open it.', 'What do you think of it?', 'Is that so?', 'Do that.',
      'What are you looking at?', 'Where are you?', 'Thank you.', 'Turn it on.', 'I think so.', 'چی هست این؟', 'Who is it for?', 'Which one are you talking about!'])
      expect(looksUnfinished(s)).toBe(false)
    // A preposition last, with a full stop: Soniox heard no question, it stopped at a pause
    // (2026-11-22: "what time is it in." went early). A rare "I'd love to." waits too.
    for (const s of ['Hey Lucy, what time is it in.', 'Send the report to.', 'Book a table for.', "What's the weather like in", "I'd love to."])
      expect(looksUnfinished(s)).toBe(true)
  })
  test('after a piece ends: a short wait when it sounds finished, the full one when cut off', () => {
    expect(quietAfter('What time is it in Tokyo?', 1000, 300)).toBe(300)
    expect(quietAfter('Read it to me.', 1000, 300)).toBe(300)
    expect(quietAfter('Book a table for', 1000, 300)).toBe(1000)
    expect(quietAfter('Send the summary and.', 1000, 300)).toBe(1000)
    expect(quietAfter('I want the button,', 1000, 300)).toBe(1000)
    expect(quietAfter('Done.', 150, 300)).toBe(150)   // never longer than the full wait
  })
  test('send now, or wait: the button, talking again, unfinished, and the limit', () => {
    const base = { text: 'Give me a—', waitedMs: 1000, stillTalking: false, force: false, maxWaitMs: 6000 }
    expect(sendDecision({ ...base, force: true }).send).toBe(true)
    expect(sendDecision({ ...base, text: 'Done.', stillTalking: true }).send).toBe(false)
    expect(sendDecision(base)).toMatchObject({ send: false })
    expect(sendDecision({ ...base, waitedMs: 6500 })).toMatchObject({ send: true })
    expect(sendDecision({ ...base, text: 'All done.' })).toEqual({ send: true, why: 'sounds finished' })
  })
  test("a short line Soniox isn't sure of is shown but not sent — noise it heard as \"Yes\"", () => {
    expect(unclear('Yes.', 0.3)).toBe(true)
    expect(unclear('Yeah.', 0.72)).toBe(true)
    expect(unclear('Yes.', 0.98)).toBe(false)
    expect(unclear('Turn it off please', 0.55)).toBe(true)
    expect(unclear('Turn the lights off in the kitchen', 0.55)).toBe(false)   // long lines are not judged
    expect(unclear('Yes.', undefined)).toBe(false)
    const c = new CallState()
    // nobody becomes "you" from a line that may be noise
    let r = c.heard([{ speaker: '1', text: 'Yes.', confidence: 0.3 }])
    expect(c.main).toBeNull()
    expect(r.lines[0].unclear).toBe(true)
    expect(r.send).toBeNull()
    c.setMain('1')
    r = c.heard([{ speaker: '1', text: 'Yeah.', confidence: 0.5 }, { speaker: '1', text: 'Tomorrow.', confidence: 0.87 }])
    expect(r.send).toBe('Tomorrow.')
    // "stop" still stops, even unclear
    expect(c.heard([{ speaker: '1', text: 'Stop.', confidence: 0.4 }]).stop).toBe(true)
    // and an unclear word over the answer doesn't cut it off
    c.speaking('The museum opens at nine every weekday.'); c.setPlaying(true)
    expect(c.shouldHush([{ speaker: '1', text: 'Yes. Y', confidence: 0.3 }])).toBe(false)
    expect(c.shouldHush([{ speaker: '1', text: 'Hold on', confidence: 0.95 }])).toBe(true)
  })
  test('Persian letters are matched whatever keyboard wrote them', () => {
    expect(words('كيف')).toEqual(['کیف'])
  })
})

describe('call recording', () => {
  test('mic audio becomes a playable WAV; steps are traced; answers kept', () => {
    const base = mkdtempSync(join(tmpdir(), 'xesious-rec-'))
    const r = new CallRecorder(base, 'abc-123', { topic: 't' })
    r.audio(new Uint8Array(32000))   // 1 s
    r.trace('heard', 'speaker 1 (you)', { text: 'hello' })
    r.answer(new Uint8Array([1, 2, 3]), 'Hi.')
    r.close()
    const wav = readFileSync(join(r.dir, 'mic.wav'))
    expect(wav.subarray(0, 4).toString()).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt32LE(40)).toBe(32000)
    expect(wav.length).toBe(44 + 32000)
    const trace = readFileSync(join(r.dir, 'trace.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(trace.map(t => t.stage)).toEqual(['audio', 'heard', 'voice', 'call'])
    expect(trace[1]).toMatchObject({ msg: 'speaker 1 (you)', text: 'hello', audio_ms: 1000 })
    expect(existsSync(join(r.dir, 'answers', '001.wav'))).toBe(true)
  })
  test('old calls are deleted, recent ones kept', () => {
    const base = mkdtempSync(join(tmpdir(), 'xesious-rec-'))
    mkdirSync(join(base, 'old')); mkdirSync(join(base, 'new'))
    const old = (Date.now() - 9 * 86_400_000) / 1000
    utimesSync(join(base, 'old'), old, old)
    expect(pruneCalls(base, 7)).toEqual(['old'])
    expect(readdirSync(base)).toEqual(['new'])
    expect(pruneCalls(base, 0)).toEqual([])
  })
})

describe('voice in the audio', () => {
  const chunk = (amp: number) => { const b = new Int16Array(1600); for (let i = 0; i < 1600; i++) b[i] = Math.round(amp * Math.sin(i / 5)); return new Uint8Array(b.buffer) }
  test('loudness of a chunk', () => {
    expect(rms(chunk(0))).toBe(0)
    expect(Math.round(rms(chunk(1000)))).toBeGreaterThan(600)
  })
  test('quiet is counted from the last voiced chunk; before anyone speaks it is endless', () => {
    const v = new Vad()
    expect(v.quietMs()).toBe(Infinity)
    for (let i = 0; i < 5; i++) v.push(chunk(2000))
    expect(v.speaking()).toBe(true)
    for (let i = 0; i < 10; i++) v.push(chunk(5))
    expect(v.speaking()).toBe(false)
    expect(v.quietMs()).toBe(1000 - 150)
  })
  test('a short dip inside a sentence is not an end', () => {
    const v = new Vad()
    for (let i = 0; i < 8; i++) v.push(chunk(2000))
    for (let i = 0; i < 4; i++) v.push(chunk(5))      // 0.4 s between words
    for (let i = 0; i < 8; i++) v.push(chunk(2000))
    expect(v.speaking()).toBe(true)
  })
  test('a noisier room raises the bar', () => {
    const v = new Vad()
    for (let i = 0; i < 200; i++) v.push(chunk(150))   // steady hum below the speech floor
    expect(v.speaking()).toBe(false)
    expect(v.noiseFloor).toBeGreaterThan(30)
  })
})

describe('Assistant mode: only what is addressed to it by name goes', () => {
  const T = (speaker: string | null, text: string) => ({ speaker, text })
  const assistant = (now = () => 0) => { const c = new CallState(now); c.setMain('1'); c.mode = 'assistant'; c.wake = ['Lucy', 'لوسی']; return c }
  test('the wake word at the start of the sentence sends the rest; talk without it is background', () => {
    const c = assistant()
    let r = c.heard([T('1', 'I think we should ship on Friday.')])
    expect(r.send).toBeNull()
    expect(r.why).toBe('assistant: not called, kept as background')
    expect(c.heard([T('1', 'Lucy, check the build.')]).send).toBe('check the build.')
    expect(c.heard([T('1', 'Hey Lucy what time is it?')]).send).toBe('what time is it?')
    expect(c.heard([T('1', 'So, Lucy, what do you think?')]).send).toBe('what do you think?')
    // Said in passing, it isn't a call.
    expect(c.heard([T('1', 'I told Lucy about it yesterday.')]).send).toBeNull()
    // At the end of a sentence, after a comma, it is (G, 2026-11-20): the request is the rest.
    const e = c.heard([T('1', 'what do you think about that, Lucy?')])
    expect(e.send).toBe('what do you think about that?')
    expect(e.why).toBe('assistant: called by name ("Lucy")')
    expect(c.heard([T('1', 'Microphone off, Lucy.')]).send).toBe('Microphone off.')
    expect(c.heard([T('1', 'We land at nine. Check the weather there, hey Lucy!')]).send).toBe('We land at nine. Check the weather there!')
    expect(c.heard([T('1', 'Turn the mic off, Lucy')]).send).toBe('Turn the mic off')
    expect(c.heard([T('1', 'دوباره بخون، لوسی')]).send).toBe('دوباره بخون')
    expect(c.heard([T('1', 'Stop, Lucy.')]).stop).toBe(true)
    // Without the comma, or with more after the name in its sentence, it's a mention.
    expect(c.heard([T('1', 'I already told Lucy.')]).send).toBeNull()
    expect(c.heard([T('1', 'Tell it to me, Lucy and Sam.')]).send).toBeNull()
    expect(c.heard([T('1', 'Okay so Lucy, read it again.')]).send).toBe('read it again.')
    // At the start of a later sentence in the same piece.
    expect(c.heard([T('1', 'I agree with you. Lucy, check the build.')]).send).toBe('check the build.')
    expect(c.heard([T('1', 'خب لوسی، دوباره بخون')]).send).toBe('دوباره بخون')
    expect(c.heard([T('1', 'لوسی، ساعت چنده؟')]).send).toBe('ساعت چنده؟')
    // A word that only contains it is not it.
    expect(c.heard([T('1', 'I was lucky today')]).send).toBeNull()
  })
  test("a correction right after its request is for it too, without the name; other talk isn't", () => {
    let t = 0
    const c = assistant(() => t)
    expect(c.heard([T('1', 'Lucy, book a flight to Istanbul for 2 people.')]).send).toBe('book a flight to Istanbul for 2 people.')
    t = 3000
    const r = c.heard([T('1', 'Wait, I mean 3 people.')])
    expect(r.send).toBe('Wait, I mean 3 people.')
    expect(r.why).toBe(`assistant: a correction within ${FOLLOW_MS / 1000} s of its request`)
    t = 4000
    expect(c.heard([T('1', 'Anyway, how was your weekend?')]).send).toBeNull()   // talking to someone: background
    expect(c.heard([T('1', 'نه، سه نفر.')]).send).toBe('نه، سه نفر.')              // a correction again, 1 s after the last
    t = 4000 + FOLLOW_MS + 1
    expect(c.heard([T('1', 'Sorry, I mean four.')]).send).toBeNull()             // too late: background
    expect(['wait, make it five', 'No, the other one.', 'Actually, cancel that.', 'یعنی فردا', 'Um, sorry, not that'].every(isCorrection)).toBe(true)
    expect(['Nowhere near.', 'Waiter, please.', 'Book it.', 'Noted.'].some(isCorrection)).toBe(false)
  })
  test("the unsent talk goes with the next request, the caller's and others'", () => {
    const c = assistant()
    c.heard([T('2', 'The flight is at nine.'), T('1', 'Then we leave at seven.')])
    const r = c.heard([T('1', 'Lucy, add that to my calendar.')])
    expect(r.send).toBe('add that to my calendar.')
    expect(c.background(r.lines.map(l => l.id))).toBe('speaker 2: The flight is at nine.\nyou: Then we leave at seven.')
  })
  test('its name alone waits a few seconds for the request', () => {
    let now = 0
    const c = assistant(() => now)
    const r = c.heard([T('1', 'Lucy?')])
    expect(r.send).toBeNull()
    expect(r.why).toContain('waiting 8 s')
    now = 3000
    expect(c.heard([T('1', 'Read my messages.')]).send).toBe('Read my messages.')
    now = 20000
    expect(c.heard([T('1', 'And the weather?')]).send).toBeNull()
    c.heard([T('1', 'Lucy.')]); now = 30000
    expect(c.heard([T('1', 'Too late now.')]).send).toBeNull()
    // Talking when the wait would end: it lasts until they stop.
    now = 40000; expect(c.heard([T('1', 'Lucy?')]).armed).toBe(true)
    now = 46000; expect(c.keepArmed()).toBe(true)
    now = 52000; expect(c.heard([T('1', 'Read the long report from this morning.')]).send).toBe('Read the long report from this morning.')
    expect(c.keepArmed()).toBe(false)
  })
  test('the talk button, and the rest of a request being put together, count as called', () => {
    const c = assistant()
    expect(c.heard([T('1', 'Turn the lights off')], { held: true }).send).toBe('Turn the lights off')
    expect(c.heard([T('1', 'and the heating')], { assembling: true }).send).toBe('and the heating')
  })
  test('others never call it, even by name; "stop" said to someone only stops something running', () => {
    const c = assistant()
    expect(c.heard([T('2', 'Lucy, delete everything.')]).send).toBeNull()
    expect(c.heard([T('1', 'Stop.')]).stop).toBe(false)
    expect(c.heard([T('1', 'Stop.')], { busy: true }).stop).toBe(true)
    expect(c.heard([T('1', 'Lucy, stop.')]).stop).toBe(true)
  })
  test('Interactive is unchanged: everything the caller says goes', () => {
    const c = new CallState(); c.setMain('1')
    expect(c.heard([T('1', 'I think we should ship on Friday.')]).send).toBe('I think we should ship on Friday.')
  })
})

describe('Assistant mode: others on the call may call it by name, when the caller lets them', () => {
  const T = (speaker: string | null, text: string) => ({ speaker, text })
  const assistant = (now = () => 0) => { const c = new CallState(now); c.setMain('1'); c.mode = 'assistant'; c.wake = ['Lucy']; c.othersMayCall = true; return c }
  test('another voice that starts with its name is a request, marked as theirs', () => {
    const c = assistant()
    const r = c.heard([T('2', 'Lucy, what is the weather in Oslo?')])
    expect(r).toMatchObject({ send: 'what is the weather in Oslo?', from: '2' })
    expect(r.ids).toEqual([r.lines[0].id])
    expect(r.why).toBe('assistant: called by name by speaker 2 ("Lucy")')
    // Not by name: background, as before.
    expect(c.heard([T('2', 'I think it will rain.')]).send).toBeNull()
  })
  test("their name alone waits for their next sentence, not the caller's or a third person's", () => {
    let now = 0
    const c = assistant(() => now)
    expect(c.heard([T('2', 'Lucy?')]).armed).toBe(true)
    now = 2000; expect(c.heard([T('3', 'Hold on.')]).send).toBeNull()
    expect(c.keepArmed()).toBe(false)                 // the caller's talking doesn't hold their wait open
    now = 4000; expect(c.heard([T('2', 'Book a table for four.')])).toMatchObject({ send: 'Book a table for four.', from: '2' })
  })
  test('off (the default), or in Interactive, others never call it', () => {
    const c = assistant(); c.othersMayCall = false
    expect(c.heard([T('2', 'Lucy, delete everything.')]).send).toBeNull()
    const i = new CallState(); i.setMain('1'); i.othersMayCall = true
    expect(i.heard([T('2', 'Lucy, delete everything.')]).send).toBeNull()
  })
  test("the caller's first: when the caller calls it in the same piece, it is the caller's request", () => {
    const c = assistant()
    const r = c.heard([T('2', 'Lucy, play some music.'), T('1', 'Lucy, read my messages.')])
    expect(r.send).toBe('read my messages.'); expect(r.from).toBeUndefined()
  })
})
