#!/usr/bin/env bun
/**
 * ocr.ts — the text in a history's photos, read on this machine, so that a screenshot
 * (an email, a dashboard, an error message) is found by what it says, not only by the
 * caption it came with. See context/OCR.md for what reads them and how it was chosen.
 *
 * The reading is done by context/ocr_service.py (RapidOCR, CPU only), started by
 * `context/services.sh start ocr`. This file is its client, the tidying of what it
 * reads, and a command that reads every photo of a history that is not read yet:
 *
 *   bun context/ocr.ts --db <context.db> [--chat <id>] [--url http://127.0.0.1:8094] [--limit N] [--redo]
 *
 * Resumable: a photo already read (by this model) is skipped. Photos are read newest
 * first. The index's stretches pick the text up when their topics are next refreshed
 * (this command refreshes at the end); their summaries and vectors are then redone by
 * whatever keeps them (the bridge, context/summarize.ts).
 */
import { ContextIndex } from './engine'

export const OCR_URL = 'http://127.0.0.1:8094'
// What a photo's text is cut to: past this it is a wall of log lines or code, and
// the start says what it is.
export const PHOTO_TEXT_MAX = 4000

export interface OcrLine { text: string; score: number }

// The lines the service read in one image. Throws when the service is down, or (with
// `status`) when it answered but would not read this image.
export async function readPhoto(url: string, image: Blob, timeoutMs = 180_000): Promise<{ lines: OcrLine[]; model: string }> {
  const send = () => fetch(`${url.replace(/\/+$/, '')}/ocr`, { method: 'POST', body: image, headers: { 'content-type': 'application/octet-stream' }, signal: AbortSignal.timeout(timeoutMs) })
  // A kept-alive connection the service already closed fails at once; one retry on a
  // fresh one is enough (as in engines.ts).
  const r = await send().catch(e => { if (/closed unexpectedly|ECONNRESET|socket/i.test(String(e))) return send(); throw e })
  const d: any = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(`ocr: HTTP ${r.status} ${String(d?.error ?? '').slice(0, 200)}`), { status: r.status })
  return { lines: Array.isArray(d.lines) ? d.lines : [], model: String(d.model ?? 'ocr') }
}

// What is worth keeping of what a photo says, one line per line of text. Left out:
// lines with nothing but symbols (icons read as "•••"), stray single letters, and
// bare numbers of up to six digits — a chart's axis ("500", "1,000"), clock times,
// percentages — which would make every dashboard screenshot match a question about
// "500 users". Longer ones (an amount, an order number, an id) stay, and so does
// any number on a line with words. Repeats are kept once.
export function cleanPhotoText(lines: OcrLine[], max = PHOTO_TEXT_MAX): string {
  const out: string[] = []
  const seen = new Set<string>()
  let size = 0
  for (const l of lines) {
    const t = String(l.text ?? '').replace(/\s+/g, ' ').trim()
    if (!/[\p{L}\p{N}]/u.test(t)) continue
    const letters = (t.match(/\p{L}/gu) ?? []).length
    if (!letters && (t.match(/\p{N}/gu) ?? []).length <= 6) continue
    if (letters <= 1 && t.length <= 2) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    if (size + t.length + 1 > max) break
    out.push(t)
    size += t.length + 1
  }
  return out.join('\n')
}

// Read the photos of a store that are not read yet and store their text; returns how
// many were read. `onEach` hears about every photo (for progress).
export async function readPhotos(idx: ContextIndex, url: string, o: { chat?: string; limit?: number; redoModel?: string; onEach?: (p: { chat: string; id: number; chars: number; ms: number; error?: string }) => void } = {}): Promise<number> {
  const todo = idx.photosToRead({ chat: o.chat, limit: o.limit, engine: o.redoModel })
  let n = 0
  for (const p of todo) {
    const t0 = performance.now()
    const file = Bun.file(p.path)
    if (!(await file.exists())) { o.onEach?.({ ...p, chars: 0, ms: 0, error: `no file at ${p.path}` }); continue }
    let r: { lines: OcrLine[]; model: string }
    try { r = await readPhoto(url, file) }
    catch (e: any) {
      if (!e?.status) throw e                  // the service is down: stop, and read the rest another time
      // It answered, but not with this photo's text: one bad image does not stop the rest.
      // Not an image at all is recorded as such, so it is not sent again.
      if (e.status === 415) idx.setMediaText(p.chat, p.id, '', 'unreadable')
      o.onEach?.({ ...p, chars: 0, ms: Math.round(performance.now() - t0), error: String(e.message) })
      continue
    }
    const text = cleanPhotoText(r.lines)
    idx.setMediaText(p.chat, p.id, text, r.model)
    n++
    o.onEach?.({ chat: p.chat, id: p.id, chars: text.length, ms: Math.round(performance.now() - t0) })
  }
  return n
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
  const db = opt('--db')
  if (!db) { console.error('usage: bun context/ocr.ts --db <context.db> [--chat <id>] [--url http://127.0.0.1:8094] [--limit N] [--redo]'); process.exit(2) }
  const url = opt('--url') ?? process.env.OCR_URL ?? OCR_URL
  const health: any = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => undefined)
  if (!health?.ok) { console.error(`[ocr] nothing answers at ${url} — start it with: context/services.sh start ocr`); process.exit(1) }
  const idx = new ContextIndex(db)
  const model = `rapidocr/pp-ocrv5/${health.model}`
  const total = idx.photosToRead({ chat: opt('--chat'), limit: opt('--limit') ? Number(opt('--limit')) : undefined, engine: args.includes('--redo') ? model : undefined }).length
  console.log(`[ocr] ${total} photo(s) to read with ${model}`)
  const t0 = Date.now()
  let done = 0, chars = 0
  await readPhotos(idx, url, {
    chat: opt('--chat'), limit: opt('--limit') ? Number(opt('--limit')) : undefined, redoModel: args.includes('--redo') ? model : undefined,
    onEach: p => {
      if (p.error) { console.error(`[ocr] #${p.id}: ${p.error}`); return }
      done++; chars += p.chars
      if (done % 10 === 0 || done === total) {
        const rate = done / ((Date.now() - t0) / 1000)
        console.log(`[ocr] ${done}/${total} read, ${Math.round(chars / done)} chars each on average; ${rate.toFixed(2)}/s, ~${Math.round((total - done) / Math.max(rate, 0.001) / 60)} min left`)
      }
    },
  })
  const changed = idx.refresh()
  idx.close()
  console.log(`[ocr] done: ${done} photo(s) read in ${Math.round((Date.now() - t0) / 60000)} min; ${changed} stretch(es) now carry their photos' text`)
}
