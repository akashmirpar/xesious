// An answer streams in as text; it is spoken a sentence at a time. A sentence ends at
// . ! ? … ؟ (with any closing quotes or brackets) followed by a space or a line break —
// never at a point inside a number ("3.6 GB", "v1.2"), a path or an address. The end of
// what has come so far is not a sentence end yet: the next piece may carry on ("3." then
// "6 GB"). Whatever is left when the answer is complete is spoken as it is.
export function drainSentences(buf: string): { done: string[]; rest: string } {
  const done: string[] = []
  const re = /[\s\S]*?[.!?…؟]+["'”’»)\]]*(?=\s)\s+/g
  let m: RegExpExecArray | null, last = 0
  while ((m = re.exec(buf))) { const s = m[0].trim(); if (s) done.push(s); last = re.lastIndex }
  return { done, rest: buf.slice(last) }
}
