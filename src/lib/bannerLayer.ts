/**
 * Placing a banner, and making it arrive.
 *
 * Its own module for the reason `lib/backgroundLayer` is: three callers need
 * exactly the same answer — the toolbar picker, the assistant's chapter pass,
 * and the tutorial builder — and a banner placed one way by hand and another
 * way by the generator would be a bug nobody could explain.
 *
 * The rule it encodes is short: **a banner goes on its own track, over
 * everything.** Not on the first free layer, the way a title does. A lower
 * third is a dressing, it is always meant to sit above the picture, and giving
 * it a named row of its own means a second run reuses that row instead of
 * stacking a new one — the same bargain `Sous-titres` and `Clips viraux` strike.
 */

import { uid } from '@/lib/id';
import { snapToFrame } from '@/lib/time';
import { measureBanner, bannerOffset } from '@/lib/bannerPainter';
import {
  BANNER_TRACK_NAME,
  DEFAULT_BANNER_DURATION,
  MIN_BANNER_DURATION,
  bannerFromPreset,
  type BannerLayer,
  type BannerPreset,
} from '@/types/banner';
import { presetEasing, type AnimationMap, type Easing, type Keyframe } from '@/types/animation';
import type { Project } from '@/types/project';
import { DEFAULT_TRACK_HEIGHT, clipEnd, type Clip, type Track } from '@/types/timeline';

/* ------------------------------------------------------------------ *
 * The track
 * ------------------------------------------------------------------ */

/**
 * The banner track — reused across runs rather than stacked, and created at the
 * *top* of the video block, which is where a dressing belongs. List order is
 * compositing order, so a banner track anywhere else would sit under the
 * footage it is supposed to label.
 */
export function bannerTrack(project: Project): { track: Track; created: boolean } {
  const existing = project.tracks.find(
    (track) => track.kind === 'video' && track.name === BANNER_TRACK_NAME,
  );
  if (existing) return { track: existing, created: false };

  return {
    track: {
      id: uid('tr'),
      kind: 'video',
      name: BANNER_TRACK_NAME,
      height: DEFAULT_TRACK_HEIGHT,
      muted: false,
      solo: false,
      locked: false,
      hidden: false,
    },
    created: true,
  };
}

/* ------------------------------------------------------------------ *
 * The slot
 * ------------------------------------------------------------------ */

export interface Slot {
  start: number;
  duration: number;
}

/**
 * Where a banner of `wanted` seconds can actually go, from `at` onwards.
 *
 * Banners share one row, so two chapters a second apart cannot both have their
 * full four and a half seconds. Three rules, in order:
 *
 * 1. if something already covers `at`, start after it — a banner that silently
 *    replaced another would lose the first one's text;
 * 2. shorten to the gap before whatever comes next, rather than overlapping it;
 * 3. if the gap is too short to read, look at the next one.
 *
 * Falling off the end is not a failure: the banner is appended after the last
 * one, which is what someone adding a fourth banner to a busy row expects.
 */
export function slotFor(
  clips: Clip[],
  trackId: string,
  at: number,
  wanted: number,
  fps: number,
): Slot {
  const occupied = clips
    .filter((clip) => clip.trackId === trackId)
    .sort((a, b) => a.start - b.start);

  let cursor = Math.max(0, at);

  for (let guard = 0; guard < occupied.length + 1; guard += 1) {
    const blocking = occupied.find(
      (clip) => cursor >= clip.start - 1e-6 && cursor < clipEnd(clip) - 1e-6,
    );
    if (blocking) {
      cursor = clipEnd(blocking);
      continue;
    }

    const next = occupied.find((clip) => clip.start > cursor + 1e-6);
    const room = next ? next.start - cursor : Number.POSITIVE_INFINITY;

    if (room >= MIN_BANNER_DURATION) {
      return {
        start: snapToFrame(cursor, fps),
        duration: snapToFrame(Math.max(MIN_BANNER_DURATION, Math.min(wanted, room)), fps),
      };
    }
    if (!next) break;
    cursor = clipEnd(next);
  }

  const last = occupied.reduce((furthest, clip) => Math.max(furthest, clipEnd(clip)), cursor);
  return { start: snapToFrame(last, fps), duration: snapToFrame(wanted, fps) };
}

/* ------------------------------------------------------------------ *
 * Motion
 * ------------------------------------------------------------------ */

/** `cubic-in-out` — the curve the brief names, taken from the shared library. */
const SLIDE: Easing = presetEasing('cubic-in-out');
/** `quart-out` for the fade: light off the mark, settled long before it stops. */
const FADE_IN: Easing = presetEasing('quart-out');
/** `sine-in-out` on the way out — a departure should never be the loud part. */
const FADE_OUT: Easing = presetEasing('sine-in-out');

/** Seconds a banner takes to leave. Shorter than its arrival, always. */
const EXIT = 0.3;
/** Never spend more than this share of a short banner on its own entrance. */
const MAX_SHARE = 0.34;
/** The exit slides back a fraction of the way it came — never all of it. */
const EXIT_TRAVEL = 0.45;

const key = (time: number, value: number, easing: Easing): Keyframe => ({
  id: uid('kf'),
  time,
  value,
  easing: { ...easing },
});

