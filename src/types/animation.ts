/**
 * Keyframe animation.
 *
 * A property is a plain number until it is *animated*; from then on a list of
 * keyframes owns it and the static field becomes the fallback. That is the
 * After Effects model, and it is what makes this addition non-breaking: a clip
 * with no `animation` map behaves exactly as before.
 *
 * Keyframe times are **relative to the clip start**, so moving a clip along the
 * timeline carries its animation untouched.
 */

export type EasingKind = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold' | 'bezier';

/** Cubic-bézier control points `[x1, y1, x2, y2]`, CSS convention. */
export type BezierHandles = [number, number, number, number];

export interface Easing {
  kind: EasingKind;
  /** Only meaningful for `bezier`. */
  bezier?: BezierHandles;
}

export interface Keyframe {
  id: string;
  /** Seconds from the clip start. */
  time: number;
  value: number;
  /** Governs the segment that *starts* at this keyframe. */
  easing: Easing;
}

/** Channel name → its keyframes, sorted by time. */
export type AnimationMap = Record<string, Keyframe[]>;

/** Addresses one keyframe anywhere in the document. */
export interface KeyframeRef {
  clipId: string;
  channel: string;
  id: string;
}

/* ------------------------------------------------------------------ *
 * Channels
 * ------------------------------------------------------------------ */

export const CLIP_CHANNELS = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'] as const;
export type ClipChannel = (typeof CLIP_CHANNELS)[number];

/** Effect parameters address themselves as `fx:<effectId>:<paramKey>`. */
export const effectChannel = (effectId: string, key: string): string => `fx:${effectId}:${key}`;

export function parseEffectChannel(channel: string): { effectId: string; key: string } | null {
  if (!channel.startsWith('fx:')) return null;
  const [, effectId, key] = channel.split(':');
  return effectId && key ? { effectId, key } : null;
}

export const isClipChannel = (channel: string): channel is ClipChannel =>
  (CLIP_CHANNELS as readonly string[]).includes(channel);

/**
 * A generated background's own parameters address themselves as `bg:<key>`.
 *
 * The prefix is not decoration: a background has a `scale` of its own, and a
 * clip already has one. Without a namespace the two would be the same channel,
 * and animating the shapes would resize the layer.
 */
export const BACKGROUND_CHANNELS = ['speed', 'scale', 'intensity'] as const;
export type BackgroundChannel = (typeof BACKGROUND_CHANNELS)[number];

export const backgroundChannel = (key: BackgroundChannel): string => `bg:${key}`;

export function parseBackgroundChannel(channel: string): BackgroundChannel | null {
  if (!channel.startsWith('bg:')) return null;
  const key = channel.slice(3);
  return (BACKGROUND_CHANNELS as readonly string[]).includes(key)
    ? (key as BackgroundChannel)
    : null;
}

/* ------------------------------------------------------------------ *
 * Easing
 * ------------------------------------------------------------------ */

