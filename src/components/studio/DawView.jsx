import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Circle,
  Loader2,
  Mic,
  Pause,
  Play,
  Plus,
  Redo2,
  Scissors,
  SkipBack,
  Square,
  TrendingDown,
  TrendingUp,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  AudioPosition,
  ClipInteractionProvider,
  KeyboardShortcuts,
  Waveform,
  WaveformPlaylistProvider,
  useClipSplitting,
  usePlaybackAnimation,
  usePlaylistControls,
  usePlaylistData,
  usePlaylistState,
} from '@waveform-playlist/browser';
import { createTrack } from '@waveform-playlist/core';
import { useIntegratedRecording } from '@waveform-playlist/recording';
import { SegmentedVUMeter, darkTheme } from '@waveform-playlist/ui-components';
import { Button } from '@/components/ui/button';

// Forja colours on the library's dark theme.
const THEME = {
  ...darkTheme,
  backgroundColor: 'transparent',
  playlistBackgroundColor: 'transparent',
  surfaceColor: 'rgba(255,255,255,0.02)',
  borderColor: 'rgba(255,255,255,0.08)',
  waveOutlineColor: '#0b0d12',
  waveFillColor: '#f59e0b',
  waveProgressColor: 'rgba(245,158,11,0.35)',
  selectedWaveFillColor: '#fbbf24',
  selectedTrackBackground: 'rgba(245,158,11,0.06)',
  selectedTrackControlsBackground: 'rgba(245,158,11,0.10)',
  playheadColor: '#fbbf24',
  selectionColor: 'rgba(245,158,11,0.18)',
  timeColor: '#8b93a7',
  timescaleBackgroundColor: 'transparent',
  clipHeaderBackgroundColor: 'rgba(255,255,255,0.05)',
  selectedClipHeaderBackgroundColor: 'rgba(245,158,11,0.18)',
  clipHeaderTextColor: '#cbd2e1',
  fadeOverlayColor: 'rgba(56,189,248,0.25)',
  fontFamily: 'inherit',
};

