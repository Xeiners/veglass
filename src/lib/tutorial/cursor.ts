/**
 * Building a pointer out of what the analysis saw.
 *
 * The model reports where each action happened and when. That is a list of
 * destinations, not a path — so this is where it becomes one: the pointer waits
 * on the last thing it touched, sets off shortly before the next action, and
 * arrives exactly on the instant of the click.
 *
 * # Arriving, not chasing
 *
 * Every timing here is arranged so the pointer is *already there* when the
 * action lands. A cursor that reaches a button at the same moment its ring
 * fires looks like a recording; one that is still travelling when the ring
 * fires looks like a bug. Which is the same reasoning as the virtual camera's
 * `lead`, and for the same reason: the viewer's eye needs to arrive before the
 * thing it came to see.
 *
 * Pure, like every generator in this suite. The caller commits the result
 * inside the one `transact` that places the whole tutorial.
 */

import { uid } from '@/lib/id';
import { clamp } from '@/lib/time';
import {
  CURSOR_TRACK_NAME,
  cursorLayer,
  isVisible,
  type CursorClick,
  type CursorLayer,
  type CursorSample,
} from '@/types/cursor';
import type { ScreenPoint } from '@/types/geometry';
import type { Project } from '@/types/project';
import { DEFAULT_TRACK_HEIGHT, type Clip, type Track } from '@/types/timeline';
import { isPointed, type TutorialStep } from '@/types/tutorial';

/** Longest the pointer spends travelling to its next target, in seconds. */
const TRAVEL = 0.75;
/** Shortest — below this a move is a jump, and a jump is what we are avoiding. */
const MIN_TRAVEL = 0.16;
/** Intermediate samples per transit, so the spline has a curve to fit. */
const STEPS = 8;

/**
 * Which actions throw a ring.
 *
 * A scroll is a gesture rather than a press, and a `read` step is the narrator
 * pointing something out with nothing happening on screen. Firing a spotlight
 * on either would teach the viewer to ignore the spotlight.
 */
export const clicks = (step: TutorialStep): boolean =>
  step.enabled && step.point !== null && isPointed(step.action) && step.action !== 'scroll';

/**
 * The path, in clip time.
 *
 * Steps with no point of interest are skipped rather than guessed at: the
 * pointer holding still through a `read` step is exactly right, because nothing
 * is being pointed at.
 */
export function pathFromSteps(steps: TutorialStep[], offset: number): CursorSample[] {
  const targets = steps
    .filter((step) => step.enabled && step.point !== null)
    .map((step) => ({ t: step.at - offset, point: step.point as ScreenPoint }))
    .sort((a, b) => a.t - b.t);

  if (targets.length === 0) return [];

  const first = targets[0] as { t: number; point: ScreenPoint };

  // Where the pointer waits before the first action.
  //
  // Below its first target rather than on it: starting *on* the button would
  // mean the opening move of the tutorial — the one that establishes there is a
  // cursor at all — never happens. Half height keeps the approach short.
  const samples: CursorSample[] = [];
  let from: ScreenPoint = { x: clamp(first.point.x, 0, 1), y: 0.5 };
  let previous = Math.max(0, first.t - TRAVEL * 2);
  samples.push({ t: previous, x: from.x, y: from.y });

  for (const target of targets) {
    const gap = Math.max(0, target.t - previous);
    const travel = clamp(Math.min(TRAVEL, gap * 0.6), MIN_TRAVEL, TRAVEL);
    const start = Math.max(previous, target.t - travel);

    // Hold still until it is time to set off. Skipped when there is no wait to
    // hold — two actions in quick succession are one continuous move.
    if (start > previous + 1e-3) samples.push({ t: start, x: from.x, y: from.y });

    for (let index = 1; index <= STEPS; index += 1) {
      const ratio = index / STEPS;
      samples.push({
        t: start + (target.t - start) * ratio,
        x: from.x + (target.point.x - from.x) * ratio,
        y: from.y + (target.point.y - from.y) * ratio,
      });
    }

    from = target.point;
    previous = target.t;
  }

  // Two samples on the same instant are one sample; the later wins, because it
  // is the one that arrived.
  const out: CursorSample[] = [];
  for (const sample of samples.sort((a, b) => a.t - b.t)) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - sample.t) < 1e-4) out[out.length - 1] = sample;
    else out.push(sample);
  }
  return out;
}

