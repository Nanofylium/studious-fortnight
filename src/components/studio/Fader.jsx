import React, { useCallback, useRef } from 'react';
import { clamp, dbToGain, gainToDb } from '@/lib/audio/dsp';

// Vertical channel fader in dB: -40 dB at the bottom, +6 dB at the top, with
// the travel bent so unity sits about three quarters of the way up, like a
// console fader. Drag, arrow keys or double-click (back to 0 dB).
const MIN_DB = -40;
const MAX_DB = 6;
const CURVE = 0.6;

const dbToPos = (db) => Math.pow((clamp(db, MIN_DB, MAX_DB) - MIN_DB) / (MAX_DB - MIN_DB), 1 / CURVE);
const posToDb = (p) => MIN_DB + Math.pow(clamp(p, 0, 1), CURVE) * (MAX_DB - MIN_DB);

const TICKS = [6, 0, -6, -12, -24, -40];

export default function Fader({ value, onChange, height = 132 }) {
  const trackRef = useRef(null);
  const pos = dbToPos(gainToDb(value));

  const setFromEvent = useCallback(
    (e) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      const p = 1 - (e.clientY - rect.top) / rect.height;
      onChange(dbToGain(posToDb(p)));
    },
    [onChange],
  );

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setFromEvent(e);
  };

  const onPointerMove = (e) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) setFromEvent(e);
  };

  const onKeyDown = (e) => {
    const step = e.shiftKey ? 3 : 0.5;
    const db = gainToDb(value);
    if (e.key === 'ArrowUp') onChange(dbToGain(clamp(db + step, MIN_DB, MAX_DB)));
    else if (e.key === 'ArrowDown') onChange(dbToGain(clamp(db - step, MIN_DB, MAX_DB)));
    else return;
    e.preventDefault();
  };

  return (
    <div className="flex items-stretch gap-1.5" style={{ height }}>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-orientation="vertical"
        aria-valuemin={MIN_DB}
        aria-valuemax={MAX_DB}
        aria-valuenow={Number(gainToDb(value).toFixed(1))}
        aria-label="Volume"
        className="relative w-7 cursor-ns-resize touch-none rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onDoubleClick={() => onChange(1)}
        onKeyDown={onKeyDown}
      >
        <div className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 rounded-full bg-secondary" />
        <div
          className="absolute bottom-0 left-1/2 w-1 -translate-x-1/2 rounded-full bg-primary/70"
          style={{ height: `${pos * 100}%` }}
        />
        <div
          className="absolute left-1/2 h-3 w-7 -translate-x-1/2 translate-y-1/2 rounded-[4px] border border-hairline bg-foreground/90 shadow"
          style={{ bottom: `${pos * 100}%` }}
        >
          <div className="mx-auto mt-[5px] h-px w-4 bg-background" />
        </div>
      </div>
      <div className="relative w-4">
        {TICKS.map((t) => (
          <span
            key={t}
            className="num absolute right-0 translate-y-1/2 text-[8px] leading-none text-muted-foreground"
            style={{ bottom: `${dbToPos(t) * 100}%` }}
          >
            {t > 0 ? `+${t}` : t}
          </span>
        ))}
      </div>
    </div>
  );
}
