import { clamp, dbToGain, limitTruePeak, measure, saturationCurve, tapeCurve } from './dsp';
import { integratedLufs } from './loudness';
import { minimumPhaseFir } from './reference';

// Builds the full signal chain once: per-stem correction -> fader/pan -> master bus.
// The exact same graph is used for live playback and for the offline render,
// so what you hear is what you download.
export function buildGraph(ctx, stems, params, options = {}) {
  const mixBus = ctx.createGain();

  const stemNodes = stems.map((stem) => {
    const src = ctx.createBufferSource();
    src.buffer = stem.buffer;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 28;
    hp.Q.value = 0.7;

    const harsh = ctx.createBiquadFilter();
    harsh.type = 'peaking';
    harsh.frequency.value = stem.analysis?.harshFreq || 3200;
    harsh.Q.value = 1.05;
    harsh.gain.value = 0;

    // Surgical tame of the region where AI generated sheen turns metallic,
    // narrow enough to leave true air above 12 kHz intact.
    const air = ctx.createBiquadFilter();
    air.type = 'peaking';
    air.frequency.value = 9200;
    air.Q.value = 0.9;
    air.gain.value = 0;

    const body = ctx.createBiquadFilter();
    body.type = 'lowshelf';
    body.frequency.value = 120;
    body.gain.value = 0;

    const shaper = ctx.createWaveShaper();
    shaper.curve = saturationCurve(0);
    shaper.oversample = '2x';

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 16;
    comp.ratio.value = 1.8;
    comp.attack.value = 0.012;
    comp.release.value = 0.2;

    const fader = ctx.createGain();
    const pan = ctx.createStereoPanner();

    src.connect(hp);
    hp.connect(harsh);
    harsh.connect(air);
    air.connect(body);
    body.connect(shaper);
    shaper.connect(comp);
    comp.connect(fader);
    fader.connect(pan);
    pan.connect(mixBus);

    return { src, hp, harsh, air, body, shaper, comp, fader, pan, drive: -1 };
  });

  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -16;
  glue.knee.value = 10;
  glue.ratio.value = 1.8;
  glue.attack.value = 0.02;
  glue.release.value = 0.28;

  const shelfLo = ctx.createBiquadFilter();
  shelfLo.type = 'lowshelf';
  shelfLo.frequency.value = 110;
  shelfLo.gain.value = 0;

  const shelfHi = ctx.createBiquadFilter();
  shelfHi.type = 'highshelf';
  shelfHi.frequency.value = 12000;
  shelfHi.gain.value = 0;

  // Reference match EQ: a minimum-phase FIR (see reference.js) in a
  // convolver, crossfaded against a dry path so it costs nothing when unused.
  const matchDry = ctx.createGain();
  const matchWet = ctx.createGain();
  matchWet.gain.value = 0;
  const matchConv = ctx.createConvolver();
  matchConv.normalize = false;

  // Mid/side stereo width stage
  const splitter = ctx.createChannelSplitter(2);
  const midL = ctx.createGain();
  const midR = ctx.createGain();
  const sideL = ctx.createGain();
  const sideR = ctx.createGain();
  midL.gain.value = 0.5;
  midR.gain.value = 0.5;
  sideL.gain.value = 0.5;
  sideR.gain.value = -0.5;

  const midSum = ctx.createGain();
  const sideSum = ctx.createGain();
  splitter.connect(midL, 0);
  splitter.connect(midR, 1);
  splitter.connect(sideL, 0);
  splitter.connect(sideR, 1);
  midL.connect(midSum);
  midR.connect(midSum);
  sideL.connect(sideSum);
  sideR.connect(sideSum);

  const sideWidth = ctx.createGain();
  sideWidth.gain.value = 1;
  sideSum.connect(sideWidth);

  const merger = ctx.createChannelMerger(2);
  const mL = ctx.createGain();
  const mR = ctx.createGain();
  const sL = ctx.createGain();
  const sR = ctx.createGain();
  sR.gain.value = -1;
  midSum.connect(mL);
  sideWidth.connect(sL);
  mL.connect(merger, 0, 0);
  sL.connect(merger, 0, 0);
  midSum.connect(mR);
  sideWidth.connect(sR);
  mR.connect(merger, 0, 1);
  sR.connect(merger, 0, 1);

  // Tape stage on the master bus: subtle harmonic rounding, a gentle high-end
  // loss and a low-end bump. It sits BEFORE the make-up gain, so the amount of
  // colour stays the same when the loudness target changes.
  const tapePre = ctx.createGain();
  tapePre.gain.value = 0.6;
  const tapeShape = ctx.createWaveShaper();
  tapeShape.curve = tapeCurve(0);
  tapeShape.oversample = '4x';
  const tapeDc = ctx.createBiquadFilter();
  tapeDc.type = 'highpass';
  tapeDc.frequency.value = 18;
  tapeDc.Q.value = 0.707;
  const tapeHf = ctx.createBiquadFilter();
  tapeHf.type = 'highshelf';
  tapeHf.frequency.value = 15000;
  tapeHf.gain.value = 0;
  const tapeBump = ctx.createBiquadFilter();
  tapeBump.type = 'lowshelf';
  tapeBump.frequency.value = 70;
  tapeBump.gain.value = 0;
  const tapePost = ctx.createGain();
  tapePost.gain.value = 1 / 0.6;

  const makeup = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.5;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;

  const out = ctx.createGain();

  mixBus.connect(glue);
  glue.connect(shelfLo);
  shelfLo.connect(shelfHi);
  shelfHi.connect(matchDry);
  shelfHi.connect(matchConv);
  matchConv.connect(matchWet);
  matchDry.connect(splitter);
  matchWet.connect(splitter);
  merger.connect(tapePre);
  tapePre.connect(tapeShape);
  tapeShape.connect(tapeDc);
  tapeDc.connect(tapeHf);
  tapeHf.connect(tapeBump);
  tapeBump.connect(tapePost);
  tapePost.connect(makeup);
  makeup.connect(limiter);
  limiter.connect(out);
  out.connect(ctx.destination);
  if (options.meter) out.connect(options.meter);

  return {
    stems: stemNodes,
    master: {
      mixBus,
      glue,
      shelfLo,
      shelfHi,
      matchDry,
      matchWet,
      matchConv,
      matchCurve: null,
      sideWidth,
      tapePre,
      tapeShape,
      tapeDc,
      tapeHf,
      tapeBump,
      tapePost,
      tapeDrive: -1,
      makeup,
      limiter,
      out,
    },
    dispose() {
      for (const n of stemNodes) {
        // stop() throws when the source was never started
        try {
          n.src.stop();
        } catch (e) {
          /* not started yet */
        }
        n.src.disconnect();
      }
      out.disconnect();
    },
  };
}

