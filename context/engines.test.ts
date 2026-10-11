import { test, expect, describe, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ContextIndex, recallPick, type CtxMessage, type Embedder, type Hit } from './engine'
import { buildEngines, defaultEngineId, envEmbedding, DEFAULT_EMBED_URL, historyChat, loadEnginesConfig, type EnginesConfig } from './engines'
import { importExport, topicsOf, messageText, botApiChatId } from './import-telegram'
import { cleanDigest, splitDigests, digestBatchUser } from './digest'
import { linkTemplate, recallBody, RECALL_CAVEAT } from './recall'
import { reviewPage } from './review'

const T0 = Date.parse('2026-05-01T09:00:00Z') / 1000
const msg = (id: number, minutes: number, from: string, text: string, topic = '10', chat = '-100'): CtxMessage =>
  ({ chat, topic, topicTitle: topic === '10' ? 'Ops' : 'Dev', id, t: T0 + minutes * 60, from, text })

// A toy embedder: one dimension per word of a small vocabulary, so "meaning" is
// predictable in a test.
const VOCAB = ['outage', 'down', 'database', 'expense', 'approval', 'twice', 'billing', 'vendor', 'refund', 'address']
const toyEmbedder: Embedder = {
  name: 'toy',
  async embed(texts) {
    return texts.map(t => {
      const v = new Float32Array(VOCAB.length)
      const low = t.toLowerCase()
      VOCAB.forEach((w, i) => { if (low.includes(w)) v[i] = 1 })
      if (!v.some(Boolean)) v[0] = 0.01
      return v
    })
  },
}

const tmp = mkdtempSync(join(tmpdir(), 'ctx-engines-test-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('Telegram export import', () => {
  const exportJson = {
    name: 'Team', type: 'private_supergroup', id: 1234567890,
    messages: [
      { id: 90, type: 'service', action: 'topic_created', title: 'Incidents', date_unixtime: String(T0) },
      { id: 91, type: 'message', from: 'Ali', text: 'db is down again', reply_to_message_id: 90, date_unixtime: String(T0 + 60) },
      { id: 92, type: 'message', from: 'Sara', text: [{ type: 'plain', text: 'restarted it, see ' }, { type: 'text_link', text: 'the runbook', href: 'https://x' }], reply_to_message_id: 91, date_unixtime: String(T0 + 120) },
      { id: 93, type: 'message', from: 'Ali', text: 'thanks', reply_to_message_id: 92, date_unixtime: String(T0 + 180), photo: 'photos/p1.jpg' },
      // In a topic created before the export began: its root is not in the file.
      { id: 94, type: 'message', from: 'Bot Bot', text: 'merged !12', reply_to_message_id: 7, date_unixtime: String(T0 + 240) },
      // General: no reply at all.
      { id: 95, type: 'message', from: 'Nika', text: 'hello all', date_unixtime: String(T0 + 300), forwarded_from: 'News' },
      // A reply to a message from before the export: its topic cannot be known.
      { id: 96, type: 'message', from: 'Nika', text: 'agreed', reply_to_message_id: 3, date_unixtime: String(T0 + 360) },
      { id: 97, type: 'message', from: 'Lena', media_type: 'sticker', sticker_emoji: '👍', text: '', reply_to_message_id: 90, date_unixtime: String(T0 + 420) },
    ],
  }
  const file = join(tmp, 'result.json')
  writeFileSync(file, JSON.stringify(exportJson))

  test('topics come from reply chains, and the chat id is the Bot API one', () => {
    const t = topicsOf(exportJson.messages)
    expect([t.get(91), t.get(92), t.get(93), t.get(97)]).toEqual(['90', '90', '90', '90'])
    expect(t.get(94)).toBe('7')
    expect(t.get(95)).toBe('main')
    expect(t.get(96)).toBe('3')
    expect(botApiChatId(exportJson)).toBe('-1001234567890')
  })

  test('what a message carries is named in its text', () => {
    expect(messageText({ photo: 'x.jpg', text: 'look' })).toBe('[photo] look')
    expect(messageText({ media_type: 'sticker', sticker_emoji: '👍', text: '' })).toBe('[sticker 👍]')
    expect(messageText({ forwarded_from: 'News', text: 'hi' })).toBe('(forwarded from News) hi')
    expect(messageText({ file: 'files/a.pdf', file_name: 'a.pdf', text: '' })).toBe('[file: a.pdf]')
  })

  test('named topics are kept, unnamed and dropped ones left out; re-importing keeps summaries', () => {
    const idx = new ContextIndex(':memory:', undefined, { minMsgs: 1 })
    const plan = { names: { '90': 'Incidents', '7': 'Gitlab', main: 'General' }, drop: ['7'] }
    const r = importExport(file, idx, { plan })
    expect(r.chat).toBe('-1001234567890')
    expect(Object.keys(r.topics).sort()).toEqual(['90', 'main'])
    expect(r.topics['90'].messages).toBe(4)
    const texts = (idx.db.query('SELECT id, text, reply_to FROM msgs ORDER BY id').all() as any[])
    expect(texts.find(x => x.id === 92).text).toBe('restarted it, see the runbook')
    // Replying to the topic's first message is just being in the topic.
    expect(texts.find(x => x.id === 91).reply_to).toBeNull()
    expect(texts.find(x => x.id === 92).reply_to).toBe(91)
    const ep = idx.db.query("SELECT ekey FROM episodes WHERE topic = '90'").get() as any
    idx.setSummary(ep.ekey, 'haiku', 'About: database outage, restarted')
    importExport(file, idx, { plan })
    expect(idx.summaryOf(ep.ekey, 'haiku')).toBe('About: database outage, restarted')
    // Dropping a topic on a later import takes its stretches out.
    importExport(file, idx, { plan: { ...plan, drop: ['7', 'main'] } })
    expect((idx.db.query("SELECT count(*) n FROM episodes WHERE topic = 'main'").get() as any).n).toBe(0)
  })
})

