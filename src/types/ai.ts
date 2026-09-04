/**
 * The AI suite's domain model.
 *
 * Everything the assistant can *do* is expressed here as data — a plan is a
 * list of typed actions, a transcription is a list of timed segments — and
 * never as a call into the store. That separation is what lets a whole plan
 * land as one document write, and therefore as one undo step: the actions are
 * folded into a single `Project → Project` function before anything is
 * committed. See `lib/ai/plan.ts`.
 *
 * Nothing in this file is persisted inside a project. Preferences live beside
 * the app in browser storage, the API key lives in the OS credential store, and
 * a chat transcript is session-only. The document format is untouched.
 */

import type { BackgroundKind } from './background';
import type { EffectKind } from './effects';
import type { TransitionKind } from './transitions';
import type { BackgroundChannel, ClipChannel } from './animation';
import type { EasingKind } from './animation';
import type { TextAlign, TextLayer } from './text';

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

/**
 * Why a request failed, in the terms the interface reacts to.
 *
 * Mirrors `AiErrorKind` in `src-tauri/src/ai/error.rs` — the two are a contract,
 * not a coincidence.
 */
export type AiErrorKind =
  | 'missing-key'
  | 'invalid-key'
  | 'quota'
  | 'rate-limit'
  | 'network'
  | 'server'
  | 'blocked'
  | 'format'
  | 'request'
  | 'ffmpeg'
  | 'io'
  | 'unsupported'
  | 'cancelled';

/** Where the key is kept. `file` is honest about being obfuscation, not encryption. */
export type KeyBackend = 'keychain' | 'file' | 'browser' | 'none';

export interface KeyStatus {
  configured: boolean;
  backend: KeyBackend;
  /** Last four characters — enough to tell two keys apart. */
  hint: string | null;
}

export interface ModelInfo {
  id: string;
  label: string;
  description: string | null;
  inputTokenLimit: number | null;
}

export interface GenerateUsage {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  attempts: number;
}

/* ------------------------------------------------------------------ *
 * Preferences
 * ------------------------------------------------------------------ */

/**
 * A short, curated list — the field beside it accepts any id, and the settings
 * panel offers whatever the key can actually reach, so a model released after
 * this build is never out of reach.
 */
export const SUGGESTED_MODELS: { id: string; label: string; hint: string }[] = [
  {
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    hint: 'Multimodal, rapide, bon partout — le choix par défaut',
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    hint: 'Le plus capable de la famille Flash — raisonnement plus fin',
  },
  {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite',
    hint: 'Le moins cher — pour les demandes courtes',
  },
];

export const DEFAULT_MODEL = 'gemini-3.6-flash';

/**
 * Models tried, in order, when the chosen one has no quota left.
 *
 * Gemini counts quota **per model**, so a request refused by one can be
 * accepted by the next immediately — no waiting, no plan change. The order is
 * deliberate: the lite model first because it is the one most likely to have
 * free-tier headroom, then the largest, which is the last resort in every sense.
 */
export const DEFAULT_FALLBACK_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash'];

/**
 * Model ids Google has withdrawn from new API keys, and what takes their place.
 *
 * A retired id does not fail loudly at startup — it fails on the first request,
 * as a 404 naming its replacement, which is a miserable way to discover that a
 * default has aged out. Preferences saved by an older build are therefore moved
 * forward on load, once, and stamped so a deliberate later choice sticks.
 */
export const RETIRED_MODELS: Record<string, string> = {
  'gemini-2.5-flash': 'gemini-3.6-flash',
  'gemini-2.5-flash-lite': 'gemini-3.5-flash-lite',
  'gemini-2.5-pro': 'gemini-3.8-flash',
  'gemini-2.0-flash': 'gemini-3.6-flash',
  'gemini-2.0-flash-lite': 'gemini-3.5-flash-lite',
};

/** Bumped whenever a stored preference has to be rewritten on load. */
export const AI_SETTINGS_VERSION = 1;

