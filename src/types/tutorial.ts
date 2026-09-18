/**
 * The tutorial generator's vocabulary.
 *
 * A raw screen recording goes in; a montage comes out — the recording on its
 * own track with a camera that moves, a narration track timed against it, and a
 * chapter marker per step.
 *
 * Everything here describes a *proposal*. None of it is document data: a step
 * only becomes clips, keyframes and markers when the user presses the button at
 * the end of the wizard, which is why none of these types appear in `Project`.
 * The one thing that does cross over is the marker, and it has its own file.
 */

import type { BannerPreset } from './banner';
import type { ScreenPoint } from './geometry';
import type { SpeechTake } from './voice';

/* ------------------------------------------------------------------ *
 * Step 2 — what the user is asking for
 * ------------------------------------------------------------------ */

export type TutorialAudience = 'beginner' | 'operator' | 'expert';

export const AUDIENCE_OPTIONS: { id: TutorialAudience; label: string; hint: string }[] = [
  {
    id: 'beginner',
    label: 'Découverte',
    hint: 'Quelqu’un qui ouvre le logiciel pour la première fois',
  },
  {
    id: 'operator',
    label: 'Utilisateur',
    hint: 'Connaît le métier, découvre cette manipulation',
  },
  { id: 'expert', label: 'Référent', hint: 'Va vite, veut juste les étapes' },
];

/**
 * How much the camera moves.
 *
 * The numbers are the whole personality of the feature, so they are named
 * rather than typed into the engine: a zoom that is too tight loses the context
 * that makes a tutorial legible, and one that is too loose is indistinguishable
 * from no zoom at all.
 */
export type ZoomStyle = 'off' | 'subtle' | 'balanced' | 'punchy';

export interface ZoomProfile {
  id: ZoomStyle;
  label: string;
  hint: string;
  /** 1 = no zoom. 1.4 means the point of interest fills 140 % of the frame. */
  factor: number;
  /** Seconds the camera spends arriving, so it is settled *before* the click. */
  lead: number;
  /** Seconds it spends pulling back out. */
  release: number;
  /**
   * Longest a single shot holds before releasing, in seconds.
   *
   * Without it, a step whose `until` sits forty seconds later would leave the
   * camera parked on one button for forty seconds — technically what the model
   * said, and unwatchable.
   */
  maxDwell: number;
  /**
   * Two shots closer together than this become one continuous move.
   *
   * The N of "if two zooms follow each other within N seconds, glide". Below
   * it the camera slides straight from one point of interest to the next; above
   * it, it pulls back to the wide shot in between, which re-establishes context.
   * Pulling out and back in inside a second is the single ugliest thing an
   * automatic camera does, and this number is what prevents it.
   */
  reframeGap: number;
}

export const ZOOM_PROFILES: ZoomProfile[] = [
  {
    id: 'off',
    label: 'Fixe',
    hint: 'Image entière, sans zoom ni recadrage — réglage par défaut',
    factor: 1,
    lead: 0,
    release: 0,
    maxDwell: 0,
    reframeGap: 0,
  },
  {
    id: 'subtle',
    label: 'Discret',
    hint: 'On se rapproche à peine — pour un écran déjà lisible',
    factor: 1.18,
    lead: 0.7,
    release: 0.7,
    maxDwell: 4,
    reframeGap: 1.9,
  },
  {
    id: 'balanced',
    label: 'Équilibré',
    hint: 'Zoom à 140 %, arrivée avant le clic',
    factor: 1.4,
    lead: 0.5,
    release: 0.55,
    maxDwell: 3.5,
    reframeGap: 1.5,
  },
  {
    id: 'punchy',
    label: 'Marqué',
    hint: 'Zoom franc et rapide — pour du 4K et des interfaces denses',
    factor: 1.75,
    lead: 0.32,
    release: 0.4,
    maxDwell: 2.6,
    reframeGap: 1.1,
  },
];

