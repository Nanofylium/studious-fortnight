// Main-thread side of the RVC worker.
let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const job = pending.get(e.data.id);
      if (!job) return;
      if (e.data.stage) {
        job.onProgress?.(e.data);
        return;
      }
      pending.delete(e.data.id);
      if (e.data.error) job.reject(new Error(e.data.error));
      else job.resolve(e.data);
    };
    worker.onerror = (e) => {
      for (const job of pending.values()) job.reject(new Error(e.message || 'RVC worker failed'));
      pending.clear();
      worker.terminate();
      worker = null;
    };
  }
  return worker;
}

// buffer: AudioBuffer of a vocal → { audio (mono Float32Array at the
// buffer's rate), voicedPct, modelSr }. `key` names the stored model set, so
// the worker reuses its sessions while it does not change.
export async function convertBuffer(buffer, { semitones = 0, key, onProgress } = {}) {
  const n = buffer.length;
  const mono = new Float32Array(n);
  const chs = Math.min(2, buffer.numberOfChannels);
  for (let c = 0; c < chs; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / chs;
  }
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ id, key, mono, sampleRate: buffer.sampleRate, semitones }, [mono.buffer]);
  });
}

export function releaseWorker() {
  worker?.terminate();
  worker = null;
  pending.clear();
}
