import { applyParams, buildGraph } from './chain';
import { clamp } from './dsp';

// Real-time transport + graph host for the session.
export class StudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.graph = null;
    this.stems = [];
    this.params = null;
    this.offset = 0;
    this.startedAt = 0;
    this.playing = false;
    this.duration = 0;
  }

  async ensureContext() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'playback' });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.78;
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  async setStems(stems, params) {
    await this.ensureContext();
    const wasPlaying = this.playing;
    const pos = this.getPosition();
    this.stems = stems;
    this.params = params;
    this.duration = stems.reduce((max, s) => Math.max(max, s.duration), 0);
    this.disposeGraph();
    if (wasPlaying) {
      this.offset = clamp(pos, 0, Math.max(0, this.duration - 0.05));
      this.rebuild();
      this.startSources();
    } else {
      this.rebuild();
    }
  }

  updateParams(params) {
    this.params = params;
    if (this.graph) applyParams(this.graph, params, this.stems);
  }

  rebuild() {
    if (!this.ctx || !this.stems.length) {
      this.graph = null;
      return;
    }
    this.graph = buildGraph(this.ctx, this.stems, this.params, { meter: this.analyser });
    applyParams(this.graph, this.params, this.stems);
  }

  disposeGraph() {
    if (this.graph) this.graph.dispose();
    this.graph = null;
  }

  startSources() {
    if (!this.graph) return;
    const startAt = this.ctx.currentTime + 0.06;
    this.graph.stems.forEach((node, i) => {
      const stem = this.stems[i];
      const offset = Math.min(this.offset, Math.max(0, stem.duration - 0.02));
      try {
        node.src.start(startAt, offset);
      } catch (e) {
        /* already started */
      }
    });
    this.startedAt = startAt - this.offset;
    this.playing = true;
  }

  async play(from) {
    await this.ensureContext();
    if (this.playing) return;
    if (!this.graph) this.rebuild();
    if (!this.graph) return;
    if (from != null) this.offset = clamp(from, 0, Math.max(0, this.duration - 0.05));
    this.startSources();
  }

  pause() {
    const pos = this.getPosition();
    this.playing = false;
    this.offset = Math.max(0, pos);
    this.disposeGraph();
    this.rebuild();
  }

  stop() {
    this.playing = false;
    this.offset = 0;
    this.disposeGraph();
    this.rebuild();
  }

  seek(t) {
    this.offset = clamp(t, 0, Math.max(0, this.duration - 0.05));
    if (this.playing) {
      this.disposeGraph();
      this.rebuild();
      this.startSources();
    }
  }

  getPosition() {
    if (!this.ctx || !this.playing) return this.offset;
    return clamp(this.ctx.currentTime - this.startedAt, 0, this.duration);
  }

  getAnalyser() {
    return this.analyser;
  }

  dispose() {
    this.disposeGraph();
    if (this.ctx) this.ctx.close();
    this.ctx = null;
    this.analyser = null;
  }
}