import React from 'react';
import { AlertTriangle, Check, Loader2, Wand2 } from 'lucide-react';
import { Bar, BarChart, Cell, LabelList, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { streamingCheck } from '@/lib/audio/analysis';

function StatusRow({ ok, label, detail }) {
  return (
    <div className="flex items-start gap-2 py-[5px]">
      <span
        className={`mt-[2px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
          ok ? 'bg-meter-low/15 text-meter-low' : 'bg-meter-warn/15 text-meter-warn'
        }`}
      >
        {ok ? <Check className="h-2.5 w-2.5" /> : <AlertTriangle className="h-2.5 w-2.5" />}
      </span>
      <p className="text-[11px] leading-snug">
        <span className="text-foreground">{label}</span>
        <span className="ml-1 text-muted-foreground">{detail}</span>
      </p>
    </div>
  );
}

function MetricRow({ label, before, after, suffix = '' }) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-hairline/70 py-2 last:border-0">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="num text-[11px] text-muted-foreground">{before}{suffix}</span>
      <span className="num text-[11px] text-primary">{after}{suffix}</span>
    </div>
  );
}

// What the repair stage did on load, summed over all stems.
function RepairSummary({ repairs }) {
  if (!repairs?.length) return null;
  const sum = (k) => repairs.reduce((a, r) => a + (r[k] || 0), 0);
  const holes = sum('dropouts') + sum('gaps');
  const clicks = sum('clicks');
  const left = sum('unrepaired');
  const cutoffs = repairs.map((r) => r.cutoffHz).filter(Boolean);
  const rings = repairs.reduce((a, r) => a + (r.resonances?.length || 0), 0);
  const kHz = (hz) => (hz / 1000).toFixed(1).replace('.', ',');

  return (
    <div className="mt-3">
      <p className="mb-1 text-[9px] uppercase tracking-[0.16em] text-muted-foreground">Restauração</p>
      <StatusRow
        ok={left === 0}
        label={`${clicks} ${clicks === 1 ? 'estalo' : 'estalos'} e ${holes} ${holes === 1 ? 'buraco' : 'buracos'}`}
        detail={left === 0 ? (clicks + holes ? 'corrigidos' : 'nenhuma falha encontrada') : `corrigidos, ${left} longos demais para preencher`}
      />
      <StatusRow
        ok
        label={rings ? `${rings} ${rings === 1 ? 'ressonância metálica' : 'ressonâncias metálicas'}` : 'Sem ressonância metálica fixa'}
        detail={rings ? 'atenuadas' : ''}
      />
      <StatusRow
        ok
        label={cutoffs.length ? `Agudos restaurados acima de ${kHz(Math.min(...cutoffs))} kHz` : 'Agudos completos'}
        detail={cutoffs.length ? `em ${cutoffs.length} ${cutoffs.length === 1 ? 'stem' : 'stems'}` : 'nenhum corte detectado'}
      />
    </div>
  );
}

export default function ReportPanel({ baseline, after, target, ceiling, repairs, rendering, onRender }) {
  if (!baseline) return null;

  const current = after || baseline;
  const check = streamingCheck(current.lufs, current.peakDb, target, ceiling);
  const scope = after ? 'Master do Forja' : 'Arquivo original';

  const data = [
    { name: 'Original', value: Math.abs(baseline.lufs), label: baseline.lufs.toFixed(1), fill: '#475569' },
  ];
  if (after) {
    data.push({ name: 'Forja', value: Math.abs(after.lufs), label: after.lufs.toFixed(1), fill: '#f59e0b' });
  }

  return (
    <section className="rounded-3xl border border-hairline bg-panel/70 p-5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="font-heading text-[13px] font-semibold uppercase tracking-[0.18em]">Comparativo</h2>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-[11px]"
          onClick={onRender}
          disabled={!!rendering}
        >
          {rendering ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
          {rendering ? 'Renderizando…' : 'Comparar volume'}
        </Button>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        Volume integrado medido (LUFS). A linha tracejada é o alvo de {target} LUFS.
      </p>

      <ResponsiveContainer width="100%" height={168}>
        <BarChart data={data} margin={{ top: 18, right: 6, bottom: 0, left: -20 }}>
          <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
          <YAxis
            domain={[0, 20]}
            ticks={[0, 5, 10, 15, 20]}
            tick={{ fontSize: 10, fill: '#94a3b8' }}
            axisLine={false}
            tickLine={false}
          />
          <ReferenceLine y={Math.abs(target)} stroke="#f59e0b" strokeDasharray="4 4" strokeOpacity={0.7} />
          <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={58} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.name} fill={d.fill} />
            ))}
            <LabelList dataKey="label" position="top" fill="#e5e7eb" fontSize={11} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      <div className="mt-3">
        <p className="mb-1 text-[9px] uppercase tracking-[0.16em] text-muted-foreground">{scope}</p>
        <StatusRow
          ok={check.lufsOk}
          label={`${current.lufs.toFixed(1)} LUFS`}
          detail={
            check.lufsOk
              ? `na medida do padrão de ${target} LUFS`
              : `fora do padrão — ${check.delta > 0 ? 'faltam' : 'sobram'} ${Math.abs(check.delta).toFixed(1)} dB`
          }
        />
        <StatusRow
          ok={check.peakOk}
          label={`${current.peakDb.toFixed(1)} dBTP de pico`}
          detail={check.peakOk ? `dentro do teto de ${ceiling} dBTP` : `acima do teto de ${ceiling} dBTP`}
        />
      </div>

      <RepairSummary repairs={repairs} />

      <div className="mt-3">
        <div className="mb-1 grid grid-cols-[1fr_auto_auto] gap-3 text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
          <span />
          <span>original</span>
          <span className="text-primary">forja</span>
        </div>
        <MetricRow label="Volume alvo" before={baseline.lufs.toFixed(1)} after={after ? after.lufs.toFixed(1) : '—'} suffix=" LUFS" />
        <MetricRow label="Pico real" before={baseline.peakDb.toFixed(1)} after={after ? after.peakDb.toFixed(1) : '—'} suffix=" dBTP" />
        <MetricRow
          label="Aspereza metálica"
          before={Math.round(baseline.harshness * 100)}
          after={after ? Math.round(after.harshness * 100) : '—'}
          suffix="%"
        />
        <MetricRow
          label="Faixa dinâmica"
          before={baseline.crest ? baseline.crest.toFixed(1) : '—'}
          after={after && after.crest ? after.crest.toFixed(1) : '—'}
          suffix=" dB"
        />
        {after && after.limiterGrDb != null && (
          <div className="flex items-center justify-between border-b border-hairline/70 py-2 last:border-0">
            <span className="text-[11px] text-muted-foreground">Trabalho do limitador</span>
            <span className="num text-[11px] text-primary">-{after.limiterGrDb.toFixed(1)} dB</span>
          </div>
        )}
      </div>
    </section>
  );
}