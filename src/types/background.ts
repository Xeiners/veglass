/**
 * Generated backgrounds.
 *
 * A background is a **kind plus a bag of numbers and colours** — the same shape
 * as an effect, and for the same reason: the document format must not change
 * when a new look is added. Everything a preset knows about itself lives in the
 * registry below, and everything it draws lives in `lib/backgroundPainter.ts`.
 *
 * Nothing here is rasterised. The painter is a pure function of the layer, the
 * frame size and the time, which is what lets the same code serve the preview
 * canvas and the export bake — the render engine never learns that generated
 * backgrounds exist, it receives PNGs like it does for text.
 */

export type BackgroundKind = 'aurora' | 'bokeh' | 'mesh' | 'waves' | 'solid';

export interface BackgroundLayer {
  kind: BackgroundKind;
  /** Painted first, edge to edge. The colour the frame settles to. */
  base: string;
  /** Accents, cycled by whatever the preset draws. Two to five reads best. */
  colors: string[];
  /** Movement, 0 → 2. At 0 the pattern is frozen and bakes as one still. */
  speed: number;
  /** Shape size relative to the frame, 0.4 → 2. */
  scale: number;
  /** How strongly the accents sit over the base, 0 → 1.5. */
  intensity: number;
  /**
   * Fixes the layout.
   *
   * Every position is drawn from this rather than from `Math.random`, so the
   * preview and the exported frame are identical — and so two backgrounds in
   * one project do not move in lockstep.
   */
  seed: number;
}

export interface BackgroundDescriptor {
  kind: BackgroundKind;
  label: string;
  hint: string;
  /** Sensible starting point, including a palette that already looks right. */
  preset: Omit<BackgroundLayer, 'seed'>;
}

/**
 * The looks on offer.
 *
 * Four patterns, deliberately: each has to be recognisably its own thing at a
 * glance, and a list of twelve near-identical gradients is worse than a list of
 * four that are not. The fifth entry is not a look at all — see `solid`.
 */
export const BACKGROUNDS: BackgroundDescriptor[] = [
  {
    kind: 'aurora',
    label: 'Aurore',
    hint: 'Grandes boules floues qui dérivent — le fond animé passe-partout',
    preset: {
      kind: 'aurora',
      base: '#0B0A1F',
      colors: ['#7C3AED', '#22D3EE', '#EC4899'],
      speed: 0.6,
      scale: 1,
      intensity: 0.9,
    },
  },
  {
    kind: 'bokeh',
    label: 'Bokeh',
    hint: 'Particules douces qui montent lentement, comme un flou d’objectif',
    preset: {
      kind: 'bokeh',
      base: '#0A0A0F',
      colors: ['#FBBF24', '#FDE68A', '#F59E0B'],
      speed: 0.5,
      scale: 0.9,
      intensity: 0.75,
    },
  },
  {
    kind: 'mesh',
    label: 'Dégradé maillé',
    hint: 'Quatre teintes qui respirent aux coins — sobre, très lisible',
    preset: {
      kind: 'mesh',
      base: '#0D0F12',
      colors: ['#4F46E5', '#0EA5E9', '#A78BFA', '#F472B6'],
      speed: 0.35,
      scale: 1.15,
      intensity: 0.85,
    },
  },
  {
    kind: 'waves',
    label: 'Ondes',
    hint: 'Bandes sinusoïdales superposées, lentes et régulières',
    preset: {
      kind: 'waves',
      base: '#06131C',
      colors: ['#0EA5E9', '#14B8A6', '#6366F1'],
      speed: 0.5,
      scale: 1,
      intensity: 0.8,
    },
  },
  {
    /*
     * A flat colour, edge to edge — a matte rather than a look.
     *
     * It earns a place in this registry because everything a generated layer
     * already gets for free is exactly what a colour card needs: the painter
     * draws it, the bake rasterises it, the encoder overlays the PNG, and an
     * animated opacity travels through all three by construction. A veil built
     * any other way would be a fourth thing to keep in parity.
     *
     * It is what an AMV's flashes are made of, and it is the plainest possible
     * answer to "I want two seconds of black at the top".
     */
    kind: 'solid',
    label: 'Aplat',
    hint: 'Une couleur pleine et immobile — cartons, voiles, flashs',
    preset: {
      kind: 'solid',
      base: '#FFFFFF',
      // Nothing is drawn over the base, so there are no accents to choose.
      colors: [],
      // Frozen by definition: a flat colour has nothing that could move, and a
      // speed of zero is what lets the bake write one PNG instead of hundreds.
      speed: 0,
      scale: 1,
      intensity: 1,
    },
  },
];

export const backgroundDescriptor = (kind: BackgroundKind): BackgroundDescriptor =>
  BACKGROUNDS.find((item) => item.kind === kind) ?? (BACKGROUNDS[0] as BackgroundDescriptor);

/**
 * Ready-made palettes.
 *
 * Choosing three colours that work together is the part people get stuck on, so
 * the panel offers a handful that do and a picker for those who would rather
 * not be offered anything.
 */
export interface Palette {
  id: string;
  label: string;
  base: string;
  colors: string[];
}

export const PALETTES: Palette[] = [
  { id: 'nebula', label: 'Nébuleuse', base: '#0B0A1F', colors: ['#7C3AED', '#22D3EE', '#EC4899'] },
  { id: 'ember', label: 'Braise', base: '#12070A', colors: ['#F97316', '#EF4444', '#FBBF24'] },
  { id: 'lagoon', label: 'Lagon', base: '#04141A', colors: ['#14B8A6', '#0EA5E9', '#A3E635'] },
  { id: 'orchid', label: 'Orchidée', base: '#140A1B', colors: ['#D946EF', '#8B5CF6', '#F472B6'] },
  { id: 'slate', label: 'Ardoise', base: '#0A0C10', colors: ['#64748B', '#94A3B8', '#38BDF8'] },
  { id: 'gold', label: 'Or', base: '#0B0904', colors: ['#FBBF24', '#F59E0B', '#FDE68A'] },
];

export const DEFAULT_BACKGROUND_DURATION = 8;

export function defaultBackground(kind: BackgroundKind = 'aurora'): BackgroundLayer {
  return {
    ...backgroundDescriptor(kind).preset,
    // A fresh layout each time, so adding two auroras does not give two of the
    // same drifting in step.
    seed: Math.floor(Math.random() * 0xffffff) + 1,
  };
}

/** Bounds the inspector and any generated plan are held to. */
export const BACKGROUND_RANGES = {
  speed: { min: 0, max: 2, step: 0.05 },
  scale: { min: 0.4, max: 2, step: 0.05 },
  intensity: { min: 0, max: 1.5, step: 0.05 },
} as const;

/** A frozen pattern is one still frame, which the export bake can exploit. */
export const isStill = (layer: BackgroundLayer): boolean => layer.speed <= 0;
