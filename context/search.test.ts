import { test, expect, describe } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextIndex, fuse, rrf, FUSION, refersBack, recallPick, timeWindow, normalizeText, numbersIn, latinKeys, persianKeys, NORMALIZE_VERSION, type CtxMessage, type Hit } from './engine'

const T0 = Date.parse('2026-09-12T07:00:00Z') / 1000
const NOW = Date.parse('2026-09-28T15:00:00Z') / 1000
const m = (id: number, minutes: number, from: string, text: string, topic = '7'): CtxMessage =>
  ({ chat: '-100', topic, topicTitle: 'Dev', id, t: T0 + minutes * 60, from, text })
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)

describe('fusing the signals', () => {
  const ids = (list: string, n: number, at: number, key: string) => Array.from({ length: n }, (_, i) => (i === at ? key : `${list}${i}`))
  // X is what the words point at, first; Z is 25th in every list, each of which has
  // other things of its own.
  const lists = [
    { name: 'words', ids: ['X', ...ids('w', 39, 23, 'Z')] }, { name: 'message', ids: ['X', ...ids('m', 39, 23, 'Z')] },
    { name: 'meaning', ids: ids('v', 40, 24, 'Z') }, { name: 'summary', ids: ids('s', 40, 24, 'Z') }, { name: 'summary meaning', ids: ids('sv', 40, 24, 'Z') },
  ]
  const order = (f: Map<string, { score: number }>) => [...f.entries()].sort((a, b) => b[1].score - a[1].score).map(e => e[0])
  test('a stretch the words put first is not buried by one found half-way down by every list', () => {
    const before = order(rrf(lists, 60)), now = order(fuse(lists))
    expect(before.indexOf('Z')).toBeLessThan(before.indexOf('X'))
    expect(now.indexOf('X')).toBeLessThan(now.indexOf('Z'))
  })
  test('two lists that measure the same thing count once, with a little for agreeing', () => {
    const both = fuse([{ name: 'words', ids: ['A'] }, { name: 'message', ids: ['A'] }]).get('A')!.score
    const one = fuse([{ name: 'words', ids: ['A'] }]).get('A')!.score
    expect(both).toBeCloseTo(one * 1.1, 6)
    // Lists of different kinds still add up, and every signal that found it is named.
    const f = fuse([{ name: 'words', ids: ['A'] }, { name: 'meaning', ids: ['A'] }]).get('A')!
    expect(f.score).toBeCloseTo(2 * one, 6)
    expect(f.why).toEqual(['words', 'meaning'])
  })
  test('the default', () => { expect(FUSION).toEqual({ k: 10, group: true, agree: 0.1 }) })
})

describe('does a message point back? (Persian)', () => {
  const back = (t: string) => refersBack(t, { now: NOW })
  test('the past perfect, the past continuous, and asking what was', () => {
    for (const q of ['سارا گفته بود جلسه عقب افتاده، دلیلش چی بود؟', 'علی گفته بود این رو', 'اون سرویس که درخواست زیادی میزد بهمون',
      'چرا سرور تست اصلا بالا نمیومد؟', 'دیتابیس رو منتقل کردیم به نسخه ۲؟', 'آخرین وضعیت قرارداد چیه؟', 'ماجرای باگ پرداخت آخرش به کجا رسید؟',
      'آیا بکاپ‌ها به سرور جدید منتقل شده؟', 'من کی تو گروه پشتیبانی اد شدم؟'])
      expect([q, back(q)]).toEqual([q, true])
  })
  test('but not a request about now', () => {
    for (const q of ['یه اسکریپت پایتون بنویس که فایل‌های تکراری رو پیدا کنه', 'این متن رو به انگلیسی ترجمه کن', 'سلام، خوبی؟', 'هوای تهران الان چطوره؟',
      'مشکل این کد چیه؟', 'یه اسم خوب برای یه گربه پیشنهاد بده', 'چطوری docker رو روی اوبونتو نصب کنم؟', 'این تابع چه کاری انجام میدهد؟'])
      expect([q, back(q)]).toEqual([q, false])
  })
  test('a topic that exists to ask about an archive: every message, but only stretches that match well', () => {
    const h = (why: string[], matched: number[] = []): Hit => ({ episode: { key: why.join('+') } as any, score: 1, why, matched })
    const hits = [h(['words']), h(['words', 'meaning'])]
    expect(recallPick(hits, 'tell me about the demo')).toEqual([])
    expect(recallPick(hits, 'tell me about the demo', { gate: false }).map(x => x.episode.key)).toEqual(['words+meaning'])
  })
})

