// Run with `npm test` (node's built-in runner, no extra dependencies).
// Every defect here is planted at a known place in a synthetic "song", so the
// tests check both that it is found and that clean material stays clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SR, makeBuffer, song, noise, brickwall } from './test-signals.js';
import { detectBandwidth, detectResonances, detectClicks, detectDropouts, scanDefects } from './detect.js';

test('bandwidth: finds a 16 kHz brick wall', () => {
  const x = brickwall(noise(1 << 18), 16000);
  const res = detectBandwidth(makeBuffer([x]));
  assert.ok(res.cutoffHz !== null, 'cutoff expected');
  assert.ok(Math.abs(res.cutoffHz - 16000) < 400, `cutoff ${res.cutoffHz}`);
  assert.equal(res.limited, true);
  assert.ok(res.dropDb > 40);
});

test('bandwidth: finds an 11 kHz brick wall and reports missing air', () => {
  const x = brickwall(noise(1 << 18, 5), 11000);
  const res = detectBandwidth(makeBuffer([x]));
  assert.ok(Math.abs(res.cutoffHz - 11000) < 400, `cutoff ${res.cutoffHz}`);
  assert.ok(res.airDb < -20, `air ${res.airDb}`);
});

test('bandwidth: full-band material has no cutoff', () => {
  const res = detectBandwidth(makeBuffer([noise(1 << 18)]));
  assert.equal(res.cutoffHz, null);
  assert.equal(res.limited, false);
  assert.ok(Math.abs(res.airDb) < 3, `air ${res.airDb}`);
});

test('resonances: a steady 5.2 kHz ring over the music is flagged', () => {
  const x = song(8);
  for (let i = 0; i < x.length; i++) x[i] += 0.01 * Math.sin((2 * Math.PI * 5200 * i) / SR);
  const res = detectResonances(makeBuffer([x]));
  const hit = res.peaks.find((p) => Math.abs(p.freq - 5200) < 60);
  assert.ok(hit, `peaks ${JSON.stringify(res.peaks)}`);
  assert.ok(hit.persistence > 0.9);
  assert.ok(res.score > 0);
});

test('resonances: music whose notes move is not flagged', () => {
  const res = detectResonances(makeBuffer([song(8)]));
  assert.deepEqual(res.peaks, []);
  assert.equal(res.score, 0);
});

test('resonances: plain noise is not flagged', () => {
  const res = detectResonances(makeBuffer([noise(SR * 6)]));
  assert.deepEqual(res.peaks, []);
});

test('clicks: planted clicks are found where they are', () => {
  const x = song(6);
  const spots = [0.73, 1.91, 2.4, 3.333, 4.8].map((s) => Math.round(s * SR));
  spots.forEach((p, i) => {
    x[p] += i % 2 ? -0.4 : 0.4;
    x[p + 1] += i % 2 ? 0.25 : -0.25;
  });
  const found = detectClicks(makeBuffer([x]));
  for (const p of spots) {
    assert.ok(
      found.some((c) => p >= c.start - 2 && p <= c.end),
      `click at ${p} missing; got ${found.map((c) => c.start)}`,
    );
  }
  assert.ok(found.length <= spots.length + 1, `false positives: ${found.length - spots.length}`);
});

test('clicks: clean music, including drum onsets, gives no clicks', () => {
  const found = detectClicks(makeBuffer([song(6, 11)]));
  assert.equal(found.length, 0, `got ${JSON.stringify(found.slice(0, 5))}`);
});

test('dropouts: a 40 ms dropout and a 400 ms gap are found and classified', () => {
  const x = song(6);
  const d0 = Math.round(1.2 * SR);
  const d1 = d0 + Math.round(0.04 * SR);
  const g0 = Math.round(3.1 * SR);
  const g1 = g0 + Math.round(0.4 * SR);
  x.fill(0, d0, d1);
  x.fill(0, g0, g1);
  const found = detectDropouts(makeBuffer([x, x.slice()]));
  assert.equal(found.length, 2, JSON.stringify(found));
  const [a, b] = found;
  assert.equal(a.type, 'dropout');
  assert.ok(Math.abs(a.start - d0) < 10 && Math.abs(a.end - d1) < 10, JSON.stringify(a));
  assert.deepEqual(a.channels.sort(), [0, 1]);
  assert.equal(b.type, 'gap');
  assert.ok(Math.abs(b.start - g0) < 10 && Math.abs(b.end - g1) < 10, JSON.stringify(b));
});

test('dropouts: a fade to silence and back is not a dropout', () => {
  const x = song(6);
  const f0 = Math.round(2 * SR);
  const fadeLen = Math.round(0.3 * SR);
  for (let i = 0; i < fadeLen; i++) x[f0 + i] *= 1 - i / fadeLen;
  x.fill(0, f0 + fadeLen, f0 + fadeLen + Math.round(0.2 * SR));
  const found = detectDropouts(makeBuffer([x]));
  assert.equal(found.length, 0, JSON.stringify(found));
});

test('dropouts: silence at the very end (an outro) is ignored', () => {
  const x = song(4);
  x.fill(0, Math.round(3.5 * SR));
  assert.equal(detectDropouts(makeBuffer([x])).length, 0);
});

test('scanDefects: one report, dropout edges not double-counted as clicks', () => {
  const x = brickwall(song(6), 15000);
  x.fill(0, Math.round(2.2 * SR), Math.round(2.25 * SR));
  const click = Math.round(4.2 * SR);
  x[click] += 0.5;
  const rep = scanDefects(makeBuffer([x]));
  assert.ok(rep.bandwidth.limited, JSON.stringify(rep.bandwidth));
  assert.equal(rep.counts.dropouts, 1);
  assert.equal(rep.counts.clicks, 1, JSON.stringify(rep.events));
  assert.equal(rep.events[0].type, 'dropout');
  assert.ok(Math.abs(rep.events[0].startSec - 2.2) < 0.001);
  assert.ok(Math.abs(rep.events[0].durationMs - 50) < 1);
  assert.equal(rep.events[1].type, 'click');
});
