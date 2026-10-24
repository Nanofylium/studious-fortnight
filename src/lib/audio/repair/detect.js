// Defect detection for AI-rendered audio — the analysis half of the repair
// stage. Pure functions over anything shaped like an AudioBuffer
// (numberOfChannels, length, sampleRate, getChannelData), so they run the same
// in the browser, in a worker and under node for tests.
//
// Two families of defects:
//   - spectral: a hard low-pass cliff (lost air, the "underwater" sound) and
//     narrow resonances that stay put for the whole song (the "metallic" sheen);
//   - temporal: clicks, short dropouts and abrupt gaps where the render failed.
import { fftInPlace, gainToDb, dbToGain, clamp } from '../dsp.js';

const windows = new Map();
function hann(n) {
  let w = windows.get(n);
  if (!w) {
    w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    windows.set(n, w);
  }
  return w;
}

function channelsOf(buffer) {
  const out = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
  return out;
}

// Power spectra of frames spread evenly across the file. Silent frames are
// skipped so fades and intros do not drag the averages down.
function frameSpectra(buffer, { fftSize = 4096, frames = 96, gateDb = -60 } = {}) {
  const chans = channelsOf(buffer);
  const total = buffer.length;
  const half = fftSize / 2;
  const out = [];
  if (total < fftSize) return { frames: out, binHz: buffer.sampleRate / fftSize, half };
  const win = hann(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const gate = dbToGain(gateDb);
  const count = Math.max(1, Math.min(frames, Math.floor(total / (fftSize / 2))));
  for (let f = 0; f < count; f++) {
    const start = Math.floor(((total - fftSize) * (f + 0.5)) / count);
    let sum = 0;
    for (let i = 0; i < fftSize; i++) {
      let s = 0;
      for (let c = 0; c < chans.length; c++) s += chans[c][start + i];
      s /= chans.length;
      sum += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    if (Math.sqrt(sum / fftSize) < gate) continue;
    fftInPlace(re, im);
    const pow = new Float32Array(half);
    const norm = 1 / (half * half);
    for (let k = 0; k < half; k++) pow[k] = (re[k] * re[k] + im[k] * im[k]) * norm;
    out.push(pow);
  }
  return { frames: out, binHz: buffer.sampleRate / fftSize, half };
}

const toDb = (p) => 10 * Math.log10(p + 1e-20);

function bandDb(pow, binHz, lo, hi) {
  const i0 = Math.max(1, Math.floor(lo / binHz));
  const i1 = Math.min(pow.length - 1, Math.ceil(hi / binHz));
  if (i1 < i0) return -200;
  let s = 0;
  for (let i = i0; i <= i1; i++) s += pow[i];
  return toDb(s / (i1 - i0 + 1));
}

// Finds a brick-wall low-pass: the frequency where the long-term spectrum falls
// off a cliff. AI renders and low-bitrate encodes typically stop at 11–16 kHz,
// which is most of what makes them sound dull or "under water". Also reports
// how much air (12–16 kHz) there is relative to the presence band, which
// catches a soft roll-off that has no clear cliff.
export function detectBandwidth(buffer, { minDropDb = 24 } = {}) {
  const { frames, binHz, half } = frameSpectra(buffer, { fftSize: 4096, frames: 64 });
  if (!frames.length) return { cutoffHz: null, dropDb: 0, limited: false, airDb: null };

  // Median over frames, not mean: a single click or the edge of a dropout is
  // broadband and would otherwise paint over the cliff.
  const avg = new Float32Array(half);
  const col = new Float32Array(frames.length);
  for (let k = 0; k < half; k++) {
    for (let f = 0; f < frames.length; f++) col[f] = frames[f][k];
    col.sort();
    avg[k] = col[frames.length >> 1];
  }
  const db = new Float32Array(half);
  for (let k = 0; k < half; k++) db[k] = toDb(avg[k]);

  const prefix = new Float64Array(half + 1);
  for (let k = 0; k < half; k++) prefix[k + 1] = prefix[k] + db[k];
  const mean = (a, b) => (prefix[b] - prefix[a]) / (b - a);

  const span = Math.max(4, Math.round(1000 / binHz));
  const guard = Math.max(2, Math.round(300 / binHz));
  let bestDrop = 0;
  let bestK = -1;
  for (let k = Math.round(5000 / binHz); k + guard + span <= half; k++) {
    const drop = mean(k - span, k) - mean(k + guard, k + guard + span);
    if (drop > bestDrop) {
      bestDrop = drop;
      bestK = k;
    }
  }

  const airDb = bandDb(avg, binHz, 12000, 16000) - bandDb(avg, binHz, 2000, 5000);
  if (bestK < 0 || bestDrop < minDropDb) {
    return { cutoffHz: null, dropDb: bestDrop, limited: false, airDb };
  }
  // Refine to the first bin 12 dB under the pass-band just below the cliff.
  const pass = mean(bestK - span, bestK);
  let edge = bestK;
  while (edge < bestK + guard + span && db[edge] > pass - 12) edge++;
  const cutoffHz = edge * binHz;
  return { cutoffHz, dropDb: bestDrop, limited: cutoffHz < 18500, airDb };
}

// Narrow spectral peaks that sit on the same frequency for most of the song.
// Musical partials move with the notes; the metallic ringing of AI renders and
// codec artefacts does not, so persistence across the file is the tell.
export function detectResonances(buffer, { lo = 1800, hi = 10000, minProminenceDb = 8, minPersistence = 0.75 } = {}) {
  const { frames, binHz, half } = frameSpectra(buffer, { fftSize: 8192, frames: 96 });
  const empty = { peaks: [], score: 0 };
  if (!frames.length) return empty;

  const k0 = Math.max(2, Math.floor(lo / binHz));
  const k1 = Math.min(half - 3, Math.ceil(hi / binHz));
  const hits = new Float32Array(half);
  const promSum = new Float32Array(half);
  const db = new Float32Array(half);
  const prefix = new Float64Array(half + 1);

  for (const p of frames) {
    for (let k = 0; k < half; k++) db[k] = toDb(p[k]);
    for (let k = 0; k < half; k++) prefix[k + 1] = prefix[k] + db[k];
    for (let k = k0; k <= k1; k++) {
      if (db[k] < db[k - 1] || db[k] < db[k + 1]) continue;
      // Local floor: mean level over about ±6 % of the frequency, leaving out
      // the peak's own main lobe.
      const w = Math.max(8, Math.round(k * 0.06));
      const a = Math.max(0, k - w);
      const b = Math.min(half, k + w + 1);
      const inner = Math.min(half, k + 3) - Math.max(0, k - 2);
      const sum = prefix[b] - prefix[a] - (prefix[Math.min(half, k + 3)] - prefix[Math.max(0, k - 2)]);
      const floor = sum / (b - a - inner);
      const prom = db[k] - floor;
      if (prom < minProminenceDb) continue;
      hits[k] += 1;
      promSum[k] += prom;
    }
  }

  // Let a peak wander by one bin between frames and still count as the same.
  const F = frames.length;
  const persist = new Float32Array(half);
  for (let k = k0; k <= k1; k++) persist[k] = Math.min(1, (hits[k - 1] + hits[k] + hits[k + 1]) / F);

  const peaks = [];
  for (let k = k0; k <= k1; k++) {
    const v = persist[k];
    if (v < minPersistence || v < persist[k - 1] || v <= persist[k + 1]) continue;
    const h = hits[k - 1] + hits[k] + hits[k + 1];
    const freq = ((k - 1) * hits[k - 1] + k * hits[k] + (k + 1) * hits[k + 1]) / h * binHz;
    const prominenceDb = (promSum[k - 1] + promSum[k] + promSum[k + 1]) / h;
    const last = peaks[peaks.length - 1];
    if (last && freq - last.freq < last.freq * 0.03) {
      if (v * prominenceDb > last.persistence * last.prominenceDb) peaks[peaks.length - 1] = { freq, prominenceDb, persistence: v };
      continue;
    }
    peaks.push({ freq, prominenceDb, persistence: v });
  }

  const score = clamp(peaks.reduce((s, p) => s + p.persistence * p.prominenceDb, 0) / 40, 0, 1);
  return { peaks, score };
}

// Linear-prediction coefficients (autocorrelation method, Levinson–Durbin).
// Returns a with a[0] = 1 so that e[n] = sum a[j] x[n-j] is the residual.
function lpc(x, start, n, order) {
  const win = hann(n);
  const seg = new Float64Array(n);
  for (let i = 0; i < n; i++) seg[i] = x[start + i] * win[i];
  const r = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += seg[i] * seg[i - lag];
    r[lag] = s;
  }
  const a = new Float64Array(order + 1);
  a[0] = 1;
  if (r[0] <= 1e-12) return a;
  r[0] *= 1 + 1e-6;
  let err = r[0];
  const tmp = new Float64Array(order + 1);
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / err;
    tmp.set(a);
    for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
    a[i] = k;
    err *= 1 - k * k;
    if (err <= 0) break;
  }
  return a;
}

