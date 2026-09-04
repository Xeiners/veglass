/**
 * Entrance and exit animations for generated text.
 *
 * Two callers want the same handful of curves — the subtitle pass and any
 * `addText` action that asks to be animated — so they are built here once,
 * against the clip they belong to rather than as fixed numbers.
 *
 * Two details make these behave: a keyframed channel *replaces* the static
 * field, so an animation has to be written relative to the value the clip
 * already has (a subtitle sitting low on the frame must rise to **its** y, not
 * to zero); and keyframe times are clip-relative, so the exit is expressed from
 * the clip's own duration and travels with it when the clip is trimmed.
 */

import { uid } from '@/lib/id';
import { snapToFrame } from '@/lib/time';
import type { AnimationMap, Easing, Keyframe } from '@/types/animation';
import type { Clip } from '@/types/timeline';
import type { SubtitleAnimation } from '@/types/ai';

/** Long enough to read as a move, short enough not to delay the word. */
const ENTRANCE = 0.22;
const EXIT = 0.16;
/** The word-by-word entrance: it has to land before the next word arrives. */
const PUNCH = 0.1;
/** Never eat more than this fraction of a short clip with its own entrance. */
const MAX_SHARE = 0.3;

/** Quart-out: fast off the mark, settled well before it stops. */
const OUT: Easing = { kind: 'bezier', bezier: [0.25, 1, 0.5, 1] };
const IN: Easing = { kind: 'bezier', bezier: [0.5, 0, 0.75, 0] };

const key = (time: number, value: number, easing: Easing): Keyframe => ({
  id: uid('kf'),
  time,
  value,
  easing: { ...easing },
});

/**
 * The animation map for `clip`, given the style asked for.
 *
 * Returns `undefined` for `none`, which is what the clip should then carry —
 * an absent map is the signal the rest of the editor tests for.
 */
export function entranceAnimation(
  clip: Pick<Clip, 'duration' | 'opacity' | 'scale' | 'y'>,
  style: SubtitleAnimation,
  fps: number,
  /** Seconds the entrance should take. Omitted, each style uses its own. */
  seconds?: number,
): AnimationMap | undefined {
  if (style === 'none') return undefined;
  const asked = seconds !== undefined && Number.isFinite(seconds) ? Math.max(0.02, seconds) : null;

  /*
   * `punch` is the word-by-word style, and it plays by different rules.
   *
   * A word on screen for a third of a second cannot afford a fifth of a second
   * of arrival, so the entrance is roughly half as long as the others. It comes
   * down from *above* full size rather than up from below — the overshoot is
   * what makes it read as a hit rather than a fade — and it has no exit at all,
   * because the next word replaces it. Fading a word out while the following
   * one arrives is what makes a karaoke line look mushy.
   */
  if (style === 'punch') {
    const rise = snapToFrame(Math.min(asked ?? PUNCH, clip.duration * 0.45), fps);
    if (rise <= 0) return undefined;
    return {
      opacity: [key(0, 0, OUT), key(rise, clip.opacity, { kind: 'linear' })],
      scale: [key(0, clip.scale * 1.22, OUT), key(rise, clip.scale, { kind: 'linear' })],
    };
  }

  // A one-second subtitle cannot spend a fifth of a second arriving and another
  // sixth leaving; the ramps shrink with the clip rather than overlapping.
  // A slow entrance is still capped by the clip: a two-second rise on a
  // one-second subtitle would never finish arriving before it left.
  const budget = clip.duration * MAX_SHARE;
  const rise = snapToFrame(Math.min(asked ?? ENTRANCE, budget), fps);
  const fall = snapToFrame(Math.min(EXIT, budget), fps);
  const end = snapToFrame(clip.duration, fps);
  if (rise <= 0 || end <= rise) return undefined;

  // Below this the clip has no room for a separate exit, and forcing one would
  // put two keys on the same frame — a subtitle that flashes rather than leaves.
  const leaves = end - fall > rise;
  const animation: AnimationMap = {
    opacity: leaves
      ? [
          key(0, 0, OUT),
          key(rise, clip.opacity, { kind: 'linear' }),
          key(end - fall, clip.opacity, IN),
          key(end, 0, { kind: 'linear' }),
        ]
      : [key(0, 0, OUT), key(rise, clip.opacity, { kind: 'linear' })],
  };

  if (style === 'pop') {
    // A hair under, never over: a title that overshoots reads as a bounce, and
    // a bounce on every subtitle is exhausting.
    animation.scale = [key(0, clip.scale * 0.94, OUT), key(rise, clip.scale, { kind: 'linear' })];
  }

  if (style === 'rise') {
    // The travel grows with the duration: a slow rise over 26 pixels reads as a
    // stall, and the request for "lente et fluide" means a longer move as much
    // as a longer time.
    const travel = Math.round(26 * Math.max(1, rise / ENTRANCE));
    animation.y = [key(0, clip.y + travel, OUT), key(rise, clip.y, { kind: 'linear' })];
  }

  return animation;
}
