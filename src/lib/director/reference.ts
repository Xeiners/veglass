/**
 * Reading a reference edit.
 *
 * Someone points at a montage they like. The only honest way to learn how it is
 * cut is to measure it, and both halves of that measurement already exist: the
 * cuts come from ffmpeg's scene detector (`ai::scenes`), and the reference's own
 * three-movement arc comes from the same beat pipeline the montage uses, run on
 * the reference's own soundtrack.
 *
 * Crossing the two is the whole idea. Cuts alone give an average pace and no
 * shape; the arc alone gives a shape and no pace. Together they answer the
 * question that actually matters — *how fast does this edit cut, in each of its
 * movements* — and that is a fact about the reference that survives being
 * applied to different music.
 *
 * Everything here is pure. No I/O, no clock: the fetching and the two
 * measurements happen in `lib/director/client`, and this turns what they
 * returned into a profile.
 */

import { readStructure, type Structure } from '@/lib/amv/structure';
import type { Beat } from '@/lib/amv/beats';
import type { PhaseId } from '@/types/amv';
import { STRATEGY_LIMITS, type ReferenceProfile } from '@/types/director';

/**
 * Shortest stretch worth measuring a rate over, in seconds.
 *
 * A movement two seconds long with one cut in it says nothing about pacing —
 * the answer would be "two seconds a shot", which is an artefact of the window
 * rather than a fact about the edit. Below this the movement inherits the
 * overall rate instead.
 */
const MIN_MEASURED = 4;

/** The mean gap between cuts across a whole reference. */
function overallShot(cuts: number, duration: number): number {
  if (cuts < 2 || duration <= 0) return STRATEGY_LIMITS.maxShot;
  return clampShot(duration / cuts);
}

const clampShot = (seconds: number): number =>
  Math.min(STRATEGY_LIMITS.maxShot, Math.max(STRATEGY_LIMITS.minShot, seconds));

/**
 * What a reference does, from its cuts and its own beats.
 *
 * `beats` may be empty — a reference with no soundtrack, or one whose audio
 * would not decode. The arc then falls back to the conventional proportions,
 * and it says so: the *pacing* is still measured either way, and pacing is what
 * is being copied.
 */
export function readReference(
  cuts: number[],
  beats: Beat[],
  duration: number,
): ReferenceProfile {
  const span = Math.max(0.001, duration);
  const inside = cuts.filter((at) => at >= 0 && at <= span).sort((a, b) => a - b);
  const structure: Structure = readStructure(beats, span);
  const overall = overallShot(inside.length, span);

  const shot: Record<PhaseId, number> = { intro: overall, build: overall, drop: overall };
  const arc: ReferenceProfile['arc'] = { build: 0, drop: 0 };

  for (const phase of structure.phases) {
    const length = phase.to - phase.from;
    if (phase.id !== 'intro') arc[phase.id] = span > 0 ? phase.from / span : 0;

    // A rate needs a window long enough to be a rate, and at least two cuts to
    // have a gap between them. Anything less inherits the overall pace rather
    // than reporting the length of the window as the length of a shot.
    const within = inside.filter((at) => at >= phase.from && at < phase.to).length;
    if (length >= MIN_MEASURED && within >= 2) shot[phase.id] = clampShot(length / within);
  }

  /*
   * A movement can only be as fast as the ones after it.
   *
   * Not a correction of the measurement but of what it is used for: the
   * strategy is an *arc*, and a reference whose opening happens to be measured
   * busier than its release — a title sequence, a montage of stills before a
   * slow chorus — would otherwise be copied as a montage that decelerates.
   * Copying that literally reproduces the accident, not the intention.
   */
  shot.build = Math.min(shot.build, shot.intro);
  shot.drop = Math.min(shot.drop, shot.build);

  return {
    arc,
    shot,
    cuts: inside.length,
    duration: span,
    arcSource: structure.source,
  };
}
