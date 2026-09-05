/**
 * Clip effects.
 *
 * An effect instance is deliberately dumb — a kind plus a bag of numbers — so
 * the document format never has to change when a new filter is added. All the
 * knowledge lives in the descriptor registry below: parameter ranges, live CSS
 * mapping, and the label the UI shows. Adding a filter is one entry here; the
 * inspector, the preview and the render plan all follow automatically.
 *
 * The ffmpeg mapping deliberately lives elsewhere (`src-tauri/src/engine`, with
 * a TypeScript twin in `src/lib/effectChain.ts`) because the render engine owns
 * it, not the UI.
 */

export type EffectKind =
  | 'brightness'
  | 'contrast'
  | 'saturation'
  | 'blur'
  | 'hue'
  | 'grayscale'
  | 'invert'
  | 'rgbsplit'
  | 'motionblur';

export interface Effect {
  id: string;
  kind: EffectKind;
  enabled: boolean;
  /** Keyed by the descriptor's parameter `key`. */
  params: Record<string, number>;
}

export interface EffectParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** The value that means "no change" — used by the reset control. */
  neutral: number;
  /** Value applied when the effect is first added, so it is visibly doing something. */
  initial: number;
  /**
   * Factor between the number a user types and the one that is stored — 100 for
   * a parameter shown as a percentage, so `130` means 1.30.
   */
  inputScale?: number;
  format(value: number): string;
}

export interface EffectDescriptor {
  kind: EffectKind;
  label: string;
  hint: string;
  params: EffectParamSpec[];
  /**
   * Live preview fragment, e.g. `saturate(1.3)`.
   *
   * `unit` converts **project pixels into the pixels the viewer is drawing in**
   * — the stage is a scaled-down copy of the frame, and a filter is not scaled
   * by the transform that positions the layer. A length that ignores it looks
   * right on a maximised window and two or three times too strong on a small
   * one, while the export does something else again. Only lengths use it.
   *
   * `null` when the parameters are neutral, and on the effects CSS has no
   * function for at all — those answer through {@link EffectDescriptor.svg}.
   */
  css(params: Record<string, number>, unit: number): string | null;
  /**
   * The SVG filter this effect needs, for the ones the CSS function list
   * cannot express — a channel offset, a blur along one axis.
   *
   * Present exactly on those effects, and `null` when their parameters are
   * neutral. The chain builder puts a `url(#…)` reference in the CSS string
   * where the effect sits, so the stack order survives.
   */
  svg?(params: Record<string, number>, unit: number, id: string): SvgFilterSpec | null;
}

/**
 * A filter the viewer has to draw as SVG rather than as a CSS function.
 *
 * Every length is already in the viewer's own pixels: whoever builds one has
 * applied `unit`, so the renderer places the numbers verbatim.
 */
export type SvgFilterSpec =
  | {
      id: string;
      kind: 'rgbsplit';
      /** How far the red channel moves; blue moves the opposite way. */
      dx: number;
      dy: number;
    }
  | {
      id: string;
      kind: 'motionblur';
      /** Gaussian standard deviation per axis. */
      x: number;
      y: number;
    };

const percent = (value: number) => `${Math.round(value * 100)} %`;
const signedPercent = (value: number) =>
  `${value > 0 ? '+' : ''}${Math.round(value * 100)} %`;

