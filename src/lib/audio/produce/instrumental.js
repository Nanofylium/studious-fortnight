// Instrumental production chain: a milder dynamic de-metal only in 4–14 kHz
// (cymbal and hat swirl; real tonal partials pass the high threshold), then
// warmth (220 Hz body, a touch of low-mid fullness, softer top) and tape. The
// loudness of the input is kept, so the mixdown balance stays meaningful.
import { dbToGain } from '../dsp.js';
import { integratedLufs } from '../loudness.js';
import { asBuffer, bq, chain, scale, tape, toStereo } from './filters.js';
import { dynamicDemetal } from './spectral.js';

export function produceInstrumental(input, sr, { warmth = 1 } = {}) {
  const src = toStereo(input);
  const dm = dynamicDemetal(src, sr, { thrDb: 8, ratio: 0.5, maxCut: 6, relMs: 80, lo: 4000, hi: 14000 });
  const eqs = [bq('peak', 220, 0.8, 1.2 * warmth, sr), bq('peak', 450, 1.0, 0.4 * warmth, sr), bq('hs', 9000, 0.7, -1.0 * warmth, sr)];
  let x = dm.channels.map((c) => chain(c, eqs));
  x = tape(x, 0.3 * warmth, sr);
  const before = integratedLufs(asBuffer(src, sr));
  const after = integratedLufs(asBuffer(x, sr));
  if (Number.isFinite(before) && Number.isFinite(after)) scale(x, dbToGain(before - after));
  return { channels: x, report: { demetalCutDb: dm.meanCutDb } };
}
