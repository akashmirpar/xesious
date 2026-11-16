// voice/soniox-stt.ts — transcribe one recorded file (a Telegram voice note or round
// video) with Soniox's file API.
//
// The live page streams to Soniox's real-time endpoint, but a file sent there is read
// at about the speed it plays: a 60 s note took 53 s. The file API takes
// 2–3 s whatever the length, and reads the .ogg and .mp4 Telegram sends without
// decoding them first. The upload and the transcription are deleted afterwards, so
// nothing stays at Soniox.
//
// Checked against the real service on 2026-11-14: POST /files (multipart "file") →
// {id}; POST /transcriptions {model, file_id, language_hints} → {id, status}; GET
// /transcriptions/:id until status is "completed" or "error"; GET
// /transcriptions/:id/transcript → {text, tokens}; DELETE both.

export const SONIOX_API = 'https://api.soniox.com/v1'

export type FileSttOptions = {
  key: string
  languages?: string[]
  model?: string
  base?: string
  timeoutMs?: number
  pollMs?: number
  fetch?: typeof fetch
}

// The words heard, '' for a note with no speech in it. Throws when Soniox can't be
// reached or refuses, so the caller can fall back to local whisper.
export async function sonioxTranscribeFile(path: string, o: FileSttOptions): Promise<string> {
  const f = o.fetch ?? fetch
  const base = o.base ?? SONIOX_API
  const auth = { Authorization: `Bearer ${o.key}` }
  const deadline = Date.now() + (o.timeoutMs ?? 120_000)
  const call = async (method: string, url: string, body?: BodyInit, json = false): Promise<any> => {
    const r = await f(`${base}${url}`, {
      method, body, headers: json ? { ...auth, 'Content-Type': 'application/json' } : auth,
      signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
    })
    if (!r.ok) throw new Error(`Soniox ${method} ${url.replace(/[0-9a-f-]{36}/g, ':id')}: ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`)
    return r.status === 204 ? null : r.json()
  }
  let fileId: string | undefined, jobId: string | undefined
  try {
    const form = new FormData()
    form.append('file', Bun.file(path))
    fileId = (await call('POST', '/files', form)).id
    jobId = (await call('POST', '/transcriptions', JSON.stringify({
      model: o.model ?? 'stt-async-v6', file_id: fileId,
      ...(o.languages?.length ? { language_hints: o.languages } : {}),
      enable_language_identification: true,
    }), true)).id
    for (;;) {
      const s = await call('GET', `/transcriptions/${jobId}`)
      if (s.status === 'completed') break
      if (s.status === 'error') throw new Error(`Soniox could not transcribe it: ${s.error_message ?? 'error'}`)
      if (Date.now() + (o.pollMs ?? 500) > deadline) throw new Error('Soniox took too long')
      await Bun.sleep(o.pollMs ?? 500)
    }
    const t = await call('GET', `/transcriptions/${jobId}/transcript`)
    return String(t?.text ?? '').trim()
  } finally {
    // Best effort, and not waited on past a few seconds: a failed delete must not
    // hold up the answer.
    const del = (u: string) => f(`${base}${u}`, { method: 'DELETE', headers: auth, signal: AbortSignal.timeout(5000) }).catch(() => {})
    if (jobId) await del(`/transcriptions/${jobId}`)
    if (fileId) await del(`/files/${fileId}`)
  }
}
