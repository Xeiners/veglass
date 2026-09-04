/**
 * The viral-clip generator's vocabulary.
 *
 * A long recording goes in; a handful of self-contained vertical cuts come out.
 * Everything here describes that proposal — the wizard's answers, and the clips
 * the model came back with — and none of it is part of the document. A proposal
 * only becomes a project edit when the user presses a button, which is why none
 * of these types appear in `Project`.
 */

import type { TranscriptSegment } from './ai';
import type { Pace } from '@/lib/viral/gaps';
import type { ProjectSettings } from './project';
import { DEFAULT_KIT_ID } from './styleKit';

/* ------------------------------------------------------------------ *
 * Step 2 — what the user is asking for
 * ------------------------------------------------------------------ */

export type ViralFormat = 'vertical' | 'square' | 'horizontal';

export interface FormatOption {
  id: ViralFormat;
  label: string;
  hint: string;
  width: number;
  height: number;
}

/**
 * The three shapes worth offering, at the resolution each platform actually
 * wants. Vertical is first because it is what the feature exists for.
 */
export const FORMAT_OPTIONS: FormatOption[] = [
  { id: 'vertical', label: '9:16', hint: 'TikTok · Reels · Shorts', width: 1080, height: 1920 },
  { id: 'square', label: '1:1', hint: 'Fil Instagram · LinkedIn', width: 1080, height: 1080 },
  { id: 'horizontal', label: '16:9', hint: 'Format d’origine', width: 1920, height: 1080 },
];

export function frameOf(format: ViralFormat, fps: number): ProjectSettings {
  const option = FORMAT_OPTIONS.find((item) => item.id === format) ?? FORMAT_OPTIONS[0];
  const { width, height } = option as FormatOption;
  return { width, height, fps };
}

export type ViralLength = 'snappy' | 'standard' | 'long';

export interface LengthOption {
  id: ViralLength;
  label: string;
  hint: string;
  /** Seconds. The model is asked to stay inside this, and results are checked. */
  min: number;
  max: number;
}

export const LENGTH_OPTIONS: LengthOption[] = [
  { id: 'snappy', label: '15 – 30 s', hint: 'Une punchline', min: 15, max: 30 },
  { id: 'standard', label: '30 – 60 s', hint: 'Une idée complète', min: 30, max: 60 },
  { id: 'long', label: '60 – 90 s', hint: 'Une histoire courte', min: 60, max: 90 },
];

export const lengthOf = (id: ViralLength): LengthOption =>
  LENGTH_OPTIONS.find((item) => item.id === id) ?? (LENGTH_OPTIONS[1] as LengthOption);

export type ViralTone = 'auto' | 'punchy' | 'educational' | 'funny' | 'emotional' | 'story';

export const TONE_OPTIONS: { id: ViralTone; label: string; hint: string }[] = [
  { id: 'auto', label: 'Au jugé', hint: 'Le modèle choisit ce qui ressort' },
  { id: 'punchy', label: 'Punchy', hint: 'Opinions tranchées, formules' },
  { id: 'educational', label: 'Pédagogique', hint: 'Explications, conseils' },
  { id: 'funny', label: 'Drôle', hint: 'Rires, anecdotes' },
  { id: 'emotional', label: 'Émotionnel', hint: 'Confidences, moments forts' },
  { id: 'story', label: 'Narratif', hint: 'Une histoire avec un début et une fin' },
];

