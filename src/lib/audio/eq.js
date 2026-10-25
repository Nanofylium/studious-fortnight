// The master equalizer's bands: broad, musical moves (a mastering EQ, not a
// surgical one), shared by the audio graph and the panel.
export const EQ_BANDS = [
  { key: 'sub', label: 'Sub', type: 'lowshelf', freq: 60, q: 0.7 },
  { key: 'low', label: 'Grave', type: 'peaking', freq: 200, q: 0.8 },
  { key: 'mid', label: 'Médio', type: 'peaking', freq: 1000, q: 0.7 },
  { key: 'presence', label: 'Presença', type: 'peaking', freq: 3500, q: 0.8 },
  { key: 'air', label: 'Ar', type: 'highshelf', freq: 10000, q: 0.7 },
];

export const EQ_RANGE_DB = 6;

export const flatEq = () => Object.fromEntries(EQ_BANDS.map((b) => [b.key, 0]));
