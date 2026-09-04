/**
 * Finding the dead air, from the words we already have.
 *
 * A jump cut needs to know where nobody is speaking. There are two ways to
 * answer that, and this module deliberately takes the cheaper and the better
 * one.
 *
 * The obvious route is `detectSilences` in `lib/ai/silence`: decode the audio,
 * measure its loudness envelope, threshold it. That is the right tool when
 * there is no transcript — it is what the timeline-wide smart cut uses — but it
 * costs an ffmpeg pass, it needs a threshold nobody can pick confidently, and
 * it cannot tell a pause from a breath, a keyboard, or a passing lorry.
 *
 * The viral pass already has something better: a **timed transcript**, paid for
 * during the reading phase. The gaps between its segments are, by construction,
 * the stretches where nothing was said — which is exactly the question. No
 * second decode, no threshold, and a quiet "hmm" that the transcriber did not
 * transcribe is correctly treated as silence rather than as speech that merely
 * happened to be soft.
 *
 * Everything here is a pure function of the segments. That is what lets the
 * whole feature be tested without a file, a decoder or a network.
 */

import type { TranscriptSegment, CutInterval } from '@/types/ai';

export interface JumpCutOptions {
  /** Shortest silence worth removing, in seconds. */
  minGap: number;
  /**
   * Breath left on each side of a removed gap, in seconds.
   *
   * Cutting a pause to nothing is what makes automatic jump cuts sound
   * mechanical: speech has a tail, and clipping it flush turns every sentence
   * into a hard stop. A tenth of a second either side keeps the rhythm nervous
   * without making it breathless.
   */
  padding: number;
}

export type Pace = 'natural' | 'tight' | 'ruthless';

export interface PaceOption {
  id: Pace;
  label: string;
  hint: string;
  options: JumpCutOptions;
}

export const PACE_OPTIONS: PaceOption[] = [
  {
    id: 'natural',
    label: 'Naturel',
    hint: 'Ne coupe que les vrais blancs — on n’entend rien',
    options: { minGap: 0.7, padding: 0.14 },
  },
  {
    id: 'tight',
    label: 'Serré',
    hint: 'Le réglage de référence — supprime les hésitations',
    options: { minGap: 0.4, padding: 0.1 },
  },
  {
    id: 'ruthless',
    label: 'Nerveux',
    hint: 'Rythme de format court, chaque respiration y passe',
    options: { minGap: 0.25, padding: 0.06 },
  },
];

export const paceOf = (id: Pace): PaceOption =>
  PACE_OPTIONS.find((option) => option.id === id) ?? (PACE_OPTIONS[1] as PaceOption);

/** Below this a cut is a frame or two — invisible, and not worth a splice. */
const MIN_USEFUL = 0.12;

/**
 * The silences inside `[from, to]`, in the same clock the segments use.
 *
 * The head and the tail count: a clip that opens on a second of nobody talking
 * has wasted the only second that decides whether anyone keeps watching, and
 * one that ends on silence simply runs long.
 *
 * Padding shrinks each gap from both ends, so what is removed is the *middle*
 * of the silence and the speech either side keeps its tail. A gap that padding
 * shrinks below the useful floor is left alone rather than nibbled.
 */
export function silentGaps(
  segments: TranscriptSegment[],
  from: number,
  to: number,
  options: JumpCutOptions,
): CutInterval[] {
  if (!(to > from)) return [];

  const spoken = segments
    .map((segment) => ({
      start: Math.max(from, Math.min(segment.start, to)),
      end: Math.max(from, Math.min(segment.end, to)),
    }))
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start);

  // Overlapping lines are one stretch of speech, not two: a gap measured
  // between them would be negative, and a negative gap is not a silence.
  const merged: { start: number; end: number }[] = [];
  for (const segment of spoken) {
    const last = merged[merged.length - 1];
    if (last && segment.start <= last.end) last.end = Math.max(last.end, segment.end);
    else merged.push({ ...segment });
  }

  const gaps: { start: number; end: number }[] = [];
  let cursor = from;
  for (const segment of merged) {
    if (segment.start > cursor) gaps.push({ start: cursor, end: segment.start });
    cursor = Math.max(cursor, segment.end);
  }
  if (cursor < to) gaps.push({ start: cursor, end: to });

  const padding = Math.max(0, options.padding);
  const minimum = Math.max(MIN_USEFUL, options.minGap);

  return gaps
    .filter((gap) => gap.end - gap.start >= minimum)
    .map((gap) => ({ start: gap.start + padding, end: gap.end - padding }))
    .filter((gap) => gap.end - gap.start >= MIN_USEFUL)
    .map((gap) => ({
      ...gap,
      // `silence` rather than `filler`: this came from where words were absent,
      // not from a model deciding a word was worthless.
      source: 'silence' as const,
      label: `${(gap.end - gap.start).toFixed(1).replace('.', ',')} s sans parole`,
    }));
}

/** Seconds `silentGaps` would remove — for saying so before it happens. */
export const gapTotal = (gaps: CutInterval[]): number =>
  gaps.reduce((total, gap) => total + Math.max(0, gap.end - gap.start), 0);

/**
 * The same gaps, moved onto the timeline.
 *
 * Source time to timeline time for a cut laid at `at` from source `origin` —
 * the same shift `toTimeline` applies to the captions, and it has to be, or the
 * subtitles would be cut on different frames from the picture they belong to.
 */
export const onTimeline = (gaps: CutInterval[], origin: number, at: number): CutInterval[] =>
  gaps.map((gap) => ({ ...gap, start: at + (gap.start - origin), end: at + (gap.end - origin) }));
