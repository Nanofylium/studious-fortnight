// Bloopers: short "recording mistake" clips made from the session's own song.
// Each one starts a little before a sung phrase and goes wrong on purpose:
// an early entry after the count-in, a sour take, a voice crack, monitor
// feedback, a dragged phrase, a bumped mic or a tape that warps and stops.
// Everything is plain DSP on Float32Arrays, so it runs in the browser and in
// node tests alike.
import { asBuffer, bq, filt, lcg, monoOf, readAt, toStereo } from '../produce/filters.js';
import { masterTo } from '../produce/mixdown.js';

export const BLOOPER_KINDS = [
  { key: 'falsa-largada', title: 'Entrei antes da hora', needsVocal: false },
  { key: 'desafinou', title: 'Desafinou feio', needsVocal: false },
  { key: 'voz-falhou', title: 'A voz falhou', needsVocal: true },
  { key: 'microfonia', title: 'O retorno microfonou', needsVocal: false },
  { key: 'atravessou', title: 'Atravessei o tempo', needsVocal: true },
  { key: 'mic-bateu', title: 'Bati no microfone', needsVocal: false },
  { key: 'fita', title: 'A fita enrolou', needsVocal: false },
];

const FRAME = 0.05; // seconds per activity frame

// ---------------------------------------------------------------- analysis

// Phrase onsets of a voice (or a full mix): frames over a level threshold
// that follow at least `quiet` seconds under it and stay sung for at least
// `minLen` seconds. Returns sample positions, earliest first.
export function findPhrases(mono, sr, { quiet = 0.35, minLen = 1.5 } = {}) {
  const hop = Math.round(FRAME * sr);
  const frames = Math.floor(mono.length / hop);
  const lev = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) e += mono[i] * mono[i];
    lev[f] = Math.sqrt(e / hop);
  }
  const sorted = Array.from(lev).sort((a, b) => a - b);
  const loud = sorted[Math.floor(frames * 0.9)] || 0;
  if (loud <= 1e-5) return [];
  const thr = loud * 0.18;
  const needQuiet = Math.round(quiet / FRAME);
  const needLen = Math.round(minLen / FRAME);
  const out = [];
  let quietRun = needQuiet; // the start of the song counts as quiet
  for (let f = 0; f < frames; f++) {
    if (lev[f] < thr) {
      quietRun++;
      continue;
    }
    if (quietRun >= needQuiet) {
      let on = 0;
      for (let g = f; g < Math.min(frames, f + needLen); g++) if (lev[g] >= thr) on++;
      if (on >= needLen * 0.7) out.push(f * hop);
    }
    quietRun = 0;
  }
  return out;
}

// Tempo from the autocorrelation of an onset envelope (10 ms frames), searched
// between 70 and 160 BPM with a mild preference for the middle of the range.
export function estimateTempo(mono, sr) {
  const hop = Math.round(0.01 * sr);
  const frames = Math.floor(mono.length / hop);
  if (frames < 400) return 100;
  const hp = filt(mono, bq('hp', 1500, 0.7, 0, sr));
  const env = new Float32Array(frames);
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) e += Math.abs(hp[i]) + 0.3 * Math.abs(mono[i]);
    env[f] = Math.max(0, e - prev);
    prev = e;
  }
  let mean = 0;
  for (const v of env) mean += v;
  mean /= frames;
  for (let f = 0; f < frames; f++) env[f] -= mean;
  let best = 100;
  let bestScore = -Infinity;
  for (let bpm = 70; bpm <= 160; bpm += 0.5) {
    const lag = 6000 / bpm; // frames per beat
    let s = 0;
    for (let f = 0; f + lag * 2 + 1 < frames; f++) s += env[f] * (readAt(env, f + lag) + 0.5 * readAt(env, f + 2 * lag));
    s *= 1 - 0.15 * Math.abs(Math.log2(bpm / 105));
    if (s > bestScore) {
      bestScore = s;
      best = bpm;
    }
  }
  return best;
}

// ---------------------------------------------------------------- effects

const zeros = (n) => [new Float32Array(n), new Float32Array(n)];

function cut(ch, from, to) {
  return ch.map((c) => {
    const o = new Float32Array(Math.max(0, to - from));
    for (let i = 0; i < o.length; i++) {
      const j = from + i;
      o[i] = j >= 0 && j < c.length ? c[j] : 0;
    }
    return o;
  });
}

