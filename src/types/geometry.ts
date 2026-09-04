/**
 * A point on a picture, as a fraction of it.
 *
 * `0 → 1` across the source, y downwards, independent of any resolution. Its
 * own file because three unrelated things now speak in these coordinates — the
 * model naming where it clicked, the virtual camera deciding where to look, and
 * the crop tool deciding what to keep — and a coordinate convention shared by
 * three subsystems deserves one definition rather than three that happen to
 * match.
 */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** The middle of the picture — the only defensible default anchor. */
export const CENTRE: ScreenPoint = { x: 0.5, y: 0.5 };
