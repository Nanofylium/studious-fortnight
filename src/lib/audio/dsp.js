// Pure DSP helpers — no Web Audio API dependency, safe to run anywhere.

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-6));

export function measure(buffer) {
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
      n++;
    }
  }
  const rms = Math.sqrt(sum / Math.max(1, n));
  return {
    peak,
    rms,
    rmsDb: gainToDb(rms),
    peakDb: gainToDb(peak),
    crest: rms > 0 ? gainToDb(peak / rms) : 0,
  };
}

export function computePeaks(buffer, buckets = 420) {
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const step = Math.max(1, Math.floor(buffer.length / buckets));
  const out = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    const start = b * step;
    const end = Math.min(buffer.length, start + step);
    let max = 0;
    for (let c = 0; c < chans.length; c++) {
      const d = chans[c];
      for (let i = start; i < end; i++) {
        const a = d[i] < 0 ? -d[i] : d[i];
        if (a > max) max = a;
      }
    }
    out[b] = max;
  }
  return out;
}

// Inter-sample (true) peak in dBTP — the metric streaming platforms actually
// enforce. 4x linear interpolation, the same detection practical limiters use.
// Linear interpolation between two samples never exceeds the louder endpoint,
// so windows whose endpoints both sit below the gate cannot hide a peak.
export function truePeakDb(buffer, { gate = 0.1 } = {}) {
  const n = buffer.length;
  let max = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const v = d[i];
      const a = v < 0 ? -v : v;
      if (a > max) max = a;
      if (i === n - 1) break;
      const nb = d[i + 1];
      const b = nb < 0 ? -nb : nb;
      if (a <= gate && b <= gate) continue;
      const diff = nb - v;
      let p = v + diff * 0.25;
      if (p < 0) p = -p;
      let m = p;
      p = v + diff * 0.5;
      if (p < 0) p = -p;
      if (p > m) m = p;
      p = v + diff * 0.75;
      if (p < 0) p = -p;
      if (p > m) m = p;
      if (m > max) max = m;
    }
  }
  return gainToDb(max);
}

// Look-ahead brickwall limiter with inter-sample-aware detection. The ceiling
// holds on the samples and between them, and it does so independently of how
// hard the level is pushed — which is what lets the loudness loop hit its
// target without ever breaking the peak. In place.
export function limitTruePeak(buffer, ceilingDb, { releaseMs = 120, lookMs = 2.5 } = {}) {
  const n = buffer.length;
  const sr = buffer.sampleRate;
  const limit = dbToGain(ceilingDb);
  const gate = limit * 0.7;
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));

  const env = new Float32Array(n);
  for (const d of chans) {
    for (let i = 0; i < n; i++) {
      const v = d[i];
      const a = v < 0 ? -v : v;
      if (a > env[i]) env[i] = a;
      if (i === n - 1) break;
      const nb = d[i + 1];
      const b = nb < 0 ? -nb : nb;
      if (a <= gate && b <= gate) continue;
      const diff = nb - v;
      let p = v + diff * 0.25;
      if (p < 0) p = -p;
      if (p > env[i]) env[i] = p;
      p = v + diff * 0.5;
      if (p < 0) p = -p;
      if (p > env[i]) env[i] = p;
      p = v + diff * 0.75;
      if (p < 0) p = -p;
      if (p > env[i]) env[i] = p;
    }
  }

  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) need[i] = env[i] > limit ? limit / env[i] : 1;

  // Sliding minimum over the look-ahead window: the gain is already down when
  // the peak arrives, so nothing overshoots between samples either.
  const look = Math.max(1, Math.round((lookMs / 1000) * sr));
  const ahead = new Float32Array(n);
  const deque = new Int32Array(n + 2);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    const add = i + look;
    if (add < n) {
      while (tail > head && need[deque[tail - 1]] >= need[add]) tail--;
      deque[tail++] = add;
    }
    while (tail > head && deque[head] < i) head++;
    ahead[i] = head < tail ? need[deque[head]] : 1;
  }

  const rel = Math.exp(-1 / ((releaseMs / 1000) * sr));
  let g = 1;
  let minG = 1;
  for (let i = 0; i < n; i++) {
    const t = ahead[i];
    g = t < g ? t : t + (g - t) * rel;
    if (g < minG) minG = g;
    for (let c = 0; c < chans.length; c++) chans[c][i] *= g;
  }

  return { grDb: -gainToDb(minG), truePeakDb: truePeakDb(buffer) };
}

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

function frameMagnitudes(frame) {
  const n = frame.length;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = frame[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  fftInPlace(re, im);
  const mag = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]) / (n / 2);
  return mag;
}

