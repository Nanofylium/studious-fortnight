// RVC (Retrieval-based Voice Conversion, RVC-Project, MIT) inference on
// plain arrays: the same pipeline as the project's ONNX inference
// (rvc/lib/infer_pack/onnx_inference.py), reimplemented in JS so it runs in
// the browser with onnxruntime-web, or in node with onnxruntime-node.
//
//   voice ─► 16 kHz ─► HuBERT/ContentVec features (50 fps, repeated to 100)
//                  └─► log-mel ─► RMVPE ─► f0 (100 fps)
//   features + f0 (+ transpose) ─► the singer's model (NSF-HiFiGAN) ─► voice
//
// The audio is converted in windows of WINDOW seconds with PAD seconds of
// context on each side, crossfaded over the overlap, so long songs fit in
// memory and the attention stays short.
import { fftInPlace } from '../dsp.js';

export const SR16 = 16000;
const HOP16 = 160; // 100 frames per second at 16 kHz
const WINDOW = 12;
const PAD = 1;
const F0_MIN = 50;
const F0_MAX = 1100;
const MEL_MIN = 1127 * Math.log(1 + F0_MIN / 700);
const MEL_MAX = 1127 * Math.log(1 + F0_MAX / 700);

// ------------------------------------------------------------ resampling

// Windowed-sinc resampler (Kaiser-ish via Blackman, 32 zero crossings), with
// the cutoff at the lower of the two Nyquists.
export function resample(x, from, to) {
  if (from === to) return Float32Array.from(x);
  const ratio = to / from;
  const n = Math.floor(x.length * ratio);
  const y = new Float32Array(n);
  const fc = Math.min(1, ratio); // cutoff relative to input Nyquist
  const half = 32 / fc; // taps on each side, in input samples
  for (let i = 0; i < n; i++) {
    const t = i / ratio;
    const c = Math.floor(t);
    let acc = 0;
    let wsum = 0;
    const lo = Math.max(0, Math.ceil(t - half));
    const hi = Math.min(x.length - 1, Math.floor(t + half));
    for (let k = lo; k <= hi; k++) {
      const d = k - t;
      const arg = Math.PI * d * fc;
      const sinc = d === 0 ? 1 : Math.sin(arg) / arg;
      const wpos = (d + half) / (2 * half);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * wpos) + 0.08 * Math.cos(4 * Math.PI * wpos);
      const v = sinc * w;
      acc += x[k] * v;
      wsum += v;
    }
    y[i] = wsum ? acc / wsum : 0;
    if (c < 0) y[i] = 0;
  }
  return y;
}

// ------------------------------------------------------------ RMVPE input

// librosa.filters.mel(sr=16000, n_fft=1024, n_mels=128, fmin=30, fmax=8000,
// htk=True) with the default Slaney area normalisation.
export function melBasis(sr = SR16, nFft = 1024, nMels = 128, fmin = 30, fmax = 8000) {
  const hz2mel = (f) => 2595 * Math.log10(1 + f / 700);
  const mel2hz = (m) => 700 * (10 ** (m / 2595) - 1);
  const bins = nFft / 2 + 1;
  const fftFreqs = Float64Array.from({ length: bins }, (_, k) => (k * sr) / nFft);
  const mMin = hz2mel(fmin);
  const mMax = hz2mel(fmax);
  const pts = Float64Array.from({ length: nMels + 2 }, (_, i) => mel2hz(mMin + ((mMax - mMin) * i) / (nMels + 1)));
  const basis = Array.from({ length: nMels }, () => new Float32Array(bins));
  for (let m = 0; m < nMels; m++) {
    const [f0, f1, f2] = [pts[m], pts[m + 1], pts[m + 2]];
    const enorm = 2 / (f2 - f0);
    for (let k = 0; k < bins; k++) {
      const f = fftFreqs[k];
      const lower = (f - f0) / (f1 - f0);
      const upper = (f2 - f) / (f2 - f1);
      basis[m][k] = Math.max(0, Math.min(lower, upper)) * enorm;
    }
  }
  return basis;
}

let MEL = null;

// log(max(mel, 1e-5)) of |STFT| (n_fft = win = 1024, hop 160, Hann, centred
// with reflect padding), shape [128][frames], as torch.stft does it.
export function logMel(x16) {
  MEL = MEL || melBasis();
  const n = 1024;
  const pad = n / 2;
  const frames = Math.floor(x16.length / HOP16) + 1;
  const at = (i) => {
    // reflect padding
    let j = i - pad;
    if (j < 0) j = -j;
    if (j >= x16.length) j = 2 * (x16.length - 1) - j;
    return x16[Math.max(0, Math.min(x16.length - 1, j))] || 0;
  };
  const win = Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  const out = Array.from({ length: 128 }, () => new Float32Array(frames));
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const mag = new Float32Array(n / 2 + 1);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < n; i++) {
      re[i] = at(f * HOP16 + i) * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let k = 0; k <= n / 2; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    for (let m = 0; m < 128; m++) {
      const b = MEL[m];
      let s = 0;
      for (let k = 0; k <= n / 2; k++) s += b[k] * mag[k];
      out[m][f] = Math.log(Math.max(s, 1e-5));
    }
  }
  return { mel: out, frames };
}

