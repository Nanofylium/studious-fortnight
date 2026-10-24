import React, { useEffect, useRef } from 'react';

const W = 720;
const H = 118;
const BARS = 52;

export default function MasterMeter({ getAnalyser }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      for (let i = 1; i < 8; i++) ctx.fillRect((W / 8) * i, 0, 1, H - 1);

      const analyser = getAnalyser?.();
      if (!analyser) return;
      const bins = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(bins);
      const barW = W / BARS;

      for (let i = 0; i < BARS; i++) {
        const idx = Math.floor(Math.pow(i / BARS, 1.8) * (bins.length - 1));
        const v = bins[idx] / 255;
        const h = Math.max(1, v * (H - 6));
        ctx.fillStyle = `hsl(${32 - v * 14} 92% ${42 + v * 26}%)`;
        ctx.fillRect(i * barW + 1, H - h, barW - 2, h);
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [getAnalyser]);

  return (
    <canvas
      ref={ref}
      className="block w-full rounded-xl border border-hairline bg-black/30"
      style={{ height: H }}
    />
  );
}