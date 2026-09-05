/**
 * The one number the strategy needs from the music it is being applied to.
 *
 * A target of "half a second a shot" is not a pace until it is measured against
 * the track's own pulse: at 120 BPM it means a cut on every beat, and at 180 it
 * means skipping one. Turning a length into a count of beats is what makes a
 * reference's pacing transferable at all — otherwise "copy that edit" would
 * copy its tempo along with its rhythm, and land every cut off the music.
 */

import type { Beat } from '@/lib/amv/beats';

/** Gaps outside this are a subdivision too fine, or a phrase rather than a beat. */
const MIN_GAP = 0.1;
const MAX_GAP = 2;

/** Below this many usable gaps a median is a coincidence rather than a pulse. */
const MIN_INTERVALS = 6;

/** The pulse assumed when the beats do not describe one — 120 BPM. */
const FALLBACK = 0.5;

/**
 * The median gap between beats, in seconds.
 *
 * The median and not the mean, for the reason `estimateTempo` gives: a run of
 * onsets contains plenty of gaps that are two beats long or half of one, and an
 * average is dragged around by them where a median is not.
 *
 * Unlike the tempo read-out, this is deliberately *not* folded into a musical
 * octave. What the strategy needs is the spacing of the events it can actually
 * cut on, and if those are eighths then eighths are the grid — folding it up to
 * the notional pulse would make every target twice as slow as asked for.
 */
export function medianInterval(beats: Beat[]): number {
  const gaps: number[] = [];
  for (let index = 1; index < beats.length; index += 1) {
    const gap = (beats[index]?.at ?? 0) - (beats[index - 1]?.at ?? 0);
    if (gap >= MIN_GAP && gap <= MAX_GAP) gaps.push(gap);
  }
  if (gaps.length < MIN_INTERVALS) return FALLBACK;

  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? FALLBACK;
}
