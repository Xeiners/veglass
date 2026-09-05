/**
 * Turning a transient curve into beats.
 *
 * The measurement happens in Rust (`ai::audio::onsets`): ffmpeg decodes the
 * track to PCM, three envelope followers ride three bands, and what comes back
 * is how sharply each band rose in each five-millisecond frame. Everything in
 * this file is arithmetic over that curve — no I/O, no clock, no randomness.
 *
 * The split is the same one silence detection makes, and for the same two
 * reasons. It is **cheap to redo**: the sensitivity slider re-picks the beats
 * from a curve already in memory, so the wizard answers a drag in a frame
 * instead of decoding the track again. And it is **testable**: a peak picker
 * that has to spawn ffmpeg to be exercised is a peak picker nobody exercises.
 *
 * # What "a beat" is here
 *
 * Not a metrical pulse — an *onset*: a moment where something struck. A montage
 * cuts on strikes, and the strike is what the picture has to land on, whether
 * or not it falls on the one. The tempo estimate below is a description of what
 * was found, never an input to it: quantising the cuts to an inferred grid
 * would move every one of them off the sound that justified it.
 */

import { clamp } from '@/lib/time';

/** The measurement, exactly as `ai::audio::onsets` serialises it. */
export interface OnsetCurve {
  /** Onset strength per frame, low band — the kick. */
  low: number[];
  /** Mid band: voices and sustained instruments. */
  mid: number[];
  /** High band — snare, hats, anything with a crack to it. */
  high: number[];
  framesPerSecond: number;
  duration: number;
  /** Strongest onset anywhere in the three bands. */
  peak: number;
}

/** What struck, as far as the band split can tell. */
export type BeatBand = 'kick' | 'snare' | 'body';

export interface Beat {
  /** Seconds from the start of the track. */
  at: number;
  /** 0 → 1, against the loudest onset in this track rather than an absolute. */
  strength: number;
  band: BeatBand;
}

/* ------------------------------------------------------------------ *
 * The detection function
 * ------------------------------------------------------------------ */

/**
 * How much each band counts towards "something struck".
 *
 * The kick leads because it is the beat a montage is cut against, and because
 * the low band is the one least polluted by anything else. The mid band is
 * discounted hard rather than dropped: a vocal entry or a guitar stab is a real
 * event, but sustained material rises and falls constantly without a strike
 * behind it, and weighting it evenly fills a ballad with beats that are not
 * there.
 */
const BAND_WEIGHTS = { low: 1.6, mid: 0.5, high: 1 } as const;

/** Half-width of the "is this the local maximum" window, in seconds. */
const PEAK_WINDOW = 0.03;

/**
 * Half-width of the adaptive baseline, in seconds.
 *
 * Long enough to span a bar at any usable tempo, so the baseline describes the
 * passage rather than the beat sitting in the middle of it. This is what lets
 * one sensitivity work across a quiet intro and the chorus after it.
 */
const BASELINE_WINDOW = 0.4;

/** How far over the local baseline a peak has to stand. */
const BASELINE_RATIO = 1.4;

/**
 * The margin the sensitivity dial moves, in normalised curve units.
 *
 * At 0 only the plainest strikes survive; at 1 nearly every ripple does. The
 * ends are deliberately not 0 and 1 — a slider that can be dragged to "no beats
 * at all" or "every frame is a beat" has two settings that are never the answer.
 */
const DELTA_STRICT = 0.17;
const DELTA_LOOSE = 0.02;

/**
 * Absolute floor, whatever the sensitivity.
 *
 * The baseline test is relative, so a passage of near-silence has a near-zero
 * baseline and the faintest room tone clears it. This is the backstop that
 * keeps an intro's noise floor from coming back as a drum fill.
 */
const SILENCE_FLOOR = 0.05;

/**
 * Shortest gap between two beats, in seconds.
 *
 * Around a sixteenth note at 240 BPM, and comfortably longer than the smear of
 * a single drum hit across the envelope. Two peaks closer than this are one
 * strike seen twice, and the louder of them is the one that is real.
 */
const MIN_GAP = 0.07;

/** How decisively one band must lead for the beat to be named after it. */
const BAND_MARGIN = 1.25;

const mean = (values: number[], from: number, to: number): number => {
  const start = Math.max(0, from);
  const end = Math.min(values.length, to);
  if (end <= start) return 0;
  let total = 0;
  for (let index = start; index < end; index += 1) total += values[index] ?? 0;
  return total / (end - start);
};

/**
 * The three bands folded into one curve, normalised against its own maximum.
 *
 * Normalising is what makes every threshold in this file a dimensionless
 * number: the curve is measured in log-energy rise, which has no natural scale,
 * and comparing it against a constant would mean one sensitivity for a
 * compressed master and another for a dynamic one.
 *
 * Exported because the wizard draws it — a strip showing where the beats were
 * found, and how much was left on the table, is the only honest way to explain
 * what the sensitivity dial just did.
 */
export function detectionCurve(curve: OnsetCurve): number[] {
  const frames = Math.min(curve.low.length, curve.mid.length, curve.high.length);
  const out: number[] = new Array(frames);

  let ceiling = 0;
  for (let index = 0; index < frames; index += 1) {
    const value =
      BAND_WEIGHTS.low * (curve.low[index] ?? 0) +
      BAND_WEIGHTS.mid * (curve.mid[index] ?? 0) +
      BAND_WEIGHTS.high * (curve.high[index] ?? 0);
    out[index] = value;
    if (value > ceiling) ceiling = value;
  }

  // A track that never rises — digital silence, or a decode that produced
  // nothing — has no scale to normalise against, and is flat by definition.
  if (ceiling <= 0) return out.fill(0);
  for (let index = 0; index < frames; index += 1) out[index] = (out[index] ?? 0) / ceiling;
  return out;
}

