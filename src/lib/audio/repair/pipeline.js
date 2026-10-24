// The whole repair stage for one stem: find the defects, fill the holes, then
// de-metallize. Amounts are chosen from what was found, so clean material
// passes through (almost) untouched.
import { clamp } from '../dsp.js';
import { scanDefects } from './detect.js';
import { repairEvents } from './inpaint.js';
import { demetallize } from './demetal.js';

export function repairChannels(channels, sampleRate) {
  const buffer = {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    getChannelData: (c) => channels[c],
  };
  const scan = scanDefects(buffer);
  const { channels: filled, report } = repairEvents(channels, sampleRate, scan.events);

  const peaks = scan.resonances.peaks;
  const resonance = peaks.length ? clamp(0.45 + scan.resonances.score * 0.55, 0, 1) : 0;
  const air = scan.bandwidth.limited ? 0.6 : 0;
  // Incoherent highs in the side are AI "sizzle" only when the scan found
  // artefacts; on clean material they are reverb and width, so leave them.
  const stereo = channels.length > 1 && (peaks.length || scan.bandwidth.limited) ? 0.3 : 0;
  const out = demetallize(filled, sampleRate, scan, { resonance, air, stereo });

  const fixed = report.filter((r) => r.method !== 'none');
  return {
    channels: out,
    summary: {
      clicks: fixed.filter((r) => r.type === 'click').length,
      dropouts: fixed.filter((r) => r.type === 'dropout').length,
      gaps: fixed.filter((r) => r.type === 'gap').length,
      unrepaired: report.length - fixed.length,
      cutoffHz: scan.bandwidth.limited ? scan.bandwidth.cutoffHz : null,
      resonances: peaks.map((p) => Math.round(p.freq)),
    },
  };
}
