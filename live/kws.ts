// What the phone's wake-word spotter (Vosk in the browser, see live/kws-setup.sh)
// listens for while the mic is off: "hey <word>" for each wake word in Latin letters,
// as a Vosk grammar. A two-word phrase wakes by mistake far less than a name alone (0
// false wakes in 3.3 h of real calls, against ~8 for "Lucy"); words the model doesn't
// know are dropped by Vosk itself. Farsi wake words have no English model to hear them.
export function kwsPhrases(wake: string[]): string[] {
  const out: string[] = []
  for (const w of wake) {
    const t = w.trim().replace(/[\s,،.!?]+/g, ' ').trim().toLowerCase()
    if (!/^[a-z' ]+$/.test(t) || !/[a-z]/.test(t)) continue
    const p = /^(hey|hi|ok|okay) /.test(t) ? t : `hey ${t}`
    if (!out.includes(p)) out.push(p)
  }
  return out
}
