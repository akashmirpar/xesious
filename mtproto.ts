// Files past the cloud Bot API's caps (20 MB down, 50 MB up), moved over MTProto.
//
// The bot logs in to MTProto with its own token (plus an api_id/api_hash from
// my.telegram.org), downloads a message's media by chat and message id, and sends
// files from disk, both up to 2 GB. Nothing else moves off the Bot API: this session
// never takes updates (disableUpdates), and polling carries on as before. Tested on
// two staging bots 2026-10-19: 15-60 MB files both ways at ~7.5 MB/s, and a 10-minute
// run beside Bot API polling on the same token lost no update.
//
// Things in mtcute that look like they should work and don't, found on the staging
// bots 2026-10-19 and still so in 0.32.7:
// - handing it the Bot API file_id: it can't decode the current format ("Unsupported
//   file ID v3 subversion"), so a file is fetched by its message instead;
// - one session file for two bot tokens: hence one file per bot id.
// Two more were worked around here until 0.32.7 fixed them upstream: uploads from a
// path could send a part under another part's number (mtcute#182), and downloadToFile
// on Bun kept an older, longer file's tail. Both now go through mtcute's own methods.
import { basename, join } from 'node:path'
import { rmSync, statSync } from 'node:fs'
import type { TelegramClient } from '@mtcute/bun'

export const MTPROTO_MAX = 2000 * 1024 * 1024   // what a bot can move over MTProto, either way
const PART_KB = 512                              // the largest part: twice the speed of the default, 4000 parts for 2000 MB

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
      // A failed download leaves a partial file behind; mtcute doesn't remove it.
      try {
        await tg.downloadToFile(dest, media, { partSize: PART_KB, progressCallback: onProgress })
      } catch (e) { rmSync(dest, { force: true }); throw e }
    },
    async upload(chat, path, o = {}) {
      const tg = await connected()
      const { InputMedia } = await import('@mtcute/bun')
      const size = statSync(path).size, name = basename(path)
      const file = await tg.uploadFile({ file: path, fileName: name, fileSize: size, partSize: PART_KB, progressCallback: o.onProgress })
      const m = await tg.sendMedia(chat, InputMedia.document(file, { fileName: name, fileSize: size }), {
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
