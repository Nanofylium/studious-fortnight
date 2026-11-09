// Vocal production chain for a separated AI vocal: dynamic de-metal, a bleed
// gate between phrases, EQ, de-esser, compressor, tape, optional "body"
// (parallel compression, chest saturation, ADT double), clarity EQ and a
// shared room. Same chain that made the "vocal mix e master" files; the stem
// arrives here already through the repair stage (clicks, gaps, resonances).
import { dbToGain } from '../dsp.js';
import { fftConvolve } from '../reference.js';
import { roomImpulse } from '../mixplan.js';
import { bq, chain, filt, lcg, monoOf, percentile, readAt, rms, tape, toStereo } from './filters.js';
import { dynamicDemetal } from './spectral.js';

// Downward expander keyed on the vocal band: closes up to `rangeDb` when the
// level drops 30 dB under the loud singing, which is where separation bleed lives.
export function bleedGate(ch, sr, { rangeDb = 18, holdMs = 120 } = {}) {
  const n = ch[0].length;
  const sc = chain(monoOf(ch), [bq('hp', 150, 0.7, 0, sr), bq('lp', 6000, 0.7, 0, sr)]);
  const blk = Math.max(1, Math.round(sr * 0.05));
  const lv = [];
  for (let i = 0; i + blk < n; i += blk) {
    let e = 0;
    for (let j = i; j < i + blk; j++) e += sc[j] ** 2;
    lv.push(10 * Math.log10(e / blk + 1e-12));
  }
  if (!lv.length) return { channels: ch, closedPct: 0 };
  const loud = percentile(lv, 0.95);
  const thr = dbToGain(loud - 30);
  const floor = dbToGain(-rangeDb);
  const att = Math.exp(-1 / (0.002 * sr));
  const relc = Math.exp(-1 / (0.18 * sr));
  const hold = Math.round((holdMs / 1000) * sr);
  const envDecay = Math.exp(-1 / (0.045 * sr));
  let env = 0, g = 1, h = 0, closed = 0;
  const gg = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(sc[i]);
    env = a > env ? a : envDecay * env;
    let tgt;
    if (env >= thr) {
      tgt = 1;
      h = hold;
    } else if (h > 0) {
      h--;
      tgt = 1;
    } else tgt = Math.max(floor, (env / thr) ** 2);
    g = tgt > g ? att * g + (1 - att) * tgt : relc * g + (1 - relc) * tgt;
    gg[i] = g;
    if (g < 0.5) closed++;
  }
  return { channels: ch.map((c) => c.map((v, i) => v * gg[i])), closedPct: (100 * closed) / n };
}

// Split-band de-esser: the band above 5.5 kHz is ducked when its share of the
// signal rises 7 dB over its median share.
export function deEss(ch, sr, { maxDb = 7, splitHz = 5500 } = {}) {
  const n = ch[0].length;
  const mono = monoOf(ch);
  const hpk = bq('hp', splitHz, 0.7, 0, sr);
  const hiM = filt(filt(mono, hpk), hpk);
  const a = Math.exp(-1 / (0.001 * sr));
  const r = Math.exp(-1 / (0.06 * sr));
  let eF = 0, eH = 0;
  const ratio = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const f = mono[i] ** 2;
    const hh = hiM[i] ** 2;
    eF = f > eF ? a * eF + (1 - a) * f : r * eF + (1 - r) * f;
    eH = hh > eH ? a * eH + (1 - a) * hh : r * eH + (1 - r) * hh;
    ratio[i] = 10 * Math.log10((eH + 1e-12) / (eF + 1e-12));
  }
  const voiced = [];
  for (let i = 0; i < n; i += 480) if (mono[i] !== 0) voiced.push(ratio[i]);
  if (!voiced.length) return { channels: ch, activePct: 0 };
  const thr = percentile(voiced, 0.5) + 7;
  let active = 0;
  const out = ch.map((c) => {
    const hi = filt(filt(c, hpk), hpk);
    return c.map((v, i) => {
      const over = ratio[i] - thr;
      const g = over > 0 ? dbToGain(-Math.min(maxDb, over * 0.8)) : 1;
      return v - hi[i] * (1 - g);
    });
  });
  for (let i = 0; i < n; i += 48) if (ratio[i] > thr) active++;
  return { channels: out, activePct: (100 * active) / Math.ceil(n / 48) };
}

