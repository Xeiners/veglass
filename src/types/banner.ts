/**
 * Lower thirds and chapter banners.
 *
 * A banner is a *recipe*, not a picture and not a text layer. Like a generated
 * background it carries only the parameters it is drawn from, and the drawing
 * happens in one place — `lib/bannerPainter` — which both the viewer and the
 * export bake call. That is the whole reason this is a fourth `ClipKind` rather
 * than a dressed-up `TextLayer`.
 *
 * Two things a text layer genuinely cannot express, and both are the point of
 * the feature:
 *
 * * **Two strings with different roles.** A title and a subtitle are not one
 *   string with a newline in it: they take different sizes, different weights,
 *   different colours, and the subtitle is often uppercased while the title is
 *   not. Encoding that as `"Étape 1\nCTRL + S"` would mean the renderer had to
 *   guess which line was which.
 * * **A composed shape.** A plate, a hairline border and a vertical accent bar
 *   are three rectangles with a relationship to the text box, not a `box`
 *   behind a paragraph.
 *
 * # Fractions, never pixels
 *
 * Every measurement here is a fraction — of the frame height for the type size,
 * of the type size for everything else. Same reasoning as `types/styleKit`, and
 * it is what lets one preset read identically on a 720p draft and a 4K master.
 * The conversion happens once, in the painter, against `ProjectSettings`.
 */

import type { ProjectSettings } from './project';

export type BannerPreset = 'saas' | 'corporate' | 'shortcut';

/** Which edge the banner hugs — and therefore which side it slides in from. */
export type BannerSide = 'left' | 'right';

export type BannerAnchor = 'top' | 'middle' | 'bottom';

export interface BannerLayer {
  /** The preset it was built from. Kept so the picker can show what it is. */
  preset: BannerPreset;

  title: string;
  /** Empty is legitimate: a one-line banner is a common, deliberate look. */
  subtitle: string;

  fontFamily: string;
  /** Title cap height, as a fraction of the frame height. */
  size: number;
  titleWeight: number;
  titleColor: string;
  /** Subtitle size, as a fraction of the title size. */
  subtitleRatio: number;
  subtitleWeight: number;
  subtitleColor: string;
  /** Subtitles in these designs are usually shouted; titles never are. */
  uppercaseSubtitle: boolean;
  letterSpacing: number;

  /* ---- the shape ---- */
  plateColor: string;
  /** 0 draws no plate at all — the text then floats, which some looks want. */
  plateOpacity: number;
  /** Corner radius, as a fraction of the title size. */
  radius: number;
  /** Hairline around the plate. 0 disables it. Fraction of the title size. */
  borderWidth: number;
  borderColor: string;
  /** The vertical accent bar. 0 disables it. Fraction of the title size. */
  accentWidth: number;
  accentColor: string;

  /* ---- layout ---- */
  /** Inner padding, as fractions of the title size. */
  padX: number;
  padY: number;
  side: BannerSide;
  anchor: BannerAnchor;
  /** Distance from the frame edge, as a fraction of the frame height. */
  margin: number;

  /**
   * Draw the subtitle as keyboard caps rather than as a line of text.
   *
   * Data rather than a check on `preset === 'shortcut'`: someone who wants
   * keycaps on the corporate plate should get them, and the painter should not
   * have to know which preset it is drawing.
   */
  keycaps: boolean;

  /* ---- motion ---- */
  /** Seconds the banner takes to arrive. 0 means it simply appears. */
  entrance: number;
  /** How far it travels in, as a fraction of its own width. */
  travel: number;
}

/** The token separator in a shortcut, as someone would type it. */
export const KEY_SEPARATOR = '+';

/**
 * The keys of a shortcut, in the order they are pressed.
 *
 * Deliberately forgiving about spacing — `Ctrl+S`, `Ctrl + S` and `ctrl  +  s`
 * are the same shortcut, and a model or a user typing any of the three should
 * get the same three caps.
 */
export const keysOf = (subtitle: string): string[] =>
  subtitle
    .split(KEY_SEPARATOR)
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

/* ------------------------------------------------------------------ *
 * The presets
 * ------------------------------------------------------------------ */

export interface BannerPresetOption {
  id: BannerPreset;
  label: string;
  hint: string;
  /** Sample content for the picker, so a card shows a real banner. */
  sample: { title: string; subtitle: string };
}

/** Everything a preset fixes — the content is what the caller supplies. */
type BannerStyle = Omit<BannerLayer, 'title' | 'subtitle'>;

/**
 * The look of a modern developer-tools product: near-black glass, one hairline
 * of emerald, and nothing else competing for attention. The accent bar is the
 * only saturated thing on screen, which is what makes it read as a mark rather
 * than as decoration.
 */
const SAAS: BannerStyle = {
  preset: 'saas',
  fontFamily: 'inter',
  size: 0.042,
  titleWeight: 600,
  titleColor: '#F4F7F9',
  subtitleRatio: 0.62,
  subtitleWeight: 500,
  subtitleColor: '#7FE7C4',
  uppercaseSubtitle: false,
  letterSpacing: -0.015,
  plateColor: '#0B1015',
  plateOpacity: 0.82,
  radius: 0.22,
  borderWidth: 0.032,
  borderColor: '#31E1A6',
  accentWidth: 0.11,
  accentColor: '#31E1A6',
  padX: 0.62,
  padY: 0.46,
  side: 'left',
  anchor: 'bottom',
  margin: 0.085,
  keycaps: false,
  entrance: 0.42,
  travel: 0.35,
};