describe('summaries and vector spaces', () => {
  const idx = new ContextIndex(':memory:', undefined, { minMsgs: 1 })
  idx.add([
    msg(1, 0, 'Ali', 'prod is not responding since 10:00'),
    msg(2, 2, 'Sara', 'the primary ran out of disk, failing over'),
    msg(3, 300, 'Nika', 'the expense tool asks for approval twice'),
    msg(4, 302, 'Tom', 'fixed in the approval service, released today'),
    msg(5, 900, 'Ali', 'refunds went to a wrong address in billing', '20'),
  ])
  idx.refresh()
  const keys = (idx.db.query('SELECT ekey FROM episodes ORDER BY first_id').all() as any[]).map(r => r.ekey)

  test('a summary is kept per model, and goes stale when its stretch changes', () => {
    idx.setSummary(keys[0], 'haiku', 'About: production outage; database disk full; failover')
    idx.setSummary(keys[0], 'sonnet', 'About: prod down, DB disk exhausted')
    expect(idx.summaryOf(keys[0], 'haiku')).toContain('failover')
    expect(idx.summaryOf(keys[0], 'sonnet')).toContain('exhausted')
    expect(idx.episodesNeedingSummary('haiku').map(e => e.key)).toEqual(keys.slice(1))
    // An edit changes the stretch's text.
    idx.add([msg(2, 2, 'Sara', 'the primary ran out of disk, failing over now')])
    idx.refresh()
    expect(idx.summaryOf(keys[0], 'haiku')).toBeUndefined()
    expect(idx.episodesNeedingSummary('haiku').map(e => e.key)).toContain(keys[0])
    idx.setSummary(keys[0], 'haiku', 'About: production outage; database disk full; failover')
    idx.setSummary(keys[1], 'haiku', 'About: the expense tool asked for approval twice; fixed in the approval service')
  })

  test('summaries alone find a stretch by what it was about, not its words', async () => {
    const alone = await idx.search('-100', 'outage', { summaries: { model: 'haiku', use: 'alone' }, meaning: false })
    expect(alone[0]?.episode.key).toBe(keys[0])
    expect(alone[0]?.why).toEqual(['summary'])
    const plain = await idx.search('-100', 'outage', { meaning: false })
    expect(plain.length).toBe(0)
  })

  test('vectors per space: the talk, and the summaries, as two signals', async () => {
    expect(await idx.embedSpace(toyEmbedder, 'text')).toBe(3)
    expect(await idx.embedSpace(toyEmbedder, 'text')).toBe(0)
    expect(await idx.embedSpace(toyEmbedder, 'haiku')).toBe(2)
    const hits = await idx.search('-100', 'expense approval twice', { summaries: { model: 'haiku', use: 'with-text' }, meaning: { embedder: toyEmbedder } })
    expect(hits[0].episode.key).toBe(keys[1])
    expect(hits[0].why).toEqual(expect.arrayContaining(['words', 'summary', 'meaning', 'summary meaning']))
  })
})

