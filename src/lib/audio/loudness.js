// Simplified ITU-R BS.1770 loudness measurement (K-weighting + gated blocks).

export function biquad(type, f0, q, gainDb, sampleRate) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;

  if (type === 'highshelf') {
    const s = 2 * Math.sqrt(A) * alpha;
    b0 = A * (A + 1 + (A - 1) * cos + s);
    b1 = -2 * A * (A - 1 + (A + 1) * cos);
    b2 = A * (A + 1 + (A - 1) * cos - s);
    a0 = A + 1 - (A - 1) * cos + s;
    a1 = 2 * (A - 1 - (A + 1) * cos);
    a2 = A + 1 - (A - 1) * cos - s;
  } else {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  }

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function applyBiquad(d, { b0, b1, b2, a1, a2 }) {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < d.length; i++) {
    const x = d[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    d[i] = y;
  }
}

export function integratedLufs(buffer, { maxSeconds = 0, inPlace = false } = {}) {
  const sr = buffer.sampleRate;
  const nch = Math.min(2, buffer.numberOfChannels);
  const total = buffer.length;
  let start = 0;
  let len = total;
  if (maxSeconds > 0 && total > maxSeconds * sr) {
    len = Math.round(maxSeconds * sr);
    start = Math.floor((total - len) / 2);
  }
  if (len < Math.round(0.4 * sr)) return -70;

  const full = start === 0 && len === total;
  const data = [];
  for (let c = 0; c < nch; c++) {
    const src = buffer.getChannelData(c);
    // inPlace only when the caller owns the samples (a throwaway mixdown)
    data.push(inPlace && full ? src : src.slice(start, start + len));
  }

  const shelf = biquad('highshelf', 1681.97, 0.7071, 4, sr);
  const hp = biquad('highpass', 38.13, 0.5, 0, sr);
  for (const d of data) {
    applyBiquad(d, shelf);
    applyBiquad(d, hp);
  }

  const blockLen = Math.round(0.4 * sr);
  const hop = Math.round(0.1 * sr);
  const z = [];
  for (let s = 0; s + blockLen <= len; s += hop) {
    let ms = 0;
    for (let c = 0; c < nch; c++) {
      const d = data[c];
      let sum = 0;
      for (let i = s; i < s + blockLen; i++) sum += d[i] * d[i];
      ms += sum / blockLen;
    }
    z.push(ms);
  }
  if (!z.length) return -70;

  const loud = z.map((v) => -0.691 + 10 * Math.log10(v + 1e-12));
  const above = loud.filter((v) => v > -70);
  if (!above.length) return -70;
  const mean = above.reduce((a, b) => a + b, 0) / above.length;
  const rel = mean - 10;
  const kept = z.filter((_, i) => loud[i] > -70 && loud[i] > rel);
  if (!kept.length) return -70;
  const finalMean = kept.reduce((a, b) => a + b, 0) / kept.length;
  return -0.691 + 10 * Math.log10(finalMean + 1e-12);
}