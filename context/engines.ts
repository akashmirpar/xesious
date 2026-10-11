/**
 * engines.ts — which search engine ranks a group's history, chosen by config.
 *
 * Everything a group said lives in one store (engine.ts: messages, stretches of
 * conversation, topics, summaries), whatever engine is used. An engine does one
 * thing: given a question, rank the stretches. So engines can be switched per topic
 * without re-recording anything, compared side by side (/recall, compare.ts), and a
 * new one added without touching the bridge.
 *
 * Two kinds:
 *   xesious  built in — keywords (SQLite FTS5), optionally meaning (vectors from an
 *            embeddings server) and summaries, fused by rank.
 *   http     anything behind the small HTTP protocol in ENGINES.md, in any language:
 *            the bridge sends it stretches as they change and asks it to rank them.
 *            txtai (engines/txtai_service.py) is one.
 *
 * The config is a JSON file (state/context-engines.json, or TG_CONTEXT_ENGINES;
 * context/setup.sh writes one from context/context-engines.example.json):
 *
 *   {
 *     "default": "xesious-bge-m3",
 *     "embeddings": { "url": "http://127.0.0.1:8093", "model": "bge-m3", "maxChars": 2000 },
 *     "summaries": { "model": "haiku" },
 *     "engines": {
 *       "xesious-keywords": { "kind": "xesious", "label": "Keywords" },
 *       "xesious-bge-m3":   { "kind": "xesious", "meaning": true },
 *       "xesious-bge-m3-haiku": { "kind": "xesious", "meaning": true, "summaries": "haiku", "summaryUse": "with-text" },
 *       "txtai-dense":      { "kind": "http", "url": "http://127.0.0.1:8092", "mode": "dense" }
 *     },
 *     "archives": { "-1001234567890": { "db": "/data/archive/context.db", "title": "Old team chat (export)" } },
 *     "links": { "-1009876543210:540": "-1001234567890" }
 *   }
 *
 * `archives` are imported histories (import-telegram.ts) kept in their own file;
 * `links` point a whole group ("chat") or one topic ("chat:topic") at one of them, so
 * questions asked there search that history instead. Links are set here, on the
 * server, never from a chat. A link may also name another group's chat id.
 */
import { existsSync, readFileSync } from 'node:fs'
import { ContextIndex, ftsQuery, textHash, type Embedder, type Hit, type SearchOptions } from './engine'
import { httpEmbedder } from './embed'

export interface EngineDef {
  kind: string
  label?: string
  // xesious
  meaning?: boolean
  summaries?: string
  summaryUse?: 'with-text' | 'alone'
  // http
  url?: string
  index?: string
  mode?: string
  weights?: number
  text?: string          // what the service is sent: 'text' (default), '<model>+text' or '<model>'
  dense?: boolean        // false: the service needs no vectors for this index (keyword-only)
  timeoutMs?: number
}

export interface EnginesConfig {
  default?: string
  embeddings?: { url: string; model: string; maxChars?: number }
  summaries?: { model?: string }
  // The service that reads the text in photos (context/ocr_service.py); without it,
  // photos are known by their captions only.
  ocr?: { url: string }
  engines: Record<string, EngineDef>
  archives?: Record<string, { db: string; title?: string }>
  links?: Record<string, string>
}

export interface Engine {
  id: string
  label: string
  def: EngineDef
  // Rank the stretches of one chat for a question.
  search(store: ContextIndex, chat: string, query: string, o?: SearchOptions): Promise<Hit[]>
  // Background upkeep: vectors to embed, stretches to send. Returns the work done.
  sync(store: ContextIndex, o?: { budget?: number }): Promise<number>
  // What sync() writes to, so engines sharing it (three modes of one txtai index)
  // sync once.
  syncTarget?: string
}

export type EngineFactory = (id: string, def: EngineDef, cfg: EnginesConfig) => Engine
const KINDS: Record<string, EngineFactory> = {}
// A new kind written in TypeScript registers itself here; one in another language
// needs no code at all — it is an `http` engine.
export function registerKind(kind: string, f: EngineFactory): void { KINDS[kind] = f }

// ---------------------------------------------------------------------------
// xesious: the built-in engine
// ---------------------------------------------------------------------------

const embedders = new Map<string, Embedder>()
function sharedEmbedder(cfg: EnginesConfig): Embedder | undefined {
  const e = cfg.embeddings
  if (!e?.url) return undefined
  const k = `${e.url}#${e.model}`
  if (!embedders.has(k)) embedders.set(k, httpEmbedder(e.url, e.model || 'default'))
  return embedders.get(k)
}

