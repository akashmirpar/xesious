import { test, expect, describe, afterAll } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextIndex, PHOTO_TEXT_IN_STRETCH, type CtxMessage } from './engine'
import { cleanPhotoText, readPhotos } from './ocr'

const T0 = Date.parse('2026-09-12T07:00:00Z') / 1000
const dir = mkdtempSync(join(tmpdir(), 'xesious-ocr-'))
const m = (id: number, minutes: number, from: string, text: string, topic = '810'): CtxMessage =>
  ({ chat: '-100', topic, topicTitle: 'Office', id, t: T0 + minutes * 60, from, text })
const EMAIL = 'Office closed on Friday for maintenance\nAcme Facilities <facilities@acme.example>\n' +
  'The building will be closed on Friday 3 October for elevator maintenance. Parking level B2 stays open.\nRooms affected: 4A · 4B · 5C · Cafeteria · Gym · Library'

function store(): ContextIndex {
  const idx = new ContextIndex(':memory:')
  idx.add([
    m(1, 0, 'Sara', '[photo] فکر کنم جمعه ساختمون بسته است'),
    m(2, 120, 'Lena', '(forwarded from Tech News) [photo] a new database release is out'),
    m(3, 200, 'Maryam', 'lunch is at one today'),
    m(10, 0, 'Sara', 'the build is broken again', '7'),
  ])
  idx.setMedia('-100', 1, 'photo', '/data/photo_1.jpg')
  idx.setMedia('-100', 2, 'photo', '/data/photo_2.jpg')
  idx.refresh()
  return idx
}

describe('the text in a photo', () => {
  test('finds the message by what the photo says, not only by its caption', async () => {
    const idx = store()
    expect(await idx.search('-100', 'elevator maintenance Cafeteria', { k: 3 })).toEqual([])
    idx.setMediaText('-100', 1, EMAIL, 'test')
    const hits = await idx.search('-100', 'elevator maintenance Cafeteria', { k: 3 })
    expect(hits[0].episode.ids).toContain(1)
    expect(hits[0].matched).toEqual([1])
  })

  test("goes into the stretch's text, marked as read by machine and cut short", () => {
    const idx = store()
    const before = idx.episode('-100:810:1')!
    idx.setMediaText('-100', 1, EMAIL + '\n' + 'log line '.repeat(200), 'test')
    idx.refresh()
    const after = idx.episode('-100:810:1')!
    // Where stretches are cut does not move: the same stretch, now with the photo's words.
    expect(after.ids).toEqual(before.ids)
    const line = after.text.split('\n').find(l => l.includes('#1 '))!
    expect(line).toContain('[text in the photo, machine-read: Office closed on Friday for maintenance / Acme Facilities')
    expect(line.length).toBeLessThan(before.text.length + PHOTO_TEXT_IN_STRETCH + 60)
    expect(line).toContain('…]')
  })

  test('changes only the stretches with photos: the summaries of the rest stay', () => {
    const idx = store()
    idx.setSummary('-100:810:1', 'sonnet', 'About: news')
    idx.setSummary('-100:7:10', 'sonnet', 'About: a broken build')
    idx.setMediaText('-100', 1, EMAIL, 'test')
    idx.refresh()
    expect(idx.summaryOf('-100:7:10', 'sonnet')).toBe('About: a broken build')
    // The stretch with the photo is due a new summary, of the text it now has.
    expect(idx.summaryOf('-100:810:1', 'sonnet')).toBeUndefined()
    expect(idx.episodesNeedingSummary('sonnet').map(e => e.key)).toEqual(['-100:810:1'])
  })

  test('a photo with nothing to read is recorded, so it is not read again', () => {
    const idx = store()
    expect(idx.photosToRead().map(p => p.id)).toEqual([2, 1])     // newest first
    idx.setMediaText('-100', 2, '', 'test')
    expect(idx.photosToRead().map(p => p.id)).toEqual([1])
    expect(idx.episode('-100:810:1')!.text).not.toContain('text in the photo')
    // A better reader can go over them again (and the one never read).
    expect(idx.photosToRead({ engine: 'better' }).map(p => p.id)).toEqual([2, 1])
    expect(idx.photosToRead({ engine: 'test' }).map(p => p.id)).toEqual([1])
  })

  test('survives the message being added again (an edit, or an archive re-imported)', async () => {
    const idx = store()
    idx.setMediaText('-100', 1, EMAIL, 'test')
    idx.add([m(1, 0, 'Sara', '[photo] edited caption')])
    idx.refresh()
    expect((await idx.search('-100', 'Cafeteria', { k: 3 }))[0].episode.ids).toContain(1)
    expect(idx.episode('-100:810:1')!.text).toContain('edited caption [text in the photo, machine-read: Office closed')
  })

  test('arrives before its message is indexed, and is used when it is', async () => {
    const idx = new ContextIndex(':memory:')
    idx.setMediaText('-100', 1, EMAIL, 'test')
    idx.add([m(1, 0, 'Sara', '[photo]')])
    idx.refresh()
    expect((await idx.search('-100', 'Cafeteria', { k: 3 }))[0].episode.ids).toEqual([1])
  })

  test('goes with its message when retention prunes it', () => {
    const idx = store()
    idx.setMediaText('-100', 1, EMAIL, 'test')
    idx.pruneBefore('-100', T0 + 60)
    expect(idx.mediaTextOf('-100', [1]).size).toBe(0)
    expect(idx.mediaOf('-100', [1]).size).toBe(0)
    expect(idx.mediaOf('-100', [2]).size).toBe(1)
  })
})