export function spectrum(buffer, { fftSize = 2048, windows = 12 } = {}) {
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const total = buffer.length;
  const acc = new Float32Array(fftSize / 2);
  const frame = new Float32Array(fftSize);
  let used = 0;
  for (let w = 1; w <= windows; w++) {
    const start = Math.floor(((total - fftSize) * w) / (windows + 1));
    if (start < 0) break;
    for (let i = 0; i < fftSize; i++) {
      let s = 0;
      for (let c = 0; c < chans.length; c++) s += chans[c][start + i];
      frame[i] = s / chans.length;
    }
    const mag = frameMagnitudes(frame);
    for (let i = 0; i < mag.length; i++) acc[i] += mag[i];
    used++;
  }
  if (used) for (let i = 0; i < acc.length; i++) acc[i] /= used;
  return { mag: acc, sampleRate: buffer.sampleRate, fftSize, length: total };
}

export function bandEnergy(sp, lo, hi) {
  const { mag, sampleRate, fftSize } = sp;
  const binHz = sampleRate / fftSize;
  const i0 = Math.max(1, Math.floor(lo / binHz));
  const i1 = Math.min(mag.length - 1, Math.ceil(hi / binHz));
  if (i1 <= i0) return 0;
  let sum = 0;
  for (let i = i0; i <= i1; i++) sum += mag[i] * mag[i];
  return Math.sqrt(sum / (i1 - i0 + 1));
}

export function peakFrequency(sp, lo, hi) {
  const { mag, sampleRate, fftSize } = sp;
  const binHz = sampleRate / fftSize;
  const i0 = Math.max(1, Math.round(lo / binHz));
  const i1 = Math.min(mag.length - 1, Math.round(hi / binHz));
  let best = i0;
  let bestV = -1;
  for (let i = i0; i <= i1; i++) {
    if (mag[i] > bestV) {
      bestV = mag[i];
      best = i;
    }
  }
  return best * binHz;
}

// Soft saturation, level-neutral at low levels so the knob adds harmonics and
// rounds transients instead of just getting louder. drive 0 = transparent.
export function saturationCurve(drive = 0) {
  const n = 2048;
  const curve = new Float32Array(n);
  const d = Math.max(drive, 0);
  const k = d * 3 + 0.0001;
  const norm = Math.tanh(k);
  const mix = Math.min(0.5, d * 0.5);
  const smallSignal = (1 - mix) + (mix * k) / norm;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 - mix) * x + mix * (Math.tanh(k * x) / norm)) / smallSignal;
  }
  return curve;
}

// Gentle downward expander: only touches signal below the threshold,
// which is where AI-generated swirl and hiss live. In-place.
export function denoiseChannels(channels, sampleRate, { thresholdDb = -58, maxReductionDb = 11 } = {}) {
  const thr = dbToGain(thresholdDb);
  const floor = dbToGain(-maxReductionDb);
  const attack = Math.exp(-1 / (0.004 * sampleRate));
  const release = Math.exp(-1 / (0.15 * sampleRate));
  for (let c = 0; c < channels.length; c++) {
    const d = channels[c];
    let env = 0;
    for (let i = 0; i < d.length; i++) {
      const a = d[i] < 0 ? -d[i] : d[i];
      env = a > env ? attack * env + (1 - attack) * a : release * env + (1 - release) * a;
      if (env < thr) {
        const t = env / thr;
        d[i] *= floor + (1 - floor) * t;
      }
    }
  }
  return channels;
}

// Tape-style transfer curve. A soft knee leaves quiet material clean while peaks
// round off, a slight asymmetry adds the even harmonics that read as warmth and
// body (the odd ones come from the knee itself), and small-signal gain is unity
// so the stage colours the sound instead of just making it louder. drive 0 is
// an exact identity curve, so the stage can be switched off transparently.
export function tapeCurve(drive = 0.3) {
  const n = 4096;
  const curve = new Float32Array(n);
  const d = clamp(drive, 0, 1);
  if (d <= 0) {
    for (let i = 0; i < n; i++) curve[i] = (i / (n - 1)) * 2 - 1;
    return curve;
  }
  const k = 0.65 + d * 2.2;
  const asym = 0.03 + d * 0.07;
  const norm = Math.tanh(k);
  const small = k / norm;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const xa = x + asym * x * x;
    curve[i] = Math.tanh(k * xa) / norm / small;
  }
  return curve;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export function encodeWav(buffer, bitDepth = 24) {
  const numCh = buffer.numberOfChannels;
  const len = buffer.length;
  const bytes = bitDepth / 8;
  const dataSize = len * numCh * bytes;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * numCh * bytes, true);
  view.setUint16(32, numCh * bytes, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = clamp(channels[c][i], -1, 1);
      if (bitDepth === 24) {
        const v = Math.round(s * 8388607);
        view.setUint8(offset++, v & 0xff);
        view.setUint8(offset++, (v >> 8) & 0xff);
        view.setUint8(offset++, (v >> 16) & 0xff);
      } else {
        view.setInt16(offset, Math.round(s * 32767), true);
        offset += 2;
      }
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}