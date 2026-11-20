// live/call.ts — what a live call does with the words it hears. No I/O: the server
// feeds it Soniox's turns and acts on what it returns, so every rule is testable.
//
// The rules:
// - The first voice heard is the caller's, the only one whose words go to Claude.
//   Everyone else is shown and kept as background. A tap on any line makes that voice
//   the caller's (someone else spoke first), or sends that one line.
// - Holding the talk button counts whatever is said as the caller's.
// - The page hears its own answer through the speaker: words that are mostly in the
//   answer being read are dropped.
// - "stop" (or بس, وایسا…) alone stops whatever runs. Two new words of the caller's
//   over the answer stop the reading.
// - Speaker numbers mean something within one Soniox connection only: a new
//   connection forgets who "me" is.
import type { Turn } from './soniox'

export type Role = 'me' | 'other'
// How the call takes what the caller says (picked on the page). interactive: every request of
// the caller's goes to Claude. assistant: the caller is talking with people; only what they address to
// it by its name (or say holding the talk button) goes, the rest is background.
export type CallMode = 'interactive' | 'assistant'
export const CALL_MODES: CallMode[] = ['interactive', 'assistant']
// After its name alone ("Lucy?"), this long for the request.
export const ARMED_MS = 8000

// Where a wake word is in the text: what comes after it, or null when it isn't there.
// At the start: nothing before it but a filler or two ("so", "okay", «خب»…), so a
// name said in passing ("I told Lucy yesterday") is not a call. Or at the end of a
// sentence, set off by a comma ("Turn the mic off, Lucy."): then the request is the
// rest of the text, without the name; with no comma ("I told Lucy.") it is a mention.
// Whole words, any case; Arabic and Persian letter forms alike (ي/ی, ك/ک).
const FILLERS = new Set(['so', 'ok', 'okay', 'hey', 'hi', 'um', 'uh', 'erm', 'well', 'and', 'oh', 'right', 'yeah', 'خب', 'خوب', 'هی', 'ببین', 'آهان', 'اوکی', 'باشه', 'ام'])
const fold = (s: string) => s.toLowerCase().replace(/ي/g, 'ی').replace(/ك/g, 'ک')
export function callWord(text: string, wake: string[]): { rest: string; word: string } | null {
  const t = fold(text)
  for (const w of wake) {
    const ww = fold(w.trim())
    if (!ww) continue
    const esc = ww.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    const re = new RegExp(`(^|[^\\p{L}\\p{N}-])((?:hey|hi|ok|okay|هی)[\\s,،]+)?${esc}(?=$|[^\\p{L}\\p{N}-])`, 'iu')
    const m = re.exec(t)
    if (!m) continue
    const at = m.index + m[1].length, end = m.index + m[0].length
    // From the start of its sentence: a piece of speech can hold several.
    const lead = text.slice(0, at), cut = Math.max(...['.', '!', '?', '؟', '\n'].map(c => lead.lastIndexOf(c)))
    const before = fold(lead.slice(cut + 1)).match(/[\p{L}\p{N}]+/gu) ?? []
    if (before.length > 2 || before.some(w => !FILLERS.has(w))) continue
    const rest = text.slice(end).replace(/\s+/g, ' ').replace(/[\s,،]+([.!?؟])/g, '$1').replace(/^[\s,،.!?؟:;-]+|[\s,،:;-]+$/g, '').trim()
    return { rest: /[\p{L}\p{N}]/u.test(rest) ? rest : '', word: w.trim() }
  }
  for (const w of wake) {
    const ww = fold(w.trim())
    if (!ww) continue
    const esc = ww.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    const re = new RegExp(`[,،]\\s*(?:(?:hey|hi|ok|okay|هی)\\s+)?${esc}(?=\\s*(?:[.!?؟]|$))`, 'iu')
    const m = re.exec(t)
    if (!m) continue
    const before = text.slice(0, m.index).trim(), after = text.slice(m.index + m[0].length)
    if (!/[\p{L}\p{N}]/u.test(before)) continue   // ", Lucy." alone: the start rule's case
    const rest = (before + after).replace(/\s+/g, ' ').replace(/^[\s,،.!?؟:;-]+|[\s,،:;-]+$/g, '').trim()
    return { rest, word: w.trim() }
  }
  return null
}
// `given`: it already went along with a request, as context.
export type Line = { id: number; speaker: string | null; text: string; role: Role; at: number; language?: string | null; sent?: boolean; confidence?: number; unclear?: boolean; given?: boolean }

const STOP_PHRASES = new Set(['stop', 'stop it', 'stop everything', 'cancel', 'be quiet', 'quiet', 'shut up',
  'بس', 'بسه', 'وایسا', 'صبر کن', 'ساکت', 'ساکت شو', 'متوقف شو', 'لغو کن', 'کافیه'])