export interface AiSettings {
  /** Set to {@link AI_SETTINGS_VERSION} once migrations have run. */
  version: number;
  /** Model id used for chat and planning. */
  model: string;
  /** Model used for transcription; must accept audio, so usually the same one. */
  transcriptionModel: string;
  /** 0 → 1. Low, because a plan is not a place for invention. */
  temperature: number;
  /** Sent with every request, so a house style survives across sessions. */
  language: string;
  /**
   * Move to another model when the chosen one is out of quota.
   *
   * On by default: an exhausted daily allowance is not something the user did
   * wrong, and a montage stopping halfway through a subtitle pass because one
   * model ran out is a poor way to find out about it.
   */
  autoFallback: boolean;
  /** The order tried, after the chosen model. */
  fallbackModels: string[];
  /**
   * Whether a plan is applied the moment it arrives. Off by default: the model
   * proposes, the editor disposes.
   */
  autoApply: boolean;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  version: AI_SETTINGS_VERSION,
  model: DEFAULT_MODEL,
  transcriptionModel: DEFAULT_MODEL,
  temperature: 0.35,
  language: 'français',
  autoFallback: true,
  fallbackModels: [...DEFAULT_FALLBACK_MODELS],
  autoApply: false,
};

/**
 * The models to try after the chosen one, given the current preferences.
 *
 * Empty when the switch is turned off, which is also what makes a single
 * refusal surface immediately rather than after three.
 */
export const fallbackChain = (settings: AiSettings): string[] =>
  settings.autoFallback ? settings.fallbackModels.filter((id) => id.trim() !== '') : [];

/* ------------------------------------------------------------------ *
 * Conversation
 * ------------------------------------------------------------------ */

export type ChatRole = 'user' | 'model';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  at: number;
  /** Present on a model turn that proposed timeline edits. */
  plan?: AiPlan;
  /** Set instead of `text` when the request failed. */
  error?: { kind: AiErrorKind; message: string };
  usage?: GenerateUsage;
}

/* ------------------------------------------------------------------ *
 * Plans
 * ------------------------------------------------------------------ */

/**
 * A reference the model is allowed to make.
 *
 * Ids come from the project description we send, but a language model will
 * sometimes answer with a *name* instead — "le clip d'intro", "V2". Rather than
 * rejecting those, resolution accepts either and reports what it could not
 * match. See `resolveClip` / `resolveTrack` in `lib/ai/plan.ts`.
 */
export type Reference = string;

/** Everything a plan may put keyframes on. */
export type AnimatableChannel = ClipChannel | `bg:${BackgroundChannel}`;

export interface PlanKeyframe {
  /** Seconds from the clip start. */
  time: number;
  value: number;
  easing?: EasingKind;
}

export interface TextStyleSpec {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  align?: TextAlign;
  italic?: boolean;
  /** Offset from the centre of the frame, in project pixels. */
  x?: number;
  y?: number;
}

