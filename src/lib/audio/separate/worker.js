// Runs the separation network off the main thread: the UI stays responsive
// through the minutes a whole song takes.
import { separateChannels } from './core.js';

self.onmessage = async (e) => {
  const { id, channels, sampleRate, weights } = e.data;
  const progress = (p) => self.postMessage({ id, progress: p });
  const attempt = (device) => separateChannels(channels, sampleRate, { weights, device, onProgress: progress });
  try {
    let stems;
    try {
      // WebGPU is several times faster where there is one; wasm everywhere.
      stems = await attempt(self.navigator?.gpu ? 'webgpu' : undefined);
    } catch (err) {
      if (!self.navigator?.gpu) throw err;
      stems = await attempt(undefined);
    }
    const transfer = stems.flatMap((s) => s.channels.map((c) => c.buffer));
    self.postMessage({ id, stems }, transfer);
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