export const EFFECTS: EffectDescriptor[] = [
  {
    kind: 'brightness',
    label: 'Luminosité',
    hint: 'Éclaircit ou assombrit l’image',
    params: [
      {
        key: 'amount',
        label: 'Intensité',
        min: -1,
        max: 1,
        step: 0.01,
        neutral: 0,
        initial: 0.15,
        inputScale: 100,
        format: signedPercent,
      },
    ],
    // CSS brightness is a multiplier around 1; the stored value is an offset,
    // which matches ffmpeg's `eq=brightness` range of -1 → 1.
    css: (params) => `brightness(${(1 + (params.amount ?? 0)).toFixed(3)})`,
  },
  {
    kind: 'contrast',
    label: 'Contraste',
    hint: 'Écarte ou resserre les tons',
    params: [
      {
        key: 'amount',
        label: 'Intensité',
        min: 0,
        max: 2.5,
        step: 0.01,
        neutral: 1,
        initial: 1.2,
        inputScale: 100,
        format: percent,
      },
    ],
    css: (params) => `contrast(${(params.amount ?? 1).toFixed(3)})`,
  },
  {
    kind: 'saturation',
    label: 'Saturation',
    hint: 'Densité des couleurs',
    params: [
      {
        key: 'amount',
        label: 'Intensité',
        min: 0,
        max: 3,
        step: 0.01,
        neutral: 1,
        initial: 1.35,
        inputScale: 100,
        format: percent,
      },
    ],
    css: (params) => `saturate(${(params.amount ?? 1).toFixed(3)})`,
  },
  {
    kind: 'blur',
    label: 'Flou',
    hint: 'Flou gaussien',
    params: [
      {
        key: 'radius',
        label: 'Rayon',
        min: 0,
        max: 40,
        step: 0.5,
        neutral: 0,
        initial: 6,
        format: (value) => `${value.toFixed(1)} px`,
      },
    ],
    /*
     * Halved, and scaled to the viewer.
     *
     * CSS `blur(n)` *is* a Gaussian of standard deviation `n` — the spec says
     * so, and `types/backdrop` has said so here for as long as backdrops have
     * existed. The encoder is handed `radius / 2`, so passing the raw radius to
     * the viewer made the preview exactly twice as blurred as the file it was
     * previewing. The export is left alone and the viewer is corrected to it.
     */
    css: (params, unit) =>
      (params.radius ?? 0) > 0
        ? `blur(${(((params.radius ?? 0) / 2) * unit).toFixed(2)}px)`
        : null,
  },
  {
    kind: 'hue',
    label: 'Teinte',
    hint: 'Rotation de la roue chromatique',
    params: [
      {
        key: 'angle',
        label: 'Angle',
        min: -180,
        max: 180,
        step: 1,
        neutral: 0,
        initial: 30,
        format: (value) => `${value > 0 ? '+' : ''}${Math.round(value)}°`,
      },
    ],
    css: (params) => `hue-rotate(${Math.round(params.angle ?? 0)}deg)`,
  },
  {
    kind: 'grayscale',
    label: 'Noir & blanc',
    hint: 'Désaturation totale progressive',
    params: [
      {
        key: 'amount',
        label: 'Dosage',
        min: 0,
        max: 1,
        step: 0.01,
        neutral: 0,
        initial: 1,
        inputScale: 100,
        format: percent,
      },
    ],
    css: (params) => `grayscale(${(params.amount ?? 0).toFixed(3)})`,
  },
  {
    kind: 'invert',
    label: 'Négatif',
    hint: 'Inverse les couleurs — à pleine dose, la photo en négatif',
    params: [
      {
        key: 'amount',
        label: 'Dosage',
        min: 0,
        max: 1,
        step: 0.01,
        neutral: 0,
        // Full, because a half-inverted frame is flat grey and reads as a bug.
        // Anyone who wants the in-between can drag towards it.
        initial: 1,
        inputScale: 100,
        format: percent,
      },
    ],
    css: (params) => `invert(${(params.amount ?? 0).toFixed(3)})`,
  },
  {
    /*
     * Chromatic aberration.
     *
     * Red goes one way, blue the other, green stays put — which is what a cheap
     * lens does at the edge of its coverage, and what a tape head does when it
     * is losing tracking. On an impact it reads as the frame being struck.
     *
     * Neither CSS nor the canvas has a function for moving one channel, so this
     * is drawn as an SVG filter. The encoder's `rgbashift` moves the same
     * channels by the same signed pixel counts in the same directions — both
     * checked against the binary rather than assumed — so the two are one
     * operation described twice, not two that resemble each other.
     */
    kind: 'rgbsplit',
    label: 'Aberration chromatique',
    hint: 'Décale les canaux rouge et bleu — l’écart d’objectif d’un impact',
    params: [
      {
        key: 'amount',
        label: 'Écart',
        min: 0,
        // `rgbashift` takes a signed byte's worth of pixels; nothing legible
        // needs a tenth of that, and the cap keeps a slider drag sane.
        max: 60,
        // Whole project pixels, because the encoder's option is an integer. A
        // step the export would round away is a step that lies.
        step: 1,
        neutral: 0,
        initial: 10,
        format: (value) => `${Math.round(value)} px`,
      },
      {
        key: 'angle',
        label: 'Direction',
        min: -180,
        max: 180,
        step: 1,
        neutral: 0,
        initial: 0,
        format: (value) => `${value > 0 ? '+' : ''}${Math.round(value)}°`,
      },
    ],
    css: () => null,
    svg: (params, unit, id) => {
      const amount = params.amount ?? 0;
      if (amount <= 0) return null;
      const radians = ((params.angle ?? 0) * Math.PI) / 180;
      return {
        id,
        kind: 'rgbsplit',
        dx: amount * Math.cos(radians) * unit,
        dy: amount * Math.sin(radians) * unit,
      };
    },
  },
  {
    /*
     * Directional blur — the smear that keeps a hard cut from reading as a jump.
     *
     * Gaussian, and **elliptical rather than rotated**: the deviation is split
     * across the two axes, so 0° and 90° are exact and everything between is an
     * axis-aligned ellipse rather than a true streak along the angle. That is a
     * real limitation, and it is the honest one — a rotated Gaussian means
     * turning, blurring and turning back, and the viewer and the encoder would
     * then have to agree on the resampling of both turns to the pixel. An
     * ellipse the two compute identically beats a streak they compute
     * differently.
     *
     * SVG's `stdDeviation="x y"` and ffmpeg's `gblur=sigma=x:sigmaV=y` are the
     * same two numbers in the same units — the equivalence `types/backdrop`
     * already rests on, now stated per axis.
     */
    kind: 'motionblur',
    label: 'Flou de mouvement',
    hint: 'Flou gaussien sur un seul axe — lie les images d’une coupe rapide',
    params: [
      {
        key: 'amount',
        label: 'Intensité',
        min: 0,
        max: 60,
        step: 0.5,
        neutral: 0,
        initial: 14,
        format: (value) => `${value.toFixed(1)} px`,
      },
      {
        key: 'angle',
        label: 'Direction',
        min: -180,
        max: 180,
        step: 1,
        neutral: 0,
        initial: 0,
        format: (value) => `${value > 0 ? '+' : ''}${Math.round(value)}°`,
      },
    ],
    css: () => null,
    svg: (params, unit, id) => {
      const amount = params.amount ?? 0;
      if (amount <= 0) return null;
      const radians = ((params.angle ?? 0) * Math.PI) / 180;
      // Absolute: a blur has an axis, not a direction. 180° is 0°.
      return {
        id,
        kind: 'motionblur',
        x: amount * Math.abs(Math.cos(radians)) * unit,
        y: amount * Math.abs(Math.sin(radians)) * unit,
      };
    },
  },
];

