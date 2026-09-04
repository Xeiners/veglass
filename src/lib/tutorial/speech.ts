/**
 * Turning the script into audio.
 *
 * One step, one take, one file. That is the whole scheme, and it is not an
 * accident of implementation: a step is already the unit the model wrote a
 * self-contained sentence for, the unit a chapter marker names, and the unit
 * the camera moves for. Splitting further — by sentence, say — would produce
 * fragments that have to be re-joined against the same step anyway, and each
 * one would carry the request overhead of a whole round trip.
 *
 * Sequential, and for the same reason the transcription pass is: the account
 * has a request-per-minute allowance, and several requests racing to exhaust it
 * is a worse failure than one taking longer. It also means a run can be
 * cancelled between takes and stop having spent anything more.
 */

import { AiError, toAiError } from '@/lib/ai/client';
import { speak, type SpeechRequest } from '@/lib/voice/client';
import type { SpeechTake, VoicePreferences } from '@/types/voice';
import type { TutorialStep } from '@/types/tutorial';

/**
 * The name a take is filed under.
 *
 * Project id and step id together: the project so two documents generating
 * their own tutorials never write over each other, the step so running the
 * wizard twice replaces a take rather than leaving the first one orphaned on
 * disk. Rust sanitises this again — choosing well here is a courtesy, not the
 * guarantee.
 */
export const takeKey = (projectId: string, stepId: string): string =>
  `${projectId}-${stepId}`.replace(/[^a-zA-Z0-9-]/g, '-');

export interface SpeechProgress {
  /** 0 → 1 over the whole script. */
  ratio: number;
  /** 1-based, for "phrase 3 sur 12". */
  index: number;
  total: number;
  /** The line being recorded, so the wait shows what it is buying. */
  say: string;
}

export interface SpeechOutcome {
  /** Step id → its take. Steps that failed are simply absent. */
  takes: Map<string, SpeechTake>;
  /** How many lines could not be recorded. */
  failed: number;
  /** Keys written to disk, so an abandoned run can clean up after itself. */
  keys: string[];
}

/** The steps that actually need a voice: enabled, and with something to say. */
export const speakableSteps = (steps: TutorialStep[]): TutorialStep[] =>
  steps.filter((step) => step.enabled && step.say.trim().length > 0);

/**
 * Records the narration for every step that wants one.
 *
 * A line that fails is skipped rather than fatal, with one exception: an
 * exhausted quota or a refused key will refuse every remaining line in exactly
 * the same way, so the run stops there instead of spending two minutes proving
 * it eleven more times. Everything already recorded is kept and returned — the
 * user gets a tutorial with some steps silent, which is worth far more than
 * nothing at all.
 */
export async function recordScript(
  steps: TutorialStep[],
  preferences: VoicePreferences,
  projectId: string,
  onProgress: (progress: SpeechProgress) => void,
  signal?: AbortSignal,
): Promise<SpeechOutcome> {
  const wanted = speakableSteps(steps);
  const takes = new Map<string, SpeechTake>();
  const keys: string[] = [];
  let failed = 0;

  for (let index = 0; index < wanted.length; index += 1) {
    if (signal?.aborted) throw new AiError('cancelled', 'Génération annulée.');

    const step = wanted[index] as TutorialStep;
    const key = takeKey(projectId, step.id);

    onProgress({
      ratio: index / wanted.length,
      index: index + 1,
      total: wanted.length,
      say: step.say,
    });

    const request: SpeechRequest = {
      voiceId: preferences.voiceId,
      modelId: preferences.modelId,
      text: step.say,
      settings: preferences.settings,
      key,
    };

    try {
      takes.set(step.id, await speak(request));
      keys.push(key);
    } catch (error) {
      const failure = toAiError(error);
      if (
        failure.kind === 'quota' ||
        failure.kind === 'missing-key' ||
        failure.kind === 'invalid-key'
      ) {
        // Nothing about the next line would make this succeed.
        throw failure;
      }
      failed += 1;
    }
  }

  onProgress({ ratio: 1, index: wanted.length, total: wanted.length, say: '' });
  return { takes, failed, keys };
}
