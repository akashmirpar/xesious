// The wake phrase for the phone's keyword spotter (sherpa-onnx KWS, run on the page
// while the mic is off), as the model's tokens. The spotter takes a keyword as the
// pieces of its sentencepiece vocabulary ("▁HE Y ▁ LU C Y"); sherpa-onnx turns text
// into those only in Python (text2token), so this is that encoding (a unigram model:
// the split whose pieces score highest). Checked against sentencepiece itself
// (test/kws-tokens.test.ts).

export type Vocab = Record<string, number>   // piece → score

// "Hey Lucy, what…" → "HEY LUCY": the letters and spaces the English model knows.
// Null for a phrase it can't spell (another script, digits).
export function kwsText(phrase: string): string | null {
  const t = phrase.trim().replace(/[\s,،.!?]+/g, ' ').trim().toUpperCase()
  return /^[A-Z' ]+$/.test(t) && /[A-Z]/.test(t) ? t : null
}

export function kwsTokens(phrase: string, vocab: Vocab): string[] | null {
  const text = kwsText(phrase)
  if (!text) return null
  // The whole phrase, each word marked with ▁, split into the pieces whose scores
  // (log-probabilities) add up highest: sentencepiece's unigram model, by Viterbi.
  const s = text.split(' ').map(w => '▁' + w).join('')
  const best: number[] = [0], back: number[] = [0]
  for (let end = 1; end <= s.length; end++) {
    best[end] = -Infinity
    for (let start = Math.max(0, end - 16); start < end; start++) {
      const sc = vocab[s.slice(start, end)]
      if (sc === undefined || best[start] === -Infinity || s.slice(start, end).startsWith('<')) continue
      if (best[start] + sc > best[end]) { best[end] = best[start] + sc; back[end] = start }
    }
  }
  if (best[s.length] === -Infinity) return null
  const out: string[] = []
  for (let end = s.length; end > 0; end = back[end]) out.unshift(s.slice(back[end], end))
  return out
}

// The spotter's keywords from the call's wake words: "HEY <word>" for each one the
// English model can spell (a two-word phrase wakes by mistake far less than a name
// alone: 0 false wakes in 3.3 h of real calls, against ~8 for "Lucy"), each line
// "<tokens> @<label>". A wake word that already starts with hey/hi/ok is kept as it is.
export function kwsKeywords(wake: string[], vocab: Vocab): { text: string; keywords: string } {
  const phrases: string[] = []
  for (const w of wake) {
    const t = kwsText(w)
    if (!t) continue
    const p = /^(HEY|HI|OK|OKAY) /.test(t) ? t : `HEY ${t}`
    if (!phrases.includes(p)) phrases.push(p)
  }
  const lines = phrases.flatMap(p => { const tk = kwsTokens(p, vocab); return tk ? [`${tk.join(' ')} @${p.replace(/ /g, '_')}`] : [] })
  return { text: phrases.join(', '), keywords: lines.join('\n') }
}