export const EASING_HANDLES: Record<Exclude<EasingKind, 'hold' | 'bezier'>, BezierHandles> = {
  linear: [0, 0, 1, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
};

export const EASING_LABELS: Record<EasingKind, string> = {
  linear: 'Linéaire',
  'ease-in': 'Départ doux',
  'ease-out': 'Arrivée douce',
  'ease-in-out': 'Doux des deux côtés',
  hold: 'Palier',
  bezier: 'Courbe libre',
};

export const DEFAULT_EASING: Easing = { kind: 'ease-in-out' };

export interface EasingPreset {
  id: string;
  label: string;
  group: string;
  /** `null` for the two curves that are not béziers at all. */
  handles: BezierHandles | null;
  kind: EasingKind;
}

/**
 * The standard easing library.
 *
 * These are the Penner curves in their cubic-bézier form — the same values the
 * web platform and every motion tool use, so a curve chosen here reads the way
 * a designer expects it to. Grouped by character rather than by family name,
 * because what you pick by is the *feel*, not the polynomial degree.
 */
export const EASING_PRESETS: EasingPreset[] = [
  { id: 'linear', label: 'Linéaire', group: 'Base', kind: 'linear', handles: [0, 0, 1, 1] },
  { id: 'hold', label: 'Palier', group: 'Base', kind: 'hold', handles: null },

  { id: 'sine-in', label: 'Sine · entrée', group: 'Doux', kind: 'bezier', handles: [0.12, 0, 0.39, 0] },
  { id: 'sine-out', label: 'Sine · sortie', group: 'Doux', kind: 'bezier', handles: [0.61, 1, 0.88, 1] },
  { id: 'sine-in-out', label: 'Sine · les deux', group: 'Doux', kind: 'bezier', handles: [0.37, 0, 0.63, 1] },
  { id: 'quad-in', label: 'Quad · entrée', group: 'Doux', kind: 'bezier', handles: [0.11, 0, 0.5, 0] },
  { id: 'quad-out', label: 'Quad · sortie', group: 'Doux', kind: 'bezier', handles: [0.5, 1, 0.89, 1] },
  { id: 'quad-in-out', label: 'Quad · les deux', group: 'Doux', kind: 'bezier', handles: [0.45, 0, 0.55, 1] },

  { id: 'cubic-in', label: 'Cubic · entrée', group: 'Marqué', kind: 'bezier', handles: [0.32, 0, 0.67, 0] },
  { id: 'cubic-out', label: 'Cubic · sortie', group: 'Marqué', kind: 'bezier', handles: [0.33, 1, 0.68, 1] },
  { id: 'cubic-in-out', label: 'Cubic · les deux', group: 'Marqué', kind: 'bezier', handles: [0.65, 0, 0.35, 1] },
  { id: 'quart-out', label: 'Quart · sortie', group: 'Marqué', kind: 'bezier', handles: [0.25, 1, 0.5, 1] },
  { id: 'expo-out', label: 'Expo · sortie', group: 'Marqué', kind: 'bezier', handles: [0.16, 1, 0.3, 1] },
  { id: 'expo-in-out', label: 'Expo · les deux', group: 'Marqué', kind: 'bezier', handles: [0.87, 0, 0.13, 1] },

  { id: 'circ-in', label: 'Circ · entrée', group: 'Circulaire', kind: 'bezier', handles: [0.55, 0, 1, 0.45] },
  { id: 'circ-out', label: 'Circ · sortie', group: 'Circulaire', kind: 'bezier', handles: [0, 0.55, 0.45, 1] },
  { id: 'circ-in-out', label: 'Circ · les deux', group: 'Circulaire', kind: 'bezier', handles: [0.85, 0, 0.15, 1] },

  // Overshoot: the control points leave the 0–1 band on purpose.
  { id: 'back-in', label: 'Anticipation', group: 'Rebond', kind: 'bezier', handles: [0.36, 0, 0.66, -0.56] },
  { id: 'back-out', label: 'Dépassement', group: 'Rebond', kind: 'bezier', handles: [0.34, 1.56, 0.64, 1] },
  { id: 'back-in-out', label: 'Élan', group: 'Rebond', kind: 'bezier', handles: [0.68, -0.6, 0.32, 1.6] },
];

export const EASING_GROUPS = ['Base', 'Doux', 'Marqué', 'Circulaire', 'Rebond'] as const;

const sameHandles = (a: BezierHandles, b: BezierHandles): boolean =>
  a.every((value, index) => Math.abs(value - (b[index] as number)) < 1e-3);

/** Which preset an easing corresponds to, if any — used to light up the grid. */
export function matchPreset(easing: Easing): EasingPreset | null {
  if (easing.kind === 'hold') return EASING_PRESETS.find((item) => item.id === 'hold') ?? null;
  if (easing.kind === 'linear') return EASING_PRESETS.find((item) => item.id === 'linear') ?? null;

  const handles = handlesOf(easing);
  return (
    EASING_PRESETS.find(
      (preset) => preset.handles !== null && sameHandles(preset.handles, handles),
    ) ?? null
  );
}

/**
 * The easing a preset id names, by name rather than by handles.
 *
 * Generators reach for these curves constantly — a title's entrance, a camera
 * push, a banner sliding in — and each was writing its own `[0.65, 0, 0.35, 1]`
 * with a comment saying which Penner curve that was. Naming it once means the
 * intent is in the call and a correction lands everywhere at once.
 *
 * Falls back to the library's default rather than throwing: a curve that is a
 * little wrong is a far better outcome than an export that stops.
 */
export function presetEasing(id: string): Easing {
  const preset = EASING_PRESETS.find((item) => item.id === id);
  return preset ? easingOf(preset) : { ...DEFAULT_EASING };
}

/** The easing a preset applies. */
export const easingOf = (preset: EasingPreset): Easing =>
  preset.handles === null || preset.kind !== 'bezier'
    ? { kind: preset.kind }
    : { kind: 'bezier', bezier: preset.handles };

/** The control points a given easing actually uses. */
export function handlesOf(easing: Easing): BezierHandles {
  if (easing.kind === 'bezier') return easing.bezier ?? [0.42, 0, 0.58, 1];
  if (easing.kind === 'hold') return [0, 0, 0, 0];
  return EASING_HANDLES[easing.kind];
}

const bezierAt = (t: number, a: number, b: number): number => {
  // Cubic with the first and last control points pinned at 0 and 1.
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * a + 3 * inverse * t * t * b + t * t * t;
};

const bezierSlope = (t: number, a: number, b: number): number => {
  const inverse = 1 - t;
  return 3 * inverse * inverse * a + 6 * inverse * t * (b - a) + 3 * t * t * (1 - b);
};

/**
 * Solves the parametric `t` that puts the curve at abscissa `x`.
 *
 * Newton converges in a handful of steps for well-behaved handles; bisection
 * takes over when the slope is flat, which is exactly where Newton stalls.
 */
function solveT(x: number, x1: number, x2: number): number {
  let t = x;
  for (let i = 0; i < 8; i += 1) {
    const error = bezierAt(t, x1, x2) - x;
    if (Math.abs(error) < 1e-6) return t;
    const slope = bezierSlope(t, x1, x2);
    if (Math.abs(slope) < 1e-6) break;
    t -= error / slope;
  }

  let low = 0;
  let high = 1;
  t = x;
  for (let i = 0; i < 24; i += 1) {
    const value = bezierAt(t, x1, x2);
    if (Math.abs(value - x) < 1e-6) return t;
    if (value > x) high = t;
    else low = t;
    t = (low + high) / 2;
  }
  return t;
}

/** Progress 0 → 1 mapped through the easing curve. */
export function easeAt(easing: Easing, progress: number): number {
  const t = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  if (easing.kind === 'hold') return 0;
  if (easing.kind === 'linear') return t;
  if (t === 0 || t === 1) return t;

  const [x1, y1, x2, y2] = handlesOf(easing);
  return bezierAt(solveT(t, x1, x2), y1, y2);
}

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

export const sortKeyframes = (keyframes: Keyframe[]): Keyframe[] =>
  [...keyframes].sort((a, b) => a.time - b.time);

/**
 * The property's value at `time` (clip-relative seconds).
 *
 * Outside the keyframed span the value is held flat, which is what every
 * compositor does: an animation does not extrapolate past its own ends.
 */
export function evaluateKeyframes(
  keyframes: Keyframe[] | undefined,
  time: number,
  fallback: number,
): number {
  if (!keyframes || keyframes.length === 0) return fallback;

  const first = keyframes[0] as Keyframe;
  if (keyframes.length === 1 || time <= first.time) return first.value;

  const last = keyframes[keyframes.length - 1] as Keyframe;
  if (time >= last.time) return last.value;

  for (let i = 0; i < keyframes.length - 1; i += 1) {
    const a = keyframes[i] as Keyframe;
    const b = keyframes[i + 1] as Keyframe;
    if (time < a.time || time > b.time) continue;

    const span = b.time - a.time;
    if (span <= 1e-9) return b.value;

    const eased = easeAt(a.easing, (time - a.time) / span);
    return a.value + (b.value - a.value) * eased;
  }

  return last.value;
}

/** True when the channel actually drives the property. */
export const isAnimated = (keyframes: Keyframe[] | undefined): boolean =>
  Array.isArray(keyframes) && keyframes.length > 0;

/* ------------------------------------------------------------------ *
 * Sampling — for the export bridge
 * ------------------------------------------------------------------ */

export interface Breakpoint {
  time: number;
  value: number;
}

/** How finely a non-linear segment is chopped into straight pieces. */
export const EXPORT_SUBDIVISIONS = 10;

/**
 * Flattens a channel into piecewise-linear breakpoints.
 *
 * ffmpeg's expression language has no bézier solver, so an eased segment is
 * approximated by straight pieces. Ten per segment keeps the error well under a
 * pixel at any sane duration, and a linear segment needs no subdivision at all.
 */
export function sampleChannel(
  keyframes: Keyframe[],
  subdivisions = EXPORT_SUBDIVISIONS,
): Breakpoint[] {
  if (keyframes.length === 0) return [];
  if (keyframes.length === 1) {
    const only = keyframes[0] as Keyframe;
    return [{ time: only.time, value: only.value }];
  }

  const out: Breakpoint[] = [];
  for (let i = 0; i < keyframes.length - 1; i += 1) {
    const a = keyframes[i] as Keyframe;
    const b = keyframes[i + 1] as Keyframe;
    const steps = a.easing.kind === 'linear' ? 1 : a.easing.kind === 'hold' ? 1 : subdivisions;

    for (let step = 0; step < steps; step += 1) {
      const progress = step / steps;
      out.push({
        time: a.time + (b.time - a.time) * progress,
        value: a.value + (b.value - a.value) * easeAt(a.easing, progress),
      });
    }
    // A hold keeps its value right up to the next key.
    if (a.easing.kind === 'hold') {
      out.push({ time: b.time - 1e-4, value: a.value });
    }
  }

  const last = keyframes[keyframes.length - 1] as Keyframe;
  out.push({ time: last.time, value: last.value });
  return out;
}
