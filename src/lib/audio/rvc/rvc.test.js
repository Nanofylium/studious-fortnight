import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SR16, coarsePitch, decodeF0, melBasis, resample, convertVoice, detectF0 } from './core.js';

const tone = (f, seconds, sr, harmonics = 6) => {
  const x = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < x.length; i++) {
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += Math.sin((2 * Math.PI * f * h * i) / sr) / h;
    x[i] = 0.2 * v;
  }
  return x;
};

const median = (a) => {
  const v = Array.from(a).filter((x) => x > 0).sort((p, q) => p - q);
  return v.length ? v[v.length >> 1] : 0;
};

const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length));

test('resample keeps a tone and the length ratio', () => {
  const x = tone(440, 1, 44100, 1);
  const y = resample(x, 44100, SR16);
  assert.equal(y.length, SR16);
  // Zero crossings per second ≈ 2 × 440.
  let z = 0;
  for (let i = 1000; i < 15000; i++) if (y[i - 1] < 0 && y[i] >= 0) z++;
  assert.ok(Math.abs(z / (14000 / SR16) - 440) < 5, `crossings ${z}`);
  assert.ok(Math.abs(rms(y.subarray(1000, 15000)) - rms(x)) < 0.01);
});

test('mel basis: 128 triangles, Slaney-normalised, inside 30–8000 Hz', () => {
  const b = melBasis();
  assert.equal(b.length, 128);
  assert.equal(b[0].length, 513);
  // Bin 0 (0 Hz) and the top bin are outside every filter.
  assert.ok(b.every((row) => row[0] === 0));
  // Each filter has area ≈ 1 (in Hz × weight) with Slaney norm: sum × bin width ≈ 1.
  const binHz = 16000 / 1024;
  const area = b[64].reduce((s, v) => s + v, 0) * binHz;
  assert.ok(Math.abs(area - 1) < 0.15, `area ${area}`);
});

test('decodeF0: a peak at bin k gives 10 · 2^(cents/1200), quiet frames are 0', () => {
  const sal = new Float32Array(2 * 360);
  sal[100] = 0.9;
  const f0 = decodeF0(sal, 2);
  const cents = 20 * 100 + 1997.3794084376191;
  assert.ok(Math.abs(f0[0] - 10 * 2 ** (cents / 1200)) < 0.01);
  assert.equal(f0[1], 0);
});

test('coarsePitch: mel-scaled 1..255, unvoiced = 1, transpose scales Hz', () => {
  const { pitch, pitchf } = coarsePitch(Float32Array.from([0, 50, 1100, 220]), 12);
  assert.equal(pitch[0], 1n);
  assert.equal(pitchf[3], 440);
  assert.equal(pitch[2], 255n);
  assert.ok(pitch[3] > 1n && pitch[3] < 255n);
});

// With the real networks (not in the repo): RVC_MODELS=/dir holding
// rmvpe.onnx, hubert_base.onnx and a voice model (voice.onnx, 40 kHz).
const DIR = process.env.RVC_MODELS;
const have = DIR && ['rmvpe.onnx', 'hubert_base.onnx', 'voice.onnx'].every((f) => existsSync(join(DIR, f)));

test('RMVPE finds the pitch of a sung-like tone', { skip: !DIR || !existsSync(join(DIR || '', 'rmvpe.onnx')) }, async () => {
  const ort = await import('onnxruntime-node');
  const rmvpe = await ort.InferenceSession.create(join(DIR, 'rmvpe.onnx'));
  const f0 = await detectF0(ort, rmvpe, resample(tone(220, 3, 44100), 44100, SR16));
  const m = median(f0);
  assert.ok(Math.abs(m - 220) < 220 * 0.02, `median f0 ${m}`);
  assert.ok(f0.filter((v) => v > 0).length > f0.length * 0.8);
});

test('convertVoice: same length, finite, follows the pitch (+12 = one octave up)', { skip: !have, timeout: 300000 }, async () => {
  const ort = await import('onnxruntime-node');
  const load = (f) => ort.InferenceSession.create(join(DIR, f));
  const sessions = { rmvpe: await load('rmvpe.onnx'), hubert: await load('hubert_base.onnx'), voice: await load('voice.onnx') };
  const sr = 44100;
  // Longer than one window, so the crossfade between windows is exercised.
  const x = tone(196, 14, sr);
  let last = 0;
  const { audio, voicedPct } = await convertVoice(ort, sessions, x, sr, { semitones: 12, onProgress: (p) => (last = p) });
  assert.equal(audio.length, x.length);
  assert.ok(audio.every(Number.isFinite));
  assert.ok(rms(audio) > 0.005, `rms ${rms(audio)}`);
  assert.equal(last, 1);
  assert.ok(voicedPct > 0.8);
  const f0 = await detectF0(ort, sessions.rmvpe, resample(audio.subarray(sr, 13 * sr), sr, SR16));
  const m = median(f0);
  assert.ok(Math.abs(m - 392) < 392 * 0.04, `output f0 ${m}`);
});

test('matchEnvelope: follows the original loudness contour, rate 1 leaves it alone', async () => {
  const { matchEnvelope } = await import('./core.js');
  const sr = 16000;
  const input = tone(220, 2, sr);
  for (let i = sr; i < 2 * sr; i++) input[i] *= 0.1; // second half 20 dB down
  const output = tone(330, 2, sr);
  const y = matchEnvelope(input, output, sr, 0);
  const r1 = rms(y.subarray(2000, 14000));
  const r2 = rms(y.subarray(18000, 30000));
  assert.ok(Math.abs(20 * Math.log10(r1 / r2) - 20) < 1.5, `${r1} ${r2}`);
  assert.deepEqual(matchEnvelope(input, output, sr, 1), output);
});

test('probeModelSr reads the output rate of a voice model', { skip: !have }, async () => {
  const { probeModelSr } = await import('./core.js');
  const ort = await import('onnxruntime-node');
  const voice = await ort.InferenceSession.create(join(DIR, 'voice.onnx'));
  assert.equal(await probeModelSr(ort, voice), 40000);
});
