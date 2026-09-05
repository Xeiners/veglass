/**
 * Reading the shape of a track, so the montage can have one too.
 *
 * The sequencer without this is a machine with reflexes and no intention: it
 * cuts every beat as hard as every other, and ninety seconds of that is not an
 * edit but a texture. What is missing is the thing a human editor supplies
 * before they touch a single clip — *where is this going*. An edit that has
 * somewhere to go can be calm at the start, because the calm is what makes the
 * drop land; one that is loud throughout has spent its loudest moment in the
 * first four seconds and has nothing left.
 *
 * So the track is read as three movements — a settled opening, a rise, and the
 * release — and every dial the sequencer owns is modulated by which one a shot
 * falls in. The phases are found here; what they *do* is in `types/amv`.
 *
 * # Why the beats, and not a second analysis
 *
 * The obvious instinct is to ask Rust for a loudness envelope and threshold it.
 * The beats are better, for two reasons. Their strength is already normalised
 * against the whole track, so "loud for this song" needs no second calibration;
 * and they are already in memory, which means the structure is re-read on a
 * sensitivity drag along with everything else, instead of going stale against
 * the beats it is supposed to describe.
 *
 * Everything here is pure. No I/O, no clock, no randomness — the same track and
 * the same beats always give the same arc.
 */

import { clamp } from '@/lib/time';
import type { Beat } from './beats';
import type { PhaseId } from '@/types/amv';

/** How often intensity is sampled, in seconds. Structure moves in bars. */
const STEP = 0.5;

/**
 * Half-width of the window each sample sums over, in seconds.
 *
 * Three seconds either side is roughly a bar and a half at any usual tempo —
 * long enough that a fill or a dropped beat does not register as a change of
 * movement, short enough that the boundary it reports is within a second or so
 * of where the music actually turns. A centred window necessarily smears a step
 * across its own width; the levels below are picked knowing that.
 */
const WINDOW = 3;

/**
 * Where the release begins, as a fraction of the track's own peak intensity.
 *
 * Two things are folded into this number. It has to be high enough that a busy
 * verse is not mistaken for the chorus — getting that wrong is the expensive
 * direction, because a montage that decides the drop started in the second bar
 * is exactly the flat, exhausting thing this module exists to prevent. And it
 * has to account for the window: a step change crosses this level roughly a
 * second *after* the music turns, which is the right side to err on. An editor
 * lets the drop land before answering it.
 */
const DROP_LEVEL = 0.68;

/**
 * How far above the track's own floor the rise begins, as a fraction of the
 * distance from that floor to the peak.
 *
 * Measured from the **floor**, not from the peak, and that distinction is the
 * whole of it. A fraction of the peak ties the rise to how big the release is:
 * on a track whose drop is four times denser than its build, the build sits at
 * a fifth of the peak and any level worth setting puts the whole of it back in
 * the opening. Measured from the floor it means what it should — "the track has
 * stopped being an opening" — whatever the drop does later.
 *
 * Low, because the rise is a departure from calm, not an approach to loud.
 */
const BUILD_RISE = 0.12;

/**
 * Where the floor is taken from, as a quantile of the curve.
 *
 * Not the minimum: one sample of true silence at the very start would put the
 * floor at zero and the rise threshold back where a fraction of the peak had
 * it. The low sixth is settled enough to be the opening and robust to a gap.
 */
const FLOOR_QUANTILE = 0.15;

/**
 * How long the intensity must stay up before it counts, in seconds.
 *
 * A drum fill at the end of the first verse can be as dense as the chorus for a
 * second and a half. Requiring the level to *hold* is what separates a fill
 * from an arrival. The rise is given a shorter guard than the release: it is a
 * lower bar to clear, so a spurious crossing costs less.
 */
const DROP_HOLD = 3;
const BUILD_HOLD = 2;

/** Below this a phase is not a movement, and is folded into its neighbour. */
const MIN_PHASE = 2;

/**
 * Where the phases fall when the music does not say.
 *
 * Used when the track never crosses the bar, and when it is over the bar from
 * its first sample — both are music with no arc of its own, and both still want
 * one: the arc is an editing convention as much as a musical fact, and an edit
 * that opens at full intensity has thrown away its own build. These proportions
 * are the shape a short edit takes when nothing argues otherwise — a brief
 * settle, a rise about a quarter of the way in, the rest given to the release.
 */
