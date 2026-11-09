// Main-thread side of the production worker; runs in place when workers are
// unavailable.
import { produceSong } from './pipeline.js';
import { ltas } from './voicematch.js';

const channelsOf = (buffer) => Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());

// stems: the session's stems ({ role, buffer }); muted stems are left out.
// reference: an AudioBuffer of a dry reference voice, or null.
export function produceStems(stems, { reference = null, options = {}, onStage = () => {} } = {}) {
  const sampleRate = stems[0].buffer.sampleRate;
  const job = {
    sampleRate,
    vocals: stems.filter((s) => s.role?.key === 'vocals').map((s) => channelsOf(s.buffer)),
    others: stems.filter((s) => s.role?.key !== 'vocals').map((s) => channelsOf(s.buffer)),
    reference: reference ? channelsOf(reference) : null,
  };
  const transfer = [...job.vocals, ...job.others, job.reference || []].flat().map((c) => c.buffer);
  let worker = null;
  try {
    if (typeof Worker !== 'undefined') worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }
  if (!worker) {
    const referenceLtas = job.reference ? ltas(job.reference) : null;
    return Promise.resolve().then(() => produceSong({ ...job, referenceLtas }, options, onStage));
  }
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      if (e.data.stage) return onStage(e.data.stage);
      worker.terminate();
      if (e.data.error) reject(new Error(e.data.error));
      else resolve({ channels: e.data.channels, report: e.data.report });
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error(err?.message || 'falha no worker de produção'));
    };
    worker.postMessage({ id: 1, job, options }, transfer);
  });
}
