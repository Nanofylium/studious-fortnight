// Main-thread side of the repair worker. Falls back to running in place when
// workers are unavailable or the worker fails to start.
import { repairChannels } from './pipeline.js';

let worker = null;
let broken = false;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (broken || typeof Worker === 'undefined') return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch {
      broken = true;
      return null;
    }
    worker.onmessage = (e) => {
      const job = pending.get(e.data.id);
      if (!job) return;
      pending.delete(e.data.id);
      if (e.data.error) job.reject(new Error(e.data.error));
      else job.resolve({ channels: e.data.channels, summary: e.data.summary });
    };
    worker.onerror = () => {
      broken = true;
      worker.terminate();
      worker = null;
      for (const job of pending.values()) job.fallback();
      pending.clear();
    };
  }
  return worker;
}

// Channels are copied before they are handed over, so the caller's arrays stay
// valid whatever happens to the job.
export function repairStem(channels, sampleRate) {
  const copies = channels.map((c) => c.slice());
  const w = getWorker();
  if (!w) return Promise.resolve(repairChannels(copies, sampleRate));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, {
      resolve,
      reject,
      fallback: () => {
        try {
          resolve(repairChannels(channels.map((c) => c.slice()), sampleRate));
        } catch (err) {
          reject(err);
        }
      },
    });
    w.postMessage({ id, channels: copies, sampleRate }, copies.map((c) => c.buffer));
  });
}
