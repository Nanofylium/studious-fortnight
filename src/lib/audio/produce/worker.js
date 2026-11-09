// Runs the production chain off the main thread; a 4-minute song takes a
// while and the UI must keep playing and responding.
import { produceSong } from './pipeline.js';
import { ltas } from './voicematch.js';

self.onmessage = (e) => {
  const { id, job, options } = e.data;
  try {
    const referenceLtas = job.reference ? ltas(job.reference) : null;
    const { channels, report } = produceSong({ ...job, referenceLtas }, options, (stage) => self.postMessage({ id, stage }));
    self.postMessage({ id, channels, report }, channels.map((c) => c.buffer));
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
