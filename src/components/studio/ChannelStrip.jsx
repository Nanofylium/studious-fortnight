import React from 'react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import Fader from './Fader';
import Waveform from './Waveform';
import { gainToDb } from '@/lib/audio/dsp';

function panLabel(pan) {
  if (Math.abs(pan) < 0.04) return 'C';
  return `${Math.round(Math.abs(pan) * 100)}${pan < 0 ? 'E' : 'D'}`;
}

export default function ChannelStrip({ stem, params, solo, progress, onParam, onSolo }) {
  const db = params.muted ? '—' : gainToDb(params.gain).toFixed(1);
  const fixes = stem.repair ? stem.repair.clicks + stem.repair.dropouts + stem.repair.gaps : 0;

  return (
    <div
      className={`flex w-[124px] shrink-0 flex-col gap-3 rounded-2xl border border-hairline bg-panel/70 p-3 transition-colors sm:w-[136px] ${
        solo ? 'border-primary/50 bg-primary/[0.06]' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: stem.color }} />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium leading-tight">{stem.name}</p>
          <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground">{stem.role.label}</p>
        </div>
      </div>

      <Waveform peaks={stem.analysis.peaks} height={36} color={stem.color} progress={progress} />

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground">Pan</span>
          <span className="num text-[10px] text-muted-foreground">{panLabel(params.pan)}</span>
        </div>
        <Slider
          value={[params.pan]}
          min={-1}
          max={1}
          step={0.02}
          onValueChange={([v]) => onParam({ pan: v })}
        />
      </div>

      <div className="flex flex-1 items-center justify-center gap-3 pt-1">
        <Fader value={params.gain} onChange={(v) => onParam({ gain: v })} height={132} />
        <div className="text-right">
          <p className="num text-[12px]">{db}</p>
          <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground">dB</p>
          <p className="num mt-2 text-[10px] text-muted-foreground">{stem.analysis.harshness > 0.5 ? 'áspero' : 'ok'}</p>
          {fixes > 0 && (
            <p className="num text-[10px] text-primary" title="Estalos, dropouts e buracos corrigidos ao carregar">
              {fixes} {fixes === 1 ? 'reparo' : 'reparos'}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          size="sm"
          variant={params.muted ? 'default' : 'secondary'}
          className="h-7 px-0 text-[10px] tracking-widest"
          onClick={() => onParam({ muted: !params.muted })}
        >
          M
        </Button>
        <Button
          size="sm"
          variant={solo ? 'default' : 'secondary'}
          className="h-7 px-0 text-[10px] tracking-widest"
          onClick={onSolo}
        >
          S
        </Button>
      </div>
    </div>
  );
}