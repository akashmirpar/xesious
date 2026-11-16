// Tier 3's stand-in for the live page: opens a call on the live server, types what
// it is given (as the page's text box does), and prints every message the server
// sends, one JSON per line, until it hangs up.
//
//   bun test/staging/live_call.ts <port> <link-uuid> <seconds> <text>...
//
// Each <text> is sent after the previous request's answer has finished. It hangs up
// after <seconds>, or once a notice has come in and been answered; with
// LIVE_CALL_UNTIL=answered, once the last request's answer has finished.
// LIVE_CALL_VIEW=<topic id>: that topic is open on the page.
// LIVE_CALL_ALLOW=1: with that topic open, what waits there is answered from the page
// (a permission allowed, each question's second option); LIVE_CALL_EXPECT=<word>: it hangs up once the topic's messages hold an
// answer from the bot with that word.
// LIVE_CALL_TYPE=<text>: typed into that open topic instead; it hangs up once the
// topic's messages, as the page gets them, hold an answer from the bot.
const [port, uuid, secs, ...texts] = process.argv.slice(2)
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
const say = (o: unknown) => console.log(JSON.stringify(o))
let queue = [...texts], noticeReq = 0, noticeSeen = false, typedOk = false, allowed = false
const started = Date.now()
const next = () => { const t = queue.shift(); if (t) ws.send(JSON.stringify({ type: 'text', text: t })) }
ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', uuid, device: 'staging-live-check-device-0001', agent: 'tier3' }))
ws.onmessage = e => {
  if (typeof e.data !== 'string') return
  const m = JSON.parse(e.data)
  say(m)
  // LIVE_CALL_VIEW: the topic open on the page (an id, or General) before asking.
  if (m.type === 'ready' && process.env.LIVE_CALL_VIEW) { const v = process.env.LIVE_CALL_VIEW; ws.send(JSON.stringify({ type: 'view', topic: /^\d+$/.test(v) ? Number(v) : v })) }
  if (m.type === 'ready' && process.env.LIVE_CALL_TYPE) { const v = process.env.LIVE_CALL_VIEW!; ws.send(JSON.stringify({ type: 'type', topic: /^\d+$/.test(v) ? Number(v) : v, text: process.env.LIVE_CALL_TYPE })); return }
  if (m.type === 'typed') typedOk = m.ok
  if (process.env.LIVE_CALL_ALLOW && m.type === 'ready') { const v = process.env.LIVE_CALL_VIEW!; ws.send(JSON.stringify({ type: 'view', topic: /^\d+$/.test(v) ? Number(v) : v })); return }
  if (process.env.LIVE_CALL_ALLOW && m.type === 'topics' && !allowed) {
    const w = (m.topics ?? []).find((t: any) => String(t.id) === process.env.LIVE_CALL_VIEW)?.waits?.[0]
    // A permission: allowed. Questions: the second option of each.
    if (w) { allowed = true; ws.send(JSON.stringify({ type: 'answer', id: w.id, ...(w.kind === 'permission' ? { allow: true } : w.kind === 'plan' ? { go: true } : { answers: (w.questions ?? []).map(() => 2) }) })) }
  }
  if (process.env.LIVE_CALL_EXPECT && m.type === 'messages' && (m.messages ?? []).some((x: any) => x.bot && String(x.text).includes(process.env.LIVE_CALL_EXPECT!))) { ws.close(); return }
  if (m.type === 'messages' && typedOk && (m.messages ?? []).some((x: any) => x.bot && x.t * 1000 >= started - 5000)) { ws.close(); return }
  if (m.type === 'ready') next()
  if (m.type === 'notice') noticeSeen = true
  if (m.type === 'working' && String(m.said ?? '').startsWith('🔔')) noticeReq = m.req
  if (m.type === 'turn_end') {
    if (noticeReq && m.req === noticeReq) { ws.close(); return }
    if (!queue.length && process.env.LIVE_CALL_UNTIL === 'answered') { ws.close(); return }
    next()
  }
  if (['denied', 'expired', 'other_device'].includes(m.type)) ws.close()
}
ws.onclose = () => { say({ type: 'hung_up', noticeSeen }); process.exit(0) }
setTimeout(() => ws.close(), Number(secs) * 1000)