/** One ring per press, at the instant the action lands. */
export const clicksFromSteps = (steps: TutorialStep[], offset: number): CursorClick[] =>
  steps
    .filter(clicks)
    .map((step) => ({
      t: step.at - offset,
      button: 'left' as const,
      at: step.point as ScreenPoint,
    }))
    .sort((a, b) => a.t - b.t);

/**
 * The whole layer, or `null` when there would be nothing to draw.
 *
 * `aspect` comes from the recording rather than from the project: the samples
 * are source coordinates, and the pointer only lands where the picture is if
 * both agree on the rectangle those coordinates describe.
 */
export function cursorFromSteps(
  steps: TutorialStep[],
  offset: number,
  aspect: number,
  style: Parameters<typeof cursorLayer>[3] = {},
): CursorLayer | null {
  const layer = cursorLayer(aspect, pathFromSteps(steps, offset), clicksFromSteps(steps, offset), style);
  return isVisible(layer) ? layer : null;
}

/* ------------------------------------------------------------------ *
 * Placement
 * ------------------------------------------------------------------ */

export interface CursorPlacement {
  project: Project;
  clip: Clip;
}

/**
 * Lays the pointer over the recording it belongs to.
 *
 * The clip is a **copy of the screen clip's geometry** — same start, same
 * duration, same `scale`, `x`, `y` and, crucially, the same animation map. That
 * is the whole trick: the virtual camera's curve carries the cursor with it, so
 * a pointer sampled at a point on the source is still on that point after the
 * camera has pushed in on it. Nothing has to be re-derived, and the two can
 * never fall out of step because they are driven by one curve.
 */
export function placeCursor(project: Project, screen: Clip, layer: CursorLayer): CursorPlacement {
  const existing = project.tracks.find(
    (track) => track.kind === 'video' && track.name === CURSOR_TRACK_NAME,
  );
  const created: Track | null = existing
    ? null
    : {
        id: uid('tr'),
        kind: 'video',
        name: CURSOR_TRACK_NAME,
        height: DEFAULT_TRACK_HEIGHT,
        muted: false,
        solo: false,
        locked: false,
        hidden: false,
      };

  const clip: Clip = {
    id: uid('cl'),
    kind: 'cursor',
    assetId: null,
    trackId: existing?.id ?? (created as Track).id,
    start: screen.start,
    duration: screen.duration,
    // Zero, not the recording's in-point: the path is already in clip time, and
    // an offset would shift it against the picture it is drawn over.
    offset: 0,
    volume: 1,
    opacity: 1,
    scale: screen.scale,
    x: screen.x,
    y: screen.y,
    rotation: screen.rotation,
    muted: true,
    label: 'Curseur',
    effects: [],
    cursor: layer,
    ...(screen.animation ? { animation: cloneCurves(screen.animation) } : {}),
  };

  return {
    project: {
      ...project,
      tracks: created ? [created, ...project.tracks] : project.tracks,
      clips: [...project.clips, clip],
    },
    clip,
  };
}

/**
 * A deep copy of the camera's curves, with fresh keyframe ids.
 *
 * Sharing them would be sharing objects between two clips: editing one
 * keyframe would silently move the other layer, and an id that appears twice in
 * a document breaks every lookup that assumes it does not.
 */
function cloneCurves(animation: NonNullable<Clip['animation']>): NonNullable<Clip['animation']> {
  const out: NonNullable<Clip['animation']> = {};
  for (const [channel, keys] of Object.entries(animation)) {
    out[channel] = keys.map((key) => ({ ...key, id: uid('kf'), easing: { ...key.easing } }));
  }
  return out;
}