describe('tidying what was read', () => {
  const L = (...t: string[]) => t.map(text => ({ text, score: 0.9 }))
  test("keeps the words, drops a chart's axis, icons, stray letters and repeats", () => {
    expect(cleanPhotoText(L('Weekly Active Users', '2,000', '1,500', '12:00', '•••', 'E', 'Signups', 'Signups', '80,961 visits', '0.38315152681602462 GB')))
      .toBe('Weekly Active Users\nSignups\n80,961 visits\n0.38315152681602462 GB')
  })
  test('keeps a long number, and Persian', () => {
    expect(cleanPhotoText(L('48213377', 'جلسه فردا به ساعت ۱۰ منتقل شد meeting room B'))).toBe('48213377\nجلسه فردا به ساعت ۱۰ منتقل شد meeting room B')
  })
  test('stops at a size', () => {
    expect(cleanPhotoText(L('a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)), 70)).toBe(`${'a'.repeat(30)}\n${'b'.repeat(30)}`)
  })
})

describe('reading photos through the service', () => {
  const photo = join(dir, 'p.jpg')
  writeFileSync(photo, 'JPEGBYTES')
  let calls = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls++
      const body = await req.text()
      if (body !== 'JPEGBYTES') return Response.json({ error: 'wrong bytes' }, { status: 400 })
      return Response.json({ lines: [{ text: 'Office closed on Friday for maintenance', score: 0.99 }, { text: '3,000', score: 0.9 }], ms: 5, model: 'stub/fa+en' })
    },
  })
  afterAll(() => server.stop(true))

  test('reads the photos not read yet, and not again', async () => {
    const idx = new ContextIndex(':memory:')
    idx.add([m(1, 0, 'Sara', '[photo] the building'), m(2, 5, 'Lena', '[photo]')])
    idx.setMedia('-100', 1, 'photo', photo)
    idx.setMedia('-100', 2, 'photo', join(dir, 'missing.jpg'))
    const errors: string[] = []
    const n = await readPhotos(idx, `http://127.0.0.1:${server.port}`, { onEach: p => { if (p.error) errors.push(`${p.id}`) } })
    expect(n).toBe(1)
    expect(errors).toEqual(['2'])
    expect(idx.mediaTextOf('-100', [1]).get(1)).toBe('Office closed on Friday for maintenance')
    const before = calls
    expect(await readPhotos(idx, `http://127.0.0.1:${server.port}`)).toBe(0)
    expect(calls).toBe(before)
  })

  test('an image the service will not read is passed over, not the end of the run', async () => {
    const bad = Bun.serve({ port: 0, fetch: () => Response.json({ error: 'not an image this service can read' }, { status: 415 }) })
    try {
      const idx = new ContextIndex(':memory:')
      idx.add([m(1, 0, 'Sara', '[photo]'), m(2, 5, 'Lena', '[photo]')])
      idx.setMedia('-100', 1, 'photo', photo)
      idx.setMedia('-100', 2, 'photo', photo)
      const errors: number[] = []
      expect(await readPhotos(idx, `http://127.0.0.1:${bad.port}`, { onEach: p => { if (p.error) errors.push(p.id) } })).toBe(0)
      expect(errors).toEqual([2, 1])
      // Recorded as unreadable, so it is not sent again.
      expect(idx.photosToRead().length).toBe(0)
    } finally { bad.stop(true) }
  })

  test('a service that is down is an error to the caller, and nothing is stored', async () => {
    const idx = new ContextIndex(':memory:')
    idx.add([m(1, 0, 'Sara', '[photo]')])
    idx.setMedia('-100', 1, 'photo', photo)
    await expect(readPhotos(idx, 'http://127.0.0.1:9')).rejects.toThrow()
    expect(idx.photosToRead().length).toBe(1)
  })
})

test('read_messages shows what a photo says, next to where the file is', async () => {
  const db = join(dir, 'mcp.db')
  const idx = new ContextIndex(db)
  idx.add([m(1, 0, 'Sara', '[photo] the building'), m(2, 5, 'Lena', 'ok')])
  idx.setMedia('-100', 1, 'photo', '/data/photo_1.jpg')
  idx.setMediaText('-100', 1, EMAIL, 'test')
  idx.refresh()
  idx.close()
  const p = spawn(process.execPath, [join(import.meta.dir, 'mcp.ts')], { env: { ...process.env, XESIOUS_CONTEXT_DB: db, XESIOUS_CONTEXT_CHAT: '-100' }, stdio: ['pipe', 'pipe', 'inherit'] })
  let out = ''
  p.stdout.on('data', d => { out += d })
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_messages', arguments: { topic: '810', around_id: 1 } } }) + '\n')
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_history', arguments: { query: 'elevator maintenance Cafeteria' } } }) + '\n')
  for (let i = 0; i < 100 && out.split('\n').filter(Boolean).length < 2; i++) await new Promise(r => setTimeout(r, 50))
  p.stdin.end()
  const res = out.split('\n').filter(Boolean).map(l => JSON.parse(l))
  const read = res.find(r => r.id === 1).result.content[0].text as string
  expect(read).toContain('#1 Sara: [photo] the building (photo file: /data/photo_1.jpg) [text in the photo, machine-read: Office closed on Friday for maintenance')
  expect(read).toContain('Cafeteria')
  expect(res.find(r => r.id === 2).result.content[0].text).toContain('#1 Sara: [photo] the building [text in the photo, machine-read:')
})
