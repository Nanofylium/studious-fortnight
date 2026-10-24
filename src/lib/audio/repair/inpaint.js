// Audio inpainting for AI-rendered audio — the second corrective half of the
// repair stage. Fills the regions detect.js reports, choosing the method by
// how much is missing:
//   - up to a few milliseconds (clicks, short dropouts): least-squares AR
//     interpolation, which continues the waveform from both sides at once;
//   - longer gaps: a patch copied from the place in the song whose
//     surroundings best match the gap's (AI music repeats itself a lot), cut
//     in with short crossfades at the matched phase;
//   - when nothing in the song matches well enough: AR extrapolation forward
//     from before the gap and backward from after it, crossfaded.
// Pure functions over channel arrays, no Web Audio dependency.
import { clamp, fftInPlace } from '../dsp.js';

// AR model fitted on the context on both sides of [start, end) with Burg's
// method, summed over the two segments. Unlike the windowed autocorrelation
// method it does not bias the poles inward, which matters when the model has
// to carry a waveform across tens of milliseconds.
function arAround(x, start, end, order, context) {
  const segs = [
    [Math.max(0, start - context), start],
    [end, Math.min(x.length, end + context)],
  ]
    .filter(([s0, e0]) => e0 - s0 > order * 2)
    .map(([s0, e0]) => ({ f: Float64Array.from(x.subarray(s0, e0)), b: Float64Array.from(x.subarray(s0, e0)) }));
  const a = new Float64Array(order + 1);
  a[0] = 1;
  if (!segs.length) return a;
  const prev = new Float64Array(order + 1);
  for (let m = 1; m <= order; m++) {
    let num = 0;
    let den = 0;
    for (const { f, b } of segs) {
      for (let n = m; n < f.length; n++) {
        num += f[n] * b[n - 1];
        den += f[n] * f[n] + b[n - 1] * b[n - 1];
      }
    }
    if (den <= 1e-30) break;
    const k = (-2 * num) / den;
    for (const { f, b } of segs) {
      for (let n = f.length - 1; n >= m; n--) {
        const fn = f[n] + k * b[n - 1];
        b[n] = b[n - 1] + k * f[n];
        f[n] = fn;
      }
    }
    prev.set(a);
    for (let j = 1; j < m; j++) a[j] = prev[j] + k * prev[m - j];
    a[m] = k;
  }
  return a;
}

// Least-squares AR interpolation (LSAR): the missing samples are the ones
// that minimise the total prediction error over the gap and the `order`
// samples after it. The normal equations are a banded, symmetric positive
// definite system, solved here with a banded Cholesky factorisation.
export function interpolateAR(x, start, end, { order = 100, context = 4096 } = {}) {
  const m = end - start;
  if (m <= 0) return;
  const p = order;
  const a = arAround(x, start, end, p, context);

  // Autocorrelation of the coefficients: the system's band.
  const ra = new Float64Array(p + 1);
  for (let d = 0; d <= p; d++) {
    let s = 0;
    for (let l = 0; l + d <= p; l++) s += a[l] * a[l + d];
    ra[d] = s;
  }

  // Prediction error from the known samples alone, over the affected span.
  const span = m + p;
  const ek = new Float64Array(span);
  for (let t = 0; t < span; t++) {
    const tt = start + t;
    let s = 0;
    for (let j = 0; j <= p; j++) {
      const idx = tt - j;
      if (idx < 0 || idx >= x.length || (idx >= start && idx < end)) continue;
      s += a[j] * x[idx];
    }
    ek[t] = s;
  }
  const rhs = new Float64Array(m);
  for (let u = 0; u < m; u++) {
    let s = 0;
    for (let j = 0; j <= p; j++) s += a[j] * ek[u + j];
    rhs[u] = -s;
  }

  // Banded Cholesky: L[i][j] (j = i-p..i) stored at i * bw + (i - j).
  const bw = p + 1;
  const L = new Float64Array(m * bw);
  for (let i = 0; i < m; i++) {
    const lo = Math.max(0, i - p);
    for (let j = lo; j <= i; j++) {
      let s = ra[i - j] + (i === j ? 1e-9 * ra[0] : 0);
      for (let q = lo; q < j; q++) s -= L[i * bw + (i - q)] * L[j * bw + (j - q)];
      if (i === j) L[i * bw] = Math.sqrt(Math.max(s, 1e-30));
      else L[i * bw + (i - j)] = s / L[j * bw];
    }
  }
  const y = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let s = rhs[i];
    for (let k = 1; k <= Math.min(p, i); k++) s -= L[i * bw + k] * y[i - k];
    y[i] = s / L[i * bw];
  }
  for (let i = m - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = 1; k <= p && i + k < m; k++) s -= L[(i + k) * bw + k] * x[start + i + k];
    x[start + i] = s / L[i * bw];
  }
}