const FALLBACK_INTRO = 0.18;
const FALLBACK_BUILD = 0.42;

export interface Phase {
  id: PhaseId;
  /** Seconds from the start of the montage. */
  from: number;
  to: number;
}

export interface Structure {
  /** Ordered, contiguous, covering `[0, span)`. Never empty. */
  phases: Phase[];
  /**
   * How the boundaries were arrived at.
   *
   * `measured` — the track's own intensity crossed the thresholds.
   * `proportional` — it never did, and the conventional shape was used.
   *
   * Reported rather than hidden, because the two deserve different confidence:
   * a measured arc can be trusted to land on the music, and an assumed one is a
   * reasonable guess that someone may want to argue with.
   */
  source: 'measured' | 'proportional';
  /** The curve the boundaries came from, 0 → 1, for the review strip. */
  intensity: number[];
  /** Seconds between two samples of `intensity`. */
  step: number;
}

/**
 * Strength-weighted beat rate over time, normalised to its own peak.
 *
 * Weighted rather than counted, because density alone cannot tell a hi-hat
 * pattern from a kick pattern — an intro full of light percussion would read
 * as busier than the chorus it leads into. Multiplying by strength puts the
 * weight where the energy is.
 *
 * Normalised against the track's own maximum, so the numbers mean "loud for
 * this song" rather than "loud in absolute terms". A quiet acoustic track has a
 * drop too, and it is not at −6 dBFS.
 */
export function intensityCurve(beats: Beat[], span: number): number[] {
  const samples = Math.max(1, Math.ceil(span / STEP));
  const out = new Array<number>(samples).fill(0);
  if (beats.length === 0) return out;

  for (const beat of beats) {
    if (beat.at < 0 || beat.at > span) continue;
    // Spread over the window rather than added at a point: one pass over the
    // beats fills the whole curve, and the result is already smooth.
    const first = Math.max(0, Math.ceil((beat.at - WINDOW) / STEP));
    const last = Math.min(samples - 1, Math.floor((beat.at + WINDOW) / STEP));
    for (let index = first; index <= last; index += 1) {
      out[index] += beat.strength;
    }
  }

  const ceiling = out.reduce((max, value) => Math.max(max, value), 0);
  if (ceiling <= 0) return out;
  return out.map((value) => value / ceiling);
}

/**
 * The first sample where the curve reaches `level` and stays there.
 *
 * `-1` when it never does. Runs that are too short are skipped whole rather
 * than re-tested sample by sample — a long shelf sitting just over the bar is
 * otherwise quadratic in the length of the track.
 */
function sustained(curve: number[], level: number, hold: number): number {
  const needed = Math.max(1, Math.round(hold / STEP));
  let index = 0;

  while (index < curve.length) {
    if (!((curve[index] ?? 0) >= level)) {
      index += 1;
      continue;
    }

    let held = 0;
    while (index + held < curve.length && (curve[index + held] ?? 0) >= level) held += 1;
    /*
     * `held` cannot be zero here, and the test above is written to keep it that
     * way. Phrased as `< level` — the obvious spelling — a `NaN` in the curve
     * would fail it (every comparison with NaN is false), fall through, fail
     * the inner test too, leave `held` at zero and spin here for ever. Negating
     * the same comparison the inner loop uses makes the two agree by
     * construction, so any value that reaches this line advances the cursor.
     */
    if (held >= needed) return index;
    index += held;
  }

  return -1;
}

/** The track's own settled level — what "calm" means for this song. */
function floorOf(curve: number[]): number {
  if (curve.length === 0) return 0;
  const sorted = [...curve].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * FLOOR_QUANTILE)] ?? 0;
}

