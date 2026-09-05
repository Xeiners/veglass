/**
 * The SVG filters the viewer needs for effects CSS has no function for.
 *
 * Two consumers, one string. The preview drops the markup into an `<svg>` it
 * keeps beside the layer; the export bake mounts the same markup in the
 * document for as long as it takes to draw one frame, because a canvas
 * `ctx.filter` of `url(#…)` resolves against the document like any other filter
 * reference. Building the markup once, here, is what stops the two from
 * drifting — the alternative was a React tree and a DOM builder that had to be
 * kept saying the same thing by hand.
 *
 * # Two details that are not decoration
 *
 * `color-interpolation-filters="sRGB"` is on every filter. The SVG default is
 * **linearRGB**, and a blur or an offset computed in linear light gives visibly
 * different edges from one computed on the encoded values — which is what
 * ffmpeg does. Leaving the default in place would be a parity break that only
 * showed up on high-contrast edges, which is exactly where these effects live.
 *
 * The filter region is grown well past the source box. A channel shifted twenty
 * pixels sideways, or a blur with a long tail, is clipped to the default
 * -10 %/120 % region and loses its fringe at the frame edge; the encoder clips
 * to the frame instead. The margin is derived from the filter's own numbers so
 * it is always enough and never more than that.
 */

import type { SvgFilterSpec } from '@/types/effects';

/** Numbers in markup, at a precision finer than any screen resolves. */
const n = (value: number): string => (Number.isFinite(value) ? value.toFixed(2) : '0');

/**
 * The channel isolation matrices.
 *
 * Each keeps one colour channel and zeroes the other two, and each keeps alpha —
 * so the three layers recombine over the same silhouette rather than three
 * offset ones.
 */
const KEEP_RED = '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0';
const KEEP_GREEN = '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0';
const KEEP_BLUE = '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0';

/**
 * How far outside its box a filter is allowed to paint, as a fraction.
 *
 * A percentage of the box rather than an absolute margin, because that is the
 * only unit the region accepts without pinning the filter to one element size.
 * Converted from the effect's own pixels against a conservative assumed width,
 * so a large shift on a small preview still has room.
 */
function region(margin: number): string {
  // 4 % of a 640-pixel stage is 25 pixels, which covers the usual case; beyond
  // that the margin grows with the number that needs it.
  const percent = Math.min(40, Math.max(4, (margin / 640) * 100 + 2));
  return `x="${-percent}%" y="${-percent}%" width="${100 + 2 * percent}%" height="${100 + 2 * percent}%"`;
}

/**
 * One filter's markup.
 *
 * The split is three isolated channels recombined with `screen`. Screen is
 * addition for values that do not overlap, and these do not: each layer holds
 * exactly one channel, so the recombination puts each back where it belongs
 * without the clipping a plain addition would risk.
 */
function filterMarkup(spec: SvgFilterSpec): string {
  if (spec.kind === 'motionblur') {
    const margin = Math.max(spec.x, spec.y) * 3;
    return (
      `<filter id="${spec.id}" ${region(margin)} color-interpolation-filters="sRGB">` +
      `<feGaussianBlur in="SourceGraphic" stdDeviation="${n(spec.x)} ${n(spec.y)}"/>` +
      `</filter>`
    );
  }

  const { dx, dy } = spec;
  return (
    `<filter id="${spec.id}" ${region(Math.max(Math.abs(dx), Math.abs(dy)))} color-interpolation-filters="sRGB">` +
    `<feOffset in="SourceGraphic" dx="${n(dx)}" dy="${n(dy)}" result="rOff"/>` +
    `<feColorMatrix in="rOff" type="matrix" values="${KEEP_RED}" result="r"/>` +
    `<feColorMatrix in="SourceGraphic" type="matrix" values="${KEEP_GREEN}" result="g"/>` +
    `<feOffset in="SourceGraphic" dx="${n(-dx)}" dy="${n(-dy)}" result="bOff"/>` +
    `<feColorMatrix in="bOff" type="matrix" values="${KEEP_BLUE}" result="b"/>` +
    `<feBlend in="r" in2="g" mode="screen" result="rg"/>` +
    `<feBlend in="rg" in2="b" mode="screen"/>` +
    `</filter>`
  );
}

/** The `<defs>` body for a set of filters — the one source both consumers read. */
export const filterDefs = (specs: SvgFilterSpec[]): string =>
  specs.map(filterMarkup).join('');

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Runs `draw` with `specs` mounted in the document, then takes them away again.
 *
 * The export bake needs this because a canvas resolves `url(#…)` against the
 * document it lives in, and the layer being baked is very often not the one the
 * preview is showing — so the filter it names is nowhere on the page.
 *
 * Removal happens in a `finally`: a bake that throws half way through must not
 * leave its filters behind, or a long export slowly fills the document with the
 * leftovers of every frame it drew.
 */
export async function withMountedFilters<T>(
  specs: SvgFilterSpec[],
  draw: () => Promise<T>,
): Promise<T> {
  if (specs.length === 0) return draw();

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  // Out of flow and out of the way: the element exists to be referenced, never
  // to be seen, and a zero-sized absolute box cannot disturb a layout.
  svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');

  const defs = document.createElementNS(SVG_NS, 'defs');
  defs.innerHTML = filterDefs(specs);
  svg.appendChild(defs);
  document.body.appendChild(svg);

  try {
    return await draw();
  } finally {
    svg.remove();
  }
}