// AR extrapolation of `count` samples from x[from-1], x[from-2], ... forward
// (dir = 1) or from x[from+1], ... backward (dir = -1).
function extrapolate(x, from, count, a, dir) {
  const p = a.length - 1;
  const out = new Float64Array(count);
  const hist = new Float64Array(p);
  for (let j = 0; j < p; j++) hist[j] = x[from - dir * (j + 1)] || 0;
  for (let i = 0; i < count; i++) {
    let s = 0;
    for (let j = 1; j <= p; j++) s -= a[j] * hist[j - 1];
    out[i] = s;
    hist.copyWithin(1, 0, p - 1);
    hist[0] = s;
  }
  return out;
}

// Etter-style fill for medium gaps without a good match: predict forward from
// the left edge and backward from the right edge, then crossfade the two.
export function extrapolateBoth(x, start, end, { order = 64, context = 4096 } = {}) {
  const m = end - start;
  if (m <= 0) return;
  const a = arAround(x, start, end, order, context);
  const fwd = extrapolate(x, start, m, a, 1);
  const bwd = extrapolate(x, end - 1, m, a, -1);
  for (let i = 0; i < m; i++) {
    const t = (i + 0.5) / m;
    const wf = Math.cos((t * Math.PI) / 2) ** 2;
    x[start + i] = fwd[i] * wf + bwd[m - 1 - i] * (1 - wf);
  }
}

function ncc(x, ai, y, bi, n) {
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const u = x[ai + i];
    const v = y[bi + i];
    sxy += u * v;
    sxx += u * u;
    syy += v * v;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

// Coarse fingerprint of the song for the patch search: log energy in
// log-spaced bands per 512-sample hop. Magnitudes do not care about a few
// hundred samples of misalignment, yet still tell a hi-hat from a held chord,
// which is what a decimated waveform cannot do.
const FP_HOP = 512;
const FP_N = 1024;
const FP_BANDS = 24;
const fingerprints = new WeakMap();
function fingerprint(mono, sampleRate) {
  const cached = fingerprints.get(mono);
  if (cached) return cached;
  const frames = Math.max(0, Math.floor((mono.length - FP_N) / FP_HOP) + 1);
  const edges = [];
  const lo = 100;
  const hi = Math.min(16000, sampleRate / 2 - 100);
  for (let bnd = 0; bnd <= FP_BANDS; bnd++) {
    edges.push(Math.max(1, Math.round(((lo * Math.pow(hi / lo, bnd / FP_BANDS)) / sampleRate) * FP_N)));
  }
  const out = new Float32Array(frames * FP_BANDS);
  const re = new Float32Array(FP_N);
  const im = new Float32Array(FP_N);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < FP_N; i++) {
      re[i] = mono[f * FP_HOP + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FP_N));
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let bnd = 0; bnd < FP_BANDS; bnd++) {
      let e = 0;
      for (let k = edges[bnd]; k < Math.max(edges[bnd] + 1, edges[bnd + 1]); k++) e += re[k] * re[k] + im[k] * im[k];
      out[f * FP_BANDS + bnd] = Math.log10(e + 1e-10);
    }
  }
  const fp = { data: out, frames };
  fingerprints.set(mono, fp);
  return fp;
}