// Feed-forward RMS compressor, soft knee; threshold 7.5 dB under the 97th
// percentile level, so loud phrases see ~5 dB of gain reduction.
export function compress(ch, sr, { ratio = 3, attMs = 8, relMs = 140, knee = 6 } = {}) {
  const n = ch[0].length;
  const mono = monoOf(ch);
  const a = Math.exp(-1 / ((attMs / 1000) * sr));
  const r = Math.exp(-1 / ((relMs / 1000) * sr));
  const rm = Math.exp(-1 / (0.01 * sr));
  let p = 0;
  const lvl = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    p = rm * p + (1 - rm) * mono[i] ** 2;
    lvl[i] = 10 * Math.log10(p + 1e-12);
  }
  const thr = percentile(lvl.filter((_, i) => i % 480 === 0), 0.97) - 7.5;
  let g = 0, grSum = 0, grCnt = 0;
  const gain = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = lvl[i] - thr;
    let tgt = 0;
    if (o > knee / 2) tgt = -(o * (1 - 1 / ratio));
    else if (o > -knee / 2) tgt = -((o + knee / 2) ** 2 / (2 * knee)) * (1 - 1 / ratio);
    g = tgt < g ? a * g + (1 - a) * tgt : r * g + (1 - r) * tgt;
    gain[i] = dbToGain(g);
    if (g < -0.5) {
      grSum += g;
      grCnt++;
    }
  }
  return { channels: ch.map((c) => c.map((v, i) => v * gain[i])), avgGrDb: grCnt ? grSum / grCnt : 0 };
}

// "Corpo": parallel 6:1 compression, 120–500 Hz chest saturation and a
// two-voice ADT double (17/23 ms, slowly wandering, panned 70 %), all blended
// under the dry voice and scaled by `amount` (0 = off, 1 = normal, 2.5 = max).
export function addBody(ch, sr, amount) {
  if (!(amount > 0)) return ch;
  const n = ch[0].length;
  const mono = monoOf(ch);
  const a = Math.exp(-1 / (0.002 * sr));
  const r = Math.exp(-1 / (0.08 * sr));
  const thr = percentile(mono.filter((_, i) => i % 480 === 0).map(Math.abs), 0.6) + 1e-6;
  const pc = new Float32Array(n);
  let env = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(mono[i]);
    env = v > env ? a * env + (1 - a) * v : r * env + (1 - r) * v;
    pc[i] = mono[i] * (env > thr ? (thr / env) ** (1 - 1 / 6) : 1);
  }
  const pcg = (rms(mono) / (rms(pc) + 1e-12)) * dbToGain(-9) * amount;

  let chest = chain(mono, [bq('hp', 120, 0.7, 0, sr), bq('lp', 500, 0.7, 0, sr)]);
  let cpk = 1e-9;
  for (let i = 0; i < n; i++) cpk = Math.max(cpk, Math.abs(chest[i]));
  chest = chest.map((v) => (Math.tanh((4 * v) / cpk) * cpk) / 4);
  chest = filt(chest, bq('hp', 180, 0.7, 0, sr));
  const chg = dbToGain(-12) * amount;

  const dsrc = filt(mono, bq('hp', 220, 0.7, 0, sr));
  const rnd = lcg(3);
  const step = Math.round(sr / 10);
  const smooth = 1 - Math.exp(-1 / (0.5 * sr));
  const wander = (baseMs) => {
    const out = new Float32Array(n);
    let tv = 0, cur = 0;
    for (let i = 0; i < n; i++) {
      if (i % step === 0) tv = rnd() * 2 - 1;
      cur += (tv - cur) * smooth;
      out[i] = ((baseMs + 1.2 * cur) / 1000) * sr;
    }
    return out;
  };
  const w1 = wander(17);
  const w2 = wander(23);
  const dg = dbToGain(-16) * amount;
  const pan = [
    [0.85, 0.15],
    [0.15, 0.85],
  ];
  return ch.map((c, ci) =>
    c.map((v, i) => v + pc[i] * pcg + chest[i] * chg + (readAt(dsrc, i - w1[i]) * pan[0][ci] + readAt(dsrc, i - w2[i]) * pan[1][ci]) * dg),
  );
}

