/**
 * Drawing a banner. Once.
 *
 * The whole module exists so there is exactly **one** piece of code that turns
 * a `BannerLayer` into pixels, and both the viewer and the export bake call it.
 * `paintBanner` works in project pixels around an origin at the banner's
 * centre, which is the same coordinate space `bake.ts` already establishes
 * after `applyTransform` — so the export is identical to the preview by
 * construction rather than by agreement.
 *
 * # Why this is a canvas in the preview too
 *
 * Text layers take the other road: DOM in the viewer, canvas in the bake, kept
 * in step by shared constants (`TEXT_PADDING_X`, `fontShorthand`, `withAlpha`).
 * That works, but it is a standing invitation for the two to drift — the plate
 * behind a caption is the one place in this app where preview-versus-export
 * agreement rests on two implementations being written to match, and nobody has
 * ever compared the two renders pixel for pixel.
 *
 * A banner is a plate, a border, an accent bar, two type sizes and a row of
 * keycaps. Reproducing that twice would be five more chances to drift. So it is
 * drawn once, on a canvas, in both places — which makes the agreement a fact
 * about the code rather than a claim about it.
 *
 * # Measuring
 *
 * A banner shrink-wraps its content, so its size is a text measurement.
 * `measureBanner` uses a module-level offscreen context; where there is no DOM
 * at all it falls back to an estimate from the character count rather than
 * throwing, so placement logic stays testable headlessly and a banner is never
 * the reason an export dies.
 */

import { fontOption } from '@/types/text';
import { withAlpha } from '@/types/text';
import {
  keysOf,
  subtitleText,
  titleSizeOf,
  type BannerLayer,
} from '@/types/banner';
import type { ProjectSettings } from '@/types/project';

/* ------------------------------------------------------------------ *
 * Type
 * ------------------------------------------------------------------ */

/** The `font` shorthand for one half of a banner. */
function fontOf(layer: BannerLayer, size: number, weight: number): string {
  return `${weight} ${size}px ${fontOption(layer.fontFamily).stack}`;
}

/**
 * Chromium honours `letterSpacing` in `measureText`, which is exactly why it is
 * set before measuring and not only before drawing: a tracked-in title measured
 * without it would get a plate too wide for its text.
 */
function armType(
  ctx: CanvasRenderingContext2D,
  layer: BannerLayer,
  size: number,
  weight: number,
): void {
  ctx.font = fontOf(layer, size, weight);
  if ('letterSpacing' in ctx) {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
      `${layer.letterSpacing}em`;
  }
}

/**
 * The shared measuring surface.
 *
 * One 1×1 canvas for the life of the page: `measureText` needs a context, not
 * a drawable area, and creating one per call would allocate a canvas per
 * keystroke while someone types a title.
 */
let scratch: CanvasRenderingContext2D | null | undefined;

function measuringContext(): CanvasRenderingContext2D | null {
  if (scratch !== undefined) return scratch;
  try {
    scratch = document.createElement('canvas').getContext('2d');
  } catch {
    scratch = null;
  }
  return scratch;
}

/**
 * How wide a string is, in project pixels.
 *
 * The fallback is a deliberate approximation, not a guess at correctness: with
 * no canvas there is no typography either, and 0.54 em per character is close
 * enough for a placement decision that the user can then drag.
 */
