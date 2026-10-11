#!/usr/bin/env bun
/**
 * sync.ts — bring every configured engine up to date with a store, now, instead of a
 * little per background tick: embed the vectors it searches, send an external engine
 * the stretches it has not seen. For a freshly imported archive, or after adding an
 * engine to the config.
 *
 *   bun context/sync.ts --config <context-engines.json> (--db <context.db> | --archive <chat id>) [--engine a,b]
 */
import { ContextIndex } from './engine'
import { buildEngines, loadEnginesConfig } from './engines'

const args = process.argv.slice(2)
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const cfg = loadEnginesConfig(opt('--config'))
const db = opt('--db') ?? (opt('--archive') ? cfg.archives?.[opt('--archive')!]?.db : undefined)
if (!db) { console.error('usage: bun context/sync.ts --config <file> (--db <context.db> | --archive <chat id>) [--engine a,b]'); process.exit(2) }
const only = opt('--engine') ? new Set(opt('--engine')!.split(',')) : undefined
const store = new ContextIndex(db)
store.refresh()
const seen = new Set<string>()
for (const e of buildEngines(cfg).values()) {
  if (only && !only.has(e.id)) continue
  if (!e.syncTarget || seen.has(e.syncTarget)) continue
  seen.add(e.syncTarget)
  const t0 = performance.now()
  let total = 0
  let retries = 0
  for (;;) {
    let err = ''
    const n = await e.sync(store, { budget: 256 }).catch(x => { err = String(x); return -1 })
    // A service still loading its model (503) or restarting (refused) is waited for.
    if (n < 0 && /HTTP 50[023]|ECONNREFUSED|ConnectionRefused|Unable to connect|timed out|closed unexpectedly/i.test(err) && retries++ < 60) {
      console.error(`[sync] ${e.id}: ${err.slice(0, 120)} — retrying in 10 s`)
      await Bun.sleep(10_000)
      continue
    }
    if (n < 0) console.error(`[sync] ${e.id}: ${err}`)
    if (n <= 0) break
    retries = 0
    total += n
    console.log(`[sync] ${e.id} (${e.syncTarget}): ${total} so far, ${((performance.now() - t0) / 1000).toFixed(0)} s`)
  }
  console.log(`[sync] ${e.id}: done, ${total} in ${((performance.now() - t0) / 1000).toFixed(0)} s`)
}
store.close()
