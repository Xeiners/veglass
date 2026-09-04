/**
 * Drawing the virtual cursor. Once.
 *
 * The same bargain as `lib/bannerPainter`: one function turns a `CursorLayer`
 * into pixels, and both the viewer and the export bake call it. `paintCursor`
 * works in project pixels around an origin at the *frame* centre, which is the
 * space `bake.ts` establishes after `applyTransform` — so the pointer and its
 * rings are identical in the preview and in the file by construction.
 *
 * # Where the pointer is, at a given instant
 *
 * Three passes, and the order matters.
 *
 * 1. **Exponential smoothing** removes the tremor. Raw pointer data is a
 *    staircase: sampled at some rate, quantised to whole screen pixels, and
 *    full of one-pixel corrections nobody made on purpose.
 * 2. **Catmull-Rom** between the smoothed samples gives a curve rather than a
 *    polyline, so a diagonal move does not visibly change direction at every
 *    sample.
 * 3. The **ease** on the ring is separate, and deliberately not the same curve:
 *    a spotlight that expands linearly reads as a loading spinner.
 *
 * Both smoothing passes are pure functions of the sample list, so the pointer
 * is at exactly the same place on frame 431 whether that frame is being drawn
 * for the viewer or written to disk.
 */

import { clamp } from '@/lib/time';
import { withAlpha } from '@/types/text';
import type { ProjectSettings } from '@/types/project';
import {
  isVisible,
  type CursorClick,
  type CursorLayer,
  type CursorSample,
} from '@/types/cursor';

/* ------------------------------------------------------------------ *
 * The path
 * ------------------------------------------------------------------ */

/**
 * One pass of exponential smoothing, forwards then backwards.
 *
 * Run in both directions on purpose. A single forward pass is a low-pass filter
 * *and* a delay — the pointer would lag behind its own clicks, which is the one
 * error this feature cannot afford: a ring that fires where the cursor is about
 * to be looks like a mistake. Filtering the reversed signal as well cancels the
 * phase shift exactly, which is the standard trick and the reason this is not
 * simply a loop.
 */
export function smoothPath(samples: CursorSample[], strength: number): CursorSample[] {
  const alpha = 1 - clamp(strength, 0, 0.95);
  if (samples.length < 3 || alpha >= 1) return samples;

  const ordered = [...samples].sort((a, b) => a.t - b.t);

  const pass = (input: CursorSample[]): CursorSample[] => {
    const out: CursorSample[] = [];
    let x = (input[0] as CursorSample).x;
    let y = (input[0] as CursorSample).y;
    for (const sample of input) {
      x += (sample.x - x) * alpha;
      y += (sample.y - y) * alpha;
      out.push({ t: sample.t, x, y });
    }
    return out;
  };

  const forward = pass(ordered);
  const backward = pass([...forward].reverse()).reverse();
  // Times are carried from the original list: the filter smooths *positions*,
  // and letting it touch the clock would slide clicks off their own frames.
  return backward.map((sample, index) => ({ ...sample, t: (ordered[index] as CursorSample).t }));
}

/** One coordinate of a uniform Catmull-Rom spline through four controls. */
const spline = (a: number, b: number, c: number, d: number, t: number): number => {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
  );
};

/**
 * Where the pointer is at `time`, in source coordinates.
 *
 * Held flat outside the sampled span, which is what every compositor does with
 * an animation: a path does not extrapolate past its own ends, and a cursor
 * that flew off the screen before the recording started would be worse than one
 * that waited.
 */
export function pointerAt(samples: CursorSample[], time: number): { x: number; y: number } | null {
  if (samples.length === 0) return null;
  const first = samples[0] as CursorSample;
  if (samples.length === 1 || time <= first.t) return { x: first.x, y: first.y };

  const last = samples[samples.length - 1] as CursorSample;
  if (time >= last.t) return { x: last.x, y: last.y };

  for (let index = 0; index < samples.length - 1; index += 1) {
    const b = samples[index] as CursorSample;
    const c = samples[index + 1] as CursorSample;
    if (time < b.t || time > c.t) continue;

    const span = c.t - b.t;
    if (span <= 1e-9) return { x: c.x, y: c.y };
    const t = (time - b.t) / span;

    // Falling back to the segment's own ends where there is no neighbour makes
    // the spline a straight line there, which is right: with nothing before or
    // after, there is no direction to carry through.
    const a = samples[index - 1] ?? b;
    const d = samples[index + 2] ?? c;

    return { x: spline(a.x, b.x, c.x, d.x, t), y: spline(a.y, b.y, c.y, d.y, t) };
  }

  return { x: last.x, y: last.y };
}

/** The path the painter actually reads — smoothed once, then interpolated. */
export const resolvedPath = (layer: CursorLayer): CursorSample[] =>
  smoothPath(layer.samples, layer.smoothing);

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/** The rectangle the source occupies at `scale = 1`, from its aspect alone. */
export function cursorFit(
  layer: CursorLayer,
  settings: ProjectSettings,
): { width: number; height: number } {
  const frame = settings.height > 0 ? settings.width / settings.height : 16 / 9;
  const source = layer.aspect > 0 ? layer.aspect : 16 / 9;

  return source >= frame
    ? { width: settings.width, height: settings.width / source }
    : { width: settings.height * source, height: settings.height };
}

