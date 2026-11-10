// RVC off the main thread: the three networks stay loaded between
// conversions (they take a while to build), the UI keeps running.
import { convertVoice, probeModelSr } from './core.js';
import { loadModelFiles } from './store.js';
import wasmMjs from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import wasmBin from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import gpuMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import gpuBin from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';

let ort = null;
let loaded = null; // { key, sessions, modelSr }

async function sessionsFor(key) {
  if (loaded?.key === key) return loaded;
  // Straight from IndexedDB: the files never cross threads.
  const files = await loadModelFiles();
  if (loaded) await Promise.all(Object.values(loaded.sessions).map((s) => s.release?.()));
  loaded = null;
  const build = async (device) => {
    ort = device === 'webgpu' ? await import('onnxruntime-web/webgpu') : await import('onnxruntime-web/wasm');
    // The runtime's glue as its own file: its threads start from that URL,
    // not from this worker's bundle (which would run this handler again).
    ort.env.wasm.wasmPaths = device === 'webgpu' ? { mjs: gpuMjs, wasm: gpuBin } : { mjs: wasmMjs, wasm: wasmBin };
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, Math.max(1, (self.navigator?.hardwareConcurrency || 2) - 1)) : 1;
    const opts = { executionProviders: device === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'], graphOptimizationLevel: 'all' };
    const sessions = {};
    for (const k of ['rmvpe', 'hubert', 'voice']) {
      sessions[k] = await ort.InferenceSession.create(new Uint8Array(files[k]), opts);
    }
    return sessions;
  };
  // WebGPU only with a real adapter (a GPU without one can stall session
  // creation instead of failing); wasm, with threads, everywhere.
  const adapter = await self.navigator?.gpu?.requestAdapter?.().catch(() => null);
  const gpu = adapter && !adapter.info?.isFallbackAdapter && adapter.info?.architecture !== 'swiftshader';
  let sessions;
  try {
    sessions = await build(gpu ? 'webgpu' : 'wasm');
  } catch (err) {
    if (!gpu) throw err;
    sessions = await build('wasm');
  }
  loaded = { key, sessions, modelSr: await probeModelSr(ort, sessions.voice) };
  return loaded;
}

self.onmessage = async (e) => {
  const { id, key, mono, sampleRate, semitones } = e.data;
  try {
    self.postMessage({ id, stage: 'load' });
    const { sessions, modelSr } = await sessionsFor(key);
    self.postMessage({ id, stage: 'convert', progress: 0 });
    const { audio, voicedPct } = await convertVoice(ort, sessions, mono, sampleRate, {
      semitones,
      modelSr,
      onProgress: (p) => self.postMessage({ id, stage: 'convert', progress: p }),
    });
    self.postMessage({ id, audio, voicedPct, modelSr }, [audio.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
