import React, { useRef, useState } from 'react';
import { Loader2, Music, Sliders, Upload, Waves, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const CHIPS = [
  { icon: Zap, title: 'De-metálico automático', text: 'Corta a aspereza que o gerador deixa na faixa de 2 a 6 kHz.' },
  { icon: Sliders, title: 'Mixagem automática', text: 'Equilibra o volume e o posicionamento de cada stem.' },
  { icon: Music, title: 'Master para release', text: 'Limitador e volume alvo de streaming, pronto para subir.' },
];

export default function StemDropzone({ onFiles, busy, error }) {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);

  return (
    <div className="mx-auto flex min-h-[74vh] w-full max-w-3xl flex-col items-center justify-center px-5 py-10">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onFiles(e.dataTransfer.files);
        }}
        className={cn(
          'w-full rounded-[28px] border border-dashed px-8 py-12 text-center transition-colors',
          over ? 'border-primary/70 bg-primary/[0.06]' : 'border-white/12 bg-white/[0.02]',
        )}
      >
        <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/25 bg-primary/10 text-primary">
          <Waves className="h-6 w-6" />
        </div>

        <h1 className="font-heading text-[28px] font-semibold leading-tight tracking-tight sm:text-[36px]">
          Solte seus stems aqui
        </h1>
        <p className="mx-auto mt-3 max-w-lg text-[13px] leading-relaxed text-muted-foreground sm:text-sm">
          Exporte os stems separados no Suno e traga todos de uma vez. O Forja limpa os artefatos metálicos,
          equilibra a mixagem e entrega um master pronto para lançamento.
        </p>

        <Button className="mt-7 h-11 gap-2 px-6 text-[13px]" onClick={() => inputRef.current?.click()} disabled={!!busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {busy ? 'Processando…' : 'Escolher arquivos'}
        </Button>

        <p className="num mt-4 text-[11px] text-muted-foreground">WAV · MP3 · FLAC · M4A — até 12 stems</p>

        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          multiple
          className="hidden"
          onChange={(e) => {
            onFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {busy && (
        <p className="mt-5 text-[12px] text-muted-foreground">
          {busy.phase === 'decode' && 'Decodificando'}
          {busy.phase === 'clean' && 'Limpando artefatos de'}
          {busy.phase === 'repair' && 'Reparando falhas e som metálico de'}
          {busy.phase === 'analyze' && 'Analisando'}
          {busy.phase === 'separate' && 'Separando em voz, bateria, baixo e outros (IA)'}
          <span className="text-foreground"> {busy.name}</span>
          {busy.phase === 'separate' ? (
            <span className="num ml-2">{Math.round((busy.progress || 0) * 100)}%</span>
          ) : (
            <span className="num ml-2">{busy.index}/{busy.total}</span>
          )}
        </p>
      )}
      {error && <p className="mt-4 text-[12px] text-destructive">{error}</p>}

      <div className="mt-10 grid w-full gap-3 sm:grid-cols-3">
        {CHIPS.map(({ icon: Icon, title, text }) => (
          <div key={title} className="rounded-2xl border border-hairline bg-panel/60 p-4 text-left">
            <Icon className="mb-2.5 h-4 w-4 text-primary" />
            <p className="text-[12px] font-medium">{title}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{text}</p>
          </div>
        ))}
      </div>

      <p className="mt-8 text-center text-[11px] leading-relaxed text-muted-foreground">
        Todo o processamento acontece no seu navegador. Os arquivos não são enviados para nenhum servidor.
      </p>
    </div>
  );
}