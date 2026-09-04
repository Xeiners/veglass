import type { TrackAudio } from '@/types/timeline';

/**
 * The mixing graph behind the preview.
 *
 * Media elements play through Web Audio rather than straight to the output, so
 * a track can be panned, filtered, compressed and — above all — *measured*.
 * Clip-level gain stays on the element itself (that is where keyframed volume
 * already lives); everything here applies to the track's sum, which is what
 * makes it a bus.
 *
 * The engine is a singleton because `createMediaElementSource` can be called
 * only once per element: ownership of that routing has to live somewhere
 * stable, outside React's mounting and unmounting.
 */

export interface Levels {
  /** 0 → 1, linear. */
  peak: number;
  rms: number;
}

interface Bus {
  input: GainNode;
  highPass: BiquadFilterNode;
  lowPass: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
  panner: StereoPannerNode;
  analyser: AnalyserNode;
  buffer: Float32Array<ArrayBuffer>;
  /** Decayed peak, so the meter falls smoothly instead of flickering. */
  held: number;
}

const SILENCE: Levels = { peak: 0, rms: 0 };
/** How fast the held peak falls, per animation frame. */
const DECAY = 0.06;

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buses = new Map<string, Bus>();
  private sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  private routed = new WeakMap<HTMLMediaElement, string>();
  private refused = new WeakSet<HTMLMediaElement>();

  /** Lazily built: an AudioContext created before a gesture starts suspended. */
  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;

    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  /** Browsers suspend the context until a gesture; playback is that gesture. */
  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  private bus(trackId: string): Bus | null {
    const ctx = this.ensure();
    if (!ctx || !this.master) return null;

    const existing = this.buses.get(trackId);
    if (existing) return existing;

    const input = ctx.createGain();
    const highPass = ctx.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 10;
    const lowPass = ctx.createBiquadFilter();
    lowPass.type = 'lowpass';
    lowPass.frequency.value = 20_000;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = 0;
    compressor.ratio.value = 1;

    const panner = ctx.createStereoPanner();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;

    input.connect(highPass);
    highPass.connect(lowPass);
    lowPass.connect(compressor);
    compressor.connect(panner);
    panner.connect(analyser);
    analyser.connect(this.master);

    const bus: Bus = {
      input,
      highPass,
      lowPass,
      compressor,
      panner,
      analyser,
      buffer: new Float32Array(new ArrayBuffer(analyser.fftSize * 4)),
      held: 0,
    };
    this.buses.set(trackId, bus);
    return bus;
  }

  /**
   * Routes an element into a track's bus, moving it if the track changed.
   *
   * Returns whether the routing happened. This is not a formality: a
   * `MediaElementAudioSourceNode` built over media the page cannot read
   * cross-origin outputs **silence**, and the element's own output is gone for
   * good once the node exists. So the caller must know, and must keep applying
   * gain to the element itself when the answer is no.
   */
  attach(element: HTMLMediaElement, trackId: string): boolean {
    if (this.refused.has(element)) return false;

    const ctx = this.ensure();
    const bus = this.bus(trackId);
    if (!ctx || !bus) return false;

    let source = this.sources.get(element);
    if (!source) {
      try {
        source = ctx.createMediaElementSource(element);
      } catch {
        // Already owned by another graph, or not ready. Plain playback is a
        // fair degradation: only the meter is lost.
        this.refused.add(element);
        return false;
      }
      this.sources.set(element, source);
    }

    if (this.routed.get(element) === trackId) return true;
    try {
      source.disconnect();
    } catch {
      /* never connected yet */
    }
    source.connect(bus.input);
    this.routed.set(element, trackId);
    return true;
  }

  isRouted(element: HTMLMediaElement): boolean {
    return this.routed.has(element);
  }

  /** Never route this element: its audio must reach the output directly. */
  refuse(element: HTMLMediaElement): void {
    this.refused.add(element);
  }

  /** Applies the bus settings. `audible` folds in mute and solo. */
  configure(trackId: string, audio: TrackAudio, audible: boolean, masterVolume: number): void {
    const bus = this.bus(trackId);
    if (!bus) return;

    const gain = audible ? Math.max(0, audio.volume) * Math.max(0, masterVolume) : 0;
    // Short ramps rather than jumps: a stepped gain is an audible click.
    const now = this.ctx?.currentTime ?? 0;
    bus.input.gain.setTargetAtTime(gain, now, 0.01);
    bus.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, audio.pan)), now, 0.01);

    bus.highPass.frequency.value = audio.highPass > 0 ? audio.highPass : 10;
    bus.lowPass.frequency.value = audio.lowPass > 0 ? audio.lowPass : 20_000;

    if (audio.compressor.enabled) {
      bus.compressor.threshold.value = Math.max(-100, Math.min(0, audio.compressor.threshold));
      bus.compressor.ratio.value = Math.max(1, Math.min(20, audio.compressor.ratio));
      bus.compressor.knee.value = 6;
      bus.compressor.attack.value = 0.02;
      bus.compressor.release.value = 0.25;
    } else {
      bus.compressor.threshold.value = 0;
      bus.compressor.ratio.value = 1;
    }
  }

  /** Current level of one bus, with a decaying peak hold. */
  levels(trackId: string): Levels {
    const bus = this.buses.get(trackId);
    if (!bus) return SILENCE;

    bus.analyser.getFloatTimeDomainData(bus.buffer);
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < bus.buffer.length; i += 1) {
      const sample = bus.buffer[i] as number;
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
      sum += sample * sample;
    }

    bus.held = Math.max(peak, bus.held - DECAY);
    return { peak: bus.held, rms: Math.sqrt(sum / bus.buffer.length) };
  }

  forget(trackId: string): void {
    this.buses.delete(trackId);
  }
}

export const audioEngine = new AudioEngine();

/** Linear amplitude → dBFS, floored where a meter stops being useful. */
export const toDb = (value: number): number =>
  value <= 0.00001 ? -100 : Math.max(-60, 20 * Math.log10(value));

/** dBFS → 0…1 along a meter scaled for the range that matters. */
export const meterScale = (db: number): number =>
  Math.max(0, Math.min(1, (db + 60) / 60));
