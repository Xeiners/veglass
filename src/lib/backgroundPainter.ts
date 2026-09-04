/**
 * Drawing a generated background.
 *
 * One pure function, `paintBackground`, used by two very different callers: the
 * preview canvas sixty times a second, and the export bake once per output
 * frame. That they share the code is the whole point — a background that looked
 * right in the viewer and different in the render would be worse than no
 * background at all.
 *
 * "Pure" is meant strictly. Nothing here reads a clock or calls `Math.random`:
 * every position comes from the layer's own seed and the time it is handed, so
 * frame 412 of the export is pixel-identical to the viewer parked on frame 412.
 *
 * The looks are built from **soft radial gradients**, not from `ctx.filter =
 * blur()`. A canvas blur of the radius these shapes need costs tens of
 * milliseconds a frame at 4K; a gradient with an alpha falloff is one fill, and
 * it is what a blurred circle looks like anyway.
 */

import { withAlpha } from '@/types/text';
import { easeAt, type Keyframe } from '@/types/animation';
import type { BackgroundLayer } from '@/types/background';

/**
 * xorshift32 — small, fast, and above all *reproducible*.
 *
 * The quality of the randomness matters far less here than the fact that the
 * same seed always lays the shapes out the same way.
 */
function rng(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

const TAU = Math.PI * 2;

const pick = (colors: string[], index: number): string =>
  colors.length === 0 ? '#FFFFFF' : (colors[index % colors.length] as string);

/**
 * A blurred disc, as one gradient.
 *
 * The middle stop is what makes it read as *blurred* rather than as a hard
 * circle with a soft edge: a straight two-stop falloff is visibly linear.
 */
function blob(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  alpha: number,
): void {
  if (radius <= 0 || alpha <= 0) return;
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, withAlpha(color, alpha));
  gradient.addColorStop(0.45, withAlpha(color, alpha * 0.45));
  gradient.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

/**
 * The finishing pass every preset gets.
 *
 * A generated gradient without one looks flat and uniformly bright to the edges,
 * which is the tell that something was drawn by a loop. Darkening the corners is
 * what photographers and colourists do for the same reason.
 */
function vignette(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const radius = Math.hypot(width, height) / 2;
  const gradient = ctx.createRadialGradient(
    width / 2,
    height / 2,
    radius * 0.35,
    width / 2,
    height / 2,
    radius,
  );
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

/* ------------------------------------------------------------------ *
 * The presets
 * ------------------------------------------------------------------ */

/** Large soft blobs drifting on Lissajous paths — the default look. */
function aurora(
  ctx: CanvasRenderingContext2D,
  layer: BackgroundLayer,
  phase: number,
  width: number,
  height: number,
): void {
  const random = rng(layer.seed);
  const short = Math.min(width, height);
  const count = 5;

  ctx.globalCompositeOperation = 'lighter';

  for (let index = 0; index < count; index += 1) {
    // Drawn before the loop body uses them, so the sequence of calls — and
    // therefore the layout — is fixed by the seed alone.
    const phaseX = random() * TAU;
    const phaseY = random() * TAU;
    // Deliberately unequal frequencies: two blobs on the same rhythm read as a
    // pulse, and the whole point is that the movement never quite repeats.
    const freqX = 0.05 + random() * 0.07;
    const freqY = 0.04 + random() * 0.08;
    const radius = short * (0.34 + random() * 0.3) * layer.scale;
    const spread = 0.34 + random() * 0.16;

    const x = width / 2 + Math.sin(phase * freqX * TAU + phaseX) * width * spread;
    const y = height / 2 + Math.cos(phase * freqY * TAU + phaseY) * height * spread;

    blob(ctx, x, y, radius, pick(layer.colors, index), 0.5 * layer.intensity);
  }
}

/** Soft discs rising slowly, the way out-of-focus highlights drift. */
function bokeh(
  ctx: CanvasRenderingContext2D,
  layer: BackgroundLayer,
  phase: number,
  width: number,
  height: number,
): void {
  const random = rng(layer.seed);
  const short = Math.min(width, height);
  const count = 28;

  ctx.globalCompositeOperation = 'lighter';

  for (let index = 0; index < count; index += 1) {
    const column = random();
    const offset = random();
    const rise = 0.02 + random() * 0.05;
    const sway = random() * TAU;
    const size = 0.012 + random() ** 2 * 0.055;

    // Wrapped rather than clamped: a disc that leaves the top reappears below,
    // so the field never empties however long the clip runs.
    const progress = (offset + phase * rise) % 1.2;
    const y = height * (1.1 - progress);
    const x = width * column + Math.sin(phase * 0.3 + sway) * width * 0.03;
    const radius = short * size * layer.scale;

    // Small ones sit further back, so they are dimmer — the depth cue that
    // separates a bokeh field from a handful of circles.
    const depth = 0.35 + size * 8;
    blob(ctx, x, y, radius, pick(layer.colors, index), 0.35 * layer.intensity * depth);
  }
}

/** Four hues breathing at the corners — the mesh gradient, quietly animated. */
function mesh(
  ctx: CanvasRenderingContext2D,
  layer: BackgroundLayer,
  phase: number,
  width: number,
  height: number,
): void {
  const random = rng(layer.seed);
  const count = Math.max(3, layer.colors.length);
  const short = Math.min(width, height);

  ctx.globalCompositeOperation = 'source-over';

  for (let index = 0; index < count; index += 1) {
    const seed = random() * TAU;
    const drift = 0.03 + random() * 0.05;
    // Anchored around a circle rather than at literal corners: an odd number of
    // colours has no corners to sit in, and the ring degrades gracefully.
    const angle = (index / count) * TAU + seed * 0.1;
    const anchorX = width / 2 + Math.cos(angle) * width * 0.32;
    const anchorY = height / 2 + Math.sin(angle) * height * 0.32;

    const wobble = Math.sin(phase * drift * TAU + seed);
    const x = anchorX + wobble * width * 0.07;
    const y = anchorY + Math.cos(phase * drift * TAU + seed) * height * 0.07;
    const radius = short * (0.55 + wobble * 0.07) * layer.scale;

    blob(ctx, x, y, radius, pick(layer.colors, index), 0.42 * layer.intensity);
  }
}

/** Stacked sine bands, drifting out of phase with each other. */
function waves(
  ctx: CanvasRenderingContext2D,
  layer: BackgroundLayer,
  phase: number,
  width: number,
  height: number,
): void {
  const random = rng(layer.seed);
  const bands = Math.max(4, layer.colors.length * 2);
  const step = width / 64;

  ctx.globalCompositeOperation = 'lighter';

  for (let index = 0; index < bands; index += 1) {
    const seed = random() * TAU;
    const frequency = (1 + random() * 2) / layer.scale;
    const amplitude = height * (0.04 + random() * 0.07) * layer.scale;
    const drift = 0.08 + random() * 0.12;
    // Spread down the frame, with the lower bands in front.
    const baseline = height * (0.2 + (index / bands) * 0.75);

    const color = pick(layer.colors, index);
    const gradient = ctx.createLinearGradient(0, baseline - amplitude, 0, height);
    gradient.addColorStop(0, withAlpha(color, 0.3 * layer.intensity));
    gradient.addColorStop(1, withAlpha(color, 0));

    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let x = 0; x <= width + step; x += step) {
      const angle = (x / width) * frequency * TAU + phase * drift * TAU + seed;
      ctx.lineTo(x, baseline + Math.sin(angle) * amplitude);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * How far the pattern has travelled by `time`, in speed-seconds.
 *
 * This exists because speed is **animatable**, and a rate cannot simply be
 * multiplied by the clock once it varies. Drawing at `time × speed(t)` makes the
 * pattern *jump* the moment the speed changes — accelerating from 0,2 to 1 at
 * t = 10 would teleport it eight seconds forward. What the presets actually need
 * is the integral of the speed, which is continuous by construction however
 * abruptly the speed itself moves.
 *
 * The common case costs nothing: with no keyframes the integral is `speed × t`
 * exactly. Otherwise it is accumulated segment by segment — a handful of
 * keyframes, a few subdivisions each, independent of how long the clip runs.
 */
export function backgroundPhase(
  layer: BackgroundLayer,
  keyframes: Keyframe[] | undefined,
  time: number,
): number {
  const seconds = Number.isFinite(time) ? Math.max(0, time) : 0;
  if (!keyframes || keyframes.length === 0) return seconds * layer.speed;

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  const first = sorted[0] as Keyframe;
  const last = sorted[sorted.length - 1] as Keyframe;

  // Before the first key and after the last, the value is held flat — the same
  // rule the evaluator uses everywhere else.
  let phase = Math.min(seconds, first.time) * first.value;
  if (seconds <= first.time) return phase;

  const STEPS = 8;
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const from = sorted[index] as Keyframe;
    const to = sorted[index + 1] as Keyframe;
    const span = to.time - from.time;
    if (span <= 0) continue;

    const until = Math.min(seconds, to.time);
    if (until <= from.time) break;

    // Trapezoid over the eased segment: the curve is smooth, so a handful of
    // slices is well past the point where more would change a pixel.
    const covered = until - from.time;
    const slice = covered / STEPS;
    for (let step = 0; step < STEPS; step += 1) {
      const a = from.value + (to.value - from.value) * easeAt(from.easing, (step * slice) / span);
      const b =
        from.value + (to.value - from.value) * easeAt(from.easing, ((step + 1) * slice) / span);
      phase += ((a + b) / 2) * slice;
    }
    if (until < to.time) return phase;
  }

  return phase + Math.max(0, seconds - last.time) * last.value;
}

/**
 * Paints `layer` onto `ctx`, filling `width × height`.
 *
 * `phase` is how far the pattern has travelled — see {@link backgroundPhase}.
 * It is not a clock: `layer.speed` is deliberately *not* read while drawing, so
 * that an animated speed accelerates the movement instead of jumping it.
 */
export function paintBackground(
  ctx: CanvasRenderingContext2D,
  layer: BackgroundLayer,
  phase: number,
  width: number,
  height: number,
): void {
  if (width <= 0 || height <= 0) return;

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = layer.base;
  ctx.fillRect(0, 0, width, height);

  const travelled = Number.isFinite(phase) ? phase : 0;

  switch (layer.kind) {
    case 'bokeh':
      bokeh(ctx, layer, travelled, width, height);
      break;
    case 'mesh':
      mesh(ctx, layer, travelled, width, height);
      break;
    case 'waves':
      waves(ctx, layer, travelled, width, height);
      break;
    default:
      aurora(ctx, layer, travelled, width, height);
      break;
  }

  vignette(ctx, width, height);
  ctx.restore();
}