// Raised-cosine gain ramp over [a, b) from g0 to g1, then g1 to the end.
function ramp(ch, a, b, g0, g1) {
  for (const c of ch) {
    for (let i = Math.max(0, a); i < c.length; i++) {
      const t = i >= b ? 1 : (i - a) / Math.max(1, b - a);
      c[i] *= g0 + (g1 - g0) * (0.5 - 0.5 * Math.cos(Math.PI * t));
    }
  }
  return ch;
}

const silenceFrom = (ch, at, fade) => ramp(ch, at, at + fade, 1, 0);

function mute(ch, a, b) {
  for (const c of ch) c.fill(0, Math.max(0, a), Math.min(c.length, b));
  return ch;
}

function addInto(dst, src, offset = 0, gain = 1) {
  for (let c = 0; c < 2; c++) {
    const d = dst[c];
    const s = src[c % src.length];
    for (let i = 0; i < s.length; i++) {
      const j = i + offset;
      if (j >= 0 && j < d.length) d[j] += s[i] * gain;
    }
  }
  return dst;
}

// Time-preserving pitch shift with two crossfaded delay taps (the rotating
// tape-head shifter). `ratioAt(i)` gives the pitch ratio at sample i, so the
// pitch can drift; the slight grain it leaves suits a bad take.
export function pitchShift(x, sr, ratioAt, windowSec = 0.045) {
  const W = Math.round(windowSec * sr);
  const y = new Float32Array(x.length);
  let ph = 0;
  for (let i = 0; i < x.length; i++) {
    ph += (1 - ratioAt(i)) / W;
    ph -= Math.floor(ph);
    const ph2 = (ph + 0.5) % 1;
    const w1 = Math.sin(Math.PI * ph) ** 2;
    const w2 = Math.sin(Math.PI * ph2) ** 2;
    y[i] = readAt(x, i - ph * W) * w1 + readAt(x, i - ph2 * W) * w2;
  }
  return y;
}

// Reads `ch` at a varying speed (1 = normal) starting at `from`; returns `n`
// samples. Speed 0 holds, which with the fade gives the tape-stop sound.
function varispeed(ch, from, n, speedAt) {
  return ch.map((c) => {
    const o = new Float32Array(n);
    let pos = from;
    for (let i = 0; i < n; i++) {
      o[i] = readAt(c, pos);
      pos += speedAt(i);
    }
    return o;
  });
}

// Tape stop from sample `at`: the rest of the clip slows to a halt over
// `seconds` and the output after that is silent.
function tapeStop(ch, at, seconds, sr) {
  const n = Math.round(seconds * sr);
  const slowed = varispeed(ch, at, n, (i) => (1 - i / n) ** 1.6);
  return ch.map((c, k) => {
    const o = new Float32Array(at + n + Math.round(0.35 * sr));
    o.set(c.subarray(0, Math.min(at, c.length)));
    const s = slowed[k];
    for (let i = 0; i < n; i++) o[at + i] = s[i] * (1 - (i / n) ** 3);
    return o;
  });
}

// Stick click for the count-in: a short tick with a woody body.
function stickClick(sr, accent, rnd) {
  const n = Math.round(0.06 * sr);
  const o = new Float32Array(n);
  const f = accent ? 2100 : 1700;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    o[i] = (Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 90) + (rnd() * 2 - 1) * Math.exp(-t * 260) * 0.6) * (accent ? 0.5 : 0.36);
  }
  return o;
}

// Low thump plus a burst of handling noise: a hand hitting the mic stand.
function micBump(sr, rnd) {
  const n = Math.round(0.7 * sr);
  const noise = Float32Array.from({ length: n }, () => rnd() * 2 - 1);
  const lp = filt(filt(noise, bq('lp', 380, 0.7, 0, sr)), bq('lp', 380, 0.7, 0, sr));
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    o[i] = 0.75 * Math.sin(2 * Math.PI * (48 + 30 * Math.exp(-t * 30)) * t) * Math.exp(-t * 9) + 1.8 * lp[i] * Math.exp(-t * 6);
  }
  return [o, o.slice()];
}

// Monitor feedback: a tone that swells exponentially with a little vibrato
// and a second partial creeping in.
function feedback(sr, seconds, rnd) {
  const n = Math.round(seconds * sr);
  const f = 2300 + rnd() * 900;
  const o = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    ph += (2 * Math.PI * f * (1 + 0.004 * Math.sin((2 * Math.PI * 5.5 * i) / sr))) / sr;
    const amp = 0.55 * (Math.exp(4.6 * t) - 1) / (Math.exp(4.6) - 1);
    o[i] = amp * (Math.sin(ph) + 0.18 * t * Math.sin(2.003 * ph));
  }
  return [o, o.slice()];
}