const INTERRUPT_STOP_WORDS = new Set(['stop', 'wait', 'cancel', 'بس', 'بسه', 'وایسا', 'صبر', 'ساکت'])
const INTERRUPT_WORDS = 2      // new words of the caller's over the answer that stop it
const ECHO_SHARE = 0.5         // share of heard word pairs found, in order, in the answer → it is the answer
const TALKED_OVER_MS = 8000    // the caller's words that stopped the answer are the caller's, not its echo, for this long
const ECHO_AFTER_MS = 2500     // the speaker's tail still reaches the mic this long after playback
const BACKGROUND_MS = 3 * 60_000
const MAX_LINES = 400

// A short line Soniox isn't sure of is most likely not speech: it can write "Yes." /
// "Yeah." for short blips of noise, at confidence 0.28–0.72, while real short replies
// score 0.98–1.00. Shown, not sent.
export function unclear(text: string, confidence: number | undefined): boolean {
  if (confidence === undefined) return false
  const n = words(text).length
  return (n <= 2 && confidence < 0.75) || (n <= 4 && confidence < 0.6)
}

export function words(text: string): string[] {
  return text.toLowerCase().normalize('NFKC')
    .replace(/[ً-ٰٟ]/g, '')                 // Arabic-script diacritics
    .replace(/[ي]/g, 'ی').replace(/[ك]/g, 'ک')            // Arabic → Persian letters
    .split(/[^\p{L}\p{N}']+/u).filter(Boolean)
}
export function isStopPhrase(text: string): boolean {
  // "stop, stop" is still a stop
  const ws = words(text).filter(w => w !== 'please' && w !== 'لطفا').filter((w, i, a) => w !== a[i - 1])
  return STOP_PHRASES.has(ws.join(' '))
}

// Words a finished sentence can't end on, even when Soniox gave it a full stop: what
// they lead into is still to come. Not pronouns or words English leaves at the end ("Can
// you check this?", "Turn it on.", "What are you looking at?"): in the recorded calls every
// wait on those (it, this, that, me, at, are) waited the full 6 s for nothing. Farsi
// object marker رو/را stays: its verb comes after it.
const DANGLING = new Set(['and', 'or', 'but', 'the', 'a', 'an', 'of', 'my', 'your', 'our', 'their', 'its', 'because', 'if', 'than',
  'uh', 'um', 'i', "i'm", "let's", 'into',
  'و', 'که', 'یا', 'با', 'به', 'از', 'در', 'برای', 'اما', 'ولی', 'اگه', 'اگر', 'یه', 'یک', 'رو', 'را', 'تا', 'اِم', 'ام'])
// Does this sound cut off? Soniox punctuates finished sentences, so no final
// punctuation, a trailing dash or comma, or a dangling last word means more is
// probably coming. A stand-in for a classifier that would judge it.
export function looksUnfinished(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/[—–\-,،:;]$/.test(t)) return true
  if (!/[.!?؟…]["'»)\]]*$/.test(t)) return true
  const last = words(t).at(-1)
  return !!last && DANGLING.has(last)
}

// After a piece of the caller's speech ends: send what the caller said, or wait for more.
// - force: the talk button was let go — send now.
// - stillTalking: the caller has started again — wait.
// - sounds unfinished: wait, but no longer than maxWaitMs since they started.
export function sendDecision(o: { text: string; waitedMs: number; stillTalking: boolean; force: boolean; maxWaitMs: number }): { send: boolean; why: string } {
  if (o.force) return { send: true, why: 'talk button let go' }
  if (o.stillTalking) return { send: false, why: "you're talking again, so the request waits until you stop" }
  if (looksUnfinished(o.text)) {
    if (o.waitedMs < o.maxWaitMs) return { send: false, why: `sounds unfinished, waiting for the rest (${(o.waitedMs / 1000).toFixed(1)} of ${o.maxWaitMs / 1000} s)` }
    return { send: true, why: `still sounds unfinished, but ${o.maxWaitMs / 1000} s have passed` }
  }
  return { send: true, why: 'sounds finished' }
}

export class CallState {
  main: string | null = null
  mode: CallMode = 'interactive'
  wake: string[] = ['Lucy']
  private armedUntil = 0
  private armedBy: string | null = null   // whose name-alone it waits on: null is the caller
  // Assistant mode: others in the room may call it by its name too (a setting).
  othersMayCall = false
  // Waiting for the request after its name, and the caller is talking: the wait lasts until they
  // stop (a request begun at 6 s used to be dropped when it ended past 8 s).
  keepArmed(): boolean {
    if (this.armedBy !== null || this.now() >= this.armedUntil) return false
    this.armedUntil = this.now() + ARMED_MS
    return true
  }
  lines: Line[] = []
  playing = false
  private echoWords = new Set<string>()
  private echoPairs = new Set<string>()     // consecutive word pairs of the answer
  private talkedOverAt = -Infinity
  private echoUntil = 0
  private nextId = 1

  constructor(private now: () => number = Date.now) {}

  // A new Soniox connection: its speaker numbers are new.
  reset(): void { this.main = null }
  setMain(speaker: string | null): void { this.main = speaker }
  line(id: number): Line | undefined { return this.lines.find(l => l.id === id) }

  // The answer being read: its words are what the mic will hear back.
  speaking(text: string): void {
    const ws = words(text)
    for (const w of ws) this.echoWords.add(w)
    for (let i = 0; i + 1 < ws.length; i++) this.echoPairs.add(ws[i] + ' ' + ws[i + 1])
    this.echoUntil = this.now() + ECHO_AFTER_MS
  }
  setPlaying(on: boolean): void {
    this.playing = on
    this.echoUntil = this.now() + ECHO_AFTER_MS
  }
  // A new answer starts: the old one's words are no longer what we hear.
  answerStarted(): void { this.echoWords.clear(); this.echoPairs.clear() }
  private echoWindow(): boolean { return this.playing || this.now() < this.echoUntil }
  // Is this the answer, heard back through the speaker? An echo is the answer's own
  // sentence, so its words come in the answer's order: judged on word pairs, not on
  // shared words — a reply reuses the answer's words ("What about a red one?" after
  // an answer about red ones) and was dropped as echo that way. A single
  // word is echo only if it is in the answer and Soniox wasn't sure of it.
  isEcho(text: string, confidence?: number): boolean {
    if (!this.echoWindow() || !this.echoWords.size) return false
    const heard = words(text)
    if (!heard.length) return false
    if (heard.length === 1) return this.echoWords.has(heard[0]) && (confidence === undefined || confidence < 0.9)
    let found = 0
    for (let i = 0; i + 1 < heard.length; i++) if (this.echoPairs.has(heard[i] + ' ' + heard[i + 1])) found++
    return found / (heard.length - 1) >= ECHO_SHARE
  }

  // A finished piece of speech. Returns the lines to show, what goes to Claude (the
  // caller's words), whether it was "stop", and what was dropped as the answer's own echo.
  // why: in assistant mode, what was made of the caller's words (for the trace).
  // assembling: a request of the caller's is being put together; what the caller says now is its rest.
  // armed: its name alone was heard; it now waits ARMED_MS for the request (the page shows it).
  // from / ids: a request someone else made by calling it (othersMayCall): who, and its lines.
  heard(turns: Turn[], o: { held?: boolean; busy?: boolean; assembling?: boolean } = {}): { lines: Line[]; send: string | null; stop: boolean; echo: Turn[]; why?: string; armed?: boolean; from?: string; ids?: number[] } {
    const echo: Turn[] = [], lines: Line[] = []
    for (const t of turns) {
      if (!t.text.trim()) continue
      // The caller's words that already stopped the answer are the caller's, not its echo.
      const talkedOver = t.speaker !== null && t.speaker === this.main && this.now() - this.talkedOverAt < TALKED_OVER_MS
      if (!talkedOver && this.isEcho(t.text, t.confidence)) { echo.push(t); continue }
      const vague = unclear(t.text, t.confidence)
      // The first voice is the caller — but not while the answer plays (that is most likely
      // the answer itself, misheard), and not from a line that may be noise.
      if (this.main === null && t.speaker !== null && t.speaker !== '0' && !this.echoWindow() && !vague) this.main = t.speaker
      const role: Role = o.held || t.speaker === null || t.speaker === this.main ? 'me' : 'other'
      const l: Line = { id: this.nextId++, speaker: t.speaker, text: t.text.trim(), role, at: this.now(), language: t.language, confidence: t.confidence }
      if (vague) l.unclear = true
      lines.push(l)
    }
    this.lines.push(...lines)
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES)
    const mine = lines.filter(l => l.role === 'me')
    // Someone else calling it, in assistant mode when they may: the same rules as the caller's.
    const fromOthers = () => {
      if (this.mode !== 'assistant' || !this.othersMayCall || o.held) return null
      for (const l of lines) {
        if (l.role !== 'other' || l.unclear || l.speaker === null) continue
        const c = callWord(l.text, this.wake), who = `speaker ${l.speaker}`
        if (c?.rest && isStopPhrase(c.rest)) { this.armedUntil = 0; return { lines, send: null, stop: true, echo, why: `assistant: ${who} told it to stop by name ("${c.word}")` } }
        if (c?.rest) { this.armedUntil = 0; return { lines, send: c.rest, stop: false, echo, from: l.speaker, ids: [l.id], why: `assistant: called by name by ${who} ("${c.word}")` } }
        if (c) { this.armedBy = l.speaker; this.armedUntil = this.now() + ARMED_MS; return { lines, send: null, stop: false, echo, armed: true, why: `assistant: ${who} called it by name ("${c.word}"), waiting ${ARMED_MS / 1000} s for the request` } }
        if (this.armedBy === l.speaker && this.now() < this.armedUntil) { this.armedUntil = 0; return { lines, send: l.text, stop: false, echo, from: l.speaker, ids: [l.id], why: `assistant: ${who}'s request after its name` } }
      }
      return null
    }
    if (!mine.length) return fromOthers() ?? { lines, send: null, stop: false, echo }
    // "stop" counts even when unclear: stopping by mistake costs little
    // In assistant mode only while there is something to stop: said to someone in the
    // room, it is not for it.
    if (isStopPhrase(mine.map(l => l.text).join(' ')) && (this.mode === 'interactive' || o.busy || this.playing)) return { lines, send: null, stop: true, echo }
    const clear = mine.filter(l => !l.unclear)
    if (!clear.length) return { lines, send: null, stop: false, echo }
    const text = clear.map(l => l.text).join(' ')
    if (this.mode === 'interactive') return { lines, send: text, stop: false, echo }
    // Assistant: only what is addressed to it. Not addressed, the caller's words stay with the
    // others' as background for the next request.
    if (o.held) return { lines, send: text, stop: false, echo, why: 'assistant: said with the talk button held' }
    const called = callWord(text, this.wake)
    if (called?.rest && isStopPhrase(called.rest)) { this.armedUntil = 0; return { lines, send: null, stop: true, echo, why: `assistant: told to stop by name ("${called.word}")` } }
    if (called?.rest) { this.armedUntil = 0; return { lines, send: called.rest, stop: false, echo, why: `assistant: called by name ("${called.word}")` } }
    if (called) { this.armedBy = null; this.armedUntil = this.now() + ARMED_MS; return { lines, send: null, stop: false, echo, armed: true, why: `assistant: called by name ("${called.word}"), waiting ${ARMED_MS / 1000} s for the request` } }
    if (this.armedBy === null && this.now() < this.armedUntil) { this.armedUntil = 0; return { lines, send: text, stop: false, echo, why: 'assistant: the request after its name' } }
    if (o.assembling) return { lines, send: text, stop: false, echo, why: 'assistant: the rest of the request' }
    return fromOthers() ?? { lines, send: null, stop: false, echo, why: 'assistant: not called, kept as background' }
  }

  // Words still being recognised: should the answer being read stop?
  shouldHush(live: Turn[]): boolean {
    if (!this.playing || this.main === null) return false
    for (const t of live) {
      if (t.speaker !== this.main || unclear(t.text, t.confidence)) continue
      const fresh = words(t.text).filter(w => !this.echoWords.has(w))
      if (fresh.length >= INTERRUPT_WORDS || fresh.some(w => INTERRUPT_STOP_WORDS.has(w))) { this.talkedOverAt = this.now(); return true }
    }
    return false
  }

  // The talk since the last request (within 3 minutes) that Claude has not had, for
  // the next one, in the order it was said: what others nearby said, and what the
  // caller said that was never sent, which is what a voice picked as the caller's
  // after the fact leaves (a request heard as another speaker, then "This is me",
  // then "do that"). Labelled as the lines are now.
  // Each line is given once; unclear ones (noise) never.
  // `waiting`: the caller's lines held to be sent as a request of their own; not context.
  background(waiting: Iterable<number> = []): string {
    const since = this.now() - BACKGROUND_MS, held = new Set(waiting)
    const missed = this.lines.filter(l => l.at >= since && !l.sent && !l.given && !l.unclear && !held.has(l.id))
    for (const l of missed) l.given = true
    if (!missed.length) return ''
    return missed.map(l => `${l.role === 'me' ? 'you' : `speaker ${l.speaker ?? '?'}`}: ${l.text}`).join('\n')
  }
}

// The text Claude gets for one request.
export function requestText(said: string, background: string): string {
  if (!background) return said
  return `${said}\n\n[Background, not a request in itself: what was said on the call in the last few minutes and not yet sent to you, in order. ` +
    `"you" is the caller (words heard before their voice was known as theirs); speaker numbers tell other people apart. It may or may not be relevant.]\n${background}`
}
