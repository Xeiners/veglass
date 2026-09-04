/**
 * The virtual camera.
 *
 * A screen recording is a wide, static, mostly-empty picture with one small
 * region that matters at any given second. This turns a list of steps into a
 * camera that goes and looks at each of them: it pushes in before the action so
 * it is *settled* when the click lands, holds while it happens, then pulls back
 * — or, when the next step is close enough, glides straight across without
 * bothering to return to a wide shot nobody would see.
 *
 * # Why this needs no new field on `Clip`
 *
 * The same trick as `lib/viral/frame`, and it is worth restating because it is
 * the reason this module is a hundred lines rather than a rendering project.
 * Both renderers already agree that `scale = 1` means the source *contained* in
 * the frame — the preview via `object-contain` plus a transform, the export via
 * `force_original_aspect_ratio=decrease` then `scale=iw*s`. A camera move is
 * therefore nothing but `scale`, `x` and `y` over time, and the document has
 * carried those since version 3 and animated them since version 4.
 *
 * # Why it is one animation and not one per step
 *
 * A keyframed channel *replaces* the static field — the rule at the top of
 * `lib/ai/plan.ts`. So the camera cannot be assembled from per-step fragments
 * that each assume a rest position; it is a single continuous curve per
 * channel, built once, covering the whole clip. That is also what makes the
 * "glide from one button to the next" case expressible at all: it is simply two
 * stops with no rest between them.
 *
 * Everything here is pure. The caller commits the result inside one `transact`.
 */

import { uid } from '@/lib/id';
import { clamp, snapToFrame } from '@/lib/time';
import {
  CENTRE,
  REST,
  cameraOn,
  coverFactor,
  fittedSize,
  isRest,
  type Camera,
  type Fit,
  type ScreenPoint,
} from '@/lib/geometry';
import type { AnimationMap, Easing, Keyframe } from '@/types/animation';
import type { MediaAsset } from '@/types/media';
import type { ProjectSettings } from '@/types/project';
import type { Clip } from '@/types/timeline';
import { ZOOM_CONFIDENCE_FLOOR, zoomable, type TutorialStep, type ZoomProfile } from '@/types/tutorial';

export { REST, cameraOn, fittedSize, type Camera, type Fit };

/* ------------------------------------------------------------------ *
 * Curves
 * ------------------------------------------------------------------ */

/*
 * These are three of the Penner curves already in `EASING_PRESETS`, spelled out
 * by their handles rather than looked up by id so the values are visible at the
 * point they are chosen. `matchPreset` recognises all three, so a keyframe
 * generated here lights up the right chip in the easing editor and can be
 * edited by hand like any other.
 */

/** `cubic-in-out` — a decisive move that still starts and stops softly. */
const PUSH: Easing = { kind: 'bezier', bezier: [0.65, 0, 0.35, 1] };

/** `sine-in-out` — the gentlest of the pair, for sliding between two points. */
const GLIDE: Easing = { kind: 'bezier', bezier: [0.37, 0, 0.63, 1] };

/** `quad-in-out` — the pull-back, softer than the push that earned it. */
const RELEASE: Easing = { kind: 'bezier', bezier: [0.45, 0, 0.55, 1] };

/** Between two identical values, so the shape of the curve is irrelevant. */
const HOLD: Easing = { kind: 'linear' };

/**
 * The shortest stretch worth holding still for.
 *
 * Below this, a "hold" is two keyframes a few frames apart, which reads as a
 * stutter rather than a pause — and pulling all the way back out for a fifth of
 * a second before pushing in again is the exact motion this constant exists to
 * prevent.
 */
const MIN_HOLD = 0.35;

/**
 * Shortest a shot may dwell and still be a shot.
 *
 * Below this the camera arrives and immediately reverses, which is a kink
 * rather than a move. The step keeps its narration, its marker and its banner —
 * only the camera declines to take part.
 */
const MIN_DWELL = 0.25;

/* ------------------------------------------------------------------ *
 * Smoothing
 * ------------------------------------------------------------------ */

/**
 * How hard the trajectory is smoothed.
 *
 * Every one of these trades precision for calm, and the trade has a wrong end:
 * a tutorial camera exists to look at the button the narrator is talking about,
 * and a camera smoothed until it looks *near* the button is worse than one that
 * jerks. So the defaults are timid, and `maxDrift` is a hard ceiling no amount
 * of `anchor` can push through.
 */
