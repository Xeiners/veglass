/**
 * From a screen recording to a list of steps.
 *
 * The trust boundary of this feature, in the same spirit as `lib/ai/plan.ts`
 * and `lib/viral/analyse.ts`: everything the model returns is rebuilt field by
 * field, and anything that cannot be made sense of is dropped rather than
 * repaired into something plausible-looking.
 *
 * That matters more here than anywhere else in the suite, because two of the
 * fields drive a *camera*. A coordinate outside the screen, a step that starts
 * after it ends, or an action timed past the end of the recording would each
 * produce a montage that is visibly broken rather than merely imperfect — and
 * a keyframe written from a bad number is much harder to notice, and to undo,
 * than a sentence that reads oddly.
 *
 * The one place this is deliberately generous: coordinates are *clamped* to the
 * screen rather than rejected. A model that says 1.04 means the right-hand edge,
 * and the clamp in `cameraOn` would have caught it anyway.
 */

import { audioExcerpt, generate } from '@/lib/ai/client';
import { uid } from '@/lib/id';
import { clamp } from '@/lib/time';
import { audioPreamble, frameLabel, tutorialSystem } from './prompts';
import { TUTORIAL_SCHEMA } from './schema';
import {
  WINDOW_SECONDS,
  grabStills,
  samplingPlan,
  type SampleProgress,
  type Still,
} from './frames';
import { fallbackChain, type AiSettings } from '@/types/ai';
import type { MediaAsset } from '@/types/media';
import {
  ACTION_LABELS,
  isPointed,
  type StepAction,
  type StepBanner,
  type TutorialOptions,
  type TutorialStep,
} from '@/types/tutorial';
import { keysOf } from '@/types/banner';

/** Loose shape of one entry, before anything is trusted. */
interface RawStep {
  at?: unknown;
  until?: unknown;
  title?: unknown;
  say?: unknown;
  action?: unknown;
  x?: unknown;
  y?: unknown;
  confidence?: unknown;
  bannerTitle?: unknown;
  bannerSubtitle?: unknown;
  shortcut?: unknown;
}

const ACTIONS = new Set<StepAction>(Object.keys(ACTION_LABELS) as StepAction[]);

const number = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';

/**
 * The narration, stripped of everything that does not survive being spoken.
 *
 * A model asked for plain prose still produces the occasional "**Étape 3 :**",
 * a leading dash, or a stray emoji — and a speech synthesiser reads markup
 * literally or stumbles over it. Cheaper to strip here than to lose a take to
 * it, and the prompt asks for the same thing anyway.
 */
export function speakable(value: unknown, max = 700): string {
  const raw = text(value, max);
  if (raw.length === 0) return '';

  return raw
    .replace(/[*_`#]+/g, '')
    // A leading bullet or numbering, which is a list marker and not a sentence.
    .replace(/^\s*(?:[-–—•]\s*)+/u, '')
    .replace(/^\s*(?:étape|step)\s*\d+\s*[:.\-–—]\s*/iu, '')
    .replace(/^\s*\d+\s*[).:]\s+/u, '')
    // Anything outside the letters, digits and punctuation a voice can read.
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The chapter name — short, because it has to fit on a ruler flag. */
export function chapterTitle(value: unknown, fallback: string): string {
  const raw = text(value, 90)
    .replace(/^\s*(?:étape|step)\s*\d+\s*[:.\-–—]\s*/iu, '')
    .replace(/[.:;]+$/u, '')
    .trim();
  return raw.length > 0 ? raw : fallback;
}

/**
 * A keyboard shortcut, in the one shape the keycap painter can draw.
 *
 * The model answers with every spelling there is — `Ctrl+S`, `CTRL + S`,
 * `Cmd-S`, `« Ctrl + S »`, and occasionally a whole sentence about pressing
 * control and S. Only the token form is kept, and anything that does not look
 * like a shortcut at all is dropped rather than drawn as one enormous key.
 */
export function shortcutOf(value: unknown): string | null {
  const raw = text(value, 48)
    .replace(/[«»"'`]/g, ' ')
    .replace(/\s*[-–—]\s*/g, ' + ')
    .replace(/\s+/g, ' ')
    .trim();
  if (raw.length === 0) return null;

  const keys = keysOf(raw)
    // A "key" of more than one word is prose, not a key.
    .filter((key) => key.split(' ').length === 1 && key.length <= 12)
    .slice(0, 4);

  // A lone modifier is not a shortcut, and neither is an empty result.
  if (keys.length === 0) return null;
  if (keys.length === 1 && /^(ctrl|control|alt|maj|shift|cmd|command|win)$/i.test(keys[0] as string)) {
    return null;
  }

  return keys.join(' + ');
}

/** The chapter banner, when the model marked this step as opening one. */
export function bannerOf(title: unknown, subtitle: unknown): StepBanner | null {
  const heading = text(title, 70).replace(/[.:;]+$/u, '').trim();
  // No title, no banner: a subtitle alone is a label with nothing to label.
  if (heading.length === 0) return null;
  return { title: heading, subtitle: text(subtitle, 60).replace(/[.:;]+$/u, '').trim() };
}

