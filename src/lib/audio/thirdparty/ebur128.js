// EBU R128 / ITU-R BS.1770-4 loudness meter, ported to JavaScript from
// libebur128 (https://github.com/jiixyj/libebur128, MIT License,
// Copyright (c) 2011 Jan Kokemüller; full notice in THIRD_PARTY_NOTICES.md).
// Ported: the K-weighting filter design (exact for any sample rate), the
// two-stage gated integrated loudness, loudness range (EBU Tech 3342) and the
// true-peak meter (49-tap polyphase sinc interpolator, 4x below 96 kHz).

const ABS_GATE_ENERGY = 10 ** ((-70 + 0.691) / 10);

// K-weighting: high-shelf pre-filter times RLB high-pass, as one 4th-order
// IIR (libebur128 ebur128_init_filter).
export function kWeightingCoeffs(sr) {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  const pb = [0, 0, 0];
  const pa = [1, 0, 0];
  const rb = [1, -2, 1];
  const ra = [1, 0, 0];
  const a0 = 1 + K / Q + K * K;
  pb[0] = (Vh + (Vb * K) / Q + K * K) / a0;
  pb[1] = (2 * (K * K - Vh)) / a0;
  pb[2] = (Vh - (Vb * K) / Q + K * K) / a0;
  pa[1] = (2 * (K * K - 1)) / a0;
  pa[2] = (1 - K / Q + K * K) / a0;
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sr);
  ra[1] = (2 * (K * K - 1)) / (1 + K / Q + K * K);
  ra[2] = (1 - K / Q + K * K) / (1 + K / Q + K * K);
  return {
    b: [pb[0] * rb[0], pb[0] * rb[1] + pb[1] * rb[0], pb[0] * rb[2] + pb[1] * rb[1] + pb[2] * rb[0], pb[1] * rb[2] + pb[2] * rb[1], pb[2] * rb[2]],
    a: [1, pa[0] * ra[1] + pa[1] * ra[0], pa[0] * ra[2] + pa[1] * ra[1] + pa[2] * ra[0], pa[1] * ra[2] + pa[2] * ra[1], pa[2] * ra[2]],
  };
}

// Direct form II, as libebur128 runs it. Returns the squared filtered signal
// summed over each 100 ms segment (the meter only ever needs those).
function segmentEnergies(x, sr, { b, a }) {
  const seg = Math.round(sr / 10);
  const nSeg = Math.floor(x.length / seg);
  const out = new Float64Array(nSeg);
  const v = [0, 0, 0, 0, 0];
  let i = 0;
  for (let s = 0; s < nSeg; s++) {
    let acc = 0;
    for (let j = 0; j < seg; j++, i++) {
      v[0] = x[i] - a[1] * v[1] - a[2] * v[2] - a[3] * v[3] - a[4] * v[4];
      const y = b[0] * v[0] + b[1] * v[1] + b[2] * v[2] + b[3] * v[3] + b[4] * v[4];
      v[4] = v[3]; v[3] = v[2]; v[2] = v[1]; v[1] = v[0];
      acc += y * y;
    }
    out[s] = acc;
  }
  return { energies: out, seg };
}

const toLufs = (e) => -0.691 + 10 * Math.log10(e);

// Mean-square energy of every window of `blocks` 100 ms segments, stepping
// `step` segments, summed over channels (L/R weight 1).
function windows(channels, sr, blocks, step) {
  const coeffs = kWeightingCoeffs(sr);
  const per = channels.slice(0, 2).map((c) => segmentEnergies(c, sr, coeffs));
  const { seg } = per[0];
  const nSeg = per[0].energies.length;
  const out = [];
  for (let s = 0; s + blocks <= nSeg; s += step) {
    let e = 0;
    for (const p of per) for (let k = s; k < s + blocks; k++) e += p.energies[k];
    out.push(e / (blocks * seg));
  }
  return out;
}

// Integrated loudness (LUFS): 400 ms blocks every 100 ms, absolute gate at
// -70 LUFS, relative gate 10 LU under the absolute-gated mean energy.
export function integratedLoudness(channels, sr) {
  const z = windows(channels, sr, 4, 1).filter((e) => e >= ABS_GATE_ENERGY);
  if (!z.length) return -Infinity;
  const rel = (z.reduce((a, b) => a + b, 0) / z.length) * 0.1;
  const kept = z.filter((e) => e >= rel);
  if (!kept.length) return -Infinity;
  return toLufs(kept.reduce((a, b) => a + b, 0) / kept.length);
}

// Loudness range (LU): 3 s short-term blocks every 1 s, absolute gate -70,
// relative gate -20 LU, spread between the 10th and 95th percentiles.
export function loudnessRange(channels, sr) {
  const v = windows(channels, sr, 30, 10).filter((e) => e >= ABS_GATE_ENERGY).sort((a, b) => a - b);
  if (!v.length) return 0;
  const gate = (v.reduce((a, b) => a + b, 0) / v.length) * 0.01;
  const g = v.filter((e) => e >= gate);
  if (!g.length) return 0;
  const hi = g[Math.floor((g.length - 1) * 0.95 + 0.5)];
  const lo = g[Math.floor((g.length - 1) * 0.1 + 0.5)];
  return toLufs(hi) - toLufs(lo);
}

// libebur128 interp_create: windowed-sinc polyphase interpolator.
function interpolator(taps, factor) {
  const filters = Array.from({ length: factor }, () => ({ coeff: [], index: [] }));
  for (let j = 0; j < taps; j++) {
    const m = j - (taps - 1) / 2;
    let c = 1;
    if (Math.abs(m) > 1e-9) c = Math.sin((m * Math.PI) / factor) / ((m * Math.PI) / factor);
    c *= 0.5 * (1 - Math.cos((2 * Math.PI * j) / (taps - 1)));
    if (Math.abs(c) > 1e-9) {
      filters[j % factor].coeff.push(c);
      filters[j % factor].index.push(Math.floor(j / factor));
    }
  }
  return { filters, delay: Math.floor((taps + factor - 1) / factor) };
}

// True peak, linear (max of the sample peak and the oversampled peak).
export function truePeak(channels, sr) {
  const factor = sr < 96000 ? 4 : sr < 192000 ? 2 : 1;
  let max = 0;
  for (const x of channels) for (let i = 0; i < x.length; i++) max = Math.max(max, Math.abs(x[i]));
  if (factor === 1) return max;
  const { filters, delay } = interpolator(49, factor);
  for (const x of channels) {
    const z = new Float64Array(delay);
    let zi = 0;
    for (let n = 0; n < x.length; n++) {
      z[zi] = x[n];
      for (const f of filters) {
        let acc = 0;
        for (let t = 0; t < f.coeff.length; t++) {
          let i = zi - f.index[t];
          if (i < 0) i += delay;
          acc += z[i] * f.coeff[t];
        }
        const a = acc < 0 ? -acc : acc;
        if (a > max) max = a;
      }
      if (++zi === delay) zi = 0;
    }
  }
  return max;
}

export const truePeakDbtp = (channels, sr) => 20 * Math.log10(Math.max(truePeak(channels, sr), 1e-9));
