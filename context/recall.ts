/**
 * recall.ts — what a turn is handed from earlier conversation: the stretches an
 * engine found, trimmed to what matters, as the text Claude reads.
 *
 * Shared by the bridge (the recall block in front of a message) and compare.ts (which
 * shows, for every engine, exactly what the bot would have been given).
 */
import type { Hit } from './engine'

export const RECALL_CHARS = 4000
export const RECALL_MAX = 3

// The link to a message of a supergroup (ids -100…) — in its forum topic when it has
// one — with "<id>" standing for the message's number; undefined where Telegram has
// no message links (basic groups, direct messages). The history hands these to
// Claude so an answer can cite a message as something to tap, not a date and a number.
export function linkTemplate(chat: string, topic: string): string | undefined {
  const m = /^-100(\d+)$/.exec(chat)
  if (!m) return undefined
  return `https://t.me/c/${m[1]}/${topic && topic !== 'main' ? `${topic}/` : ''}<id>`
}
// What Claude is told about those links.
export const CITE_LINKS = 'When you rely on a message, cite it as a Markdown link to it — its link with <id> replaced by the message\'s number, e.g. [7 Sep](https://t.me/c/123/45/6789) — not as a bare date and number.'

// The body of a recall block: each stretch with its topic, date and message ids;
// around what matched when a stretch is long, all of it when it is short; stopping
// at `maxChars`. `scrub` blanks anything that must not survive into the prompt (the
// bridge's secret marker).
export function recallBody(hits: Hit[], o: { maxChars?: number; scrub?: (s: string) => string } = {}): { text: string; used: Hit[] } {
  const max = o.maxChars ?? RECALL_CHARS
  const parts: string[] = []
  const used: Hit[] = []
  let size = 0
  for (const h of hits) {
    const lines = h.episode.text.split('\n').slice(1)
    let pick = lines
    if (lines.length > 12 && h.matched.length) {
      const at = new Set<number>()
      for (const id of h.matched) {
        const i = lines.findIndex(l => l.includes(`#${id} `))
        if (i >= 0) for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) at.add(j)
      }
      if (at.size) pick = [...at].sort((a, b) => a - b).map(i => lines[i])
    }
    const body = pick.map(l => o.scrub ? o.scrub(l) : l).join('\n')
    const link = linkTemplate(h.episode.chat, h.episode.topic)
    const head = `— ${h.episode.topicTitle}, ${new Date(h.episode.t0 * 1000).toISOString().slice(0, 10)}, messages #${h.episode.first}–#${h.episode.last}` +
      (link ? ` (link to a message: ${link})` : '') + ':'
    if (size + head.length + body.length > max && parts.length) break
    parts.push(`${head}\n${body.slice(0, Math.max(0, max - size))}`)
    used.push(h)
    size += head.length + body.length
  }
  return { text: parts.join('\n\n'), used }
}

// The words around the body. `source` names whose history it is: "this group's" or
// an archive's title.
export function recallIntro(source?: string): string {
  return source
    ? `earlier conversations from ${source} that may be what this message is about, found by searching that history. `
    : `earlier conversations in this group that may be what this message is about, found by searching the group's history. `
}
export const RECALL_CAVEAT = `They may be unrelated; use them only if they fit, and say where something came from if you rely on it. If one is close but differs from what the message says (another amount, date or person), it is probably not the one meant: search the history for the right one, and if it does not turn up, say you could not find it rather than correct the person with a different message. ${CITE_LINKS}\n`