// Very quiet room tone so the cuts land on "air", not digital silence.
function roomTone(n, sr, rnd) {
  const w = Float32Array.from({ length: n }, () => (rnd() * 2 - 1) * 0.0016);
  const y = filt(filt(w, bq('lp', 2500, 0.7, 0, sr)), bq('hp', 60, 0.7, 0, sr));
  return [y, filt(w.map((v, i) => w[(i * 7919) % n]), bq('lp', 2500, 0.7, 0, sr))];
}

const cents = (c) => 2 ** (c / 1200);
const beatSamples = (bpm, sr) => Math.round((60 / bpm) * sr);

// ---------------------------------------------------------------- bloopers

// vocal and backing are stereo arrays of the same length (backing all zeros
// when there is no separate voice). t0 is the phrase onset in samples.
const BUILDERS = {
  'falsa-largada'({ vocal, backing, t0, sr, beat, rnd }) {
    const pre = beat * 4 + Math.round(0.3 * sr);
    const early = Math.round(beat * (0.35 + 0.2 * rnd()));
    const len = pre + Math.round(2.6 * sr);
    const back = cut(backing, t0 - pre, t0 - pre + len);
    const voc = cut(vocal, t0 - pre + early, t0 - pre + early + len);
    const stopAt = pre - early + Math.round(1.3 * sr);
    silenceFrom(voc, stopAt, Math.round(0.012 * sr));
    const out = addInto(back, voc);
    const hasBacking = backing[0].some((v) => v !== 0);
    // With no separate voice the clip is the whole mix: count in over silence.
    if (!hasBacking) mute(out, 0, pre - early);
    for (let k = 0; k < 4; k++) {
      const click = stickClick(sr, k === 0, rnd);
      addInto(out, [click, click], Math.round(0.3 * sr) + k * beat);
    }
    return tapeStop(out, stopAt + Math.round(0.35 * sr), 0.8, sr);
  },

  desafinou({ vocal, backing, t0, sr, rnd }) {
    const pre = Math.round(1.4 * sr);
    const len = pre + Math.round((4.2 + rnd()) * sr);
    const back = cut(backing, t0 - pre, t0 - pre + len);
    const voc = cut(vocal, t0 - pre, t0 - pre + len);
    const start = -(45 + 25 * rnd());
    const end = 35 + 30 * rnd();
    const ratio = (i) => {
      const t = Math.max(0, (i - pre) / (len - pre));
      return cents(start + (end - start) * t * t + 28 * Math.sin((2 * Math.PI * 5.2 * i) / sr) * t);
    };
    const sour = voc.map((c) => pitchShift(c, sr, ratio));
    const out = addInto(back, sour);
    // Someone hits stop in the booth.
    return silenceFrom(out, len - Math.round(0.4 * sr), Math.round(0.006 * sr));
  },

  'voz-falhou'({ vocal, backing, t0, sr, rnd }) {
    const pre = Math.round(1.4 * sr);
    const len = pre + Math.round(5 * sr);
    const back = cut(backing, t0 - pre, t0 - pre + len);
    const voc = cut(vocal, t0 - pre, t0 - pre + len);
    // The crack goes on the loudest moment 1-3.5 s into the phrase.
    const m = monoOf(voc);
    const hop = Math.round(0.05 * sr);
    let at = pre + sr;
    let best = 0;
    for (let i = pre + sr; i < pre + 3.5 * sr - hop; i += hop) {
      let e = 0;
      for (let j = i; j < i + hop; j++) e += m[j] * m[j];
      if (e > best) {
        best = e;
        at = i;
      }
    }
    const crackLen = Math.round((0.18 + 0.08 * rnd()) * sr);
    const jump = 12 * (0.85 + 0.15 * rnd());
    const ratio = (i) => (i >= at && i < at + crackLen ? cents(jump * 100 * Math.min(1, (i - at) / (0.015 * sr))) : 1);
    const cracked = voc.map((c) => {
      const y = pitchShift(c, sr, ratio, 0.03);
      for (let i = at; i < at + crackLen && i < y.length; i++) y[i] *= 0.65 + 0.35 * Math.sin((2 * Math.PI * 23 * (i - at)) / sr);
      return y;
    });
    silenceFrom(cracked, at + crackLen, Math.round(0.03 * sr));
    const out = addInto(back, cracked);
    return ramp(out, at + crackLen + Math.round(1.1 * sr), at + crackLen + Math.round(1.8 * sr), 1, 0).map((c) =>
      c.subarray(0, Math.min(c.length, at + crackLen + Math.round(2 * sr))),
    );
  },

  microfonia({ vocal, backing, t0, sr, rnd }) {
    const pre = Math.round(1.4 * sr);
    const fbAt = pre + Math.round((1.6 + rnd()) * sr);
    const fbLen = Math.round((1.2 + 0.5 * rnd()) * sr);
    const len = fbAt + fbLen;
    const out = addInto(cut(backing, t0 - pre, t0 - pre + len), cut(vocal, t0 - pre, t0 - pre + len));
    addInto(out, feedback(sr, fbLen / sr, rnd), fbAt);
    const end = Math.round(0.4 * sr);
    return out.map((c) => {
      const o = new Float32Array(len + end);
      o.set(c);
      for (let i = len - Math.round(0.004 * sr); i < len; i++) o[i] *= (len - i) / (0.004 * sr);
      return o;
    });
  },

  atravessou({ vocal, backing, t0, sr, beat, rnd }) {
    const pre = Math.round(1.4 * sr);
    const len = pre + Math.round(4.5 * sr);
    const back = cut(backing, t0 - pre, t0 - pre + len);
    // The voice falls further behind as the phrase goes on.
    const lag0 = beat * 0.12;
    const lag1 = beat * (0.4 + 0.15 * rnd());
    const speed = 1 - (lag1 - lag0) / len;
    // Read slower to fall behind, then shift the pitch back up so only the
    // timing is off.
    const late = varispeed(vocal, t0 - pre - lag0, len, () => speed).map((c) => pitchShift(c, sr, () => 1 / speed));
    const out = addInto(back, late);
    return tapeStop(out, len - Math.round(0.9 * sr), 0.9, sr);
  },

  'mic-bateu'({ vocal, backing, t0, sr, rnd }) {
    const pre = Math.round(1.4 * sr);
    const hit = pre + Math.round((1.3 + 0.8 * rnd()) * sr);
    const len = hit + Math.round(2.2 * sr);
    const back = cut(backing, t0 - pre, t0 - pre + len);
    const voc = cut(vocal, t0 - pre, t0 - pre + len);
    // After the hit the singer is off-axis: duller and quieter, then stops.
    const off = voc.map((c) => filt(c.subarray(hit), bq('lp', 1800, 0.7, 0, sr)));
    for (let k = 0; k < 2; k++) {
      for (let i = 0; i < off[k].length; i++) voc[k][hit + i] = off[k][i] * 0.3;
    }
    silenceFrom(voc, hit + Math.round(0.8 * sr), Math.round(0.05 * sr));
    const out = addInto(back, voc);
    addInto(out, micBump(sr, rnd), hit, 0.9);
    return ramp(out, hit + Math.round(1.3 * sr), len, 1, 0);
  },

  fita({ vocal, backing, t0, sr, rnd }) {
    const pre = Math.round(1.4 * sr);
    const len = pre + Math.round(4.2 * sr);
    const mix = addInto(cut(backing, t0 - pre - sr, t0 - pre + len + 2 * sr), cut(vocal, t0 - pre - sr, t0 - pre + len + 2 * sr));
    // Wow that deepens, a few flutter dips, then the tape stops.
    const f = 0.6 + 0.4 * rnd();
    const speed = (i) => {
      const t = i / len;
      return 1 + t * t * (0.05 * Math.sin((2 * Math.PI * f * i) / sr) + 0.012 * Math.sin((2 * Math.PI * 9 * i) / sr));
    };
    const warped = varispeed(mix, sr, len, speed);
    return tapeStop(warped, len - Math.round(1.1 * sr), 1.1, sr);
  },
};

