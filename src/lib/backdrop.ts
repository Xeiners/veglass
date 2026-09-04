/**
 * The one place the backdrop's numbers are turned into a renderer's units.
 *
 * The viewer draws with CSS, the export draws with ffmpeg, and the two spell
 * the same blur differently. Every conversion between them lives here, so the
 * question "do the preview and the export agree" has one place to be answered
 * and one place to be tested — rather than two implementations that were
 * written to match and drift the first time either is touched.
 *
 * The three facts these functions encode:
 *
 * * CSS `filter: blur(L)` is a Gaussian of standard deviation **L**. ffmpeg's
 *   `gblur=sigma=S` is a Gaussian of standard deviation **S**. Same quantity,
 *   so the number passes straight through.
 * * CSS `box-shadow`'s blur radius **B** approximates a Gaussian of standard
 *   deviation **B / 2** — the specification says so in as many words. A shadow
 *   stored as a standard deviation therefore reaches CSS doubled, and ffmpeg
 *   unchanged. Getting this backwards is a factor of two, which is visible.
 * * Everything is stored in **project pixels**. The viewer draws at some
 *   fraction of the project resolution, so every length it uses is multiplied
 *   by that scale; the encoder works at full resolution and multiplies by
 *   nothing.
 */

import { withAlpha } from '@/types/text';
import { casts, type Backdrop, type BackdropShadow } from '@/types/backdrop';

/**
 * CSS blur length for a stored standard deviation.
 *
 * `unit` is the viewer's screen-pixels-per-project-pixel. A backdrop blurred by
 * 40 project pixels on a preview drawn at a third of the resolution has to be
 * blurred by about 13 screen pixels, or the preview would look far softer than
 * the file.
 */
export const cssBlur = (sigma: number, unit: number): string =>
  `blur(${(Math.max(0, sigma) * unit).toFixed(2)}px)`;

/** The `gblur` fragment for the same standard deviation. */
export const ffmpegBlur = (sigma: number): string =>
  `gblur=sigma=${Math.max(0, sigma).toFixed(2)}:steps=2`;

/**
 * The CSS blur radius that matches a Gaussian of standard deviation `sigma`.
 *
 * Doubled, per the shadow half-the-radius rule above. Exported on its own so
 * the conversion is testable without a DOM.
 */
export const shadowRadius = (sigma: number): number => Math.max(0, sigma) * 2;

/** `box-shadow`, in the viewer's units. */
export function cssShadow(shadow: BackdropShadow, unit: number): string | undefined {
  if (!casts(shadow)) return undefined;
  const blur = shadowRadius(shadow.blur) * unit;
  const offset = shadow.y * unit;
  return `0 ${offset.toFixed(2)}px ${blur.toFixed(2)}px ${withAlpha(shadow.color, shadow.opacity)}`;
}

/** The wash laid over the blurred copy — the glass itself. */
export const cssTint = (backdrop: Backdrop): string =>
  withAlpha(backdrop.tint, Math.max(0, Math.min(1, backdrop.tintOpacity)));

/**
 * How much bigger than the frame the blurred copy is drawn.
 *
 * Never below 1: a copy smaller than the frame would leave the very edges it
 * exists to fill still empty, which is the failure mode this whole feature is
 * about.
 */
export const backdropZoom = (backdrop: Backdrop): number => Math.max(1, backdrop.zoom);

/**
 * The filter fragments the encoder runs for a backdrop, in order.
 *
 * The authority is the Rust builder in `engine::ffmpeg`, which is what actually
 * encodes; this is its TypeScript twin, used by the render-plan description and
 * — more usefully — by the tests, which assert the two produce the same shape
 * so a change to one that misses the other is caught rather than shipped.
 */
export function backdropChain(
  backdrop: Backdrop,
  frame: { width: number; height: number },
): string[] {
  const zoom = backdropZoom(backdrop);
  const cover = {
    width: Math.round(frame.width * zoom),
    height: Math.round(frame.height * zoom),
  };

  return [
    // Cover, not contain: the copy has to reach every edge before it is blurred.
    `scale=${cover.width}:${cover.height}:force_original_aspect_ratio=increase`,
    `crop=${cover.width}:${cover.height}`,
    ffmpegBlur(backdrop.blur),
    // Cropped back to the frame *after* the blur, so the overscan is what fed
    // the edges rather than what shows at them.
    `crop=${frame.width}:${frame.height}`,
    ...(backdrop.tintOpacity > 0
      ? [
          `drawbox=x=0:y=0:w=${frame.width}:h=${frame.height}:color=${hexForFfmpeg(
            backdrop.tint,
          )}@${clamp01(backdrop.tintOpacity).toFixed(3)}:t=fill`,
        ]
      : []),
    'setsar=1',
  ];
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * `#RRGGBB` as ffmpeg spells a colour.
 *
 * ffmpeg accepts `0xRRGGBB` and named colours but not a leading `#`, which it
 * reads as the start of a comment in a filter script.
 */
export function hexForFfmpeg(hex: string): string {
  const clean = hex.replace('#', '').trim();
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : clean.slice(0, 6);
  return `0x${(full || '000000').toUpperCase()}`;
}
