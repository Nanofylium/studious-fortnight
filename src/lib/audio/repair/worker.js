// Runs the repair stage off the main thread so the UI keeps responding while
// a long stem is processed.
import { repairChannels } from './pipeline.js';

self.onmessage = (e) => {
  const { id, channels, sampleRate } = e.data;
  try {
    const { channels: out, summary } = repairChannels(channels, sampleRate);
    self.postMessage({ id, channels: out, summary }, out.map((c) => c.buffer));
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