// Median of |e| over consecutive segments: a robust, cheap local level.
function segmentLevels(e, seg) {
  const ns = Math.ceil(e.length / seg);
  const out = new Float32Array(ns);
  const tmp = new Float32Array(seg);
  for (let j = 0; j < ns; j++) {
    const from = j * seg;
    const len = Math.min(seg, e.length - from);
    const view = tmp.subarray(0, len);
    view.set(e.subarray(from, from + len));
    view.sort();
    out[j] = view[len >> 1] * 1.4826;
  }
  return out;
}

// Clicks show up as bursts in the linear-prediction residual: music is
// predictable from its recent past, a discontinuity is not. What separates a
// click from a drum hit is that the hit stays unpredictable afterwards (and a
// cut-off stays so before), so each sample is judged against the residual
// level on both sides — skipping the click's own tail — and the louder side
// wins. Anything longer than a few milliseconds is left to the dropout
// detector.
function clicksInChannel(x, sr, { order, block, threshold, maxLengthMs, floor }) {
  const n = x.length;
  const e = new Float32Array(n);
  for (let b = 0; b < n; b += block) {
    const end = Math.min(n, b + block);
    const from = Math.max(0, b - order);
    const len = end - from;
    if (len <= order * 2) continue;
    const a = lpc(x, from, len, order);
    for (let i = Math.max(b, order); i < end; i++) {
      let s = x[i];
      for (let j = 1; j <= order; j++) s += a[j] * x[i - j];
      e[i] = s < 0 ? -s : s;
    }
  }

  const seg = 64;
  const lv = segmentLevels(e, seg);
  const ns = lv.length;
  const side = 4;
  const skip = Math.ceil(order / seg) + 1;
  const sideLevel = (from, to) => {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, from); j < Math.min(ns, to); j++) {
      s += lv[j];
      c++;
    }
    return c ? s / c : 0;
  };

  const events = [];
  const maxLen = Math.round((maxLengthMs / 1000) * sr);
  let cur = null;
  for (let j = 0; j < ns; j++) {
    const before = sideLevel(j - skip - side, j - skip + 1);
    const after = sideLevel(j + skip, j + skip + side);
    const sigma = Math.max(before, after, floor);
    const limit = threshold * sigma;
    const end = Math.min(n, (j + 1) * seg);
    for (let i = j * seg; i < end; i++) {
      if (e[i] <= limit) continue;
      const ratio = e[i] / sigma;
      if (cur && i - cur.end <= order) {
        cur.end = i + 1;
        if (ratio > cur.severity) cur.severity = ratio;
      } else {
        if (cur) events.push(cur);
        cur = { start: i, end: i + 1, severity: ratio };
      }
    }
  }
  if (cur) events.push(cur);
  return events.filter((ev) => ev.end - ev.start <= maxLen);
}

