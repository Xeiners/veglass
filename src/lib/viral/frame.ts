/**
 * Turning a wide recording into a tall clip, without a crop field.
 *
 * Both renderers already agree on what `clip.scale` means, and that agreement
 * is the whole trick here. The preview fits a layer into the frame with
 * `object-contain` and then applies `transform: scale(...)`; the export builds
 * `scale=W:H:force_original_aspect_ratio=decrease` and then multiplies by
 * `scale=iw*s:ih*s`. Same convention, so `scale = 1` means *contained* on both
 * sides, and a number computed here lands identically in the preview and in the
 * finished file.
 *
 * That means a 9:16 reframe needs no new field on `Clip`, no schema bump, and
 * no change to `bake.ts`, `renderPlan.ts` or `render.rs`: it is a scale and an
 * offset, which the document has carried since version 3.
 *
 * What it is not: face tracking. The analysis reads audio, so nothing here
 * knows where a speaker stands. The framing starts centred — right for most
 * talking-head footage — and `focus` is the user's handle to move it.
 */

import { coverScale, frameAspect, sourceAspect } from '@/lib/geometry';
import type { MediaAsset } from '@/types/media';
import type { ProjectSettings } from '@/types/project';

export { coverScale, frameAspect, sourceAspect };

export interface Reframe {
  scale: number;
  x: number;
  y: number;
  /**
   * How far the framing can travel horizontally, in project pixels, before the
   * edge of the source shows. Zero when the source is narrower than the frame.
   */
  slackX: number;
  slackY: number;
  /** False when the asset never reported its dimensions; the caller falls back. */
  known: boolean;
}

export const IDENTITY_REFRAME: Reframe = {
  scale: 1,
  x: 0,
  y: 0,
  slackX: 0,
  slackY: 0,
  known: false,
};

/** Nearest even pixel count — see `reframe` for why the parity matters. */
const even = (value: number): number => 2 * Math.round(value / 2);

/**
 * How a source should sit in the frame to fill it, framed at `focus`.
 *
 * `focus` runs 0 → 1 along whichever axis has room to move — horizontally for
 * the wide-to-tall case this feature exists for, vertically for the reverse.
 * Only one axis ever has slack, so a single handle is unambiguous. Moving the
 * visible window towards the start of the source means sliding the layer the
 * other way, which is why the offset is `(0.5 - focus)` and not the reverse.
 */
export function reframe(
  asset: Pick<MediaAsset, 'width' | 'height'>,
  settings: ProjectSettings,
  focus = 0.5,
): Reframe {
  const source = sourceAspect(asset);
  if (source === null) return IDENTITY_REFRAME;

  const frame = frameAspect(settings);
  const scale = coverScale(source, frame);

  // The contained size, before covering — the starting point both renderers use.
  const fitWidth = source >= frame ? settings.width : settings.height * source;
  const fitHeight = source >= frame ? settings.width / source : settings.height;

  // One of these is always ~0: covering only overflows the axis that was short.
  // Rounded to an even number of pixels so that half of it is a whole one —
  // otherwise the offsets at focus 0 and focus 1 round apart, and the framing
  // is a pixel off centre at one end of the slider but not the other.
  const slackX = even(Math.max(0, fitWidth * scale - settings.width));
  const slackY = even(Math.max(0, fitHeight * scale - settings.height));

  const clamped = Math.min(1, Math.max(0, Number.isFinite(focus) ? focus : 0.5));

  return {
    scale,
    x: (0.5 - clamped) * slackX,
    y: (0.5 - clamped) * slackY,
    slackX,
    slackY,
    known: true,
  };
}

/**
 * The focus a given offset corresponds to — the exact inverse of the above.
 *
 * The dashboard's framing slider reads a clip that may already carry an offset,
 * so the two directions have to agree or the handle jumps on first drag.
 */
export function focusOf(offset: number, slack: number): number {
  if (slack <= 0) return 0.5;
  return Math.min(1, Math.max(0, 0.5 - offset / slack));
}

/**
 * The share of the source's width still visible after covering.
 *
 * Shown on the card as a plain warning: reframing a 16:9 interview to 9:16
 * throws away about two thirds of the picture, and someone should know that
 * before they export twelve clips.
 */
export function keptWidth(reframed: Reframe, settings: ProjectSettings): number {
  const total = settings.width + reframed.slackX;
  return total > 0 ? settings.width / total : 1;
}

/** The axis the framing handle actually moves, for labelling the control. */
export const framingAxis = (reframed: Reframe): 'x' | 'y' | null => {
  if (reframed.slackX > 1) return 'x';
  if (reframed.slackY > 1) return 'y';
  return null;
};
