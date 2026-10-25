// AI stem separation: a finished song into vocals, drums, bass and other, so
// the smart mix can work on each part. The network is SCNet (Tong et al.,
// ICASSP 2024; MIT-licensed weights) run through @audio/neural-separate and
// ONNX Runtime, entirely on this machine. Its 13 MB int8 model is read from
// the app's own files when the build ships it (the desktop installer does),
// else fetched once from Hugging Face and kept in the browser cache.
import separate from '@audio/neural-separate';

export const MODEL = 'scnet';
export const STEMS = [
  { key: 'vocals', name: 'Vocals' },
  { key: 'drums', name: 'Drums' },
  { key: 'bass', name: 'Bass' },
  { key: 'other', name: 'Other' },
];

// `session` makes the ONNX session (a test double in the tests).
export async function separateChannels(channels, sampleRate, { weights, device, session, onProgress } = {}) {
  const input = channels.length > 1 ? channels.slice(0, 2) : [channels[0], channels[0]];
  const { stems } = await separate(input, {
    sampleRate,
    model: MODEL,
    weights,
    device,
    session,
    progress: onProgress ? ({ chunk, totalChunks }) => onProgress(chunk / totalChunks) : undefined,
  });
  return STEMS.map(({ key, name }) => {
    const st = stems[key];
    if (!st) throw new Error(`separation returned no ${key} stem`);
    return { key, name, channels: st.map((c) => Float32Array.from(c)) };
  });
}