// Room send: pre-filtered (HP 300 Hz, LP 7 kHz) so it neither muddies nor
// hisses, returned at -20 dB.
export function addRoom(ch, sr, { sendDb = -20 } = {}) {
  const ir = roomImpulse(sr, { seconds: 2.0, rt60: 1.6, predelayMs: 28 });
  const send = chain(monoOf(ch), [bq('hp', 300, 0.7, 0, sr), bq('lp', 7000, 0.7, 0, sr)]);
  const g = dbToGain(sendDb);
  return ch.map((c, ci) => {
    const wet = fftConvolve(send, ir[ci % 2]);
    return c.map((v, i) => v + wet[i] * g);
  });
}

// Wide presence lift, air shelf and optional 220 Hz body, level kept by RMS.
export function clarityEq(ch, sr, { presenceDb = 3.5, airDb = 2.5, bodyDb = 0 } = {}) {
  const ks = [bq('peak', 3000, 0.7, presenceDb, sr), bq('hs', 10000, 0.7, airDb, sr), bq('peak', 220, 0.8, bodyDb, sr)];
  const out = ch.map((c) => chain(c, ks));
  const g = rms(ch[0]) / (rms(out[0]) + 1e-12);
  return out.map((c) => c.map((v) => v * g));
}

export const VOCAL_DEFAULTS = { warm: 1, body: 1.5, clarity: true, presenceDb: 3.5, airDb: 2.5, clarityBodyDb: 1, room: true };

export function produceVocal(input, sr, opts = {}) {
  const o = { ...VOCAL_DEFAULTS, ...opts };
  const w = o.warm;
  const report = {};
  let x = toStereo(input);
  const dm = dynamicDemetal(x, sr);
  x = dm.channels;
  report.demetalCutDb = dm.meanCutDb;
  const gt = bleedGate(x, sr);
  x = gt.channels;
  report.gateClosedPct = gt.closedPct;
  // HPF 85 Hz (24 dB/oct), body/mud, box cut, presence, air; "warm" trades a
  // little edge and air for 200 Hz body.
  const eqs = [
    bq('hp', 85, 0.54, 0, sr),
    bq('hp', 85, 1.31, 0, sr),
    bq('peak', 200, 0.9, 1.5 * w, sr),
    bq('peak', 330, 1.2, -2.5 + 0.5 * w, sr),
    bq('peak', 650, 1.4, -1.5, sr),
    bq('peak', 3200, 0.8, 1.5 - 0.75 * w, sr),
    bq('peak', 4500, 2, -1.0 * w, sr),
    bq('hs', 11000, 0.7, 2.5 - 1.0 * w, sr),
  ];
  x = x.map((c) => chain(c, eqs));
  const ds = deEss(x, sr);
  x = ds.channels;
  report.deEssActivePct = ds.activePct;
  const cp = compress(x, sr);
  x = cp.channels;
  report.compGrDb = cp.avgGrDb;
  x = tape(x, 0.25 + 0.2 * w, sr);
  x = addBody(x, sr, o.body);
  if (o.room) x = addRoom(x, sr);
  if (o.clarity) x = clarityEq(x, sr, { presenceDb: o.presenceDb, airDb: o.airDb, bodyDb: o.clarityBodyDb });
  return { channels: x, report };
}
