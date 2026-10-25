import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { separateChannels, STEMS } from './core.js';
import { SR, song } from '../repair/test-signals.js';

// A stand-in for SCNet's graph: its contract is the mixture's complex
// spectrogram in ([1, 2C, F, T]) and four sources' out ([1, 2SC, F, T]).
// This one gives everything to the source at `index` in its output order.
function fakeSession(index) {
  return {
    inputs: [{ name: 'mix_spec', dims: [1, 4, 2049, 476] }],
    outputs: [{ name: 'stems_spec' }],
    async run(feeds) {
      const x = Object.values(feeds)[0];
      const [, ch, f, t] = x.dims;
      const out = new Float32Array(4 * ch * f * t);
      out.set(x.data, index * ch * f * t);
      return { stems_spec: { data: out, dims: [1, 4 * ch, f, t] } };
    },
  };
}

// The fake session is used instead of the model, but in Node the library still
// wants the weights file to exist where `weights` points.
const weights = mkdtempSync(join(tmpdir(), 'forja-sep-'));
mkdirSync(join(weights, 'scnet'));
writeFileSync(join(weights, 'scnet', 'scnet.int8.onnx'), '');

test('separateChannels: returns the four stems, each as long as the input', async () => {
  const x = song(3, 2);
  const stems = await separateChannels([x, x], SR, { session: () => fakeSession(0), weights });
  assert.deepEqual(stems.map((s) => s.key), STEMS.map((s) => s.key));
  for (const s of stems) {
    assert.equal(s.channels.length, 2);
    assert.equal(s.channels[0].length, x.length);
  }
  // Exactly one source carries the music; the others are silent.
  const energy = stems.map((s) => s.channels[0].reduce((a, v) => a + v * v, 0));
  const total = x.reduce((a, v) => a + v * v, 0);
  const loud = energy.filter((e) => e > total * 0.5);
  assert.equal(loud.length, 1, `energies ${energy.map((e) => (e / total).toFixed(3))}`);
  assert.ok(energy.filter((e) => e < total * 1e-4).length === 3);
});

test('separateChannels: mono input is separated as dual mono', async () => {
  const x = song(2, 3);
  const stems = await separateChannels([x], SR, { session: () => fakeSession(1), weights });
  assert.equal(stems[0].channels.length, 2);
});
