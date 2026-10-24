// Smart per-stem mix plan: the moves a mix engineer makes on every session,
// decided from the stems themselves.
//   - high-pass each stem where its role stops needing low end;
//   - cut the low-mid build-up (the "boxy" 250–400 Hz region) when the stems
//     pile up there;
//   - open a pocket for the vocal: instruments that share the vocal's presence
//     region dip there, but only while the vocal is actually singing (a
//     dynamic EQ keyed from the vocal, the usual sidechain trick);
//   - de-ess the vocal, again only on the sibilant moments;
//   - send everything to one shared room so the stems sound recorded together.
// The time-varying parts are precomputed here as low-rate envelopes; the graph
// plays them as audio-rate modulators, so live playback and the offline render
// get exactly the same automation. Pure functions, no Web Audio dependency.
import { bandEnergy, clamp, peakFrequency } from './dsp.js';
import { applyBiquad, biquad } from './loudness.js';

export const ENV_RATE = 3000;

const HIGHPASS = { vocals: 90, drums: 30, bass: 30, guitar: 100, keys: 110, strings: 120, other: 80 };
const SEND = { vocals: 0.14, drums: 0.05, bass: 0, guitar: 0.11, keys: 0.12, strings: 0.14, other: 0.1 };
const POCKET_ROLES = new Set(['guitar', 'keys', 'strings', 'other']);

function monoOf(buffer) {
  const n = buffer.length;
  const out = new Float32Array(n);
  const ch = buffer.numberOfChannels;
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}

// Attack/release smoothing of a control signal sampled at `rate`.
function smooth(x, rate, attackMs, releaseMs) {
  const a = Math.exp(-1 / ((attackMs / 1000) * rate));
  const r = Math.exp(-1 / ((releaseMs / 1000) * rate));
  const out = new Float32Array(x.length);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    y = v > y ? a * y + (1 - a) * v : r * y + (1 - r) * v;
    out[i] = y;
  }
  return out;
}

// RMS in dB per hop of `hopMs`.
function levelsDb(x, sampleRate, hopMs) {
  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate));
  const n = Math.ceil(x.length / hop);
  const out = new Float32Array(n);
  for (let h = 0; h < n; h++) {
    let s = 0;
    const end = Math.min(x.length, (h + 1) * hop);
    for (let i = h * hop; i < end; i++) s += x[i] * x[i];
    out[h] = 10 * Math.log10(s / Math.max(1, end - h * hop) + 1e-12);
  }
  return { db: out, rate: 1000 / hopMs };
}

function percentile(arr, p) {
  const s = Float32Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

// Resample a control signal to ENV_RATE for `seconds` (linear interpolation).
function toEnvRate(x, rate, seconds) {
  const n = Math.max(1, Math.ceil(seconds * ENV_RATE));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i / ENV_RATE) * rate;
    const i0 = Math.min(x.length - 1, Math.floor(t));
    const i1 = Math.min(x.length - 1, i0 + 1);
    const f = t - i0;
    out[i] = x[i0] * (1 - f) + x[i1] * f;
  }
  return out;
}

// 0..1: how hard the vocal is singing. Silence and breaths stay at 0, so the
// pocket only opens under actual singing.
export function vocalActivity(buffer, seconds = buffer.duration ?? buffer.length / buffer.sampleRate) {
  const { db, rate } = levelsDb(monoOf(buffer), buffer.sampleRate, 10);
  const loud = percentile(db, 0.95);
  const gate = Math.max(loud - 24, -60);
  const act = new Float32Array(db.length);
  for (let i = 0; i < db.length; i++) act[i] = clamp((db[i] - gate) / 12, 0, 1);
  return toEnvRate(smooth(act, rate, 20, 300), rate, seconds);
}

