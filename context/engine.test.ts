import { test, expect, describe } from 'bun:test'
import { ContextIndex, episodesOf, ftsQuery, rrf, type CtxMessage, type Embedder } from './engine'

const T0 = Date.parse('2026-07-01T09:00:00Z') / 1000
const m = (id: number, minutes: number, from: string, text: string, topic = '10', chat = '-100'): CtxMessage =>
  ({ chat, topic, topicTitle: topic === '10' ? 'Product' : 'Grants', id, t: T0 + minutes * 60, from, text })

const chat: CtxMessage[] = [
  m(1, 0, 'Maryam', 'what if every Friday each of us shows what they built that week?'),
  m(2, 2, 'Sara', 'love it, 20 minutes max per person'),
  m(3, 3, 'Ali', 'ok but not during the release week'),
  // a long pause: a new episode
  m(4, 300, 'Tom', 'the NGO discount is approved, 40% off the first year'),
  m(5, 302, 'Lena', 'I will update the pricing page'),
  m(6, 2000, 'Nika', 'grant deadline moved to 12 September', '20'),
  m(7, 2003, 'Sara', 'مهلت گرنت دوباره عقب افتاد؟', '20'),
]

describe('episodes', () => {
  test('a pause starts a new stretch of conversation', () => {
    const eps = episodesOf(chat.filter(x => x.topic === '10'), { minMsgs: 1 })
    expect(eps.map(e => e.ids)).toEqual([[1, 2, 3], [4, 5]])
    expect(eps[0].text).toContain('Product — 2026-07-01')
    expect(eps[0].text).toContain('#2 Sara: love it')
  })
  test('but a stretch too short to mean much carries on across a pause, up to half a day', () => {
    const topic = chat.filter(x => x.topic === '10')
    expect(episodesOf(topic).map(e => e.ids)).toEqual([[1, 2, 3, 4, 5]])
    expect(episodesOf(topic, { hardGap: 60 * 60 }).map(e => e.ids)).toEqual([[1, 2, 3], [4, 5]])
  })
  test('and so does a size cap', () => {
    const many = Array.from({ length: 70 }, (_, i) => m(100 + i, i, 'Ali', `message ${i}`))
    expect(episodesOf(many).map(e => e.ids.length)).toEqual([30, 30, 10])
  })
})

describe('keyword query', () => {
  test('drops mentions and filler, quotes every word, prefixes long ones', () => {
    expect(ftsQuery('@scout_bot what happened with the Friday demo thing?')).toBe('"friday"* OR "demo"')
  })
  test('keeps Persian words and splits on the zero-width non-joiner', () => {
    expect(ftsQuery('مهلت گرنت‌ها چی شد')).toBe('"مهلت" OR "گرنت" OR "ها"')
  })
  test('nothing left means no query', () => { expect(ftsQuery('what is it?')).toBe('') })
  test('FTS syntax in a question is inert', () => { expect(ftsQuery('NEAR(a b) "x" OR -y*')).toBe('"near"') })
})

test('reciprocal-rank fusion rewards agreement', () => {
  const f = rrf([{ name: 'a', ids: ['x', 'y'] }, { name: 'b', ids: ['y', 'z'] }])
  const order = [...f.entries()].sort((p, q) => q[1].score - p[1].score).map(e => e[0])
  expect(order[0]).toBe('y')
  expect(f.get('y')!.why).toEqual(['a', 'b'])
})

describe('the index', () => {
  // Every pause cuts here, so the tests can name the stretches they expect.
  const idx = new ContextIndex(':memory:', undefined, { minMsgs: 1 })
  idx.add(chat)
  idx.add([m(50, 0, 'Eve', 'friday demo is secret here', '10', '-200')])
  idx.refresh()

  test('finds the stretch of talk behind a vague question', async () => {
    const hits = await idx.search('-100', 'is the friday thing still happening?')
    expect(hits[0].episode.ids).toEqual([1, 2, 3])
    expect(hits[0].why).toContain('words')
  })
  test('never answers from another chat', async () => {
    const hits = await idx.search('-100', 'secret')
    expect(hits.length).toBe(0)
    expect((await idx.search('-200', 'secret'))[0].episode.chat).toBe('-200')
  })
  test('Persian', async () => {
    expect((await idx.search('-100', 'مهلت گرنت'))[0].episode.ids).toEqual([6, 7])
  })
  test('can be limited to a topic and a time range', async () => {
    expect((await idx.search('-100', 'grant deadline', { topic: '10' })).length).toBe(0)
    expect((await idx.search('-100', 'discount', { since: T0 + 1000 * 60 })).length).toBe(0)
  })
  test('an edit replaces the words it is found by', async () => {
    idx.add([{ ...chat[4], text: 'I will update the website copy' }])
    idx.refresh()
    expect((await idx.search('-100', 'pricing page')).length).toBe(0)
    expect((await idx.search('-100', 'website copy'))[0].episode.ids).toEqual([4, 5])
  })
  test('a digest makes an episode findable by the name people later gave it', async () => {
    const ep = (await idx.search('-100', 'friday'))[0].episode
    expect((await idx.search('-100', 'showcase')).length).toBe(0)
    idx.setDigest(ep.key, 'Idea: a weekly Friday showcase ("demo day"). Proposed by Maryam.')
    expect((await idx.search('-100', 'showcase'))[0].episode.key).toBe(ep.key)
  })
  test('retention removes old messages and their episodes', () => {
    expect(idx.pruneBefore('-100', T0 + 1000 * 60)).toBe(5)
    expect(idx.stats('-100')).toMatchObject({ messages: 2, episodes: 1 })
  })
})