// Which vectors a xesious engine searches: of the talk, and of the summaries it uses
// — each a signal of its own, so a summary adds to what the talk says instead of
// replacing it ('with-text'), or stands in for it ('alone').
export function xesiousSpaces(def: EngineDef): string[] {
  if (!def.summaries) return ['text']
  return def.summaryUse === 'alone' ? [def.summaries] : ['text', def.summaries]
}

registerKind('xesious', (id, def, cfg) => {
  const embedder = def.meaning ? sharedEmbedder(cfg) : undefined
  const spaces = xesiousSpaces(def)
  const maxChars = cfg.embeddings?.maxChars ?? 4000
  return {
    id, def,
    label: def.label ?? id,
    syncTarget: embedder ? `${embedder.name}|${spaces.join(',')}` : undefined,
    async search(store, chat, query, o = {}) {
      return store.search(chat, query, {
        ...o,
        summaries: def.summaries ? { model: def.summaries, use: def.summaryUse ?? 'with-text' } : undefined,
        // meaning: true with no embeddings server configured falls back to the
        // store's own embedder (TG_CONTEXT_EMBED), as before engines were configurable.
        meaning: embedder ? { embedder } : def.meaning ? undefined : false,
      })
    },
    async sync(store, o = {}) {
      if (!embedder) return 0
      let n = 0
      for (const s of spaces) n += await store.embedSpace(embedder, s, { max: Math.max(0, (o.budget ?? 64) - n), maxChars, batch: 8 })
      return n
    },
  }
})

// ---------------------------------------------------------------------------
// http: an engine behind the protocol in ENGINES.md
// ---------------------------------------------------------------------------

