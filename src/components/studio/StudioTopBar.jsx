import React from 'react';
import { Download, Loader2, Trash2, Waves } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatTime } from './Transport';

export default function StudioTopBar({ stemCount, duration, sampleRate, exporting, onExport, onClear, canExport }) {
  return (
    <header className="sticky top-0 z-20 border-b border-hairline bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1680px] flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 lg:px-8">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
            <Waves className="h-4 w-4" />
          </span>
          <div className="leading-none">
            <p className="font-heading text-[15px] font-semibold tracking-[0.22em]">FORJA</p>
            <p className="mt-1 text-[9px] uppercase tracking-[0.22em] text-muted-foreground">studio mastering</p>
          </div>
        </div>

        {stemCount > 0 && (
          <p className="num hidden text-[11px] text-muted-foreground sm:block">
            {stemCount} stems · {formatTime(duration)} · {(sampleRate / 1000).toFixed(1)} kHz
          </p>
        )}

        <div className="ml-auto flex items-center gap-2">
          {stemCount > 0 && (
            <Button variant="ghost" size="sm" className="h-9 gap-2 text-[11px]" onClick={onClear}>
              <Trash2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Nova sessão</span>
            </Button>
          )}
          <Button size="sm" className="h-9 gap-2 text-[11px]" onClick={onExport} disabled={!canExport || !!exporting}>
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {exporting ? `Renderizando ${exporting.pass}/3` : 'Baixar master'}
          </Button>
        </div>
      </div>
    </header>
  );
}