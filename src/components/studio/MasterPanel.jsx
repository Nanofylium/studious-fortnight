import React, { useRef } from 'react';
import { Disc3, Loader2, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import MasterMeter from './MasterMeter';

const CHAIN = ['De-metálico', 'Calor', 'Fita', 'Compressão', 'Largura', 'Limitador'];
// The smart-mix moves the current plan actually makes.
function smartChain(plan) {
  if (!plan) return [];
  return [plan.pocketHz && 'Espaço p/ voz', plan.vocalEnv && 'De-esser', plan.mudCutDb > 0.1 && 'Corte de embolo', 'Sala'].filter(
    Boolean,
  );
}

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

// Reference track: upload, strength of the tonal match, remove.
function ReferenceBlock({ reference, busy, onReference, onAmount, onClear }) {
  const inputRef = useRef(null);
  const peak = reference
    ? reference.curve.reduce((m, g) => (Math.abs(g) > Math.abs(m) ? g : m), 0) * reference.amount
    : 0;

  return (
    <div className="mb-4 rounded-2xl border border-hairline px-3 py-2.5">
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => {
          onReference(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {!reference ? (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[12px] font-medium">Música de referência</p>
            <p className="text-[10px] leading-snug text-muted-foreground">
              Suba uma faixa profissional do mesmo estilo: o Forja iguala timbre, largura e volume a ela.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1.5 text-[11px]"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Disc3 className="h-3.5 w-3.5" />}
            {busy ? 'Analisando' : 'Escolher'}
          </Button>
        </div>
      ) : (
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Disc3 className="h-3.5 w-3.5 shrink-0 text-primary" />
              <p className="truncate text-[12px] font-medium" title={reference.name}>{reference.name}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <span className="num text-[10px] text-muted-foreground">{reference.lufs.toFixed(1)} LUFS</span>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClear} aria-label="Remover referência">
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <ParamRow
            label="Igualar timbre"
            value={reference.amount}
            display={`${Math.round(reference.amount * 100)}% · ${peak >= 0 ? '+' : ''}${peak.toFixed(1)} dB`}
            min={0}
            max={1}
            step={0.01}
            onChange={onAmount}
          />
        </div>
      )}
    </div>
  );
}

// Smart per-stem mix: what it found (vocal pocket) and how much room.
function SmartMixBlock({ master, mixPlan, onMaster }) {
  const on = master.smartMix !== false;
  const hint = !mixPlan
    ? 'Ajusta cada stem como um engenheiro de mixagem.'
    : mixPlan.pocketHz
      ? `Abre espaço para a voz em ${(mixPlan.pocketHz / 1000).toFixed(1)} kHz enquanto ela canta, controla os "s" e junta tudo numa sala.`
      : 'Sem stem de voz: limpa graves e embolo e junta os stems numa sala.';
  return (
    <div className={`mb-4 rounded-2xl border px-3 py-2.5 ${on ? 'border-primary/40 bg-primary/[0.07]' : 'border-hairline'}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] font-medium">Mix inteligente</p>
          <p className="text-[10px] leading-snug text-muted-foreground">{hint}</p>
        </div>
        <Switch checked={on} onCheckedChange={(v) => onMaster({ smartMix: v })} aria-label="Mix inteligente" />
      </div>
      {on && (
        <div className="mt-3">
          <ParamRow
            label="Ambiência"
            value={master.ambience ?? 0.5}
            display={`${Math.round((master.ambience ?? 0.5) * 100)}%`}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => onMaster({ ambience: v })}
          />
        </div>
      )}
    </div>
  );
}

export default function MasterPanel({
  master,
  mixPlan,
  getAnalyser,
  onMaster,
  onAuto,
  reference,
  referenceBusy,
  onReference,
  onReferenceAmount,
  onClearReference,
}) {
  const pct = (v) => `${Math.round(v * 100)}%`;
  const refTarget = reference ? Math.max(-16, Math.min(-7, Math.round(reference.lufs * 2) / 2)) : null;
  const targets = reference && !TARGETS.some((t) => t.value === refTarget)
    ? [...TARGETS, { value: refTarget, label: 'Referência' }]
    : TARGETS;

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

      <ReferenceBlock
        reference={reference}
        busy={referenceBusy}
        onReference={onReference}
        onAmount={onReferenceAmount}
        onClear={onClearReference}
      />

      <SmartMixBlock master={master} mixPlan={mixPlan} onMaster={onMaster} />

      <MasterMeter getAnalyser={getAnalyser} />

      <div className="mt-4 flex flex-wrap gap-1.5">
        {[...(master.smartMix !== false ? smartChain(mixPlan) : []), ...CHAIN].map((step) => (
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
        <div className={`grid gap-1.5 ${targets.length > 4 ? 'grid-cols-5' : 'grid-cols-4'}`}>
          {targets.map((t) => (
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