/* ------------------------------------------------------------------ *
 * Peak picking
 * ------------------------------------------------------------------ */

/**
 * The beats in `curve`, at the given sensitivity.
 *
 * Three tests, all of which a frame must pass, and each catching something the
 * others do not:
 *
 * 1. It is the largest value in a short window around itself. Without this the
 *    rising flank of one strike reports a beat on every frame of the way up.
 * 2. It stands clear of the local baseline *and* of the absolute floor. The
 *    first adapts to the passage, the second stops a quiet one from being
 *    scored against its own noise.
 * 3. It is far enough from the previous accepted beat. The smear of a single
 *    hit across the envelope can clear the first two tests twice.
 */
export function detectBeats(curve: OnsetCurve, sensitivity: number): Beat[] {
  const detection = detectionCurve(curve);
  const rate = curve.framesPerSecond > 0 ? curve.framesPerSecond : 200;

  const peakSpan = Math.max(1, Math.round(PEAK_WINDOW * rate));
  const baselineSpan = Math.max(peakSpan + 1, Math.round(BASELINE_WINDOW * rate));
  const delta = DELTA_STRICT + (DELTA_LOOSE - DELTA_STRICT) * clamp(sensitivity, 0, 1);
  const gap = MIN_GAP * rate;

  const beats: Beat[] = [];
  let previousFrame = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < detection.length; index += 1) {
    const value = detection[index] ?? 0;
    if (value < SILENCE_FLOOR) continue;

    const baseline = mean(detection, index - baselineSpan, index + baselineSpan);
    if (value < baseline * BASELINE_RATIO + delta) continue;

    let dominant = true;
    for (let probe = index - peakSpan; probe <= index + peakSpan; probe += 1) {
      if (probe === index || probe < 0 || probe >= detection.length) continue;
      // Strictly greater, so a plateau reports its first frame rather than
      // reporting nothing at all — the attack is the front edge of the plateau.
      if ((detection[probe] ?? 0) > value) {
        dominant = false;
        break;
      }
    }
    if (!dominant) continue;

    if (index - previousFrame < gap) {
      // The louder of two hits this close together is the real one. Replacing
      // rather than skipping matters on a curve that ramps: the first frame
      // over the threshold is rarely the peak of the strike.
      const last = beats[beats.length - 1];
      if (last && value > last.strength) {
        beats[beats.length - 1] = { ...bandOf(curve, index), at: index / rate, strength: value };
        previousFrame = index;
      }
      continue;
    }

    beats.push({ ...bandOf(curve, index), at: index / rate, strength: value });
    previousFrame = index;
  }

  return beats;
}

/** Which band a frame belongs to, once the weights are taken into account. */
function bandOf(curve: OnsetCurve, index: number): { band: BeatBand } {
  const low = BAND_WEIGHTS.low * (curve.low[index] ?? 0);
  const high = BAND_WEIGHTS.high * (curve.high[index] ?? 0);

  if (low > high * BAND_MARGIN) return { band: 'kick' };
  if (high > low * BAND_MARGIN) return { band: 'snare' };
  return { band: 'body' };
}

/* ------------------------------------------------------------------ *
 * Describing what was found
 * ------------------------------------------------------------------ */

/** The range a tempo is actually written in, in beats per minute. */
const MIN_BPM = 60;
const MAX_BPM = 180;
/** Gaps outside this are a subdivision too fine, or a phrase rather than a beat. */
const MIN_GAP_SECONDS = 0.1;
const MAX_GAP_SECONDS = 2;
/** Below this many usable gaps, a median is a coincidence rather than a tempo. */
const MIN_INTERVALS = 8;

/**
 * The track's tempo, or `null` when the beats do not describe one.
 *
 * The median of the gaps, not the mean: a run of onsets contains plenty of gaps
 * that are two beats long or half of one, and an average is dragged around by
 * them where a median is not.
 *
 * Then folded into the range a tempo is written in. Onsets are not the pulse —
 * they include every subdivision, every eighth and every fill — so the median
 * gap is very often half or a quarter of the beat, and reporting "240 BPM" for
 * a track that everyone involved would call 120 is a wrong answer told
 * precisely. Halving until it lands in range is what a musician does reading
 * the same number.
 *
 * Reported to the user and to nothing else. It is a sanity check — "148 BPM,
 * 312 temps" says at a glance whether the analysis heard the track or heard the
 * noise floor — and it never feeds back into where the cuts land.
 */
export function estimateTempo(beats: Beat[]): number | null {
  const gaps: number[] = [];
  for (let index = 1; index < beats.length; index += 1) {
    const gap = (beats[index]?.at ?? 0) - (beats[index - 1]?.at ?? 0);
    if (gap >= MIN_GAP_SECONDS && gap <= MAX_GAP_SECONDS) gaps.push(gap);
  }
  if (gaps.length < MIN_INTERVALS) return null;

  gaps.sort((a, b) => a - b);
  const middle = gaps[Math.floor(gaps.length / 2)] ?? 0;
  if (!(middle > 0)) return null;

  let bpm = 60 / middle;
  // Both loops terminate: `bpm` is finite and positive, and the two bounds are
  // more than an octave apart, so no value can bounce between them.
  while (bpm > MAX_BPM) bpm /= 2;
  while (bpm < MIN_BPM) bpm *= 2;
  return Math.round(bpm);
}

/** Beats at or above `strength`, for the counts the review step shows. */
export const beatsAbove = (beats: Beat[], strength: number): Beat[] =>
  beats.filter((beat) => beat.strength >= strength);