export function applyParams(graph, params, stems) {
  const bypass = !!params.bypass;
  const d = bypass ? 0 : clamp(params.deMetallic ?? 0.5, 0, 1);
  const w = bypass ? 0 : clamp(params.warmth ?? 0.35, 0, 1);
  const width = bypass ? 1 : clamp(params.width ?? 1.15, 0.5, 1.8);
  const drive = clamp(w * 0.55 + d * 0.12, 0, 0.8);
  const ceiling = clamp(params.ceilingDb ?? -1, -6, 0);

  graph.stems.forEach((node, i) => {
    const stem = stems[i];
    const p = (params.stems && params.stems[stem.id]) || { gain: 1, pan: 0, muted: false };
    const soloed = !!params.soloId;
    const audible = !p.muted && (!soloed || params.soloId === stem.id);
    const weight = 0.55 + 0.45 * (stem.analysis?.harshness ?? 0.4);

    node.fader.gain.value = audible ? clamp(p.gain, 0, 2) : 0;
    node.pan.pan.value = clamp(p.pan ?? 0, -1, 1);
    node.harsh.gain.value = -7.5 * d * weight;
    node.air.gain.value = -3.5 * d * weight;
    node.body.gain.value = 2.2 * w;
    node.comp.ratio.value = bypass ? 1 : 1.9;
    node.comp.threshold.value = bypass ? 0 : -20;

    if (Math.abs(node.drive - drive) > 0.02) {
      node.shaper.curve = saturationCurve(drive);
      node.drive = drive;
    }
  });

  const m = graph.master;
  m.glue.ratio.value = bypass ? 1 : 1.8;
  m.glue.threshold.value = bypass ? 0 : -16;
  m.shelfLo.gain.value = bypass ? 0 : 1.6;
  m.shelfHi.gain.value = bypass ? 0 : 1.1;
  m.sideWidth.gain.value = width;

  // The FIR is designed at the context's own rate, which can differ from the
  // stems' (a 48 kHz device playing 44.1 kHz files).
  const curve = bypass ? null : params.matchCurve || null;
  if (curve !== m.matchCurve) {
    if (curve) {
      const ctx = m.matchConv.context;
      const fir = minimumPhaseFir(curve, ctx.sampleRate);
      const ir = ctx.createBuffer(2, fir.length, ctx.sampleRate);
      ir.copyToChannel(fir, 0);
      ir.copyToChannel(fir, 1);
      m.matchConv.buffer = ir;
    }
    m.matchCurve = curve;
  }
  m.matchDry.gain.value = curve ? 0 : 1;
  m.matchWet.gain.value = curve ? 1 : 0;
  m.makeup.gain.value = bypass ? 1 : dbToGain(clamp(params.makeupDb ?? 0, -12, 18));
  m.limiter.ratio.value = bypass ? 1 : 20;
  // Limiting a touch below the ceiling leaves room for the limiter to catch
  // transients without overshooting it.
  m.limiter.threshold.value = bypass ? 0 : ceiling - 0.5;

  // Tape: the pre-gain keeps the curve in its sweet spot, the curve itself is
  // unity at small signal, and the DC blocker removes what the asymmetry adds.
  const tapeAmt = bypass ? 0 : clamp(params.tape ?? 0.35, 0, 1);
  m.tapePre.gain.value = bypass ? 1 : 0.6;
  m.tapePost.gain.value = bypass ? 1 : 1 / 0.6;
  m.tapeHf.gain.value = -1.3 * tapeAmt;
  m.tapeBump.gain.value = 1.1 * tapeAmt;
  if (Math.abs(m.tapeDrive - tapeAmt) > 0.02) {
    m.tapeShape.curve = tapeCurve(tapeAmt);
    m.tapeDrive = tapeAmt;
  }
}