export const effectDescriptor = (kind: EffectKind): EffectDescriptor =>
  EFFECTS.find((item) => item.kind === kind) ?? (EFFECTS[0] as EffectDescriptor);

/** Parameter bag for a freshly added effect. */
export function initialParams(kind: EffectKind): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of effectDescriptor(kind).params) out[spec.key] = spec.initial;
  return out;
}

export function neutralParams(kind: EffectKind): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of effectDescriptor(kind).params) out[spec.key] = spec.neutral;
  return out;
}

/** True when every parameter sits at its no-op value. */
export function isNeutral(effect: Effect): boolean {
  return effectDescriptor(effect.kind).params.every(
    (spec) => Math.abs((effect.params[spec.key] ?? spec.neutral) - spec.neutral) < 1e-6,
  );
}

/** Everything a viewer needs in order to draw one clip's effect stack. */
export interface FilterChain {
  /** Value for CSS `filter`, or `undefined` when nothing applies. */
  css: string | undefined;
  /** The filters the `url(#…)` references in `css` point at, in that order. */
  svg: SvgFilterSpec[];
}

export const EMPTY_CHAIN: FilterChain = { css: undefined, svg: [] };

/**
 * The whole stack, as one CSS `filter` value plus the SVG it leans on.
 *
 * Order is preserved, and that is why the two halves come back together rather
 * than as "the CSS ones" and "the SVG ones": a stack of blur, split, saturation
 * composes in that order, and a builder that gathered each kind into its own
 * pass would quietly reorder it. An SVG-backed effect contributes a `url(#…)`
 * **at its own position** in the chain, so what is composed is what the
 * inspector lists and what the encoder builds.
 *
 * `unit` turns project pixels into the pixels the caller is drawing in — the
 * stage's scale for the viewer, and 1 for the export bake, which already works
 * at the project's own resolution.
 *
 * `scope` makes the generated ids unique. It is the clip id everywhere, so two
 * clips carrying the same effect never fight over one `<filter>`.
 */
export function filterChainFor(
  effects: Effect[] | undefined,
  unit: number,
  scope: string,
): FilterChain {
  if (!effects || effects.length === 0) return EMPTY_CHAIN;

  const parts: string[] = [];
  const svg: SvgFilterSpec[] = [];

  effects.forEach((effect, index) => {
    if (!effect.enabled) return;
    const descriptor = effectDescriptor(effect.kind);

    if (descriptor.svg) {
      const spec = descriptor.svg(effect.params, unit, `vgfx-${scope}-${index}`);
      if (spec) {
        svg.push(spec);
        parts.push(`url(#${spec.id})`);
      }
      return;
    }

    const css = descriptor.css(effect.params, unit);
    if (css) parts.push(css);
  });

  return parts.length > 0 ? { css: parts.join(' '), svg } : EMPTY_CHAIN;
}
