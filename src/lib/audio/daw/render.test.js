import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audibleTracks, renderTrack, renderTracks } from './render.js';

const SR = 44100;
const buffer = (data) => ({ numberOfChannels: 1, length: data.length, sampleRate: SR, getChannelData: () => data });
const ones = (n) => new Float32Array(n).fill(1);
const clip = (o) => ({ id: 'c', startSample: 0, offsetSamples: 0, gain: 1, sampleRate: SR, ...o });
const track = (clips, o = {}) => ({ id: 't', name: 't', clips, muted: false, soloed: false, volume: 1, pan: 0, ...o });

test('a clip lands at its start, reads from its offset, with click-free edges', () => {
  const src = Float32Array.from({ length: SR }, (_, i) => i / SR);
  const t = track([clip({ audioBuffer: buffer(src), startSample: 1000, offsetSamples: 22050, durationSamples: 4410 })]);
  const [l, r] = renderTrack(t, SR, 10000);
  assert.equal(l[999], 0);
  assert.ok(Math.abs(l[1000 + 2000] - (22050 + 2000) / SR) < 1e-6, 'offset read');
  assert.ok(l[1000] < 0.05, 'edge ramp in');
  assert.ok(l[1000 + 4409] < 0.05, 'edge ramp out');
  assert.equal(l[1000 + 4410], 0);
  assert.equal(l[3000], r[3000], 'mono doubled');
});

test('fades, clip gain, track volume and pan', () => {
  const t = track(
    [clip({ audioBuffer: buffer(ones(SR)), durationSamples: SR, gain: 0.5, fadeIn: { duration: 0.5, type: 'linear' } })],
    { volume: 0.5, pan: 1 },
  );
  const [l, r] = renderTrack(t, SR, SR);
  assert.ok(Math.abs(r[SR / 4] - 0.5 * 0.5 * 0.5 * Math.SQRT2) < 0.01, `mid-fade ${r[SR / 4]}`);
  assert.ok(Math.abs(r[(3 * SR) / 4] - 0.25 * Math.SQRT2) < 1e-3);
  assert.ok(Math.abs(l[(3 * SR) / 4]) < 1e-6, 'hard right');
});

test('mute and solo pick the tracks; all come out the same length', () => {
  const a = track([clip({ audioBuffer: buffer(ones(100)), durationSamples: 100 })], { id: 'a' });
  const b = track([clip({ audioBuffer: buffer(ones(100)), startSample: 500, durationSamples: 100 })], { id: 'b', muted: true });
  const c = track([], { id: 'c' });
  assert.deepEqual(audibleTracks([a, b, c]).map((t) => t.id), ['a']);
  assert.deepEqual(audibleTracks([a, { ...b, soloed: true, muted: false }]).map((t) => t.id), ['b']);
  const out = renderTracks([a, { ...b, muted: false }], SR);
  assert.equal(out.length, 2);
  assert.ok(out.every((o) => o.channels[0].length === 600));
});
