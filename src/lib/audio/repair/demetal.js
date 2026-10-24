// De-metallizing for AI-rendered audio — the first corrective half of the
// repair stage. Driven by the report from detect.js, one STFT pass does three
// things, each with its own 0–1 amount:
//   - resonance: dynamically pulls the persistent narrow peaks (the metallic
//     ring) down to their local floor, only while they actually stick out;
//   - air: rebuilds the band above a brick-wall cutoff by replicating the
//     octave below it, shaped to continue the spectrum's own slope;
//   - stereo: narrows the side channel in the upper bands where left and
//     right stop being coherent, the swirly "phasey" sheen of AI renders.
// Pure functions over channel arrays, no Web Audio dependency.
import { fftInPlace, dbToGain } from '../dsp.js';

const N = 2048;
const HOP = N / 4;
// Hann analysis and synthesis at 75 % overlap sum to a constant 1.5.
const OLA_NORM = 1 / 1.5;

let hannN = null;
function hann() {
  if (!hannN) {
    hannN = new Float32Array(N);
    for (let i = 0; i < N; i++) hannN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  }
  return hannN;
}

// Two real channels through one complex FFT: z = l + i·r.
function forward(l, r, start, re, im) {
  const w = hann();
  const n = l.length;
  for (let i = 0; i < N; i++) {
    const j = start + i;
    const inside = j >= 0 && j < n;
    re[i] = inside ? l[j] * w[i] : 0;
    im[i] = inside ? r[j] * w[i] : 0;
  }
  fftInPlace(re, im);
}

// Splits the packed spectrum into the half-spectra of l and r (bins 0..N/2).
function unpack(re, im, Lr, Li, Rr, Ri) {
  for (let k = 0; k <= N / 2; k++) {
    const nk = (N - k) % N;
    Lr[k] = 0.5 * (re[k] + re[nk]);
    Li[k] = 0.5 * (im[k] - im[nk]);
    Rr[k] = 0.5 * (im[k] + im[nk]);
    Ri[k] = -0.5 * (re[k] - re[nk]);
  }
}

// Rebuilds the packed spectrum from the two (Hermitian) half-spectra and
// inverts it: the real part comes back as l, the imaginary part as r.
function inverse(Lr, Li, Rr, Ri, re, im) {
  for (let k = 0; k <= N / 2; k++) {
    re[k] = Lr[k] - Ri[k];
    im[k] = Li[k] + Rr[k];
    if (k > 0 && k < N / 2) {
      re[N - k] = Lr[k] + Ri[k];
      im[N - k] = -Li[k] + Rr[k];
    }
  }
  // Inverse FFT via conjugation.
  for (let k = 0; k < N; k++) im[k] = -im[k];
  fftInPlace(re, im);
  for (let k = 0; k < N; k++) {
    re[k] /= N;
    im[k] = -im[k] / N;
  }
}

// Long-term average power per bin (mono), from a subsample of frames.
function averagePower(l, r, frames) {
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const Lr = new Float32Array(N / 2 + 1);
  const Li = new Float32Array(N / 2 + 1);
  const Rr = new Float32Array(N / 2 + 1);
  const Ri = new Float32Array(N / 2 + 1);
  const avg = new Float64Array(N / 2 + 1);
  const step = Math.max(1, Math.floor(frames / 200));
  let used = 0;
  for (let f = 0; f < frames; f += step) {
    forward(l, r, f * HOP - (N - HOP), re, im);
    unpack(re, im, Lr, Li, Rr, Ri);
    for (let k = 0; k <= N / 2; k++) {
      const mr = (Lr[k] + Rr[k]) / 2;
      const mi = (Li[k] + Ri[k]) / 2;
      avg[k] += mr * mr + mi * mi;
    }
    used++;
  }
  for (let k = 0; k <= N / 2; k++) avg[k] = avg[k] / Math.max(1, used) + 1e-24;
  return avg;
}

