// Who may use a /live link, and for how long.
//
// The link's uuid is the key, and the first device that opens it keeps it: the page
// makes a random device token, kept in the browser, and the link stores its hash.
// Another device with the same link is refused, so a link that leaks from a
// forwarded message or a screenshot is useless once you have opened it. A new
// /live makes a new link, which the next device to open it takes.
import { createHash } from 'node:crypto'

// How long a link works after it was last used (the page open on it), or after /live
// made it if it was never opened. 0 = forever.
export const LINK_TTL_MIN = Math.max(0, Number(process.env.LIVE_LINK_TTL_MIN ?? 60) || 0)

// `used`: stamped by the live server while a page is connected on the link.
export function linkExpired(link: { created: string; used?: string }, now = Date.now(), ttlMin = LINK_TTL_MIN): boolean {
  if (!ttlMin) return false
  const made = Date.parse(link.created)
  if (!Number.isFinite(made)) return true
  const used = link.used ? Date.parse(link.used) : NaN
  return now - (Number.isFinite(used) ? Math.max(made, used) : made) > ttlMin * 60_000
}

// A link by its id: only one of the file's own entries. A plain lookup would find
// "__proto__" (and the like) on every object, which as a "link" with no date would let
// anyone in where links never expire, and take every new link's device with it.
export function ownLink<L extends object>(links: Record<string, L>, uuid: unknown): L | undefined {
  if (typeof uuid !== 'string' || !uuid || uuid.length > 100 || !Object.hasOwn(links, uuid)) return undefined
  const l = links[uuid]
  return l && typeof l === 'object' && typeof (l as any).created === 'string' ? l : undefined
}

export const deviceHash = (token: string): string => createHash('sha256').update(`xesious-live:${token}`).digest('hex')

// 'bound': this device just took the link (save it). 'ok': it is the device that has it.
// 'other': another device has it. 'missing': no usable token was sent.
export type DeviceCheck = 'bound' | 'ok' | 'other' | 'missing'
export function claimDevice(link: { device?: string }, token: unknown): DeviceCheck {
  if (typeof token !== 'string' || token.length < 16 || token.length > 200) return 'missing'
  const h = deviceHash(token)
  if (!link.device) { link.device = h; return 'bound' }
  return link.device === h ? 'ok' : 'other'
}
