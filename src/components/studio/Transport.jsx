import React, { useState } from 'react';
import { Pause, Play, Square, Sliders } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function Transport({ playing, position, duration, bypass, onPlay, onPause, onStop, onSeek, onToggleBypass }) {
  const [scrub, setScrub] = useState(null);
  const shown = scrub ?? position;

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-hairline bg-background/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1680px] flex-wrap items-center gap-4 px-4 py-3 lg:px-8">
        <div className="flex items-center gap-2">
          <Button
            size="icon"
            className="h-10 w-10 rounded-full"
            onClick={playing ? onPause : onPlay}
            aria-label={playing ? 'Pausar' : 'Tocar'}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
          </Button>
          <Button size="icon" variant="secondary" className="h-10 w-10 rounded-full" onClick={onStop} aria-label="Parar">
            <Square className="h-3.5 w-3.5" />
          </Button>
        </div>

        <span className="num w-[54px] text-[12px] text-muted-foreground">{formatTime(shown)}</span>

        <div className="order-last min-w-[200px] flex-1 lg:order-none">
          <Slider
            value={[Math.min(shown, duration || 1)]}
            min={0}
            max={duration || 1}
            step={0.1}
            onValueChange={([v]) => setScrub(v)}
            onValueCommit={([v]) => {
              setScrub(null);
              onSeek(v);
            }}
          />
        </div>

        <span className="num w-[54px] text-right text-[12px] text-muted-foreground">{formatTime(duration)}</span>

        <Button
          variant={bypass ? 'secondary' : 'outline'}
          size="sm"
          onClick={onToggleBypass}
          className="h-9 gap-2 text-[11px] uppercase tracking-[0.14em]"
        >
          <Sliders className="h-3.5 w-3.5" />
          {bypass ? 'Ouvindo original' : 'Ouvindo master'}
        </Button>
      </div>
    </div>
  );
}