describe('engines by config', () => {
  test('without a file, the environment describes the one engine there was', () => {
    const cfg = loadEnginesConfig(undefined, {})
    expect(Object.keys(cfg.engines)).toEqual(['xesious-keywords'])
    const withEmbed = loadEnginesConfig(undefined, { TG_CONTEXT_EMBED_URL: 'http://e', TG_CONTEXT_EMBED: 'bge-m3', TG_CONTEXT_DIGEST: 'haiku' })
    expect(defaultEngineId(withEmbed)).toBe('xesious-meaning')
    expect(withEmbed.engines['xesious-meaning']).toMatchObject({ meaning: true, summaries: 'haiku' })
  })

  test('TG_CONTEXT_EMBED=1 is bge-m3 on the local server; a model id with a slash runs in-process', () => {
    expect(envEmbedding({})).toBeUndefined()
    expect(envEmbedding({ TG_CONTEXT_EMBED: '1' })).toEqual({ url: DEFAULT_EMBED_URL, model: 'bge-m3' })
    expect(envEmbedding({ TG_CONTEXT_EMBED_URL: 'http://e' })).toEqual({ url: 'http://e', model: 'bge-m3' })
    expect(envEmbedding({ TG_CONTEXT_EMBED_URL: 'http://e', TG_CONTEXT_EMBED: 'other' })).toEqual({ url: 'http://e', model: 'other' })
    expect(envEmbedding({ TG_CONTEXT_EMBED: 'Xenova/multilingual-e5-small' })).toEqual({ local: 'Xenova/multilingual-e5-small' })
    expect(envEmbedding({ TG_CONTEXT_EMBED: 'off', TG_CONTEXT_EMBED_URL: 'http://e' })).toBeUndefined()
    const cfg = loadEnginesConfig(undefined, { TG_CONTEXT_EMBED: '1' })
    expect(cfg.embeddings).toEqual({ url: DEFAULT_EMBED_URL, model: 'bge-m3' })
    expect(defaultEngineId(cfg)).toBe('xesious-meaning')
  })

  test('the example config setup.sh installs defaults to bge-m3', () => {
    const cfg = loadEnginesConfig(join(import.meta.dir, 'context-engines.example.json'))
    expect(defaultEngineId(cfg)).toBe('xesious-bge-m3')
    expect(cfg.embeddings).toMatchObject({ url: DEFAULT_EMBED_URL, model: 'bge-m3' })
    expect([...buildEngines(cfg).keys()]).toEqual(['xesious-keywords', 'xesious-bge-m3'])
  })

  test('an unknown kind is refused by name', () => {
    expect(() => buildEngines({ engines: { x: { kind: 'nope' } } })).toThrow(/unknown kind "nope"/)
  })

  test('links point a topic, by id or title, or a whole group at an archive', () => {
    const cfg: EnginesConfig = { engines: {}, links: { '-1:540': '-9', '-2:Archive': '-9', '-3': '-8' } }
    expect(historyChat(cfg, '-1', '540')).toBe('-9')
    expect(historyChat(cfg, '-1', '541')).toBe('-1')
    expect(historyChat(cfg, '-2', '7', 'Archive')).toBe('-9')
    expect(historyChat(cfg, '-3', '1')).toBe('-8')
  })

  test('an http engine is sent what changed, ranks elsewhere, and is told what is gone', async () => {
    const got: any = { upserts: [] as any[], deletes: [] as any[] }
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const b: any = await req.json()
        const path = new URL(req.url).pathname
        if (path === '/upsert') { got.upserts.push(...b.items.map((i: any) => i.key)); return Response.json({ ok: true }) }
        if (path === '/delete') { got.deletes.push(...b.keys); return Response.json({ ok: true }) }
        if (path === '/search') { got.search = b; return Response.json({ hits: got.upserts.slice().reverse().map((key: string, i: number) => ({ key, score: 1 - i / 10 })) }) }
        return new Response('nope', { status: 404 })
      },
    })
    try {
      const idx = new ContextIndex(':memory:', undefined, { minMsgs: 1 })
      idx.add([msg(1, 0, 'Ali', 'vendor sync stuck'), msg(2, 300, 'Sara', 'refund address wrong')])
      idx.refresh()
      const engines = buildEngines({ engines: { t: { kind: 'http', url: `http://127.0.0.1:${server.port}`, mode: 'dense' } } })
      const e = engines.get('t')!
      expect(await e.sync(idx)).toBe(2)
      expect(await e.sync(idx)).toBe(0)
      const hits = await e.search(idx, '-100', 'vendor sync', { k: 2 })
      expect(got.search).toMatchObject({ index: 'plain', chat: '-100', mode: 'dense', query: 'vendor sync' })
      expect(hits.map(h => h.episode.first)).toEqual([2, 1])
      expect(hits[1].matched).toEqual([1])
      // A stretch that disappears is taken back.
      idx.db.run("DELETE FROM msgs WHERE id = 2"); idx.db.run("UPDATE topics SET dirty = 1")
      idx.refresh()
      await e.sync(idx)
      expect(got.deletes.length).toBe(1)
    } finally { server.stop(true) }
  })

  test('an http engine that is down throws, so the caller can fall back', async () => {
    const idx = new ContextIndex(':memory:')
    const e = buildEngines({ engines: { t: { kind: 'http', url: 'http://127.0.0.1:9', timeoutMs: 2000 } } }).get('t')!
    await expect(e.search(idx, '-100', 'x')).rejects.toThrow()
  })
})

