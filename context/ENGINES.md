# Context engines — choosing one, and adding one

The context engine keeps everything a group said in one store (`context/engine.ts`:
messages, *stretches* of conversation cut at pauses, topics, summaries). A **search
engine** does one thing on top of it: given a question, rank the stretches. The bridge
uses a topic's engine twice per answer:

1. **Automatic recall.** Before the turn, the bridge searches and hands Claude up to
   three stretches (`Recall earlier talk` in `/config` → *Context engine*: off / when a
   message points back / on every message). What it searches with is the topic's
   *Search words* setting: by default Claude Sonnet (or Haiku) writes them from the message and the
   talk just before it (`context/query.ts`), shown the terms the searched history uses
   most, so a name typed in another script comes out spelled the way the chat spells
   it; or the message as typed, with no model involved. On a real history,
   Claude-written words beat the message as typed for every engine.
2. **Claude's own searches.** During the turn Claude can call `search_history`,
   `read_messages` and `list_topics` (`context/mcp.ts`), with search words it picks.

Engines are listed in a JSON file — `state/context-engines.json`, or the path in
`TG_CONTEXT_ENGINES`. `context/setup.sh` installs bge-m3 on llama.cpp, starts it and
writes the file from `context/context-engines.example.json`: keywords, and keywords +
bge-m3 as the default. Without the file, the old variables describe one built-in
engine, as before: keywords, plus meaning with `TG_CONTEXT_EMBED=1` (bge-m3 on the
local server, `http://127.0.0.1:8093`) or `TG_CONTEXT_EMBED_URL` (another server;
`TG_CONTEXT_EMBED` is its model name), plus summaries with `TG_CONTEXT_DIGEST`.
A transformers.js model id in `TG_CONTEXT_EMBED` (e.g. `Xenova/multilingual-e5-small`)
runs in the bridge instead; nothing installs its runtime (`context/embed.ts` says how).

```jsonc
{
  "default": "xesious-bge-m3",
  // an OpenAI-compatible embeddings server (llama.cpp's llama-server, or the cache in front of it)
  "embeddings": { "url": "http://127.0.0.1:8093", "model": "bge-m3", "maxChars": 2000 },
  // the model that writes per-stretch summaries (haiku / sonnet through the CLI, or "local");
  // setting it turns summary writing on in every topic, which costs usage (/config turns it off per topic)
  "summaries": { "model": "haiku" },
  // the service that reads the text in photos (context/OCR.md); without it, photos are known by their captions
  "ocr": { "url": "http://127.0.0.1:8094" },
  "engines": {
    "xesious-keywords": { "kind": "xesious", "label": "keywords" },
    "xesious-bge-m3":   { "kind": "xesious", "label": "keywords + bge-m3", "meaning": true },
    "xesious-bge-m3-haiku": { "kind": "xesious", "meaning": true, "summaries": "haiku", "summaryUse": "with-text" },
    "txtai-dense":      { "kind": "http", "url": "http://127.0.0.1:8092", "mode": "dense" },
    "txtai-bm25":       { "kind": "http", "url": "http://127.0.0.1:8092", "mode": "bm25", "dense": false }
  },
  // imported histories (context/import-telegram.ts), each in its own file
  "archives": { "-1001234567890": { "db": "/data/archive/context.db", "title": "Old team chat (export)" } },
  // a topic ("chat:topic id" or "chat:topic title") or a whole group ("chat") that searches an archive or another group
  "links": { "-1009876543210:Archive": "-1001234567890" }
}
```

Every engine in the file is kept up to date with every message (in the background), so
switching a topic's engine in `/config` is instant and loses nothing. `/recall <question>`
shows every engine's top three side by side. Links are set here, on the server, and
may point at an archive or at another group's chat id.

## The built-in engine (`kind: "xesious"`)

Signals fused by rank (reciprocal-rank fusion): keywords over whole stretches and over
single messages (SQLite FTS5, Persian spelling and thousands separators normalised), the
conversation just before the question, a date the question names (English or Persian,
Gregorian or Solar Hijri months), and optionally:

