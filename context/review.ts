#!/usr/bin/env bun
/**
 * review.ts — turn a compare.ts result into one self-contained HTML page for judging
 * the engines blind, on real questions with no answer key:
 *
 *   1. For each question, every engine's top results, pooled and shuffled by how
 *      highly the engines ranked them, engine names hidden. You mark each "answers
 *      it", "related" or "no". Marks are kept in the browser (and can be exported).
 *   2. A scoreboard worked out from your marks, per engine and way of asking.
 *   3. For each question and engine, exactly what the bot would have been handed.
 *
 *   bun context/review.ts <results.json> <review.html>
 *
 * Nothing leaves the page: no scripts or fonts from anywhere else.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

// The page for a compare.ts result (with `suggest`: judge.ts's marks, if any).
export function reviewPage(data: any): string {
// </script> inside the data would end the script element early.
const json = JSON.stringify(data).replace(/</g, '\\u003c')

return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Context Engine Review</title>
<style>
:root {
  --bg: #f7f7f5; --panel: #ffffff; --ink: #1d1d1b; --muted: #6b6b66; --line: #e3e2dc;
  --accent: #2f5bd3; --good: #1f8a4c; --mid: #b7791f; --bad: #b3392f; --chip: #efeee9; --code: #f2f1ec;
  --good-bg: #e6f4ec; --mid-bg: #fbf1df; --bad-bg: #f8e7e5;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #151514; --panel: #1e1e1c; --ink: #ecebe6; --muted: #a09f98; --line: #34332f;
    --accent: #7c9cf5; --good: #5cc98a; --mid: #e3ad55; --bad: #ef7b6f; --chip: #2a2a27; --code: #252522;
    --good-bg: #1c3326; --mid-bg: #3a2f1a; --bad-bg: #3a2220;
  }
}
:root[data-theme="dark"] {
  --bg: #151514; --panel: #1e1e1c; --ink: #ecebe6; --muted: #a09f98; --line: #34332f;
  --accent: #7c9cf5; --good: #5cc98a; --mid: #e3ad55; --bad: #ef7b6f; --chip: #2a2a27; --code: #252522;
  --good-bg: #1c3326; --mid-bg: #3a2f1a; --bad-bg: #3a2220;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", "Vazirmatn", Tahoma, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 80px; }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 20px; margin: 40px 0 12px; }
h3 { font-size: 16px; margin: 0; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
nav.top { position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--line); margin: 0 -16px; padding: 10px 16px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
nav.top a { color: var(--accent); text-decoration: none; font-weight: 600; font-size: 14px; }
nav.top .spacer { flex: 1; }
button, .btn { font: inherit; font-size: 13px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 8px; padding: 5px 10px; cursor: pointer; }
button:hover { border-color: var(--accent); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin: 12px 0; }
.q { margin: 28px 0; }
.qhead { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
.qnum { font-weight: 700; color: var(--accent); }
.qtext { font-size: 17px; font-weight: 600; }
.rew { font-size: 13px; color: var(--muted); margin: 4px 0 10px; }
.card { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin: 8px 0; background: var(--panel); }
.card.j2 { border-color: var(--good); background: var(--good-bg); }
.card.j1 { border-color: var(--mid); background: var(--mid-bg); }
.card.j0 { opacity: .55; }
.card.s2 { border: 1px dashed var(--good); }
.card.s1 { border: 1px dashed var(--mid); }
.card.s0 { opacity: .8; }
.sug { font-size: 12px; }
.meta { font-size: 13px; color: var(--muted); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.chip { background: var(--chip); border-radius: 999px; padding: 1px 8px; font-size: 12px; }
.gist { font-size: 13px; color: var(--muted); margin: 6px 0; white-space: pre-wrap; }
.lines { font-size: 14px; margin: 6px 0 0; }
.line { padding: 1px 0; unicode-bidi: plaintext; }
.line b { font-weight: 600; }
.hit { background: color-mix(in srgb, var(--accent) 14%, transparent); border-radius: 4px; }
.judge { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.judge button[aria-pressed="true"].b2 { background: var(--good); color: #fff; border-color: var(--good); }
.judge button[aria-pressed="true"].b1 { background: var(--mid); color: #fff; border-color: var(--mid); }
.judge button[aria-pressed="true"].b0 { background: var(--bad); color: #fff; border-color: var(--bad); }
details > summary { cursor: pointer; color: var(--accent); font-size: 13px; }
pre.block { white-space: pre-wrap; background: var(--code); border-radius: 8px; padding: 10px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; unicode-bidi: plaintext; max-height: 420px; overflow: auto; }
.tw { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; white-space: nowrap; }
th { font-size: 12px; color: var(--muted); font-weight: 600; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
tr.best td { font-weight: 700; }
.bar { display: inline-block; height: 8px; border-radius: 4px; background: var(--accent); vertical-align: middle; margin-right: 6px; }
.progress { font-size: 13px; }
.eng { margin: 10px 0 16px; }
.rank { font-size: 13px; margin: 2px 0; unicode-bidi: plaintext; }
.why { font-size: 11px; color: var(--muted); }
.warn { color: var(--bad); }
@media (max-width: 640px) { .qtext { font-size: 16px; } th, td { padding: 5px 6px; } }
</style>
</head>
<body>
<main>
<nav class="top">
  <a href="#judge">1 · Judge</a><a href="#scores">2 · Scores</a><a href="#handed">3 · What each engine gave the bot</a>
  <span class="spacer"></span>
  <span class="progress" id="progress"></span>
  <label class="small"><input type="checkbox" id="usesug" checked> count suggestions I haven't reviewed</label>
  <button id="export">Export marks</button>
  <label class="btn">Import marks<input id="import" type="file" accept="application/json" hidden></label>
  <button id="theme">Theme</button>
</nav>
<header style="margin-top:18px">
  <h1>Context engines on real history</h1>
  <div class="muted" id="sub"></div>
</header>

<section class="panel small">
  <b>How this works.</b> Each question was run through every engine twice: <b>as typed</b>, and as <b>search words written by Claude Haiku</b> (names in both scripts, synonyms), which is roughly what the bot's own searches look like.
  Below, each question lists every conversation any engine put in its top results, mixed together, <b>with engine names hidden</b>, most-agreed first.
  Mark each one: <b>Answers it</b> (you could answer the question from it), <b>Related</b> (right subject, not the answer), or <b>No</b>. Unmarked ones count as "no".
  You can stop marking a question once you've found its answers. The scores in section 2 update as you go. Marks are saved in this browser; use <i>Export marks</i> to keep them or send them.
  A gist under each conversation (an English summary by Claude Sonnet) is there to help you read faster; it's the same whichever engine found it.
  <br><br><b>Suggestions.</b> Claude Sonnet has pre-marked every conversation (the <span class="chip">suggested</span> tag, and a dashed outline). Your own mark always wins; with the box at the top ticked, a suggestion you haven't reviewed counts in the scores, so they're meaningful before you start — reviewing mostly means correcting the suggestions that are wrong.
</section>

<h2 id="judge">1 · Judge the results</h2>
<div id="questions"></div>

<h2 id="scores">2 · Scores from your marks</h2>
<div class="panel small muted" id="scorenote"></div>
<div class="tw"><table id="scoretable"></table></div>

<h2 id="handed">3 · What each engine gave the bot</h2>
<div class="panel small">For every question and engine: the top results in order, and the exact block the bot would have been handed before answering, with <i>Recall</i> set to "on every message". The note says whether the default setting ("when a message points back") would have handed it anything.</div>
<div id="appendix"></div>
</main>

<script type="application/json" id="data">${json}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent)
const STORE = 'ctx-review:' + D.chat
let marks = {}
try { marks = JSON.parse(localStorage.getItem(STORE) || '{}') } catch {}
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(marks)) } catch {} }
const S = D.suggest || {}
let useSug = true
try { useSug = localStorage.getItem(STORE + ':usesug') !== '0' } catch {}
document.getElementById('usesug').checked = useSug
// The mark that counts: yours, else (when ticked) the suggestion.
const val = (n, key) => marks[n]?.[key] ?? (useSug ? S[n]?.[key] : undefined)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const day = t => new Date(t * 1000).toISOString().slice(0, 10)
// The ways of asking in this result, in a fixed order.
const forms = ['typed', 'rewritten', 'bridge', 'bridge-sonnet'].filter(f => D.questions.some(q => D.runs[q.n]?.[f]))
const formLabel = { typed: 'as typed', rewritten: 'Haiku search words (test)', bridge: 'Haiku\\'s words, as the bot writes them', 'bridge-sonnet': 'Sonnet\\'s words, as the bot writes them' }
const formWords = (q, f) => f === 'rewritten' ? q.rewritten : f === 'bridge' ? q.bridge : f === 'bridge-sonnet' ? q.bridgeSonnet : null
document.getElementById('sub').textContent = D.title + ' · ' + D.questions.length + ' questions · ' + D.engines.length + ' engines · top ' + D.k + ' each · made ' + D.made.slice(0, 16).replace('T', ' ') + ' UTC'

// The pool for a question: every stretch any engine/form returned, ordered by how
// highly they were ranked overall (sum of 1/rank), so likely answers come first.
function pool(q) {
  const score = {}, ids = {}
  for (const f of forms) for (const e of D.engines) {
    const r = D.runs[q.n]?.[f]?.[e.id]
    if (!r) continue
    r.hits.forEach((h, i) => { score[h.key] = (score[h.key] || 0) + 1 / (i + 1); (ids[h.key] ??= new Set()); h.matched.forEach(m => ids[h.key].add(m)) })
  }
  return Object.keys(score).sort((a, b) => score[b] - score[a]).map(k => ({ key: k, matched: ids[k] }))
}

function linesOf(st, matched, all) {
  const lines = st.text.split('\\n').slice(1)
  let pick = lines.map((l, i) => i)
  if (!all && lines.length > 10) {
    const keep = new Set()
    lines.forEach((l, i) => { const m = /#(\\d+) /.exec(l); if (m && matched.has(Number(m[1]))) for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < lines.length) keep.add(j) })
    pick = keep.size ? [...keep].sort((a, b) => a - b) : lines.slice(0, 8).map((l, i) => i)
  }
  let prev = -1
  return pick.map(i => {
    const l = lines[i]
    const m = /^\\[(\\d\\d:\\d\\d)\\] #(\\d+) ([^:]+?)(?: \\(reply to #\\d+\\))?: (.*)$/.exec(l)
    const gap = prev >= 0 && i > prev + 1 ? '<div class="line muted">…</div>' : ''
    prev = i
    if (!m) return gap + '<div class="line" dir="auto">' + esc(l) + '</div>'
    const hit = matched.has(Number(m[2])) ? ' hit' : ''
    return gap + '<div class="line' + hit + '" dir="auto"><span class="muted small">' + m[1] + '</span> <b>' + esc(m[3]) + ':</b> ' + esc(m[4]) + '</div>'
  }).join('')
}

function renderQuestions() {
  const root = document.getElementById('questions')
  root.innerHTML = ''
  for (const q of D.questions) {
    const sec = document.createElement('section')
    sec.className = 'q'
    sec.id = 'q' + q.n
    const p = pool(q)
    sec.innerHTML = '<div class="qhead"><span class="qnum">Q' + q.n + '</span><span class="qtext" dir="auto">' + esc(q.text) + '</span><span class="muted small" data-count></span></div>' +
      (q.rewritten ? '<div class="rew" dir="auto">Haiku search words (test): ' + esc(q.rewritten) + '</div>' : '') +
      (q.bridge ? '<div class="rew" dir="auto">Haiku\\'s words, as the bot writes them: ' + esc(q.bridge) + '</div>' : '') +
      (q.bridgeSonnet ? '<div class="rew" dir="auto">Sonnet\\'s words, as the bot writes them: ' + esc(q.bridgeSonnet) + '</div>' : '')
    for (const c of p) {
      const st = D.stretches[c.key]
      const card = document.createElement('div')
      card.className = 'card'
      card.dataset.key = c.key
      const gist = st.summaries.sonnet || st.summaries.haiku
      const sv = S[q.n]?.[c.key]
      const sugText = sv === 2 ? '✓ answers it' : sv === 1 ? '~ related' : sv === 0 ? '✗ no' : ''
      card.innerHTML = '<div class="meta"><span class="chip">' + esc(st.topic) + '</span><span>' + day(st.t0) + (day(st.t1) !== day(st.t0) ? ' → ' + day(st.t1) : '') + '</span><span>#' + st.first + '–#' + st.last + '</span>' +
        (sugText ? '<span class="chip sug">suggested: ' + sugText + '</span>' : '') + '</div>' +
        (gist ? '<div class="gist" dir="auto">' + esc(gist) + '</div>' : '') +
        '<div class="lines">' + linesOf(st, c.matched, false) + '</div>' +
        '<details><summary>Whole conversation</summary><div class="lines">' + linesOf(st, c.matched, true) + '</div></details>' +
        '<div class="judge"><button class="b2" data-v="2">✓ Answers it</button><button class="b1" data-v="1">~ Related</button><button class="b0" data-v="0">✗ No</button></div>'
      card.querySelectorAll('.judge button').forEach(b => b.onclick = () => {
        const v = Number(b.dataset.v)
        const m = (marks[q.n] ??= {})
        if (m[c.key] === v) delete m[c.key]; else m[c.key] = v
        save(); paintCard(card, q.n); paintCounts(); renderScores()
      })
      sec.appendChild(card)
      paintCard(card, q.n)
    }
    root.appendChild(sec)
  }
  paintCounts()
}
function paintCard(card, n) {
  const v = marks[n]?.[card.dataset.key]
  const s = S[n]?.[card.dataset.key]
  card.className = 'card' + (v !== undefined ? ' j' + v : s !== undefined ? ' s' + s : '')
  card.querySelectorAll('.judge button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === v)))
}
function paintCounts() {
  let done = 0, total = 0
  for (const q of D.questions) {
    const p = pool(q), m = marks[q.n] || {}
    const j = p.filter(c => m[c.key] !== undefined).length
    const a = p.filter(c => val(q.n, c.key) === 2).length
    done += j; total += p.length
    const el = document.querySelector('#q' + q.n + ' [data-count]')
    if (el) el.textContent = j + ' of ' + p.length + ' reviewed' + (a ? ' · ' + a + ' answer' + (a > 1 ? 's' : '') : '')
  }
  document.getElementById('progress').textContent = done + ' / ' + total + ' reviewed'
}
document.getElementById('usesug').onchange = ev => {
  useSug = ev.target.checked
  try { localStorage.setItem(STORE + ':usesug', useSug ? '1' : '0') } catch {}
  paintCounts(); renderScores()
}

function renderScores() {
  const counted = q => pool(q).map(c => val(q.n, c.key))
  const answerable = D.questions.filter(q => counted(q).some(v => v === 2))
  const useful = D.questions.filter(q => counted(q).some(v => v >= 1))
  document.getElementById('scorenote').innerHTML = (useSug ? 'Counting Sonnet\\'s suggestions wherever you haven\\'t marked yourself. ' : 'Only your own marks count. ') +
    '<b>' + answerable.length + '</b> of ' + D.questions.length + ' questions have a conversation marked "answers it" — the answer scores are over those. ' +
    '"Useful in top 5" counts "related" too, over the ' + useful.length + ' questions with any mark of that kind. MRR: 1/rank of the first answer (1 = always first). Unmarked results count as "no". ' +
    'Time is the median search time on this server. For the vector setups, embedding the question is part of it (about half a second while the embeddings server is capped at half a core); ' +
    'txtai\\'s vector times look low because xesious had already embedded the same questions, and the shared cache answered.'
  const rows = []
  for (const e of D.engines) for (const f of forms) {
    const has = D.questions.some(q => D.runs[q.n]?.[f]?.[e.id])
    if (!has) continue
    let h1 = 0, h3 = 0, h5 = 0, mrr = 0, u5 = 0
    const ms = []
    for (const q of D.questions) {
      const r = D.runs[q.n]?.[f]?.[e.id]
      if (!r) continue
      ms.push(r.ms)
      const ranks = r.hits.map(h => val(q.n, h.key))
      if (answerable.includes(q)) {
        const i = ranks.findIndex(v => v === 2)
        if (i === 0) h1++
        if (i >= 0 && i < 3) h3++
        if (i >= 0 && i < 5) h5++
        if (i >= 0) mrr += 1 / (i + 1)
      }
      if (useful.includes(q) && ranks.slice(0, 5).some(v => v >= 1)) u5++
    }
    ms.sort((a, b) => a - b)
    const A = answerable.length || 1, U = useful.length || 1
    rows.push({ label: e.label, form: formLabel[f], h1: h1 / A, h3: h3 / A, h5: h5 / A, mrr: mrr / A, u5: u5 / U, ms: ms[Math.floor(ms.length / 2)] || 0, err: D.questions.some(q => D.runs[q.n]?.[f]?.[e.id]?.error) })
  }
  const best = Math.max(...rows.map(r => r.mrr))
  const pct = x => Math.round(x * 100) + '%'
  const bar = x => '<span class="bar" style="width:' + Math.round(x * 60) + 'px"></span>'
  rows.sort((a, b) => b.mrr - a.mrr || b.h5 - a.h5)
  document.getElementById('scoretable').innerHTML = '<thead><tr><th>Engine</th><th>Asked</th><th class="n">First</th><th class="n">Top 3</th><th class="n">Top 5</th><th class="n">MRR</th><th class="n">Useful in top 5</th><th class="n">Time</th></tr></thead><tbody>' +
    rows.map(r => '<tr' + (answerable.length && r.mrr === best ? ' class="best"' : '') + '><td>' + esc(r.label) + (r.err ? ' <span class="warn small">errors</span>' : '') + '</td><td>' + r.form + '</td><td class="n">' + pct(r.h1) + '</td><td class="n">' + pct(r.h3) + '</td><td class="n">' + bar(r.h5) + pct(r.h5) + '</td><td class="n">' + r.mrr.toFixed(2) + '</td><td class="n">' + pct(r.u5) + '</td><td class="n">' + r.ms + ' ms</td></tr>').join('') + '</tbody>'
}

function renderAppendix() {
  const root = document.getElementById('appendix')
  for (const q of D.questions) {
    const d = document.createElement('details')
    d.className = 'panel'
    let h = '<summary><span class="qnum">Q' + q.n + '</span> <span dir="auto">' + esc(q.text) + '</span></summary>'
    for (const f of forms) {
      if (!D.runs[q.n]?.[f]) continue
      h += '<h3 style="margin-top:14px">' + formLabel[f] + (formWords(q, f) ? ': <span dir="auto" class="muted small">' + esc(formWords(q, f)) + '</span>' : '') + '</h3>'
      for (const e of D.engines) {
        const r = D.runs[q.n][f][e.id]
        if (!r) continue
        h += '<div class="eng"><b>' + esc(e.label) + '</b> <span class="muted small">' + r.ms + ' ms</span>' + (r.error ? ' <span class="warn small">error: ' + esc(r.error) + '</span>' : '')
        h += r.hits.map((x, i) => { const st = D.stretches[x.key]; const m = val(q.n, x.key); const tag = m === 2 ? ' ✓' : m === 1 ? ' ~' : ''
          return '<div class="rank">' + (i + 1) + '. ' + esc(st.topic) + ' · ' + day(st.t0) + ' · #' + st.first + '–#' + st.last + tag + ' <span class="why">' + esc(x.why.join(' + ')) + '</span></div>' }).join('') || '<div class="rank muted">nothing found</div>'
        const gateNote = r.gate.pointsBack ? (r.gate.passed ? 'Default recall would hand over ' + r.gate.passed + ' of these.' : 'Default recall: the question points back, but no result was strong enough — nothing handed over.') : 'Default recall: the question does not point back at anything, so nothing handed over (the bot can still search).'
        h += '<details><summary>What the bot is handed (' + (r.block ? r.block.length + ' characters' : 'nothing') + ') — ' + esc(gateNote) + '</summary><pre class="block" dir="auto">' + esc(r.block || '(nothing)') + '</pre></details></div>'
      }
    }
    d.innerHTML = h
    root.appendChild(d)
  }
}

document.getElementById('export').onclick = () => {
  const blob = new Blob([JSON.stringify({ chat: D.chat, made: D.made, marks }, null, 1)], { type: 'application/json' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'context-review-marks.json'; a.click()
}
document.getElementById('import').onchange = async ev => {
  const f = ev.target.files[0]; if (!f) return
  try { const j = JSON.parse(await f.text()); marks = j.marks || j; save(); renderQuestions(); renderScores() } catch (e) { alert('Could not read that file: ' + e) }
}
document.getElementById('theme').onclick = () => {
  const r = document.documentElement
  const dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  r.dataset.theme = dark ? 'light' : 'dark'
}
renderQuestions(); renderScores(); renderAppendix()
</script>
</body>
</html>
`
}

if (import.meta.main) {
  const [src, out] = process.argv.slice(2)
  if (!src || !out) { console.error('usage: bun context/review.ts <results.json> <review.html>'); process.exit(2) }
  const data = JSON.parse(readFileSync(src, 'utf8'))
  // Suggested marks from judge.ts, when there are some.
  const judgedFile = src.replace(/\.json$/, '') + '.judged.json'
  data.suggest = existsSync(judgedFile) ? JSON.parse(readFileSync(judgedFile, 'utf8')) : {}
  const html = reviewPage(data)
  writeFileSync(out, html)
  console.log(`[review] wrote ${out} (${Math.round(html.length / 1024)} KB)`)
}
