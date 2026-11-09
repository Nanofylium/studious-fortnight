// Vocal bus + instrumental -> stereo mix -> streaming master (-14 LUFS
// integrated, -1 dBTP). The vocal sits 1 dB above the loudness the separated
// vocal had in the song; the instrumental gets a wide -1.5 dB pocket at
// 2.8 kHz and a sub clean-up. Optional tape machine on the bus (Airwindows
// ToTape6), then a slow 2:1 glue and the loudness loop through the true-peak
// limiter, optionally after the Airwindows ClipOnly2 clipper.
import { dbToGain, limitTruePeak, truePeakDb } from '../dsp.js';
import { integratedLufs } from '../loudness.js';
import { asBuffer, bq, chain, lcg, monoOf, percentile, scale } from './filters.js';
import { clipOnly2Aligned, toTape6 } from '../thirdparty/airwindows.js';
import { loudnessRange } from '../thirdparty/ebur128.js';

const lufsOf = (ch, sr) => integratedLufs(asBuffer(ch, sr));

// Tape machine on the bus: Airwindows ToTape6 (flutter, head bump, soft
// highs, saturation), driven from a fixed level so the colour is the same
// whatever the mix level, then a faint hiss and slight L/R crosstalk.
export function analogStage(mix, sr) {
  let pk = 1e-9;
  for (const c of mix) for (let i = 0; i < c.length; i++) pk = Math.max(pk, Math.abs(c[i]));
  const drive = dbToGain(-6) / pk;
  let y = toTape6(mix.map((c) => c.map((v) => v * drive)), sr);
  const rnd = lcg(11);
  const hg = dbToGain(-76) * 3;
  y = y.map((c) => {
    let b0 = 0, b1 = 0, b2 = 0;
    return c.map((v) => {
      const w = rnd() * 2 - 1;
      b0 = 0.997 * b0 + 0.03 * w;
      b1 = 0.985 * b1 + 0.03 * w;
      b2 = 0.95 * b2 + 0.06 * w;
      return v / drive + (b0 + b1 + b2 + 0.1 * w) * hg;
    });
  });
  const xt = dbToGain(-30);
  const [l0, r0] = y;
  return [l0.map((v, i) => v + r0[i] * xt), r0.map((v, i) => v + l0[i] * xt)];
}

// Slow 2:1 RMS bus compressor, ~1.5–2 dB on the loudest passages. In place.
export function glue(mix, sr) {
  const L = mix[0].length;
  const m = monoOf(mix);
  const rm = Math.exp(-1 / (0.03 * sr));
  const a = Math.exp(-1 / (0.03 * sr));
  const r = Math.exp(-1 / (0.3 * sr));
  let p = 0;
  const lv = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    p = rm * p + (1 - rm) * m[i] ** 2;
    lv[i] = 10 * Math.log10(p + 1e-12);
  }
  const thr = percentile(lv.filter((_, i) => i % 480 === 0), 0.9) - 2;
  let g = 0, sum = 0, cnt = 0;
  for (let i = 0; i < L; i++) {
    const o = lv[i] - thr;
    const t = o > 0 ? -o * 0.5 : 0;
    g = t < g ? a * g + (1 - a) * t : r * g + (1 - r) * t;
    const kk = dbToGain(g);
    for (const c of mix) c[i] *= kk;
    if (g < -0.3) {
      sum += g;
      cnt++;
    }
  }
  return cnt ? sum / cnt : 0;
}

// Loudness to the target through the true-peak limiter; iterated because
// limiting takes a little loudness away. With `clip`, Airwindows ClipOnly2
// shaves the tallest transients first (overs more than 1.5 dB above the
// ceiling), so the limiter works less and pumps less. In place.
export function masterTo(ch, sr, { targetLufs = -14, ceilingDb = -1, clip = false } = {}) {
  const k = 0.9549925859 / dbToGain(ceilingDb + 1.5);
  for (let it = 0; it < 5; it++) {
    const l = lufsOf(ch, sr);
    if (!Number.isFinite(l)) break;
    if (Math.abs(targetLufs - l) < 0.05 && it > 0) break;
    scale(ch, dbToGain(targetLufs - l));
    if (clip) {
      for (let c = 0; c < ch.length; c++) {
        const y = clipOnly2Aligned(ch[c].map((v) => v * k), sr);
        for (let i = 0; i < y.length; i++) ch[c][i] = y[i] / k;
      }
    }
    limitTruePeak(asBuffer(ch, sr), ceilingDb);
  }
  return { lufs: lufsOf(ch, sr), truePeakDb: truePeakDb(asBuffer(ch, sr)), lra: loudnessRange(ch, sr) };
}

export function mixdown({ vocal, vocalTargetLufs, instrumental }, sr, { analog = false } = {}) {
  const parts = [];
  if (vocal) {
    const v = vocal.map((c) => c.slice());
    const now = lufsOf(v, sr);
    if (Number.isFinite(now) && Number.isFinite(vocalTargetLufs)) scale(v, dbToGain(vocalTargetLufs + 1 - now));
    parts.push(v);
  }
  if (instrumental) {
    const ks = vocal ? [bq('peak', 2800, 0.9, -1.5, sr), bq('hp', 28, 0.7, 0, sr)] : [bq('hp', 28, 0.7, 0, sr)];
    parts.push(instrumental.map((c) => chain(c, ks)));
  }
  const L = Math.min(...parts.map((p) => p[0].length));
  let mix = [0, 1].map((ci) => {
    const o = new Float32Array(L);
    for (const p of parts) for (let i = 0; i < L; i++) o[i] += p[ci][i];
    return o;
  });
  if (analog) mix = analogStage(mix, sr);
  const glueDb = glue(mix, sr);
  return { channels: mix, glueDb };
}

// 16-bit PCM with TPDF dither, the format every distributor accepts.
export function encodeWav16Dither(channels, sr, seed = 5) {
  const nc = channels.length;
  const n = channels[0].length;
  const ab = new ArrayBuffer(44 + n * nc * 2);
  const v = new DataView(ab);
  const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * nc * 2, true);
  w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nc, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * nc * 2, true);
  v.setUint16(32, nc * 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * nc * 2, true);
  const rnd = lcg(seed);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      const d = rnd() - rnd();
      const s = Math.max(-32768, Math.min(32767, Math.round(channels[c][i] * 32767 + d)));
      v.setInt16(o, s, true);
      o += 2;
    }
  }
  return ab;
}
