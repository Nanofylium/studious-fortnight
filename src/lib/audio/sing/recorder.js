// Records the singer over the instrumental. One AudioContext plays the
// instrumental and captures the mic through an AudioWorklet that stamps each
// block with its frame on the context clock, so a take can be placed on the
// instrumental to the sample (see align.js for the latency side).
import { clickTrain, clicksHeard, estimateLatencySec, joinChunks, measureLoopbackDelay } from './align.js';

// Collects mono blocks of 4096 frames, each with the context frame of its
// first sample. `start` and `stop` gate the capture; `stop` flushes.
const TAP = `
class ForjaTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.frame = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.n = 0; }
      else if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (this.n) this.port.postMessage({ frame: this.frame, data: this.buf.slice(0, this.n) });
    this.n = 0;
  }
  process(inputs) {
    const ins = inputs[0];
    if (!this.on || !ins || !ins.length) return true;
    const len = ins[0].length;
    for (let i = 0; i < len; i++) {
      if (this.n === 0) this.frame = currentFrame + i;
      let v = 0;
      for (let c = 0; c < ins.length; c++) v += ins[c][i];
      this.buf[this.n++] = v / ins.length;
      if (this.n === this.buf.length) this.flush();
    }
    return true;
  }
}
registerProcessor('forja-tap', ForjaTap);
`;

// Raw mic: the browser's voice-call processing (echo cancelling, noise
// suppression, automatic gain) smears singing and moves its timing.
const MIC = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };

export class SingRecorder {
  ctx = null;
  stream = null;
  micNode = null;
  tap = null;
  analyser = null;
  chunks = [];
  playing = [];

  get sampleRate() {
    return this.ctx?.sampleRate ?? 48000;
  }

  // Opens (or switches) the microphone. Must follow a click: browsers only
  // start audio and ask for the mic from a user gesture.
  async open(deviceId) {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      const url = URL.createObjectURL(new Blob([TAP], { type: 'application/javascript' }));
      try {
        await this.ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      this.tap = new AudioWorkletNode(this.ctx, 'forja-tap', { numberOfOutputs: 1, outputChannelCount: [1] });
      this.tap.port.onmessage = (e) => {
        if (e.data.done) this.onDone?.();
        else this.chunks.push(e.data);
      };
      // Pulled by the destination (silently) so it keeps processing.
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.tap.connect(mute).connect(this.ctx.destination);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { ...MIC, deviceId: { exact: deviceId } } : MIC,
    });
    this.closeMic();
    this.stream = stream;
    this.micNode = this.ctx.createMediaStreamSource(stream);
    this.micNode.connect(this.tap);
    this.micNode.connect(this.analyser);
    return stream.getAudioTracks()[0]?.getSettings?.().deviceId || deviceId || '';
  }

  async devices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  }

  // Round trip the browser reports for this mic and output, in seconds.
  estimatedLatency() {
    const settings = this.stream?.getAudioTracks()[0]?.getSettings?.() || {};
    return estimateLatencySec({
      outputLatency: this.ctx?.outputLatency,
      baseLatency: this.ctx?.baseLatency,
      inputLatency: settings.latency,
    });
  }

  // Peak level of the mic right now, 0..1.
  level() {
    if (!this.analyser) return 0;
    const d = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(d);
    let p = 0;
    for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
    return p;
  }

  // Plays `buffers` ([{ buffer, gain }]) together from `fromSec`, starting
  // slightly ahead so all sources begin on the same frame. Returns the
  // context time they start at.
  play(buffers, { fromSec = 0, onEnded } = {}) {
    this.stopPlayback();
    const at = this.ctx.currentTime + 0.15;
    let ended = 0;
    this.playing = buffers.map(({ buffer, gain = 1 }) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const g = this.ctx.createGain();
      g.gain.value = gain;
      src.connect(g).connect(this.ctx.destination);
      src.onended = () => {
        ended += 1;
        if (ended === buffers.length && this.playing.includes(src)) {
          this.playing = [];
          onEnded?.();
        }
      };
      src.start(at, fromSec);
      return src;
    });
    return at;
  }

  stopPlayback() {
    const list = this.playing;
    this.playing = [];
    for (const s of list) {
      try {
        s.stop();
      } catch {
        // never started
      }
    }
  }

  // Starts a take: the instrumental plays and the mic is captured from the
  // same context frame. `stopTake` returns the raw take.
  startTake(instrumental, { gain = 1, onEnded } = {}) {
    this.chunks = [];
    this.tap.port.postMessage('start');
    const at = this.play([{ buffer: instrumental, gain }], { onEnded });
    this.takeStart = Math.round(at * this.ctx.sampleRate);
    return at;
  }

  // Ends the take; resolves with { raw, sampleRate } where raw[0] is the
  // instant the instrumental started.
  stopTake() {
    this.stopPlayback();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.onDone?.(), 500);
      this.onDone = () => {
        clearTimeout(timer);
        this.onDone = null;
        resolve({ raw: joinChunks(this.chunks, this.takeStart), sampleRate: this.ctx.sampleRate });
        this.chunks = [];
      };
      this.tap.port.postMessage('stop');
    });
  }

  // Click loopback: plays a click train out loud and listens for it on the
  // mic. Resolves with the measured round trip in seconds, or null when the
  // clicks were not heard clearly.
  async calibrate() {
    const sr = this.ctx.sampleRate;
    const train = clickTrain(sr);
    const clicks = train.signal;
    const buffer = new AudioBuffer({ numberOfChannels: 1, length: clicks.length, sampleRate: sr });
    buffer.copyToChannel(clicks, 0);
    await new Promise((resolve) => {
      this.startTake(buffer, { onEnded: resolve });
    });
    const { raw } = await this.stopTake();
    const { lagFrames, confidence } = measureLoopbackDelay(clicks, raw, Math.round(0.6 * sr));
    // Most bursts must be heard as onsets at that lag, not just correlate.
    const heard = clicksHeard(raw, train, lagFrames, sr);
    return confidence >= 6 && heard >= train.starts.length - 2 ? { seconds: lagFrames / sr, confidence, heard } : null;
  }

  closeMic() {
    this.micNode?.disconnect();
    this.micNode = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  dispose() {
    this.stopPlayback();
    this.closeMic();
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
