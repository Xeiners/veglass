import type { AnimationMap } from './animation';
import type { BackgroundLayer } from './background';
import type { Backdrop } from './backdrop';
import { isStill } from './background';
import type { BannerLayer } from './banner';
import type { CursorLayer } from './cursor';
import type { Effect } from './effects';
import type { TextLayer } from './text';

export type TrackKind = 'video' | 'audio';

/**
 * What a clip is made of.
 *
 * `media` points at an imported file; `text` carries its own content and needs
 * no asset at all; `background` and `banner` carry only a recipe, and are drawn
 * from it — by the viewer for the preview, and by the export bake for the
 * render, through one painter each so the two cannot disagree.
 */
export type ClipKind = 'media' | 'text' | 'background' | 'banner' | 'cursor';

/**
 * Kinds whose pixels are produced by the front-end rather than read from a file.
 *
 * Worth a name because six places ask this question — the preview, the bake,
 * the render plan, the visual resolver among them — and every one of them used
 * to spell it out as `kind === 'text' || kind === 'background'`. Adding a
 * fourth kind meant finding all six, which is exactly the sort of hunt that
 * ends with one of them missed and a layer invisible only at export.
 */
export const GENERATED_KINDS: readonly ClipKind[] = ['text', 'background', 'banner', 'cursor'];

export const isGenerated = (clip: Pick<Clip, 'kind'>): boolean =>
  GENERATED_KINDS.includes(clip.kind);

/**
 * Whether the layer keeps its own size instead of conforming to the frame.
 *
 * Video and generated backgrounds fill the frame; a title, a banner and an
 * imported still are overlays with a box of their own, which is what gives the
 * gizmo something real to grab.
 */
export const hasOwnSize = (clip: Pick<Clip, 'kind'>): boolean =>
  clip.kind === 'text' || clip.kind === 'banner';

/**
 * Whether the layer's pixels differ every frame on their own.
 *
 * Keyframes are not the only thing that makes a layer move. A generated
 * background drifts on its own clock, and a cursor follows a path that is not
 * an animation channel — asking only "is anything keyframed" would freeze both
 * on their first frame at export, which is precisely the bug this exists to
 * name rather than to rediscover a third time.
 */
export const isContinuous = (clip: Pick<Clip, 'kind' | 'background'>): boolean => {
  if (clip.kind === 'cursor') return true;
  return clip.kind === 'background' && clip.background !== undefined && !isStill(clip.background);
};

export interface TrackCompressor {
  enabled: boolean;
  /** dBFS above which the compressor starts working. */
  threshold: number;
  ratio: number;
  /** dB of make-up gain applied after compression. */
  makeup: number;
}

/**
 * The track's audio bus.
 *
 * Everything here applies to the *sum* of the clips on the track, which is what
 * makes it a bus rather than a per-clip setting: soloing, panning and filtering
 * are decisions about a stem, not about one take.
 */
export interface TrackAudio {
  /** Linear gain, 1 = unity. */
  volume: number;
  /** -1 hard left, 0 centre, +1 hard right. */
  pan: number;
  /** Hz; 0 disables the filter. */
  highPass: number;
  lowPass: number;
  compressor: TrackCompressor;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  /** Row height in pixels. */
  height: number;
  muted: boolean;
  /** When any track is soloed, every un-soloed one falls silent. */
  solo: boolean;
  locked: boolean;
  /** Video tracks only — hides the layer from the preview compositor. */
  hidden: boolean;
  audio?: TrackAudio;
}

export function defaultTrackAudio(): TrackAudio {
  return {
    volume: 1,
    pan: 0,
    highPass: 0,
    lowPass: 0,
    compressor: { enabled: false, threshold: -18, ratio: 3, makeup: 0 },
  };
}

export const trackAudioOf = (track: Track): TrackAudio => track.audio ?? defaultTrackAudio();

/** A track is heard when it is not muted and nothing else is soloed instead. */
export function isAudible(track: Track, anySolo: boolean): boolean {
  if (track.muted) return false;
  return !anySolo || track.solo;
}

export interface Clip {
  id: string;
  kind: ClipKind;
  /** `null` on a text clip, which owns its content rather than referencing one. */
  assetId: string | null;
  trackId: string;
  /** Position on the timeline, in seconds. */
  start: number;
  /** Visible length, in seconds. */
  duration: number;
  /** In-point inside the source media, in seconds. */
  offset: number;
  /** 0 → 1. */
  volume: number;
  /** 0 → 1, video only. */
  opacity: number;
  /** 1 = fit to frame, video only. */
  scale: number;
  /** Offset from the centre of the frame, in project pixels. */
  x: number;
  y: number;
  /** Degrees, clockwise, about the centre of the layer. */
  rotation: number;
  muted: boolean;
  label?: string;
  /** Present when `kind === 'text'`. */
  text?: TextLayer;
  /** Present when `kind === 'background'`. */
  background?: BackgroundLayer;
  /** Present when `kind === 'banner'`. */
  banner?: BannerLayer;
  /** Present when `kind === 'cursor'`. */
  cursor?: CursorLayer;
  /**
   * The glass behind a floating media layer. Absent on everything else, and on
   * anything nobody has asked for one on — see `types/backdrop`.
   */
  backdrop?: Backdrop;
  /**
   * Animated channels. A channel present here overrides the static field of the
   * same name; absent means the scalar above is the value. See `types/animation`.
   */
  animation?: AnimationMap;
  /** Filter stack, applied in order. Empty on clips that were never touched. */
  effects: Effect[];
}

export const clipEnd = (clip: Clip): number => clip.start + clip.duration;

export const clipContains = (clip: Clip, time: number): boolean =>
  time >= clip.start && time < clip.start + clip.duration;

/** Source time under the playhead for a given clip. */
export const sourceTimeAt = (clip: Clip, time: number): number =>
  clip.offset + (time - clip.start);

export const DEFAULT_TRACK_HEIGHT = 68;
export const MIN_CLIP_DURATION = 0.1;

/** A clip sitting exactly on the frame, untransformed. */
export const IDENTITY_TRANSFORM = { scale: 1, x: 0, y: 0, rotation: 0 } as const;

export const isTransformed = (clip: Clip): boolean =>
  clip.scale !== 1 || clip.x !== 0 || clip.y !== 0 || clip.rotation !== 0;