export async function renderMix(stems, params) {
  const sampleRate = stems[0].buffer.sampleRate;
  const tail = Math.round(sampleRate * 0.4);
  const length = stems.reduce((max, s) => Math.max(max, s.buffer.length), 0) + tail;
  const ctx = new OfflineAudioContext(2, Math.max(sampleRate, length), sampleRate);
  const graph = buildGraph(ctx, stems, params);
  applyParams(graph, params, stems);
  for (const node of graph.stems) node.src.start(0);
  return ctx.startRendering();
}

// Renders the master and converges on both streaming constraints at once.
// The brickwall limiter holds the ceiling no matter how hard the level is
// pushed, so raising the makeup only moves loudness: the loop can therefore
// land on the target WITHOUT the ceiling being traded against it (which is
// what a post-render trim does — it drops loudness to save the peak).
export async function renderMaster(stems, params, { onProgress } = {}) {
  const target = params.targetLufs ?? -14;
  const ceiling = clamp(params.ceilingDb ?? -1, -6, 0);
  let makeup = clamp(params.makeupDb ?? 0, -12, 18);
  let rendered = null;
  let lufs = -70;
  let lim = { grDb: 0, truePeakDb: 0 };
  let prevMakeup = null;
  let prevLufs = null;

  for (let pass = 0; pass < 5; pass++) {
    onProgress?.(pass);
    rendered = await renderMix(stems, { ...params, bypass: false, makeupDb: makeup });
    lim = limitTruePeak(rendered, ceiling);
    lufs = integratedLufs(rendered);
    const delta = target - lufs;
    if (Math.abs(delta) < 0.15 || pass === 4) break;
    // A limiter makes loudness respond to make-up gain by less than 1:1, so the
    // step is scaled by the response actually measured, not assumed unity.
    let step = delta;
    if (prevMakeup != null && Math.abs(makeup - prevMakeup) > 0.05) {
      const sens = clamp((lufs - prevLufs) / (makeup - prevMakeup), 0.35, 1.1);
      step = delta / sens;
    }
    prevMakeup = makeup;
    prevLufs = lufs;
    makeup = clamp(makeup + clamp(step, -8, 12), -12, 18);
  }

  const meas = measure(rendered);
  return {
    buffer: rendered,
    lufs,
    peakDb: lim.truePeakDb,
    truePeakDb: lim.truePeakDb,
    limiterGrDb: lim.grDb,
    crest: lim.truePeakDb - meas.rmsDb,
    makeupDb: makeup,
    ceilingDb: ceiling,
  };
}