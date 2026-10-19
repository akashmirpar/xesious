// Files over the cloud Bot API's 20 MB getFile cap, fetched over MTProto instead.
//
// The bot logs in to MTProto with its own token (plus an api_id/api_hash from
// my.telegram.org) and downloads a message's media by chat and message id, up to
// 2 GB. Nothing else moves off the Bot API: this session never takes updates
// (disableUpdates), and polling carries on as before. Tested on two staging bots
// 2026-10-19: 25-50 MB files from DMs and groups at ~7 MB/s, and a 10-minute run
// beside Bot API polling on the same token lost no update.
//
// Two things that look like they should work and don't: handing mtcute the Bot API
// file_id (0.32 can't decode the current format: "Unsupported file ID v3 subversion")
// and reusing one session file for another bot token — hence one file per bot id.
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import type { TelegramClient } from '@mtcute/bun'

export const MTPROTO_MAX = 2000 * 1024 * 1024   // what a bot can download over MTProto

export type BigFiles = {
  download(chat: number, msgId: number, dest: string): Promise<void>
  close(): Promise<void>
}

export function bigFiles(o: { apiId: number; apiHash: string; token: string; stateDir: string }): BigFiles {
  // Connected on first use and kept: most deployments never see a file this big, and
  // a bot that does shouldn't log in again for each one.
  let client: Promise<TelegramClient> | undefined
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
    async download(chat, msgId, dest) {
      client ??= connect().catch(e => { client = undefined; throw e })
      const tg = await client
      const [m] = await tg.getMessages(chat, msgId)
      const media = m?.media as any
      if (!media || typeof media.fileSize !== 'number') throw new Error('the message or its file is gone')
      try { await tg.downloadToFile(dest, media, { partSize: 512 }) }   // 512 KB parts: twice the speed of the default
      catch (e) { rmSync(dest, { force: true }); throw e }
    },
    async close() {
      const tg = await client?.catch(() => undefined)
      await tg?.destroy()
    },
  }
}