// Searches the song for the source of a patch: the offset whose context on
// both sides matches the gap's best. The fingerprint ranks candidate places,
// then a full-rate correlation aligns each to the sample and picks the winner.
export function findPatch(mono, start, end, sampleRate, { contextMs = 150, blocked = [], keep = 8 } = {}) {
  const m = end - start;
  const ctx = Math.round((contextMs / 1000) * sampleRate);
  const n = mono.length;
  if (start - ctx < 0 || end + ctx > n) return null;
  const isBlocked = (c) => {
    const a = c - ctx;
    const b = c + m + ctx;
    if (a < 0 || b > n) return true;
    if (a < end + ctx && b > start - ctx) return true;
    return blocked.some(([s0, e0]) => a < e0 && b > s0);
  };

  // Context frames: whole frames clear of the gap on each side.
  const { data, frames } = fingerprint(mono, sampleRate);
  const cf = Math.max(2, Math.round(ctx / FP_HOP));
  const bEnd = Math.floor((start - FP_N) / FP_HOP);
  const aStart = Math.ceil(end / FP_HOP);
  const ctxFrames = [];
  for (let f = bEnd - cf + 1; f <= bEnd; f++) if (f >= 0) ctxFrames.push(f);
  for (let f = aStart; f < aStart + cf; f++) if (f < frames) ctxFrames.push(f);
  if (ctxFrames.length < cf) return null;

  const apart = Math.max(2, Math.round((0.02 * sampleRate) / FP_HOP));
  const cands = [];
  const minShift = -Math.floor(start / FP_HOP);
  const maxShift = Math.floor((n - end) / FP_HOP);
  for (let L = minShift; L <= maxShift; L++) {
    const c = start + L * FP_HOP;
    if (isBlocked(c)) continue;
    let dist = 0;
    let ok = true;
    for (const f of ctxFrames) {
      const g = f + L;
      if (g < 0 || g >= frames) {
        ok = false;
        break;
      }
      for (let bnd = 0; bnd < FP_BANDS; bnd++) {
        const dv = data[f * FP_BANDS + bnd] - data[g * FP_BANDS + bnd];
        dist += dv * dv;
      }
    }
    if (!ok) continue;
    if (cands.length < keep || dist < cands[cands.length - 1].dist) {
      const near = cands.findIndex((q) => Math.abs(q.L - L) < apart);
      if (near >= 0) {
        if (dist < cands[near].dist) cands[near] = { L, dist };
      } else {
        cands.push({ L, dist });
      }
      cands.sort((p, q) => p.dist - q.dist);
      if (cands.length > keep) cands.pop();
    }
  }

  let best = null;
  for (const { L } of cands) {
    const c0 = start + L * FP_HOP;
    for (let off = -FP_HOP; off <= FP_HOP; off++) {
      const cc = c0 + off;
      if (isBlocked(cc)) continue;
      const score = 0.5 * (ncc(mono, start - ctx, mono, cc - ctx, ctx) + ncc(mono, end, mono, cc + m, ctx));
      if (!best || score > best.score) best = { source: cc, score };
    }
  }
  return best;
}

function rms(x, a, b) {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

// Copies the patch into each damaged channel from the same source offset (so the
// stereo image stays intact), level-matched to the gap's surroundings and cut
// in with equal-power crossfades over `fade` samples on each side.
function applyPatch(channels, start, end, source, fade, ctx) {
  const m = end - start;
  for (const x of channels) {
    const here = rms(x, start - ctx, start) + rms(x, end, end + ctx);
    const there = rms(x, source - ctx, source) + rms(x, source + m, source + m + ctx);
    const g = there > 0 ? clamp(here / there, 0.5, 2) : 1;
    for (let i = -fade; i < m + fade; i++) {
      const src = x[source + i] * g;
      let w = 1;
      if (i < 0) w = Math.sin(((i + fade + 0.5) / fade) * (Math.PI / 2)) ** 2;
      else if (i >= m) w = Math.cos(((i - m + 0.5) / fade) * (Math.PI / 2)) ** 2;
      x[start + i] = w * src + (1 - w) * x[start + i];
    }
  }
}

// Repairs every event in place on copies of the channels. Returns the new
// channels and, per event, what was done (or why it was left alone).
export function repairEvents(channels, sampleRate, events, {
  arMaxMs = 12,
  extrapolateMaxMs = 120,
  minPatchScore = 0.6,
  fadeMs = 8,
  contextMs = 150,
  patch = true,
} = {}) {
  const out = channels.map((c) => c.slice());
  const n = out[0].length;
  const ms = (s) => (s / sampleRate) * 1000;
  const fade = Math.round((fadeMs / 1000) * sampleRate);
  const ctx = Math.round((contextMs / 1000) * sampleRate);
  const blocked = events.map((e) => [e.start, e.end]);
  let mono = null;
  const report = [];

  for (const ev of events) {
    const start = Math.max(0, ev.start);
    const end = Math.min(n, ev.end);
    const len = ms(end - start);
    const targets = (ev.channels && ev.channels.length ? ev.channels : out.map((_, c) => c))
      .filter((c) => c < out.length)
      .map((c) => out[c]);

    if (len <= arMaxMs) {
      for (const x of targets) interpolateAR(x, start, end);
      report.push({ ...ev, method: 'ar' });
      continue;
    }

    let found = null;
    if (patch) {
      if (!mono) {
        mono = new Float32Array(n);
        for (const x of out) for (let i = 0; i < n; i++) mono[i] += x[i] / out.length;
      }
      found = findPatch(mono, start, end, sampleRate, { contextMs, blocked });
    }
    if (found && found.score >= minPatchScore && start - fade >= 0 && end + fade <= n) {
      applyPatch(targets, start, end, found.source, fade, ctx);
      report.push({ ...ev, method: 'patch', source: found.source, score: found.score });
    } else if (len <= extrapolateMaxMs) {
      for (const x of targets) extrapolateBoth(x, start, end);
      report.push({ ...ev, method: 'extrapolate', score: found?.score ?? null });
    } else {
      report.push({ ...ev, method: 'none', score: found?.score ?? null });
    }
  }
  return { channels: out, report };
}
