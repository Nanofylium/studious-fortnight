import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Circle, Download, Headphones, Loader2, Mic, Play, Sliders, Square, Timer, Trash2, Upload, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import Waveform from '@/components/studio/Waveform';
import { computePeaks, denoiseChannels, encodeWav } from '@/lib/audio/dsp';
import { roleByKey } from '@/lib/audio/analysis';
import { loadStemFiles, stemFromChannels } from '@/lib/audio/loader';
import { separateBuffer } from '@/lib/audio/separate/client';
import { MAX_OFFSET_MS, alignTake, resampleLinear } from '@/lib/audio/sing/align';
import { SingRecorder } from '@/lib/audio/sing/recorder';

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function Step({ n, title, done, children, hint }) {
  return (
    <section className="rounded-2xl border border-hairline bg-panel/60 p-5">
      <div className="mb-4 flex items-start gap-3">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${
            done ? 'bg-primary text-primary-foreground' : 'border border-white/15 text-muted-foreground'
          }`}
        >
          {done ? <Check className="h-3.5 w-3.5" /> : n}
        </span>
        <div className="min-w-0">
          <h2 className="font-heading text-[13px] font-semibold uppercase tracking-[0.18em]">{title}</h2>
          {hint && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Row({ label, display, value, min, max, step, onChange, disabled }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</span>
        <span className="num text-[11px]">{display}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} disabled={disabled} />
    </div>
  );
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// The chosen take on the instrumental's timeline, at the session rate, as a
// mono channel the length of the instrumental.
function voiceChannel(take, offsetMs, instrumental) {
  const devLength = Math.round(instrumental.buffer.duration * take.sampleRate);
  const placed = alignTake(take.raw, (offsetMs / 1000) * take.sampleRate, devLength);
  const atSession = resampleLinear(placed, take.sampleRate, instrumental.sampleRate);
  const out = new Float32Array(instrumental.buffer.length);
  out.set(atSession.subarray(0, out.length));
  return out;
}

// The two stems of the song: the instrumental as loaded and the voice,
// cleaned of the low-level room/mic hiss the same way loaded stems are.
export function songStems(sing) {
  const { instrumental, takes, chosen, offsetMs } = sing;
  const take = takes.find((t) => t.id === chosen);
  if (!instrumental || !take) return null;
  const voice = voiceChannel(take, offsetMs, instrumental);
  denoiseChannels([voice], instrumental.sampleRate);
  const voz = stemFromChannels([voice], instrumental.sampleRate, 'Minha voz', { index: 1 });
  return [instrumental, voz];
}

// "Cantar": load an instrumental, sing over it with headphones, get the
// finished song. The take is captured on the same clock that plays the
// instrumental and shifted back by the measured (or estimated) round trip.
export default function SingView({ sing, setSing, onRender, onOpenMix }) {
  const { instrumental, takes, chosen, offsetMs, voiceDb, backingGain } = sing;
  const patch = useCallback((p) => setSing((s) => ({ ...s, ...p })), [setSing]);

  const recRef = useRef(null);
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [mic, setMic] = useState({ open: false, devices: [], deviceId: '' });
  const [recording, setRecording] = useState(null); // { since }
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [previewing, setPreviewing] = useState(null);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationNote, setCalibrationNote] = useState(null);
  const [rendering, setRendering] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => () => recRef.current?.dispose(), []);

  // Mic meter and take clock.
  useEffect(() => {
    if (!mic.open) return undefined;
    let raf = 0;
    let frame = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (++frame % 3) return;
      setLevel(recRef.current?.level() ?? 0);
      if (recording) setElapsed((performance.now() - recording.since) / 1000);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mic.open, recording]);

  const peaks = useMemo(() => (instrumental ? computePeaks(instrumental.buffer, 300) : null), [instrumental]);

  const loadInstrumental = async (file) => {
    if (!file) return;
    setError(null);
    setResult(null);
    try {
      const decodeCtx = new OfflineAudioContext(2, 1, 44100);
      const [stem] = await loadStemFiles([file], decodeCtx, (p) => setBusy({ ...p }));
      patch({ instrumental: { ...stem, role: roleByKey('instrumental') }, takes: [], chosen: null });
    } catch (e) {
      setError(`Não deu para abrir o instrumental. ${e?.message || ''}`.trim());
    } finally {
      setBusy(null);
    }
  };

  // The file still has the AI's voice: the separation model takes it out and
  // the instrumental becomes drums + bass + other.
  const removeVoice = async () => {
    setError(null);
    setBusy({ phase: 'separate', progress: 0 });
    try {
      const parts = await separateBuffer(instrumental.buffer, {
        onProgress: (progress) => setBusy({ phase: 'separate', progress }),
      });
      const rest = parts.filter((p) => p.key !== 'vocals');
      const channels = rest[0].channels.map((_, c) => {
        const out = new Float32Array(rest[0].channels[c].length);
        for (const p of rest) {
          const d = p.channels[c];
          for (let i = 0; i < out.length; i++) out[i] += d[i];
        }
        return out;
      });
      const stem = stemFromChannels(channels, instrumental.sampleRate, instrumental.name, { repair: instrumental.repair });
      patch({ instrumental: { ...stem, role: roleByKey('instrumental') } });
    } catch (e) {
      setError(`Não deu para tirar a voz nesta máquina. ${e?.message || ''}`.trim());
    } finally {
      setBusy(null);
    }
  };

  const openMic = async (deviceId) => {
    setError(null);
    try {
      if (!recRef.current) recRef.current = new SingRecorder();
      const id = await recRef.current.open(deviceId);
      const devices = await recRef.current.devices();
      setMic({ open: true, devices, deviceId: id });
      // First time: start from what the browser reports.
      setSing((s) => (s.offsetMs == null ? { ...s, offsetMs: Math.round(recRef.current.estimatedLatency() * 1000) } : s));
      return true;
    } catch (e) {
      setError(
        e?.name === 'NotAllowedError'
          ? 'O microfone foi bloqueado. Libere o acesso ao microfone no navegador e tente de novo.'
          : `Não deu para abrir o microfone. ${e?.message || ''}`.trim(),
      );
      return false;
    }
  };

  const finishTake = useCallback(async () => {
    const rec = recRef.current;
    if (!rec) return;
    setRecording(null);
    const { raw, sampleRate } = await rec.stopTake();
    if (raw.length < sampleRate * 0.5) return;
    const take = { id: `t${Date.now().toString(36)}`, raw, sampleRate, seconds: raw.length / sampleRate };
    setSing((s) => {
      const n = s.takes.length ? Math.max(...s.takes.map((t) => t.n)) + 1 : 1;
      return { ...s, takes: [...s.takes, { ...take, n }], chosen: take.id };
    });
    setResult(null);
  }, [setSing]);

  const startTake = async () => {
    if (!instrumental || recording) return;
    if (!mic.open && !(await openMic())) return;
    stopPreview();
    recRef.current.startTake(instrumental.buffer, { gain: backingGain, onEnded: finishTake });
    setElapsed(0);
    setRecording({ since: performance.now() + 150 });
  };

  const stopPreview = () => {
    recRef.current?.stopPlayback();
    setPreviewing(null);
  };

  // Voice and instrumental together, with the current sync and balance.
  const preview = async (take) => {
    if (previewing === take.id) return stopPreview();
    if (!mic.open && !(await openMic())) return;
    const rec = recRef.current;
    const sr = take.sampleRate;
    const placed = alignTake(take.raw, ((offsetMs ?? 0) / 1000) * sr, Math.round(instrumental.buffer.duration * sr));
    const voice = new AudioBuffer({ numberOfChannels: 1, length: Math.max(1, placed.length), sampleRate: sr });
    voice.copyToChannel(placed, 0);
    rec.play(
      [
        { buffer: instrumental.buffer, gain: 0.8 },
        { buffer: voice, gain: 10 ** (voiceDb / 20) * 1.2 },
      ],
      { onEnded: () => setPreviewing(null) },
    );
    setPreviewing(take.id);
  };

  const calibrate = async () => {
    if (!mic.open && !(await openMic())) return;
    stopPreview();
    setCalibrating(true);
    setCalibrationNote(null);
    try {
      const r = await recRef.current.calibrate();
      if (r) {
        patch({ offsetMs: Math.round(r.seconds * 1000) });
        setCalibrationNote(`Medido: ${Math.round(r.seconds * 1000)} ms.`);
      } else {
        setCalibrationNote('Não ouvi os cliques. Tire o fone, aumente o volume e tente de novo.');
      }
    } catch (e) {
      setCalibrationNote(`Falhou: ${e?.message || e}`);
    } finally {
      setCalibrating(false);
    }
  };

  const render = async () => {
    const list = songStems(sing);
    if (!list) return;
    stopPreview();
    setRendering(true);
    setError(null);
    try {
      const r = await onRender(list, voiceDb);
      setResult(r);
    } catch (e) {
      setError(`Não deu para gerar a música. ${e?.message || ''}`.trim());
    } finally {
      setRendering(false);
    }
  };

  const songName = (instrumental?.name || 'minha-musica').replace(/\b(instrumental|playback)\b/gi, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'minha-musica';
  const offset = offsetMs ?? 0;
  const chosenTake = takes.find((t) => t.id === chosen);
  const levelDb = 20 * Math.log10(Math.max(level, 1e-5));

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4 pb-10">
      <div className="text-center">
        <h1 className="font-heading text-[26px] font-semibold leading-tight tracking-tight sm:text-[32px]">Cante a sua música</h1>
        <p className="mx-auto mt-2 max-w-lg text-[13px] leading-relaxed text-muted-foreground">
          Traga o instrumental, cante por cima com fone de ouvido e o Forja junta a sua voz com a base, mixa e masteriza.
        </p>
      </div>

      <Step
        n={1}
        title="Instrumental"
        done={!!instrumental}
        hint={instrumental ? null : 'A base sem voz (o stem instrumental da Suno, um playback, um beat).'}
      >
        {instrumental ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 truncate text-[13px] font-medium">
                {instrumental.name} <span className="num ml-2 text-[11px] text-muted-foreground">{fmt(instrumental.duration)}</span>
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="h-8 gap-1.5 text-[11px]" onClick={removeVoice} disabled={!!busy || !!recording}>
                  <Wand2 className="h-3.5 w-3.5" /> Ainda tem voz? Tirar com IA
                </Button>
                <Button variant="ghost" size="sm" className="h-8 text-[11px]" onClick={() => fileRef.current?.click()} disabled={!!busy || !!recording}>
                  Trocar
                </Button>
              </div>
            </div>
            <Waveform peaks={peaks} height={44} progress={recording ? Math.min(1, elapsed / instrumental.duration) : 0} />
          </div>
        ) : (
          <Button className="h-11 gap-2 px-6 text-[13px]" onClick={() => fileRef.current?.click()} disabled={!!busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {busy ? 'Abrindo…' : 'Escolher o instrumental'}
          </Button>
        )}
        {busy && (
          <p className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {busy.phase === 'separate'
              ? `Tirando a voz com IA ${Math.round((busy.progress || 0) * 100)}%`
              : busy.phase === 'repair'
                ? 'Limpando falhas da base'
                : 'Abrindo a base'}
          </p>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => {
            loadInstrumental(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </Step>

      <Step
        n={2}
        title="Sua voz"
        done={!!chosenTake}
        hint="Coloque o fone de ouvido: o instrumental toca nele enquanto o microfone grava só a sua voz."
      >
        <div className="flex flex-col items-center gap-3 py-2">
          {recording ? (
            <Button
              className="h-16 gap-3 rounded-full bg-red-500 px-10 text-[15px] text-white hover:bg-red-500/90"
              onClick={finishTake}
            >
              <Square className="h-5 w-5 fill-white" /> Parar · <span className="num">{fmt(elapsed)}</span>
            </Button>
          ) : (
            <Button
              className="h-16 gap-3 rounded-full bg-red-500/90 px-10 text-[15px] text-white hover:bg-red-500"
              onClick={startTake}
              disabled={!instrumental || !!busy || calibrating || rendering}
            >
              <Circle className="h-5 w-5 fill-white" /> {takes.length ? 'Gravar de novo' : 'Gravar minha voz'}
            </Button>
          )}
          <div className="flex flex-wrap items-center justify-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Headphones className="h-3.5 w-3.5" /> Use fone para a base não vazar no microfone
            </span>
            {mic.open && (
              <span className="flex items-center gap-2">
                <Mic className="h-3.5 w-3.5" />
                <span className="relative h-1.5 w-28 overflow-hidden rounded-full bg-white/10">
                  <span
                    className={`absolute inset-y-0 left-0 ${levelDb > -3 ? 'bg-red-500' : 'bg-emerald-400'}`}
                    style={{ width: `${Math.max(0, Math.min(100, ((levelDb + 50) / 50) * 100))}%` }}
                  />
                </span>
                {levelDb > -3 && <span className="text-red-400">alto demais, afaste o microfone</span>}
              </span>
            )}
          </div>
          {mic.open && mic.devices.length > 1 && (
            <select
              className="h-8 max-w-[260px] rounded-lg border border-hairline bg-transparent px-2 text-[11px]"
              value={mic.deviceId}
              onChange={(e) => openMic(e.target.value)}
              disabled={!!recording}
              aria-label="Microfone"
            >
              {mic.devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Microfone'}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Row
            label="Volume da base no fone"
            display={`${Math.round(backingGain * 100)}%`}
            value={backingGain}
            min={0.1}
            max={1.5}
            step={0.05}
            onChange={(v) => patch({ backingGain: v })}
            disabled={!!recording}
          />
          <div>
            <Row
              label="Sincronia (atraso do fone + microfone)"
              display={`${offset} ms`}
              value={offset}
              min={0}
              max={MAX_OFFSET_MS}
              step={1}
              onChange={(v) => patch({ offsetMs: v })}
              disabled={!!recording}
            />
            <button
              type="button"
              onClick={calibrate}
              disabled={!!recording || calibrating}
              className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
              title="Tire o fone e deixe o som sair pela caixa: o Forja toca alguns cliques e mede quanto tempo eles levam para voltar pelo microfone."
            >
              {calibrating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Timer className="h-3.5 w-3.5" />}
              {calibrating ? 'Medindo… fique em silêncio' : 'Medir o atraso (sem fone, som na caixa)'}
            </button>
            {calibrationNote && <p className="mt-1 text-[10px] text-muted-foreground">{calibrationNote}</p>}
          </div>
        </div>

        {takes.length > 0 && (
          <ul className="mt-4 divide-y divide-white/5 rounded-xl border border-hairline">
            {takes.map((t) => (
              <li key={t.id} className="flex items-center gap-2 px-3 py-2 text-[12px]">
                <button
                  type="button"
                  onClick={() => patch({ chosen: t.id })}
                  className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                    chosen === t.id ? 'border-primary bg-primary' : 'border-white/25'
                  }`}
                  aria-label={`Usar a gravação ${t.n}`}
                  title="Usar esta gravação"
                />
                <span className="font-medium">Gravação {t.n}</span>
                <span className="num text-[11px] text-muted-foreground">{fmt(t.seconds)}</span>
                <div className="ml-auto flex gap-1">
                  <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[11px]" onClick={() => preview(t)} disabled={!!recording}>
                    {previewing === t.id ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                    {previewing === t.id ? 'Parar' : 'Ouvir'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => {
                      if (previewing === t.id) stopPreview();
                      setSing((s) => {
                        const rest = s.takes.filter((x) => x.id !== t.id);
                        return { ...s, takes: rest, chosen: s.chosen === t.id ? rest[rest.length - 1]?.id ?? null : s.chosen };
                      });
                    }}
                    disabled={!!recording}
                    aria-label={`Apagar a gravação ${t.n}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {takes.length > 0 && (
          <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
            Ao ouvir, se a voz parecer atrasada em relação à base, aumente a sincronia; se parecer adiantada, diminua.
          </p>
        )}
      </Step>

      <Step n={3} title="Sua música" done={!!result} hint="A voz e a base passam pela mixagem inteligente e pelo master do Forja.">
        <div className="space-y-4">
          <Row
            label="Voz na mistura"
            display={`${voiceDb > 0 ? '+' : ''}${voiceDb} dB`}
            value={voiceDb}
            min={-6}
            max={6}
            step={0.5}
            onChange={(v) => {
              patch({ voiceDb: v });
              setResult(null);
            }}
            disabled={rendering}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button className="h-11 gap-2 px-6 text-[13px]" onClick={render} disabled={!chosenTake || !!recording || rendering}>
              {rendering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              {rendering ? 'Mixando e masterizando…' : 'Gerar minha música'}
            </Button>
            {result && (
              <>
                <Button
                  variant="outline"
                  className="h-11 gap-2 text-[13px]"
                  onClick={() => download(encodeWav(result.buffer, 24), `${songName}-com-minha-voz.wav`)}
                >
                  <Download className="h-4 w-4" /> Baixar a música
                </Button>
                <Button variant="ghost" className="h-11 gap-2 text-[12px]" onClick={() => onOpenMix(songStems(sing), voiceDb)}>
                  <Sliders className="h-4 w-4" /> Ajustar na mixagem
                </Button>
              </>
            )}
          </div>
          {result && (
            <p className="num text-[11px] text-muted-foreground">
              Pronta: {result.lufs.toFixed(1)} LUFS · pico {result.truePeakDb.toFixed(1)} dBTP · WAV 24 bits.
            </p>
          )}
        </div>
      </Step>

      {error && <p className="text-center text-[12px] text-destructive">{error}</p>}
    </div>
  );
}