const CENTS = (() => {
  const c = new Float32Array(368);
  for (let i = 0; i < 360; i++) c[i + 4] = 20 * i + 1997.3794084376191;
  return c;
})();

// RMVPE salience [frames][360] → f0 in Hz (0 = unvoiced): weighted average of
// the cents around the peak, as RMVPE.decode does.
export function decodeF0(salience, frames, thred = 0.03) {
  const f0 = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    const row = salience.subarray(t * 360, (t + 1) * 360);
    let arg = 0;
    let max = -Infinity;
    for (let k = 0; k < 360; k++) {
      if (row[k] > max) {
        max = row[k];
        arg = k;
      }
    }
    if (max <= thred) continue;
    let ps = 0;
    let ws = 0;
    for (let k = arg - 4; k <= arg + 4; k++) {
      const s = k >= 0 && k < 360 ? row[k] : 0;
      ps += s * CENTS[k + 4];
      ws += s;
    }
    const cents = ps / ws;
    const hz = 10 * 2 ** (cents / 1200);
    f0[t] = hz === 10 ? 0 : hz;
  }
  return f0;
}

// f0 (Hz) → the model's coarse pitch (1..255) and fine pitch.
export function coarsePitch(f0, semitones = 0) {
  const k = 2 ** (semitones / 12);
  const pitchf = Float32Array.from(f0, (v) => v * k);
  const pitch = new BigInt64Array(f0.length);
  for (let i = 0; i < f0.length; i++) {
    let m = 1127 * Math.log(1 + pitchf[i] / 700);
    if (m > 0) m = ((m - MEL_MIN) * 254) / (MEL_MAX - MEL_MIN) + 1;
    if (m <= 1) m = 1;
    if (m > 255) m = 255;
    pitch[i] = BigInt(Math.round(m));
  }
  return { pitch, pitchf };
}

// ------------------------------------------------------------ models

// sessions: { hubert, rmvpe, voice } onnxruntime InferenceSessions; ort: the
// onnxruntime module (for Tensor).
export async function detectF0(ort, rmvpe, x16) {
  const { mel, frames } = logMel(x16);
  const padded = 32 * Math.ceil(frames / 32);
  const data = new Float32Array(128 * padded);
  for (let m = 0; m < 128; m++) data.set(mel[m], m * padded);
  const input = rmvpe.inputNames[0];
  const out = await rmvpe.run({ [input]: new ort.Tensor('float32', data, [1, 128, padded]) });
  const hidden = out[rmvpe.outputNames[0]].data; // [1, padded, 360]
  return decodeF0(hidden, frames);
}

async function runHubert(ort, hubert, x16) {
  const input = hubert.inputNames[0];
  const dims = hubert.inputMetadata?.[0]?.shape?.length ?? 2;
  const shape = dims === 3 ? [1, 1, x16.length] : [1, x16.length];
  const out = await hubert.run({ [input]: new ort.Tensor('float32', x16, shape) });
  const t = out[hubert.outputNames[0]]; // [1, T, 768]
  return { data: t.data, frames: t.dims[1], dim: t.dims[2] };
}

// One window: 16 kHz audio in, the singer's voice at the model's rate out.
async function convertWindow(ort, sessions, x16, { semitones, modelSr, sid = 0, seed = 1 }) {
  const f0 = await detectF0(ort, sessions.rmvpe, x16);
  const h = await runHubert(ort, sessions.hubert, x16);
  // Features at 50 fps, repeated to 100 fps to line up with the f0 frames.
  const T = Math.min(h.frames * 2, f0.length);
  const phone = new Float32Array(T * h.dim);
  for (let t = 0; t < T; t++) phone.set(h.data.subarray((t >> 1) * h.dim, ((t >> 1) + 1) * h.dim), t * h.dim);
  const { pitch, pitchf } = coarsePitch(f0.subarray(0, T), semitones);
  let s = seed >>> 0;
  const gauss = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    const u = (s + 1) / 4294967297;
    s = (s * 1664525 + 1013904223) >>> 0;
    const v = (s + 1) / 4294967297;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  // Noise scaled by 2/3, as the PyTorch pipeline does at inference.
  const rnd = Float32Array.from({ length: 192 * T }, () => 0.66666 * gauss());
  const v = sessions.voice;
  const feeds = {
    phone: new ort.Tensor('float32', phone, [1, T, h.dim]),
    phone_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(T)]), [1]),
    pitch: new ort.Tensor('int64', pitch, [1, T]),
    pitchf: new ort.Tensor('float32', pitchf, [1, T]),
    ds: new ort.Tensor('int64', BigInt64Array.from([BigInt(sid)]), [1]),
    rnd: new ort.Tensor('float32', rnd, [1, 192, T]),
  };
  const out = await v.run(feeds);
  const audio = out[v.outputNames[0]].data;
  // Expected length: T frames of modelSr/100 samples.
  const want = Math.round((T * modelSr) / 100);
  const y = new Float32Array(want);
  y.set(audio.subarray(0, Math.min(want, audio.length)));
  return { audio: y, voicedPct: f0.reduce((a, v) => a + (v > 0 ? 1 : 0), 0) / Math.max(1, f0.length) };
}

