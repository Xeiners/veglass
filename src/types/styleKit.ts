/**
 * Brand kits — the graphic presets a generated clip is dressed with.
 *
 * Everything here is expressed as a **fraction of the frame height**, never in
 * pixels. That is the whole reason a kit is worth having: the same preset has
 * to read the same on a 1080×1920 phone export and on a 4K master, and a kit
 * storing "72 px" would be a kit that only works at one resolution. The
 * conversion happens once, in {@link kitLayer}, against the project settings.
 *
 * A kit carries two dressings, because they do different jobs: `captions` is
 * the running word-by-word subtitle, and `hook` is the banner that holds the
 * first three seconds. They are separate on purpose — the whole point of a hook
 * is that it does not look like the subtitles underneath it.
 */

import type { SubtitleAnimation } from './ai';
import type { ProjectSettings } from './project';
import { defaultTextLayer, type TextLayer } from './text';

/** Where a block sits vertically, as the user thinks of it. */
export type KitPosition = 'top' | 'middle' | 'bottom';

/**
 * Offsets from the centre of the frame, as a fraction of its height.
 *
 * `bottom` is deliberately not the bottom: on a phone the last eighth of the
 * frame is under the platform's own interface, so a caption placed there is
 * half-hidden by a username and a row of buttons.
 */
const POSITION_OFFSET: Record<KitPosition, number> = {
  top: -0.3,
  middle: 0,
  bottom: 0.3,
};

export const POSITION_OPTIONS: { id: KitPosition; label: string }[] = [
  { id: 'top', label: 'Haut' },
  { id: 'middle', label: 'Milieu' },
  { id: 'bottom', label: 'Bas' },
];

export interface KitPlate {
  color: string;
  /** 0 means no plate at all. */
  opacity: number;
  /** Padding, as a fraction of the font size. */
  padX: number;
  padY: number;
  /** Corner radius, as a fraction of the font size. */
  radius: number;
}

export interface KitText {
  /** Key into `FONTS`. */
  fontFamily: string;
  /** Cap height as a fraction of the frame height. */
  size: number;
  weight: number;
  color: string;
  /** Fraction of the font size. 0 disables the outline. */
  strokeWidth: number;
  strokeColor: string;
  letterSpacing: number;
  lineHeight: number;
  /** Shouted captions are a style choice, so it belongs to the kit. */
  uppercase: boolean;
  plate: KitPlate;
  position: KitPosition;
}

export interface StyleKit {
  id: string;
  name: string;
  /** Shipped with the app: editable only by duplicating. */
  builtIn: boolean;
  captions: KitText;
  hook: KitText;
  /** Entrance applied to each caption piece. */
  animation: SubtitleAnimation;
}

/* ------------------------------------------------------------------ *
 * Rendering a kit against a frame
 * ------------------------------------------------------------------ */

export interface KitStyle {
  text: TextLayer;
  /** Offset from the centre of the frame, in project pixels. */
  y: number;
}

/**
 * A kit's fractions, resolved into a real text layer for these settings.
 *
 * The floor on the frame height stops a malformed project (height 0, or a
 * half-written settings object) from producing a zero-sized font that would
 * render as nothing at all and read as a bug in the generator.
 */
export function kitLayer(part: KitText, settings: ProjectSettings): KitStyle {
  const height = Math.max(settings.height, 240);
  const fontSize = Math.max(8, Math.round(height * part.size));
  const base = defaultTextLayer('');

  return {
    text: {
      ...base,
      fontFamily: part.fontFamily,
      fontSize,
      fontWeight: part.weight,
      color: part.color,
      letterSpacing: part.letterSpacing,
      lineHeight: part.lineHeight,
      stroke: {
        width: part.strokeWidth > 0 ? Math.max(1, Math.round(fontSize * part.strokeWidth)) : 0,
        color: part.strokeColor,
      },
      shadow: {
        // A plate already separates the text from the picture; a shadow on top
        // of one only muddies its edge.
        blur: part.plate.opacity > 0 ? 0 : Math.round(fontSize * 0.3),
        offsetX: 0,
        offsetY: part.plate.opacity > 0 ? 0 : Math.round(fontSize * 0.06),
        color: '#000000',
        opacity: part.plate.opacity > 0 ? 0 : 0.5,
      },
      box: {
        color: part.plate.color,
        opacity: part.plate.opacity,
        paddingX: Math.round(fontSize * part.plate.padX),
        paddingY: Math.round(fontSize * part.plate.padY),
        radius: Math.round(fontSize * part.plate.radius),
      },
    },
    y: Math.round(height * POSITION_OFFSET[part.position]),
  };
}

