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
  | 'grayscale';

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
  /** Live preview fragment, e.g. `saturate(1.3)`. */
  css(params: Record<string, number>): string | null;
}

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
    css: (params) =>
      (params.radius ?? 0) > 0 ? `blur(${(params.radius ?? 0).toFixed(1)}px)` : null,
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

/**
 * The whole stack as one CSS `filter` value. Order is preserved: effects
 * compose top-down exactly as they are listed in the inspector.
 */
export function cssFilterFor(effects: Effect[] | undefined): string | undefined {
  if (!effects || effects.length === 0) return undefined;
  const parts = effects
    .filter((effect) => effect.enabled)
    .map((effect) => effectDescriptor(effect.kind).css(effect.params))
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' ') : undefined;
}
