// Frame-wise "de-metal": in each STFT frame, bins that stick out of the local
// ~1/3-octave spectral envelope are pulled down (instant attack, smooth
// release), with one gain shared by L and R so the image does not move. This
// is the dynamic counterpart of repair/demetal.js, which treats resonances
// that persist through the whole stem; the AI ringing in a separated vocal
// moves with the melody, so it needs per-frame decisions.
import { fftInPlace } from '../dsp.js';
import { monoOf } from './filters.js';

const N = 2048;
const HOP = 512;
const HANN = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));

// Moving average in dB over ~1/3 octave, leaving out the bin and its neighbours.
function envelopeDb(magDb, out) {
  for (let k = 1; k < N / 2; k++) {
    const w = Math.max(3, Math.round(k * 0.115));
    let s = 0;
    let m = 0;
    for (let j = Math.max(1, k - w); j <= Math.min(N / 2 - 1, k + w); j++) {
      if (Math.abs(j - k) > 1) {
        s += magDb[j];
        m++;
      }
    }
    out[k] = s / m;
  }
}

export function dynamicDemetal(
  ch,
  sr,
  { thrDb = 5, ratio = 0.75, maxCut = 10, relMs = 60, lo = 1200, hi = 12000 } = {},
) {
  const [L, R] = ch;
  const n = L.length;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const frames = Math.ceil((n + N) / HOP);
  const lr = new Float32Array(N), li = new Float32Array(N), rr = new Float32Array(N), ri = new Float32Array(N);
  const md = new Float32Array(N / 2);
  const env = new Float32Array(N / 2);
  const gDb = new Float32Array(N / 2 + 1);
  const gLin = new Float32Array(N / 2 + 1);
  const rel = Math.exp(-HOP / ((relMs / 1000) * sr));
  const binHz = sr / N;
  const k1 = Math.round(lo / binHz);
  const k2 = Math.min(N / 2, Math.round(hi / binHz));
  const norm = new Float32Array(N);
  for (let o = 0; o < N; o += HOP) for (let i = 0; i < N; i++) norm[(i + o) % N] += HANN[i] ** 2;
  const olaN = 1 / norm[0];
  let cutAcc = 0;
  let cutCnt = 0;
  for (let f = 0; f < frames; f++) {
    const s = f * HOP - N;
    for (let i = 0; i < N; i++) {
      const j = s + i;
      const ok = j >= 0 && j < n;
      lr[i] = ok ? L[j] * HANN[i] : 0;
      rr[i] = ok ? R[j] * HANN[i] : 0;
      li[i] = 0;
      ri[i] = 0;
    }
    fftInPlace(lr, li);
    fftInPlace(rr, ri);
    for (let k = 1; k < N / 2; k++) {
      md[k] = 10 * Math.log10(0.5 * (lr[k] ** 2 + li[k] ** 2 + rr[k] ** 2 + ri[k] ** 2) + 1e-14);
    }
    envelopeDb(md, env);
    for (let k = 0; k <= N / 2; k++) {
      let target = 0;
      if (k >= k1 && k <= k2 && k < N / 2 && md[k] > -110) {
        const ex = md[k] - env[k] - thrDb;
        if (ex > 0) target = -Math.min(maxCut, ex * ratio);
      }
      gDb[k] = target < gDb[k] ? target : rel * gDb[k] + (1 - rel) * target;
      gLin[k] = 10 ** (gDb[k] / 20);
      if (k >= k1 && k <= k2) {
        cutAcc += gDb[k];
        cutCnt++;
      }
    }
    for (let k = 0; k < N; k++) {
      const g = gLin[k <= N / 2 ? k : N - k];
      lr[k] *= g; li[k] *= -g; rr[k] *= g; ri[k] *= -g; // conjugate for the inverse
    }
    fftInPlace(lr, li);
    fftInPlace(rr, ri);
    for (let i = 0; i < N; i++) {
      const j = s + i;
      if (j >= 0 && j < n) {
        const w = (HANN[i] * olaN) / N;
        outL[j] += lr[i] * w;
        outR[j] += rr[i] * w;
      }
    }
  }
  return { channels: [outL, outR], meanCutDb: cutCnt ? cutAcc / cutCnt : 0 };
}

// How far narrow bins stick out of the local envelope, 1.5–10 kHz, averaged
// over frames with signal. Higher = more ringing ("metallic"). For reports.
export function metallicIndex(ch, sr) {
  const mono = monoOf(ch);
  const re = new Float32Array(N), im = new Float32Array(N), md = new Float32Array(N / 2), env = new Float32Array(N / 2);
  const binHz = sr / N;
  const kLo = Math.round(1500 / binHz);
  const kHi = Math.min(N / 2 - 1, Math.round(10000 / binHz));
  let acc = 0;
  let cnt = 0;
  for (let s = 0; s + N < mono.length; s += HOP * 8) {
    let e = 0;
    for (let i = 0; i < N; i++) {
      re[i] = mono[s + i] * HANN[i];
      im[i] = 0;
      e += mono[s + i] ** 2;
    }
    if (10 * Math.log10(e / N + 1e-12) < -40) continue;
    fftInPlace(re, im);
    for (let k = 1; k < N / 2; k++) md[k] = 10 * Math.log10(re[k] ** 2 + im[k] ** 2 + 1e-12);
    envelopeDb(md, env);
    let ex = 0;
    for (let k = kLo; k < kHi; k++) ex += Math.max(0, md[k] - env[k] - 6);
    acc += ex / (kHi - kLo);
    cnt++;
  }
  return cnt ? acc / cnt : 0;
}