export type AiAction =
  | { kind: 'addTrack'; trackKind: 'video' | 'audio'; name?: string }
  | {
      /** Drops a generated background under the montage, or restyles one. */
      kind: 'addBackground';
      background: BackgroundKind;
      start?: number;
      duration?: number;
      base?: string;
      colors?: string[];
      speed?: number;
      scale?: number;
      intensity?: number;
    }
  | {
      kind: 'setBackground';
      clip: Reference;
      background?: BackgroundKind;
      base?: string;
      colors?: string[];
      speed?: number;
      scale?: number;
      intensity?: number;
    }
  | {
      kind: 'addText';
      content: string;
      start: number;
      duration: number;
      track?: Reference;
      style?: TextStyleSpec;
      /** Fade + scale entrance, the same one the subtitle pass uses. */
      animate?: boolean;
      /** A named entrance, which wins over `animate` when both are given. */
      animation?: SubtitleAnimation;
      label?: string;
    }
  | {
      kind: 'addClip';
      asset: Reference;
      start: number;
      duration?: number;
      offset?: number;
      track?: Reference;
    }
  | { kind: 'moveClip'; clip: Reference; start: number; track?: Reference }
  | { kind: 'trimClip'; clip: Reference; start?: number; duration?: number; offset?: number }
  | { kind: 'removeClip'; clip: Reference }
  | { kind: 'renameClip'; clip: Reference; label: string }
  | {
      kind: 'setClip';
      clip: Reference;
      opacity?: number;
      scale?: number;
      x?: number;
      y?: number;
      rotation?: number;
      volume?: number;
      muted?: boolean;
    }
  | { kind: 'updateText'; clip: Reference; content?: string; style?: TextStyleSpec }
  | {
      /**
       * Replaces a text layer with one clip per word — the word-by-word reveal.
       *
       * Expressed as an action rather than as a flag on `addText` because it is
       * just as often applied to text that is already on the timeline, whether
       * the assistant put it there or the subtitle pass did.
       */
      kind: 'splitText';
      clip: Reference;
      unit?: 'word' | 'line';
      animation?: SubtitleAnimation;
    }
  | {
      /**
       * Applies a named entrance to a clip that already exists.
       *
       * The reason this is an action rather than a job for `animate`: a
       * keyframed channel *replaces* the clip's static value, so an entrance
       * has to end on the value the clip already has. Left to compute the
       * keyframes itself, a model animates a subtitle at y = 400 up to y = 0
       * and lands it in the middle of the frame. The preset does that
       * arithmetic from the clip, so it cannot be got wrong.
       */
      kind: 'setEntrance';
      clip: Reference;
      animation: SubtitleAnimation;
      /** Seconds the entrance takes. Omitted, the style picks its own. */
      duration?: number;
    }
  | {
      kind: 'animate';
      /**
       * A clip property, or a generated background's own — `bg:speed`,
       * `bg:scale`, `bg:intensity`. The prefix matters: a background has a
       * `scale` and so does the clip that carries it.
       */
      channel: AnimatableChannel;
      clip: Reference;
      keyframes: PlanKeyframe[];
    }
  | { kind: 'addEffect'; clip: Reference; effect: EffectKind; params?: Record<string, number> }
  | {
      kind: 'addTransition';
      fromClip: Reference;
      toClip: Reference;
      transition: TransitionKind;
      duration?: number;
    };

/** What the model proposed, before anything has been written. */
export interface AiPlan {
  id: string;
  /** One line for the history entry and the toast. */
  title: string;
  actions: AiAction[];
  /** Filled in by validation: actions that could not be resolved, and why. */
  rejected: { action: AiAction; reason: string }[];
  /** Set once the plan has been committed, so the card stops offering to. */
  appliedAt: number | null;
}

/* ------------------------------------------------------------------ *
 * Transcription & subtitles
 * ------------------------------------------------------------------ */

export interface TranscriptSegment {
  /** Seconds, on the **timeline**, once the caller has offset them. */
  start: number;
  end: number;
  text: string;
}

export type SubtitleAnimation = 'none' | 'fade' | 'pop' | 'rise' | 'punch';

export const SUBTITLE_ANIMATIONS: { id: SubtitleAnimation; label: string; hint: string }[] = [
  { id: 'none', label: 'Aucune', hint: 'Apparition franche' },
  { id: 'fade', label: 'Fondu', hint: 'Opacité seule — le plus sobre' },
  { id: 'pop', label: 'Pop', hint: 'Fondu + léger agrandissement' },
  { id: 'rise', label: 'Montée', hint: 'Fondu + glissement vertical' },
  { id: 'punch', label: 'Punch', hint: 'Entrée sèche, sans sortie — le style mot à mot' },
];

export type SubtitlePreset = 'caption' | 'broadcast' | 'social';