// Gaps between phrases picked so the clips don't overlap.
function pickPhrases(phrases, count, minGap, rnd) {
  const pool = phrases.slice();
  const out = [];
  while (pool.length && out.length < count) {
    const k = Math.floor(rnd() * pool.length);
    const p = pool.splice(k, 1)[0];
    if (out.every((q) => Math.abs(q - p) >= minGap)) out.push(p);
  }
  return out;
}

// vocal: the voice stem(s), stereo, or null for a single full mix.
// backing: everything else summed, stereo (ignored when vocal is null and mix
// is given). Returns the clips mastered to -16 LUFS / -1 dBTP.
export function makeBloopers({ vocal = null, backing = null, mix = null, sampleRate: sr }, { count = 5, seed = 1, kinds = null } = {}) {
  const rnd = lcg(seed * 7919 + 13);
  let voc;
  let back;
  if (vocal) {
    voc = toStereo(vocal);
    back = backing ? toStereo(backing) : zeros(voc[0].length);
  } else {
    voc = toStereo(mix || backing);
    back = zeros(voc[0].length);
  }
  const n = Math.min(voc[0].length, back[0].length);
  voc = voc.map((c) => c.subarray(0, n));
  back = back.map((c) => c.subarray(0, n));

  const vocMono = monoOf(voc);
  const bpm = estimateTempo(vocal ? monoOf(back.map((c, k) => c.map((v, i) => v + 0.3 * voc[k][i]))) : vocMono, sr);
  const beat = beatSamples(bpm, sr);
  // Phrases that leave room for the longest pre-roll and clip.
  let phrases = findPhrases(vocMono, sr).filter((p) => p > beat * 4 + 0.4 * sr && p < n - 7 * sr);
  if (!phrases.length) {
    // No clear phrase starts (dense mix): fall back to evenly spaced points.
    for (let p = Math.round(8 * sr); p < n - 8 * sr; p += Math.round(12 * sr)) phrases.push(p);
  }
  if (!phrases.length) return { bpm, bloopers: [] };

  const allowed = BLOOPER_KINDS.filter((k) => (vocal || !k.needsVocal) && (!kinds || kinds.includes(k.key)));
  const order = allowed.slice().sort(() => rnd() - 0.5);
  const want = Math.min(count, order.length * 2);
  const picked = pickPhrases(phrases, want, 6 * sr, rnd);
  // Few clear phrase starts (short excerpt, through-sung song): top up with
  // other points of the song, 2 s apart.
  if (picked.length < want) {
    const extra = [];
    const lo = beat * 4 + Math.round(0.4 * sr);
    for (let p = lo; p < n - 7 * sr; p += Math.round(2 * sr)) extra.push(p);
    picked.push(...pickPhrases(extra.filter((p) => picked.every((q) => Math.abs(q - p) >= 6 * sr)), want - picked.length, 6 * sr, rnd));
  }
  const bloopers = picked.map((t0, idx) => {
    const kind = order[idx % order.length];
    const body = BUILDERS[kind.key]({ vocal: voc, backing: back, t0, sr, beat, rnd });
    const room = roomTone(body[0].length, sr, rnd);
    const ch = addInto(body.map((c) => Float32Array.from(c)), room);
    masterTo(ch, sr, { targetLufs: -16, ceilingDb: -1 });
    return { kind: kind.key, title: kind.title, start: t0 / sr, channels: ch };
  });
  bloopers.sort((a, b) => a.start - b.start);
  bloopers.forEach((b, k) => (b.take = k + 1));
  return { bpm, bloopers };
}

