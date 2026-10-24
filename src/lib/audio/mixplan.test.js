import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENV_RATE, planMix, roomImpulse, sibilance, vocalActivity } from './mixplan.js';
import { spectrum } from './dsp.js';
import { SR, makeBuffer, noise, rng, song } from './repair/test-signals.js';

// A "singer": a harmonic tone around 2.8 kHz-rich formant for `on` seconds,
// silent between phrases, with an "s" (noise above 6 kHz) at given times.
function voice(seconds, phrases, esses = []) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  for (const [a, b] of phrases) {
    const i0 = Math.round(a * SR);
    const i1 = Math.min(n, Math.round(b * SR));
    for (let i = i0; i < i1; i++) {
      const t = (i - i0) / SR;
      const env = Math.min(1, t / 0.02, (i1 - i) / (0.02 * SR));
      let s = 0;
      for (let h = 1; h <= 20; h++) {
        const f = 220 * h;
        // Formant bump around 2.6 kHz.
        const amp = (0.08 / h) * (1 + 6 * Math.exp(-(((f - 2640) / 500) ** 2)));
        s += amp * Math.sin(2 * Math.PI * f * t);
      }
      x[i] = env * s;
    }
  }
  const r = rng(11);
  for (const at of esses) {
    const i0 = Math.round(at * SR);
    const len = Math.round(0.08 * SR);
    let prev = 0;
    for (let i = 0; i < len && i0 + i < n; i++) {
      const w = r() * 2 - 1;
      // First difference pushes the noise toward the top octave.
      x[i0 + i] += 0.25 * (w - prev) * Math.sin((Math.PI * i) / len);
      prev = w;
    }
  }
  return x;
}

const stem = (id, key, data) => {
  const buffer = makeBuffer([data]);
  return { id, role: { key }, buffer, analysis: { sp: spectrum(buffer, { fftSize: 2048, windows: 10 }) } };
};

const at = (env, t) => env[Math.round(t * ENV_RATE)];

test('vocalActivity: up while singing, down in the gaps', () => {
  const x = voice(6, [
    [0.5, 2],
    [3.5, 5],
  ]);
  const env = vocalActivity(makeBuffer([x]));
  assert.equal(env.length, Math.ceil(6 * ENV_RATE));
  for (const t of [1, 1.5, 4, 4.7]) assert.ok(at(env, t) > 0.8, `singing at ${t}s: ${at(env, t)}`);
  for (const t of [0.2, 2.9, 5.8]) assert.ok(at(env, t) < 0.1, `gap at ${t}s: ${at(env, t)}`);
});

test('sibilance: peaks on the "s", quiet on vowels', () => {
  const x = voice(4, [[0.2, 3.8]], [1.0, 2.5]);
  const env = sibilance(makeBuffer([x]));
  assert.ok(at(env, 1.04) > 0.6 && at(env, 2.54) > 0.6, `on s: ${at(env, 1.04)}, ${at(env, 2.54)}`);
  for (const t of [0.6, 1.7, 3.3]) assert.ok(at(env, t) < 0.1, `vowel at ${t}s: ${at(env, t)}`);
});

test('planMix: roles get their high-pass, sends, pocket and de-esser', () => {
  const seconds = 4;
  const n = seconds * SR;
  const v = voice(seconds, [[0.3, 3.7]], [2]);
  const guitar = song(seconds, 3);
  const bass = new Float32Array(n);
  for (let i = 0; i < n; i++) bass[i] = 0.3 * Math.sin((2 * Math.PI * 55 * i) / SR);
  const drums = noise(n, 9).map((s, i) => s * 0.2 * Math.exp(-((i % (SR / 2)) / (0.03 * SR))));
  const plan = planMix([stem('v', 'vocals', v), stem('g', 'guitar', guitar), stem('b', 'bass', bass), stem('d', 'drums', drums)]);

  assert.ok(plan.pocketHz > 2200 && plan.pocketHz < 3100, `pocket at ${plan.pocketHz}`);
  assert.equal(plan.vocalEnv.length, Math.ceil(seconds * ENV_RATE));

  const { v: pv, g: pg, b: pb, d: pd } = plan.perStem;
  assert.equal(pv.highpassHz, 90);
  assert.equal(pb.highpassHz, 30);
  assert.equal(pg.highpassHz, 100);
  assert.ok(pv.vocal && pv.deEss && pv.deEss.env.length === plan.vocalEnv.length);
  assert.ok(pv.deEss.freq >= 5000 && pv.deEss.freq <= 10000);
  assert.equal(pv.pocket, null);
  assert.ok(pg.pocket && pg.pocket.freq === plan.pocketHz);
  assert.ok(pg.pocket.depthDb >= 1.5 && pg.pocket.depthDb <= 4);
  assert.equal(pb.pocket, null);
  assert.equal(pd.pocket, null);
  assert.equal(pb.send, 0);
  assert.equal(pb.mudCutDb, 0);
  assert.equal(pd.mudCutDb, 0);
  assert.ok(plan.mudCutDb >= 0 && plan.mudCutDb <= 3);
});

test('planMix: no vocal stem means no pocket and no de-esser', () => {
  const plan = planMix([stem('g', 'guitar', song(2, 4)), stem('k', 'keys', song(2, 5))]);
  assert.equal(plan.vocalEnv, null);
  for (const p of Object.values(plan.perStem)) {
    assert.equal(p.pocket, null);
    assert.equal(p.deEss, null);
  }
  assert.equal(planMix([]), null);
});

test('planMix: a single file is treated as a finished mix', () => {
  const plan = planMix([stem('m', 'other', song(2, 6))]);
  assert.equal(plan.perStem.m.highpassHz, 28);
  assert.ok(plan.perStem.m.send <= 0.05);
});

test('roomImpulse: unit energy, pre-delay, decorrelated channels', () => {
  const [l, r] = roomImpulse(SR);
  const pre = Math.round(0.018 * SR);
  let el = 0;
  let er = 0;
  let lr = 0;
  for (let i = 0; i < l.length; i++) {
    el += l[i] * l[i];
    er += r[i] * r[i];
    lr += l[i] * r[i];
  }
  assert.ok(Math.abs(el - 1) < 1e-4 && Math.abs(er - 1) < 1e-4);
  for (let i = 0; i < pre; i++) assert.equal(l[i], 0);
  assert.ok(Math.abs(lr) < 0.2, `correlation ${lr}`);
  // Decays: the last 10% holds almost nothing.
  let tail = 0;
  for (let i = Math.floor(l.length * 0.9); i < l.length; i++) tail += l[i] * l[i];
  assert.ok(tail < 1e-3, `tail energy ${tail}`);
});
