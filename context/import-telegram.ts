#!/usr/bin/env bun
/**
 * import-telegram.ts — a Telegram Desktop export ("Export chat history", JSON) into
 * the context engine's index, as a read-only archive: the history of a group the bot
 * was never in, searchable like a group it records.
 *
 *   bun context/import-telegram.ts <export dir> --db <file> [--topics topics.json] [--chat <id>]
 *
 * The export does not say which forum topic a message was in. Each message replies
 * either to its topic's first message (the topic id) or to another message in the
 * same topic, so following the reply chain back to a message outside the export, or
 * to a "topic created" message, gives the topic. A reply to a message older than the
 * export cannot be placed; those are left out.
 *
 * topics.json names the topics and says what to leave out:
 *   { "names": { "5120": "Release notes", "main": "General" },
 *     "drop": ["4410"],                  // topics to leave out
 *     "merge": { "6021": "5120" },      // a topic that is really part of another
 *     "keepUnnamed": false }             // topics with no name are left out
 * Without it, every topic is kept, titled from the export where it can be.
 *
 * Re-running replaces what an earlier run imported for that chat. Stretches that come
 * out the same keep their summaries and vectors.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ContextIndex, type CtxMessage } from './engine'

export interface TopicPlan { names?: Record<string, string>; drop?: string[]; merge?: Record<string, string>; keepUnnamed?: boolean }

// The Bot API id of an exported chat: supergroups and channels are -100<id>.
export function botApiChatId(d: { id: number | string; type?: string }): string {
  const id = String(d.id).replace(/^-/, '')
  if (/supergroup|channel/.test(d.type ?? '')) return id.startsWith('100') && id.length > 12 ? `-${id}` : `-100${id}`
  return `-${id}`
}

// Which topic each message is in, by its reply chain: 'main' (General) when the
// chain ends at a message with no reply, the topic id when it ends at a
// topic-created message or at one before the export.
export function topicsOf(messages: any[]): Map<number, string> {
  const byId = new Map<number, any>(messages.map(m => [m.id, m]))
  const roots = new Set<number>(messages.filter(m => m.action === 'topic_created').map(m => m.id))
  const out = new Map<number, string>()
  for (const m of messages) {
    let cur = m
    const path: number[] = []
    let topic = 'main'
    for (let n = 0; n < 5000; n++) {
      const known = out.get(cur.id)
      if (known !== undefined && cur !== m) { topic = known; break }
      path.push(cur.id)
      const r = cur.reply_to_message_id
      if (r === undefined || r === null) { topic = roots.has(cur.id) ? String(cur.id) : 'main'; break }
      if (roots.has(r) || !byId.has(r)) { topic = String(r); break }
      cur = byId.get(r)
    }
    for (const id of path) if (!out.has(id)) out.set(id, topic)
  }
  return out
}

// A message's text with its formatting dropped; links keep their visible text.
export function flatText(t: unknown): string {
  if (typeof t === 'string') return t
  if (!Array.isArray(t)) return ''
  return t.map(p => typeof p === 'string' ? p : String(p?.text ?? '')).join('')
}

// What a message says, with what it carries named: "[photo] caption", "[file: a.pdf]".
export function messageText(m: any): string {
  const parts: string[] = []
  if (m.forwarded_from) parts.push(`(forwarded from ${m.forwarded_from})`)
  if (m.photo) parts.push('[photo]')
  else if (m.media_type === 'sticker') parts.push(`[sticker${m.sticker_emoji ? ` ${m.sticker_emoji}` : ''}]`)
  else if (m.media_type === 'animation') parts.push('[gif]')
  else if (m.media_type === 'voice_message') parts.push('[voice message]')
  else if (m.media_type === 'video_message') parts.push('[video message]')
  else if (m.media_type === 'video_file') parts.push(`[video${m.file_name ? `: ${m.file_name}` : ''}]`)
  else if (m.media_type === 'audio_file') parts.push(`[audio${m.title || m.performer ? `: ${[m.performer, m.title].filter(Boolean).join(' – ')}` : ''}]`)
  else if (m.file) parts.push(`[file${m.file_name ? `: ${m.file_name}` : ''}]`)
  if (m.poll?.question) parts.push(`[poll: ${m.poll.question}]`)
  const text = flatText(m.text).trim()
  if (text) parts.push(text)
  return parts.join(' ')
}

export interface ImportResult { chat: string; title: string; messages: number; topics: Record<string, { title: string; messages: number }>; skipped: number; episodes: number }

export function importExport(exportPath: string, idx: ContextIndex, o: { plan?: TopicPlan; chat?: string } = {}): ImportResult {
  const file = exportPath.endsWith('.json') ? exportPath : join(exportPath, 'result.json')
  const dir = dirname(resolve(file))
  const d = JSON.parse(readFileSync(file, 'utf8'))
  const chat = o.chat ?? botApiChatId(d)
  const all: any[] = d.messages ?? []
  const topicOf = topicsOf(all)
  const plan = o.plan ?? {}
  // Titles the export itself knows: topics created, or renamed, inside it.
  const exportTitles: Record<string, string> = {}
  for (const m of all) if (m.action === 'topic_created' && m.title) exportTitles[String(m.id)] = m.title
  for (const m of all) if (m.action === 'topic_edit' && m.new_title && m.reply_to_message_id) exportTitles[String(m.reply_to_message_id)] = m.new_title
  const drop = new Set(plan.drop ?? [])
  const titleOf = (t: string) => plan.names?.[t] ?? exportTitles[t] ?? (t === 'main' ? 'General' : undefined)
  const msgs: CtxMessage[] = []
  const media: { id: number; kind: string; path: string }[] = []
  const count: Record<string, { title: string; messages: number }> = {}
  let skipped = 0
  for (const m of all) {
    if (m.type !== 'message') continue
    let topic = topicOf.get(m.id) ?? 'main'
    topic = plan.merge?.[topic] ?? topic
    const title = titleOf(topic)
    if (drop.has(topic) || (!title && plan.names && !plan.keepUnnamed)) { skipped++; continue }
    const text = messageText(m)
    if (!text) { skipped++; continue }
    const from = m.from || 'Deleted Account'
    const replyTo = typeof m.reply_to_message_id === 'number' && String(m.reply_to_message_id) !== topic && topicOf.has(m.reply_to_message_id) ? m.reply_to_message_id : undefined
    msgs.push({ chat, topic, topicTitle: title ?? `topic ${topic}`, id: m.id, t: Number(m.date_unixtime ?? Date.parse(m.date) / 1000), from, text, replyTo, bot: /bot$/i.test(from) })
    const rel = m.photo ?? m.file
    if (typeof rel === 'string' && !rel.startsWith('(')) media.push({ id: m.id, kind: m.photo ? 'photo' : (m.media_type ?? 'file'), path: join(dir, rel) })
    ;(count[topic] ??= { title: title ?? `topic ${topic}`, messages: 0 }).messages++
  }
  // Replace what an earlier import of this chat put there.
  idx.db.transaction(() => {
    idx.db.prepare('DELETE FROM msgs WHERE chat = ?').run(chat)
    idx.db.prepare('DELETE FROM msg_fts WHERE chat = ?').run(chat)
    idx.db.prepare('DELETE FROM media WHERE chat = ?').run(chat)
    idx.db.prepare('UPDATE topics SET dirty = 1 WHERE chat = ?').run(chat)
  })()
  for (let i = 0; i < msgs.length; i += 2000) idx.add(msgs.slice(i, i + 2000))
  idx.db.transaction(() => { for (const x of media) if (existsSync(x.path)) idx.setMedia(chat, x.id, x.kind, x.path) })()
  // Topics left out this time: gone from the list, and refresh() drops their stretches.
  const kept = new Set(Object.keys(count))
  for (const r of idx.db.query('SELECT topic FROM topics WHERE chat = ?').all(chat) as { topic: string }[]) {
    if (!kept.has(r.topic)) idx.db.prepare('UPDATE topics SET dirty = 1 WHERE chat = ? AND topic = ?').run(chat, r.topic)
  }
  for (const [t, c] of Object.entries(count)) idx.db.prepare('UPDATE topics SET title = ? WHERE chat = ? AND topic = ?').run(c.title, chat, t)
  idx.refresh()
  for (const r of idx.db.query('SELECT topic FROM topics WHERE chat = ?').all(chat) as { topic: string }[]) {
    if (!kept.has(r.topic)) idx.db.prepare('DELETE FROM topics WHERE chat = ? AND topic = ?').run(chat, r.topic)
  }
  const episodes = (idx.db.query('SELECT count(*) n FROM episodes WHERE chat = ?').get(chat) as any).n
  const title = String(d.name ?? chat)
  idx.setMeta(`archive:${chat}`, JSON.stringify({ title, source: resolve(file), imported: new Date().toISOString(), messages: msgs.length, episodes }))
  return { chat, title, messages: msgs.length, topics: count, skipped, episodes }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
  const src = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true)
  const db = opt('--db')
  if (!src || !db) {
    console.error('usage: bun context/import-telegram.ts <export dir or result.json> --db <context.db> [--topics topics.json] [--chat <id>]')
    process.exit(2)
  }
  const plan = opt('--topics') ? JSON.parse(readFileSync(opt('--topics')!, 'utf8')) as TopicPlan : undefined
  const idx = new ContextIndex(db)
  const t0 = performance.now()
  const r = importExport(src, idx, { plan, chat: opt('--chat') })
  idx.close()
  console.log(`imported "${r.title}" as chat ${r.chat}: ${r.messages} messages in ${Object.keys(r.topics).length} topics, ${r.episodes} stretches; ` +
    `${r.skipped} left out; ${Math.round(performance.now() - t0)} ms`)
  for (const [t, c] of Object.entries(r.topics).sort((a, b) => b[1].messages - a[1].messages)) console.log(`  ${c.title} (topic ${t}): ${c.messages}`)
}
