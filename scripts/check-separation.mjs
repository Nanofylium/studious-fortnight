// End-to-end check of the stem separation with the real model (needs
// public/models/scnet, see fetch-model.mjs): a synthetic song of a sung tone,
// a bass line and drum hits goes in, and each part must come out mostly in
// its own stem. Run in CI, where the model can be downloaded.
import { separateChannels } from '../src/lib/audio/separate/core.js';

const SR = 44100;
const n = SR * 12;
const parts = { vocals: new Float32Array(n), bass: new Float32Array(n), drums: new Float32Array(n) };
let seed = 1;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
for (let i = 0; i < n; i++) {
  const t = i / SR;
  // Voice: vibrato, formant-rich harmonics, phrases with breaths.
  const f0 = 220 * Math.pow(2, [0, 3, 5, 7][Math.floor(t / 1.5) % 4] / 12) * (1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * t));
  let v = 0;
  for (let h = 1; h <= 18; h++) v += (Math.sin(2 * Math.PI * f0 * h * t) / h) * (1 + 4 * Math.exp(-(((f0 * h - 2800) / 700) ** 2)));
  parts.vocals[i] = (t % 1.5 < 1.3 ? 0.08 : 0) * v;
  // Bass: low sine notes on the beat.
  const fb = 55 * Math.pow(2, [0, 0, 3, 5][Math.floor(t / 0.75) % 4] / 12);
  parts.bass[i] = 0.25 * Math.sin(2 * Math.PI * fb * t) * Math.exp(-(t % 0.375) * 2);
  // Drums: kick on beats, noisy snare on off-beats.
  const beat = t % 0.5;
  parts.drums[i] = 0.5 * Math.sin(2 * Math.PI * 60 * beat * (1 - beat)) * Math.exp(-beat * 30) + (Math.abs((t % 1) - 0.5) < 0.12 ? 0.15 * rnd() * Math.exp(-((t % 1) - 0.5 + 0.12) * 25) : 0);
}
const mix = new Float32Array(n);
for (let i = 0; i < n; i++) mix[i] = parts.vocals[i] + parts.bass[i] + parts.drums[i];

const weights = new URL('../public/models/', import.meta.url).pathname;
const t0 = Date.now();
const stems = await separateChannels([mix, mix], SR, { weights });
console.log(`separated 12 s in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const corr = (a, b) => {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return ab / Math.sqrt(aa * bb + 1e-20);
};
let ok = true;
for (const key of ['vocals', 'bass', 'drums']) {
  const row = stems.map((s) => corr(s.channels[0], parts[key]));
  const own = row[stems.findIndex((s) => s.key === key)];
  console.log(key.padEnd(7), stems.map((s, i) => `${s.key} ${row[i].toFixed(2)}`).join('  '));
  if (!(own > 0.6 && own === Math.max(...row))) ok = false;
}
if (!ok) {
  console.error('a part did not come out in its own stem');
  process.exit(1);
}
console.log('separation OK');