export const zoomProfileOf = (id: ZoomStyle): ZoomProfile =>
  ZOOM_PROFILES.find((profile) => profile.id === id) ?? (ZOOM_PROFILES[0] as ZoomProfile);

export interface TutorialOptions {
  /** The screen recording being turned into a tutorial. */
  assetId: string | null;
  /** Total stills requested for the recording. Absent/null preserves automatic sampling. */
  frameCount?: number | null;
  /** Empty means "detect it", which the model does well. */
  language: string;
  audience: TutorialAudience;
  /**
   * The user's own instructions, in their words.
   *
   * Where "c'est un logiciel de caisse, appelle le panier « ticket »",
   * "ne commente pas la connexion" or "vouvoie" go. It outranks the audience
   * preset when the two disagree, being the more specific of the two.
   */
  brief: string;
  /** Narration. Off produces the montage and the markers, and nothing spoken. */
  voiceover: boolean;
  zoom: ZoomStyle;
  chapters: boolean;
  /**
   * Lower thirds at chapter openings, and a badge whenever a keyboard shortcut
   * is used. The single biggest difference between a screen recording and
   * something that looks like a course, and the reason the analysis is asked
   * for banner text at all.
   */
  banners: boolean;
  /** Which template dresses the chapter banners. Shortcuts always use theirs. */
  bannerPreset: BannerPreset;
  /**
   * Replace the recorded mouse with a drawn one.
   *
   * A smoothed path and a ring on every click. The recorded pointer is still
   * in the picture underneath — nothing can remove it — so this is an overlay,
   * and on a recording made without hiding the system cursor there will be two.
   * Said plainly in the wizard rather than discovered at export.
   */
  cursor: boolean;
  /**
   * Glass behind the recording, by preset id, or `null` for none.
   *
   * Only earns its place when the recording does not fill the frame — a 16:9
   * capture in a 9:16 project, or a clip scaled down. On a frame it already
   * fills there is nothing of it to see.
   */
  backdrop: string | null;
  /** Burnt-in captions, timed from the narration's own word alignment. */
  captions: boolean;
  /**
   * Fade the recording's own sound under the narration.
   *
   * Screen recordings usually carry keyboard clatter and room noise. Left at
   * full level under a voice-over it fights the narration; muted outright, the
   * tutorial loses the click that confirms the action landed.
   */
  duckOriginal: boolean;
}

export const DEFAULT_TUTORIAL_OPTIONS: TutorialOptions = {
  assetId: null,
  frameCount: null,
  language: '',
  audience: 'operator',
  brief: '',
  voiceover: true,
  zoom: 'off',
  chapters: true,
  banners: true,
  bannerPreset: 'saas',
  cursor: true,
  backdrop: null,
  captions: false,
  duckOriginal: true,
};

/** Long enough for real direction, short enough not to crowd the frames. */
export const MAX_BRIEF = 600;

/* ------------------------------------------------------------------ *
 * Step 3 — what came back
 * ------------------------------------------------------------------ */

/**
 * Normalised 0 → 1 across the *source* frame, not the project frame.
 *
 * Re-exported rather than redeclared: the camera and the crop tool read these
 * same coordinates, and one definition is what keeps the three in step.
 */
export type { ScreenPoint } from './geometry';

/**
 * What the user did, in the terms the narration and the camera both care about.
 *
 * The list is short on purpose: it exists to decide whether a shot is worth a
 * zoom, not to describe the interface. A `read` step has no point of interest
 * and gets no camera move; a `click` is exactly what the feature is for.
 */
export type StepAction = 'click' | 'type' | 'select' | 'navigate' | 'scroll' | 'read';

export const ACTION_LABELS: Record<StepAction, string> = {
  click: 'Clic',
  type: 'Saisie',
  select: 'Sélection',
  navigate: 'Navigation',
  scroll: 'Défilement',
  read: 'Lecture',
};

