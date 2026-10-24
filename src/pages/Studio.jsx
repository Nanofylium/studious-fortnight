import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ChannelStrip from '@/components/studio/ChannelStrip';
import MasterPanel from '@/components/studio/MasterPanel';
import ReportPanel from '@/components/studio/ReportPanel';
import StemDropzone from '@/components/studio/StemDropzone';
import StudioTopBar from '@/components/studio/StudioTopBar';
import Transport from '@/components/studio/Transport';
import { autoMix, excerptMixLufs, harshnessOf, suggestedMaster, summarizeMix, unityMix } from '@/lib/audio/analysis';
import { encodeWav, clamp } from '@/lib/audio/dsp';
import { renderMaster } from '@/lib/audio/chain';
import { StudioEngine } from '@/lib/audio/engine';
import { loadStemFiles, pickStemFiles } from '@/lib/audio/loader';

const STEM_COLORS = [
  '#f59e0b', '#38bdf8', '#a78bfa', '#34d399', '#fb7185', '#facc15',
  '#22d3ee', '#c084fc', '#4ade80', '#f472b6', '#60a5fa', '#fb923c',
];

export default function Studio() {
  const [stems, setStems] = useState([]);
  const [mixParams, setMixParams] = useState({});
  const [soloId, setSoloId] = useState(null);
  const [master, setMaster] = useState({
    deMetallic: 0.55,
    warmth: 0.4,
    width: 1.15,
    tape: 0.35,
    targetLufs: -14,
    ceilingDb: -1,
    streaming: true,
    makeupDb: 0,
    bypass: false,
  });
  const [baseline, setBaseline] = useState(null);
  const [after, setAfter] = useState(null);
  const [busy, setBusy] = useState(null);
  const [exporting, setExporting] = useState(null);
  const [error, setError] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [dragging, setDragging] = useState(false);

  const engineRef = useRef(null);
  const seekRef = useRef(0);
  const dragCount = useRef(0);
  const addInputRef = useRef(null);

  const params = useMemo(
    () => ({ ...master, stems: mixParams, soloId }),
    [master, mixParams, soloId],
  );
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;

  const duration = useMemo(() => stems.reduce((max, s) => Math.max(max, s.duration), 0), [stems]);
  const sampleRate = stems[0]?.sampleRate || 44100;

  const sessionName = useMemo(() => {
    const raw = stems[0]?.name || '';
    const slug = raw
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[^\p{L}\p{N} ]/gu, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, 4)
      .join('-')
      .toLowerCase();
    return slug || 'forja-sessao';
  }, [stems]);

  const handleFiles = useCallback(
    async (fileList) => {
      if (!fileList || !fileList.length) return;
      const files = pickStemFiles(fileList, stems.length);
      if (!files.length) {
        setError('Nenhum arquivo de áudio válido — ou o limite de 12 stems foi atingido.');
        return;
      }
      setError(null);
      setBusy({ phase: 'decode', name: files[0].name, index: 1, total: files.length });
      try {
        const decodeCtx = new OfflineAudioContext(2, 1, 44100);
        const loaded = await loadStemFiles(files, decodeCtx, setBusy);
        const next = [...stems, ...loaded].map((s, i) => ({ ...s, color: STEM_COLORS[i % STEM_COLORS.length] }));
        const levels = autoMix(next);
        const summary = summarizeMix(next);
        // Unity gain = exactly what the delivered files contain. A single file is
        // measured in full, so the loudness verdict on it is exact.
        const originalLufs = excerptMixLufs(next, unityMix(next), next.length === 1 ? 0 : 40);
        const sessionLufs = excerptMixLufs(next, levels, 40);

        setStems(next);
        setMixParams(levels);
        setBaseline({
          lufs: originalLufs,
          sessionLufs,
          peakDb: summary.truePeakDb ?? summary.peakDb,
          harshness: summary.harshness,
          crest: (summary.truePeakDb ?? summary.peakDb) - summary.rmsDb,
        });
        setAfter(null);
        setMaster((m) => ({
          ...m,
          ...suggestedMaster(summary),
          makeupDb: clamp(m.targetLufs - sessionLufs, -12, 16),
        }));
      } catch (e) {
        setError(`Não foi possível processar o arquivo. ${e?.message || ''}`.trim());
      } finally {
        setBusy(null);
      }
    },
    [stems],
  );

  useEffect(() => {
    const engine = engineRef.current;
    if (engine) engine.setStems(stems, paramsRef.current);
    if (!stems.length) {
      setPosition(0);
      seekRef.current = 0;
      setPlaying(false);
    }
  }, [stems]);

  useEffect(() => {
    engineRef.current?.updateParams(params);
  }, [params]);

  const ensureEngine = useCallback(async () => {
    if (!engineRef.current) {
      engineRef.current = new StudioEngine();
      await engineRef.current.ensureContext();
    }
    return engineRef.current;
  }, []);

  const getAnalyser = useCallback(() => engineRef.current?.getAnalyser() ?? null, []);

  const handlePlay = useCallback(async () => {
    if (!stems.length) return;
    const engine = await ensureEngine();
    await engine.setStems(stems, paramsRef.current);
    let from = seekRef.current;
    if (from >= duration - 0.1) from = 0;
    await engine.play(from);
    seekRef.current = from;
    setPosition(from);
    setPlaying(true);
  }, [stems, duration, ensureEngine]);

  const handlePause = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.pause();
    seekRef.current = engine.getPosition();
    setPosition(seekRef.current);
    setPlaying(false);
  }, []);

  const handleStop = useCallback(() => {
    engineRef.current?.stop();
    seekRef.current = 0;
    setPosition(0);
    setPlaying(false);
  }, []);

  const handleSeek = useCallback((t) => {
    seekRef.current = t;
    setPosition(t);
    engineRef.current?.seek(t);
  }, []);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let frame = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      frame += 1;
      const engine = engineRef.current;
      if (!engine) return;
      const pos = engine.getPosition();
      if (frame % 3 === 0) {
        setPosition(pos);
        seekRef.current = pos;
      }
      if (pos >= duration - 0.05) handleStop();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration, handleStop]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Space' || !stems.length) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
      e.preventDefault();
      if (playing) handlePause();
      else handlePlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing, stems.length, handlePlay, handlePause]);

  useEffect(() => () => engineRef.current?.dispose(), []);

  const handleMasterPatch = useCallback((patch) => {
    setMaster((m) => {
      const next = { ...m, ...patch };
      if (patch.targetLufs != null && baselineRef.current) {
        next.makeupDb = clamp(patch.targetLufs - baselineRef.current.sessionLufs, -12, 16);
      }
      return next;
    });
  }, []);

  const handleAuto = useCallback(() => {
    const summary = summarizeMix(stems);
    const lufs = excerptMixLufs(stems, mixParams);
    setMaster((m) => ({
      ...m,
      ...suggestedMaster(summary),
      makeupDb: clamp(m.targetLufs - lufs, -12, 16),
    }));
  }, [stems, mixParams]);

  const runRender = useCallback(
    async (download) => {
      if (!stems.length) return;
      setExporting({ pass: 1 });
      try {
        const result = await renderMaster(stems, paramsRef.current, {
          onProgress: (p) => setExporting({ pass: p + 1 }),
        });
        if (download) {
          const blob = encodeWav(result.buffer, 24);
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `${sessionName}-master.wav`;
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        }
        setMaster((m) => ({ ...m, makeupDb: result.makeupDb }));
        setAfter({
          lufs: result.lufs,
          peakDb: result.peakDb,
          crest: result.crest,
          limiterGrDb: result.limiterGrDb,
          harshness: harshnessOf(result.buffer),
        });
      } finally {
        setExporting(null);
      }
    },
    [stems, sessionName],
  );

  const handleExport = useCallback(() => runRender(true), [runRender]);
  const handleRender = useCallback(() => runRender(false), [runRender]);

  const handleClear = useCallback(() => {
    engineRef.current?.stop();
    setStems([]);
    setMixParams({});
    setSoloId(null);
    setBaseline(null);
    setAfter(null);
    setError(null);
    setPlaying(false);
    setPosition(0);
    seekRef.current = 0;
  }, []);

  const handleParam = useCallback((id, patch) => {
    setMixParams((p) => ({ ...p, [id]: { ...p[id], ...patch } }));
  }, []);

  return (
    <div
      className="relative min-h-screen pb-24"
      onDragEnter={(e) => {
        e.preventDefault();
        dragCount.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragCount.current = Math.max(0, dragCount.current - 1);
        if (!dragCount.current) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragCount.current = 0;
        setDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      <StudioTopBar
        stemCount={stems.length}
        duration={duration}
        sampleRate={sampleRate}
        exporting={exporting}
        canExport={stems.length > 0}
        onExport={handleExport}
        onClear={handleClear}
      />

      {stems.length === 0 ? (
        <StemDropzone onFiles={handleFiles} busy={busy} error={error} />
      ) : (
        <div className="mx-auto w-full max-w-[1680px] px-4 pt-6 lg:px-8">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_370px]">
            <section className="min-w-0">
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="font-heading text-[12px] font-semibold uppercase tracking-[0.2em]">Canais</h2>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {error ? <span className="text-destructive">{error}</span> : 'Mixagem automática aplicada — ajuste o que quiser.'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {busy && (
                    <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {busy.phase === 'decode' ? 'Decodificando' : busy.phase === 'clean' ? 'Limpando' : busy.phase === 'repair' ? 'Reparando' : 'Analisando'}{' '}
                      {busy.name}
                    </span>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 text-[11px]"
                    onClick={() => addInputRef.current?.click()}
                    disabled={!!busy || stems.length >= 12}
                  >
                    <Plus className="h-3.5 w-3.5" /> Adicionar
                  </Button>
                  <input
                    ref={addInputRef}
                    type="file"
                    accept="audio/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      handleFiles(e.target.files);
                      e.target.value = '';
                    }}
                  />
                </div>
              </div>

              <div className="flex gap-3 overflow-x-auto pb-3">
                {stems.map((stem) => (
                  <ChannelStrip
                    key={stem.id}
                    stem={stem}
                    params={mixParams[stem.id] || { gain: 1, pan: 0, muted: false }}
                    solo={soloId === stem.id}
                    progress={duration ? Math.min(1, position / duration) : 0}
                    onParam={(patch) => handleParam(stem.id, patch)}
                    onSolo={() => setSoloId((id) => (id === stem.id ? null : stem.id))}
                  />
                ))}
              </div>
            </section>

            <aside className="space-y-5">
              <MasterPanel master={master} getAnalyser={getAnalyser} onMaster={handleMasterPatch} onAuto={handleAuto} />
              <ReportPanel
                baseline={baseline}
                after={after}
                target={master.targetLufs}
                ceiling={master.ceilingDb}
                repairs={stems.map((s) => s.repair).filter(Boolean)}
                rendering={exporting}
                onRender={handleRender}
              />
            </aside>
          </div>
        </div>
      )}

      {stems.length > 0 && (
        <Transport
          playing={playing}
          position={position}
          duration={duration}
          bypass={master.bypass}
          onPlay={handlePlay}
          onPause={handlePause}
          onStop={handleStop}
          onSeek={handleSeek}
          onToggleBypass={() => handleMasterPatch({ bypass: !master.bypass })}
        />
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <div className="rounded-2xl border border-dashed border-primary/60 bg-primary/[0.06] px-10 py-8 font-heading text-sm uppercase tracking-[0.2em] text-primary">
            Solte para adicionar stems
          </div>
        </div>
      )}
    </div>
  );
}