// Rewind sound: the end of a clip played backwards at speed, thin and quiet.
function rewind(ch, sr) {
  const n = Math.round(0.55 * sr);
  const from = ch[0].length - 1;
  const r = varispeed(ch, from, n, (i) => -(2 + 9 * Math.sin((Math.PI * i) / n)));
  return r.map((c) => {
    const y = filt(filt(c, bq('hp', 500, 0.7, 0, sr)), bq('lp', 6000, 0.7, 0, sr));
    for (let i = 0; i < n; i++) y[i] *= 0.4 * Math.sin((Math.PI * i) / n);
    return y;
  });
}

// One file with every clip: clip, rewind, a breath of room, next clip.
export function compileBloopers(bloopers, sr) {
  const gap = Math.round(0.25 * sr);
  const parts = [];
  bloopers.forEach((b, k) => {
    parts.push(b.channels);
    if (k < bloopers.length - 1) parts.push(rewind(b.channels, sr), zeros(gap));
  });
  const total = parts.reduce((s, p) => s + p[0].length, 0);
  const out = zeros(total);
  let at = 0;
  for (const p of parts) {
    addInto(out, p, at);
    at += p[0].length;
  }
  return out;
}

export const blooperBuffer = (b, sr) => asBuffer(b.channels, sr);
