import React, { useEffect, useState } from 'react';
import { Clapperboard, Download, Loader2, Lock, Shuffle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { compileBloopers, makeBloopers } from '@/lib/audio/bloopers/generate';
import { encodeWav16Dither } from '@/lib/audio/produce/mixdown';

const channelsOf = (buffer) => Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));

// Stems summed to one stereo pair, as long as the longest.
function sum(list) {
  if (!list.length) return null;
  const n = Math.max(...list.map((s) => s.buffer.length));
  const out = [new Float32Array(n), new Float32Array(n)];
  for (const s of list) {
    const ch = channelsOf(s.buffer);
    for (let c = 0; c < 2; c++) {
      const src = ch[c % ch.length];
      for (let i = 0; i < src.length; i++) out[c][i] += src[i];
    }
  }
  return out;
}

const wavUrl = (channels, sr) => URL.createObjectURL(new Blob([encodeWav16Dither(channels, sr)], { type: 'audio/wav' }));

function save(url, name) {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// Hidden "Bastidores" room: recording-mistake clips made from the session's
// own song, for behind-the-scenes posts. Only mounted after the passphrase.
export default function BloopersPanel({ stems, mixParams, sessionName, onLock }) {
  const [count, setCount] = useState(5);
  const [seed, setSeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // Blob URLs are released when a new batch replaces them or the panel goes.
  useEffect(() => () => result && [result.reel, ...result.clips.map((c) => c.url)].forEach(URL.revokeObjectURL), [result]);

  const active = stems.filter((s) => !mixParams[s.id]?.muted);
  const vocals = active.filter((s) => s.role?.key === 'vocals');

  const run = (nextSeed) => {
    if (!active.length) return;
    setBusy(true);
    setError(null);
    setSeed(nextSeed);
    // Let the spinner paint before the work blocks the page for a second or two.
    setTimeout(() => {
      try {
        const sr = active[0].buffer.sampleRate;
        const job = vocals.length
          ? { vocal: sum(vocals), backing: sum(active.filter((s) => s.role?.key !== 'vocals')), sampleRate: sr }
          : { mix: sum(active), sampleRate: sr };
        const { bpm, bloopers } = makeBloopers(job, { count, seed: nextSeed });
        if (!bloopers.length) throw new Error('a música é curta demais ou não tem frases claras');
        setResult({
          bpm,
          clips: bloopers.map((b) => ({ ...b, url: wavUrl(b.channels, sr), seconds: b.channels[0].length / sr, channels: null })),
          reel: wavUrl(compileBloopers(bloopers, sr), sr),
        });
      } catch (e) {
        setError(`Não deu para gerar. ${e?.message || ''}`.trim());
      } finally {
        setBusy(false);
      }
    }, 30);
  };

  const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

  return (
    <section className="rounded-3xl border border-primary/30 bg-panel/70 p-5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Clapperboard className="h-4 w-4 text-primary" />
          <h2 className="font-heading text-[13px] font-semibold uppercase tracking-[0.18em]">Bloopers</h2>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onLock} aria-label="Trancar e esconder">
          <Lock className="h-3.5 w-3.5" />
        </Button>
      </div>
      <p className="mb-4 text-[10px] leading-snug text-muted-foreground">
        Erros de gravação feitos a partir desta música: entrada antes da hora, desafinada, voz falhando, microfonia,
        tempo atravessado, microfone batido, fita enrolando.
        {vocals.length ? '' : ' Sem stem de voz, alguns tipos ficam de fora.'}
      </p>

      <div className="space-y-4">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Quantos</span>
            <span className="num text-[11px]">{count}</span>
          </div>
          <Slider value={[count]} min={2} max={8} step={1} onValueChange={([v]) => setCount(v)} />
        </div>

        <div className="flex gap-2">
          <Button className="h-9 flex-1 gap-2 text-[12px]" disabled={busy || !active.length} onClick={() => run(seed)}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4" />}
            {busy ? 'Gravando os erros…' : 'Gerar bloopers'}
          </Button>
          <Button
            variant="outline"
            className="h-9 gap-1.5 text-[11px]"
            disabled={busy || !active.length}
            onClick={() => run(seed + 1)}
            title="Outros trechos e outros erros"
          >
            <Shuffle className="h-3.5 w-3.5" /> Outra leva
          </Button>
        </div>

        {error && <p className="text-[11px] text-destructive">{error}</p>}

        {result && (
          <div className="space-y-3">
            {result.clips.map((c) => (
              <div key={c.url} className="rounded-2xl border border-hairline px-3 py-2.5">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-[12px] font-medium">
                    Take {c.take} · {c.title}
                  </p>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={() => save(c.url, `${sessionName} - blooper ${c.take} ${c.kind}.wav`)}
                    aria-label={`Baixar take ${c.take}`}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <p className="num mb-1.5 text-[10px] text-muted-foreground">
                  aos {fmt(c.start)} da música · {c.seconds.toFixed(1)} s
                </p>
                <audio controls preload="none" src={c.url} className="h-8 w-full" />
              </div>
            ))}
            <Button
              variant="outline"
              className="h-9 w-full gap-2 text-[11px]"
              onClick={() => save(result.reel, `${sessionName} - bloopers compilado.wav`)}
            >
              <Download className="h-3.5 w-3.5" /> Baixar compilado (todos em sequência)
            </Button>
            <p className="num text-[10px] text-muted-foreground">
              Andamento detectado: {Math.round(result.bpm)} BPM · WAV 16 bits, -16 LUFS.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