export function detectClicks(buffer, { order = 20, block = 2048, threshold = 8, maxLengthMs = 4, floorDb = -90 } = {}) {
  const sr = buffer.sampleRate;
  const opts = { order, block, threshold, maxLengthMs, floor: dbToGain(floorDb) };
  const all = [];
  channelsOf(buffer).forEach((x, c) => {
    for (const ev of clicksInChannel(x, sr, opts)) all.push({ ...ev, channels: [c] });
  });
  return mergeEvents(all, Math.round(0.001 * sr));
}

// Dropouts and gaps: the level collapses to (near) silence with no decay on
// the way in, and the music comes back afterwards. A natural rest has a tail
// and an outro has nothing after it, so neither qualifies.
function dropoutsInChannel(x, sr, { frameMs, floorDb, contextDb, minMs, maxMs, gapMs }) {
  const fl = Math.max(16, Math.round((frameMs / 1000) * sr));
  const nf = Math.floor(x.length / fl);
  const lvl = new Float32Array(nf);
  for (let f = 0; f < nf; f++) {
    let s = 0;
    for (let i = f * fl; i < (f + 1) * fl; i++) s += x[i] * x[i];
    lvl[f] = gainToDb(Math.sqrt(s / fl));
  }

  const ctxFrames = Math.max(1, Math.round(10 / frameMs));
  const thr = dbToGain(floorDb);
  const events = [];
  let f = 0;
  while (f < nf) {
    if (lvl[f] >= floorDb) {
      f++;
      continue;
    }
    const r0 = f;
    while (f < nf && lvl[f] < floorDb) f++;
    const r1 = f;
    if (r0 === 0 || r1 >= nf) continue;
    let after = 0;
    const aEnd = Math.min(nf, r1 + ctxFrames);
    for (let k = r1; k < aEnd; k++) after += lvl[k];
    after /= aEnd - r1;
    if (lvl[r0 - 1] < contextDb || after < contextDb) continue;

    let start = r0 * fl;
    while (start > 0 && Math.abs(x[start - 1]) < thr) start--;
    let end = r1 * fl;
    while (end < x.length && Math.abs(x[end]) < thr) end++;
    const ms = ((end - start) / sr) * 1000;
    if (ms < minMs || ms > maxMs) continue;

    let inside = 0;
    for (let k = r0; k < r1; k++) inside += lvl[k];
    inside /= r1 - r0;
    events.push({
      type: ms >= gapMs ? 'gap' : 'dropout',
      start,
      end,
      severity: Math.min(lvl[r0 - 1], after) - inside,
    });
  }
  return events;
}

