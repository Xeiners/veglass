/**
 * Smart cut — finding dead air, and removing it without breaking sync.
 *
 * Two sources feed the same pipeline. Silence is **measured**: a loudness
 * envelope, a threshold, a minimum length, and the same file always yields the
 * same cuts. Hesitations are **judged**, by the model, from the audio itself.
 * Keeping them apart matters — a montage tightened by a deterministic pass can
 * be reproduced and explained, and the model is only asked for the part that
 * genuinely needs listening to.
 *
 * The removal itself is the interesting half. [`rippleDelete`] is pure, does the
 * whole timeline at once, and preserves three things a naive implementation
 * loses: source in-points (so the picture does not jump), animation (keyframes
 * are re-timed and cut curves get an interpolated boundary key), and sync
 * across layers (every track shifts by the same amount, whether or not the cut
 * touched it).
 */

import { uid } from '@/lib/id';
import { snapToFrame } from '@/lib/time';
import { generate, AiError } from './client';
import { FILLER_SYSTEM } from './prompts';
import { CUTS_SCHEMA } from './schema';
import { pointerAt } from '@/lib/cursorPainter';
import { markersOf } from '@/types/marker';
import type { CursorLayer, CursorSample } from '@/types/cursor';
import type { Project } from '@/types/project';
import { MIN_CLIP_DURATION, clipEnd, type Clip } from '@/types/timeline';
import {
  evaluateKeyframes,
  sortKeyframes,
  type AnimationMap,
  type Easing,
  type Keyframe,
} from '@/types/animation';
import type { Waveform } from '@/lib/media';
import {
  amplitudeToDb,
  fallbackChain,
  dbToAmplitude,
  type AiSettings,
  type CutInterval,
  type LoudnessEnvelope,
  type SmartCutOptions,
} from '@/types/ai';

const EPSILON = 1e-6;
/** A cut shorter than this is not worth the frame it lands on. */
const MIN_CUT = 0.12;

const seconds = (value: number): string => `${value.toFixed(1).replace('.', ',')} s`;

/* ------------------------------------------------------------------ *
 * Measurement
 * ------------------------------------------------------------------ */

/**
 * The browser host's envelope, from the waveform the media pool already has.
 *
 * Lower resolution than the native pass — the media pool buckets at 120 per
 * second and normalises against the file's own ceiling — so the level is
 * *relative*, not dBFS. `ceiling` carries that fact forward and the threshold
 * suggestion accounts for it.
 */
export function envelopeFromWaveform(waveform: Waveform, duration: number): LoudnessEnvelope {
  const buckets = waveform.rms.length;
  return {
    rms: waveform.rms,
    peak: waveform.peaks,
    bucketsPerSecond: duration > 0 && buckets > 0 ? buckets / duration : 120,
    duration,
    // Normalised on extraction, so full scale by construction.
    ceiling: 1,
  };
}

/**
 * A threshold that suits this particular recording.
 *
 * A fixed -42 dBFS is right for a well-levelled voice-over and wrong for
 * everything else: a quiet phone recording is entirely "silent" under it, a hot
 * master entirely "loud". Anchoring to the material's own speech level — the
 * 90th percentile of its RMS — and dropping a fixed distance below it gives a
 * starting point that is usually close enough to accept as-is.
 */
export function suggestThreshold(envelope: LoudnessEnvelope): number {
  const loud = [...envelope.rms].filter((value) => value > 0).sort((a, b) => a - b);
  if (loud.length === 0) return -42;

  const speech = loud[Math.floor(loud.length * 0.9)] ?? loud[loud.length - 1] ?? 0;
  const suggestion = amplitudeToDb(speech) - 26;
  return Math.round(Math.max(-60, Math.min(-20, suggestion)));
}

/**
 * Silent stretches, in the envelope's own time base.
 *
 * `offset` shifts the result onto the timeline, so a clip analysed from its
 * in-point still reports cuts where the viewer will see them.
 */