/**
 * A source point, in project pixels from the frame centre.
 *
 * The same formula `lib/geometry` uses to place a camera anchor, and it has to
 * be: the cursor clip carries the screen recording's own transform, so the two
 * only land together if they agree on where a normalised point sits inside the
 * fitted rectangle.
 */
export const toFrame = (
  point: { x: number; y: number },
  fit: { width: number; height: number },
): { x: number; y: number } => ({
  x: (point.x - 0.5) * fit.width,
  y: (point.y - 0.5) * fit.height,
});

/* ------------------------------------------------------------------ *
 * Painting
 * ------------------------------------------------------------------ */

/** Ease-out cubic. The ring is fastest the instant it is born. */
const easeOut = (t: number): number => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

/**
 * The arrow.
 *
 * Drawn as a path rather than an image so it scales cleanly to any resolution
 * and takes its colours from the layer. The proportions are the familiar
 * pointer everyone recognises without having to look at it — this is not the
 * place to be original.
 */
function drawPointer(
  ctx: CanvasRenderingContext2D,
  layer: CursorLayer,
  height: number,
  opacity: number,
): void {
  // A unit arrow, tip at the origin, one unit tall.
  const points: [number, number][] = [
    [0, 0],
    [0, 0.74],
    [0.19, 0.57],
    [0.31, 0.86],
    [0.44, 0.8],
    [0.32, 0.52],
    [0.55, 0.5],
  ];

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.scale(height, height);

  ctx.beginPath();
  ctx.moveTo(points[0]![0], points[0]![1]);
  for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();

  // The outline is what keeps a white pointer readable over a white dialog —
  // the single reason a system cursor has one.
  ctx.lineWidth = 0.075;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = layer.outline;
  ctx.stroke();

  ctx.fillStyle = layer.color;
  ctx.fill();
  ctx.restore();
}

/**
 * One click ring.
 *
 * Expands with an ease-out and fades on the same clock, so it is brightest and
 * fastest at the instant of the press and gone before the eye has to decide
 * whether it is still there. Drawn as a stroke rather than a disc: a filled
 * circle hides the thing it is pointing at, which is the opposite of the job.
 */
function drawRipple(
  ctx: CanvasRenderingContext2D,
  layer: CursorLayer,
  centre: { x: number; y: number },
  radius: number,
  age: number,
): void {
  const progress = clamp(age / Math.max(0.05, layer.rippleSeconds), 0, 1);
  const eased = easeOut(progress);
  const size = radius * eased;
  if (size <= 0.5) return;

  // Fades as the square of what is left: the ring is still clearly there at the
  // halfway point and unmistakably leaving by three quarters.
  const alpha = Math.pow(1 - progress, 2);

  ctx.save();
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, size, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1, radius * layer.rippleWidth * (1 - progress * 0.4));
  ctx.strokeStyle = withAlpha(layer.rippleColor, alpha);
  ctx.stroke();

  // A soft inner wash for the first third, so the press reads as a flash rather
  // than only as an outline travelling outwards.
  if (progress < 0.34) {
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, size, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(layer.rippleColor, alpha * 0.22);
    ctx.fill();
  }
  ctx.restore();
}

/** Rings alight at `time`, newest last so a double click stacks correctly. */
export function activeClicks(layer: CursorLayer, time: number): { click: CursorClick; age: number }[] {
  if (layer.ripple <= 0) return [];
  return layer.clicks
    .map((click) => ({ click, age: time - click.t }))
    .filter((entry) => entry.age >= 0 && entry.age <= layer.rippleSeconds)
    .sort((a, b) => b.age - a.age);
}

/**
 * Draws the cursor for one instant, centred on the current origin.
 *
 * `time` is clip-relative seconds — the same clock the samples and the clicks
 * are stamped in, and the same one `bakeLayer` passes when it walks a sequence.
 */
export function paintCursor(
  ctx: CanvasRenderingContext2D,
  layer: CursorLayer,
  settings: ProjectSettings,
  time: number,
  path: CursorSample[] = resolvedPath(layer),
): void {
  if (!isVisible(layer)) return;

  const fit = cursorFit(layer, settings);
  const height = Math.max(settings.height, 240);
  const radius = height * Math.max(0, layer.ripple);

  ctx.save();

  for (const { click, age } of activeClicks(layer, time)) {
    // A click's own coordinates win; otherwise it happened wherever the path
    // was, which is the usual case and the one that stays true if the path is
    // re-smoothed.
    const source = click.at ?? pointerAt(path, click.t);
    if (!source) continue;
    drawRipple(ctx, layer, toFrame(source, fit), radius, age);
  }

  const at = pointerAt(path, time);
  if (at && layer.opacity > 0) {
    const centre = toFrame(at, fit);
    ctx.save();
    ctx.translate(centre.x, centre.y);
    drawPointer(ctx, layer, height * Math.max(0.005, layer.size), layer.opacity);
    ctx.restore();
  }

  ctx.restore();
}
