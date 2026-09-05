/**
 * The editing copilot's vocabulary.
 *
 * The director is not a second sequencer. It produces one small, readable
 * object — a {@link Strategy} — and hands it to the engine that already exists.
 * Everything it can decide is in that object, which is what makes the whole
 * feature reviewable: what the model is allowed to change is exactly the fields
 * listed here, and nothing it says can reach the timeline by another route.
 *
 * # Where the numbers come from
 *
 * From measurement, not from the model. A reference edit is downloaded, its
 * cuts are detected by ffmpeg and its own arc read from its own audio by the
 * same beat pipeline the montage uses. That produces a {@link ReferenceProfile}
 * with no language model involved at all — so the feature works with no API key
 * configured, and a key only buys the conversation.
 *
 * The model's job is to *talk about* the strategy and to take corrections in
 * words. It never invents the pacing; it nudges numbers that were measured, and
 * every nudge goes through a normaliser that clamps it. That split is deliberate:
 * a copilot that hallucinated "cuts every 0.02 s" would produce a montage nobody
 * asked for, and there would be no measurement to check it against.
 */

import type { AmvProfileId, PhaseId } from './amv';

/**
 * Whether the copilot is offered at all.
 *
 * Off: the conversational flow is not good enough to put in front of anyone
 * yet. Everything it needs is still here and still compiled — the reference
 * analysis, the prompt, the trust boundary, the casting — so turning it back on
 * is this one line.
 *
 * Two things go with it, and both are worth checking before flipping it back:
 *
 * * `RightPanel` hides the tab, so the panel has no entry point.
 * * The montage wizard keeps its own **Monter** button while this is off, which
 *   commits `defaultRecipe(profile)` — the registry's own movements, exactly
 *   what it used before the copilot existed. With the copilot on, that button
 *   should go back to handing over rather than committing, or there are two
 *   roads to the timeline again.
 */
export const DIRECTOR_ENABLED = false;

/* ------------------------------------------------------------------ *
 * The reference
 * ------------------------------------------------------------------ */

/** Where a reference came from, and the local copy that was measured. */
export interface ReferenceSource {
  url: string;
  title: string;
  /** The downloaded file. Kept so the analysis can be re-run. */
  path: string;
  /** Seconds of it that were actually looked at. */
  duration: number;
}

/**
 * What a reference edit was measured to *do*.
 *
 * Three facts, and they are the three that survive being copied onto different
 * music: where its movements fell as fractions of its length, how long a shot
 * held in each of them, and how densely it cut overall. Absolute timestamps do
 * not survive — "a drop at 00:06" means nothing applied to a track whose drop is
 * at 00:41 — which is why the arc is stored as fractions.
 */
export interface ReferenceProfile {
  /** Where its movements began, as fractions of its duration, 0 → 1. */
  arc: Record<Exclude<PhaseId, 'intro'>, number>;
  /** Mean seconds one shot held, per movement. */
  shot: Record<PhaseId, number>;
  /** Cuts detected, over `duration` seconds. */
  cuts: number;
  duration: number;
  /**
   * How the reference's own arc was read.
   *
   * `measured` — its audio gave up a structure. `proportional` — it did not, or
   * it has no audio at all, and the conventional shape stood in. The second is
   * still useful: the *pacing* is measured either way, and pacing is the thing
   * being copied.
   */
  arcSource: 'measured' | 'proportional';
}

/* ------------------------------------------------------------------ *
 * The strategy
 * ------------------------------------------------------------------ */

/**
 * The proposal, in the form the user argues with.
 *
 * Small on purpose. Every field is either a length in seconds or a switch, so
 * it can be shown as a sentence, adjusted in words, and clamped on the way back
 * without any of it being guesswork.
 */
/**
 * Which movement a clip has been cast into.
 *
 * `any` is the honest default and covers most of a bank: a clip nobody has an
 * opinion about is drawn wherever one is needed. The three phases are a
 * *preference*, not a fence — see `createPicker`, which falls back to the whole
 * bank rather than repeating one clip because a movement was cast thin.
 */
export type ClipRole = PhaseId | 'any';

export interface Strategy {
  /** The look it starts from. */
  profile: AmvProfileId;
  /** Target mean shot length per movement, in seconds. */
  shot: Record<PhaseId, number>;
  /**
   * The casting: which clips belong to which movement.
   *
   * Keyed by asset id, and only for the clips an opinion was expressed about.
   * This is the difference between a montage that cuts on the beat and one that
   * cuts *to something* — without it the sequencer draws from a shuffled bank
   * and the placement is arithmetic rather than editing.
   */
  roles: Record<string, ClipRole>;
  /** The asset the montage opens on, when one was chosen. */
  opening: string | null;
  punch: boolean;
  flashes: boolean;
  /** Chromatic aberration on the heaviest beats of the release. */
  split: boolean;
  /** Directional smear across each cut. */
  smear: boolean;
  /**
   * Whether the reference's arc proportions stand in when the user's own track
   * does not state one.
   *
   * Only ever consulted in that case. A track with a clear drop of its own is
   * always cut on *its* drop — copying a reference means copying its pacing and
   * its habits, never overriding the music actually being edited.
   */
  borrowArc: boolean;
}

