import React, { useEffect, useRef } from 'react';

export default function Waveform({ peaks, height = 40, color = '#f59e0b', progress = 0 }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !peaks || !peaks.length) return;
    const W = 800;
    const H = Math.round(height);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const mid = H / 2;
    const n = peaks.length;
    const barW = W / n;
    const head = Math.round(progress * n);

    for (let i = 0; i < n; i++) {
      const v = Math.min(1, Math.max(0.03, peaks[i]));
      const h = v * (mid - 1);
      ctx.fillStyle = i <= head ? color : 'rgba(255,255,255,0.16)';
      ctx.fillRect(i * barW + 0.4, mid - h, Math.max(0.8, barW - 0.8), h * 2);
    }
  }, [peaks, height, color, progress]);

  return <canvas ref={ref} className="block w-full" style={{ height }} />;
}