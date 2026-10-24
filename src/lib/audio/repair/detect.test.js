// Run with `npm test` (node's built-in runner, no extra dependencies).
// Every defect here is planted at a known place in a synthetic "song", so the
// tests check both that it is found and that clean material stays clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fftInPlace } from '../dsp.js';
import { detectBandwidth, detectResonances, detectClicks, detectDropouts, scanDefects } from './detect.js';

const SR = 44100;

function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeBuffer(channels) {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate: SR,
    getChannelData: (c) => channels[c],
  };
}

// Notes that change every half second, each with a decaying harmonic series
// (5 ms attack, 15 ms release, so the note changes themselves are smooth),
// a soft noise "hi-hat" on every beat and a little broadband noise underneath.
function song(seconds, seed = 7) {
  const r = rng(seed);
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  const notes = [220, 247, 262, 294, 330, 349, 392, 440];
  const noteLen = Math.round(0.5 * SR);
  for (let start = 0; start < n; start += noteLen) {
    const f0 = notes[Math.floor(r() * notes.length)] * (r() < 0.5 ? 1 : 2);
    const end = Math.min(n, start + noteLen);
    for (let h = 1; h <= 12; h++) {
      const f = f0 * h;
      if (f > 9000) break;
      const amp = 0.12 / h;
      const ph = r() * 2 * Math.PI;
      for (let i = start; i < end; i++) {
        const t = (i - start) / SR;
        const env = Math.min(1, t / 0.005, (end - i) / (0.015 * SR)) * Math.exp(-t * 2.5);
        x[i] += amp * env * Math.sin(2 * Math.PI * f * t + ph);
      }
    }
    // Hi-hat: 1 ms attack ramp, 60 ms decay.
    for (let i = start; i < Math.min(end, start + Math.round(0.08 * SR)); i++) {
      const t = (i - start) / SR;
      const env = Math.min(1, t / 0.001) * Math.exp(-t / 0.02);
      x[i] += 0.05 * env * (r() * 2 - 1);
    }
  }
  for (let i = 0; i < n; i++) x[i] += 0.003 * (r() * 2 - 1);
  return x;
}

function noise(n, seed = 3) {
  const r = rng(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.2 * (r() * 2 - 1);
  return x;
}

// Brick-wall low-pass by zeroing FFT bins, the way a codec or a band-limited
// generator leaves the top of the spectrum.
function brickwall(x, cutoffHz) {
  const n = 1 << Math.ceil(Math.log2(x.length));
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  re.set(x);
  fftInPlace(re, im);
  const kc = Math.round((cutoffHz / SR) * n);
  for (let k = kc; k <= n - kc; k++) {
    re[k] = 0;
    im[k] = 0;
  }
  for (let k = 0; k < n; k++) im[k] = -im[k];
  fftInPlace(re, im);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = re[i] / n;
  return out;
}

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
