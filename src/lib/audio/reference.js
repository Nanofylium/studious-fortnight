// Reference mastering: make the mix sit like a finished record the user picks.
// The approach follows Matchering's idea (reimplemented here, no code from it):
// compare the long-term spectrum of the mix with the reference's over their
// loudest passages, turn the difference into a smooth EQ curve, and let the
// existing loudness loop and limiter match the level. Stereo width is matched
// separately through the side/mid energy ratio.
// Pure functions, no Web Audio dependency.
import { fftInPlace, clamp } from './dsp.js';

const FFT = 4096;

// 1/6-octave bands from 20 Hz to 20 kHz.
export const BANDS = (() => {
  const out = [];
  for (let f = 20; f <= 20000 * 1.0001; f *= Math.pow(2, 1 / 6)) out.push(f);
  return out;
})();

let hannCache = null;
function hann() {
  if (!hannCache) {
    hannCache = new Float32Array(FFT);
    for (let i = 0; i < FFT; i++) hannCache[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT - 1));
  }
  return hannCache;
}

// Long-term spectrum of the mid signal in BANDS (dB, shape only) plus the
// side/mid energy ratio, both over the loudest half of the frames so intros,
// breaks and fades do not skew the picture.
export function spectralProfile(buffer, { maxFrames = 400 } = {}) {
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const n = buffer.length;
  const sr = buffer.sampleRate;
  const half = FFT / 2;
  const available = Math.max(1, Math.floor((n - FFT) / (FFT / 2)));
  const count = Math.min(maxFrames, available);
  const w = hann();

  const starts = [];
  const energy = [];
  for (let f = 0; f < count; f++) {
    const start = Math.floor(((n - FFT) * (f + 0.5)) / count);
    if (start < 0) break;
    let e = 0;
    for (let i = 0; i < FFT; i += 4) {
      const m = L[start + i] + R[start + i];
      e += m * m;
    }
    starts.push(start);
    energy.push(e);
  }
  const sorted = [...energy].sort((a, b) => b - a);
  const gate = sorted[Math.max(0, Math.floor(sorted.length / 2) - 1)] ?? 0;

  const pow = new Float64Array(half);
  const re = new Float32Array(FFT);
  const im = new Float32Array(FFT);
  let midE = 0;
  let sideE = 0;
  let used = 0;
  starts.forEach((start, idx) => {
    if (energy[idx] < gate || energy[idx] <= 0) return;
    for (let i = 0; i < FFT; i++) {
      const l = L[start + i];
      const r = R[start + i];
      const m = 0.5 * (l + r);
      const s = 0.5 * (l - r);
      midE += m * m;
      sideE += s * s;
      re[i] = m * w[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let k = 0; k < half; k++) pow[k] += re[k] * re[k] + im[k] * im[k];
    used++;
  });

  const binHz = sr / FFT;
  const bands = new Float32Array(BANDS.length);
  for (let b = 0; b < BANDS.length; b++) {
    const lo = BANDS[b] / Math.pow(2, 1 / 12);
    const hi = BANDS[b] * Math.pow(2, 1 / 12);
    const k0 = Math.max(1, Math.floor(lo / binHz));
    const k1 = Math.min(half - 1, Math.max(k0, Math.ceil(hi / binHz)));
    let s = 0;
    for (let k = k0; k <= k1; k++) s += pow[k];
    bands[b] = 10 * Math.log10(s / (k1 - k0 + 1) / Math.max(1, used) + 1e-20);
  }
  return { bands, sideRatio: midE > 0 ? sideE / midE : 0, sampleRate: sr };
}

// EQ curve (dB per band) that moves the mix's tonal balance toward the
// reference's. The overall offset is removed (loudness is matched later),
// the curve is smoothed to 1/3 octave, kept within ±maxDb, faded out at the
// extremes, and never boosts a band the mix simply does not have (boosting
// silence only raises noise).
export function matchCurve(mix, ref, { maxDb = 6, emptyDb = 30, emptyBoostDb = 2 } = {}) {
  const nb = BANDS.length;
  const raw = new Float32Array(nb);
  for (let b = 0; b < nb; b++) raw[b] = ref.bands[b] - mix.bands[b];

  // Level-neutral over the range that carries the music.
  let s = 0;
  let c = 0;
  for (let b = 0; b < nb; b++) {
    if (BANDS[b] >= 100 && BANDS[b] <= 8000) {
      s += raw[b];
      c++;
    }
  }
  const offset = c ? s / c : 0;

  const sortedMix = [...mix.bands].sort((a, b) => a - b);
  const mixMedian = sortedMix[nb >> 1];
  const curve = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    let acc = 0;
    let wsum = 0;
    for (let d = -2; d <= 2; d++) {
      const j = b + d;
      if (j < 0 || j >= nb) continue;
      const wt = 3 - Math.abs(d);
      acc += (raw[j] - offset) * wt;
      wsum += wt;
    }
    let g = clamp(acc / wsum, -maxDb, maxDb);
    if (mix.bands[b] < mixMedian - emptyDb) g = Math.min(g, emptyBoostDb);
    const f = BANDS[b];
    if (f < 30) g *= clamp((f - 20) / 10, 0, 1);
    if (f > 18000) g *= clamp((20000 - f) / 2000, 0, 1);
    curve[b] = g;
  }
  return curve;
}

