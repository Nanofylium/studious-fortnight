import { denoiseChannels } from './dsp';
import { analyzeStem, guessRole } from './analysis';

export const MAX_STEMS = 12;

const AUDIO_EXT = /\.(wav|mp3|m4a|aac|flac|ogg|oga|opus|aif|aiff|webm)$/i;

export function isAudioFile(file) {
  return file.type.startsWith('audio/') || AUDIO_EXT.test(file.name);
}

export function pickStemFiles(files, alreadyLoaded = 0) {
  const room = Math.max(0, MAX_STEMS - alreadyLoaded);
  return Array.from(files).filter(isAudioFile).slice(0, room);
}

// Decodes each stem, cleans the low-level artefact floor and measures it.
export async function loadStemFiles(files, decodeCtx, onProgress) {
  const out = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const step = { name: file.name, index: i + 1, total: files.length };

    onProgress?.({ ...step, phase: 'decode' });
    const buffer = await decodeCtx.decodeAudioData(await file.arrayBuffer());

    onProgress?.({ ...step, phase: 'clean' });
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    denoiseChannels(channels, buffer.sampleRate);

    onProgress?.({ ...step, phase: 'analyze' });
    out.push({
      id: `${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 7)}`,
      name: file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || `Stem ${i + 1}`,
      buffer,
      duration: buffer.duration,
      sampleRate: buffer.sampleRate,
      analysis: analyzeStem(buffer),
      role: guessRole(file.name),
    });
  }
  return out;
}