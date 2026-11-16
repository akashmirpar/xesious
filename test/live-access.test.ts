import { test, expect } from 'bun:test'
import { linkExpired, claimDevice, ownLink } from '../live/access'

const at = (iso: string) => Date.parse(iso)
const made = { created: '2026-11-13T10:00:00.000Z' }

test('a link works for its hour and not after', () => {
  expect(linkExpired(made, at('2026-11-13T10:59:59Z'), 60)).toBe(false)
  expect(linkExpired(made, at('2026-11-13T11:00:01Z'), 60)).toBe(true)
})
test('a link in use keeps working: its hour counts from when it was last used', () => {
  const used = { ...made, used: '2026-11-13T14:30:00.000Z' }
  expect(linkExpired(used, at('2026-11-13T15:29:00Z'), 60)).toBe(false)
  expect(linkExpired(used, at('2026-11-13T15:31:00Z'), 60)).toBe(true)
  expect(linkExpired({ ...made, used: 'garbage' }, at('2026-11-13T10:30:00Z'), 60)).toBe(false)
})
test('0 means no expiry', () => {
  expect(linkExpired(made, at('2027-01-01T00:00:00Z'), 0)).toBe(false)
})
test('a link with no readable date counts as expired', () => {
  expect(linkExpired({ created: 'garbage' }, Date.now(), 60)).toBe(true)
})

test('the first device takes the link; it may come back; another device may not', () => {
  const link: { device?: string } = {}
  expect(claimDevice(link, 'device-one-0123456789')).toBe('bound')
  expect(link.device).toMatch(/^[0-9a-f]{64}$/)
  expect(link.device).not.toContain('device-one')
  expect(claimDevice(link, 'device-one-0123456789')).toBe('ok')
  expect(claimDevice(link, 'device-two-0123456789')).toBe('other')
})
test('no token, or a silly one, takes nothing', () => {
  const link: { device?: string } = {}
  for (const t of [undefined, '', 'short', 42, 'x'.repeat(500)]) expect(claimDevice(link, t)).toBe('missing')
  expect(link.device).toBeUndefined()
})

test('a link is only one of the file\'s own entries', () => {
  const links = JSON.parse('{"real-one":{"created":"2026-11-13T10:00:00.000Z"},"__proto__":{"created":"x"}}')
  expect(ownLink(links, 'real-one')).toBeDefined()
  for (const k of ['constructor', 'toString', 'hasOwnProperty', '', 'x'.repeat(101)]) expect(ownLink(links, k)).toBeUndefined()
  expect(ownLink({}, '__proto__')).toBeUndefined()
  expect(ownLink(links, 42)).toBeUndefined()
  // Nothing on Object.prototype after a device claim on what was found.
  expect((Object.prototype as any).device).toBeUndefined()
})
