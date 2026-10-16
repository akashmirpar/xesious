import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runScript, outputBlock, lastLines } from './scripts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'xesious-script-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const env = { PATH: process.env.PATH, HOME: process.env.HOME }
const gone = (pid: number) => { try { process.kill(pid, 0); return false } catch { return true } }

describe('running a script', () => {
  test('its status, what it printed and its stderr, in its folder', async () => {
    const r = await runScript({ command: 'pwd; echo "backup: 12 files"; echo "1 skipped" >&2; exit 0', cwd: dir, env, timeoutMs: 10_000 })
    expect(r.code).toBe(0)
    expect(r.out).toBe(`${dir}\nbackup: 12 files\n`)
    expect(r.err).toBe('1 skipped\n')
    expect(r.timedOut).toBe(false)
    const bad = await runScript({ command: 'echo "disk full" >&2; exit 3', cwd: dir, env, timeoutMs: 10_000 })
    expect(bad.code).toBe(3)
  })

  test('past its time limit it is stopped, with everything it started', async () => {
    const r = await runScript({ command: 'sleep 300 & echo $! > child.pid; wait', cwd: dir, env, timeoutMs: 400 })
    expect(r.timedOut).toBe(true)
    expect(r.code).toBeNull()
    const child = Number(readFileSync(join(dir, 'child.pid'), 'utf8'))
    for (let i = 0; i < 40 && !gone(child); i++) await Bun.sleep(50)
    expect(gone(child)).toBe(true)
  })

  test('a person can stop it', async () => {
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 200)
    const r = await runScript({ command: 'echo started; sleep 30', cwd: dir, env, timeoutMs: 10_000, signal: stop.signal })
    expect(r).toMatchObject({ stopped: true, code: null, timedOut: false, out: 'started\n' })
  })
})

test('output as a code block: the end of it, in a fence nothing in it can close', () => {
  expect(outputBlock('a\nb\n\n')).toBe('```\na\nb\n```')
  expect(outputBlock('x ``` y')).toBe('````\nx ``` y\n````')
  expect(outputBlock('0123456789', 4)).toBe('```\n…\n6789\n```')
  expect(lastLines('one\n\ntwo\nthree\nfour', 2)).toBe('three · four')
})
