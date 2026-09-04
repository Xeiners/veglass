/**
 * The speech provider's vocabulary.
 *
 * Kept apart from `types/ai.ts` because the two services answer different
 * questions and fail for different reasons: a montage can be planned with no
 * ElevenLabs key at all, and a voice that no longer exists on the account is
 * not the same problem as a retired Gemini model. Mixing them would put the two
 * empty states in one settings panel and one error path.
 *
 * Nothing here is document data. A voice choice is a workspace preference, like
 * the export settings and the default easing — it travels with the machine, not
 * with the project.
 */

/** One voice on the account, as the service describes it. */
export interface VoiceInfo {
  id: string;
  name: string;
  /** `premade` · `cloned` · `professional` — how the account came by it. */
  category: string | null;
  description: string | null;
  /** The service's own sample. Playable directly; costs no characters. */
  previewUrl: string | null;
  /** Free-form tags: accent, age, use case. */
  labels: string[];
}

/**
 * How the voice is driven.
 *
 * These are the service's own dials, passed through untranslated. Renaming them
 * into something friendlier would only mean guessing at the mapping every time
 * the provider adjusts what they do.
 */
export interface VoiceSettings {
  /** Low wanders and emotes; high is flat and predictable. */
  stability: number;
  /** How closely the timbre tracks the original voice. */
  similarityBoost: number;
  /** Exaggeration. Costs latency, and past a third it starts inventing. */
  style: number;
  useSpeakerBoost: boolean;
  /** 0.7 – 1.2. The service refuses anything outside that. */
  speed: number;
}

/**
 * Deliberately steady, because this is narration over a screen recording.
 *
 * A tutorial voice that emotes is a tutorial voice that distracts: the picture
 * is carrying the information, and the narration's whole job is to be
 * effortless to follow. High stability, no style exaggeration, and a hair under
 * natural speed so a listener can act while listening.
 */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.55,
  similarityBoost: 0.75,
  style: 0,
  useSpeakerBoost: true,
  speed: 0.96,
};

export interface VoiceModel {
  id: string;
  label: string;
  hint: string;
}

/**
 * The models worth offering.
 *
 * Multilingual v2 is the default and the one this feature was written against:
 * the interface is French, and a monolingual English model reads French as
 * though it were English. The turbo models are here for someone generating a
 * forty-step tutorial who would rather wait less than have the last five per
 * cent of the delivery.
 */
export const VOICE_MODELS: VoiceModel[] = [
  {
    id: 'eleven_multilingual_v2',
    label: 'Multilingue v2',
    hint: 'Le plus naturel — recommandé pour le français',
  },
  {
    id: 'eleven_turbo_v2_5',
    label: 'Turbo v2.5',
    hint: 'Deux fois plus rapide, un cran en dessous',
  },
  {
    id: 'eleven_flash_v2_5',
    label: 'Flash v2.5',
    hint: 'Le plus rapide et le moins cher',
  },
];

export const DEFAULT_VOICE_MODEL = 'eleven_multilingual_v2';

export const modelLabel = (id: string): string =>
  VOICE_MODELS.find((model) => model.id === id)?.label ?? id;

/** Bumped whenever a stored preference has to be rewritten on load. */
export const VOICE_SETTINGS_VERSION = 1;

export interface VoicePreferences {
  version: number;
  /** Empty until the user has picked one — there is no sensible default id. */
  voiceId: string;
  modelId: string;
  settings: VoiceSettings;
}

export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  version: VOICE_SETTINGS_VERSION,
  voiceId: '',
  modelId: DEFAULT_VOICE_MODEL,
  settings: { ...DEFAULT_VOICE_SETTINGS },
};

/** One word, and when it is said, relative to the start of its take. */
export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

/** What one synthesis produced. The audio itself is on disk, at `path`. */
export interface SpeechTake {
  path: string;
  /** Seconds, from the service's own alignment rather than from a probe. */
  duration: number;
  words: WordTiming[];
  bytes: number;
}

/**
 * A rough character count, for warning before a long run.
 *
 * The service bills per character, and someone about to spend eight thousand of
 * them on a fifteen-minute recording should be told before the run, not after.
 */
export const countCharacters = (passages: string[]): number =>
  passages.reduce((total, passage) => total + passage.trim().length, 0);
