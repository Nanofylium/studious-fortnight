import React from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import MasterMeter from './MasterMeter';

const CHAIN = ['De-metálico', 'Calor', 'Fita', 'Compressão', 'Largura', 'Limitador'];

const TARGETS = [
  { value: -16, label: 'Dinâmico' },
  { value: -14, label: 'Streaming' },
  { value: -11, label: 'Alto' },
  { value: -9, label: 'Club' },
];

function ParamRow({ label, value, display, min, max, step, onChange }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</span>
        <span className="num text-[11px]">{display}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} />
    </div>
  );
}

export default function MasterPanel({ master, getAnalyser, onMaster, onAuto }) {
  const pct = (v) => `${Math.round(v * 100)}%`;

  return (
    <section className="rounded-3xl border border-hairline bg-panel/70 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="font-heading text-[13px] font-semibold uppercase tracking-[0.18em]">Master</h2>
          <span className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-[3px] text-[9px] uppercase tracking-[0.14em] text-primary">
            <Sparkles className="h-3 w-3" /> auto
          </span>
        </div>
        <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={onAuto}>
          Recalcular
        </Button>
      </div>

      <div
        className={`mb-4 flex items-center justify-between gap-3 rounded-2xl border px-3 py-2.5 ${
          master.streaming ? 'border-primary/40 bg-primary/[0.07]' : 'border-hairline'
        }`}
      >
        <div className="min-w-0">
          <p className="text-[12px] font-medium">Modo streaming</p>
          <p className="text-[10px] leading-snug text-muted-foreground">
            Garante -14 LUFS integrado e teto de -1 dBTP (pico real) no arquivo baixado.
          </p>
        </div>
        <Switch
          checked={!!master.streaming}
          onCheckedChange={(v) => onMaster(v ? { streaming: true, targetLufs: -14 } : { streaming: false })}
        />
      </div>

      <MasterMeter getAnalyser={getAnalyser} />

      <div className="mt-4 flex flex-wrap gap-1.5">
        {CHAIN.map((step) => (
          <span
            key={step}
            className={`rounded-full border px-2 py-[3px] text-[9px] uppercase tracking-[0.12em] ${
              master.bypass ? 'border-hairline text-muted-foreground' : 'border-primary/25 bg-primary/[0.07] text-primary'
            }`}
          >
            {step}
          </span>
        ))}
      </div>

      <div className="mt-5 space-y-4">
        <ParamRow
          label="De-metálico"
          value={master.deMetallic}
          display={pct(master.deMetallic)}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => onMaster({ deMetallic: v })}
        />
        <ParamRow
          label="Calor analógico"
          value={master.warmth}
          display={pct(master.warmth)}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => onMaster({ warmth: v })}
        />
        <ParamRow
          label="Largura estéreo"
          value={master.width}
          display={pct(master.width)}
          min={0.5}
          max={1.8}
          step={0.01}
          onChange={(v) => onMaster({ width: v })}
        />
        <ParamRow
          label="Saturação de fita"
          value={master.tape}
          display={pct(master.tape)}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => onMaster({ tape: v })}
        />
      </div>

      <div className="mt-5">
        <p className="mb-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Volume alvo</p>
        <div className="grid grid-cols-4 gap-1.5">
          {TARGETS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => onMaster({ targetLufs: t.value, streaming: t.value === -14 })}
              className={`rounded-lg border px-1 py-2 text-[10px] transition-colors ${
                master.targetLufs === t.value
                  ? 'border-primary/60 bg-primary/15 text-primary'
                  : 'border-hairline text-muted-foreground hover:border-white/25'
              }`}
            >
              <span className="block num text-[11px]">{t.value}</span>
              <span className="block">{t.label}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}