/**
 * The entrance and exit for a placed banner.
 *
 * Two things about this are load-bearing, and both are the rule stated at the
 * top of `lib/ai/motion.ts`.
 *
 * A keyframed channel **replaces** the static field, so the animation has to be
 * written relative to the value the clip already has: a banner anchored at the
 * bottom-left has an `x` of several hundred negative pixels, and a slide
 * written to land on zero would send it to the middle of the frame. Every value
 * below is `clip.x ± travel`, never an absolute.
 *
 * And keyframe times are clip-relative, so the exit is expressed from the
 * clip's own duration and travels with it when the banner is trimmed.
 *
 * Returns `undefined` when there is nothing to animate — the value the clip
 * should then carry, since an absent map is what the rest of the editor tests.
 */
export function bannerAnimation(
  clip: Pick<Clip, 'duration' | 'x' | 'opacity'>,
  layer: BannerLayer,
  width: number,
  fps: number,
): AnimationMap | undefined {
  if (layer.entrance <= 0 || clip.duration <= 0) return undefined;

  const budget = clip.duration * MAX_SHARE;
  const rise = snapToFrame(Math.min(layer.entrance, budget), fps);
  const fall = snapToFrame(Math.min(EXIT, budget), fps);
  const end = snapToFrame(clip.duration, fps);
  if (rise <= 0 || end <= rise) return undefined;

  // Off the side it hugs: a banner on the left slides in from the left.
  const direction = layer.side === 'left' ? -1 : 1;
  const travel = Math.round(width * layer.travel) * direction;

  // Below this there is no room for a separate exit, and forcing one would put
  // two keys on the same frame — a banner that blinks rather than leaves.
  const leaves = end - fall > rise;

  const animation: AnimationMap = {
    x: leaves
      ? [
          key(0, clip.x + travel, SLIDE),
          key(rise, clip.x, { kind: 'linear' }),
          key(end - fall, clip.x, FADE_OUT),
          key(end, clip.x + travel * EXIT_TRAVEL, { kind: 'linear' }),
        ]
      : [key(0, clip.x + travel, SLIDE), key(rise, clip.x, { kind: 'linear' })],
    opacity: leaves
      ? [
          key(0, 0, FADE_IN),
          // The fade finishes before the slide does, so the banner is solid
          // while it is still settling — a plate arriving translucent reads as
          // a rendering fault rather than as an animation.
          key(snapToFrame(rise * 0.7, fps), clip.opacity, { kind: 'linear' }),
          key(end - fall, clip.opacity, FADE_OUT),
          key(end, 0, { kind: 'linear' }),
        ]
      : [key(0, 0, FADE_IN), key(snapToFrame(rise * 0.7, fps), clip.opacity, { kind: 'linear' })],
  };

  return animation;
}

/* ------------------------------------------------------------------ *
 * Placement
 * ------------------------------------------------------------------ */

export interface BannerPlacement {
  project: Project;
  clip: Clip;
}

export interface PlaceOptions {
  at?: number;
  duration?: number;
  /** Off for a banner the user will position by hand before it moves. */
  animate?: boolean;
  label?: string;
}

/**
 * Adds one banner to the project, on the banner track.
 *
 * Pure `Project → Project`, like every other generator here: the caller commits
 * the result inside one `transact`, which is what lets the tutorial pass drop a
 * dozen banners as a single undo step.
 */
export function placeBanner(
  project: Project,
  layer: BannerLayer,
  options: PlaceOptions = {},
): BannerPlacement {
  const { fps } = project.settings;
  const { track, created } = bannerTrack(project);

  const slot = slotFor(
    project.clips,
    track.id,
    options.at ?? 0,
    Math.max(MIN_BANNER_DURATION, options.duration ?? DEFAULT_BANNER_DURATION),
    fps,
  );

  const metrics = measureBanner(layer, project.settings);
  const offset = bannerOffset(layer, project.settings, metrics);

  const base: Clip = {
    id: uid('cl'),
    kind: 'banner',
    assetId: null,
    trackId: track.id,
    start: slot.start,
    duration: slot.duration,
    offset: 0,
    volume: 1,
    opacity: 1,
    scale: 1,
    x: offset.x,
    y: offset.y,
    rotation: 0,
    // A dressing is silent, and an unmuted layer with no audio still counts
    // towards the mix meters, which is confusing rather than harmful.
    muted: true,
    label: options.label ?? (layer.title.trim().slice(0, 48) || 'Habillage'),
    effects: [],
    banner: layer,
  };

  const animation =
    options.animate === false
      ? undefined
      : bannerAnimation(base, layer, metrics.width, fps);

  const clip: Clip = animation ? { ...base, animation } : base;

  // The banner track goes on top of the video stack — see `bannerTrack`.
  return {
    project: {
      ...project,
      tracks: created ? [track, ...project.tracks] : project.tracks,
      clips: [...project.clips, clip],
    },
    clip,
  };
}

/** The same, from a preset id — what the picker and the toolbar button use. */
export const placePreset = (
  project: Project,
  preset: BannerPreset,
  content: { title?: string; subtitle?: string } = {},
  options: PlaceOptions = {},
): BannerPlacement => placeBanner(project, bannerFromPreset(preset, content), options);