/**
 * The look of a corporate training deck: deep navy, generous type, and a
 * subtitle set small and uppercase so it reads as a label rather than as a
 * second sentence. No border — the plate is opaque enough not to need one.
 */
const CORPORATE: BannerStyle = {
  preset: 'corporate',
  fontFamily: 'inter',
  size: 0.05,
  titleWeight: 700,
  titleColor: '#FFFFFF',
  subtitleRatio: 0.44,
  subtitleWeight: 600,
  subtitleColor: '#9DB2D4',
  uppercaseSubtitle: true,
  letterSpacing: -0.02,
  plateColor: '#0E1A33',
  plateOpacity: 0.93,
  radius: 0.14,
  borderWidth: 0,
  borderColor: '#FFFFFF',
  accentWidth: 0.16,
  accentColor: '#4C8DFF',
  padX: 0.7,
  padY: 0.52,
  side: 'left',
  anchor: 'bottom',
  margin: 0.1,
  keycaps: false,
  entrance: 0.5,
  travel: 0.28,
};

/**
 * The shortcut badge: compact, centred low, and built around keycaps.
 *
 * Smaller than the other two on purpose. It appears *during* a manipulation
 * rather than between chapters, so it has to be readable without taking the
 * eye off what the mouse is doing.
 */
const SHORTCUT: BannerStyle = {
  preset: 'shortcut',
  fontFamily: 'inter',
  size: 0.03,
  titleWeight: 500,
  titleColor: '#C9D2DE',
  subtitleRatio: 0.92,
  subtitleWeight: 600,
  subtitleColor: '#1A1F27',
  uppercaseSubtitle: false,
  letterSpacing: 0,
  plateColor: '#0B0E13',
  plateOpacity: 0.86,
  radius: 0.34,
  borderWidth: 0.028,
  borderColor: '#FFFFFF',
  accentWidth: 0,
  accentColor: '#FFFFFF',
  padX: 0.55,
  padY: 0.42,
  side: 'left',
  anchor: 'bottom',
  margin: 0.06,
  keycaps: true,
  entrance: 0.3,
  travel: 0.18,
};

const STYLES: Record<BannerPreset, BannerStyle> = {
  saas: SAAS,
  corporate: CORPORATE,
  shortcut: SHORTCUT,
};

export const BANNER_PRESETS: BannerPresetOption[] = [
  {
    id: 'saas',
    label: 'Modern SaaS',
    hint: 'Verre sombre, filet émeraude — pour un logiciel',
    sample: { title: 'Créer une fiche client', subtitle: 'Module Ventes' },
  },
  {
    id: 'corporate',
    label: 'Corporate',
    hint: 'Bleu nuit, typographie large, intertitre en capitales',
    sample: { title: 'Saisie de la caisse', subtitle: 'Étape 1 sur 6' },
  },
  {
    id: 'shortcut',
    label: 'Raccourci',
    hint: 'Badge compact à touches clavier',
    sample: { title: 'Enregistrer', subtitle: 'Ctrl + S' },
  },
];

export const presetOption = (id: BannerPreset): BannerPresetOption =>
  BANNER_PRESETS.find((item) => item.id === id) ?? (BANNER_PRESETS[0] as BannerPresetOption);

/** A banner built from a preset, with content. */
export function bannerFromPreset(
  preset: BannerPreset,
  content?: { title?: string; subtitle?: string },
): BannerLayer {
  const style = STYLES[preset] ?? SAAS;
  const sample = presetOption(preset).sample;
  return {
    ...style,
    title: content?.title ?? sample.title,
    subtitle: content?.subtitle ?? sample.subtitle,
  };
}

/**
 * Re-dresses a banner with another preset, keeping what the user wrote.
 *
 * Switching template must never silently discard a title someone typed — that
 * is the one thing a preset picker can do that is unforgivable.
 */
export const redress = (layer: BannerLayer, preset: BannerPreset): BannerLayer => ({
  ...(STYLES[preset] ?? SAAS),
  title: layer.title,
  subtitle: layer.subtitle,
});

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

/** How long a banner holds by default, in seconds. */
export const DEFAULT_BANNER_DURATION = 4.5;

/** Shortest a banner may be trimmed to and still be readable. */
export const MIN_BANNER_DURATION = 1;

/** Track name for generated banners, reused rather than stacked. */
export const BANNER_TRACK_NAME = 'Habillages';

/**
 * The title size in project pixels.
 *
 * Floored against a malformed settings object for the same reason `kitLayer`
 * is: a zero-height frame would give a zero-sized font, which renders as
 * nothing at all and reads as a bug in the generator rather than as bad data.
 */
export const titleSizeOf = (layer: BannerLayer, settings: ProjectSettings): number =>
  Math.max(8, Math.round(Math.max(settings.height, 240) * layer.size));

/** The subtitle a viewer actually sees, after the preset's own casing rule. */
export const subtitleText = (layer: BannerLayer): string =>
  layer.uppercaseSubtitle ? layer.subtitle.toLocaleUpperCase() : layer.subtitle;
