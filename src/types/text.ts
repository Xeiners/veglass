/**
 * Text layers.
 *
 * Sizes are expressed in **project pixels**, not screen pixels: a 72 px title
 * is 72 px of a 1920×1080 frame whatever the viewer is scaled to, and the same
 * number is what the export bakes. The preview divides by the frame scale.
 */

export type TextAlign = 'left' | 'center' | 'right';

export interface TextStroke {
  width: number;
  color: string;
}

/**
 * The plate a caption sits on.
 *
 * Absent on every layer that predates it, and `opacity: 0` means "no box" —
 * so the default costs nothing and old projects need no migration. Padding is
 * *added to* the base padding below, which the preview and the bake share so
 * the plate is the same rectangle in both.
 */
export interface TextBox {
  color: string;
  /** 0 disables the plate entirely. */
  opacity: number;
  /** Extra room around the text, in project pixels. */
  paddingX: number;
  paddingY: number;
  radius: number;
}

/**
 * The breathing room a text layer always has, in project pixels.
 *
 * Exported because the export bake has to reproduce the preview's padding
 * exactly: it draws the plate itself rather than inheriting a CSS box, and a
 * different number here would give two different rectangles.
 */
export const TEXT_PADDING_X = 6;
export const TEXT_PADDING_Y = 2;

export interface TextShadow {
  blur: number;
  offsetX: number;
  offsetY: number;
  color: string;
  opacity: number;
}

export interface TextLayer {
  content: string;
  /** Key into {@link FONTS}. */
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  color: string;
  align: TextAlign;
  lineHeight: number;
  letterSpacing: number;
  stroke: TextStroke;
  shadow: TextShadow;
  /** Absent on layers written before plates existed — read it via {@link textBox}. */
  box?: TextBox;
}

export const NO_BOX: TextBox = {
  color: '#000000',
  opacity: 0,
  paddingX: 0,
  paddingY: 0,
  radius: 0,
};

export const textBox = (layer: TextLayer): TextBox => layer.box ?? NO_BOX;

/** Whether the plate is worth drawing at all. */
export const hasBox = (box: TextBox): boolean => box.opacity > 0;

export interface FontOption {
  id: string;
  label: string;
  /** Full CSS stack — also what the bake canvas uses, so both agree. */
  stack: string;
  weights: number[];
}

/**
 * Inter is bundled with the app; the rest resolve against the system, with a
 * generic fallback so a missing face degrades rather than disappears.
 */
export const FONTS: FontOption[] = [
  {
    id: 'inter',
    label: 'Inter',
    stack: "'Inter Variable', Inter, system-ui, sans-serif",
    weights: [300, 400, 500, 600, 700, 800],
  },
  {
    id: 'system',
    label: 'Système',
    stack: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    weights: [300, 400, 600, 700],
  },
  {
    id: 'grotesk',
    label: 'Grotesque',
    stack: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    weights: [400, 500, 700],
  },
  {
    id: 'serif',
    label: 'Serif',
    stack: "Georgia, 'Times New Roman', Times, serif",
    weights: [400, 600, 700],
  },
  {
    id: 'slab',
    label: 'Slab',
    stack: "'Rockwell', 'Roboto Slab', Georgia, serif",
    weights: [400, 700],
  },
  {
    id: 'mono',
    label: 'Monospace',
    stack: "ui-monospace, 'Cascadia Mono', Consolas, 'SF Mono', monospace",
    weights: [400, 500, 700],
  },
];

export const fontOption = (id: string): FontOption =>
  FONTS.find((item) => item.id === id) ?? (FONTS[0] as FontOption);

export const DEFAULT_TEXT_DURATION = 4;

export function defaultTextLayer(content = 'Votre titre'): TextLayer {
  return {
    content,
    fontFamily: 'inter',
    fontSize: 96,
    fontWeight: 700,
    italic: false,
    color: '#FFFFFF',
    align: 'center',
    lineHeight: 1.15,
    letterSpacing: -0.02,
    stroke: { width: 0, color: '#000000' },
    shadow: { blur: 24, offsetX: 0, offsetY: 6, color: '#000000', opacity: 0.45 },
  };
}

/** CSS `font` shorthand shared by the preview and the export bake. */
export function fontShorthand(layer: TextLayer): string {
  const style = layer.italic ? 'italic ' : '';
  const family = fontOption(layer.fontFamily).stack;
  return `${style}${layer.fontWeight} ${layer.fontSize}px/${layer.lineHeight} ${family}`;
}

export function shadowCss(shadow: TextShadow): string | undefined {
  if (shadow.opacity <= 0 || (shadow.blur <= 0 && shadow.offsetX === 0 && shadow.offsetY === 0)) {
    return undefined;
  }
  return `${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blur}px ${withAlpha(shadow.color, shadow.opacity)}`;
}

/** `#RRGGBB` plus an alpha channel, as `rgba()`. */
export function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const value = Number.parseInt(full.slice(0, 6) || '000000', 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}