// Magnitude of the curve on an FFT grid, interpolated in log frequency.
function curveToMagnitude(curveDb, sampleRate, n) {
  const half = n / 2;
  const mag = new Float64Array(n);
  const logBands = BANDS.map((f) => Math.log(f));
  for (let k = 0; k <= half; k++) {
    const f = (k * sampleRate) / n;
    let db;
    if (f <= BANDS[0]) db = curveDb[0];
    else if (f >= BANDS[BANDS.length - 1]) db = curveDb[BANDS.length - 1];
    else {
      const lf = Math.log(f);
      let j = 0;
      while (j < BANDS.length - 2 && logBands[j + 1] < lf) j++;
      const t = (lf - logBands[j]) / (logBands[j + 1] - logBands[j]);
      db = curveDb[j] + t * (curveDb[j + 1] - curveDb[j]);
    }
    mag[k] = Math.pow(10, db / 20);
    if (k > 0 && k < half) mag[n - k] = mag[k];
  }
  return mag;
}

// Minimum-phase FIR for the curve (real-cepstrum method). Minimum phase means
// no added latency and no pre-ringing, like an analogue EQ, so the filter can
// sit in the live graph and the render stays sample-aligned.
export function minimumPhaseFir(curveDb, sampleRate, { taps = 2048, grid = 16384 } = {}) {
  const n = grid;
  const mag = curveToMagnitude(curveDb, sampleRate, n);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let k = 0; k < n; k++) re[k] = Math.log(Math.max(mag[k], 1e-6));
  // Real cepstrum = IFFT(log|H|); the input is real and even, so a forward
  // FFT divided by n gives the same result.
  fftInPlace(re, im);
  const cep = new Float32Array(n);
  for (let k = 0; k < n; k++) cep[k] = re[k] / n;
  // Fold onto positive quefrencies.
  re.fill(0);
  im.fill(0);
  re[0] = cep[0];
  for (let k = 1; k < n / 2; k++) re[k] = 2 * cep[k];
  re[n / 2] = cep[n / 2];
  fftInPlace(re, im);
  // exp of the complex log spectrum.
  for (let k = 0; k < n; k++) {
    const a = Math.exp(re[k]);
    const r = a * Math.cos(im[k]);
    const i = a * Math.sin(im[k]);
    re[k] = r;
    im[k] = -i; // conjugate for the inverse transform below
  }
  fftInPlace(re, im);
  const h = new Float32Array(taps);
  const fade = Math.floor(taps / 4);
  for (let i = 0; i < taps; i++) {
    let v = re[i] / n;
    if (i >= taps - fade) v *= 0.5 + 0.5 * Math.cos((Math.PI * (i - (taps - fade))) / fade);
    h[i] = v;
  }
  return h;
}

// FFT overlap-add convolution, output trimmed to the input length. Used by the
// tests and handy for offline processing.
export function fftConvolve(x, h) {
  const m = h.length;
  let n = 1;
  while (n < 2 * m) n <<= 1;
  const block = n - m + 1;
  const hr = new Float32Array(n);
  const hi = new Float32Array(n);
  hr.set(h);
  fftInPlace(hr, hi);
  const out = new Float32Array(x.length + m);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let start = 0; start < x.length; start += block) {
    re.fill(0);
    im.fill(0);
    re.set(x.subarray(start, Math.min(x.length, start + block)));
    fftInPlace(re, im);
    for (let k = 0; k < n; k++) {
      const a = re[k] * hr[k] - im[k] * hi[k];
      const b = re[k] * hi[k] + im[k] * hr[k];
      re[k] = a;
      im[k] = -b;
    }
    fftInPlace(re, im);
    for (let i = 0; i < n && start + i < out.length; i++) out[start + i] += re[i] / n;
  }
  return out.subarray(0, x.length);
}

// Width that would give the mix the reference's side/mid balance, relative to
// the width the mix was measured at.
export function matchWidth(currentWidth, mix, ref, { min = 0.6, max = 1.6 } = {}) {
  if (!(mix.sideRatio > 1e-6) || !(ref.sideRatio > 0)) return currentWidth;
  return clamp(currentWidth * Math.sqrt(ref.sideRatio / mix.sideRatio), min, max);
}
