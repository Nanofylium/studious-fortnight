// Offline building blocks for the production chain: RBJ biquads run over whole
// arrays, mono folds and a buffer-like view so the shared meters and limiter
// (which take AudioBuffer-shaped objects) work on plain Float32Arrays.
import { dbToGain, tapeCurve } from '../dsp.js';

export function bq(type, f, q, g, sr) {
  const A = 10 ** ((g || 0) / 40);
  const w = (2 * Math.PI * f) / sr;
  const c = Math.cos(w);
  const s = Math.sin(w);
  const al = s / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'hp') {
    b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al;
  } else if (type === 'lp') {
    b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al;
  } else if (type === 'peak') {
    b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A;
  } else {
    // 'hs' (high shelf) or 'ls' (low shelf)
    const sq = 2 * Math.sqrt(A) * al;
    const sg = type === 'hs' ? 1 : -1;
    b0 = A * (A + 1 + sg * (A - 1) * c + sq);
    b1 = -2 * sg * A * (A - 1 + sg * (A + 1) * c);
    b2 = A * (A + 1 + sg * (A - 1) * c - sq);
    a0 = A + 1 - sg * (A - 1) * c + sq;
    a1 = 2 * sg * (A - 1 - sg * (A + 1) * c);
    a2 = A + 1 - sg * (A - 1) * c - sq;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

export function filt(x, [b0, b1, b2, a1, a2]) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

export const chain = (x, ks) => ks.reduce((y, k) => filt(y, k), x);

export function monoOf(ch) {
  if (ch.length < 2) return ch[0];
  const [l, r] = ch;
  const m = new Float32Array(l.length);
  for (let i = 0; i < m.length; i++) m[i] = 0.5 * (l[i] + r[i]);
  return m;
}

// Everything in the production chain is stereo; a mono stem is doubled.
export const toStereo = (ch) => (ch.length > 1 ? [ch[0], ch[1]] : [ch[0], ch[0].slice()]);

export const asBuffer = (channels, sampleRate) => ({
  numberOfChannels: channels.length,
  length: channels[0].length,
  sampleRate,
  duration: channels[0].length / sampleRate,
  getChannelData: (c) => channels[c],
});

export function scale(ch, g) {
  for (const c of ch) for (let i = 0; i < c.length; i++) c[i] *= g;
  return ch;
}

export function rms(x) {
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  return Math.sqrt(e / Math.max(1, x.length));
}

// The repo's tape curve, driven 6 dB under full scale, then a DC block since
// the curve is asymmetric.
export function tape(ch, drive, sr) {
  const curve = tapeCurve(drive);
  const m = curve.length - 1;
  const pre = dbToGain(-6);
  const post = 1 / pre;
  const dc = bq('hp', 15, 0.7, 0, sr);
  return ch.map((c) => {
    const y = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) {
      const t = Math.max(-1, Math.min(1, c[i] * pre));
      const pos = ((t + 1) / 2) * m;
      const i0 = Math.floor(pos);
      const fr = pos - i0;
      y[i] = (curve[i0] * (1 - fr) + curve[Math.min(m, i0 + 1)] * fr) * post;
    }
    return filt(y, dc);
  });
}

// Linear interpolation read, 0 outside the array.
export function readAt(d, pos) {
  const i0 = Math.floor(pos);
  if (i0 < 0 || i0 + 1 >= d.length) return 0;
  const f = pos - i0;
  return d[i0] * (1 - f) + d[i0 + 1] * f;
}

// Small deterministic LCG, so renders are repeatable.
export function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

// Level of the loudest-but-typical passages: a percentile of a short-term
// level trace, sampled every `step` samples.
export function percentile(values, p) {
  const s = Array.from(values).sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