const actionOf = (value: unknown): StepAction => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ACTIONS.has(raw as StepAction) ? (raw as StepAction) : 'click';
};

/**
 * How long a step is given when the model does not say, or says something
 * impossible.
 *
 * Only ever a floor: it decides how long the camera may dwell, and the next
 * step's own `at` cuts it short anyway.
 */
const DEFAULT_SPAN = 4;

/** Two steps closer together than this are one step described twice. */
const MIN_APART = 0.6;

/**
 * Rebuilds the model's answer into steps we are willing to act on.
 *
 * Pure and synchronous, so the whole of it is testable without a network.
 */
export function normalizeSteps(payload: string, duration: number): TutorialStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }

  const container = parsed as { steps?: unknown };
  const raw = Array.isArray(container?.steps) ? container.steps : [];

  const out: TutorialStep[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as RawStep;

    const at = number(item.at);
    if (at === null || at < 0 || at >= duration) continue;

    const say = speakable(item.say);
    const title = chapterTitle(item.title, say.split(/[.!?]/)[0]?.slice(0, 60) ?? 'Étape');
    // A step with neither a name nor a line is not a step; it is a timestamp.
    if (title.length === 0 && say.length === 0) continue;

    // A `until` before its own `at` is the single most common malformed answer,
    // and the one that would otherwise give a camera a negative dwell.
    const claimed = number(item.until);
    const until = Math.min(
      duration,
      claimed !== null && claimed > at ? claimed : at + DEFAULT_SPAN,
    );

    const action = actionOf(item.action);
    const x = number(item.x);
    const y = number(item.y);
    const confidence = number(item.confidence);

    /*
     * A point exists only when the model gave both halves of one *and* the
     * action is the kind that has somewhere to look. Half a coordinate is not
     * a position, and a `read` step pointing somewhere is the model filling in
     * a field rather than answering the question.
     */
    const point =
      x !== null && y !== null && isPointed(action)
        ? { x: clamp(x, 0, 1), y: clamp(y, 0, 1) }
        : null;

    // Steps arrive in order and are checked in order: a duplicate of the one
    // before it is a re-description, not a second action.
    const previous = out[out.length - 1];
    if (previous && at - previous.at < MIN_APART) continue;

    out.push({
      id: uid('step'),
      at,
      until,
      title,
      say,
      action,
      point,
      confidence: confidence === null ? 50 : Math.round(clamp(confidence, 0, 100)),
      banner: bannerOf(item.bannerTitle, item.bannerSubtitle),
      shortcut: shortcutOf(item.shortcut),
      take: null,
      enabled: true,
    });
  }

  return tighten(out, duration);
}

/**
 * Stops each step where the next one begins.
 *
 * The model is asked for `until` and answers with the moment the result is on
 * screen, which is the right question — but two adjacent steps routinely
 * overlap by a second or two, and an overlapping dwell means the camera is told
 * to be in two places at once. The later step wins, because that is where the
 * viewer's attention has moved.
 */
export function tighten(steps: TutorialStep[], duration: number): TutorialStep[] {
  const ordered = [...steps].sort((a, b) => a.at - b.at);

  return ordered.map((step, index) => {
    const next = ordered[index + 1];
    const ceiling = next ? Math.min(next.at, duration) : duration;
    return { ...step, until: Math.max(step.at, Math.min(step.until, ceiling)) };
  });
}

/* ------------------------------------------------------------------ *
 * The request
 * ------------------------------------------------------------------ */

/**
 * Longest audio excerpt worth sending beside the stills, in seconds.
 *
 * A whole window's worth. `ai_audio_excerpt` compresses to roughly a hundredth
 * of the source, so a full window of sound costs less than two of the forty
 * images sitting beside it — there is no reason to send less than all of it.
 */
const AUDIO_LIMIT = WINDOW_SECONDS;

