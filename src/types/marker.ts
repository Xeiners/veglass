/**
 * Chapter markers.
 *
 * A flag on the ruler, at a time, with a name. That is the whole model, and it
 * is deliberately not a clip: a marker occupies no track, has no duration and
 * renders nothing. It exists so a twelve-minute tutorial can be navigated by
 * its steps instead of by scrubbing, which is the difference between finding
 * "saisie du client" in a second and hunting for it.
 *
 * Markers *are* document data — they are saved, and moving or deleting one is
 * an undoable edit — so they live on `Project`. The field is optional and read
 * through {@link markersOf}, which is what lets a version 7 document carry them
 * with no migration, exactly as `clip.text.box` and `track.audio` did before.
 */

export interface Marker {
  id: string;
  /** Seconds on the timeline. */
  time: number;
  label: string;
  /** Hex, `#rrggbb`. Chapters from one run share a colour so they read as a set. */
  color: string;
  /** A longer note, shown on hover. Optional — most markers are just a name. */
  note?: string;
}

/** The palette offered when a marker is created by hand. */
export const MARKER_COLORS = [
  '#a78bfa',
  '#38bdf8',
  '#34d399',
  '#fbbf24',
  '#fb7185',
  '#f472b6',
] as const;

export const DEFAULT_MARKER_COLOR = MARKER_COLORS[0];

/**
 * The empty result, as one shared value.
 *
 * Load-bearing, not a micro-optimisation. `markersOf` is read inside a zustand
 * selector, and zustand compares what a selector returns by identity: a fresh
 * `[]` on every call is a new reference every time, which React's
 * `useSyncExternalStore` reads as "the store changed again" and turns into an
 * infinite render loop. One frozen array has one identity, so a document with
 * no markers is genuinely unchanged from one read to the next.
 *
 * Frozen because it is shared: a caller that mutated it would be mutating every
 * marker-less project at once. The `readonly` return type says the same thing
 * to the compiler — every call site copies (spread, `map`, `filter`) rather
 * than writing in place.
 */
const NONE: readonly Marker[] = Object.freeze<Marker[]>([]);

/**
 * The markers of a document that may predate them.
 *
 * Every read goes through here rather than touching the field, so a project
 * saved by an older build behaves as one with no markers rather than throwing
 * on `undefined.map`.
 */
export const markersOf = (
  project: { markers?: Marker[] } | null | undefined,
): readonly Marker[] => project?.markers ?? NONE;

/** Chronological, which is the only order a ruler can draw them in. */
export const sortMarkers = (markers: Marker[]): Marker[] =>
  [...markers].sort((a, b) => a.time - b.time);

/**
 * The marker at or just before `time`, and the one just after.
 *
 * Both directions in one pass, because the two shortcuts that use this — jump
 * back, jump forward — should never disagree about which marker the playhead is
 * currently sitting on.
 */
export function surroundingMarkers(
  markers: Marker[],
  time: number,
  epsilon = 1e-3,
): { previous: Marker | null; next: Marker | null } {
  let previous: Marker | null = null;
  let next: Marker | null = null;

  for (const marker of markers) {
    if (marker.time < time - epsilon) {
      if (!previous || marker.time > previous.time) previous = marker;
    } else if (marker.time > time + epsilon) {
      if (!next || marker.time < next.time) next = marker;
    }
  }

  return { previous, next };
}