/** Whether an action is worth pushing the camera in for. */
export const isPointed = (action: StepAction): boolean => action !== 'read';

/** The text of one lower third, as the model wrote it. */
export interface StepBanner {
  title: string;
  /** May be empty: a one-line banner is a deliberate, common look. */
  subtitle: string;
}

export interface TutorialStep {
  id: string;
  /** Seconds in the **source recording** where the action happens. */
  at: number;
  /** Seconds in the source where this step's business is done. */
  until: number;
  /** The chapter name. Short — it has to fit on a ruler flag. */
  title: string;
  /** What the narrator says. One step, one take, one marker. */
  say: string;
  action: StepAction;
  /** Where to look. `null` on a step with nothing to point at. */
  point: ScreenPoint | null;
  /** 0 – 100. The model's own confidence in those coordinates. */
  confidence: number;
  /**
   * The chapter banner this step opens, or `null` on a step that continues one.
   *
   * Deliberately not every step: a lower third on all twenty-four steps of a
   * tutorial is wallpaper, and the thing it is supposed to mark — that a new
   * part has begun — stops being marked at all.
   */
  banner: StepBanner | null;
  /**
   * The keyboard shortcut this step uses, as it would be typed — `Ctrl + S`.
   *
   * Its own field rather than a kind of banner: a shortcut can appear during a
   * step that is in the middle of a chapter, so the two are independent.
   */
  shortcut: string | null;
  /** The generated narration, once it exists. */
  take: SpeechTake | null;
  /** Cleared by the user to drop a step before importing. */
  enabled: boolean;
}

export const stepDuration = (step: TutorialStep): number => Math.max(0, step.until - step.at);

/**
 * A step's coordinates are only trusted above this.
 *
 * Below it the model is guessing at a position, and a confident zoom onto the
 * wrong quarter of the screen is worse than no zoom: it points the viewer at
 * something that is not the answer. Such a step keeps its narration and its
 * marker and simply gets no camera move.
 */
export const ZOOM_CONFIDENCE_FLOOR = 45;

/** Whether the camera should move for this step, given the profile in force. */
export const zoomable = (step: TutorialStep, profile: ZoomProfile): boolean =>
  profile.factor > 1 &&
  step.enabled &&
  step.point !== null &&
  isPointed(step.action) &&
  step.confidence >= ZOOM_CONFIDENCE_FLOOR;

/* ------------------------------------------------------------------ *
 * Progress
 * ------------------------------------------------------------------ */

/**
 * Where a run is.
 *
 * The wizard reads this rather than a percentage alone: extracting frames,
 * asking the model and synthesising speech fail for entirely different reasons
 * — a missing ffmpeg, an exhausted Gemini quota, an ElevenLabs key — and each
 * deserves its own sentence.
 */
export type TutorialStage =
  | 'idle'
  | 'sampling'
  | 'analysing'
  | 'speaking'
  | 'ready'
  | 'failed'
  | 'cancelled';

export const STAGE_LABELS: Record<TutorialStage, string> = {
  idle: 'En attente',
  sampling: 'Lecture de l’écran',
  analysing: 'Repérage des étapes',
  speaking: 'Enregistrement de la voix off',
  ready: 'Terminé',
  failed: 'Échec',
  cancelled: 'Annulé',
};

export const isRunning = (stage: TutorialStage): boolean =>
  stage === 'sampling' || stage === 'analysing' || stage === 'speaking';

/* ------------------------------------------------------------------ *
 * Where it lands
 * ------------------------------------------------------------------ */

/** Reused across runs rather than stacked, exactly as the viral pass does. */
export const SCREEN_TRACK_NAME = 'Écran';
export const VOICE_TRACK_NAME = 'Voix off';

/** Chapters from one run share a colour, so they read as a set on the ruler. */
export const CHAPTER_COLOR = '#38bdf8';
