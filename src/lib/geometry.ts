/**
 * The display geometry every layer in this app agrees on.
 *
 * One convention, stated once. `scale = 1` means the source **contained** in
 * the frame — the preview reaches that with `object-contain` plus a transform,
 * the export with `scale=W:H:force_original_aspect_ratio=decrease` followed by
 * `scale=iw*s:ih*s`. Because both renderers start from the same rectangle, a
 * number computed here lands identically in the viewer and in the finished
 * file, and no clip needs a `crop` field to be reframed.
 *
 * Three features now stand on this: the vertical reframe of a viral cut, the
 * virtual camera of a tutorial, and the format shift of a whole project. They
 * used to state the same three primitives in two places; a correction to one
 * that missed the other would be a preview and an export disagreeing, which is
 * the single worst failure this codebase can have. So the primitives live here
 * and nowhere else.
 *
 * # The two ways to name a framing
 *
 * A framing can be written as a **transform** — `scale`, `x`, `y`, which is
 * what the document stores — or as an **anchor and a zoom**: which point of the
 * source sits at the centre of the frame, and how much of the source is
 * visible. The second is the one a human reasons in ("keep the button in
 * shot"), and it is the only one that survives a change of frame: a `y` of
 * −180 px means nothing once the frame is twice as tall.
 *
 * {@link cameraOn} converts anchor → transform, {@link anchorOf} converts back,
 * and {@link retargetCamera} is the round trip through a different frame. That
 * pair is the whole of the smart-crop mathematics.
 */

import { clamp } from '@/lib/time';
import type { MediaAsset } from '@/types/media';
import type { ProjectSettings } from '@/types/project';
import { CENTRE, type ScreenPoint } from '@/types/geometry';

export { CENTRE, type ScreenPoint };

/** A framing, in the terms the document stores. */
export interface Camera {
  scale: number;
  /** Offset of the layer's centre from the frame's centre, in project pixels. */
  x: number;
  y: number;
}

/** Wide, centred, untouched — what `scale = 1` already means. */
export const REST: Camera = { scale: 1, x: 0, y: 0 };

export const isRest = (camera: Camera): boolean =>
  camera.scale === REST.scale && camera.x === REST.x && camera.y === REST.y;

