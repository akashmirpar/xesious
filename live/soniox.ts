// live/soniox.ts — streaming speech-to-text with Soniox, for the live page.
//
// The page sends the mic as 16 kHz mono 16-bit PCM to our server, and the server
// streams it on to Soniox (so the key never leaves the server, and every call can be
// recorded and replayed). Soniox answers with words as they are recognised: each
// carries a speaker number (people are told apart, not identified), the language,
// and its place in the audio. Words come "pending" first, are re-sent until they are
// final, and `<end>` (Soniox heard the end of speech) or `<fin>` (the end we asked for
// with a finalize) closes a piece.
//
// Protocol checked against the real service on 2026-11-13 (stt-rt-v6): the first
// message is the config with the api_key; then binary audio; {"type":"finalize"};
// {"type":"keepalive"}; an empty frame ends the stream.

export const SONIOX_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'

export type Token = { text: string; start_ms?: number; end_ms?: number; is_final?: boolean; speaker?: string | null; language?: string | null; confidence?: number }
// confidence: the mean of Soniox's per-word confidence (0–1), when it gave one.
export type Turn = { speaker: string | null; text: string; language?: string | null; confidence?: number }
export type SonioxMessage = { tokens?: Token[]; total_audio_proc_ms?: number; final_audio_proc_ms?: number; finished?: boolean; error_code?: number; error_message?: string; error_type?: string }

// Words in order, grouped by who said them.
export function splitTurns(tokens: Token[]): Turn[] {
  const out: (Turn & { confs: number[] })[] = []
  for (const t of tokens) {
    if (!t.text || t.text === '<end>' || t.text === '<fin>') continue
    const sp = t.speaker ?? null
    let last = out[out.length - 1]
    if (last && last.speaker === sp) { last.text += t.text; if (!last.language && t.language) last.language = t.language }
    else out.push(last = { speaker: sp, text: t.text, language: t.language ?? null, confs: [] })
    if (typeof t.confidence === 'number' && /[\p{L}\p{N}]/u.test(t.text)) last.confs.push(t.confidence)
  }
  return out.map(({ confs, ...t }) => {
    const turn: Turn = { ...t, text: t.text.trim() }
    if (confs.length) turn.confidence = Math.round(confs.reduce((a, b) => a + b, 0) / confs.length * 100) / 100
    return turn
  }).filter(t => t.text)
}

// Keeps the words of the piece being spoken, and says when a piece is done.
export class TokenTracker {
  private final: Token[] = []
  private pending: Token[] = []
  processedMs = 0

  push(m: SonioxMessage): { live: Turn[]; done: Turn[] | null; finalized: boolean } {
    this.processedMs = Math.max(this.processedMs, m.total_audio_proc_ms || 0)
    let finished = false, finalized = false
    const pending: Token[] = []
    for (const t of m.tokens || []) {
      if (t.text === '<end>' || t.text === '<fin>') { finished = true; finalized ||= t.text === '<fin>' }
      else if (t.is_final) this.final.push(t)
      else pending.push(t)
    }
    this.pending = pending   // pending words are re-sent in full every time
    let done: Turn[] | null = null
    if (finished) { done = splitTurns(this.final); this.final = [] }
    return { live: splitTurns([...this.final, ...this.pending]), done, finalized }
  }

  // Where the last word in the open piece ends (audio ms): anyone's, this speaker's,
  // or (except) anyone else's. null when there is none.
  openWordEnd(speaker?: string, except = false): number | null {
    let end: number | null = null
    for (const t of [...this.final, ...this.pending]) {
      if (!t.text.trim() || typeof t.end_ms !== 'number') continue
      if (speaker !== undefined && (except ? t.speaker === speaker : t.speaker !== speaker)) continue
      end = Math.max(end ?? 0, t.end_ms)
    }
    return end
  }
  // How long nobody has said a word while the piece stays open (audio ms); null if
  // the open piece is empty.
  silenceMs(): number | null {
    const end = this.openWordEnd()
    return end === null ? null : this.processedMs - end
  }
  // How long that speaker has been quiet while the piece stays open (someone else is
  // still talking), in audio ms; null if they have no words in it.
  quietMs(speaker: string): number | null {
    const end = this.openWordEnd(speaker)
    return end === null ? null : this.processedMs - end
  }
  reset(): void { this.final = []; this.pending = []; this.processedMs = 0 }
}

