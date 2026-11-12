import test from 'node:test';
import assert from 'node:assert/strict';
import { alignTake, clickTrain, clicksHeard, estimateLatencySec, joinChunks, measureLoopbackDelay, resampleLinear } from './align.js';

test('latency estimate sums the valid figures only', () => {
  assert.equal(estimateLatencySec({ outputLatency: 0.02, baseLatency: 0.01, inputLatency: 0.005 }).toFixed(3), '0.035');
  assert.equal(estimateLatencySec({ outputLatency: NaN, baseLatency: -1, inputLatency: undefined }), 0);
  assert.equal(estimateLatencySec(), 0);
});

test('chunks join from the start frame, gaps stay silent', () => {
  const raw = joinChunks(
    [
      { frame: 90, data: Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) },
      { frame: 106, data: Float32Array.from([20, 21]) },
    ],
    100,
  );
  assert.deepEqual(Array.from(raw), [11, 12, 0, 0, 0, 0, 20, 21]);
});

test('alignTake drops the round trip and pads to the song length', () => {
  const raw = Float32Array.from([0, 0, 0, 1, 2, 3]);
  assert.deepEqual(Array.from(alignTake(raw, 3, 5)), [1, 2, 3, 0, 0]);
  assert.deepEqual(Array.from(alignTake(raw, 0, 2)), [0, 0]);
  assert.deepEqual(Array.from(alignTake(raw, 10, 2)), [0, 0]);
});

test('loopback delay is found through noise and a quieter, filtered copy', () => {
  const sr = 48000;
  const train = clickTrain(sr);
  const ref = train.signal;
  const delay = 7321; // ~152 ms
  const rec = new Float32Array(ref.length + sr);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5);
  let prev = 0;
  for (let i = 0; i < rec.length; i++) {
    const src = i - delay >= 0 && i - delay < ref.length ? ref[i - delay] : 0;
    prev = 0.6 * prev + 0.4 * src; // speaker + mic colour the bursts
    rec[i] = 0.2 * prev + 0.01 * rnd();
  }
  const { lagFrames, confidence } = measureLoopbackDelay(ref, rec, Math.round(0.6 * sr));
  assert.ok(Math.abs(lagFrames - delay) <= 3, `lag ${lagFrames}`);
  assert.ok(confidence > 6, `confidence ${confidence}`);
  assert.equal(clicksHeard(rec, train, lagFrames, sr), train.starts.length);
});

test('a steady tone on the mic is not taken for the clicks', () => {
  const sr = 48000;
  const train = clickTrain(sr);
  const rec = Float32Array.from({ length: train.signal.length + sr }, (_, i) => 0.25 * Math.sin((2 * Math.PI * 220 * i) / sr));
  const { lagFrames } = measureLoopbackDelay(train.signal, rec, Math.round(0.6 * sr));
  assert.ok(clicksHeard(rec, train, lagFrames, sr) <= 1);
});

test('silence on the mic gives a low confidence', () => {
  const sr = 16000;
  const ref = clickTrain(sr).signal;
  let seed = 3;
  const rec = Float32Array.from({ length: ref.length }, () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 0.01);
  assert.ok(measureLoopbackDelay(ref, rec, Math.round(0.6 * sr)).confidence < 6);
});

test('resampling keeps duration and a low tone', () => {
  const x = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 220 * i) / 48000));
  const y = resampleLinear(x, 48000, 44100);
  assert.equal(y.length, 44100);
  const i = 1000;
  assert.ok(Math.abs(y[i] - Math.sin((2 * Math.PI * 220 * i) / 44100)) < 1e-3);
});
