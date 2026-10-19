// Files past the cloud Bot API's caps (20 MB down, 50 MB up), moved over MTProto.
//
// The bot logs in to MTProto with its own token (plus an api_id/api_hash from
// my.telegram.org), downloads a message's media by chat and message id, and sends
// files from disk, both up to 2 GB. Nothing else moves off the Bot API: this session
// never takes updates (disableUpdates), and polling carries on as before. Tested on
// two staging bots 2026-10-19: 15-60 MB files both ways at ~7.5 MB/s, and a 10-minute
// run beside Bot API polling on the same token lost no update.
//
// Things in mtcute 0.32.5 that look like they should work and don't, all found on the
// staging bots 2026-10-19:
// - handing it the Bot API file_id: it can't decode the current format ("Unsupported
//   file ID v3 subversion"), so a file is fetched by its message instead;
// - downloadToFile on Bun: Bun's file writer doesn't truncate, so a download over an
//   existing, longer file keeps the old file's tail; the file is opened with 'w' here;
// - uploading from a file path: a part's number is taken before the lock that orders
//   the reads, so under load a part is sent as another (1 corrupt file in 6, confirmed
//   by downloading it with Telethon); parts are read here by their own offset instead;
// - one session file for two bot tokens: hence one file per bot id.
import { basename, join } from 'node:path'
import { closeSync, openSync, readSync, rmSync, statSync, writeSync } from 'node:fs'
import type { TelegramClient } from '@mtcute/bun'

export const MTPROTO_MAX = 2000 * 1024 * 1024   // what a bot can move over MTProto, either way
const PART = 512 * 1024                          // 4000 parts at most: 2000 MB
const BIG_FILE_MIN = 10 * 1024 * 1024            // smaller files are sent by saveFilePart, not this way

type Progress = (done: number, total: number) => void
export type SendOpts = { threadId?: number; replyTo?: number; caption?: string; silent?: boolean; onProgress?: Progress }
export type BigFiles = {
  download(chat: number, msgId: number, dest: string, onProgress?: Progress): Promise<void>
  // Sends a file from disk as a document; the sent message's id.
  upload(chat: number, path: string, o?: SendOpts): Promise<number>
  close(): Promise<void>
}

export function bigFiles(o: { apiId: number; apiHash: string; token: string; stateDir: string }): BigFiles {
  // Connected on first use and kept: most deployments never see a file this big, and
  // a bot that does shouldn't log in again for each one.
  let client: Promise<TelegramClient> | undefined
  const connected = () => client ??= connect().catch(e => { client = undefined; throw e })
  const connect = async (): Promise<TelegramClient> => {
    const { TelegramClient } = await import('@mtcute/bun')
    const tg = new TelegramClient({
      apiId: o.apiId, apiHash: o.apiHash, disableUpdates: true, logLevel: 1,
      storage: join(o.stateDir, `mtproto-${o.token.split(':')[0]}.session`),
    })
    await tg.start({ botToken: o.token })
    return tg
  }
  return {
    async download(chat, msgId, dest, onProgress) {
      const tg = await connected()
      const [m] = await tg.getMessages(chat, msgId)
      const media = m?.media as any
      if (!media || typeof media.fileSize !== 'number') throw new Error('the message or its file is gone')
      // 512 KB parts: twice the speed of the default.
      const fd = openSync(dest, 'w')
      try {
        for await (const chunk of tg.downloadAsIterable(media, { partSize: PART / 1024, progressCallback: onProgress })) writeSync(fd, chunk)
      } catch (e) { closeSync(fd); rmSync(dest, { force: true }); throw e }
      closeSync(fd)
    },
    async upload(chat, path, o = {}) {
      const tg = await connected()
      const { InputMedia, Long } = await import('@mtcute/bun')
      const size = statSync(path).size, name = basename(path)
      if (size <= BIG_FILE_MIN) throw new Error(`${name} is too small to send this way`)
      const parts = Math.ceil(size / PART)
      const [lo, hi] = crypto.getRandomValues(new Int32Array(2))
      const id = Long.fromBits(lo, hi)
      // Four parts in flight; each worker takes the next number and reads that part's
      // bytes by offset, so a part's number and its bytes can't come apart.
      const fd = openSync(path, 'r')
      let next = 0, sent = 0
      const worker = async () => {
        for (let i = next++; i < parts; i = next++) {
          const bytes = new Uint8Array(Math.min(PART, size - i * PART))
          readSync(fd, bytes, 0, bytes.length, i * PART)
          await tg.call({ _: 'upload.saveBigFilePart', fileId: id, filePart: i, fileTotalParts: parts, bytes },
            { kind: 'upload', maxRetryCount: Infinity, floodSleepThreshold: Infinity })
          o.onProgress?.(sent += bytes.length, size)
        }
      }
      try { await Promise.all(Array.from({ length: Math.min(4, parts) }, worker)) } finally { closeSync(fd) }
      const m = await tg.sendMedia(chat, InputMedia.document({ _: 'inputFileBig', id, parts, name }, { fileName: name, fileSize: size }), {
        threadId: o.threadId, replyTo: o.replyTo, caption: o.caption, silent: o.silent,
      })
      return m.id
    },
    async close() {
      const tg = await client?.catch(() => undefined)
      await tg?.destroy()
    },
  }
}
