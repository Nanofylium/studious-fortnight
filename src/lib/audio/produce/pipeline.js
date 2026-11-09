// "Produção completa": the offline chain that made the Spotify masters,
// inside the app. Vocal stems are summed and go through the vocal chain
// (optionally matched to a reference voice), the other stems are summed into
// the instrumental chain, and both are mixed and mastered to -14 LUFS / -1 dBTP.
import { integratedLufs } from '../loudness.js';
import { asBuffer, toStereo } from './filters.js';
import { produceVocal } from './vocal.js';
import { produceInstrumental } from './instrumental.js';
import { applyVoiceMatch } from './voicematch.js';
import { masterTo, mixdown } from './mixdown.js';
import { metallicIndex } from './spectral.js';

export const PRODUCE_DEFAULTS = {
  warm: 1,
  body: 1.5,
  clarity: true,
  analog: false,
  voiceMatch: 0.75,
  targetLufs: -14,
  ceilingDb: -1,
};

function sumStems(list) {
  if (!list.length) return null;
  const st = list.map(toStereo);
  const L = Math.max(...st.map((s) => s[0].length));
  return [0, 1].map((ci) => {
    const o = new Float32Array(L);
    for (const s of st) {
      const c = s[ci];
      for (let i = 0; i < c.length; i++) o[i] += c[i];
    }
    return o;
  });
}

const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

// `vocals` and `others` are lists of channel arrays; `referenceLtas` is the
// output of ltas() on a reference voice, or null.
export function produceSong({ vocals = [], others = [], sampleRate: sr, referenceLtas = null }, options = {}, onStage = () => {}) {
  const o = { ...PRODUCE_DEFAULTS, ...options };
  const report = {};
  const vocalSrc = sumStems(vocals);
  const instSrc = sumStems(others);
  if (!vocalSrc && !instSrc) throw new Error('nenhum stem para produzir');

  let vocal = null;
  let vocalTargetLufs = null;
  if (vocalSrc) {
    onStage('voz');
    vocalTargetLufs = integratedLufs(asBuffer(vocalSrc, sr));
    const metalBefore = metallicIndex(vocalSrc, sr);
    const v = produceVocal(vocalSrc, sr, o);
    vocal = v.channels;
    report.vocal = { ...v.report, metallicBefore: round(metalBefore, 3) };
    if (referenceLtas && o.voiceMatch > 0) {
      onStage('dna');
      const m = applyVoiceMatch(vocal, sr, referenceLtas, { strength: o.voiceMatch });
      vocal = m.channels;
      report.voiceMatch = m.curve;
    }
    report.vocal.metallicAfter = round(metallicIndex(vocal, sr), 3);
  }
  let instrumental = null;
  if (instSrc) {
    onStage('instrumental');
    const r = produceInstrumental(instSrc, sr);
    instrumental = r.channels;
    report.instrumental = { ...r.report, metallicBefore: round(metallicIndex(instSrc, sr), 3), metallicAfter: round(metallicIndex(instrumental, sr), 3) };
  }
  onStage('mix');
  const mx = mixdown({ vocal, vocalTargetLufs, instrumental }, sr, { analog: o.analog });
  report.glueDb = round(mx.glueDb);
  onStage('master');
  const m = masterTo(mx.channels, sr, { targetLufs: o.targetLufs, ceilingDb: o.ceilingDb });
  report.lufs = round(m.lufs, 2);
  report.truePeakDb = round(m.truePeakDb, 2);
  return { channels: mx.channels, report };
}
