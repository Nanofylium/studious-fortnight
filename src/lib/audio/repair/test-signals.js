// Synthetic test material shared by the repair tests. Every defect a test
// plants goes into one of these at a known place.
import { fftInPlace } from '../dsp.js';

export const SR = 44100;

export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function makeBuffer(channels) {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate: SR,
    getChannelData: (c) => channels[c],
  };
}

// Notes that change every half second, each with a decaying harmonic series
// (5 ms attack, 15 ms release, so the note changes themselves are smooth),
// a soft noise "hi-hat" on every beat and a little broadband noise underneath.
export function song(seconds, seed = 7) {
  const r = rng(seed);
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  const notes = [220, 247, 262, 294, 330, 349, 392, 440];
  const noteLen = Math.round(0.5 * SR);
  for (let start = 0; start < n; start += noteLen) {
    const f0 = notes[Math.floor(r() * notes.length)] * (r() < 0.5 ? 1 : 2);
    const end = Math.min(n, start + noteLen);
    for (let h = 1; h <= 12; h++) {
      const f = f0 * h;
      if (f > 9000) break;
      const amp = 0.12 / h;
      const ph = r() * 2 * Math.PI;
      for (let i = start; i < end; i++) {
        const t = (i - start) / SR;
        const env = Math.min(1, t / 0.005, (end - i) / (0.015 * SR)) * Math.exp(-t * 2.5);
        x[i] += amp * env * Math.sin(2 * Math.PI * f * t + ph);
      }
    }
    // Hi-hat: 1 ms attack ramp, 60 ms decay.
    for (let i = start; i < Math.min(end, start + Math.round(0.08 * SR)); i++) {
      const t = (i - start) / SR;
      const env = Math.min(1, t / 0.001) * Math.exp(-t / 0.02);
      x[i] += 0.05 * env * (r() * 2 - 1);
    }
  }
  for (let i = 0; i < n; i++) x[i] += 0.003 * (r() * 2 - 1);
  return x;
}

export function noise(n, seed = 3) {
  const r = rng(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.2 * (r() * 2 - 1);
  return x;
}

// Brick-wall low-pass by zeroing FFT bins, the way a codec or a band-limited
// generator leaves the top of the spectrum.
export function brickwall(x, cutoffHz) {
  const n = 1 << Math.ceil(Math.log2(x.length));
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  re.set(x);
  fftInPlace(re, im);
  const kc = Math.round((cutoffHz / SR) * n);
  for (let k = kc; k <= n - kc; k++) {
    re[k] = 0;
    im[k] = 0;
  }
  for (let k = 0; k < n; k++) im[k] = -im[k];
  fftInPlace(re, im);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = re[i] / n;
  return out;
}