export function detectDropouts(buffer, {
  frameMs = 2,
  floorDb = -66,
  contextDb = -40,
  minMs = 3,
  maxMs = 2500,
  gapMs = 150,
} = {}) {
  const sr = buffer.sampleRate;
  const opts = { frameMs, floorDb, contextDb, minMs, maxMs, gapMs };
  const all = [];
  channelsOf(buffer).forEach((x, c) => {
    for (const ev of dropoutsInChannel(x, sr, opts)) all.push({ ...ev, channels: [c] });
  });
  return mergeEvents(all, Math.round(0.002 * sr));
}

// Union of per-channel events that overlap or sit within `slack` samples.
function mergeEvents(events, slack) {
  events.sort((a, b) => a.start - b.start);
  const out = [];
  for (const ev of events) {
    const last = out[out.length - 1];
    if (last && ev.start <= last.end + slack && (ev.type || 'click') === (last.type || 'click')) {
      last.end = Math.max(last.end, ev.end);
      last.severity = Math.max(last.severity, ev.severity);
      for (const c of ev.channels) if (!last.channels.includes(c)) last.channels.push(c);
    } else {
      out.push({ ...ev, channels: [...ev.channels] });
    }
  }
  return out;
}

// One pass over a stem or a mix: everything the repair stage needs to decide
// what to fix, plus a flat, time-sorted event list the UI can draw.
export function scanDefects(buffer, options = {}) {
  const sr = buffer.sampleRate;
  const bandwidth = detectBandwidth(buffer, options.bandwidth);
  const resonances = detectResonances(buffer, options.resonances);
  const dropouts = detectDropouts(buffer, options.dropouts);
  // The edges of a dropout are themselves discontinuities; report them once.
  const pad = Math.round(0.005 * sr);
  const clicks = detectClicks(buffer, options.clicks).filter(
    (c) => !dropouts.some((d) => c.end >= d.start - pad && c.start <= d.end + pad),
  );

  const events = [
    ...clicks.map((c) => ({ ...c, type: 'click' })),
    ...dropouts,
  ]
    .sort((a, b) => a.start - b.start)
    .map((ev) => ({
      ...ev,
      startSec: ev.start / sr,
      durationMs: ((ev.end - ev.start) / sr) * 1000,
    }));

  return {
    bandwidth,
    resonances,
    events,
    counts: {
      clicks: clicks.length,
      dropouts: dropouts.filter((d) => d.type === 'dropout').length,
      gaps: dropouts.filter((d) => d.type === 'gap').length,
    },
  };
}