async function post(url: string, body: unknown, timeoutMs: number): Promise<any> {
  const send = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  // A kept-alive connection the service already closed fails at once; one retry on a
  // fresh one is enough. A timeout or an HTTP error is not retried.
  const r = await send().catch(e => { if (/closed unexpectedly|ECONNRESET|socket/i.test(String(e))) return send(); throw e })
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`)
  return r.json()
}

registerKind('http', (id, def, cfg) => {
  if (!def.url) throw new Error(`engine ${id}: an http engine needs a url`)
  // Cut where the built-in engine cuts, so a shared embeddings cache sees one text.
  const maxChars = cfg.embeddings?.maxChars ?? 4000
  const base = def.url.replace(/\/+$/, '')
  const index = def.index ?? ((def.text && def.text !== 'text' ? def.text : 'plain') + (def.dense === false ? '-keywords' : ''))
  const target = `${base}|${index}`
  const variant = def.text ?? 'text'
  return {
    id, def,
    label: def.label ?? id,
    syncTarget: target,
    async search(store, chat, query, o = {}) {
      // A question with barely any words of its own leans on what was just said.
      const vague = !!o.context && ftsQuery(query).split(' OR ').filter(Boolean).length <= 3
      const k = o.k ?? 5
      const r = await post(`${base}/search`, { index, chat, query: vague ? `${query}\n${o.context}` : query, k: k + (o.recent ? 10 : 0),
        mode: def.mode, weights: def.weights, topic: o.topic, since: o.since, until: o.until }, def.timeoutMs ?? 15_000)
      let ranked = (r.hits ?? []) as { key: string; score: number }[]
      if (o.recent) ranked = ranked.filter(h => { const e = store.episode(h.key); return !(e && e.topic === o.recent!.topic && e.last >= o.recent!.from) })
      return store.hitsFor(chat, ranked, query, id, { k, exclude: o.exclude })
    },
    // Send what changed since the last sync, and take back what is gone.
    async sync(store, o = {}) {
      const budget = o.budget ?? 64
      const sent = new Map((store.db.query('SELECT ekey, src FROM synced WHERE target = ?').all(target) as { ekey: string; src: string }[]).map(r => [r.ekey, r.src]))
      const rows = store.db.query('SELECT ekey, chat, topic, t0, t1, text FROM episodes ORDER BY t1').all() as any[]
      const alive = new Set(rows.map(r => r.ekey))
      const byChat = new Map<string, { key: string; topic: string; t0: number; t1: number; text: string; src: string }[]>()
      let n = 0
      for (const r of rows) {
        if (n >= budget) break
        const text = store.spaceInput(variant, r.ekey, r.text, maxChars)
        if (text === undefined) continue
        const src = textHash(text)
        if (sent.get(r.ekey) === src) continue
        const list = byChat.get(r.chat) ?? byChat.set(r.chat, []).get(r.chat)!
        list.push({ key: r.ekey, topic: r.topic, t0: r.t0, t1: r.t1, text, src })
        n++
      }
      const mark = store.db.prepare('INSERT OR REPLACE INTO synced (target, ekey, src) VALUES (?, ?, ?)')
      for (const [chat, items] of byChat) {
        for (let i = 0; i < items.length; i += 32) {
          const part = items.slice(i, i + 32)
          await post(`${base}/upsert`, { index, chat, dense: def.dense !== false, items: part.map(({ src, ...it }) => it) }, 600_000)
          store.db.transaction(() => part.forEach(p => mark.run(target, p.key, p.src)))()
        }
      }
      const gone = [...sent.keys()].filter(k => !alive.has(k))
      if (gone.length) {
        const byChatGone = new Map<string, string[]>()
        for (const k of gone) { const chat = k.slice(0, k.indexOf(':')); (byChatGone.get(chat) ?? byChatGone.set(chat, []).get(chat)!).push(k) }
        for (const [chat, keys] of byChatGone) await post(`${base}/delete`, { index, chat, keys }, 60_000)
        store.db.transaction(() => { for (const k of gone) store.db.prepare('DELETE FROM synced WHERE target = ? AND ekey = ?').run(target, k) })()
      }
      return n + gone.length
    },
  }
})

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

// The default meaning model: bge-m3 served by llama.cpp, behind the cache that
// context/setup.sh and context/services.sh run on this port.
export const DEFAULT_EMBED_URL = 'http://127.0.0.1:8093'
export const DEFAULT_EMBED_NAME = 'bge-m3'

// What TG_CONTEXT_EMBED / TG_CONTEXT_EMBED_URL ask for. `1` (or a server's model
// name) is an embeddings server, at DEFAULT_EMBED_URL unless the URL says otherwise;
// a transformers.js model id ("Xenova/multilingual-e5-small", with a slash) runs in
// the bridge instead, when its runtime was installed by hand into context/.deps.
export function envEmbedding(env: Record<string, string | undefined> = process.env): { url: string; model: string } | { local: string } | undefined {
  const url = (env.TG_CONTEXT_EMBED_URL || '').trim()
  const m = (env.TG_CONTEXT_EMBED || '').trim()
  if (/^(0|false|no|off)$/i.test(m)) return undefined
  const model = !m || /^(1|true|yes|on)$/i.test(m) ? DEFAULT_EMBED_NAME : m
  if (url) return { url, model }
  if (!m) return undefined
  return model.includes('/') ? { local: model } : { url: DEFAULT_EMBED_URL, model }
}

// The config in effect: the file when there is one, else what the environment
// variables of the first version of the context engine describe.
export function loadEnginesConfig(path: string | undefined, env: Record<string, string | undefined> = process.env): EnginesConfig {
  if (path && existsSync(path)) {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as EnginesConfig
    if (!cfg.engines || !Object.keys(cfg.engines).length) throw new Error(`${path}: no engines`)
    return cfg
  }
  const emb = envEmbedding(env)
  const digest = (env.TG_CONTEXT_DIGEST || '').trim().toLowerCase()
  const summaries = digest ? { summaries: digest, summaryUse: 'with-text' as const } : {}
  const cfg: EnginesConfig = { engines: { 'xesious-keywords': { kind: 'xesious', label: 'keywords', ...summaries } } }
  if (digest) cfg.summaries = { model: digest }
  if (emb) {
    if ('url' in emb) cfg.embeddings = { url: emb.url, model: emb.model }
    cfg.engines['xesious-meaning'] = { kind: 'xesious', label: 'keywords + meaning', meaning: true, ...summaries }
    cfg.default = 'xesious-meaning'
  } else cfg.default = 'xesious-keywords'
  return cfg
}

export function buildEngines(cfg: EnginesConfig): Map<string, Engine> {
  const out = new Map<string, Engine>()
  for (const [id, def] of Object.entries(cfg.engines)) {
    const f = KINDS[def.kind]
    if (!f) throw new Error(`engine ${id}: unknown kind "${def.kind}" (known: ${Object.keys(KINDS).join(', ')})`)
    out.set(id, f(id, def, cfg))
  }
  return out
}

export function defaultEngineId(cfg: EnginesConfig): string {
  return cfg.default && cfg.engines[cfg.default] ? cfg.default : Object.keys(cfg.engines)[0]
}

// The history a topic searches: its own group's, or the archive it is linked to. A
// link names the topic by id ("-100…:540") or by title ("-100…:Archive"), so
// one can be set up before the topic exists.
export function historyChat(cfg: EnginesConfig, chat: string, topic: string | undefined, title?: string): string {
  const l = cfg.links ?? {}
  return (topic !== undefined ? l[`${chat}:${topic}`] : undefined) ?? (title ? l[`${chat}:${title}`] : undefined) ?? l[chat] ?? chat
}