export interface ViralOptions {
  /** The long recording being mined. */
  assetId: string | null;
  format: ViralFormat;
  length: ViralLength;
  tone: ViralTone;
  /** Empty means "detect it", which Gemini does well. */
  language: string;
  /**
   * The user's own instructions, in their words.
   *
   * The preset tone is a coarse dial; this is where "ne prends que ce qui parle
   * de recrutement", "évite le passage sur les prix" or "des hooks sous forme
   * de question" go. It outranks the tone when the two disagree, because it is
   * the more specific of the two.
   */
  brief: string;
  /** How many cuts to ask for. The model may return fewer if the source is thin. */
  count: number;
  subtitles: boolean;
  /** Word-by-word captions rather than whole lines. */
  wordByWord: boolean;
  /**
   * A banner over the first seconds, carrying the model's own hook line.
   *
   * The single highest-leverage thing on a short-form clip, and the reason the
   * analysis is asked for a hook at all — see `HOOK_SECONDS`.
   */
  hooks: boolean;
  /** Which brand kit dresses the generated text. See `types/styleKit`. */
  kitId: string;
  /**
   * Remove the dead air between spoken lines.
   *
   * The gaps come from the transcript rather than from a loudness pass — see
   * `lib/viral/gaps` for why that is both cheaper and more accurate — and are
   * removed with a ripple, so the captions, the banner and every keyframe
   * contract with them.
   */
  jumpCuts: boolean;
  pace: Pace;
  /**
   * A progress hairline across the frame.
   *
   * Only on a **dedicated sequence**. It belongs to a composition, and a cut
   * dropped into an existing montage does not own the composition it lands in —
   * a bar there would span the whole timeline rather than the clip.
   */
  progressBar: boolean;
}

export const DEFAULT_VIRAL_OPTIONS: ViralOptions = {
  assetId: null,
  format: 'vertical',
  length: 'standard',
  tone: 'auto',
  language: '',
  brief: '',
  count: 6,
  subtitles: true,
  wordByWord: true,
  hooks: true,
  kitId: DEFAULT_KIT_ID,
  jumpCuts: true,
  pace: 'tight',
  progressBar: true,
};

/** Long enough for real direction, short enough not to crowd the transcript. */
export const MAX_BRIEF = 600;

export const MIN_CLIPS = 3;
export const MAX_CLIPS = 12;

/* ------------------------------------------------------------------ *
 * Step 4 — what came back
 * ------------------------------------------------------------------ */

export type PosterState = 'idle' | 'loading' | 'ready' | 'failed';

export interface ViralClip {
  id: string;
  /** The headline the model wrote for it. */
  title: string;
  /**
   * The four-or-five-word line for the opening banner.
   *
   * Separate from `title`: a caption under a post and a word burnt into the
   * first frame are not the same piece of writing, and asking one string to be
   * both gives something that is neither.
   */
  hook: string;
  /** Why it thinks this one travels. Shown under the title. */
  reason: string;
  keywords: string[];
  /** Seconds **inside the source media**, not on the timeline. */
  start: number;
  end: number;
  /** 0 – 100, the model's own estimate. */
  score: number;
  /**
   * Horizontal framing, 0 = left edge of the source, 0.5 = centre, 1 = right.
   *
   * The analysis reads audio, so it cannot know where anyone stands in frame:
   * this always starts centred and is the user's to move. See `lib/viral/frame`.
   */
  focus: number;
  poster: string | null;
  posterState: PosterState;
  /** The transcript lines falling inside the window, kept for the caption pass. */
  segments: TranscriptSegment[];
  /** Set once this clip has been placed, so the card can say so. */
  placed: boolean;
}

export const clipLength = (clip: ViralClip): number => Math.max(0, clip.end - clip.start);

/** Score bands, so the dashboard can rank at a glance rather than by reading. */
export function scoreBand(score: number): 'high' | 'mid' | 'low' {
  if (score >= 80) return 'high';
  if (score >= 60) return 'mid';
  return 'low';
}

/* ------------------------------------------------------------------ *
 * Progress
 * ------------------------------------------------------------------ */

/**
 * Where a run is. The wizard's third step reads this rather than a percentage
 * alone, because "transcription" and "analyse" fail for different reasons and
 * deserve different words.
 */
export type ViralStage =
  | 'idle'
  | 'reading'
  | 'analysing'
  | 'previewing'
  | 'ready'
  | 'failed'
  | 'cancelled';

export const STAGE_LABELS: Record<ViralStage, string> = {
  idle: 'En attente',
  reading: 'Écoute de la vidéo',
  analysing: 'Recherche des moments forts',
  previewing: 'Extraction des aperçus',
  ready: 'Terminé',
  failed: 'Échec',
  cancelled: 'Annulé',
};

export const isRunning = (stage: ViralStage): boolean =>
  stage === 'reading' || stage === 'analysing' || stage === 'previewing';

/** Track name for the generated cuts, reused so a second run does not stack layers. */
export const VIRAL_TRACK_NAME = 'Clips viraux';