// 0..1: how sibilant the vocal is right now — the share of energy above
// ~5 kHz, relative to how bright this voice usually is.
export function sibilance(buffer, seconds = buffer.duration ?? buffer.length / buffer.sampleRate) {
  const sr = buffer.sampleRate;
  const full = monoOf(buffer);
  const hi = full.slice();
  const hp = biquad('highpass', 5000, 0.707, 0, sr);
  applyBiquad(hi, hp);
  applyBiquad(hi, hp);
  const a = levelsDb(full, sr, 5);
  const b = levelsDb(hi, sr, 5);
  const loud = percentile(a.db, 0.95);
  const ratio = new Float32Array(a.db.length);
  for (let i = 0; i < ratio.length; i++) ratio[i] = a.db[i] > loud - 30 ? b.db[i] - a.db[i] : -60;
  const typical = percentile(ratio.filter((v) => v > -60), 0.5);
  const env = new Float32Array(ratio.length);
  for (let i = 0; i < ratio.length; i++) env[i] = clamp((ratio[i] - (typical + 6)) / 6, 0, 1);
  return toEnvRate(smooth(env, a.rate, 1, 60), a.rate, seconds);
}

// The plan for a session. `stems` are the loaded stems ({ id, role, buffer,
// analysis.sp }). Returns per-stem settings plus the shared envelopes.
export function planMix(stems) {
  if (!stems.length) return null;
  const seconds = stems.reduce((m, s) => Math.max(m, s.buffer.length / s.buffer.sampleRate), 0);
  const vocals = stems.filter((s) => s.role?.key === 'vocals');
  const lead = vocals[0] || null;

  // Where the vocal lives: its strongest presence frequency.
  const pocketHz = lead?.analysis?.sp ? clamp(peakFrequency(lead.analysis.sp, 1500, 4500), 1500, 4500) : null;
  const vocalEnv = lead ? vocalActivity(lead.buffer, seconds) : null;

  // Low-mid build-up of the whole session against its presence region.
  let lowMid = 0;
  let presence = 0;
  for (const s of stems) {
    if (!s.analysis?.sp) continue;
    lowMid += bandEnergy(s.analysis.sp, 220, 450) ** 2;
    presence += bandEnergy(s.analysis.sp, 1000, 4000) ** 2;
  }
  const muddiness = presence > 0 ? 10 * Math.log10(lowMid / presence) : 0;
  const mudCutDb = clamp((muddiness - 6) * 0.4, 0, 3);

  const perStem = {};
  for (const s of stems) {
    const role = s.role?.key || 'other';
    const sp = s.analysis?.sp;
    let pocket = null;
    if (vocalEnv && pocketHz && POCKET_ROLES.has(role) && sp) {
      // The more of this stem sits in the vocal's region, the deeper the dip.
      const share = bandEnergy(sp, pocketHz / 1.5, pocketHz * 1.5) / (bandEnergy(sp, 200, 8000) || 1e-9);
      pocket = { freq: pocketHz, depthDb: clamp(1.5 + share * 3, 1.5, 4) };
    }
    let deEss = null;
    if (role === 'vocals' && sp) {
      deEss = { freq: clamp(peakFrequency(sp, 5000, 10000), 5000, 10000), maxDb: 6, env: sibilance(s.buffer, seconds) };
    }
    perStem[s.id] = {
      role,
      highpassHz: HIGHPASS[role] ?? 80,
      mudCutDb: role === 'bass' || role === 'drums' ? 0 : mudCutDb,
      pocket,
      deEss,
      send: SEND[role] ?? 0.1,
      vocal: role === 'vocals',
    };
  }
  return { perStem, vocalEnv, pocketHz, mudCutDb, seconds };
}

// Stereo impulse response of a small, warm room: decorrelated decaying noise
// with a short pre-delay, darker as it decays. Built once per context.
export function roomImpulse(sampleRate, { seconds = 1.6, rt60 = 1.3, predelayMs = 18, seed = 7 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const pre = Math.round((predelayMs / 1000) * sampleRate);
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
  const decay = Math.log(1000) / (rt60 * sampleRate);
  const out = [new Float32Array(n), new Float32Array(n)];
  for (const ch of out) {
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = i - pre;
      // One-pole low-pass that closes as the tail decays.
      const k = 0.55 + 0.4 * Math.min(1, t / (0.6 * sampleRate));
      lp = k * lp + (1 - k) * rnd();
      ch[i] = lp * Math.exp(-decay * t);
    }
  }
  // Normalise to unit energy per channel so the send level means the same
  // whatever the room length.
  for (const ch of out) {
    let e = 0;
    for (let i = 0; i < n; i++) e += ch[i] * ch[i];
    const g = e > 0 ? 1 / Math.sqrt(e) : 1;
    for (let i = 0; i < n; i++) ch[i] *= g;
  }
  return out;
}
