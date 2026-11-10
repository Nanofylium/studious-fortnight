// Session stems as editor tracks (waveform-playlist ClipTracks), one clip
// each at zero, keeping the stem's id so edits map back to it.
import { createClipFromSeconds, createTrack } from '@waveform-playlist/core';

export function tracksFromStems(stems) {
  return stems.map((s) => ({
    ...createTrack({
      name: s.name,
      clips: [createClipFromSeconds({ audioBuffer: s.buffer, startTime: 0, name: s.name })],
      color: s.color,
    }),
    id: s.id,
  }));
}