export function detectSilences(
  envelope: LoudnessEnvelope,
  options: Pick<SmartCutOptions, 'threshold' | 'minSilence' | 'padding'>,
  offset = 0,
): CutInterval[] {
  const level = dbToAmplitude(options.threshold);
  const step = 1 / Math.max(envelope.bucketsPerSecond, 1);
  const cuts: CutInterval[] = [];

  let runStart: number | null = null;

  const close = (endIndex: number) => {
    if (runStart === null) return;
    const from = runStart * step;
    const to = endIndex * step;
    runStart = null;
    if (to - from < options.minSilence) return;

    // Padding is kept *inside* the silence, never taken from the speech around
    // it: a cut that starts a breath early clips the first consonant.
    const start = from + options.padding;
    const end = to - options.padding;
    if (end - start < MIN_CUT) return;

    cuts.push({
      start: start + offset,
      end: end + offset,
      source: 'silence',
      label: `${seconds(end - start)} de silence`,
    });
  };

  for (let index = 0; index < envelope.rms.length; index += 1) {
    const quiet = (envelope.rms[index] ?? 0) < level;
    if (quiet && runStart === null) runStart = index;
    else if (!quiet) close(index);
  }
  close(envelope.rms.length);

  return cuts;
}

/**
 * Hesitations, false starts and repetitions, from the model.
 *
 * The excerpt is passed in already encoded — the caller has usually just used
 * it for transcription, and sending the same audio twice would double the cost
 * of the pass for nothing.
 */
