import React, { useEffect, useRef, useState } from 'react';
import { Check, FolderOpen, Loader2, Mic2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { convertBuffer, releaseWorker } from '@/lib/audio/rvc/client';
import { KINDS, clearModelFiles, kindOf, listModelFiles, saveModelFile } from '@/lib/audio/rvc/store';

const LABELS = { voice: 'Modelo da sua voz', hubert: 'HuBERT (base)', rmvpe: 'RMVPE (base)' };
const mb = (n) => `${Math.round(n / 1e6)} MB`;

// "Minha voz (RVC)": turns the session's vocal into the owner's own voice
// with an RVC model trained only on his recordings (RVC-Project, MIT). The
// model files are picked once and kept in this computer; the converted vocal
// joins the session as a new stem and the original is muted, so it can be
// compared and undone.
export default function MyVoicePanel({ stems, onAddStem }) {
  const [files, setFiles] = useState({});
  const [target, setTarget] = useState(null);
  const [semitones, setSemitones] = useState(0);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const input = useRef(null);

  const vocals = stems.filter((s) => s.role?.key === 'vocals');
  const ready = KINDS.every((k) => files[k]);
  const key = KINDS.map((k) => `${files[k]?.name}:${files[k]?.size}`).join('|');
  const chosen = stems.find((s) => s.id === target) || vocals[0] || null;

  useEffect(() => {
    listModelFiles().then(setFiles, () => setFiles({}));
    return () => releaseWorker();
  }, []);

  const pick = async (list) => {
    setError(null);
    try {
      const found = [...list].map((f) => [kindOf(f.name), f]).filter(([k]) => k);
      if (!found.length) throw new Error('escolha arquivos .onnx');
      for (const [k, f] of found) {
        setStatus(`Guardando ${f.name}…`);
        await saveModelFile(k, f);
      }
      setFiles(await listModelFiles());
    } catch (e) {
      setError(`Não deu para guardar os modelos. ${e?.message || ''}`.trim());
    } finally {
      setStatus(null);
    }
  };

  const forget = async () => {
    releaseWorker();
    await clearModelFiles().catch(() => {});
    setFiles({});
  };

  const run = async () => {
    if (!chosen) return;
    setError(null);
    setDone(null);
    setStatus('Carregando os modelos…');
    try {
      const { audio, voicedPct } = await convertBuffer(chosen.buffer, {
        semitones,
        key,
        onProgress: (m) =>
          setStatus(m.stage === 'load' ? 'Carregando os modelos…' : `Convertendo… ${Math.round((m.progress || 0) * 100)}%`),
      });
      onAddStem({
        channels: [audio, audio.slice()],
        sampleRate: chosen.buffer.sampleRate,
        name: `Minha voz (${chosen.name})`,
        role: chosen.role,
        mute: chosen.id,
      });
      setDone({ name: chosen.name, voiced: voicedPct });
    } catch (e) {
      setError(`Não deu para converter. ${e?.message || ''}`.trim());
    } finally {
      setStatus(null);
    }
  };

  const busy = Boolean(status);

  return (
    <section className="rounded-3xl border border-primary/30 bg-panel/70 p-5">
      <div className="mb-1 flex items-center gap-2">
        <Mic2 className="h-4 w-4 text-primary" />
        <h2 className="font-heading text-[13px] font-semibold uppercase tracking-[0.18em]">Minha voz (RVC)</h2>
      </div>
      <p className="mb-4 text-[10px] leading-snug text-muted-foreground">
        Troca a voz do vocal pela sua, com o modelo treinado só com as suas gravações. Letra, melodia e interpretação
        ficam; o timbre passa a ser o seu. Roda neste computador e o modelo não sai daqui.
      </p>

      <div className="space-y-4">
        <div className="space-y-1.5">
          {KINDS.map((k) => (
            <div key={k} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-muted-foreground">{LABELS[k]}</span>
              <span className="min-w-0 truncate num">
                {files[k] ? (
                  <>
                    <Check className="mr-1 inline h-3 w-3 text-primary" />
                    {files[k].name} · {mb(files[k].size)}
                  </>
                ) : (
                  'falta'
                )}
              </span>
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              className="h-8 flex-1 gap-1.5 text-[11px]"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              <FolderOpen className="h-3.5 w-3.5" /> Escolher arquivos .onnx
            </Button>
            {Object.keys(files).length > 0 && (
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={busy} onClick={forget} aria-label="Esquecer os modelos">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          <input
            ref={input}
            type="file"
            accept=".onnx"
            multiple
            hidden
            onChange={(e) => {
              pick(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        {vocals.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {vocals.map((s) => (
              <Button
                key={s.id}
                variant={chosen?.id === s.id ? 'default' : 'outline'}
                className="h-7 px-2.5 text-[10px]"
                onClick={() => setTarget(s.id)}
              >
                {s.name}
              </Button>
            ))}
          </div>
        )}

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Tom</span>
            <span className="num text-[11px]">{semitones > 0 ? `+${semitones}` : semitones} semitons</span>
          </div>
          <Slider value={[semitones]} min={-12} max={12} step={1} onValueChange={([v]) => setSemitones(v)} />
          <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
            Use −12 se a Suno cantou com voz feminina e você canta uma oitava abaixo.
          </p>
        </div>

        <Button className="h-9 w-full gap-2 text-[12px]" disabled={busy || !ready || !chosen} onClick={run}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic2 className="h-4 w-4" />}
          {status || (chosen ? `Converter "${chosen.name}"` : 'Sem stem de voz na sessão')}
        </Button>

        {!ready && (
          <p className="text-[10px] leading-snug text-muted-foreground">
            Escolha os três arquivos .onnx (o da sua voz, o hubert e o rmvpe) de uma vez. Ficam guardados aqui.
          </p>
        )}
        {error && <p className="text-[11px] text-destructive">{error}</p>}
        {done && (
          <p className="text-[11px] text-muted-foreground">
            Pronto: "Minha voz" entrou na sessão e "{done.name}" ficou mudo para comparar.
            {done.voiced < 0.2 ? ' Pouca voz cantada foi encontrada; confira se escolheu o stem certo.' : ''}
          </p>
        )}
      </div>
    </section>
  );
}
