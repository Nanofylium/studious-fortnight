// EBU Tech 3341 / 3342 conformance signals for the libebur128 port, and
// behaviour checks for the Airwindows ports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integratedLoudness, loudnessRange, truePeakDbtp } from './ebur128.js';
import { clipOnly2Aligned, toTape6 } from './airwindows.js';

const SR = 48000;
function tone(parts, sr = SR, f = 1000) {
  const n = parts.reduce((a, [s]) => a + Math.round(s * sr), 0);
  const x = new Float32Array(n);
  let i = 0;
  for (const [s, db] of parts) {
    const a = 10 ** (db / 20);
    for (let k = 0; k < Math.round(s * sr); k++, i++) x[i] = a * Math.sin((2 * Math.PI * f * i) / sr);
  }
  return [x, x.slice()];
}
const near = (v, want, tol, what) => assert.ok(Math.abs(v - want) <= tol, `${what}: ${v.toFixed(3)} (want ${want} ±${tol})`);

test('EBU 3341 cases 1, 2, 3 and 5: integrated loudness', () => {
  near(integratedLoudness(tone([[20, -23]]), SR), -23, 0.1, 'case 1');
  near(integratedLoudness(tone([[20, -33]]), SR), -33, 0.1, 'case 2');
  near(integratedLoudness(tone([[10, -36], [60, -23], [10, -36]]), SR), -23, 0.1, 'case 3');
  near(integratedLoudness(tone([[20, -26], [20.1, -20], [20, -26]]), SR), -23, 0.1, 'case 5');
  near(integratedLoudness(tone([[20, -23]], 44100), 44100), -23, 0.1, 'case 1 at 44.1 kHz');
});

test('EBU 3342 cases 1 and 2: loudness range', () => {
  near(loudnessRange(tone([[20, -20], [20, -30]]), SR), 10, 1, 'case 1');
  near(loudnessRange(tone([[20, -20], [20, -15]]), SR), 5, 1, 'case 2');
});

test('true peak finds the peak between samples', () => {
  // fs/4 sine with a 45° phase offset: every sample sits 3 dB under the crest.
  const n = SR;
  const x = Float32Array.from({ length: n }, (_, i) => Math.sin((Math.PI / 2) * i + Math.PI / 4));
  const sample = 20 * Math.log10(Math.max(...x.map(Math.abs)));
  near(sample, -3.01, 0.05, 'sample peak');
  near(truePeakDbtp([x, x], SR), 0, 0.5, 'true peak');
});

test('ClipOnly2 leaves unclipped audio alone and holds overs near -0.4 dBFS', () => {
  const quiet = tone([[1, -6]], 44100)[0];
  const q = clipOnly2Aligned(quiet, 44100);
  let diff = 0;
  for (let i = 0; i < q.length; i++) diff = Math.max(diff, Math.abs(q[i] - quiet[i]));
  assert.ok(diff < 1e-6, `bypass ${diff}`);
  const hot = tone([[1, 6]], 44100)[0];
  const h = clipOnly2Aligned(hot, 44100);
  const pk = Math.max(...h.map(Math.abs));
  assert.ok(pk <= 0.9549925859 + 1e-6 && pk > 0.9, `peak ${pk}`);
});

// ToTape6's saturation stage (sin(x·mojo·π/2)/mojo) has a small-signal gain
// of π/2, about +3.9 dB, as in the plugin; the master re-levels after it.
test('ToTape6 at default settings: +3.9 dB of drive, bounded and finite', () => {
  const [l, r] = tone([[2, -12]], 44100, 220);
  const [ol, or] = toTape6([l, r], 44100);
  const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  const db = 20 * Math.log10(rms(ol.subarray(22050)) / rms(l.subarray(22050)));
  assert.ok(db > 3 && db < 5, `gain ${db.toFixed(2)} dB`);
  assert.ok(ol.every((v) => Number.isFinite(v) && Math.abs(v) <= 0.99));
  assert.ok(or.every(Number.isFinite));
});