// The model's output rate, from what it makes of a short silent input:
// T frames come out as T × sr / 100 samples.
export async function probeModelSr(ort, voice) {
  const T = 64;
  const out = await voice.run({
    phone: new ort.Tensor('float32', new Float32Array(T * 768), [1, T, 768]),
    phone_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(T)]), [1]),
    pitch: new ort.Tensor('int64', new BigInt64Array(T).fill(1n), [1, T]),
    pitchf: new ort.Tensor('float32', new Float32Array(T), [1, T]),
    ds: new ort.Tensor('int64', BigInt64Array.from([0n]), [1]),
    rnd: new ort.Tensor('float32', new Float32Array(192 * T), [1, 192, T]),
  });
  const sr = (out[voice.outputNames[0]].data.length / T) * 100;
  return [32000, 40000, 44100, 48000].reduce((a, b) => (Math.abs(b - sr) < Math.abs(a - sr) ? b : a));
}

// RVC's "volume envelope" mix: the converted voice takes on the loudness
// contour of the original (rate 0 = fully the original's, 1 = untouched),
// measured in 50 ms blocks and interpolated. Keeps breaths and silences
// where they were and the dynamics of the performance.
export function matchEnvelope(input, output, sr, rate = 0.25) {
  const hop = Math.round(sr * 0.05);
  const blocks = Math.ceil(output.length / hop);
  const env = (x) => {
    const e = new Float32Array(blocks);
    for (let b = 0; b < blocks; b++) {
      const a = Math.max(0, b * hop - hop);
      const z = Math.min(x.length, b * hop + 2 * hop);
      let s = 0;
      for (let i = a; i < z; i++) s += x[i] * x[i];
      e[b] = Math.sqrt(s / Math.max(1, z - a));
    }
    return e;
  };
  const e1 = env(input);
  const e2 = env(output);
  const gain = Float32Array.from(e1, (v, b) => (Math.max(v, 1e-6) / Math.max(e2[b], 1e-6)) ** (1 - rate));
  const y = new Float32Array(output.length);
  for (let i = 0; i < y.length; i++) {
    const p = i / hop - 0.5;
    const b = Math.max(0, Math.min(blocks - 1, Math.floor(p)));
    const f = Math.max(0, Math.min(1, p - b));
    const g = gain[b] + (gain[Math.min(blocks - 1, b + 1)] - gain[b]) * f;
    y[i] = output[i] * Math.min(g, 8);
  }
  return y;
}

// Mono voice at `sr` → the singer's voice at `sr`, same length.
export async function convertVoice(ort, sessions, mono, sr, { semitones = 0, modelSr = 40000, envelope = 0.25, onProgress = () => {} } = {}) {
  const x16 = resample(mono, sr, SR16);
  const win = WINDOW * SR16;
  const pad = PAD * SR16;
  const fade = Math.round(0.05 * modelSr);
  const outLen = Math.round((x16.length * modelSr) / SR16);
  const out = new Float32Array(outLen);
  const starts = [];
  for (let s = 0; s < x16.length; s += win) starts.push(s);
  let voiced = 0;
  for (let w = 0; w < starts.length; w++) {
    const s = starts[w];
    const a = Math.max(0, s - pad);
    const b = Math.min(x16.length, s + win + pad);
    const seg = x16.subarray(a, b);
    const { audio, voicedPct } = await convertWindow(ort, sessions, seg, { semitones, modelSr, seed: w + 1 });
    voiced += voicedPct * (b - a);
    // Keep [s - fade, s + win + fade) of the window, crossfading the edges.
    const k = modelSr / SR16;
    const keepA = Math.round((s - a) * k) - (w ? fade : 0);
    const keepB = Math.min(audio.length, Math.round((Math.min(x16.length, s + win) - a) * k) + fade);
    const dst0 = Math.round(s * k) - (w ? fade : 0);
    for (let i = keepA; i < keepB; i++) {
      const j = dst0 + (i - keepA);
      if (j < 0 || j >= outLen) continue;
      let g = 1;
      const fromStart = i - keepA;
      const toEnd = keepB - i;
      if (w && fromStart < 2 * fade) g = Math.min(g, fromStart / (2 * fade));
      if (w < starts.length - 1 && toEnd < 2 * fade) g = Math.min(g, toEnd / (2 * fade));
      out[j] += audio[i] * g;
    }
    onProgress((w + 1) / starts.length);
  }
  const back = resample(out, modelSr, sr);
  const y = new Float32Array(mono.length);
  y.set(back.subarray(0, mono.length));
  return { audio: matchEnvelope(mono, y, sr, envelope), voicedPct: voiced / Math.max(1, x16.length) };
}