interface Part {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

/**
 * The user turn: the stills, each labelled with its own timestamp, then the
 * audio if there is any.
 *
 * The labels sit *before* their images rather than in a list up front, because
 * a model handed forty pictures and one list of forty times has to align two
 * sequences from memory — and it gets that wrong often enough to put a step a
 * minute away from where it happened.
 */
export function contentParts(
  stills: Still[],
  audio: { mimeType: string; data: string; from: number } | null,
): Part[] {
  const parts: Part[] = [];

  for (const still of stills) {
    parts.push({ text: frameLabel(still.at) });
    parts.push({ inlineData: { mimeType: still.mimeType, data: still.data } });
  }

  if (audio) {
    parts.push({ text: audioPreamble(audio.from) });
    parts.push({ inlineData: { mimeType: audio.mimeType, data: audio.data } });
  }

  return parts;
}

export interface AnalysisProgress {
  /** 0 → 1 over the whole recording. */
  ratio: number;
  window: number;
  total: number;
  /** What is happening inside this window, for the detail line. */
  phase: 'sampling' | 'analysing';
  sample?: SampleProgress;
}

/**
 * Reads one window of the recording.
 *
 * The audio is best-effort: a screen recording with no sound track at all is
 * completely normal, and `ai_audio_excerpt` says so rather than failing. The
 * stills are what the analysis actually stands on.
 */
async function analyseWindow(
  asset: MediaAsset,
  window: { start: number; duration: number; times: number[] },
  settings: AiSettings,
  options: TutorialOptions,
  onProgress: (sample: SampleProgress) => void,
  signal?: AbortSignal,
): Promise<{ steps: TutorialStep[]; stills: number }> {
  const stills = await grabStills(asset, window.times, onProgress, signal);
  if (stills.length === 0 || signal?.aborted) return { steps: [], stills: 0 };

  let audio: { mimeType: string; data: string; from: number } | null = null;
  try {
    const excerpt = await audioExcerpt(
      asset,
      window.start,
      Math.min(window.duration, AUDIO_LIMIT),
    );
    // `sourceStart` rather than `window.start`: the browser host cannot trim,
    // and says so by handing back 0.
    audio = { mimeType: excerpt.mimeType, data: excerpt.data, from: excerpt.sourceStart };
  } catch {
    /* silent recording, or a track ffmpeg would not open — the stills stand alone */
  }

  const result = await generate(
    settings.model,
    {
      systemInstruction: {
        parts: [
          {
            text: tutorialSystem({
              audience: options.audience,
              banners: options.banners,
              duration: asset.duration,
              window:
                window.start > 0 || window.duration < asset.duration
                  ? { start: window.start, end: window.start + window.duration }
                  : null,
              language: options.language,
              instructions: options.brief,
              voiceover: options.voiceover,
            }),
          },
        ],
      },
      contents: [{ role: 'user', parts: contentParts(stills, audio) }],
      generationConfig: {
        // Judgement about what matters, none about what happened.
        temperature: 0.3,
        responseMimeType: 'application/json',
        responseSchema: TUTORIAL_SCHEMA,
      },
    },
    // Forty images and a compressed soundtrack is a large request; it is
    // routinely a minute or two of thinking, and the ceiling is generous
    // because failing at four minutes wastes everything already uploaded.
    { signal, timeoutSecs: 420, fallbacks: fallbackChain(settings) },
  );

  return { steps: normalizeSteps(result.text, asset.duration), stills: stills.length };
}

export interface AnalysisOutcome {
  steps: TutorialStep[];
  /** Windows that produced nothing — reported, not hidden. */
  failed: number;
  stills: number;
}

/**
 * The whole recording, as one ordered list of steps.
 *
 * A window that fails does not sink the run: its steps are missing, which is a
 * smaller loss than starting again on a recording that took two minutes to
 * sample. The caller is told how many were lost so it can say so rather than
 * presenting a partial tutorial as a complete one.
 */
export async function analyseTutorial(
  asset: MediaAsset,
  settings: AiSettings,
  options: TutorialOptions,
  onProgress: (progress: AnalysisProgress) => void,
  signal?: AbortSignal,
): Promise<AnalysisOutcome> {
  const spans = samplingPlan(asset.duration, options.frameCount);
  const collected: TutorialStep[] = [];
  let failed = 0;
  let stills = 0;

  for (let index = 0; index < spans.length; index += 1) {
    if (signal?.aborted) break;
    const span = spans[index]!;
    const base = index / spans.length;
    const share = 1 / spans.length;

    const report = (phase: 'sampling' | 'analysing', within: number, sample?: SampleProgress) =>
      onProgress({
        ratio: base + share * within,
        window: index + 1,
        total: spans.length,
        phase,
        ...(sample ? { sample } : {}),
      });

    report('sampling', 0);

    try {
      const outcome = await analyseWindow(
        asset,
        span,
        settings,
        options,
        (sample) => {
          // Sampling owns the first two thirds of a window's share: it is the
          // part that visibly takes time, one ffmpeg process per frame.
          report('sampling', (sample.taken / Math.max(1, sample.total)) * 0.66, sample);
          if (sample.taken === sample.total) report('analysing', 0.66, sample);
        },
        signal,
      );
      collected.push(...outcome.steps);
      stills += outcome.stills;
      if (outcome.steps.length === 0) failed += 1;
    } catch (error) {
      // A cancellation is the user's decision and must not be swallowed as a
      // failed window; anything else costs us this slice of the recording.
      if (signal?.aborted) throw error;
      failed += 1;
    }
  }

  onProgress({ ratio: 1, window: spans.length, total: spans.length, phase: 'analysing' });

  // Windows are read independently, so a step at the seam can duplicate the one
  // before it — the same tightening the single-window case already does, now
  // applied across the joins.
  return { steps: tighten(dedupe(collected), asset.duration), failed, stills };
}

/** Drops a step that repeats the one before it across a window boundary. */
function dedupe(steps: TutorialStep[]): TutorialStep[] {
  const ordered = [...steps].sort((a, b) => a.at - b.at);
  const out: TutorialStep[] = [];

  for (const step of ordered) {
    const previous = out[out.length - 1];
    if (previous && step.at - previous.at < MIN_APART) continue;
    out.push(step);
  }

  return out;
}