export const SUBTITLE_PRESETS: { id: SubtitlePreset; label: string; hint: string }[] = [
  { id: 'caption', label: 'Sous-titre', hint: 'Blanc, contour fin, bas de cadre' },
  { id: 'broadcast', label: 'Broadcast', hint: 'Plus grand, ombre portée marquée' },
  { id: 'social', label: 'Réseaux', hint: 'Gras, centré, pensé pour le vertical' },
];

export type SubtitleScope = 'clip' | 'work' | 'timeline';

/**
 * Where the words come from.
 *
 * `transcribe` reads them off the audio. `align` takes words the user already
 * has — lyrics, a script, a translation — and asks only for the timings, which
 * is both far more accurate and the only honest way to put a known text on a
 * timeline: a language model recalling a song from memory gets it subtly wrong
 * every time, and no amount of prompting fixes recall.
 */
export type SubtitleMode = 'transcribe' | 'align';

export interface SubtitleOptions {
  mode: SubtitleMode;
  /** The text to place, when `mode` is `align`. One line or phrase per line. */
  script: string;
  scope: SubtitleScope;
  preset: SubtitlePreset;
  animation: SubtitleAnimation;
  /** Empty means "detect it" — Gemini is good at that. */
  language: string;
  /** Characters per subtitle line before the model is asked to break it. */
  maxCharsPerLine: number;
  /** Longest a single subtitle may stay on screen. */
  maxDuration: number;
  /** Existing track to write onto; `null` creates a dedicated one. */
  trackId: string | null;
  /**
   * A ready-made look, overriding `preset`.
   *
   * The brand kits resolve their own fractions against the project frame, and
   * the result is richer than the three built-in presets can express — a plate
   * colour, an outline weight tied to the font size. Rather than widening
   * `SubtitlePreset` into a second style system, a caller that has already
   * computed a style hands it over.
   */
  style?: { text: TextLayer; y: number };
}

export const DEFAULT_SUBTITLE_OPTIONS: SubtitleOptions = {
  mode: 'transcribe',
  script: '',
  scope: 'timeline',
  preset: 'caption',
  animation: 'pop',
  language: '',
  maxCharsPerLine: 42,
  maxDuration: 6,
  trackId: null,
};

export const SUBTITLE_TRACK_NAME = 'Sous-titres';

/* ------------------------------------------------------------------ *
 * Smart cut
 * ------------------------------------------------------------------ */

export interface LoudnessEnvelope {
  rms: number[];
  peak: number[];
  bucketsPerSecond: number;
  duration: number;
  /** Loudest sample in the excerpt, 0 → 1, before normalisation. */
  ceiling: number;
}

/** One stretch of timeline the smart cut proposes to remove. */
export interface CutInterval {
  start: number;
  end: number;
  /** `silence` from the measurement, `filler` from the model. */
  source: 'silence' | 'filler';
  /** Shown in the review list — "3,2 s de silence", "« euh »". */
  label: string;
}

export type SmartCutScope = 'clip' | 'work' | 'timeline';

export interface SmartCutOptions {
  scope: SmartCutScope;
  /** dBFS below which a bucket counts as silent. */
  threshold: number;
  /** Shorter gaps than this are breath, not dead air. */
  minSilence: number;
  /** Kept at each end of a cut so speech never gets clipped. */
  padding: number;
  /** Ask the model to flag hesitations and false starts as well. */
  detectFillers: boolean;
}

export const DEFAULT_SMART_CUT_OPTIONS: SmartCutOptions = {
  scope: 'timeline',
  threshold: -42,
  minSilence: 0.6,
  padding: 0.12,
  detectFillers: false,
};

/** dBFS ⇄ linear amplitude, the two conventions this feature straddles. */
export const dbToAmplitude = (db: number): number => 10 ** (db / 20);
export const amplitudeToDb = (amplitude: number): number =>
  amplitude <= 0 ? -120 : 20 * Math.log10(amplitude);