/** The size the source occupies at `scale = 1`, in project pixels. */
export interface Fit {
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ *
 * Aspect
 * ------------------------------------------------------------------ */

/** Aspect ratio of a source, or `null` when it has not been probed. */
export function sourceAspect(asset: Pick<MediaAsset, 'width' | 'height'>): number | null {
  const { width, height } = asset;
  if (!width || !height || width <= 0 || height <= 0) return null;
  return width / height;
}

/** The frame's aspect, guarding a settings object with a zero in it. */
export function frameAspect(settings: ProjectSettings): number {
  return settings.height > 0 && settings.width > 0 ? settings.width / settings.height : 16 / 9;
}

/**
 * The multiplier that turns a contained layer into a covering one.
 *
 * Contain fits the longer axis; cover has to fill the other. Whichever of the
 * two ratios exceeds 1 is exactly that shortfall, and the other is its inverse,
 * so the larger of the pair is the answer in both directions — including the
 * degenerate case where the two aspects match and it is exactly 1.
 */
export function coverScale(source: number, frame: number): number {
  if (!Number.isFinite(source) || !Number.isFinite(frame) || source <= 0 || frame <= 0) return 1;
  return Math.max(source / frame, frame / source);
}

/** The scale at which `asset` fills `settings` with no empty edge. */
export function coverFactor(
  asset: Pick<MediaAsset, 'width' | 'height'>,
  settings: ProjectSettings,
): number {
  const source = sourceAspect(asset);
  return source === null ? 1 : coverScale(source, frameAspect(settings));
}

/**
 * The contained rectangle, which is the frame both renderers start from.
 *
 * `null` when the asset never reported its dimensions — the caller then knows
 * it cannot place a point of interest, and correctly does nothing rather than
 * framing somewhere arbitrary.
 */
export function fittedSize(
  asset: Pick<MediaAsset, 'width' | 'height'>,
  settings: ProjectSettings,
): Fit | null {
  const source = sourceAspect(asset);
  if (source === null) return null;

  const frame = frameAspect(settings);
  return source >= frame
    ? { width: settings.width, height: settings.width / source }
    : { width: settings.height * source, height: settings.height };
}

/* ------------------------------------------------------------------ *
 * Anchor ⇄ transform
 * ------------------------------------------------------------------ */

/** Sub-pixel offsets are real; fifteen decimal places of them are just noise. */
export const tidy = (value: number): number => Math.round(value * 100) / 100;

/**
 * How far the layer may travel before an empty edge shows, per axis.
 *
 * Zero on an axis the enlarged content does not overflow — which is why a
 * pillarboxed source cannot be panned sideways, however much the caller asks.
 */
export function roomFor(scale: number, fit: Fit, settings: ProjectSettings): { x: number; y: number } {
  return {
    x: Math.max(0, (scale * fit.width - settings.width) / 2),
    y: Math.max(0, (scale * fit.height - settings.height) / 2),
  };
}

/**
 * The transform that puts `point` in the middle of the frame at `factor` zoom.
 *
 * Two things are worth spelling out.
 *
 * The offset is *negative* the point's distance from centre: to look at
 * something on the right, the layer moves left. And it is clamped to the room
 * the enlarged content actually has, so the framing can never travel far enough
 * to show an empty edge — a crop that reveals the background is a crop that
 * looks broken, whatever asked for it.
 *
 * The clamp is also what makes a point near a corner behave sensibly: the
 * framing goes as far as it can and stops, which still puts the target on
 * screen and much larger than it was.
 */
export function cameraOn(
  point: ScreenPoint,
  factor: number,
  fit: Fit,
  settings: ProjectSettings,
): Camera {
  const scale = Math.max(0.01, factor);
  const room = roomFor(scale, fit, settings);

  const px = clamp(point.x, 0, 1);
  const py = clamp(point.y, 0, 1);

  /*
   * Rounded *before* the clamp, never after.
   *
   * The other order looks identical and is not: rounding a value that is
   * already sitting exactly on its limit can push it a few thousandths of a
   * pixel past it, and "the framing never reveals an empty edge" stops being a
   * guarantee and becomes a near-miss. Clamping last makes it exact.
   */
  return {
    scale,
    x: clamp(tidy(-(px - 0.5) * scale * fit.width), -room.x, room.x),
    y: clamp(tidy(-(py - 0.5) * scale * fit.height), -room.y, room.y),
  };
}

/**
 * Which point of the source is at the centre of the frame — the inverse.
 *
 * Not a perfect inverse of {@link cameraOn}, and deliberately so: that function
 * clamps, so a point asked for near an edge is not the point that ends up
 * centred. This reports what is *actually* centred, which is the truthful
 * answer and the one a retarget must carry across.
 */
export function anchorOf(camera: Camera, fit: Fit): ScreenPoint {
  const width = camera.scale * fit.width;
  const height = camera.scale * fit.height;

  return {
    x: width > 0 ? clamp(0.5 - camera.x / width, 0, 1) : 0.5,
    y: height > 0 ? clamp(0.5 - camera.y / height, 0, 1) : 0.5,
  };
}

/**
 * How much of the source's height the frame currently shows, 0 → 1.
 *
 * The quantity a format shift preserves. Going from a landscape master to a
 * portrait one, an editor keeps the vertical extent of the shot and loses the
 * sides — so this is what carries across, and the horizontal framing is then
 * whatever the anchor and the clamp allow.
 */
export function visibleHeight(camera: Camera, fit: Fit, settings: ProjectSettings): number {
  const shown = camera.scale * fit.height;
  return shown > 0 ? Math.min(1, settings.height / shown) : 1;
}

/* ------------------------------------------------------------------ *
 * Retargeting
 * ------------------------------------------------------------------ */

/**
 * The same framing, expressed in a different frame.
 *
 * The subject stays where it was — that is the anchor — and the amount of the
 * picture on screen is preserved vertically, then opened up to at least cover
 * so the new frame is never letterboxed. Everything else falls out of the
 * clamp in {@link cameraOn}.
 *
 * A framing that was *already* letterboxed (below cover) is snapped up to
 * cover rather than kept: a deliberate 16:9 layer sitting in bars inside a 16:9
 * frame is one thing, but carrying those bars into a 9:16 export is never what
 * a format shift meant.
 *
 * Returns the camera untouched when the asset has no measured size — there is
 * no geometry to work with, and inventing one would move a layer for no reason.
 */
export function retargetCamera(
  camera: Camera,
  asset: Pick<MediaAsset, 'width' | 'height'>,
  from: ProjectSettings,
  to: ProjectSettings,
): Camera {
  const fitFrom = fittedSize(asset, from);
  const fitTo = fittedSize(asset, to);
  if (!fitFrom || !fitTo) return camera;

  const anchor = anchorOf(camera, fitFrom);
  const shown = visibleHeight(camera, fitFrom, from);

  // The scale that shows the same fraction of the source's height in the new
  // frame. `shown` is already capped at 1, so this never asks to see more of
  // the source than exists.
  const wanted = shown > 0 ? to.height / (shown * fitTo.height) : 1;

  return cameraOn(anchor, Math.max(wanted, coverFactor(asset, to)), fitTo, to);
}

/**
 * The visible rectangle, in normalised source coordinates.
 *
 * What the crop overlay draws, and what makes "you are losing 62 % of the
 * width" a fact rather than an impression.
 */
export interface CropWindow {
  /** All four in 0 → 1 source coordinates. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export function cropWindow(camera: Camera, fit: Fit, settings: ProjectSettings): CropWindow {
  const anchor = anchorOf(camera, fit);
  const width = camera.scale * fit.width > 0 ? Math.min(1, settings.width / (camera.scale * fit.width)) : 1;
  const height = visibleHeight(camera, fit, settings);

  return {
    width,
    height,
    left: clamp(anchor.x - width / 2, 0, Math.max(0, 1 - width)),
    top: clamp(anchor.y - height / 2, 0, Math.max(0, 1 - height)),
  };
}

/** The share of the source's area still on screen — the honest cost of a crop. */
export const keptArea = (window: CropWindow): number =>
  clamp(window.width * window.height, 0, 1);
