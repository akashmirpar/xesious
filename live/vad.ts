// live/vad.ts — is anyone speaking right now? Measured on the audio itself.
//
// The first version ended a piece of speech when Soniox had written out no new word
// for 1.3 s. But Soniox writes words out up to a second after it hears them, so
// mid-sentence it looked like silence and the sentence was cut, even half a second
// into one unbroken stretch of speech. So silence is judged on the sound: the loudness of each
// 100 ms chunk against the room's noise floor.
//
// The page sends audio with the browser's noise suppression on (and echo
// cancellation in call mode), so between words it is near zero (single digits in
// 16-bit RMS) and speech is in the hundreds to thousands. The floor adapts in case a
// mic is noisier.

export function rms(pcm: Uint8Array): number {
  const n = Math.floor(pcm.byteLength / 2)
  if (!n) return 0
  const v = new DataView(pcm.buffer, pcm.byteOffset, n * 2)
  let sq = 0
  for (let i = 0; i < n; i++) { const s = v.getInt16(i * 2, true); sq += s * s }
  return Math.sqrt(sq / n)
}

export class Vad {
  private floor = 30           // the room's noise level, learned
  private audioMs = 0
  private lastVoice = -Infinity
  private voiced = 0           // consecutive voiced chunks
  constructor(private minSpeech = 250, private hangMs = 150) {}

  // One chunk of 16 kHz mono 16-bit PCM. Returns whether it is speech.
  push(pcm: Uint8Array): boolean {
    const ms = pcm.byteLength / 32
    const level = rms(pcm)
    this.audioMs += ms
    const speech = level > Math.max(this.minSpeech, this.floor * 4)
    if (!speech) this.floor = this.floor * 0.95 + Math.min(level, this.minSpeech) * 0.05
    if (speech) { this.voiced++; this.lastVoice = this.audioMs } else this.voiced = 0
    return speech
  }
  // How long it has been quiet, in audio ms (Infinity before anyone spoke).
  quietMs(): number { return this.audioMs - this.lastVoice - this.hangMs }
  speaking(): boolean { return this.quietMs() < 0 || this.voiced > 0 }
  get position(): number { return this.audioMs }
  get noiseFloor(): number { return this.floor }
}