/** Bounds every strategy is held to, whoever proposed it. */
export const STRATEGY_LIMITS = {
  /** Under this a shot is a flicker; over it, a montage is a slideshow. */
  minShot: 0.1,
  maxShot: 8,
} as const;

/**
 * The shot lengths a profile settles at with no reference to copy.
 *
 * Derived from the profile's own floor times each movement's pace, so "no
 * reference" and "a reference that happens to match the profile" produce the
 * same montage rather than two subtly different ones.
 */
export const DEFAULT_SHOT: Record<AmvProfileId, Record<PhaseId, number>> = {
  aggressive: { intro: 1.6, build: 0.62, drop: 0.28 },
  cinematic: { intro: 3.2, build: 1.6, drop: 0.9 },
};

/* ------------------------------------------------------------------ *
 * What the model is told
 * ------------------------------------------------------------------ */

/**
 * Everything measured about this montage, gathered for the system prompt.
 *
 * A plain snapshot rather than the stores themselves, so `lib/director/prompt`
 * is a pure function of data and can be exercised — and read — without a
 * running application behind it.
 */
export interface DirectorContext {
  music: { name: string; duration: number } | null;
  /** `null` when the beats do not describe a steady pulse. */
  tempo: number | null;
  beats: number;
  arc: { id: PhaseId; from: number; to: number }[];
  arcSource: 'measured' | 'proportional';
  clips: { id: string; name: string; duration: number; note: string | null }[];
  /** True once the frames have been looked at, so the prompt can say so. */
  looked: boolean;
  reference:
    | (Pick<ReferenceProfile, 'cuts' | 'duration' | 'shot' | 'arcSource'> & {
        title: string;
        /** Where its release began, as a fraction of its own length. */
        dropAt: number;
      })
    | null;
  strategy: Strategy;
  fps: number;
}

/* ------------------------------------------------------------------ *
 * The conversation
 * ------------------------------------------------------------------ */

export type DirectorStage =
  | 'idle'
  /** Fetching the reference through yt-dlp. */
  | 'fetching'
  /** Measuring its cuts and its arc. */
  | 'reading'
  /** Showing the rushes to the model, so it can cast them. */
  | 'watching'
  /** Waiting on the model for a turn of conversation. */
  | 'thinking'
  | 'ready'
  | 'failed';

export const DIRECTOR_STAGE_LABELS: Record<DirectorStage, string> = {
  idle: 'Prêt',
  fetching: 'Récupération de la référence',
  reading: 'Lecture du montage de référence',
  watching: 'Visionnage de vos rushs',
  thinking: 'Réflexion',
  ready: 'Proposition prête',
  failed: 'Analyse interrompue',
};

export const isWorking = (stage: DirectorStage): boolean =>
  stage === 'fetching' ||
  stage === 'reading' ||
  stage === 'watching' ||
  stage === 'thinking';

/** One turn of the conversation. */
export interface DirectorTurn {
  id: string;
  role: 'user' | 'director';
  text: string;
  at: number;
  /**
   * The strategy this turn arrived at, when it changed one.
   *
   * Attached to the turn rather than kept only as current state, so scrolling
   * back through the conversation shows what was proposed at each point instead
   * of showing the latest answer three times.
   */
  strategy?: Strategy;
  error?: string;
  /**
   * Which model answered, and what the round trip cost.
   *
   * Shown under every answer, and present on exactly the turns that came back
   * over the wire. That is the point of it: a copilot whose replies are written
   * locally and a copilot that is talking to Gemini look identical in a chat
   * bubble, and this is the difference made visible. A turn with no `model` did
   * not come from a model.
   */
  model?: string;
  tokens?: number;
}

/* ------------------------------------------------------------------ *
 * Links
 * ------------------------------------------------------------------ */

/**
 * Hosts a reference may come from.
 *
 * Checked before anything is downloaded, so a pasted paragraph of text fails in
 * the field rather than three seconds into a yt-dlp run. Deliberately short:
 * yt-dlp handles far more than this, and the list can grow — but a host nobody
 * has tried is better refused than silently attempted.
 */
const HOSTS = [
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'instagram.com',
  'vimeo.com',
  'dailymotion.com',
  'twitter.com',
  'x.com',
];

/** The URL in `text`, if it is one this can fetch. `null` otherwise. */
export function referenceUrl(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  return HOSTS.some((known) => host === known || host.endsWith(`.${known}`)) ? trimmed : null;
}
