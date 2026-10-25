import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoMix, suggestedMaster } from './analysis.js';

test('suggestedMaster: follows the tonal balance of the song', () => {
  const base = { harshness: 0.36, metallic: null };
  const heavyDark = suggestedMaster({ ...base, lowDb: 15, airDb: -17 });
  const thinBright = suggestedMaster({ ...base, lowDb: 8, airDb: -10 });
  assert.ok(heavyDark.eq.sub < 0 && thinBright.eq.sub > 1, `${heavyDark.eq.sub} / ${thinBright.eq.sub}`);
  assert.ok(heavyDark.eq.air > 2 && thinBright.eq.air < 1, `${heavyDark.eq.air} / ${thinBright.eq.air}`);
  assert.ok(heavyDark.warmth < thinBright.warmth);
});

test('suggestedMaster: light de-metallic when the scan found no artefacts', () => {
  const clean = suggestedMaster({ harshness: 0.36, metallic: false });
  const metallic = suggestedMaster({ harshness: 0.36, metallic: true });
  assert.ok(clean.deMetallic < 0.3 && metallic.deMetallic > 0.5, `${clean.deMetallic} / ${metallic.deMetallic}`);
});

test('autoMix: a single finished mix stays centred', () => {
  const stem = (id, pan) => ({ id, role: { gain: 0.72, pan }, analysis: { rmsDb: -19 } });
  assert.equal(autoMix([stem('a', 0.12)]).a.pan, 0);
  assert.equal(autoMix([stem('a', 0.12), stem('b', -0.18)]).a.pan, 0.12);
});
