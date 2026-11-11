import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SR, rng } from '../repair/test-signals.js';
import { BLOOPER_KINDS, compileBloopers, estimateTempo, findPhrases, makeBloopers, pitchShift } from './generate.js';
import { checkPass, hashPass, normalizePass } from './gate.js';
import { integratedLufs } from '../loudness.js';
import { truePeakDb } from '../dsp.js';
import { asBuffer } from '../produce/filters.js';

// A "voice": sung phrases of 3 s at 220-330 Hz with 1 s rests.
function voice(seconds, seed = 4) {
  const r = rng(seed);
  const x = new Float32Array(Math.round(seconds * SR));
  for (let p = SR; p + 4 * SR < x.length; p += 4 * SR) {
    const f = 220 + 110 * r();
    for (let i = 0; i < 3 * SR; i++) {
      const env = Math.min(1, i / (0.03 * SR), (3 * SR - i) / (0.03 * SR));
      const t = i / SR;
      x[p + i] = 0.3 * env * (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t));
    }
  }
  return x;
}

// A "band": a kick-like thump on every beat at `bpm` plus soft noise.
function band(seconds, bpm, seed = 9) {
  const r = rng(seed);
  const x = Float32Array.from({ length: Math.round(seconds * SR) }, () => (r() * 2 - 1) * 0.02);
  const beat = (60 / bpm) * SR;
  for (let b = 0; b * beat < x.length; b++) {
    const s = Math.round(b * beat);
    for (let i = 0; i < 0.15 * SR && s + i < x.length; i++) {
      const t = i / SR;
      x[s + i] += 0.5 * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t * 30) + (r() * 2 - 1) * 0.3 * Math.exp(-t * 200);
    }
  }
  return x;
}

test('phrase onsets are found at the start of each sung phrase', () => {
  const v = voice(30);
  const p = findPhrases(v, SR).map((s) => s / SR);
  assert.ok(p.length >= 6, `${p.length} phrases`);
  for (const t of p) assert.ok(Math.abs(((t - 1) % 4 + 4) % 4) < 0.1 || Math.abs(((t - 1) % 4) - 4) < 0.1, `onset at ${t}`);
});

test('tempo of a steady beat', () => {
  for (const bpm of [92, 120, 140]) {
    const got = estimateTempo(band(20, bpm), SR);
    assert.ok(Math.abs(got - bpm) < 3, `${bpm} -> ${got}`);
  }
});

test('pitch shift by an octave doubles the frequency and keeps the length', () => {
  const n = SR;
  const x = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 300 * i) / SR));
  const y = pitchShift(x, SR, () => 2);
  assert.equal(y.length, n);
  // Zero crossings in the steady middle.
  let zc = 0;
  for (let i = SR / 4; i < (3 * SR) / 4; i++) if (y[i - 1] < 0 && y[i] >= 0) zc++;
  assert.ok(Math.abs(zc / 0.5 - 600) < 40, `${zc / 0.5} Hz`);
});

test('stems give every kind of blooper, short, at -16 LUFS and under -1 dBTP', () => {
  const v = voice(70);
  const b = band(70, 100);
  const { bpm, bloopers } = makeBloopers({ vocal: [v, v], backing: [b, b], sampleRate: SR }, { count: 14, seed: 3 });
  assert.ok(Math.abs(bpm - 100) < 3, `bpm ${bpm}`);
  const kinds = new Set(bloopers.map((x) => x.kind));
  assert.equal(kinds.size, BLOOPER_KINDS.length, [...kinds].join(','));
  for (const x of bloopers) {
    const sec = x.channels[0].length / SR;
    assert.ok(sec > 2.5 && sec < 12, `${x.kind} ${sec.toFixed(1)} s`);
    const buf = asBuffer(x.channels, SR);
    assert.ok(Math.abs(integratedLufs(buf) + 16) < 0.6, `${x.kind} ${integratedLufs(buf).toFixed(1)} LUFS`);
    assert.ok(truePeakDb(buf) <= -0.9, `${x.kind} tp ${truePeakDb(buf).toFixed(2)}`);
    assert.ok(x.channels.every((c) => c.every(Number.isFinite)));
  }
  const reel = compileBloopers(bloopers.slice(0, 3), SR);
  const parts = bloopers.slice(0, 3).reduce((s, x) => s + x.channels[0].length, 0);
  assert.ok(reel[0].length > parts);
});

test('a single mixed song skips the kinds that need a separate voice', () => {
  const v = voice(60);
  const b = band(60, 120);
  const mix = Float32Array.from(v, (s, i) => s + b[i]);
  const { bloopers } = makeBloopers({ mix: [mix, mix], sampleRate: SR }, { count: 10, seed: 5 });
  assert.ok(bloopers.length >= 4);
  const needVocal = new Set(BLOOPER_KINDS.filter((k) => k.needsVocal).map((k) => k.key));
  assert.ok(bloopers.every((x) => !needVocal.has(x.kind)));
});

test('same seed, same bloopers; another seed, others', () => {
  const v = voice(50);
  const b = band(50, 110);
  const run = (seed) => makeBloopers({ vocal: [v], backing: [b], sampleRate: SR }, { count: 3, seed }).bloopers.map((x) => `${x.kind}@${x.start}`).join();
  assert.equal(run(1), run(1));
  assert.notEqual(run(1), run(2));
});

test('passphrase gate: hash round trip, typing is forgiving, wrong pass fails', async () => {
  const salt = '00112233445566778899aabbccddeeff';
  const gate = `${salt}:${await hashPass('gelo-ABCD-EFGH', salt)}`;
  assert.equal(normalizePass(' gelo - abcd-efgh '), 'GELO-ABCD-EFGH');
  assert.ok(await checkPass('gelo-abcd-efgh', gate));
  assert.ok(!(await checkPass('gelo-abcd-efgx', gate)));
  assert.ok(!(await checkPass('', gate)));
});