/** Trims phases that are too short to be movements, keeping the run contiguous. */
function tidy(phases: Phase[], span: number): Phase[] {
  const kept = phases.filter((phase) => phase.to - phase.from >= MIN_PHASE);
  if (kept.length === 0) return [{ id: 'drop', from: 0, to: span }];

  // Whatever the dropped phases held is given to the one that follows, or to
  // the last one standing — the montage must cover its whole span either way.
  return kept.map((phase, index) => ({
    ...phase,
    from: index === 0 ? 0 : (kept[index - 1] as Phase).to,
    to: index === kept.length - 1 ? span : phase.to,
  }));
}

/**
 * The three movements of a montage, read off the beats.
 *
 * The drop is found first, because it is the only boundary the music states
 * plainly: intensity arrives and stays. The rise is then found by walking back
 * from it to the last moment things were still settled, which is where a build
 * actually starts — not at a level of its own, but at the foot of the climb.
 *
 * A track that never reaches the bar gets the conventional shape instead, and
 * says so.
 */
export function readStructure(beats: Beat[], span: number): Structure {
  const intensity = intensityCurve(beats, span);

  if (span <= MIN_PHASE * 2) {
    // Too short to have movements. One phase, and it is the loud one: a montage
    // this brief is all release by construction.
    return { phases: [{ id: 'drop', from: 0, to: span }], source: 'proportional', intensity, step: STEP };
  }

  const proportional = (): Structure => ({
    phases: tidy(
      [
        { id: 'intro', from: 0, to: span * FALLBACK_INTRO },
        { id: 'build', from: span * FALLBACK_INTRO, to: span * FALLBACK_BUILD },
        { id: 'drop', from: span * FALLBACK_BUILD, to: span },
      ],
      span,
    ),
    source: 'proportional',
    intensity,
    step: STEP,
  });

  const dropAt = sustained(intensity, DROP_LEVEL, DROP_HOLD);
  if (dropAt < 0) return proportional();

  /*
   * The rise is found forwards, from the start, at its own level.
   *
   * Walking *back* from the drop to the last settled sample was the first
   * version, and it is wrong in a way that only shows on real music: the window
   * smears the climb over its own width, so the last sample below any useful
   * level sits two or three seconds before the drop — and the build comes back
   * as a run-up rather than as a movement. Found forwards, it starts where the
   * track stops being an opening, which is where a build actually starts.
   *
   * Clamped below the drop: a track whose rise and release are found at the
   * same instant has no build, and saying so is better than inventing one.
   */
  const floor = floorOf(intensity);
  const found = sustained(intensity, floor + (1 - floor) * BUILD_RISE, BUILD_HOLD);
  const buildAt = found < 0 ? dropAt : Math.min(found, dropAt);

  const phases: Phase[] = [
    { id: 'intro', from: 0, to: clamp(buildAt * STEP, 0, span) },
    { id: 'build', from: clamp(buildAt * STEP, 0, span), to: clamp(dropAt * STEP, 0, span) },
    { id: 'drop', from: clamp(dropAt * STEP, 0, span), to: span },
  ];

  const measured = tidy(phases, span);

  /*
   * A single movement is not an arc, and an arc is what was asked for.
   *
   * It happens on a track that is at full intensity from its first bar — a
   * trimmed loop, a chorus lifted out on its own. Following the music exactly
   * there gives a montage with no shape at all, which is the thing this module
   * exists to prevent, so the conventional proportions are used instead and the
   * result says it was assumed rather than found.
   */
  if (measured.length < 2) return proportional();

  return { phases: measured, source: 'measured', intensity, step: STEP };
}

/**
 * Which movement `time` falls in.
 *
 * Falls back to the release rather than to the opening: a time past the end of
 * the structure is a rounding error at the tail of the montage, and treating
 * the last frames as a calm intro would drop every effect on the final shot.
 */
export function phaseAt(structure: Structure, time: number): PhaseId {
  for (const phase of structure.phases) {
    if (time < phase.to) return phase.id;
  }
  return (structure.phases[structure.phases.length - 1]?.id ?? 'drop') as PhaseId;
}

/** The span each movement covers, for the review step's read-out. */
export const phaseSpans = (structure: Structure): Record<PhaseId, number> => {
  const out: Record<PhaseId, number> = { intro: 0, build: 0, drop: 0 };
  for (const phase of structure.phases) out[phase.id] += Math.max(0, phase.to - phase.from);
  return out;
};