function Tool({ label, onClick, disabled, active, children, className = '' }) {
  return (
    <Button
      variant={active ? 'default' : 'ghost'}
      size="sm"
      className={`h-8 gap-1.5 px-2.5 text-[11px] ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      {children}
    </Button>
  );
}

const Divider = () => <span className="mx-1 h-6 w-px bg-white/10" />;

function Editor({ tracks, setTracks, selectedTrackId, setSelectedTrackId, onApply, applying }) {
  const { currentTimeRef, isPlaying, currentTime } = usePlaybackAnimation();
  const { sampleRate, samplesPerPixel, playoutRef, canZoomIn, canZoomOut } = usePlaylistData();
  const { play, pause, stop, seekTo, zoomIn, zoomOut, undo, redo, setRecordingActive, setSelectedTrackId: setProviderTrack } =
    usePlaylistControls();
  const { selectedTrackId: providerTrack, canUndo, canRedo } = usePlaylistState();
  const { splitClipAtPlayhead } = useClipSplitting({ tracks, samplesPerPixel, engineRef: playoutRef });

  // Keep the selected track in sync both ways (clicks in the waveform select
  // in the provider; "new track" selects here).
  useEffect(() => setProviderTrack(selectedTrackId), [selectedTrackId, setProviderTrack]);
  const lastProvider = useRef(providerTrack);
  useEffect(() => {
    if (providerTrack !== lastProvider.current) {
      lastProvider.current = providerTrack;
      setSelectedTrackId(providerTrack);
    }
  }, [providerTrack, setSelectedTrackId]);

  const rec = useIntegratedRecording(tracks, setTracks, selectedTrackId, { currentTime, channelCount: 1 });
  const recordStart = useRef(0);
  const starting = useRef(false);
  const [armNew, setArmNew] = useState(false);

  const addTrack = useCallback(
    (name) => {
      const n = tracks.filter((t) => /^Voz gravada/.test(t.name)).length + 1;
      const t = createTrack({ name: name || `Voz gravada ${n}`, clips: [] });
      setTracks([...tracks, t]);
      setSelectedTrackId(t.id);
      return t;
    },
    [tracks, setTracks, setSelectedTrackId],
  );

  // Record over the other tracks: they play while the mic captures.
  const startTake = useCallback(async () => {
    if (starting.current) return;
    starting.current = true;
    try {
      recordStart.current = currentTimeRef.current ?? 0;
      setRecordingActive(true, selectedTrackId);
      const ok = await rec.startRecording();
      if (!ok) {
        setRecordingActive(false);
        return;
      }
      await play(currentTimeRef.current ?? 0).catch(() => {});
    } finally {
      starting.current = false;
    }
  }, [rec, play, currentTimeRef, setRecordingActive, selectedTrackId]);

  useEffect(() => {
    if (armNew && selectedTrackId) {
      setArmNew(false);
      startTake();
    }
  }, [armNew, selectedTrackId, startTake]);

  const onRecord = async () => {
    if (rec.isRecording) return;
    if (!rec.hasPermission) await rec.requestMicAccess().catch(() => {});
    const sel = tracks.find((t) => t.id === selectedTrackId);
    // Recording goes on a new "Voz gravada" track unless one is selected.
    if (!sel || !/^Voz gravada/.test(sel.name)) {
      setArmNew(true);
      addTrack();
      return;
    }
    startTake();
  };

  const onStop = () => {
    if (rec.isRecording) {
      rec.stopRecording();
      pause();
    } else {
      stop();
    }
  };

  // Fades on the clip under the playhead in the selected track: from the clip
  // start up to the playhead, or from the playhead to the clip end.
  const fadeAtPlayhead = (kind) => {
    const t = currentTimeRef.current ?? 0;
    const s = Math.round(t * sampleRate);
    let done = false;
    const next = tracks.map((tr) => {
      if (tr.id !== selectedTrackId) return tr;
      return {
        ...tr,
        clips: tr.clips.map((c) => {
          if (s <= c.startSample || s >= c.startSample + c.durationSamples) return c;
          done = true;
          return kind === 'in'
            ? { ...c, fadeIn: { duration: (s - c.startSample) / sampleRate, type: 'sCurve' } }
            : { ...c, fadeOut: { duration: (c.startSample + c.durationSamples - s) / sampleRate, type: 'sCurve' } };
        }),
      };
    });
    if (done) setTracks(next);
  };

  const shortcuts = useMemo(
    () => [
      { key: ' ', action: () => (isPlaying ? pause() : play(currentTimeRef.current ?? 0)), description: 'Tocar/pausar', preventDefault: true },
      { key: 'Escape', action: onStop, description: 'Parar', preventDefault: true },
      { key: 'r', action: onRecord, description: 'Gravar', preventDefault: true },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isPlaying, pause, play, currentTimeRef, rec.isRecording, selectedTrackId, tracks],
  );

  const busy = rec.isRecording;
  const recordingStartSample = Math.floor(recordStart.current * sampleRate);

  return (
    <>
      <KeyboardShortcuts clipSplitting undo additionalShortcuts={shortcuts} />
      <div className="mb-3 flex flex-wrap items-center gap-1 rounded-2xl border border-hairline bg-panel/70 px-2 py-1.5">
        <Tool label="Voltar ao início" onClick={() => { stop(); seekTo(0); }} disabled={busy}>
          <SkipBack className="h-4 w-4" />
        </Tool>
        {isPlaying ? (
          <Tool label="Pausar" onClick={pause} disabled={busy}>
            <Pause className="h-4 w-4" />
          </Tool>
        ) : (
          <Tool label="Tocar" onClick={() => play(currentTimeRef.current ?? 0)} disabled={busy}>
            <Play className="h-4 w-4" />
          </Tool>
        )}
        <Tool label="Parar" onClick={onStop} disabled={!isPlaying && !busy}>
          <Square className="h-4 w-4" />
        </Tool>
        <Button
          size="sm"
          className={`h-8 gap-1.5 px-3 text-[11px] ${busy ? 'bg-red-500 hover:bg-red-500' : 'bg-red-500/90 hover:bg-red-500'} text-white`}
          onClick={onRecord}
          disabled={busy}
          title="Gravar (R)"
        >
          <Circle className={`h-3.5 w-3.5 ${busy ? 'animate-pulse fill-white' : 'fill-white'}`} />
          {busy ? `Gravando ${rec.duration.toFixed(1)} s` : 'Gravar voz'}
        </Button>
        <span className="num ml-1 min-w-[88px] text-[11px] text-muted-foreground">
          <AudioPosition />
        </span>
        <Divider />
        <Tool label="Cortar no cursor (S)" onClick={splitClipAtPlayhead} disabled={busy}>
          <Scissors className="h-4 w-4" /> <span className="hidden sm:inline">Cortar</span>
        </Tool>
        <Tool label="Fade in do começo do clipe até o cursor" onClick={() => fadeAtPlayhead('in')} disabled={busy || !selectedTrackId}>
          <TrendingUp className="h-4 w-4" /> <span className="hidden sm:inline">Fade in</span>
        </Tool>
        <Tool label="Fade out do cursor até o fim do clipe" onClick={() => fadeAtPlayhead('out')} disabled={busy || !selectedTrackId}>
          <TrendingDown className="h-4 w-4" /> <span className="hidden sm:inline">Fade out</span>
        </Tool>
        <Tool label="Desfazer (Ctrl+Z)" onClick={undo} disabled={busy || !canUndo}>
          <Undo2 className="h-4 w-4" />
        </Tool>
        <Tool label="Refazer (Ctrl+Shift+Z)" onClick={redo} disabled={busy || !canRedo}>
          <Redo2 className="h-4 w-4" />
        </Tool>
        <Divider />
        <Tool label="Aproximar" onClick={zoomIn} disabled={!canZoomIn}>
          <ZoomIn className="h-4 w-4" />
        </Tool>
        <Tool label="Afastar" onClick={zoomOut} disabled={!canZoomOut}>
          <ZoomOut className="h-4 w-4" />
        </Tool>
        <Tool label="Nova pista" onClick={() => addTrack()} disabled={busy}>
          <Plus className="h-4 w-4" /> <span className="hidden sm:inline">Pista</span>
        </Tool>
        <div className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            <Mic className="h-3.5 w-3.5" />
            {rec.hasPermission ? (
              <SegmentedVUMeter
                levels={rec.levels}
                peakLevels={rec.peakLevels}
                orientation="horizontal"
                segmentCount={24}
                segmentWidth={6}
                segmentHeight={8}
                segmentGap={1}
                dBRange={[-50, 0]}
                coloredInactive
              />
            ) : (
              'mic desligado'
            )}
          </span>
          {rec.hasPermission && rec.devices.length > 1 && (
            <select
              className="h-8 max-w-[160px] rounded-lg border border-hairline bg-transparent px-2 text-[11px]"
              value={rec.selectedDevice || ''}
              onChange={(e) => rec.changeDevice(e.target.value)}
              disabled={busy}
              aria-label="Microfone"
            >
              {rec.devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Microfone'}
                </option>
              ))}
            </select>
          )}
          <Button size="sm" className="h-8 gap-1.5 text-[11px]" onClick={onApply} disabled={busy || applying}>
            {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Usar na mixagem
          </Button>
        </div>
      </div>
      {rec.error && <p className="mb-2 text-[11px] text-destructive">Microfone: {rec.error.message}</p>}

      <div className="overflow-hidden rounded-2xl border border-hairline bg-panel/40">
        <ClipInteractionProvider>
          <Waveform
            showClipHeaders
            showFades
            onRemoveTrack={(i) => {
              const gone = tracks[i];
              if (!gone || busy) return;
              if (gone.id === selectedTrackId) setSelectedTrackId(null);
              setTracks(tracks.filter((_, k) => k !== i));
            }}
            recordingState={
              busy && selectedTrackId
                ? {
                    isRecording: true,
                    trackId: selectedTrackId,
                    startSample: recordingStartSample,
                    durationSamples: Math.floor(rec.duration * sampleRate),
                    peaks: rec.recordingPeaks,
                    bits: 16,
                  }
                : undefined
            }
          />
        </ClipInteractionProvider>
      </div>
      <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
        Arraste os clipes para mover, puxe as bordas para aparar. Espaço toca, R grava numa pista "Voz gravada" com o
        resto tocando no fone, S corta no cursor. Use fone de ouvido para o instrumental não vazar no microfone.
      </p>
    </>
  );
}

// The editor: waveform-playlist (MIT) driven by the session's stems. "Usar na
// mixagem" renders the tracks back into stems for the Forja chain.
export default function DawView({ tracks, setTracks, sampleRate, onApply, applying }) {
  const [selectedTrackId, setSelectedTrackId] = useState(null);
  return (
    <WaveformPlaylistProvider
      tracks={tracks}
      onTracksChange={setTracks}
      sampleRate={sampleRate}
      samplesPerPixel={2048}
      zoomLevels={[256, 512, 1024, 2048, 4096, 8192]}
      waveHeight={88}
      automaticScroll
      timescale
      controls={{ show: true, width: 190 }}
      theme={THEME}
      barWidth={1}
      barGap={0}
    >
      <Editor
        tracks={tracks}
        setTracks={setTracks}
        selectedTrackId={selectedTrackId}
        setSelectedTrackId={setSelectedTrackId}
        onApply={() => onApply(tracks)}
        applying={applying}
      />
    </WaveformPlaylistProvider>
  );
}
