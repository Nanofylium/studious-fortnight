// "Cantar sobre o instrumental": timing of a take. What the singer hears left
// the speakers `outputLatency` after it was scheduled, and what the mic
// captures reaches the recorder `inputLatency` after it was sung, so a take
// lands late on the instrumental by the round trip. The recorder keeps the
// raw capture from the instant the instrumental was scheduled and the take is
// shifted earlier by that round trip, estimated from the browser's figures or
// measured with a click loopback (measureLoopbackDelay).
import { fftInPlace } from '../dsp.js';

export const MAX_OFFSET_MS = 600;

// Round trip in seconds from what the browser reports. Missing figures count
// as zero; the result is only a starting point for the measured value.
export function estimateLatencySec({ outputLatency = 0, baseLatency = 0, inputLatency = 0 } = {}) {
  const ok = (v) => (Number.isFinite(v) && v > 0 && v < 1 ? v : 0);
  return ok(outputLatency) + ok(baseLatency) + ok(inputLatency);
}

// Joins the recorder's chunks ({ frame, data }) into one signal that starts
// at `startFrame` (the frame the instrumental was scheduled on). Missing
// frames (a dropped chunk) stay silent rather than shifting what follows.
export function joinChunks(chunks, startFrame) {
  let end = startFrame;
  for (const c of chunks) end = Math.max(end, c.frame + c.data.length);
  const out = new Float32Array(Math.max(0, end - startFrame));
  for (const c of chunks) {
    const from = c.frame - startFrame;
    for (let i = 0; i < c.data.length; i++) {
      const j = from + i;
      if (j >= 0 && j < out.length) out[j] = c.data[i];
    }
  }
  return out;
}

// The take placed on the instrumental: `raw` starts when the instrumental
// started, so dropping the first `offsetFrames` undoes the round trip.
// Always `length` frames long (padded with silence or cut).
export function alignTake(raw, offsetFrames, length) {
  const out = new Float32Array(Math.max(0, length));
  const off = Math.max(0, Math.round(offsetFrames));
  const n = Math.min(out.length, raw.length - off);
  if (n > 0) out.set(raw.subarray(off, off + n));
  return out;
}

// Calibration signal: short 2 kHz bursts with a smooth window, `count` of
// them `gapSec` apart, after `leadSec` of silence. Irregular gaps keep the
// cross-correlation from locking onto the wrong burst. Returns the signal,
// the burst start frames and the burst length.
export function clickTrain(sampleRate, { count = 6, gapSec = 0.45, leadSec = 0.3, burstMs = 6 } = {}) {
  const burst = Math.round((burstMs / 1000) * sampleRate);
  const starts = [];
  let t = leadSec;
  for (let k = 0; k < count; k++) {
    starts.push(Math.round(t * sampleRate));
    t += gapSec * (1 + 0.17 * (k % 3));
  }
  const out = new Float32Array(starts[starts.length - 1] + burst + Math.round(0.8 * sampleRate));
  for (const s of starts) {
    for (let i = 0; i < burst; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (burst - 1));
      out[s + i] = 0.8 * w * Math.sin((2 * Math.PI * 2000 * i) / sampleRate);
    }
  }
  return { signal: out, starts, burst };
}

// How many bursts stand out in `recorded` at `lag`: the burst window must
// carry 4x (6 dB) the energy of the 20 ms just before it. A steady sound on
// the mic correlates with the train too, but has no onsets.
export function clicksHeard(recorded, { starts, burst }, lag, sampleRate) {
  const pre = Math.round(0.02 * sampleRate);
  const win = burst + Math.round(0.004 * sampleRate);
  const energy = (a, n) => {
    let e = 0;
    for (let i = a; i < a + n; i++) e += (recorded[i] ?? 0) ** 2;
    return e / n;
  };
  let heard = 0;
  for (const s of starts) {
    const at = s + lag;
    if (at - pre < 0 || at + win > recorded.length) continue;
    if (energy(at, win) > 4 * energy(at - pre - 2, pre) + 1e-9) heard += 1;
  }
  return heard;
}

// Delay (in frames) of `recorded` against `reference`, both starting at the
// same instant, searched in [0, maxLagFrames]. FFT cross-correlation;
// `confidence` is how far the peak stands over the correlation's typical
// level (under ~6 the loopback did not hear the clicks).
export function measureLoopbackDelay(reference, recorded, maxLagFrames) {
  const need = reference.length + recorded.length;
  let n = 1;
  while (n < need) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n);
  const br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(reference);
  br.set(recorded);
  fftInPlace(ar, ai);
  fftInPlace(br, bi);
  // conj(A)·B, then the inverse FFT through conjugation.
  for (let k = 0; k < n; k++) {
    const re = ar[k] * br[k] + ai[k] * bi[k];
    const im = ar[k] * bi[k] - ai[k] * br[k];
    ar[k] = re;
    ai[k] = -im;
  }
  fftInPlace(ar, ai);
  const maxLag = Math.min(maxLagFrames, n - 1);
  let best = 0, bestV = -Infinity, sum = 0;
  for (let lag = 0; lag <= maxLag; lag++) {
    const v = Math.abs(ar[lag]);
    sum += v;
    if (v > bestV) {
      bestV = v;
      best = lag;
    }
  }
  const mean = sum / (maxLag + 1);
  return { lagFrames: best, confidence: mean > 0 ? bestV / mean : 0 };
}

// Linear resampling of a mono take to the session's rate (the recording
// context runs at the device rate, the session at 44.1 kHz). The voice band
// sits far below either Nyquist, so linear interpolation is transparent
// after the low-pass the mic path already applies.
export function resampleLinear(x, fromRate, toRate) {
  if (fromRate === toRate) return x;
  const n = Math.round((x.length * toRate) / fromRate);
  const out = new Float32Array(n);
  const step = fromRate / toRate;
  for (let i = 0; i < n; i++) {
    const t = i * step;
    const i0 = Math.floor(t);
    const f = t - i0;
    const a = x[i0] ?? 0;
    const b = x[i0 + 1] ?? a;
    out[i] = a + (b - a) * f;
  }
  return out;
}
