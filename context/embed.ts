/**
 * embed.ts — the context engine's optional "meaning" signal: embedding models, run
 * two ways.
 *
 * The default is httpEmbedder: bge-m3 served by llama.cpp's llama-server in its own
 * process, installed and started by context/setup.sh. It ranked best when measured
 * (right stretch in the top 5 for 82% of questions, e5-small 78%; MRR 0.63 vs 0.57),
 * and nothing native loads into the bridge.
 *
 * localEmbedder runs a small model inside the process through transformers.js (ONNX
 * Runtime) — multilingual-e5-small and the others below, used by the benchmarks.
 * Nothing installs it: `mkdir -p context/.deps && cd context/.deps && bun add
 * @huggingface/transformers`, then TG_CONTEXT_EMBED=<model id>. Missing, the engine
 * says so once and carries on with keywords alone.
 *
 * Models are presets because they disagree on how to be asked: e5 wants "query: " and
 * "passage: " prefixes, EmbeddingGemma wants task prompts, and they pool differently.
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { Embedder } from './engine'

export interface EmbedPreset {
  id: string
  pooling: 'mean' | 'cls' | 'last_token'
  query: (t: string) => string
  passage: (t: string) => string
  dtype?: string
  license: string
}

export const EMBED_PRESETS: Record<string, EmbedPreset> = {
  // MIT. 118M parameters, 384 dimensions, ~100 languages including Persian.
  'Xenova/multilingual-e5-small': { id: 'Xenova/multilingual-e5-small', pooling: 'mean', query: t => `query: ${t}`, passage: t => `passage: ${t}`, dtype: 'q8', license: 'MIT' },
  'Xenova/multilingual-e5-base': { id: 'Xenova/multilingual-e5-base', pooling: 'mean', query: t => `query: ${t}`, passage: t => `passage: ${t}`, dtype: 'q8', license: 'MIT' },
  // Apache-2.0. 118M, 384 dimensions, 50+ languages; symmetric, no prefixes.
  'Xenova/paraphrase-multilingual-MiniLM-L12-v2': { id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', pooling: 'mean', query: t => t, passage: t => t, dtype: 'q8', license: 'Apache-2.0' },
  // Gemma terms of use. 308M, 768 dimensions, 100+ languages.
  'onnx-community/embeddinggemma-300m-ONNX': { id: 'onnx-community/embeddinggemma-300m-ONNX', pooling: 'mean',
    query: t => `task: search result | query: ${t}`, passage: t => `title: none | text: ${t}`, dtype: 'q8', license: 'Gemma' },
  // Apache-2.0. 596M, 1024 dimensions; best quality here, slowest on a small CPU.
  'onnx-community/Qwen3-Embedding-0.6B-ONNX': { id: 'onnx-community/Qwen3-Embedding-0.6B-ONNX', pooling: 'last_token',
    query: t => `Instruct: Given a question about a team chat, find the conversation that answers it\nQuery:${t}`, passage: t => t, dtype: 'q8', license: 'Apache-2.0' },
}
export const DEFAULT_EMBED_MODEL = 'Xenova/multilingual-e5-small'

// Where localEmbedder looks for the transformers.js runtime, next to this file.
export const DEPS_DIR = join(import.meta.dir, '.deps')

export async function localEmbedder(o: { model?: string; cacheDir?: string; depsDir?: string } = {}): Promise<Embedder | undefined> {
  const preset = EMBED_PRESETS[o.model ?? DEFAULT_EMBED_MODEL] ?? { id: o.model!, pooling: 'mean', query: (t: string) => t, passage: (t: string) => t, dtype: 'q8', license: '?' }
  const deps = o.depsDir ?? DEPS_DIR
  const entry = join(deps, 'node_modules', '@huggingface', 'transformers')
  let tf: any
  try { tf = await import(existsSync(entry) ? entry : '@huggingface/transformers') } catch { return undefined }
  tf.env.cacheDir = o.cacheDir ?? join(deps, 'models')
  const pipe = await tf.pipeline('feature-extraction', preset.id, { dtype: preset.dtype ?? 'q8', device: 'cpu' })
  return {
    name: preset.id,
    async embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
      const input = texts.map(t => (kind === 'query' ? preset.query : preset.passage)(t))
      const out = await pipe(input, { pooling: preset.pooling, normalize: true })
      return (out.tolist() as number[][]).map(v => Float32Array.from(v))
    },
  }
}

// Any OpenAI-compatible /v1/embeddings server — llama.cpp's llama-server with
// --embedding is the light one — so the model runs in its own process: nothing
// native loads into the bridge, and a crash there cannot take the bridge down.
// Prefixes follow the preset when the model is a known one.
// A question is embedded while someone waits, so it gives up soon and the search goes
// on without meaning; stretches are embedded in the background, where a busy CPU may
// take minutes over a batch.
export function httpEmbedder(url: string, model: string, o: { queryTimeoutMs?: number; passageTimeoutMs?: number } = {}): Embedder {
  const preset = Object.values(EMBED_PRESETS).find(p => model.toLowerCase().includes(p.id.split('/').pop()!.toLowerCase().replace(/-onnx$/, '')))
  const base = url.replace(/\/+$/, '')
  return {
    // Vectors are filed under the model, not the address: moving the server, or
    // putting a cache in front of it (embed-cache.ts), keeps them.
    name: `http#${model}`,
    async embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
      const input = texts.map(t => preset ? (kind === 'query' ? preset.query : preset.passage)(t) : t)
      const r = await fetch(`${base}/v1/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input }), signal: AbortSignal.timeout(kind === 'query' ? (o.queryTimeoutMs ?? 30_000) : (o.passageTimeoutMs ?? 900_000)) })
      if (!r.ok) throw new Error(`embeddings server: HTTP ${r.status}`)
      const d: any = await r.json()
      return (d.data as { index: number; embedding: number[] }[]).sort((a, b) => a.index - b.index).map(x => {
        const v = Float32Array.from(x.embedding)
        let n = 0; for (const y of v) n += y * y
        n = Math.sqrt(n) || 1
        return v.map(y => y / n)
      })
    },
  }
}