export interface Smoothing {
  /**
   * How far each shot is pulled toward its neighbours, 0 → 1.
   *
   * The exponential smoothing of the brief. It fixes the case that genuinely
   * looks bad: three steps whose points jump left, right, left across the
   * screen, which reads as the camera panicking.
   */
  anchor: number;
  /** Ceiling on that pull, as a fraction of the frame. Precision wins here. */
  maxDrift: number;
  /**
   * Catmull-Rom samples inserted along each glide. 0 leaves glides straight.
   *
   * A straight glide from one point of interest to the next changes direction
   * abruptly at both ends. Sampling a spline through the *surrounding* shots
   * lets the move leave and arrive along the path it is already on.
   */
  curve: number;
  /**
   * Below this distance in camera space, two shots are the same shot.
   *
   * The dead zone. Two steps on adjacent fields of one form produce two almost
   * identical framings, and moving between them is a twitch with no information
   * in it.
   */
  deadZone: number;
}

export const DEFAULT_SMOOTHING: Smoothing = {
  anchor: 0.3,
  maxDrift: 0.06,
  curve: 5,
  deadZone: 0.05,
};

/** Smoothing off entirely — the baseline the tests compare against. */
export const NO_SMOOTHING: Smoothing = { anchor: 0, maxDrift: 0, curve: 0, deadZone: 0 };

/**
 * Distance between two framings, in units of the frame.
 *
 * Position and zoom folded into one number, so the dead zone is a single
 * threshold. Scale is compared as a *ratio* rather than a difference: 1.4 → 1.5
 * and 3.4 → 3.5 are not the same move, and only the ratio says so.
 */
export function cameraDistance(a: Camera, b: Camera, settings: ProjectSettings): number {
  const dx = (a.x - b.x) / Math.max(1, settings.width);
  const dy = (a.y - b.y) / Math.max(1, settings.height);
  const ds = Math.log(Math.max(0.01, a.scale) / Math.max(0.01, b.scale));
  return Math.hypot(dx, dy, ds);
}

/**
 * The point most of the action is at, robust to a stray corner click.
 *
 * A median rather than a mean, per axis. One step whose point landed in a far
 * corner — a mis-read, or a genuine outlier like closing a window — would drag
 * a mean across the screen and take the whole resting shot with it. The median
 * ignores it, which is the entire reason to prefer one here.
 */
export function focusPoint(points: ScreenPoint[]): ScreenPoint {
  if (points.length === 0) return CENTRE;

  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  };

  return { x: median(points.map((point) => point.x)), y: median(points.map((point) => point.y)) };
}

/**
 * Where the camera rests, given what the recording is about.
 *
 * The Smart Pan. When the project's frame matches the source, resting means the
 * wide shot and there is nothing to decide. When it does not — a 16:9 screen
 * recording in a 9:16 project — *containing* the source would letterbox it into
 * a strip with bars above and below, which is not a tutorial anyone would
 * publish. So the resting shot covers the frame instead, and the sides that
 * have to go are chosen by where the action actually is rather than by taking
 * the middle and hoping.
 */
export function restingCamera(
  steps: TutorialStep[],
  asset: Pick<MediaAsset, 'width' | 'height'>,
  settings: ProjectSettings,
): Camera {
  const fit = fittedSize(asset, settings);
  if (!fit) return REST;

  const cover = coverFactor(asset, settings);
  // Within a rounding error of the same shape: contained already covers.
  if (cover <= 1.001) return REST;

  const points = steps
    .filter(
      (step) => step.enabled && step.point !== null && step.confidence >= ZOOM_CONFIDENCE_FLOOR,
    )
    .map((step) => step.point as ScreenPoint);

  return cameraOn(focusPoint(points), cover, fit, settings);
}

/**
 * Pulls each shot a little toward its neighbours.
 *
 * One pass of a symmetric exponential filter over the framings — in camera
 * space rather than in source coordinates, because what matters is where the
 * *frame* ends up, and two source points far apart can clamp to the same
 * framing.
 *
 * The result is then pulled back to within `maxDrift` of the true target. That
 * clamp is the whole safety of this pass: without it a run of scattered steps
 * would smooth into a camera pointing at the average of several buttons, which
 * is to say at none of them.
 */