// Band replication plan: for every bin above the cutoff, which bin below it
// feeds it, by how many bins it is shifted and with what gain. The gain makes
// the patch continue the slope of the octave below the cutoff, falling a
// further `rolloffDb` per octave so the restored air never sounds brighter
// than the material around it.
function airPlan(avg, binHz, cutoffHz, amount, { rolloffDb = 4, topHz = 20000 } = {}) {
  const half = N / 2;
  const kc = Math.ceil(cutoffHz / binHz);
  const kTop = Math.min(half - 1, Math.floor(topHz / binHz));
  if (kc < 16 || kc >= kTop) return null;

  // Least-squares line in dB against log2(bin) over the octave below.
  const a0 = Math.floor(kc / 2);
  const a1 = Math.floor(kc * 0.97);
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (let k = a0; k < a1; k++) {
    const x = Math.log2(k);
    const y = 10 * Math.log10(avg[k]);
    sx += x; sy += y; sxx += x * x; sxy += x * y; n++;
  }
  const slope = Math.min(0, (n * sxy - sx * sy) / (n * sxx - sx * sx || 1));
  const icept = (sy - slope * sx) / n;

  const width = kc - a0;
  const src = new Int32Array(half + 1).fill(-1);
  const shift = new Int32Array(half + 1);
  const gain = new Float32Array(half + 1);
  const fade = Math.max(2, Math.round(300 / binHz));
  for (let k = kc; k <= kTop; k++) {
    const patch = Math.floor((k - kc) / width);
    const s = a0 + ((k - kc) % width);
    const target = icept + slope * Math.log2(k) - rolloffDb * Math.log2(k / kc);
    const have = 10 * Math.log10(avg[s]);
    let g = dbToGain(Math.min(0, target - have)) * amount;
    if (k - kc < fade) g *= (k - kc + 1) / fade;
    if (kTop - k < fade) g *= (kTop - k + 1) / fade;
    src[k] = s;
    shift[k] = (patch + 1) * width;
    gain[k] = g;
  }
  return { src, shift, gain, kc, kTop };
}

function resonancePlan(peaks, binHz) {
  const half = N / 2;
  return peaks
    .map((p) => Math.round(p.freq / binHz))
    .filter((k) => k > 16 && k < half - 16)
    .map((k) => ({ k, gain: 1 }));
}

