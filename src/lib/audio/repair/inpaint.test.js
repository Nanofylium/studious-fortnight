import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SR, makeBuffer, song, rng } from './test-signals.js';
import { scanDefects } from './detect.js';
import { interpolateAR, extrapolateBoth, repairEvents } from './inpaint.js';

// SNR of the restored region against the original, in dB.
function snr(orig, fixed, a, b) {
  let s = 0;
  let e = 0;
  for (let i = a; i < b; i++) {
    s += orig[i] * orig[i];
    e += (orig[i] - fixed[i]) ** 2;
  }
  return 10 * Math.log10(s / Math.max(e, 1e-20));
}

function tones(n, freqs = [196, 392, 587, 880, 1320], seed = 2) {
  const r = rng(seed);
  const x = new Float32Array(n);
  for (const f of freqs) {
    const ph = r() * 2 * Math.PI;
    const amp = 0.25 / Math.sqrt(f / 196);
    for (let i = 0; i < n; i++) x[i] += amp * Math.sin((2 * Math.PI * f * i) / SR + ph);
  }
  return x;
}

// A 2 s phrase repeated: how most generated songs are built.
function loop(seconds, phrase = 2, seed = 13) {
  const p = song(phrase, seed);
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = p[i % p.length];
  return x;
}

test('interpolateAR: a 40-sample click in tonal material is rebuilt almost exactly', () => {
  const orig = tones(SR);
  const x = orig.slice();
  const a = 20000;
  for (let i = a; i < a + 40; i++) x[i] = 0.9 * Math.sign(Math.sin(i));
  interpolateAR(x, a, a + 40);
  assert.ok(snr(orig, x, a, a + 40) > 40, `snr ${snr(orig, x, a, a + 40)}`);
  for (let i = 0; i < x.length; i++) if (i < a || i >= a + 40) assert.equal(x[i], orig[i]);
});

test('interpolateAR: a 10 ms dropout in a song is filled plausibly', () => {
  const orig = song(3);
  const x = orig.slice();
  const a = Math.round(1.23 * SR);
  const b = a + Math.round(0.01 * SR);
  x.fill(0, a, b);
  interpolateAR(x, a, b);
  assert.ok(snr(orig, x, a, b) > 10, `snr ${snr(orig, x, a, b)}`);
});

test('extrapolateBoth: a 50 ms gap in a sustained chord is bridged', () => {
  const orig = tones(SR);
  const x = orig.slice();
  const a = 22000;
  const b = a + Math.round(0.05 * SR);
  x.fill(0, a, b);
  extrapolateBoth(x, a, b);
  assert.ok(snr(orig, x, a, b) > 15, `snr ${snr(orig, x, a, b)}`);
});

test('repairEvents: a 300 ms hole in a looped song is patched from another repeat', () => {
  const orig = loop(8);
  const L = orig.slice();
  const R = orig.slice();
  const a = Math.round(5.3 * SR);
  const b = a + Math.round(0.3 * SR);
  L.fill(0, a, b);
  R.fill(0, a, b);
  const events = [{ type: 'gap', start: a, end: b, channels: [0, 1] }];
  const { channels, report } = repairEvents([L, R], SR, events);
  assert.equal(report[0].method, 'patch');
  assert.ok(report[0].score > 0.95, `score ${report[0].score}`);
  assert.equal(Math.abs(report[0].source - a) % (2 * SR), 0, `source ${report[0].source}`);
  assert.ok(snr(orig, channels[0], a, b) > 30, `snr ${snr(orig, channels[0], a, b)}`);
  // The inputs are not modified.
  assert.equal(L[a + 10], 0);
});

test('repairEvents: only the damaged channel is touched', () => {
  const orig = loop(6);
  const L = orig.slice();
  const R = orig.slice();
  const a = Math.round(3.4 * SR);
  const b = a + Math.round(0.08 * SR);
  L.fill(0, a, b);
  const { channels } = repairEvents([L, R], SR, [{ type: 'dropout', start: a, end: b, channels: [0] }]);
  assert.deepEqual(channels[1], R);
  assert.ok(snr(orig, channels[0], a, b) > 20);
});

test('repairEvents: with no usable match and a long gap the region is left and reported', () => {
  const x = song(6, 99);
  const a = Math.round(3 * SR);
  const b = a + Math.round(0.4 * SR);
  x.fill(0, a, b);
  const { report } = repairEvents([x], SR, [{ type: 'gap', start: a, end: b, channels: [0] }], { minPatchScore: 1.01 });
  assert.equal(report[0].method, 'none');
});

test('detect + repair: after repair a rescan finds nothing left', () => {
  const orig = loop(8);
  const x = orig.slice();
  [1.1, 2.75, 6.2].forEach((s, i) => {
    x[Math.round(s * SR)] += i % 2 ? -0.5 : 0.5;
  });
  x.fill(0, Math.round(3.3 * SR), Math.round(3.34 * SR));
  x.fill(0, Math.round(4.9 * SR), Math.round(5.2 * SR));
  const before = scanDefects(makeBuffer([x]));
  assert.equal(before.events.length, 5, JSON.stringify(before.counts));
  const { channels, report } = repairEvents([x], SR, before.events);
  assert.ok(report.every((r) => r.method !== 'none'), JSON.stringify(report.map((r) => r.method)));
  const after = scanDefects(makeBuffer(channels));
  assert.equal(after.events.length, 0, JSON.stringify(after.events));
  assert.ok(snr(orig, channels[0], 0, orig.length) > 25, `overall snr ${snr(orig, channels[0], 0, orig.length)}`);
});
