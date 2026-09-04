/**
 * The virtual cursor.
 *
 * A screen recording already contains a mouse pointer, and it is the worst
 * thing in the picture: it jitters, it takes the shortest path rather than a
 * readable one, it is the size of the operating system's default and it gives
 * no sign at all when a click actually lands. Every screencast tool worth using
 * throws it away and draws its own.
 *
 * So does this. A `cursor` clip is a *recipe* — a path, a list of clicks, and a
 * style — drawn by `lib/cursorPainter` for the viewer and by the export bake
 * for the render, through one painter, exactly as a banner and a generated
 * background already are.
 *
 * # Why the positions are normalised
 *
 * Samples are stored in **source coordinates**, 0 → 1 across the recording, and
 * never in project pixels. That is what lets the cursor clip carry the *same
 * transform and the same animation* as the screen recording it belongs to: when
 * the virtual camera pushes in on a button, the cursor is carried along by the
 * identical curve, and lands on the button rather than beside it. A path stored
 * in frame pixels would have to be re-derived every time the camera moved.
 */

import type { ScreenPoint } from './geometry';

/** One position of the pointer, in clip-relative seconds. */
export interface CursorSample {
  /** Seconds from the clip's start. */
  t: number;
  /** 0 → 1 across the source picture. */
  x: number;
  y: number;
}

export type ClickButton = 'left' | 'right';

/** One press, and the ring it throws. */
export interface CursorClick {
  /** Seconds from the clip's start. */
  t: number;
  button: ClickButton;
  /**
   * Where it landed. Absent means "wherever the path is at `t`", which is the
   * normal case — a click is a moment on the path, not a place of its own.
   */
  at?: ScreenPoint;
}

export interface CursorLayer {
  /** Aspect ratio of the recording the path was measured on. */
  aspect: number;
  samples: CursorSample[];
  clicks: CursorClick[];

  /* ---- the pointer ---- */
  /** Height of the arrow, as a fraction of the frame height. */
  size: number;
  color: string;
  outline: string;
  /** 0 hides the pointer entirely and leaves only the click rings. */
  opacity: number;

  /* ---- the spotlight ---- */
  /** 0 disables the ring. Radius at full expansion, fraction of frame height. */
  ripple: number;
  rippleColor: string;
  /** Seconds a ring takes to expand and fade. */
  rippleSeconds: number;
  /** Thickness of the ring, as a fraction of its own radius. */
  rippleWidth: number;

  /* ---- smoothing ---- */
  /**
   * How hard the path is smoothed, 0 → 1.
   *
   * Raw pointer data is full of one-pixel tremors and stair-steps from the
   * sampling rate. This is the exponential pass that removes them; the spline
   * in the painter does the rest.
   */
  smoothing: number;
}

export const DEFAULT_CURSOR: Omit<CursorLayer, 'aspect' | 'samples' | 'clicks'> = {
  size: 0.045,
  color: '#FFFFFF',
  outline: '#101418',
  opacity: 1,
  ripple: 0.09,
  rippleColor: '#7FE7C4',
  rippleSeconds: 0.62,
  rippleWidth: 0.16,
  smoothing: 0.6,
};

export function cursorLayer(
  aspect: number,
  samples: CursorSample[],
  clicks: CursorClick[],
  style: Partial<typeof DEFAULT_CURSOR> = {},
): CursorLayer {
  return {
    aspect: Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9,
    samples,
    clicks,
    ...DEFAULT_CURSOR,
    ...style,
  };
}

/** Track name for the generated pointer, reused rather than stacked. */
export const CURSOR_TRACK_NAME = 'Curseur';

/**
 * How long a ring stays on screen after its click.
 *
 * Read rather than assumed, because the bake needs to know how far past the
 * last click a frame can still differ from the one before it.
 */
export const rippleTail = (layer: CursorLayer): number =>
  layer.ripple > 0 ? Math.max(0, layer.rippleSeconds) : 0;

/** Whether the layer would draw anything at all. */
export const isVisible = (layer: CursorLayer): boolean =>
  (layer.opacity > 0 && layer.samples.length > 0) ||
  (layer.ripple > 0 && layer.clicks.length > 0);
