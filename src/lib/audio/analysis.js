import { measure, computePeaks, spectrum, bandEnergy, peakFrequency, clamp, dbToGain, truePeakDb } from './dsp';
import { integratedLufs } from './loudness';

const ROLES = [
  { key: 'vocals', label: 'Vocal', test: /(vocal|vox|lead|voz|vozes)/i, gain: 0.94, pan: 0 },
  { key: 'drums', label: 'Bateria', test: /(drum|perc|kick|beat|bateria|snare|hi.?hat)/i, gain: 0.88, pan: 0 },
  { key: 'bass', label: 'Baixo', test: /(bass|baixo|sub|808|contrabaixo)/i, gain: 0.86, pan: 0 },
  { key: 'guitar', label: 'Guitarra', test: /(guitar|gtr|violao|violão)/i, gain: 0.8, pan: -0.18 },
  { key: 'keys', label: 'Teclas', test: /(piano|key|keys|synth|pad|organ|tecla|rhodes)/i, gain: 0.74, pan: 0.2 },
  { key: 'strings', label: 'Cordas', test: /(string|violin|cello|orchest|cordas|sax|brass|horn)/i, gain: 0.7, pan: 0.16 },
  { key: 'other', label: 'Outros', test: /.*/, gain: 0.72, pan: 0.12 },
];

export function guessRole(fileName = '') {
  const base = fileName.replace(/\.[^.]+$/, '');
  return ROLES.find((r) => r.test.test(base)) || ROLES[ROLES.length - 1];
}

// Relative harshness of the 2–6.5 kHz region against the 300–1200 Hz body.
// Metallic AI artefacts push this value up.
function harshnessFromSpectrum(sp) {
  const harsh = bandEnergy(sp, 2000, 6500);
  const mid = bandEnergy(sp, 300, 1200);
  const ratio = harsh / (mid || 1e-9);
  return { ratio, value: clamp((ratio - 0.3) / 0.45, 0, 1) };
}

export function analyzeStem(buffer) {
  const m = measure(buffer);
  const sp = spectrum(buffer, { fftSize: 2048, windows: 10 });
  const h = harshnessFromSpectrum(sp);
  return {
    peakDb: m.peakDb,
    truePeakDb: truePeakDb(buffer),
    rmsDb: m.rmsDb,
    crest: m.crest,
    lufs: integratedLufs(buffer, { maxSeconds: 45 }),
    harshRatio: h.ratio,
    harshness: h.value,
    harshFreq: clamp(peakFrequency(sp, 1600, 7000), 1800, 7000),
    sp,
    peaks: computePeaks(buffer, 420),
  };
}

export function harshnessOf(buffer) {
  return harshnessFromSpectrum(spectrum(buffer, { fftSize: 2048, windows: 12 })).value;
}

export function summarizeMix(stems) {
  const list = stems.filter((s) => s.analysis && s.analysis.sp);
  if (!list.length) return null;
  const n = list[0].analysis.sp.mag.length;
  const acc = new Float32Array(n);
  for (const s of list) {
    const m = s.analysis.sp.mag;
    for (let i = 0; i < n; i++) acc[i] += m[i];
  }
  const sp = { mag: acc, sampleRate: list[0].analysis.sp.sampleRate, fftSize: list[0].analysis.sp.fftSize };
  const h = harshnessFromSpectrum(sp);
  const rmsSum = list.reduce((a, s) => a + Math.pow(10, s.analysis.rmsDb / 10), 0);
  return {
    harshRatio: h.ratio,
    harshness: h.value,
    harshFreq: clamp(peakFrequency(sp, 1600, 7000), 1800, 7000),
    rmsDb: 10 * Math.log10(rmsSum),
    peakDb: Math.max(...list.map((s) => s.analysis.peakDb)),
    truePeakDb: Math.max(...list.map((s) => s.analysis.truePeakDb ?? s.analysis.peakDb)),
  };
}

export function autoMix(stems, { targetRmsDb = -21 } = {}) {
  const out = {};
  for (const s of stems) {
    const diff = clamp(targetRmsDb - s.analysis.rmsDb, -12, 10);
    out[s.id] = {
      gain: clamp(dbToGain(diff) * s.role.gain, 0.05, 2),
      pan: s.role.pan,
      muted: false,
    };
  }
  return out;
}

export function suggestedMaster(mix) {
  const h = mix ? mix.harshness : 0.4;
  return {
    deMetallic: clamp(0.3 + h * 0.62, 0.25, 0.9),
    warmth: clamp(0.5 - h * 0.22, 0.18, 0.6),
    width: h > 0.5 ? 1.05 : 1.18,
    // Tape comes in where the material is metallic and stays light when it is
    // already warm, so it always smooths rather than smears.
    tape: clamp(0.3 + h * 0.2, 0.25, 0.5),
  };
}

// Integrated loudness of a middle excerpt of the current mix, so the master
// starts from a real measured value rather than a guess.
export function excerptMixLufs(stems, mixParams, seconds = 40) {
  if (!stems.length) return -14;
  const sr = stems[0].buffer.sampleRate;
  const total = stems.reduce((m, s) => Math.max(m, s.buffer.length), 0);
  const full = seconds <= 0;
  const len = full ? total : Math.min(total, Math.round(seconds * sr));
  const start = full ? 0 : Math.max(0, Math.floor((total - len) / 2));
  const L = new Float32Array(len);
  const R = new Float32Array(len);

  for (const s of stems) {
    const p = mixParams[s.id] || { gain: 1, pan: 0, muted: false };
    if (p.muted) continue;
    const g = p.gain;
    const pan = clamp(p.pan, -1, 1);
    const gl = g * Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = g * Math.sin(((pan + 1) * Math.PI) / 4);
    const chL = s.buffer.getChannelData(0);
    const chR = s.buffer.numberOfChannels > 1 ? s.buffer.getChannelData(1) : chL;
    const n = Math.min(len, Math.max(0, chL.length - start));
    for (let i = 0; i < n; i++) {
      L[i] += chL[start + i] * gl;
      R[i] += chR[start + i] * gr;
    }
  }

  const pseudo = {
    numberOfChannels: 2,
    length: len,
    sampleRate: sr,
    getChannelData: (c) => (c === 0 ? L : R),
  };
  return integratedLufs(pseudo, { maxSeconds: full ? 0 : seconds, inPlace: true });
}

// What is actually inside the delivered files, before the auto-mix touches them.
export function unityMix(stems) {
  const out = {};
  for (const s of stems) out[s.id] = { gain: 1, pan: 0, muted: false };
  return out;
}

export function streamingCheck(lufs, peakDb, target = -14, ceiling = -1) {
  const delta = target - lufs;
  return {
    delta,
    lufsOk: Math.abs(delta) <= 0.5,
    peakOk: peakDb <= ceiling + 0.1,
  };
}