| option | effect |
|---|---|
| `"meaning": true` | vectors of each stretch from the `embeddings` server |
| `"summaries": "<model>"` | also search the summaries that model wrote (words, and vectors when `meaning` is on) |
| `"summaryUse": "with-text"` | summaries are extra signals next to the talk (default) |
| `"summaryUse": "alone"` | only the summaries are searched, in place of the talk |

Two pairs of signals measure the same thing — a stretch's words and its best message's
words; the meaning of the talk and of its summary — so each pair counts once, by its
better rank, with a little extra when both agree; and the rank constant is 10, not the
usual 60, so the top of a list counts for more than being somewhere in it (`FUSION` in
`context/engine.ts`). Without this, a stretch found half-way down by every list
outranked the one a single message answers exactly. Measured on a real archive
(`context/fusion-eval.ts`): an answer in the top 5 for 78% of real questions
as the recall searches them, up from 67%.

A question's words are searched along with numbers it writes in words (`هزار` → 1000,
"ten thousand" → 10000) and, for a name it writes in Persian letters, the spelling the
chat itself uses in Latin ones (`داکر` → docker), found by consonants among the chat's
own frequent words (`expandQuery`).

## An engine in any language (`kind: "http"`)

Run a small HTTP service and list it with `"kind": "http", "url": "…"`. The bridge
sends it stretches as they change and asks it to rank them; everything else (storage,
reading messages, topics) stays in the store. JSON in, JSON out; any non-2xx reply
means "down", and the bridge falls back to keywords for that search.

| call | body | reply |
|---|---|---|
| `POST /upsert` | `{ index, chat, dense, items: [{ key, topic, t0, t1, text }] }` | `{ ok: true }` |
| `POST /delete` | `{ index, chat, keys: [key] }` | `{ ok: true }` |
| `POST /search` | `{ index, chat, query, k, mode?, weights?, topic?, since?, until? }` | `{ hits: [{ key, score }] }`, best first |
| `GET /health` | | `{ ok: true, … }` |

- `key` is the stretch's id (`chat:topic:firstMessageId`); return it unchanged.
- `text` is the stretch as the bridge would show it (a header line, then one line per
  message: `[hh:mm] #id Author: text`). `t0`/`t1` are unix seconds.
- `index` separates what the engine is sent (`plain`, or the summary variants); `chat`
  must never be mixed with another chat's.
- `mode`, `weights` and `dense` are passed through from the engine's config entry, for
  a service with several ways to search (txtai: `dense`, `bm25`, `hybrid`).
- `topic`, `since`, `until` are filters Claude may pass to `search_history`.

`context/engines/txtai_service.py` is a complete example (~200 lines of Python).
`context/sync.ts` sends an engine everything at once (after an import, or when adding
an engine); the bridge otherwise keeps it up to date a little every minute.

## A new kind written in TypeScript

`registerKind('name', (id, def, cfg) => ({ id, label, def, search(store, chat, query, o), sync(store, o) }))`
in `context/engines.ts`. `search` returns `Hit[]` (use `store.hitsFor()` to turn ranked
keys into hits); `sync` does any background upkeep and returns how much it did.

## Comparing engines on real questions

```sh
bun context/import-telegram.ts <export dir> --db <archive.db> --topics topics.json   # a Telegram Desktop JSON export
bun context/summarize.ts --db <archive.db> --model haiku --batch 16 --conc 2          # optional: summaries
bun context/sync.ts --config <engines.json> --archive <chat id>                       # vectors, external engines
bun context/compare.ts --config <engines.json> --archive <chat id> --questions q.txt --out results.json
bun context/review.ts results.json review.html                                        # judge blind, get scores
```

## Local services

`context/setup.sh` installs the first two below and starts them (`--check` reports,
`--no-start` only installs). `context/setup-ocr.sh` installs the OCR reader; txtai
needs a Python venv with txtai at `$XESIOUS_DATA/venvs/txtai`, made by hand.

`context/services.sh start|stop|status [emb|cache|txtai|ocr|all]` runs the embeddings
server (llama.cpp + bge-m3), a cache in front of it, the txtai engine and the OCR reader, each with a
restart loop, pinned to two cores (`XESIOUS_CPUS`, default `2,3`) at the lowest priority:
a small VPS is throttled when it runs flat out for long.