export function smoothShots(
  shots: Shot[],
  settings: ProjectSettings,
  smoothing: Smoothing,
): Shot[] {
  if (smoothing.anchor <= 0 || shots.length < 3) return shots;

  const strength = clamp(smoothing.anchor, 0, 1) / 2;
  const drift = Math.max(0, smoothing.maxDrift);

  return shots.map((shot, index) => {
    const before = shots[index - 1];
    const after = shots[index + 1];
    // The ends have only one neighbour, so there is no symmetric pull to apply
    // — and the first and last framings are the ones a viewer reads longest.
    if (!before || !after) return shot;

    const blend = (pick: (camera: Camera) => number): number =>
      pick(shot.camera) * (1 - 2 * strength) +
      (pick(before.camera) + pick(after.camera)) * strength;

    let moved: Camera = {
      scale: blend((camera) => camera.scale),
      x: blend((camera) => camera.x),
      y: blend((camera) => camera.y),
    };

    const distance = cameraDistance(moved, shot.camera, settings);
    if (distance > drift && distance > 0) {
      const keep = drift / distance;
      moved = {
        scale: shot.camera.scale + (moved.scale - shot.camera.scale) * keep,
        x: shot.camera.x + (moved.x - shot.camera.x) * keep,
        y: shot.camera.y + (moved.y - shot.camera.y) * keep,
      };
    }

    return { ...shot, camera: moved };
  });
}

/**
 * Collapses consecutive shots that are looking at the same thing.
 *
 * Only when they are also close in time: two steps on the same button a minute
 * apart are two visits, and the camera should come home in between. Inside the
 * reframe window they are one shot that simply lasts longer, which removes the
 * twitch of leaving a framing and arriving back at it.
 */
export function mergeShots(
  shots: Shot[],
  settings: ProjectSettings,
  profile: ZoomProfile,
  smoothing: Smoothing,
): Shot[] {
  if (smoothing.deadZone <= 0 || shots.length < 2) return shots;

  const out: Shot[] = [];
  for (const shot of shots) {
    const last = out[out.length - 1];
    const close = last ? shot.enter - last.leave <= profile.reframeGap : false;

    if (last && close && cameraDistance(last.camera, shot.camera, settings) <= smoothing.deadZone) {
      // The earlier framing wins: it is the one the viewer has settled into,
      // and re-aiming at a target a hair away would be the twitch itself.
      out[out.length - 1] = { ...last, leave: Math.max(last.leave, shot.leave) };
      continue;
    }
    out.push(shot);
  }

  return out;
}

/**
 * One coordinate of a uniform Catmull-Rom spline through four control points.
 *
 * The curve passes exactly through `b` and `c`; `a` and `d` only set the
 * tangents. That property is what makes it usable here — a shot's framing is
 * never approximated, only the transit between two of them is bent.
 */
export function catmullRom(a: number, b: number, c: number, d: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
  );
}

/* ------------------------------------------------------------------ *
 * Shots
 * ------------------------------------------------------------------ */

/** One visit: when the camera leaves, when it has arrived, when it lets go. */
export interface Shot {
  stepId: string;
  /** Clip-relative seconds. The camera starts moving here. */
  enter: number;
  /** Settled and still, before the action happens. */
  settle: number;
  /** Holds until here, then releases or glides on. */
  leave: number;
  camera: Camera;
}

/**
 * Turns steps into shots, in clip time.
 *
 * Three things get dropped here rather than downstream, because a bad shot is
 * worse than no shot:
 *
 * * a step the profile or the model's own confidence rules out (see `zoomable`);
 * * a step whose action falls outside the clip — trimmed away, or past its end;
 * * a step that collides with the one before it. Two actions half a second
 *   apart cannot each get their own push and release, and forcing it gives a
 *   camera that lurches. The later one keeps its narration and its marker and
 *   simply does not move the camera.
 */