export type SonioxConfig = { url?: string; key: string; model: string; languages: string[]; endpointMs?: number; terms?: string[] }
export function configMessage(c: SonioxConfig): Record<string, unknown> {
  const m: Record<string, unknown> = {
    api_key: c.key, model: c.model, audio_format: 'pcm_s16le', sample_rate: 16000, num_channels: 1,
    language_hints: c.languages, enable_speaker_diarization: true, enable_language_identification: true,
    enable_endpoint_detection: !!c.endpointMs,
  }
  if (c.endpointMs) m.max_endpoint_delay_ms = Math.min(3000, Math.max(500, c.endpointMs))
  if (c.terms?.length) m.context = { terms: c.terms }
  return m
}

type Handlers = {
  message: (m: SonioxMessage) => void
  // A new connection: speaker numbers start over.
  connected: (n: number) => void
  status: (s: string) => void
  // Retrying won't help (bad key, no balance): the stream has stopped.
  fatal: (s: string) => void
}

const KEEPALIVE_MS = 8000
const MAX_QUEUED_BYTES = 16000 * 2 * 15   // 15 s of audio while (re)connecting

// One Soniox connection for a call, opened on the first audio, reconnected with
// backoff after failures. Audio sent while it connects is queued (up to 15 s).
export class SonioxStream {
  private ws: WebSocket | null = null
  private open = false
  private closed = false
  private queue: (Uint8Array | string)[] = []
  private queued = 0
  private lastSent = 0
  private keepalive: ReturnType<typeof setInterval> | null = null
  private backoff = 1000
  private connections = 0

  constructor(private c: SonioxConfig, private h: Handlers) {}

  send(pcm: Uint8Array): void {
    if (this.closed) return
    if (!this.ws) this.connect()
    if (this.open) { this.ws!.send(pcm as Uint8Array<ArrayBuffer>); this.lastSent = Date.now(); return }
    this.queue.push(pcm); this.queued += pcm.byteLength
    while (this.queued > MAX_QUEUED_BYTES && this.queue.length) {
      const old = this.queue.shift()!
      if (typeof old !== 'string') this.queued -= old.byteLength
    }
  }
  finalize(): void {
    if (this.closed || !this.ws) return
    const m = JSON.stringify({ type: 'finalize' })
    if (this.open) { this.ws.send(m); this.lastSent = Date.now() } else this.queue.push(m)
  }
  close(): void {
    this.closed = true
    if (this.keepalive) clearInterval(this.keepalive)
    try { if (this.open) this.ws!.send('') } catch {}
    try { this.ws?.close() } catch {}
  }

  private connect(): void {
    const ws = new WebSocket(this.c.url || SONIOX_URL)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      ws.send(JSON.stringify(configMessage(this.c)))
      this.open = true; this.backoff = 1000; this.connections++
      this.h.connected(this.connections)
      for (const q of this.queue) ws.send(q as string | Uint8Array<ArrayBuffer>)
      this.queue = []; this.queued = 0; this.lastSent = Date.now()
      if (!this.keepalive) this.keepalive = setInterval(() => {
        if (this.open && Date.now() - this.lastSent > KEEPALIVE_MS) { try { this.ws!.send(JSON.stringify({ type: 'keepalive' })); this.lastSent = Date.now() } catch {} }
      }, 2000)
    }
    ws.onmessage = e => {
      let m: SonioxMessage
      try { m = JSON.parse(String(e.data)) } catch { return }
      if (m.error_code || m.error_type) {
        const text = `${m.error_code ?? ''} ${m.error_type ?? ''}: ${m.error_message ?? ''}`.trim()
        const code = Number(m.error_code)
        if (code >= 400 && code < 500 && code !== 408 && code !== 429) { this.closed = true; this.h.fatal(text) }
        else this.h.status(`Soniox error, reconnecting: ${text}`)
        return
      }
      this.h.message(m)
    }
    ws.onclose = e => {
      const wasOpen = this.open
      this.open = false; this.ws = null
      if (this.closed) return
      this.h.status(`Soniox connection ${wasOpen ? 'lost' : 'refused'} (${e.code}${e.reason ? ` ${e.reason}` : ''}), retrying in ${this.backoff / 1000} s`)
      const wait = this.backoff
      this.backoff = Math.min(this.backoff * 2, 30_000)
      setTimeout(() => { if (!this.closed && !this.ws) this.connect() }, wait)
    }
    ws.onerror = () => {}
  }
}
