import fs from 'node:fs'

const SR = 48000
const DUR = 24.0
const N = Math.floor(SR * DUR)
const L = new Float32Array(N)
const R = new Float32Array(N)

const CUTS = [0, 4.2, 7.2, 11.4, 14.4, 18.8]
const CHORDS = [
  [220.0, 261.63, 329.63, 493.88],
  [174.61, 220.0, 261.63, 349.23],
  [261.63, 329.63, 392.0, 493.88],
  [196.0, 246.94, 293.66, 392.0],
  [220.0, 261.63, 329.63, 440.0],
  [146.83, 220.0, 293.66, 440.0],
]

const place = (index, value, width = 0) => {
  if (index < 0 || index >= N) return
  L[index] += value * (1 - width)
  R[index] += value * (1 + width)
}

// A warm pad: fundamental plus a quiet odd harmonic, which reads as "string-ish" without
// the buzz of a full saw. Two detunings per note give width; nothing is above 2 kHz.
for (let c = 0; c < CUTS.length; c += 1) {
  const start = Math.floor(CUTS[c] * SR)
  const end = Math.floor((CUTS[c + 1] ?? DUR) * SR)
  const notes = CHORDS[c % CHORDS.length]
  const len = end - start
  const attack = Math.floor(SR * 1.1)
  const release = Math.floor(SR * 1.8)

  for (const [i, freq] of notes.entries()) {
    for (const side of [-1, 1]) {
      const detune = 1 + side * 0.0018
      const phase0 = side === -1 ? 0 : Math.PI * 0.35
      for (let n = 0; n < len; n += 1) {
        const t = n / SR
        const env = Math.min(1, n / attack) * Math.min(1, (len - n) / release)
        const drift = 1 + 0.0009 * Math.sin(2 * Math.PI * 0.13 * t + i)
        const phase = 2 * Math.PI * freq * detune * drift * t + phase0
        const value = (Math.sin(phase) + 0.18 * Math.sin(phase * 3)) * env * 0.05
        place(start + n, value, side * 0.22)
      }
    }
  }

  // Sub: root an octave down, no harmonics.
  const root = notes[0] / 2
  for (let n = 0; n < len; n += 1) {
    const t = n / SR
    const env = Math.min(1, n / Math.floor(SR * 0.4)) * Math.min(1, (len - n) / Math.floor(SR * 1.0))
    place(start + n, Math.sin(2 * Math.PI * root * t) * env * 0.12)
  }

  // Bell on the cut: pure sine plus a quieter fifth, long exponential decay.
  const bell = notes[2] * 2
  const bellLen = Math.min(len, Math.floor(SR * 2.4))
  for (let n = 0; n < bellLen; n += 1) {
    const t = n / SR
    const env = Math.exp(-t * 1.9) * Math.min(1, n / 200)
    const value = (Math.sin(2 * Math.PI * bell * t) + 0.3 * Math.sin(2 * Math.PI * bell * 1.5 * t)) * env * 0.06
    place(start + n, value, 0.25)
  }
}

// Air: one-pole filtered noise, slowly breathing, at the edge of audibility.
let lowL = 0
let lowR = 0
for (let n = 0; n < N; n += 1) {
  const t = n / SR
  const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.07 * t)
  lowL += ((Math.random() * 2 - 1) - lowL) * 0.018
  lowR += ((Math.random() * 2 - 1) - lowR) * 0.018
  place(n, lowL * 0.010 * swell, 0.3)
  place(n, lowR * 0.010 * swell, -0.3)
}

// Reverb: two combs per channel plus one allpass, enough to sit the notes in a room.
const comb = (channel, delayMs, feedback) => {
  const delay = Math.floor((delayMs / 1000) * SR)
  for (let n = delay; n < channel.length; n += 1) channel[n] += channel[n - delay] * feedback
}
comb(L, 71, 0.45); comb(R, 79, 0.45)
comb(L, 151, 0.28); comb(R, 163, 0.28)

const fadeIn = Math.floor(SR * 1.4)
const fadeOut = Math.floor(SR * 3.2)
const soft = (x) => Math.tanh(x * 1.4) / 1.4
let peak = 0
for (let n = 0; n < N; n += 1) {
  const env = Math.min(1, n / fadeIn) * Math.min(1, (N - n) / fadeOut)
  L[n] = soft(L[n] * env)
  R[n] = soft(R[n] * env)
  peak = Math.max(peak, Math.abs(L[n]), Math.abs(R[n]))
}
const gain = peak > 0 ? 0.5 / peak : 1

const buffer = Buffer.alloc(44 + N * 4)
buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + N * 4, 4); buffer.write('WAVE', 8)
buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20)
buffer.writeUInt16LE(2, 22); buffer.writeUInt32LE(SR, 24); buffer.writeUInt32LE(SR * 4, 28)
buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36)
buffer.writeUInt32LE(N * 4, 40)
for (let n = 0; n < N; n += 1) {
  buffer.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(L[n] * gain * 32767))), 44 + n * 4)
  buffer.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(R[n] * gain * 32767))), 46 + n * 4)
}
fs.writeFileSync(process.argv[2] ?? '/tmp/music/bed2.wav', buffer)
console.log('wrote bed2, peak ' + peak.toFixed(3))
