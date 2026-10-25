import React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EQ_BANDS, EQ_RANGE_DB, flatEq } from '@/lib/audio/eq';

const fmtHz = (f) => (f >= 1000 ? `${f / 1000}k` : `${f}`);

// One band: a vertical slider centred on 0 dB.
function Band({ band, value, onChange }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <span className="num text-[10px] text-muted-foreground">{value > 0 ? '+' : ''}{value.toFixed(1)}</span>
      <SliderPrimitive.Root
        orientation="vertical"
        min={-EQ_RANGE_DB}
        max={EQ_RANGE_DB}
        step={0.5}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        onDoubleClick={() => onChange(0)}
        className="relative flex h-28 w-5 touch-none select-none flex-col items-center"
        aria-label={band.label}
      >
        <SliderPrimitive.Track className="relative w-1.5 grow overflow-hidden rounded-full bg-primary/20">
          <span className="absolute left-0 right-0 top-1/2 h-px bg-primary/50" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border border-primary/60 bg-background shadow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
      </SliderPrimitive.Root>
      <span className="text-[10px] font-medium">{band.label}</span>
      <span className="num text-[9px] text-muted-foreground">{fmtHz(band.freq)}</span>
    </div>
  );
}

// The master equalizer: five broad bands, ±6 dB, double-click a band to reset it.
export default function EqPanel({ eq, onChange }) {
  const values = eq || flatEq();
  const touched = EQ_BANDS.some((b) => values[b.key]);
  return (
    <div className="mt-5 rounded-2xl border border-hairline px-3 py-3">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Equalizador</p>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-[10px]"
          disabled={!touched}
          onClick={() => onChange(flatEq())}
        >
          <RotateCcw className="h-3 w-3" /> Zerar
        </Button>
      </div>
      <div className="flex justify-between px-1">
        {EQ_BANDS.map((b) => (
          <Band key={b.key} band={b} value={values[b.key] ?? 0} onChange={(v) => onChange({ ...values, [b.key]: v })} />
        ))}
      </div>
    </div>
  );
}
