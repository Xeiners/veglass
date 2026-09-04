/**
 * The glass backdrop behind a floating clip.
 *
 * When a 16:9 recording sits in a 9:16 frame, or a clip is scaled down inside
 * its own, the space around it is black. A blurred, tinted copy of the clip
 * itself fills that space instead — the look every screencast tool ships and
 * the single cheapest way to make a recording look composed rather than
 * cropped.
 *
 * # Blur is a standard deviation, everywhere
 *
 * The one number that has to be right. CSS `filter: blur(σ)` is specified as a
 * Gaussian with standard deviation σ; ffmpeg's `gblur=sigma=σ` is the same
 * quantity. CSS `box-shadow`'s blur radius is *not*: the specification defines
 * it as approximating a Gaussian of standard deviation **half** the radius.
 *
 * So everything here is stored as a standard deviation in project pixels, and
 * `lib/backdrop` holds the two conversions — one for the viewer, one for the
 * encoder. Storing "a blur of 40" and letting each side interpret it is exactly
 * how a preview and an export come to disagree by a factor of two.
 */

export interface BackdropShadow {
  /** Gaussian standard deviation, in project pixels. 0 disables the shadow. */
  blur: number;
  /** Vertical offset, in project pixels. Positive drops it downwards. */
  y: number;
  color: string;
  opacity: number;
}

export interface Backdrop {
  /** Gaussian standard deviation of the backdrop blur, in project pixels. */
  blur: number;
  /**
   * Magnification of the blurred copy beyond covering the frame.
   *
   * A blur pulls in colour from outside the pixel it is writing, so a copy
   * scaled to exactly cover has nothing to pull from at its edges and goes pale
   * there. A few per cent of overscan gives it something to eat.
   */
  zoom: number;
  /** Laid over the blurred copy. This is the "glass" of glassmorphism. */
  tint: string;
  tintOpacity: number;
  /** Corner radius of the floating clip above, in project pixels. */
  radius: number;
  shadow: BackdropShadow;
}

/**
 * The default look: near-black glass, a firm blur, a shadow you notice only if
 * you look for it.
 *
 * The blur is deliberately large. A backdrop that can still be read as a
 * picture competes with the clip in front of it; one blurred past recognition
 * reads as a surface, which is the whole idea.
 */
export const DEFAULT_BACKDROP: Backdrop = {
  blur: 40,
  zoom: 1.12,
  tint: '#0B0E13',
  tintOpacity: 0.42,
  radius: 22,
  shadow: { blur: 26, y: 14, color: '#000000', opacity: 0.55 },
};

export interface BackdropPreset {
  id: string;
  label: string;
  hint: string;
  backdrop: Backdrop;
}

export const BACKDROP_PRESETS: BackdropPreset[] = [
  {
    id: 'glass',
    label: 'Verre',
    hint: 'Copie floutée et teintée sombre — le réglage de référence',
    backdrop: DEFAULT_BACKDROP,
  },
  {
    id: 'soft',
    label: 'Doux',
    hint: 'Flou léger, presque pas de teinte — on devine l’image derrière',
    backdrop: {
      blur: 24,
      zoom: 1.08,
      tint: '#101418',
      tintOpacity: 0.18,
      radius: 18,
      shadow: { blur: 20, y: 10, color: '#000000', opacity: 0.4 },
    },
  },
  {
    id: 'studio',
    label: 'Studio',
    hint: 'Fond très sombre, ombre franche — la fenêtre flotte nettement',
    backdrop: {
      blur: 56,
      zoom: 1.16,
      tint: '#05070A',
      tintOpacity: 0.68,
      radius: 26,
      shadow: { blur: 38, y: 22, color: '#000000', opacity: 0.7 },
    },
  },
];

export const backdropPreset = (id: string): BackdropPreset =>
  BACKDROP_PRESETS.find((preset) => preset.id === id) ?? (BACKDROP_PRESETS[0] as BackdropPreset);

/** Whether the backdrop would put any pixels on screen. */
export const paints = (backdrop: Backdrop | undefined): backdrop is Backdrop =>
  backdrop !== undefined;

/** Whether the floating clip casts anything. */
export const casts = (shadow: BackdropShadow): boolean =>
  shadow.opacity > 0 && (shadow.blur > 0 || shadow.y !== 0);
