import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BANDS, spectralProfile, matchCurve, minimumPhaseFir, fftConvolve, matchWidth } from './reference.js';
import { SR, makeBuffer, noise } from './repair/test-signals.js';

// Noise with a gentle tilt: `tilt` dB per octave relative to 1 kHz, made by
// filtering white noise with a FIR built from the same curve machinery.
function tilted(n, tilt, seed) {
  const curve = BANDS.map((f) => tilt * Math.log2(f / 1000));
  return fftConvolve(noise(n, seed), minimumPhaseFir(Float32Array.from(curve), SR));
}

const bandAt = (f) => BANDS.findIndex((b) => b >= f);

test('minimumPhaseFir: a flat curve is (almost) a unit impulse', () => {
  const h = minimumPhaseFir(new Float32Array(BANDS.length), SR);
  assert.ok(Math.abs(h[0] - 1) < 1e-3, `h[0] ${h[0]}`);
  let rest = 0;
  for (let i = 1; i < h.length; i++) rest = Math.max(rest, Math.abs(h[i]));
  assert.ok(rest < 1e-3, `tail ${rest}`);
});

test('minimumPhaseFir: the filter has the requested magnitude and no latency', () => {
  const curve = BANDS.map((f) => (f > 4000 ? 6 : 0));
  const x = noise(SR * 3, 4);
  const y = fftConvolve(x, minimumPhaseFir(Float32Array.from(curve), SR));
  const px = spectralProfile(makeBuffer([x]));
  const py = spectralProfile(makeBuffer([y]));
  for (const f of [300, 1000, 2000]) {
    const b = bandAt(f);
    assert.ok(Math.abs(py.bands[b] - px.bands[b]) < 0.7, `${f} Hz moved ${py.bands[b] - px.bands[b]}`);
  }
  for (const f of [6000, 10000, 15000]) {
    const b = bandAt(f);
    assert.ok(Math.abs(py.bands[b] - px.bands[b] - 6) < 0.8, `${f} Hz gain ${py.bands[b] - px.bands[b]}`);
  }
  // Minimum phase: the energy of the response is at the very start.
  const h = minimumPhaseFir(Float32Array.from(curve), SR);
  let head = 0;
  let total = 0;
  for (let i = 0; i < h.length; i++) {
    total += h[i] * h[i];
    if (i < 64) head += h[i] * h[i];
  }
  assert.ok(head / total > 0.95, `head energy ${head / total}`);
});

test('matchCurve + FIR: a dull mix is moved to a bright reference', () => {
  const n = SR * 4;
  const mix = tilted(n, -1.5, 5);
  const ref = tilted(n, 0, 6);
  const pm = spectralProfile(makeBuffer([mix]));
  const pr = spectralProfile(makeBuffer([ref]));
  const curve = matchCurve(pm, pr);
  // Brighter than the mix: cut lows, boost highs (relative).
  assert.ok(curve[bandAt(100)] < -1.5 && curve[bandAt(8000)] > 1.5, `100 Hz ${curve[bandAt(100)]}, 8 kHz ${curve[bandAt(8000)]}`);
  const out = fftConvolve(mix, minimumPhaseFir(curve, SR));
  const po = spectralProfile(makeBuffer([out]));
  // After matching, the tilt between 200 Hz and 5 kHz is close to the reference's.
  const tilt = (p) => p.bands[bandAt(5000)] - p.bands[bandAt(200)];
  assert.ok(Math.abs(tilt(po) - tilt(pr)) < 1.5, `tilt mix ${tilt(pm)}, out ${tilt(po)}, ref ${tilt(pr)}`);
});

test('matchCurve: never more than ±maxDb and no boost into an empty band', () => {
  const mix = { bands: Float32Array.from(BANDS.map((f) => (f > 12000 ? -200 : -40))) };
  const ref = { bands: Float32Array.from(BANDS.map((f) => (f > 3000 ? -10 : -40))) };
  const curve = matchCurve(mix, ref, { maxDb: 6 });
  for (const g of curve) assert.ok(Math.abs(g) <= 6 + 1e-6);
  assert.ok(curve[bandAt(15000)] <= 2 + 1e-6, `boost into silence ${curve[bandAt(15000)]}`);
});

test('spectralProfile + matchWidth: width follows the side/mid balance', () => {
  const n = SR * 3;
  const m = noise(n, 1);
  const s = noise(n, 2);
  const narrowL = new Float32Array(n);
  const narrowR = new Float32Array(n);
  const wideL = new Float32Array(n);
  const wideR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    narrowL[i] = m[i] + 0.1 * s[i];
    narrowR[i] = m[i] - 0.1 * s[i];
    wideL[i] = m[i] + 0.4 * s[i];
    wideR[i] = m[i] - 0.4 * s[i];
  }
  const pn = spectralProfile(makeBuffer([narrowL, narrowR]));
  const pw = spectralProfile(makeBuffer([wideL, wideR]));
  assert.ok(Math.abs(pw.sideRatio / pn.sideRatio - 16) < 1.5, `ratio ${pw.sideRatio / pn.sideRatio}`);
  assert.equal(matchWidth(1, pn, pw), 1.6);
  assert.ok(Math.abs(matchWidth(1, pw, pn) - 0.6) < 1e-9);
  const same = matchWidth(1.1, pn, pn);
  assert.ok(Math.abs(same - 1.1) < 1e-9);
});