export async function detectFillers(
  excerpt: { data: string; mimeType: string },
  settings: AiSettings,
  offset: number,
  signal?: AbortSignal,
): Promise<CutInterval[]> {
  const result = await generate(
    settings.transcriptionModel || settings.model,
    {
      systemInstruction: { parts: [{ text: FILLER_SYSTEM }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Repère ce qui devrait être coupé dans cet extrait.' },
            { inlineData: { mimeType: excerpt.mimeType, data: excerpt.data } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: CUTS_SCHEMA,
      },
    },
    { signal, timeoutSecs: 300, fallbacks: fallbackChain(settings) },
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    throw new AiError('format', "La détection d'hésitations n'est pas revenue en JSON exploitable.");
  }

  const entries = (parsed as { cuts?: unknown }).cuts;
  if (!Array.isArray(entries)) return [];

  const out: CutInterval[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { start, end, reason } = entry as Record<string, unknown>;
    if (typeof start !== 'number' || typeof end !== 'number') continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < MIN_CUT) continue;
    out.push({
      start: start + offset,
      end: end + offset,
      source: 'filler',
      label: typeof reason === 'string' && reason.trim() ? `« ${reason.trim()} »` : 'hésitation',
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Interval algebra
 * ------------------------------------------------------------------ */

/**
 * One ordered, non-overlapping set from however many passes produced it.
 *
 * Touching intervals are joined rather than left adjacent, because two cuts a
 * frame apart leave a one-frame island of audio between them — audible as a
 * click, and impossible to see on the timeline.
 */
export function mergeCuts(cuts: CutInterval[], limit = Infinity): CutInterval[] {
  const ordered = cuts
    .map((cut) => ({ ...cut, start: Math.max(0, cut.start), end: Math.min(cut.end, limit) }))
    .filter((cut) => cut.end - cut.start >= MIN_CUT)
    .sort((a, b) => a.start - b.start);

  const out: CutInterval[] = [];
  for (const cut of ordered) {
    const previous = out[out.length - 1];
    if (previous && cut.start <= previous.end + MIN_CUT) {
      if (cut.end > previous.end) {
        previous.end = cut.end;
        // A merged pair is described by what it is now, not by its first half.
        previous.label =
          previous.source === cut.source
            ? `${seconds(previous.end - previous.start)} à retirer`
            : `${seconds(previous.end - previous.start)} — silence et hésitation`;
        if (previous.source !== cut.source) previous.source = 'silence';
      }
      continue;
    }
    out.push({ ...cut });
  }
  return out;
}

export const totalCut = (cuts: CutInterval[]): number =>
  cuts.reduce((sum, cut) => sum + (cut.end - cut.start), 0);

/* ------------------------------------------------------------------ *
 * Ripple delete
 * ------------------------------------------------------------------ */

/** Seconds removed strictly before `time`. */
function shiftAt(cuts: CutInterval[], time: number): number {
  let total = 0;
  for (const cut of cuts) {
    if (cut.start >= time - EPSILON) break;
    total += Math.min(cut.end, time) - cut.start;
  }
  return total;
}

/** The easing governing the segment that contains `time`. */
function easingAt(keyframes: Keyframe[], time: number): Easing {
  for (let index = keyframes.length - 1; index >= 0; index -= 1) {
    const keyframe = keyframes[index] as Keyframe;
    if (keyframe.time <= time + EPSILON) return { ...keyframe.easing };
  }
  return { kind: 'linear' };
}

/**
 * The part of a channel that falls inside `[from, to]`, re-based to zero.
 *
 * Boundary keys are *interpolated*, not dropped: a fade cut in half must still
 * be half-faded at the cut, and simply keeping the keys that survive would snap
 * the property back to whatever the remaining pair says. This is the difference
 * between an animation that survives a smart cut and one that has to be redone.
 */
function sliceChannel(keyframes: Keyframe[], from: number, to: number): Keyframe[] {
  if (keyframes.length === 0) return [];
  const sorted = sortKeyframes(keyframes);
  const fallback = (sorted[0] as Keyframe).value;

  const inside = sorted.filter(
    (keyframe) => keyframe.time >= from - EPSILON && keyframe.time <= to + EPSILON,
  );

  const out: Keyframe[] = inside.map((keyframe) => ({
    ...keyframe,
    id: uid('kf'),
    time: keyframe.time - from,
  }));

  const hasStart = out.some((keyframe) => Math.abs(keyframe.time) < EPSILON);
  if (!hasStart) {
    out.unshift({
      id: uid('kf'),
      time: 0,
      value: evaluateKeyframes(sorted, from, fallback),
      easing: easingAt(sorted, from),
    });
  }

  const span = to - from;
  const hasEnd = out.some((keyframe) => Math.abs(keyframe.time - span) < EPSILON);
  if (!hasEnd) {
    out.push({
      id: uid('kf'),
      time: span,
      value: evaluateKeyframes(sorted, to, fallback),
      easing: easingAt(sorted, to),
    });
  }

  // Two keys holding the same value across the whole piece is a constant, and a
  // constant belongs in the static field rather than in an animation map.
  const first = out[0] as Keyframe;
  if (out.length === 2 && Math.abs((out[1] as Keyframe).value - first.value) < 1e-9) {
    return [];
  }

  return sortKeyframes(out);
}

/**
 * The part of a cursor path that falls inside `[from, to]`, re-based to zero.
 *
 * Same contract as `sliceChannel`, and the same reason for it: a pointer whose
 * path simply lost its samples would jump to wherever the next surviving one
 * happened to be. The boundary positions are interpolated through the painter's
 * own `pointerAt`, so the sliced path starts exactly where the original was at
 * that instant rather than approximately.
 *
 * Clicks are kept, never moved: a ring belongs to the frame the press happened
 * on, and one that survived into a neighbouring take would fire over nothing.
 */
export function sliceCursor(layer: CursorLayer, from: number, to: number): CursorLayer {
  const span = to - from;
  const inside = layer.samples
    .filter((sample) => sample.t >= from - EPSILON && sample.t <= to + EPSILON)
    .map((sample) => ({ ...sample, t: sample.t - from }));

  const edge = (time: number): CursorSample | null => {
    const at = pointerAt(layer.samples, time);
    return at ? { t: time - from, x: at.x, y: at.y } : null;
  };

  const head = inside.some((sample) => Math.abs(sample.t) < EPSILON) ? null : edge(from);
  const tail = inside.some((sample) => Math.abs(sample.t - span) < EPSILON) ? null : edge(to);

  return {
    ...layer,
    samples: [...(head ? [head] : []), ...inside, ...(tail ? [tail] : [])],
    clicks: layer.clicks
      .filter((click) => click.t >= from - EPSILON && click.t <= to + EPSILON)
      .map((click) => ({ ...click, t: click.t - from })),
  };
}

function sliceAnimation(
  animation: AnimationMap | undefined,
  from: number,
  to: number,
): AnimationMap | undefined {
  if (!animation) return undefined;
  const out: AnimationMap = {};
  for (const [channel, keyframes] of Object.entries(animation)) {
    const sliced = sliceChannel(keyframes, from, to);
    if (sliced.length > 0) out[channel] = sliced;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface RippleResult {
  project: Project;
  /** Seconds of timeline actually removed. */
  removed: number;
  /** Clips that were shortened, split, or dropped. */
  touched: number;
  /** Clips that disappeared entirely because they sat inside a cut. */
  dropped: number;
}

/**
 * Removes `cuts` from every track at once and closes the gaps.
 *
 * Cutting only the analysed track and leaving the others in place would slide
 * the montage out of sync by exactly the amount removed, so the shift is global:
 * a clip that no cut touches still moves left by everything removed before it.
 */
export function rippleDelete(project: Project, cuts: CutInterval[]): RippleResult {
  const { fps } = project.settings;
  const duration = project.clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0);
  // Snapping the cuts themselves — rather than each resulting edge — is what
  // keeps every layer landing on the same frame after the shift.
  const ordered = mergeCuts(cuts, duration).map((cut) => ({
    ...cut,
    start: snapToFrame(cut.start, fps),
    end: snapToFrame(cut.end, fps),
  }));

  if (ordered.length === 0) {
    return { project, removed: 0, touched: 0, dropped: 0 };
  }

  const clips: Clip[] = [];
  let touched = 0;
  let dropped = 0;

  for (const clip of project.clips) {
    const start = clip.start;
    const end = clipEnd(clip);

    // The clip's own timeline, minus every cut that overlaps it.
    const pieces: { from: number; to: number }[] = [];
    let cursor = start;
    for (const cut of ordered) {
      if (cut.end <= start + EPSILON) continue;
      if (cut.start >= end - EPSILON) break;
      if (cut.start > cursor + EPSILON) pieces.push({ from: cursor, to: Math.min(cut.start, end) });
      cursor = Math.max(cursor, cut.end);
    }
    if (cursor < end - EPSILON) pieces.push({ from: cursor, to: end });

    const survives = pieces.filter((piece) => piece.to - piece.from >= MIN_CLIP_DURATION);
    const only = survives.length === 1 ? survives[0] : null;
    const untouched =
      only !== null &&
      Math.abs(only.from - start) < EPSILON &&
      Math.abs(only.to - end) < EPSILON;

    if (survives.length === 0) {
      dropped += 1;
      touched += 1;
      continue;
    }
    if (!untouched) touched += 1;

    survives.forEach((piece, index) => {
      const local = piece.from - start;
      const length = snapToFrame(piece.to - piece.from, fps);
      clips.push({
        ...clip,
        // The first surviving piece keeps the clip's identity, so a selection,
        // a transition or an inspector focus survives the operation.
        id: index === 0 ? clip.id : uid('cl'),
        start: snapToFrame(piece.from - shiftAt(ordered, piece.from), fps),
        duration: length,
        offset: clip.offset + local,
        effects:
          index === 0
            ? clip.effects
            : clip.effects.map((effect) => ({ ...effect, id: uid('fx'), params: { ...effect.params } })),
        // A clip no cut reached keeps its curves exactly as they were: slicing
        // an intact channel is a no-op visually, but it would still sprinkle
        // boundary keys through a document nothing happened to.
        animation: untouched
          ? clip.animation
          : sliceAnimation(clip.animation, local, local + length),
        // A pointer's path is a second timeline inside the clip, and it has to
        // contract with it — otherwise the cursor drifts further from its own
        // clicks with every gap removed.
        ...(clip.cursor && !untouched
          ? { cursor: sliceCursor(clip.cursor, local, local + length) }
          : {}),
      });
    });
  }

  // `undefined` is the signal the rest of the editor tests for; an explicit
  // `animation: undefined` key would serialise as `null` and defeat it.
  const cleaned = clips.map((clip) => {
    if (clip.animation) return clip;
    const { animation: _dropped, ...rest } = clip;
    return rest as Clip;
  });

  /*
   * Markers ride the same contraction.
   *
   * They were added to the document three schema versions after this function
   * was written, and a chapter flag left where it was would drift further from
   * the step it names with every gap removed. One that sat *inside* a cut is
   * dropped: the instant it pointed at no longer exists.
   */
  const markers = markersOf(project)
    .filter(
      (marker) =>
        !ordered.some(
          (cut) => marker.time > cut.start + EPSILON && marker.time < cut.end - EPSILON,
        ),
    )
    .map((marker) => ({
      ...marker,
      time: snapToFrame(Math.max(0, marker.time - shiftAt(ordered, marker.time)), fps),
    }));

  return {
    project: {
      ...project,
      clips: cleaned,
      // Written back only on a document that had them: an absent field and an
      // empty array read the same, and one should not become the other.
      ...(project.markers ? { markers } : {}),
    },
    removed: totalCut(ordered),
    touched,
    dropped,
  };
}