test("a chat's vocabulary: the Latin-script words its people use most, without everyday English or bots", () => {
  const idx = new ContextIndex(':memory:')
  const lines = ['orion fees are too high again', 'switch orion plan, the fees hurt', 'orion support said the plan is fine',
    'helix refund went to the wrong account', 'helix fixed the refund', 'refund on helix again', 'thanks, looks good']
  idx.add(lines.map((text, i) => ({ chat: '-5', topic: '1', id: i + 1, t: T0 + i * 60, from: 'Ali', text })))
  idx.add([1, 2, 3].map(i => ({ chat: '-5', topic: '1', id: 100 + i, t: T0, from: 'CI Bot', text: 'pipeline pipeline pipeline', bot: true })))
  const v = idx.vocabulary('-5')
  // Words in at least three messages; "fees" and "plan" are in two.
  expect(v.sort()).toEqual(['helix', 'orion', 'refund'])
  expect(v).not.toContain('pipeline')
})

test("the review page's script parses, with every way of asking and characters that need escaping", () => {
  const st = { topic: "Ops <x> 'y'", t0: T0, t1: T0, first: 1, last: 2, text: "Ops — 2026-05-01\n[09:00] #1 Ali: it's </script> down", summaries: { haiku: null, sonnet: "About: it's down" } }
  const run = { ms: 3, hits: [{ key: 'k1', score: 1, why: ['words'], matched: [1] }], block: "— Ops: it's down", gate: { pointsBack: true, passed: 1 } }
  const html = reviewPage({ made: new Date().toISOString(), now: T0, chat: '-1', title: "Team's history", k: 5,
    engines: [{ id: 'e1', label: "xesious · it's", kind: 'xesious' }],
    questions: [{ n: 1, text: "what's down?", rewritten: 'ops down', bridge: "ops it's down" }],
    runs: { 1: { typed: { e1: run }, rewritten: { e1: run }, bridge: { e1: run } } }, stretches: { k1: st }, suggest: { 1: { k1: 2 } } })
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
  expect(scripts.length).toBe(1)
  expect(() => new Function(scripts[0])).not.toThrow()
  // The data cannot close its own script element.
  expect(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)![1]).not.toContain('</script>')
})

