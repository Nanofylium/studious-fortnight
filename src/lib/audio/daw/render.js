// Renders the editor's tracks (waveform-playlist ClipTracks) back into plain
// stereo stems for the Forja mix and master. Each clip is placed at its start,
// read from its offset, scaled by its gain and faded in/out; the track's
// volume and pan apply on top, mute and solo decide what is rendered. Edges
// without a fade get a 3 ms ramp so cuts never click.
import { generateCurve } from '@waveform-playlist/core';

const EDGE = 0.003;

const channelOf = (buffer, c) => buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));

// Fade curve of `n` samples (0→1 for a fade in, 1→0 for a fade out).
function curve(fade, n, fadeIn) {
  if (n <= 1) return null;
  return generateCurve(fade?.type || 'linear', n, fadeIn);
}

export function renderClip(clip, out, sr) {
  const buf = clip.audioBuffer;
  if (!buf || clip.durationSamples <= 0) return;
  const len = clip.durationSamples;
  const inN = Math.min(len, Math.round((clip.fadeIn?.duration ?? EDGE) * sr));
  const outN = Math.min(len - inN, Math.round((clip.fadeOut?.duration ?? EDGE) * sr));
  const cin = curve(clip.fadeIn, inN, true);
  const cout = curve(clip.fadeOut, outN, false);
  const g = clip.gain ?? 1;
  for (let c = 0; c < 2; c++) {
    const src = channelOf(buf, c);
    const dst = out[c];
    for (let i = 0; i < len; i++) {
      const j = clip.startSample + i;
      const k = clip.offsetSamples + i;
      if (j < 0 || j >= dst.length || k >= src.length) continue;
      let v = src[k] * g;
      if (cin && i < inN) v *= cin[i];
      if (cout && i >= len - outN) v *= cout[i - (len - outN)];
      dst[j] += v;
    }
  }
}

export const trackEnd = (t) => t.clips.reduce((m, c) => Math.max(m, c.startSample + c.durationSamples), 0);

// Equal-power pan, centre at unity (the Forja faders do the real panning).
function panGains(pan = 0) {
  const p = Math.max(-1, Math.min(1, pan));
  if (p === 0) return [1, 1];
  const a = ((p + 1) * Math.PI) / 4;
  return [Math.cos(a) * Math.SQRT2, Math.sin(a) * Math.SQRT2];
}

export function renderTrack(track, sr, length) {
  const out = [new Float32Array(length), new Float32Array(length)];
  for (const clip of track.clips) renderClip(clip, out, sr);
  const vol = track.volume ?? 1;
  const [gl, gr] = panGains(track.pan);
  if (vol !== 1 || gl !== 1 || gr !== 1) {
    for (let i = 0; i < length; i++) {
      out[0][i] *= vol * gl;
      out[1][i] *= vol * gr;
    }
  }
  return out;
}

// The tracks that sound: soloed ones if any are soloed, else all unmuted,
// and only tracks that have audio.
export function audibleTracks(tracks) {
  const withAudio = tracks.filter((t) => t.clips.some((c) => c.audioBuffer && c.durationSamples > 0));
  const solo = withAudio.filter((t) => t.soloed);
  return (solo.length ? solo : withAudio).filter((t) => !t.muted || t.soloed);
}

// All audible tracks rendered to the same length (the latest clip end).
export function renderTracks(tracks, sr) {
  const list = audibleTracks(tracks);
  const length = list.reduce((m, t) => Math.max(m, trackEnd(t)), 0);
  return list.map((t) => ({ track: t, channels: renderTrack(t, sr, length) }));
}
