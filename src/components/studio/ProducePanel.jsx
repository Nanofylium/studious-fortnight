import React, { useState } from 'react';
import { Download, Loader2, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { encodeWav } from '@/lib/audio/dsp';
import { asBuffer } from '@/lib/audio/produce/filters';
import { encodeWav16Dither } from '@/lib/audio/produce/mixdown';
import { PRODUCE_DEFAULTS } from '@/lib/audio/produce/pipeline';
import { produceStems } from '@/lib/audio/produce/client';

const STAGES = {
  voz: 'Tratando a voz',
  instrumental: 'Tratando o instrumental',
  mix: 'Mixando',
  master: 'Masterizando',
};

function Row({ label, display, value, min, max, step, onChange }) {
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

function Toggle({ label, hint, checked, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[12px] font-medium">{label}</p>
        <p className="text-[10px] leading-snug text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

function download(data, name) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: 'audio/wav' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// "Produção completa": the chain that made the Spotify masters (voice and
// instrumental treatment, analog bus, -14 LUFS), run on the
// session's stems and delivered as two files ready for the distributor.
export default function ProducePanel({ stems, mixParams, sessionName }) {
  const [opts, setOpts] = useState(PRODUCE_DEFAULTS);
  const [stage, setStage] = useState(null);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const set = (patch) => setOpts((o) => ({ ...o, ...patch }));

  const active = stems.filter((s) => !mixParams[s.id]?.muted);
  const hasVocal = active.some((s) => s.role?.key === 'vocals');

  const run = async () => {
    if (!active.length) return;
    setError(null);
    setReport(null);
    setStage('voz');
    try {
      const { channels, report: r } = await produceStems(active, {
        options: opts,
        onStage: setStage,
      });
      const sr = active[0].buffer.sampleRate;
      const khz = `${Math.round(sr / 100) / 10}k`.replace('.', ',');
      download(encodeWav(asBuffer(channels, sr), 24), `${sessionName} - master Spotify ${khz} 24bit.wav`);
      download(encodeWav16Dither(channels, sr), `${sessionName} - master Spotify ${khz} 16bit.wav`);
      setReport(r);
    } catch (e) {
      setError(`A produção falhou. ${e?.message || ''}`.trim());
    } finally {
      setStage(null);
    }
  };

  const busy = !!stage;

  return (
    <section className="rounded-3xl border border-hairline bg-panel/70 p-5">
      <div className="mb-1 flex items-center gap-2">
        <Wand2 className="h-4 w-4 text-primary" />
        <h2 className="font-heading text-[13px] font-semibold uppercase tracking-[0.18em]">Produção completa</h2>
      </div>
      <p className="mb-4 text-[10px] leading-snug text-muted-foreground">
        A cadeia dos masters do Spotify: voz sem metálico, com corpo e clareza; instrumental mais quente; mix e master em
        -14 LUFS. Ignora os faders (só respeita o mudo).
      </p>

      <div className="space-y-4">
        {hasVocal ? (
          <>
            <Row
              label="Corpo da voz"
              value={opts.body}
              display={opts.body === 0 ? 'desligado' : opts.body >= 2.5 ? 'máximo' : `${opts.body.toFixed(1)}×`}
              min={0}
              max={2.5}
              step={0.1}
              onChange={(v) => set({ body: v })}
            />
            <Toggle
              label="Voz quente"
              hint="Mais peso em 200 Hz, menos aspereza em 4,5 kHz."
              checked={opts.warm > 0}
              onChange={(v) => set({ warm: v ? 1 : 0 })}
            />
            <Toggle
              label="Clareza"
              hint="Presença em 3 kHz e brilho acima de 10 kHz."
              checked={opts.clarity}
              onChange={(v) => set({ clarity: v })}
            />
          </>
        ) : (
          <p className="text-[10px] leading-snug text-muted-foreground">
            Nenhum stem de voz: a cadeia trata e masteriza só o instrumental.
          </p>
        )}

        <Toggle
          label="Analógico"
          hint="Fita no bus com o ToTape6 do Airwindows: flutter, grave encorpado, agudos suaves e saturação."
          checked={opts.analog}
          onChange={(v) => set({ analog: v })}
        />
        <Toggle
          label="Clipper"
          hint="ClipOnly2 do Airwindows antes do limitador: corta só os picos mais altos, o limitador bombeia menos."
          checked={opts.clip}
          onChange={(v) => set({ clip: v })}
        />

        <Button className="h-9 w-full gap-2 text-[12px]" disabled={busy || !active.length} onClick={run}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {busy ? `${STAGES[stage] || 'Processando'}…` : 'Produzir master Spotify'}
        </Button>

        {error && <p className="text-[11px] text-destructive">{error}</p>}
        {report && (
          <div className="rounded-2xl border border-hairline px-3 py-2.5 text-[11px] leading-relaxed">
            <p>
              Master: <span className="num">{report.lufs?.toFixed(1)} LUFS</span> ·{' '}
              <span className="num">{report.truePeakDb?.toFixed(1)} dBTP</span> ·{' '}
              <span className="num">LRA {report.lra?.toFixed(1)} LU</span>
            </p>
            <p className="text-muted-foreground">Medido no padrão EBU R128 (libebur128).</p>
            {report.vocal && (
              <p className="text-muted-foreground">
                Metálico na voz: <span className="num">{report.vocal.metallicBefore}</span> →{' '}
                <span className="num">{report.vocal.metallicAfter}</span>
              </p>
            )}
            {report.instrumental && (
              <p className="text-muted-foreground">
                Metálico no instrumental: <span className="num">{report.instrumental.metallicBefore}</span> →{' '}
                <span className="num">{report.instrumental.metallicAfter}</span>
              </p>
            )}
            <p className="text-muted-foreground">Dois arquivos baixados: 24 bits e 16 bits com dither.</p>
          </div>
        )}
      </div>
    </section>
  );
}