describe('summaries in batches', () => {
  test('one call, several stretches, split back by number', () => {
    const r = splitDigests('=== 1 ===\nAbout: a\n=== 2 ===\nSummary\nAbout: b\nOpen: None\n=== 3 ===\n')
    expect([...r.entries()]).toEqual([[1, 'About: a'], [2, 'About: b']])
    expect(digestBatchUser([{ key: 'k', chat: '-1', topic: '1', topicTitle: 'T', first: 1, last: 1, t0: 0, t1: 0, ids: [1], text: 'x' }])).toContain('=== STRETCH 1 ===\nTopic: T')
    expect(cleanDigest('Summary: Releases\nAbout: release 584\nIdeas: None')).toBe('About: release 584')
  })
  test('markdown marks go; a star between numbers and an underscore inside a word stay', () => {
    expect(cleanDigest('**About:** limits\nDecided: 3*20 = 60, 4 * 5 = 20; rename retry_count, not _this_'))
      .toBe('About: limits\nDecided: 3*20 = 60, 4 * 5 = 20; rename retry_count, not this')
  })
})

describe('what a turn is handed', () => {
  const ep = (first: number, n: number) => ({ key: `k${first}`, chat: '-1', topic: '1', topicTitle: 'Ops', first, last: first + n - 1, t0: T0, t1: T0, ids: Array.from({ length: n }, (_, i) => first + i),
    text: 'Ops — 2026-05-01\n' + Array.from({ length: n }, (_, i) => `[09:00] #${first + i} Ali: line ${i}`).join('\n') })
  const hit = (first: number, n: number, matched: number[] = [], why = ['words']): Hit => ({ episode: ep(first, n), score: 1, why, matched })

  test('each stretch comes with the link to its messages, and Claude is told to cite by link', () => {
    expect(linkTemplate('-1001234567890', '540')).toBe('https://t.me/c/1234567890/540/<id>')
    expect(linkTemplate('-1001234567890', 'main')).toBe('https://t.me/c/1234567890/<id>')
    expect(linkTemplate('-5', '1')).toBeUndefined()
    const h: Hit = { ...hit(7, 2), episode: { ...ep(7, 2), chat: '-1001234567890', topic: '540' } }
    expect(recallBody([h]).text.split('\n')[0]).toBe('— Ops, 2026-05-01, messages #7–#8 (link to a message: https://t.me/c/1234567890/540/<id>):')
    expect(RECALL_CAVEAT).toContain('Markdown link')
    expect(RECALL_CAVEAT).toContain('say you could not find it')
  })
  test('a long stretch is cut to around what matched', () => {
    const { text } = recallBody([hit(100, 40, [120])])
    expect(text).toContain('#120 Ali')
    expect(text).not.toContain('#100 Ali')
    expect(text.split('\n').length).toBe(8)
  })
  test('an external engine\'s results are taken as ranked; the built-in one needs two signals', () => {
    const hits = [hit(1, 3), hit(10, 3, [10, 11])]
    expect(recallPick(hits, 'what did we decide last time?').map(h => h.episode.first)).toEqual([10])
    expect(recallPick(hits, 'what did we decide last time?', { strength: false }).map(h => h.episode.first)).toEqual([1, 10])
    expect(recallPick(hits, 'write me a regex', { strength: false })).toEqual([])
  })
})
