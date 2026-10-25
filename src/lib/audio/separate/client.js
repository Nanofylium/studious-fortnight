// Main-thread side of the separation worker.
const MODEL_FILE = 'models/scnet/scnet.int8.onnx';

let worker = null;
let seq = 0;
const pending = new Map();

// The model shipped with the app (desktop builds), else none: the library
// then fetches the hosted file and caches it.
let localWeights;
async function bundledWeights() {
  if (localWeights !== undefined) return localWeights;
  const base = new URL(import.meta.env.BASE_URL || '/', location.href);
  try {
    const res = await fetch(new URL(MODEL_FILE, base), { method: 'HEAD' });
    const type = res.headers.get('content-type') || '';
    localWeights = res.ok && !type.includes('text/html') ? new URL('models/', base).href : null;
  } catch {
    localWeights = null;
  }
  return localWeights;
}

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const job = pending.get(e.data.id);
      if (!job) return;
      if (e.data.progress != null) {
        job.onProgress?.(e.data.progress);
        return;
      }
      pending.delete(e.data.id);
      if (e.data.error) job.reject(new Error(e.data.error));
      else job.resolve(e.data.stems);
    };
    worker.onerror = (e) => {
      for (const job of pending.values()) job.reject(new Error(e.message || 'separation worker failed'));
      pending.clear();
      worker.terminate();
      worker = null;
    };
  }
  return worker;
}

// buffer: AudioBuffer → [{ key, name, channels }] in vocals, drums, bass, other order.
export async function separateBuffer(buffer, { onProgress } = {}) {
  const channels = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c).slice());
  const weights = (await bundledWeights()) || undefined;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ id, channels, sampleRate: buffer.sampleRate, weights }, channels.map((c) => c.buffer));
  });
}