export function demetallize(channels, sampleRate, report, {
  resonance = 0.7,
  air = 0.6,
  stereo = 0.35,
  headroomDb = 3,
  releaseMs = 80,
  coherenceMs = 120,
  stereoFromHz = 2500,
} = {}) {
  const l = channels[0];
  const r = channels[1] || channels[0];
  const stereoIn = channels.length > 1;
  const n = l.length;
  const binHz = sampleRate / N;
  const half = N / 2;
  // The first frame starts early enough that every sample sits under four.
  const frames = Math.ceil((n + N - HOP) / HOP);

  const peaks = resonance > 0 ? resonancePlan(report?.resonances?.peaks || [], binHz) : [];
  const bw = report?.bandwidth;
  const avg = air > 0 && bw?.limited ? averagePower(l, r, frames) : null;
  const plan = avg ? airPlan(avg, binHz, bw.cutoffHz, air) : null;
  const doStereo = stereoIn && stereo > 0;

  const outL = new Float32Array(n);
  const outR = stereoIn ? new Float32Array(n) : outL;
  if (!peaks.length && !plan && !doStereo) {
    outL.set(l);
    if (stereoIn) outR.set(r);
    return stereoIn ? [outL, outR] : [outL];
  }

  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const Lr = new Float32Array(half + 1);
  const Li = new Float32Array(half + 1);
  const Rr = new Float32Array(half + 1);
  const Ri = new Float32Array(half + 1);
  const Sr = new Float32Array(half + 1);
  const Si = new Float32Array(half + 1);
  const w = hann();

  const rel = Math.exp(-HOP / ((releaseMs / 1000) * sampleRate));
  const head = dbToGain(headroomDb);
  const coh = Math.exp(-HOP / ((coherenceMs / 1000) * sampleRate));
  const kS = Math.max(1, Math.round(stereoFromHz / binHz));
  const pll = new Float64Array(half + 1);
  const prr = new Float64Array(half + 1);
  const cr = new Float64Array(half + 1);
  const ci = new Float64Array(half + 1);

  for (let f = 0; f < frames; f++) {
    const start = f * HOP - (N - HOP);
    forward(l, r, start, re, im);
    unpack(re, im, Lr, Li, Rr, Ri);

    // Resonances: measure on the original spectrum, then attenuate the peak's
    // main lobe toward the ring around it.
    for (const p of peaks) {
      let ring = 0;
      let cnt = 0;
      for (let d = 5; d <= 12; d++) {
        for (const k of [p.k - d, p.k + d]) {
          ring += Lr[k] * Lr[k] + Li[k] * Li[k] + Rr[k] * Rr[k] + Ri[k] * Ri[k];
          cnt++;
        }
      }
      ring /= cnt;
      let top = 0;
      for (let k = p.k - 1; k <= p.k + 1; k++) {
        top = Math.max(top, Lr[k] * Lr[k] + Li[k] * Li[k] + Rr[k] * Rr[k] + Ri[k] * Ri[k]);
      }
      const want = top > 0 ? Math.min(1, Math.sqrt((ring * head * head) / top)) : 1;
      const g = Math.pow(want, resonance);
      p.gain = g < p.gain ? g : g + (p.gain - g) * rel;
      for (let d = -3; d <= 3; d++) {
        const k = p.k + d;
        const gk = 1 - (1 - p.gain) * (1 - Math.abs(d) / 4);
        Lr[k] *= gk; Li[k] *= gk; Rr[k] *= gk; Ri[k] *= gk;
      }
    }

    // Air: a phase-vocoder style patch. Shifting by s bins also shifts the
    // phase advance per hop by 2π·s·HOP/N, which keeps the patch coherent
    // from frame to frame.
    if (plan) {
      for (let k = plan.kc; k <= plan.kTop; k++) {
        const s = plan.src[k];
        const g = plan.gain[k];
        if (g <= 0) continue;
        const th = (2 * Math.PI * plan.shift[k] * HOP * f) / N;
        const c = Math.cos(th);
        const sn = Math.sin(th);
        Lr[k] += g * (Lr[s] * c - Li[s] * sn);
        Li[k] += g * (Lr[s] * sn + Li[s] * c);
        Rr[k] += g * (Rr[s] * c - Ri[s] * sn);
        Ri[k] += g * (Rr[s] * sn + Ri[s] * c);
      }
    }

    // Stereo: scale the side signal by the inter-channel coherence, averaged
    // over time. Mono content (side = 0) passes untouched.
    if (doStereo) {
      for (let k = kS; k <= half; k++) {
        const a = Lr[k], b = Li[k], c = Rr[k], d = Ri[k];
        pll[k] = coh * pll[k] + (1 - coh) * (a * a + b * b);
        prr[k] = coh * prr[k] + (1 - coh) * (c * c + d * d);
        cr[k] = coh * cr[k] + (1 - coh) * (a * c + b * d);
        ci[k] = coh * ci[k] + (1 - coh) * (b * c - a * d);
        const den = Math.sqrt(pll[k] * prr[k]);
        const gamma = den > 1e-20 ? Math.min(1, Math.hypot(cr[k], ci[k]) / den) : 1;
        const gs = 1 - stereo * (1 - gamma);
        const mr = 0.5 * (a + c), mi = 0.5 * (b + d);
        Sr[k] = 0.5 * (a - c) * gs;
        Si[k] = 0.5 * (b - d) * gs;
        Lr[k] = mr + Sr[k]; Li[k] = mi + Si[k];
        Rr[k] = mr - Sr[k]; Ri[k] = mi - Si[k];
      }
    }

    inverse(Lr, Li, Rr, Ri, re, im);
    for (let i = 0; i < N; i++) {
      const j = start + i;
      if (j < 0 || j >= n) continue;
      const wi = w[i] * OLA_NORM;
      outL[j] += re[i] * wi;
      if (stereoIn) outR[j] += im[i] * wi;
    }
  }
  return stereoIn ? [outL, outR] : [outL];
}
