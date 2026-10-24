import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spectrum, bandEnergy, gainToDb } from '../dsp.js';
import { SR, makeBuffer, song, noise, brickwall } from './test-signals.js';
import { scanDefects, detectBandwidth } from './detect.js';
import { demetallize } from './demetal.js';

const bandDb = (x, lo, hi) => gainToDb(bandEnergy(spectrum(makeBuffer([x]), { fftSize: 8192, windows: 24 }), lo, hi));

function maxDiff(a, b, from = 0, to = a.length) {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

test('demetallize: with nothing to do the STFT round trip is transparent', () => {
  const l = song(3);
  const r = song(3, 9);
  const report = { resonances: { peaks: [{ freq: 5000 }] }, bandwidth: { limited: true, cutoffHz: 15000 } };
  // All amounts at zero is a straight copy.
  const [l0, r0] = demetallize([l, r], SR, report, { resonance: 0, air: 0, stereo: 0 });
  assert.equal(maxDiff(l, l0), 0);
  assert.equal(maxDiff(r, r0), 0);
  // Identical channels: side is zero, so the stereo stage must reproduce the
  // input exactly (up to float rounding), edges included.
  const [l1, r1] = demetallize([l, l.slice()], SR, null, { resonance: 0, air: 0, stereo: 1 });
  assert.ok(maxDiff(l, l1) < 1e-5, `L error ${maxDiff(l, l1)}`);
  assert.ok(maxDiff(l, r1) < 1e-5, `R error ${maxDiff(l, r1)}`);
});

test('demetallize: a metallic ring is pulled down, the music around it is not', () => {
  const x = song(8);
  for (let i = 0; i < x.length; i++) x[i] += 0.01 * Math.sin((2 * Math.PI * 5200 * i) / SR);
  const report = scanDefects(makeBuffer([x]));
  assert.ok(report.resonances.peaks.some((p) => Math.abs(p.freq - 5200) < 60));
  const [y] = demetallize([x], SR, report, { resonance: 1, air: 0, stereo: 0 });
  const ringBefore = bandDb(x, 5150, 5250);
  const ringAfter = bandDb(y, 5150, 5250);
  assert.ok(ringBefore - ringAfter > 8, `ring only down ${ringBefore - ringAfter} dB`);
  for (const [lo, hi] of [[200, 1500], [2000, 4500], [6000, 9000]]) {
    const d = Math.abs(bandDb(x, lo, hi) - bandDb(y, lo, hi));
    assert.ok(d < 0.5, `${lo}-${hi} Hz moved ${d} dB`);
  }
});

test('demetallize: air above a 12 kHz brick wall is restored, below is untouched', () => {
  const x = brickwall(noise(SR * 4), 12000);
  const report = { bandwidth: detectBandwidth(makeBuffer([x])), resonances: { peaks: [] } };
  assert.ok(report.bandwidth.limited);
  const [y] = demetallize([x], SR, report, { resonance: 0, air: 1, stereo: 0 });
  const airBefore = bandDb(x, 13000, 17000) - bandDb(x, 4000, 10000);
  const airAfter = bandDb(y, 13000, 17000) - bandDb(y, 4000, 10000);
  assert.ok(airBefore < -40, `air before ${airBefore}`);
  // White noise is flat, so the patch should land a few dB under the band
  // below (the deliberate extra roll-off), not above it.
  assert.ok(airAfter > -8 && airAfter < 0.5, `air after ${airAfter}`);
  assert.ok(Math.abs(bandDb(x, 1000, 11000) - bandDb(y, 1000, 11000)) < 0.2);
  assert.equal(detectBandwidth(makeBuffer([y])).limited, false);
});

test('demetallize: full-band material gets no air added', () => {
  const x = noise(SR * 3);
  const report = { bandwidth: detectBandwidth(makeBuffer([x])), resonances: { peaks: [] } };
  const [y] = demetallize([x], SR, report, { resonance: 0, air: 1, stereo: 0 });
  assert.equal(maxDiff(x, y), 0);
});

test('demetallize: incoherent highs are narrowed, the centre and the lows keep their width', () => {
  const n = SR * 4;
  const centre = song(4);
  const lowL = new Float32Array(n);
  const lowR = new Float32Array(n);
  // A wide but coherent low pad (same tone, different gain per side).
  for (let i = 0; i < n; i++) {
    const v = 0.1 * Math.sin((2 * Math.PI * 180 * i) / SR);
    lowL[i] = v;
    lowR[i] = 0.4 * v;
  }
  // Independent hiss per channel above 4 kHz: the swirly part.
  const hissL = brickwall(noise(n, 31), 20000);
  const hissR = brickwall(noise(n, 32), 20000);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = centre[i] + lowL[i] + 0.1 * hissL[i];
    R[i] = centre[i] + lowR[i] + 0.1 * hissR[i];
  }
  const [yl, yr] = demetallize([L, R], SR, null, { resonance: 0, air: 0, stereo: 1 });
  const side = (a, b) => a.map((v, i) => (v - b[i]) / 2);
  const hiBefore = bandDb(side(L, R), 6000, 16000);
  const hiAfter = bandDb(side(yl, yr), 6000, 16000);
  assert.ok(hiBefore - hiAfter > 6, `high side only down ${hiBefore - hiAfter} dB`);
  const loBefore = bandDb(side(L, R), 150, 210);
  const loAfter = bandDb(side(yl, yr), 150, 210);
  assert.ok(Math.abs(loBefore - loAfter) < 0.3, `low side moved ${loBefore - loAfter} dB`);
});