export function planShots(
  steps: TutorialStep[],
  clip: Pick<Clip, 'offset' | 'duration'>,
  asset: Pick<MediaAsset, 'width' | 'height'>,
  settings: ProjectSettings,
  profile: ZoomProfile,
  smoothing: Smoothing = DEFAULT_SMOOTHING,
  /** The framing to zoom *from*. See `restingCamera` for why it is not always REST. */
  rest: Camera = restingCamera(steps, asset, settings),
): Shot[] {
  const fit = fittedSize(asset, settings);
  if (!fit || profile.factor <= 1) return [];

  const ordered = [...steps].sort((a, b) => a.at - b.at);
  const raw: Shot[] = [];

  for (const step of ordered) {
    if (!zoomable(step, profile)) continue;

    // Source time to clip time. The two differ the moment the recording is
    // trimmed, and a camera that ignores the in-point looks at the wrong second.
    const settle = step.at - clip.offset;
    if (settle <= 0 || settle >= clip.duration) continue;

    const previous = raw[raw.length - 1];
    const floor = previous ? previous.leave : 0;
    if (settle <= floor) continue;

    const enter = Math.max(floor, settle - profile.lead);
    // A push with no room to happen is a cut, which is not what was asked for.
    if (settle - enter < 0.08) continue;

    const dwell = Math.max(step.until - clip.offset, settle);
    const leave = Math.min(clip.duration, Math.min(dwell, settle + profile.maxDwell));
    // Arriving and leaving in the same breath is the jerk this floor prevents:
    // the camera would reverse direction with no pause between the two moves.
    if (leave - settle < MIN_DWELL) continue;

    raw.push({
      stepId: step.id,
      enter,
      settle,
      leave,
      // The profile multiplies the *resting* framing, not the contained one. In
      // a same-shape project that is the wide shot and nothing changes; in a
      // 9:16 project resting is already a crop, and a "140 %" zoom means 140 %
      // of what the viewer is looking at rather than of a letterboxed strip.
      camera: cameraOn(
        step.point as ScreenPoint,
        rest.scale * profile.factor,
        fit,
        settings,
      ),
    });
  }

  // Order matters. Merging first means the smoothing pass sees the shots the
  // camera will actually visit, rather than averaging in duplicates that were
  // about to be collapsed anyway.
  return smoothShots(mergeShots(raw, settings, profile, smoothing), settings, smoothing);
}

/* ------------------------------------------------------------------ *
 * Stops → keyframes
 * ------------------------------------------------------------------ */

/** A moment the camera is somewhere definite, and how it leaves for the next. */
interface Stop {
  time: number;
  camera: Camera;
  /** Governs the segment that *starts* here — the document's own convention. */
  easing: Easing;
}

/**
 * The camera's whole itinerary across the clip.
 *
 * The interesting decision is the last one in the loop: whether to come home
 * between two shots. If there is room for a release and a pause, the camera
 * pulls back to the wide shot, which re-establishes context and is what makes a
 * tutorial readable. If there is not, it glides directly from one point of
 * interest to the next — one continuous move instead of an out-and-in that
 * would have to be twice as fast to fit.
 */
function itinerary(
  shots: Shot[],
  duration: number,
  profile: ZoomProfile,
  rest: Camera,
): Stop[] {
  if (shots.length === 0) return [];

  const stops: Stop[] = [{ time: 0, camera: rest, easing: PUSH }];
  const atRest = (camera: Camera): boolean => camera === rest || isRest(camera);

  shots.forEach((shot, index) => {
    const last = stops[stops.length - 1] as Stop;

    // Sit still at the resting shot until it is time to move. Skipped when the
    // wait is too short to read as one.
    if (atRest(last.camera) && shot.enter > last.time + MIN_HOLD) {
      stops.push({ time: shot.enter, camera: rest, easing: PUSH });
    }

    stops.push({ time: shot.settle, camera: shot.camera, easing: HOLD });
    stops.push({ time: shot.leave, camera: shot.camera, easing: RELEASE });

    const next = shots[index + 1];
    const idle = next ? next.enter - shot.leave : Number.POSITIVE_INFINITY;

    /*
     * The N-second rule of the brief, in one line.
     *
     * Coming home costs a release and a pause. When there is not that much room
     * before the next shot — `reframeGap` — the camera glides straight across
     * instead, one continuous pan-and-zoom rather than an out-and-in that would
     * have to be twice as fast to fit.
     */
    const homeward = Math.max(profile.release + MIN_HOLD, profile.reframeGap);

    if (idle >= homeward) {
      stops.push({
        time: Math.min(duration, shot.leave + profile.release),
        camera: rest,
        easing: PUSH,
      });
    } else {
      (stops[stops.length - 1] as Stop).easing = GLIDE;
    }
  });

  return stops;
}

/**
 * Bends every glide onto a spline through the framings around it.
 *
 * A glide is a straight line in camera space: the camera leaves one point of
 * interest heading directly at the next, and at both ends the direction changes
 * abruptly. Sampling a Catmull-Rom curve through the *previous* and *following*
 * framings instead lets the move leave along the path it arrived on and arrive
 * along the path it is about to take, which is what "a trajectory envelope"
 * means in practice.
 *
 * Only the transit is touched. The spline's control points are the two shots it
 * runs between, and Catmull-Rom passes exactly through its control points, so
 * every framing the camera is supposed to settle on is still hit exactly.
 *
 * The inserted keys are linear: the curve already carries the shape, and an
 * easing on top of it would ease each little segment separately.
 */
