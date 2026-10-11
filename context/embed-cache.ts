#!/usr/bin/env bun
/**
 * embed-cache.ts — a caching front for an OpenAI-compatible embeddings server, so
 * engines that embed the same text (xesious and txtai both embed every stretch) only
 * pay for it once, and a restart never re-embeds what was done.
 *
 *   EMB_UPSTREAM=http://127.0.0.1:8091 EMB_CACHE=/data/emb-cache.db EMB_CACHE_PORT=8093 bun context/embed-cache.ts
 *
 * POST /v1/embeddings — looks every input up by (model, text); only the ones it has
 * never seen go upstream, in one request. Anything else is passed through.
 */
import { Database } from 'bun:sqlite'

const UP = (process.env.EMB_UPSTREAM || 'http://127.0.0.1:8091').replace(/\/+$/, '')
const db = new Database(process.env.EMB_CACHE || 'emb-cache.db', { create: true })
db.run('PRAGMA journal_mode = WAL')
db.run('CREATE TABLE IF NOT EXISTS cache (model TEXT NOT NULL, h TEXT NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (model, h))')
const get = db.prepare('SELECT vec FROM cache WHERE model = ? AND h = ?')
const put = db.prepare('INSERT OR REPLACE INTO cache (model, h, vec) VALUES (?, ?, ?)')
let hits = 0, misses = 0

Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.EMB_CACHE_PORT || 8093),
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method !== 'POST' || !/\/embeddings$/.test(url.pathname)) {
      if (url.pathname === '/cache') return Response.json({ hits, misses, entries: (db.query('SELECT count(*) n FROM cache').get() as any).n })
      return fetch(`${UP}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : await req.arrayBuffer() })
    }
    const body = await req.json() as { model?: string; input: string | string[] }
    const model = String(body.model ?? 'default')
    const inputs = Array.isArray(body.input) ? body.input : [body.input]
    const hashes = inputs.map(t => Bun.hash(t).toString(36) + ':' + t.length)
    const out: (number[] | undefined)[] = hashes.map(h => { const r = get.get(model, h) as any; return r ? Array.from(new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength))) : undefined })
    const need = out.map((v, i) => v ? -1 : i).filter(i => i >= 0)
    hits += inputs.length - need.length; misses += need.length
    if (need.length) {
      const r = await fetch(`${UP}/v1/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input: need.map(i => inputs[i]) }) })
      if (!r.ok) return new Response(await r.text(), { status: r.status })
      const d = await r.json() as { data: { index: number; embedding: number[] }[] }
      const got = d.data.sort((a, b) => a.index - b.index)
      db.transaction(() => got.forEach((g, j) => {
        const i = need[j]
        out[i] = g.embedding
        put.run(model, hashes[i], Buffer.from(Float32Array.from(g.embedding).buffer))
      }))()
    }
    return Response.json({ object: 'list', model, data: out.map((embedding, index) => ({ object: 'embedding', index, embedding })) })
  },
})
console.log(`[embed-cache] on :${process.env.EMB_CACHE_PORT || 8093} → ${UP}`)
