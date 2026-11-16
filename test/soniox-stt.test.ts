import { test, expect } from 'bun:test'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sonioxTranscribeFile } from '../voice/soniox-stt'

const dir = mkdtempSync(join(tmpdir(), 'sx-'))
const file = join(dir, 'n.ogg')
writeFileSync(file, 'audio')

// A fake fetch: answers by route, records what was asked.
function fake(routes: Record<string, (body: any) => any>) {
  const seen: string[] = []
  const f = (async (url: string, init: any) => {
    const key = `${init.method} ${new URL(url).pathname}`
    seen.push(key)
    const h = routes[key]
    if (!h) return new Response(null, { status: init.method === 'DELETE' ? 204 : 404 })
    const out = h(init.body)
    return out instanceof Response ? out : Response.json(out)
  }) as any
  return { f, seen }
}

test('uploads, waits, reads the text, then deletes the job and the file', async () => {
  let polls = 0
  const { f, seen } = fake({
    'POST /v1/files': () => ({ id: 'F1' }),
    'POST /v1/transcriptions': b => { expect(JSON.parse(b)).toMatchObject({ model: 'stt-async-v6', file_id: 'F1', language_hints: ['en', 'fa'] }); return { id: 'J1', status: 'queued' } },
    'GET /v1/transcriptions/J1': () => ({ status: ++polls < 3 ? 'processing' : 'completed' }),
    'GET /v1/transcriptions/J1/transcript': () => ({ text: '  hello there  ' }),
  })
  expect(await sonioxTranscribeFile(file, { key: 'k', languages: ['en', 'fa'], fetch: f, pollMs: 1 })).toBe('hello there')
  expect(seen.slice(-2)).toEqual(['DELETE /v1/transcriptions/J1', 'DELETE /v1/files/F1'])
})

test('an error from Soniox throws, and what was made there is still deleted', async () => {
  const { f, seen } = fake({
    'POST /v1/files': () => ({ id: 'F2' }),
    'POST /v1/transcriptions': () => ({ id: 'J2' }),
    'GET /v1/transcriptions/J2': () => ({ status: 'error', error_message: 'bad audio' }),
  })
  await expect(sonioxTranscribeFile(file, { key: 'k', fetch: f, pollMs: 1 })).rejects.toThrow('bad audio')
  expect(seen.slice(-2)).toEqual(['DELETE /v1/transcriptions/J2', 'DELETE /v1/files/F2'])
})

test('a refused upload throws without the key in the message', async () => {
  const { f, seen } = fake({ 'POST /v1/files': () => new Response('no credit', { status: 402 }) })
  const e = await sonioxTranscribeFile(file, { key: 'secret-key', fetch: f }).catch(e => e)
  expect(String(e)).toContain('402 no credit')
  expect(String(e)).not.toContain('secret-key')
  expect(seen.filter(s => s.startsWith('DELETE'))).toEqual([])
})
