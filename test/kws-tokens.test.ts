// The wake phrase as the phone's keyword spotter's tokens: the same as sentencepiece's
// own encoding (the reference pieces below are from sentencepiece, over the model's
// bpe.model; 1706 of 1706 matched when this was written).
import { test, expect } from 'bun:test'
import { kwsTokens, kwsKeywords, kwsText } from '../live/kws-tokens'
import vocab from '../live/kws-vocab.json'

const REF: Record<string, string[]> = {
"HEY LUCY": [
"▁HE",
"Y",
"▁",
"LU",
"C",
"Y"
],
"HEY JARVIS": [
"▁HE",
"Y",
"▁JA",
"R",
"VI",
"S"
],
"HEY NOVA": [
"▁HE",
"Y",
"▁NO",
"V",
"A"
],
"HEY LUNA": [
"▁HE",
"Y",
"▁",
"LU",
"N",
"A"
],
"HEY SARA": [
"▁HE",
"Y",
"▁SA",
"RA"
],
"HEY HANNA": [
"▁HE",
"Y",
"▁HA",
"N",
"N",
"A"
],
"HEY NIMA": [
"▁HE",
"Y",
"▁",
"N",
"IM",
"A"
],
"OK NOVA": [
"▁O",
"K",
"▁NO",
"V",
"A"
],
"LUCY": [
"▁",
"LU",
"C",
"Y"
],
"HEY XESIOUS": [
"▁HE",
"Y",
"▁",
"X",
"ES",
"IOUS"
],
"STUCK": [
"▁ST",
"U",
"CK"
],
"SOFT": [
"▁SO",
"F",
"T"
],
"AVATAR": [
"▁A",
"V",
"AT",
"AR"
],
"EITHER": [
"▁E",
"I",
"THER"
],
"CAVEATS": [
"▁CA",
"VE",
"AT",
"S"
],
"MINOR": [
"▁MIN",
"OR"
],
"SLOWED": [
"▁S",
"LO",
"W",
"ED"
],
"LIMITS": [
"▁LI",
"M",
"IT",
"S"
],
"MAJORS": [
"▁MA",
"J",
"OR",
"S"
],
"REBOOTS": [
"▁RE",
"B",
"O",
"O",
"T",
"S"
],
"HOWEVER": [
"▁HOW",
"E",
"VER"
],
"STATS": [
"▁STA",
"T",
"S"
],
"DEPLOYS": [
"▁DE",
"P",
"LO",
"Y",
"S"
],
"BRING": [
"▁B",
"R",
"ING"
],
"MENTIONED": [
"▁ME",
"N",
"TION",
"ED"
],
"AMEND": [
"▁A",
"M",
"END"
],
"UPDATE": [
"▁UP",
"D",
"ATE"
],
"THERE": [
"▁THERE"
],
"IMPORTANT": [
"▁IMPORTANT"
],
"LACKS": [
"▁LA",
"CK",
"S"
],
"PREFS": [
"▁PRE",
"F",
"S"
],
"SNAPSHOT": [
"▁S",
"N",
"A",
"P",
"S",
"HO",
"T"
],
"SOMEWHERE": [
"▁SOME",
"W",
"HE",
"RE"
],
"ABSENT": [
"▁A",
"B",
"S",
"ENT"
],
"RETIRED": [
"▁RE",
"T",
"IR",
"ED"
],
"LIB": [
"▁LI",
"B"
],
"ENTITY": [
"▁",
"ENT",
"ITY"
],
"SCREEN": [
"▁S",
"C",
"RE",
"EN"
],
"STT": [
"▁ST",
"T"
],
"DISCUSSED": [
"▁DIS",
"C",
"US",
"S",
"ED"
]
}

test('the pieces are sentencepiece\'s own', () => {
  for (const [p, want] of Object.entries(REF)) expect([p, kwsTokens(p, vocab)]).toEqual([p, want])
})

test('only what the English model can spell', () => {
  expect(kwsText('  hey,  Lucy! ')).toBe('HEY LUCY')
  expect(kwsText('لوسی')).toBeNull()
  expect(kwsText('R2D2')).toBeNull()
  expect(kwsTokens('لوسی', vocab)).toBeNull()
})

test('the keywords: "hey" before each wake word it can spell, once each', () => {
  const k = kwsKeywords(['Lucy', 'لوسی', 'hey lucy', 'OK Nova'], vocab)
  expect(k.text).toBe('HEY LUCY, OK NOVA')
  expect(k.keywords).toBe('▁HE Y ▁ LU C Y @HEY_LUCY\n▁O K ▁NO V A @OK_NOVA')
  expect(kwsKeywords(['لوسی'], vocab)).toEqual({ text: '', keywords: '' })
})
