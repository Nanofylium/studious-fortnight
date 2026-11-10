import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SR, rng, song } from '../repair/test-signals.js';
import { asBuffer, bq, filt, rms } from './filters.js';
import { dynamicDemetal, metallicIndex } from './spectral.js';
import { encodeWav16Dither, masterTo } from './mixdown.js';
import { produceSong } from './pipeline.js';
import { integratedLufs } from '../loudness.js';
import { truePeakDb } from '../dsp.js';

const white = (seconds, seed = 3, amp = 0.1) => {
  const r = rng(seed);
  return Float32Array.from({ length: Math.round(seconds * SR) }, () => (r() * 2 - 1) * amp);
};

// Energy of x in a narrow band around f.
const bandRms = (x, f) => rms(filt(filt(x, bq('hp', f * 0.9, 4, 0, SR)), bq('lp', f * 1.1, 4, 0, SR)));

test('dynamic de-metal pulls a ringing partial out of noise and leaves plain noise alone', () => {
  const n = 3 * SR;
  const base = white(3);
  const ring = Float32Array.from(base, (v, i) => v + 0.2 * Math.sin((2 * Math.PI * 5000 * i) / SR));
  const { channels: out } = dynamicDemetal([ring, ring.slice()], SR);
  const metalIn = metallicIndex([ring, ring], SR);
  const metalOut = metallicIndex(out, SR);
  assert.ok(metalOut < metalIn * 0.7, `metallic ${metalIn.toFixed(3)} -> ${metalOut.toFixed(3)}`);
  const { channels: plain } = dynamicDemetal([base, base.slice()], SR);
  const mid = (x) => x.subarray(SR / 2, n - SR / 2);
  const ratio = rms(mid(plain[0])) / rms(mid(base));
  assert.ok(ratio > 0.93 && ratio < 1.03, `noise level ratio ${ratio.toFixed(3)}`);
  assert.ok(bandRms(mid(out[0]), 5000) < bandRms(mid(ring), 5000) * 0.6);
});

test('master loop lands on -14 LUFS under -1 dBTP', () => {
  const s = song(8);
  const ch = [s.map((v) => v * 0.3), s.map((v) => v * 0.28)];
  const m = masterTo(ch, SR);
  assert.ok(Math.abs(m.lufs + 14) < 0.3, `lufs ${m.lufs}`);
  assert.ok(m.truePeakDb <= -0.9, `tp ${m.truePeakDb}`);
});

test('full production: vocal + instrumental to a streaming master', () => {
  const sec = 8;
  const inst = song(sec, 5);
  const r = rng(9);
  const voice = Float32Array.from({ length: sec * SR }, (_, i) => {
    const t = i / SR;
    const on = Math.floor(t / 1.5) % 2 === 0 ? 1 : 0;
    let v = 0;
    for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * 196 * h * t) / h;
    return on * (0.15 * v + 0.004 * (r() * 2 - 1));
  });
  const out = produceSong({ vocals: [[voice]], others: [[inst, inst.slice()]], sampleRate: SR }, {});
  assert.equal(out.channels.length, 2);
  assert.ok(Math.abs(out.report.lufs + 14) < 0.5, `lufs ${out.report.lufs}`);
  assert.ok(out.report.truePeakDb <= -0.9, `tp ${out.report.truePeakDb} lufs ${out.report.lufs}`);
  assert.ok(out.channels[0].every(Number.isFinite));
  const lufs = integratedLufs(asBuffer(out.channels, SR));
  assert.ok(Math.abs(lufs - out.report.lufs) < 0.05);
  assert.ok(truePeakDb(asBuffer(out.channels, SR)) <= -0.9);
});

test('instrumental-only sessions still master', () => {
  const s = song(5, 2);
  const out = produceSong({ others: [[s]], sampleRate: SR }, { analog: true });
  assert.ok(Math.abs(out.report.lufs + 14) < 0.5);
  assert.equal(out.report.vocal, undefined);
});

test('16-bit export: header and dithered samples', () => {
  const ab = encodeWav16Dither([new Float32Array(100).fill(0.5), new Float32Array(100)], 44100);
  const v = new DataView(ab);
  assert.equal(ab.byteLength, 44 + 400);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(24, true), 44100);
  const s = v.getInt16(44, true);
  assert.ok(Math.abs(s - 16384) <= 2);
});
