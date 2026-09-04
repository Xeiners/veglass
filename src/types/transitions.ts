/**
 * Transitions.
 *
 * A transition is anchored to a *junction* — a point where two clips meet on
 * the same track — or to the open head/tail of a track. It stores neighbour ids
 * rather than an absolute time, so moving or trimming clips carries it along;
 * a transition whose neighbours drift apart is pruned by the store.
 */

export type TransitionKind = 'crossfade' | 'dip-black' | 'dip-white';

export interface Transition {
  id: string;
  kind: TransitionKind;
  trackId: string;
  /** Outgoing clip. `null` means a fade-in at the head of `toClipId`. */
  fromClipId: string | null;
  /** Incoming clip. `null` means a fade-out at the tail of `fromClipId`. */
  toClipId: string | null;
  /** Total length of the transition window, in seconds. */
  duration: number;
}

export interface TransitionDescriptor {
  kind: TransitionKind;
  label: string;
  hint: string;
  /** A dissolve needs material on both sides; a dip does not. */
  requiresJunction: boolean;
  /** Colour dipped through, or `null` for a true dissolve between two layers. */
  veil: string | null;
  /** Swatch used by the library chip and the timeline block. */
  swatch: string;
}

export const TRANSITIONS: TransitionDescriptor[] = [
  {
    kind: 'crossfade',
    label: 'Fondu enchaîné',
    hint: 'Les deux plans se superposent',
    requiresJunction: true,
    veil: null,
    swatch: 'linear-gradient(90deg, #4F46E5, #7C3AED)',
  },
  {
    kind: 'dip-black',
    label: 'Fondu au noir',
    hint: 'Passe par le noir — aussi en ouverture / fermeture',
    requiresJunction: false,
    veil: '#000000',
    swatch: 'linear-gradient(90deg, #7C3AED, #08090B)',
  },
  {
    kind: 'dip-white',
    label: 'Fondu au blanc',
    hint: 'Passe par le blanc',
    requiresJunction: false,
    veil: '#FFFFFF',
    swatch: 'linear-gradient(90deg, #7C3AED, #FFFFFF)',
  },
];

export const transitionDescriptor = (kind: TransitionKind): TransitionDescriptor =>
  TRANSITIONS.find((item) => item.kind === kind) ?? (TRANSITIONS[0] as TransitionDescriptor);

export const DEFAULT_TRANSITION_DURATION = 0.8;
export const MIN_TRANSITION_DURATION = 0.1;

/** Where a transition may be dropped. */
export interface TransitionAnchor {
  /** Stable across renders so the drop target can be compared cheaply. */
  id: string;
  trackId: string;
  /** Junction point on the timeline, in seconds. */
  time: number;
  fromClipId: string | null;
  toClipId: string | null;
  /** Longest window the neighbouring material can absorb. */
  maxDuration: number;
}

export const isJunction = (anchor: TransitionAnchor): boolean =>
  anchor.fromClipId !== null && anchor.toClipId !== null;