function bendGlides(stops: Stop[], smoothing: Smoothing): Stop[] {
  const samples = Math.max(0, Math.round(smoothing.curve));
  if (samples < 2 || stops.length < 2) return stops;

  const out: Stop[] = [];

  for (let index = 0; index < stops.length; index += 1) {
    const from = stops[index] as Stop;
    out.push(from);

    const to = stops[index + 1];
    if (!to || from.easing !== GLIDE) continue;

    // The tangents. Falling back to the segment's own ends where there is no
    // neighbour turns the spline into a straight line there, which is correct:
    // with nothing to anticipate there is nothing to bow towards.
    const before = (stops[index - 1] ?? from).camera;
    const after = (stops[index + 2] ?? to).camera;

    for (let step = 1; step < samples; step += 1) {
      const t = step / samples;
      out.push({
        time: from.time + (to.time - from.time) * t,
        camera: {
          scale: catmullRom(before.scale, from.camera.scale, to.camera.scale, after.scale, t),
          x: catmullRom(before.x, from.camera.x, to.camera.x, after.x, t),
          y: catmullRom(before.y, from.camera.y, to.camera.y, after.y, t),
        },
        easing: { kind: 'linear' },
      });
    }
  }

  return out;
}

/**
 * Snaps the itinerary to frames and drops anything that no longer advances.
 *
 * Done **once**, for all three channels together. Filtering per channel would
 * let `scale` keep a keyframe that `x` had discarded, and the camera would then
 * zoom and pan on subtly different schedules — a wobble that is very hard to
 * diagnose from the graph editor.
 *
 * Earlier wins on a collision, which is the opposite of what `buildKeyframes`
 * does for a hand-written plan and is right here: two stops on the same frame
 * mean a move with no time to happen, and the correct outcome is that it does
 * not happen rather than that it snaps.
 */
function onFrames(stops: Stop[], duration: number, fps: number): Stop[] {
  const out: Stop[] = [];

  for (const stop of stops) {
    const time = snapToFrame(clamp(stop.time, 0, duration), fps);
    const last = out[out.length - 1];
    if (last && time <= last.time) continue;
    out.push({ ...stop, time });
  }

  return out;
}

/** One channel of the itinerary, or `null` when it never moves. */
function channel(stops: Stop[], pick: (camera: Camera) => number): Keyframe[] | null {
  const values = stops.map((stop) => pick(stop.camera));
  const first = values[0] as number;
  // A channel that holds one value for the whole clip is not an animation, and
  // writing it as one would only put a curve in the way of the static field.
  if (values.every((value) => value === first)) return null;

  return stops.map((stop, index) => ({
    id: uid('kf'),
    time: stop.time,
    value: values[index] as number,
    easing: { ...stop.easing },
  }));
}

/**
 * The animation map for a screen recording, given the steps found in it.
 *
 * `undefined` when there is nothing to animate — no shots, or a camera that
 * would never actually move. That is the value the clip should then carry: an
 * absent map is the signal the rest of the editor tests for.
 */
export function smartZoom(
  steps: TutorialStep[],
  clip: Pick<Clip, 'offset' | 'duration'>,
  asset: Pick<MediaAsset, 'width' | 'height'>,
  settings: ProjectSettings,
  profile: ZoomProfile,
  smoothing: Smoothing = DEFAULT_SMOOTHING,
): AnimationMap | undefined {
  const rest = restingCamera(steps, asset, settings);
  const shots = planShots(steps, clip, asset, settings, profile, smoothing, rest);
  const stops = onFrames(
    bendGlides(itinerary(shots, clip.duration, profile, rest), smoothing),
    clip.duration,
    settings.fps,
  );
  if (stops.length < 2) return undefined;

  const map: AnimationMap = {};
  const scale = channel(stops, (camera) => camera.scale);
  const x = channel(stops, (camera) => camera.x);
  const y = channel(stops, (camera) => camera.y);

  if (scale) map.scale = scale;
  if (x) map.x = x;
  if (y) map.y = y;

  return Object.keys(map).length > 0 ? map : undefined;
}

/** How many camera moves a set of steps would actually produce — for the UI. */
export const countShots = (
  steps: TutorialStep[],
  clip: Pick<Clip, 'offset' | 'duration'>,
  asset: Pick<MediaAsset, 'width' | 'height'>,
  settings: ProjectSettings,
  profile: ZoomProfile,
  smoothing: Smoothing = DEFAULT_SMOOTHING,
): number => planShots(steps, clip, asset, settings, profile, smoothing).length;