/** The kit's own transform on a line of text. */
export const kitText = (part: KitText, content: string): string =>
  part.uppercase ? content.toLocaleUpperCase() : content;

/* ------------------------------------------------------------------ *
 * What ships with the app
 * ------------------------------------------------------------------ */

const NO_PLATE: KitPlate = { color: '#000000', opacity: 0, padX: 0, padY: 0, radius: 0 };

export const BUILT_IN_KITS: StyleKit[] = [
  {
    id: 'hormozi',
    name: 'Hormozi / Fluo',
    builtIn: true,
    animation: 'punch',
    captions: {
      fontFamily: 'inter',
      size: 0.062,
      weight: 800,
      color: '#FFFFFF',
      strokeWidth: 0.075,
      strokeColor: '#000000',
      letterSpacing: -0.02,
      lineHeight: 1.05,
      uppercase: true,
      plate: NO_PLATE,
      position: 'middle',
    },
    hook: {
      fontFamily: 'inter',
      size: 0.072,
      weight: 800,
      color: '#0B0B0B',
      strokeWidth: 0,
      strokeColor: '#000000',
      letterSpacing: -0.03,
      lineHeight: 1.02,
      uppercase: true,
      plate: { color: '#FFE500', opacity: 1, padX: 0.26, padY: 0.16, radius: 0.14 },
      position: 'top',
    },
  },
  {
    id: 'minimal',
    name: 'Minimaliste Blanc',
    builtIn: true,
    animation: 'fade',
    captions: {
      fontFamily: 'inter',
      size: 0.046,
      weight: 600,
      color: '#FFFFFF',
      strokeWidth: 0.028,
      strokeColor: '#000000',
      letterSpacing: -0.005,
      lineHeight: 1.2,
      uppercase: false,
      plate: NO_PLATE,
      position: 'bottom',
    },
    hook: {
      fontFamily: 'inter',
      size: 0.052,
      weight: 500,
      color: '#FFFFFF',
      strokeWidth: 0,
      strokeColor: '#000000',
      letterSpacing: -0.015,
      lineHeight: 1.15,
      uppercase: false,
      plate: { color: '#000000', opacity: 0.62, padX: 0.3, padY: 0.2, radius: 0.1 },
      position: 'top',
    },
  },
  {
    id: 'pop',
    name: 'Pop Dynamique',
    builtIn: true,
    animation: 'pop',
    captions: {
      fontFamily: 'inter',
      size: 0.056,
      weight: 700,
      color: '#FFFFFF',
      strokeWidth: 0,
      strokeColor: '#000000',
      letterSpacing: -0.02,
      lineHeight: 1.08,
      uppercase: false,
      plate: { color: '#7C3AED', opacity: 0.92, padX: 0.22, padY: 0.12, radius: 0.24 },
      position: 'middle',
    },
    hook: {
      fontFamily: 'inter',
      size: 0.07,
      weight: 800,
      color: '#111018',
      strokeWidth: 0,
      strokeColor: '#000000',
      letterSpacing: -0.035,
      lineHeight: 1.0,
      uppercase: false,
      plate: { color: '#31E1A6', opacity: 1, padX: 0.24, padY: 0.15, radius: 0.3 },
      position: 'top',
    },
  },
];

export const DEFAULT_KIT_ID = 'hormozi';

/** How long the opening banner holds, in seconds. */
export const HOOK_SECONDS = 3;

/** Track name for the opening banners, reused rather than stacked. */
export const HOOK_TRACK_NAME = 'Accroches';

export const findKit = (kits: StyleKit[], id: string): StyleKit =>
  kits.find((kit) => kit.id === id) ??
  (BUILT_IN_KITS.find((kit) => kit.id === id) ?? (BUILT_IN_KITS[0] as StyleKit));

/** A deep copy, so editing a duplicate never reaches the kit it came from. */
export function cloneKit(source: StyleKit, id: string, name: string): StyleKit {
  return {
    id,
    name,
    builtIn: false,
    animation: source.animation,
    captions: { ...source.captions, plate: { ...source.captions.plate } },
    hook: { ...source.hook, plate: { ...source.hook.plate } },
  };
}