function widthOf(layer: BannerLayer, text: string, size: number, weight: number): number {
  if (text.length === 0) return 0;
  const ctx = measuringContext();
  if (!ctx) return text.length * size * 0.54;

  ctx.save();
  armType(ctx, layer, size, weight);
  const width = ctx.measureText(text).width;
  ctx.restore();
  return width;
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/** One keyboard cap, and the room it needs. */
export interface Keycap {
  label: string;
  width: number;
}

/**
 * Everything the painter needs, resolved into project pixels.
 *
 * Computed once and handed to `paintBanner` so the viewer can size its canvas
 * from the same numbers the drawing will use — a banner measured one way and
 * drawn another would be clipped at its own edge.
 */
export interface BannerMetrics {
  width: number;
  height: number;
  titleSize: number;
  subtitleSize: number;
  padX: number;
  padY: number;
  radius: number;
  borderWidth: number;
  accentWidth: number;
  /** Room between the accent bar and the text. */
  accentGap: number;
  /** Vertical room between title and subtitle. */
  gap: number;
  /** Distance from the banner's left edge to where the text starts. */
  contentLeft: number;
  contentWidth: number;
  titleLine: number;
  subtitleLine: number;
  /** Present only when the subtitle is drawn as keys. */
  caps: Keycap[] | null;
  capHeight: number;
  capGap: number;
}

/** Space either side of a key's label inside its cap. */
const CAP_PAD = 0.42;
/** Space between two caps, including the `+` that sits between them. */
const CAP_GAP = 0.52;

/**
 * The banner's box, and every measurement inside it.
 *
 * Pure given a document: the same layer and the same settings always give the
 * same numbers, which is what lets the viewer, the bake and the placement code
 * all agree without passing geometry between themselves.
 */
export function measureBanner(layer: BannerLayer, settings: ProjectSettings): BannerMetrics {
  const titleSize = titleSizeOf(layer, settings);
  const subtitleSize = Math.max(8, Math.round(titleSize * layer.subtitleRatio));

  const padX = titleSize * layer.padX;
  const padY = titleSize * layer.padY;
  const accentWidth = titleSize * layer.accentWidth;
  const accentGap = accentWidth > 0 ? titleSize * 0.42 : 0;
  const gap = titleSize * 0.18;

  const title = layer.title.trim();
  const subtitle = subtitleText(layer).trim();

  const titleWidth = widthOf(layer, title, titleSize, layer.titleWeight);
  const titleLine = title.length > 0 ? titleSize * 1.16 : 0;

  let caps: Keycap[] | null = null;
  let subtitleWidth = 0;
  let subtitleLine = 0;
  const capHeight = subtitleSize * 1.62;
  const capGap = subtitleSize * CAP_GAP;

  if (subtitle.length > 0) {
    if (layer.keycaps) {
      caps = keysOf(subtitle).map((label) => ({
        label,
        width: widthOf(layer, label, subtitleSize, layer.subtitleWeight) + subtitleSize * CAP_PAD * 2,
      }));
      subtitleWidth =
        caps.reduce((total, cap) => total + cap.width, 0) + Math.max(0, caps.length - 1) * capGap;
      subtitleLine = caps.length > 0 ? capHeight : 0;
    } else {
      subtitleWidth = widthOf(layer, subtitle, subtitleSize, layer.subtitleWeight);
      subtitleLine = subtitleSize * 1.3;
    }
  }

  const contentWidth = Math.max(titleWidth, subtitleWidth);
  const stacked = titleLine + (titleLine > 0 && subtitleLine > 0 ? gap : 0) + subtitleLine;

  return {
    width: Math.round(padX * 2 + accentWidth + accentGap + contentWidth),
    height: Math.round(padY * 2 + stacked),
    titleSize,
    subtitleSize,
    padX,
    padY,
    radius: titleSize * layer.radius,
    borderWidth: titleSize * layer.borderWidth,
    accentWidth,
    accentGap,
    gap,
    contentLeft: padX + accentWidth + accentGap,
    contentWidth,
    titleLine,
    subtitleLine,
    caps,
    capHeight,
    capGap,
  };
}

/**
 * Where the banner sits in the frame, as an offset from its centre.
 *
 * This is what `clip.x` and `clip.y` are initialised to. Expressed against the
 * measured box so the banner hugs the margin it was designed with rather than
 * overhanging on a long title — and once placed, it is the user's to move like
 * any other layer.
 */
export function bannerOffset(
  layer: BannerLayer,
  settings: ProjectSettings,
  metrics = measureBanner(layer, settings),
): { x: number; y: number } {
  const margin = Math.round(Math.max(settings.height, 240) * layer.margin);

  const half = { x: settings.width / 2, y: settings.height / 2 };
  const x =
    layer.side === 'left'
      ? -half.x + margin + metrics.width / 2
      : half.x - margin - metrics.width / 2;

  const y =
    layer.anchor === 'top'
      ? -half.y + margin + metrics.height / 2
      : layer.anchor === 'bottom'
        ? half.y - margin - metrics.height / 2
        : 0;

  return { x: Math.round(x), y: Math.round(y) };
}

/* ------------------------------------------------------------------ *
 * Painting
 * ------------------------------------------------------------------ */

/** `roundRect` where the engine has it, a plain rectangle where it does not. */
function pathRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const capped = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  // Square corners are a worse plate, not a broken one — and an older engine
  // throwing here would take the whole export down with it.
  if (capped > 0 && typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, capped);
  } else {
    ctx.rect(x, y, width, height);
  }
}

/**
 * Draws the banner centred on the current origin, in project pixels.
 *
 * The caller owns the transform. `bake.ts` has already applied the clip's
 * position, scale and rotation; the viewer has applied its own display scale.
 * Neither is this function's business, which is precisely what lets one
 * implementation serve both.
 */