describe('times said in Persian', () => {
  const w = (t: string) => { const x = timeWindow(t, NOW); return x && `${day(x.since)}..${day(x.until)}` }
  test('relative', () => {
    expect(w('تو یک ماه اخیر سارا چیزی نوشته بود')).toBe('2026-08-28..2026-09-28')
    expect(w('دو هفته پیش درباره کش حرف زدیم')).toBe('2026-09-09..2026-09-18')
    expect(w('روزهای اخیر')).toBe('2026-09-21..2026-09-28')
    expect(w('هفته پیش')).toBe('2026-09-14..2026-09-27')
  })
  test('Gregorian months in Persian letters, with a day or a part of the month', () => {
    expect(w('نه تو ۳ مارس گفته بود')).toBe('2026-03-01..2026-03-06')
    expect(w('اواخر ژوئن')).toBe('2026-06-19..2026-07-01')
    expect(w('تو مارس')).toBe('2026-03-01..2026-04-01')
  })
  test('Solar Hijri months, placed on the Gregorian calendar', () => {
    expect(w('۵ آبان')).toBe('2025-10-25..2025-10-30')
    expect(w('اوایل مرداد')).toBe('2026-07-23..2026-08-04')
    expect(w('تیر ماه')).toBe('2026-06-22..2026-07-23')
  })
  test('month names that are everyday words need a day or "ماه"', () => {
    expect(w('یه تیر زد')).toBeUndefined()
    expect(w('مهر شرکت')).toBeUndefined()
    expect(w('می خوام بدونم')).toBeUndefined()
  })
})

describe('numbers', () => {
  test('"1,000" is indexed as the number it is', () => {
    expect(normalizeText('Temporary $1,000 minimum; ۱۲٬۰۰۰ and 1,000,000')).toBe('Temporary $1000 minimum; 12000 and 1000000')
    expect(normalizeText('1,2,3 and 3,14')).toBe('1,2,3 and 3,14')
  })
  test('written in words, as digits', () => {
    expect(numbersIn('حدود هزار نفر')).toEqual(['1000'])
    expect(numbersIn('دو هزار نفر')).toEqual(['2000'])
    expect(numbersIn('پونصد تا')).toEqual(['500'])
    expect(numbersIn('ten thousand users, 10k volume, $1.5m raised')).toEqual(['10000', '1500000'])
    // "نه" is also "no": only a number before هزار and the like.
    expect(numbersIn('نه، هزار بود')).toEqual(['1000'])
    expect(numbersIn('نه اشتباه میکنی')).toEqual([])
  })
  test('a question in words finds the number written in digits', async () => {
    const idx = new ContextIndex(':memory:')
    idx.add([m(1, 0, 'Sara', 'ظرفیت سالن همایش حدود 1,000 نفره'), m(2, 300, 'Lena', 'the report shows 1 000 errors')])
    idx.refresh()
    const hits = await idx.search('-100', 'سالن هزار نفر', { k: 3 })
    expect(hits[0].episode.ids).toContain(1)
  })
})

describe('names written in the other script', () => {
  test('Persian spellings reach the Latin ones by their consonants', () => {
    const k = (fa: string, en: string) => persianKeys(fa).some(p => latinKeys(en).some(l => p.key === l.key || `${p.key}s` === l.key))
    for (const [fa, en] of [['تلگرام', 'telegram'], ['داکر', 'docker'], ['اسلک', 'slack'], ['جیرا', 'jira'], ['گیتلب', 'gitlab'], ['پایتون', 'python'],
      ['لینوکس', 'linux'], ['اوبونتو', 'ubuntu'], ['پستگرس', 'postgres'], ['انجینکس', 'nginx'], ['ردیس', 'redis'], ['ایجنت', 'agent'], ['سرویس', 'services']])
      expect([fa, k(fa, en)]).toEqual([fa, true])
  })
  test("a question typed in Persian also searches the chat's Latin spelling", async () => {
    const idx = new ContextIndex(':memory:')
    const msgs: CtxMessage[] = []
    // The chat writes these in Latin letters (a few times each, so they are its words).
    for (let i = 0; i < 4; i++) msgs.push(m(10 + i, i * 600, 'Lena', `Docker image and Slack alerts ${i}`, '8'), m(20 + i, i * 600, 'Lena', `the Paris office sent a press release ${i}`, '9'))
    msgs.push(m(1, 5000, 'Sara', 'the docker build breaks when slack is down'))
    idx.add(msgs)
    idx.refresh()
    expect(idx.expandQuery('-100', 'داکر اسلک حدود هزار نفر')).toEqual(['1000', 'docker', 'slack'])
    // The vowels decide between names with the same consonants; everyday Persian is left alone.
    expect(idx.expandQuery('-100', 'پاریس')).toEqual(['paris'])
    expect(idx.expandQuery('-100', 'زیر ولی توی')).toEqual([])
    const hits = await idx.search('-100', 'داکر اسلک', { k: 3 })
    expect(hits.map(h => h.episode.topic)).toContain('7')
  })
})

test('an index made with an older spelling of numbers is indexed again once', async () => {
  const db = join(mkdtempSync(join(tmpdir(), 'xesious-norm-')), 'c.db')
  let idx = new ContextIndex(db)
  idx.add([m(1, 0, 'Sara', 'a temporary $1,000 minimum')])
  idx.refresh()
  // As an older version would have left it: "1,000" indexed as "1" and "000".
  idx.db.run("UPDATE msg_fts SET text = 'a temporary $1 000 minimum'")
  idx.setMeta('normalize', '1')
  idx.close()
  idx = new ContextIndex(db)
  expect(idx.getMeta('normalize')).toBe(NORMALIZE_VERSION)
  expect((await idx.search('-100', '1000', { k: 3 }))[0].episode.ids).toEqual([1])
})
