/**
 * The progress bar.
 *
 * A hairline that fills across the frame as the clip plays. On a vertical clip
 * it is the cheapest retention device there is: it answers "how much longer"
 * without the viewer having to reach for the scrubber, and a viewer who knows
 * the end is close does not leave before it.
 *
 * # Why it is a project property and not a layer
 *
 * It belongs to the *composition*, not to any clip in it. It spans the whole
 * export from the first frame to the last, it sits over everything including
 * transitions, and there is exactly one of it. A clip that carried its own
 * would produce six bars in a montage of six cuts, which is not what anyone
 * means by a progress bar.
 *
 * That also makes it cheap to render honestly: one absolutely-positioned pair
 * of boxes in the viewer, one pair of `drawbox` filters on the finished
 * composite in the encoder. No baking, no PNG sequence, no per-frame canvas.
 *
 * # Why there is no corner radius
 *
 * `drawbox` draws rectangles and nothing else. Rounding the ends would mean a
 * per-pixel `geq` pass over every frame of the export to shape six pixels of
 * height — and rounding *only* in CSS would mean the preview and the file
 * disagreed at exactly the place this feature is meant to be pixel-exact. Square
 * ends, on both sides, deliberately.
 */

export type ProgressPosition = 'top' | 'bottom';

export interface ProgressBar {
  /** Thickness, in project pixels. */
  height: number;
  /** The part that fills. */
  color: string;
  /** The groove behind it. Its opacity may be zero, leaving only the fill. */
  trackColor: string;
  trackOpacity: number;
  position: ProgressPosition;
  /**
   * Distance from the frame's edge, in project pixels.
   *
   * Not zero by default: on a phone the very top and bottom of the frame sit
   * under the platform's own interface, and a bar flush against the edge is a
   * bar half-hidden by a username and a row of buttons.
   */
  margin: number;
  /** Distance from the left and right edges, in project pixels. */
  inset: number;
  /** The fill's own opacity. */
  opacity: number;
}

export const DEFAULT_PROGRESS: ProgressBar = {
  height: 6,
  color: '#31E1A6',
  trackColor: '#FFFFFF',
  trackOpacity: 0.18,
  position: 'bottom',
  margin: 28,
  inset: 0,
  opacity: 1,
};

export interface ProgressPreset {
  id: string;
  label: string;
  hint: string;
  bar: ProgressBar;
}

export const PROGRESS_PRESETS: ProgressPreset[] = [
  {
    id: 'edge',
    label: 'Bord',
    hint: 'Pleine largeur, tout en bas — la plus discrète',
    bar: { ...DEFAULT_PROGRESS, margin: 0, height: 5 },
  },
  {
    id: 'safe',
    label: 'Zone sûre',
    hint: 'Remontée au-dessus de l’interface du téléphone',
    bar: DEFAULT_PROGRESS,
  },
  {
    id: 'top',
    label: 'En tête',
    hint: 'En haut du cadre, façon lecteur de stories',
    bar: { ...DEFAULT_PROGRESS, position: 'top', margin: 24, inset: 24, height: 5 },
  },
];

export const progressPreset = (id: string): ProgressPreset =>
  PROGRESS_PRESETS.find((preset) => preset.id === id) ?? (PROGRESS_PRESETS[1] as ProgressPreset);

/** Whether the bar would put any pixels on screen. */
export const draws = (bar: ProgressBar | undefined): bar is ProgressBar =>
  bar !== undefined && bar.height > 0 && (bar.opacity > 0 || bar.trackOpacity > 0);

/**
 * The bar's own rectangle, in project pixels from the top-left of the frame.
 *
 * Shared by the viewer and by the filter builder's twin so both put the groove
 * in the same place — the one number a bar cannot afford to disagree on, since
 * a few pixels of drift is the difference between "on the safe line" and "under
 * the username".
 */
export function progressRect(
  bar: ProgressBar,
  frame: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const inset = Math.max(0, Math.min(bar.inset, frame.width / 2 - 1));
  const height = Math.max(1, Math.round(bar.height));
  const margin = Math.max(0, Math.min(bar.margin, frame.height - height));

  return {
    x: Math.round(inset),
    y: Math.round(bar.position === 'top' ? margin : frame.height - margin - height),
    width: Math.max(1, Math.round(frame.width - inset * 2)),
    height,
  };
}

/** How full the bar is at `time`, 0 → 1, over the window actually shown. */
export function progressAt(time: number, from: number, to: number): number {
  const span = to - from;
  if (!Number.isFinite(span) || span <= 0) return 0;
  return Math.max(0, Math.min(1, (time - from) / span));
}