export function paintBanner(
  ctx: CanvasRenderingContext2D,
  layer: BannerLayer,
  settings: ProjectSettings,
  metrics = measureBanner(layer, settings),
): void {
  const { width, height } = metrics;
  const left = -width / 2;
  const top = -height / 2;

  ctx.save();

  /* ---- plate ---- */
  if (layer.plateOpacity > 0) {
    ctx.fillStyle = withAlpha(layer.plateColor, layer.plateOpacity);
    pathRect(ctx, left, top, width, height, metrics.radius);
    ctx.fill();
  }

  /* ---- border ---- */
  if (metrics.borderWidth > 0) {
    // Inset by half the stroke: a stroke straddles its path, and drawing it on
    // the plate's own edge would put half of it outside the measured box.
    const inset = metrics.borderWidth / 2;
    ctx.lineWidth = metrics.borderWidth;
    ctx.strokeStyle = layer.borderColor;
    pathRect(
      ctx,
      left + inset,
      top + inset,
      width - metrics.borderWidth,
      height - metrics.borderWidth,
      Math.max(0, metrics.radius - inset),
    );
    ctx.stroke();
  }

  /* ---- accent bar ---- */
  if (metrics.accentWidth > 0) {
    const barTop = top + metrics.padY * 0.55;
    const barHeight = height - metrics.padY * 1.1;
    const barLeft =
      layer.side === 'left'
        ? left + metrics.padX * 0.55
        : left + width - metrics.padX * 0.55 - metrics.accentWidth;

    ctx.fillStyle = layer.accentColor;
    pathRect(ctx, barLeft, barTop, metrics.accentWidth, barHeight, metrics.accentWidth / 2);
    ctx.fill();
  }

  /* ---- text ---- */
  // The accent bar swaps sides with the banner, so the text block does too.
  const textLeft =
    layer.side === 'left' ? left + metrics.contentLeft : left + metrics.padX;
  const stacked =
    metrics.titleLine +
    (metrics.titleLine > 0 && metrics.subtitleLine > 0 ? metrics.gap : 0) +
    metrics.subtitleLine;
  let cursor = -stacked / 2;

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  const title = layer.title.trim();
  if (title.length > 0) {
    armType(ctx, layer, metrics.titleSize, layer.titleWeight);
    ctx.fillStyle = layer.titleColor;
    ctx.fillText(title, textLeft, cursor + metrics.titleLine / 2);
    cursor += metrics.titleLine + metrics.gap;
  }

  const subtitle = subtitleText(layer).trim();
  if (subtitle.length === 0) {
    ctx.restore();
    return;
  }

  if (metrics.caps) {
    paintKeycaps(ctx, layer, metrics, textLeft, cursor + metrics.capHeight / 2);
  } else {
    armType(ctx, layer, metrics.subtitleSize, layer.subtitleWeight);
    ctx.fillStyle = layer.subtitleColor;
    ctx.fillText(subtitle, textLeft, cursor + metrics.subtitleLine / 2);
  }

  ctx.restore();
}

/**
 * The keyboard caps, and the `+` between them.
 *
 * Each cap is a light rounded plate with the key's own label on it, which is
 * the convention every piece of software documentation uses — a shortcut
 * written as plain text reads as prose, and a shortcut drawn as keys reads as
 * something you press.
 */
function paintKeycaps(
  ctx: CanvasRenderingContext2D,
  layer: BannerLayer,
  metrics: BannerMetrics,
  left: number,
  middle: number,
): void {
  const caps = metrics.caps ?? [];
  const top = middle - metrics.capHeight / 2;
  let x = left;

  caps.forEach((cap, index) => {
    ctx.fillStyle = layer.subtitleColor === '#FFFFFF' ? '#E8ECF2' : '#F1F4F8';
    pathRect(ctx, x, top, cap.width, metrics.capHeight, metrics.subtitleSize * 0.32);
    ctx.fill();

    // A hairline under the cap is what makes it read as a key rather than as a
    // white rectangle; it is the printed convention, at one pixel of depth.
    ctx.strokeStyle = withAlpha('#0B0E13', 0.22);
    ctx.lineWidth = Math.max(1, metrics.subtitleSize * 0.06);
    ctx.stroke();

    armType(ctx, layer, metrics.subtitleSize, layer.subtitleWeight);
    ctx.fillStyle = layer.subtitleColor;
    ctx.textAlign = 'center';
    ctx.fillText(cap.label, x + cap.width / 2, middle);
    ctx.textAlign = 'left';

    x += cap.width;

    if (index < caps.length - 1) {
      armType(ctx, layer, metrics.subtitleSize * 0.9, 500);
      ctx.fillStyle = withAlpha(layer.titleColor, 0.7);
      ctx.textAlign = 'center';
      ctx.fillText('+', x + metrics.capGap / 2, middle);
      ctx.textAlign = 'left';
      x += metrics.capGap;
    }
  });
}