test('with an embedder, meaning finds what words cannot', async () => {
  // A toy embedder: one dimension per concept, so the test is about the plumbing.
  const concepts = [['demo', 'showcase', 'friday', 'present'], ['discount', 'ngo', 'pricing', 'price']]
  const emb: Embedder = {
    name: 'toy',
    async embed(texts) {
      return texts.map(t => Float32Array.from(concepts.map(c => c.filter(w => t.toLowerCase().includes(w)).length + 0.01)))
    },
  }
  const idx = new ContextIndex(':memory:', emb, { minMsgs: 1 })
  idx.add(chat)
  idx.refresh()
  expect(await idx.embedPending()).toBe(3)
  const hits = await idx.search('-100', 'when do we present our work to each other?')
  expect(hits[0].episode.ids).toEqual([1, 2, 3])
  expect(hits[0].why).toContain('meaning')
  expect(idx.stats().vectors).toBe(3)
})

test('Persian spelled with Arabic letters, diacritics or Persian digits still matches', async () => {
  const { normalizeText } = await import('./engine')
  expect(normalizeText('كيك')).toBe('کیک')
  expect(normalizeText('۱۲ شهریور')).toBe('12 شهریور')
  const idx = new ContextIndex(':memory:')
  idx.add([{ chat: '-1', topic: 'main', id: 1, t: T0, from: 'Reza', text: 'قرارداد جدید تا ۱۲ شهریور امضا میشه' }])
  idx.refresh()
  expect((await idx.search('-1', 'قرارداد 12'))[0]?.episode.ids).toEqual([1])
  expect((await idx.search('-1', 'قراردادِ جديد'))[0]?.episode.ids).toEqual([1])
})

describe('the recall gate', () => {
  test('a message that points back', async () => {
    const { refersBack } = await import('./engine')
    const now = Date.parse('2026-08-19T10:00:00Z') / 1000
    for (const t of ['what happened with that idea?', 'is the Friday demo still on?', 'who suggested the discount?', 'any news on the grant?',
      'what did we decide last Tuesday?', 'مهلت گرنت چی شد؟', 'یادته درباره قیمت چی گفتیم؟']) expect(refersBack(t, { now })).toBe(true)
    for (const t of ['write a haiku about Mondays', 'how do I undo my last git commit?', 'what time is it in Tokyo?', 'چطوری یه فایل CSV رو تو پایتون بخونم؟'])
      expect(refersBack(t, { now })).toBe(false)
    expect(refersBack('how long was the downtime during Operation Elephant?', { names: ['Elephant'], now })).toBe(true)
    expect(refersBack('what does Nika think?', { names: ['Nika'], now })).toBe(true)
  })
  test("a group's proper names: capitalised mid-sentence, never in lower case", () => {
    const idx = new ContextIndex(':memory:')
    idx.add([
      m(1, 0, 'Ali', 'starting Operation Elephant tonight'), m(2, 1, 'Sara', 'good luck with Operation Elephant!'),
      m(3, 2, 'Tom', 'the Open call is today'), m(4, 3, 'Tom', 'is the door open? And the Open doc'),
    ])
    idx.refresh()
    const names = idx.people('-100')
    expect(names).toContain('Elephant')
    expect(names).toContain('Operation')
    expect(names).not.toContain('Open')           // also written in lower case: a word, not a name
    expect(names).toContain('Sara')
  })
  test('nothing is handed over for a message that does not point back', async () => {
    const { recallPick } = await import('./engine')
    const idx = new ContextIndex(':memory:', undefined, { minMsgs: 1 })
    idx.add(chat); idx.refresh()
    const hits = await idx.search('-100', 'friday demo')
    expect(hits.length).toBeGreaterThan(0)
    expect(recallPick(hits, 'write a friday demo script')).toEqual([])
    expect(recallPick(hits, 'is the friday demo still on?').length).toBeGreaterThan(0)
  })
})

test('an embedder that fails costs the meaning signal, not the search', async () => {
  let fail = false
  const emb: Embedder = { name: 'flaky', async embed(texts) { if (fail) throw new Error('server down'); return texts.map(() => Float32Array.from([1, 0])) } }
  const idx = new ContextIndex(':memory:', emb, { minMsgs: 1 })
  idx.add(chat); idx.refresh()
  await idx.embedPending()
  fail = true
  const hits = await idx.search('-100', 'friday demo')
  expect(hits[0].episode.ids).toEqual([1, 2, 3])
  expect(hits[0].why).not.toContain('meaning')
})
