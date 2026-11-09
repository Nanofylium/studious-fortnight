// "Voz DNA": the long-term average spectrum of a reference voice (a dry
// acapella the user likes) is matched onto our vocal with a linear-phase FIR.
// Only the broad shape moves: both spectra are smoothed over an octave, the
// correction is level-neutral, capped, applied at a fraction, and cuts above
// 6 kHz are held to -2 dB so a lossy reference cannot dull the clarity.
import { fftInPlace } from '../dsp.js';
import { fftConvolve } from '../reference.js';
import { monoOf, rms } from './filters.js';

const N = 8192;

// Mean power spectrum of the frames above the 35th energy percentile (so
// pauses and breaths do not tilt it).
export function ltas(channels, n = N) {
  const m = monoOf(channels);
  const hop = n / 4;
  const w = Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const frames = [];
  const energies = [];
  for (let s = 0; s + n < m.length; s += hop) {
    for (let i = 0; i < n; i++) {
      re[i] = m[s + i] * w[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    const p = new Float32Array(n / 2 + 1);
    let e = 0;
    for (let k = 0; k <= n / 2; k++) {
      p[k] = re[k] ** 2 + im[k] ** 2;
      e += p[k];
    }
    frames.push(p);
    energies.push(e);
  }
  if (!frames.length) throw new Error('áudio de referência curto demais');
  const sorted = [...energies].sort((a, b) => a - b);
  const thr = sorted[Math.floor(sorted.length * 0.35)];
  const out = new Float64Array(n / 2 + 1);
  let cnt = 0;
  frames.forEach((p, i) => {
    if (energies[i] > thr || frames.length < 3) {
      for (let k = 0; k < p.length; k++) out[k] += p[k];
      cnt++;
    }
  });
  return Float32Array.from(out, (v) => v / Math.max(1, cnt));
}

function smoothOctave(p, binHz, frac = 1) {
  const pre = new Float64Array(p.length + 1);
  for (let k = 0; k < p.length; k++) pre[k + 1] = pre[k] + p[k];
  const out = new Float64Array(p.length);
  for (let k = 0; k < p.length; k++) {
    const fc = k * binHz;
    const lo = Math.max(0, Math.ceil((fc * 2 ** (-frac / 2)) / binHz));
    const hi = Math.min(p.length - 1, Math.floor((fc * 2 ** (frac / 2)) / binHz));
    out[k] = hi >= lo ? (pre[hi + 1] - pre[lo]) / (hi - lo + 1) : p[k];
  }
  return out;
}

// Correction in dB per FFT bin (length N/2+1).
export function voiceMatchCurve(refLtas, ourLtas, sr, { strength = 0.75, limitDb = 6 } = {}) {
  const binHz = sr / N;
  const a = smoothOctave(refLtas, binHz);
  const b = smoothOctave(ourLtas, binHz);
  const d = new Float64Array(a.length);
  for (let k = 0; k < d.length; k++) d[k] = 10 * Math.log10(a[k] + 1e-20) - 10 * Math.log10(b[k] + 1e-20);
  let sw = 0, s = 0;
  for (let k = 1; k < d.length; k++) {
    const f = k * binHz;
    if (f >= 80 && f <= 12000) {
      sw += 1 / f;
      s += d[k] / f;
    }
  }
  const mean = sw ? s / sw : 0;
  for (let k = 0; k < d.length; k++) {
    const f = k * binHz;
    let v = Math.max(-limitDb, Math.min(limitDb, d[k] - mean)) * strength;
    if (f > 6000) v = Math.max(v, -2);
    const fade = Math.min(1, Math.max(0, (f - 30) / 30)) * Math.min(1, Math.max(0, (16000 - f) / 2000));
    d[k] = v * fade;
  }
  return d;
}

// Linear-phase FIR from a dB curve on the N/2+1 grid.
export function linearPhaseFir(curveDb) {
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let k = 0; k <= N / 2; k++) {
    const g = 10 ** (curveDb[k] / 20);
    re[k] = g;
    if (k > 0 && k < N / 2) re[N - k] = g;
  }
  fftInPlace(re, im); // real, even spectrum: forward = inverse up to 1/N
  const h = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const j = (i + N / 2) % N;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    h[i] = (re[j] / N) * w;
  }
  return h;
}

export function applyVoiceMatch(channels, sr, refLtas, opts = {}) {
  const curve = voiceMatchCurve(refLtas, ltas(channels), sr, opts);
  const h = linearPhaseFir(curve);
  const len = channels[0].length;
  const out = channels.map((c) => {
    const padded = new Float32Array(len + N / 2);
    padded.set(c);
    return fftConvolve(padded, h).slice(N / 2, N / 2 + len);
  });
  const g = rms(channels[0]) / (rms(out[0]) + 1e-12);
  for (const c of out) for (let i = 0; i < c.length; i++) c[i] *= g;
  const at = (hz) => Math.round(curve[Math.round((hz * N) / sr)] * 10) / 10;
  return { channels: out, curve: { 80: at(80), 150: at(150), 250: at(250), 400: at(400), 1000: at(1000), 3000: at(3000), 5000: at(5000), 8000: at(8000) } };
}
