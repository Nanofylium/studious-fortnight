import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SR, makeBuffer, song, brickwall } from './test-signals.js';
import { scanDefects } from './detect.js';
import { repairChannels } from './pipeline.js';

function loop(seconds, phrase = 2, seed = 13) {
  const p = song(phrase, seed);
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i++) x[i] = p[i % p.length];
  return x;
}

test('repairChannels: a damaged stereo stem comes out clean and summarised', () => {
  const base = brickwall(loop(8), 14000);
  for (let i = 0; i < base.length; i++) base[i] += 0.01 * Math.sin((2 * Math.PI * 5200 * i) / SR);
  const L = base.slice();
  const R = base.slice();
  L[Math.round(1.7 * SR)] += 0.5;
  L.fill(0, Math.round(3.2 * SR), Math.round(3.23 * SR));
  R.fill(0, Math.round(3.2 * SR), Math.round(3.23 * SR));
  L.fill(0, Math.round(5.1 * SR), Math.round(5.4 * SR));
  R.fill(0, Math.round(5.1 * SR), Math.round(5.4 * SR));

  const { channels, summary } = repairChannels([L, R], SR);
  assert.equal(summary.clicks, 1);
  assert.equal(summary.dropouts, 1);
  assert.equal(summary.gaps, 1);
  assert.equal(summary.unrepaired, 0);
  assert.ok(Math.abs(summary.cutoffHz - 14000) < 400, `cutoff ${summary.cutoffHz}`);
  assert.ok(summary.resonances.some((f) => Math.abs(f - 5200) < 60), JSON.stringify(summary.resonances));

  const after = scanDefects(makeBuffer(channels));
  assert.equal(after.events.length, 0, JSON.stringify(after.events));
  assert.equal(after.bandwidth.limited, false);
  // The inputs are left alone.
  assert.equal(L[Math.round(5.2 * SR)], 0);
});

test('repairChannels: clean material comes back (nearly) unchanged', () => {
  const x = song(4);
  const { channels, summary } = repairChannels([x], SR);
  assert.equal(summary.clicks + summary.dropouts + summary.gaps, 0);
  assert.equal(summary.cutoffHz, null);
  let e = 0;
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    e += (channels[0][i] - x[i]) ** 2;
    s += x[i] ** 2;
  }
  assert.ok(10 * Math.log10(s / e) > 60, `snr ${10 * Math.log10(s / e)}`);
});
