/**
 * From a transcript to a list of proposed cuts.
 *
 * The trust boundary of this feature, in the same spirit as `lib/ai/plan.ts`:
 * everything the model returns is rebuilt field by field, and anything that
 * cannot be made sense of is dropped rather than repaired into something
 * plausible-looking. A clip that starts after it ends, or runs past the end of
 * the recording, is not a clip.
 *
 * The length band deserves a word. The model is asked for 30–60 seconds and
 * will still return a brilliant 14-second answer, because the interesting
 * sentence was 14 seconds long. Silently stretching it would put the cut in
 * the middle of the next sentence, so short proposals are *widened onto
 * sentence boundaries we already know* — the transcript's own segments — and
 * dropped only if even that cannot reach the floor.
 */

import { generate } from '@/lib/ai/client';
import { uid } from '@/lib/id';
import { analysisSystem, transcriptDigest } from './prompts';
import { CLIPS_SCHEMA } from './schema';
import { fallbackChain, type AiSettings, type TranscriptSegment } from '@/types/ai';
import { lengthOf, type ViralClip, type ViralOptions } from '@/types/viral';

/** Loose shape of one entry, before anything is trusted. */
interface RawClip {
  start?: unknown;
  end?: unknown;
  title?: unknown;
  hook?: unknown;
  reason?: unknown;
  score?: unknown;
  keywords?: unknown;
}

const number = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';

/**
 * The banner line, trimmed to something that actually fits the frame.
 *
 * The instruction asks for four or five words and the model will still return
 * a sentence, because a sentence is what it wanted to say. Six words is the
 * ceiling here rather than five: cutting a good seven-word line at five leaves
 * a fragment, and one extra word costs less than a broken phrase. Trailing
 * punctuation goes because a banner is not a sentence.
 */
export function hookLine(value: unknown, fallback: string): string {
  const raw = text(value, 120);
  const words = raw.split(' ').filter((word) => word.length > 0);

  const kept = (words.length > 6 ? words.slice(0, 6) : words)
    .join(' ')
    .replace(/[.,;:!?…]+$/u, '')
    .trim();

  // A model that skipped the field leaves the title, which is at least true —
  // an empty banner over the opening three seconds would read as a bug.
  return kept.length > 0 ? kept : fallback;
}

/**
 * Segments overlapping `[start, end)`, which become the clip's captions.
 *
 * A line that merely brushes the boundary is left out: half a word at the top
 * of a clip reads as a glitch, not as context.
 */
export function segmentsWithin(
  segments: TranscriptSegment[],
  start: number,
  end: number,
): TranscriptSegment[] {
  return segments
    .filter((segment) => {
      const overlap = Math.min(segment.end, end) - Math.max(segment.start, start);
      return overlap > Math.min(0.25, (segment.end - segment.start) / 2);
    })
    .map((segment) => ({ ...segment }));
}

/**
 * Pushes a too-short window out to the nearest sentence boundaries.
 *
 * Boundaries come from the transcript rather than from arithmetic, so the
 * widened clip still starts and ends where someone stopped talking. Returns
 * `null` when there is not enough material around it to reach `min`.
 */
export function widen(
  segments: TranscriptSegment[],
  start: number,
  end: number,
  min: number,
  max: number,
  ceiling: number,
): { start: number; end: number } | null {
  if (end - start >= min) return { start, end };

  const ordered = [...segments].sort((a, b) => a.start - b.start);
  let from = start;
  let to = end;

  // Alternate outwards so the added context is balanced rather than all
  // trailing — a hook needs its run-up as much as its landing.
  for (let guard = 0; guard < ordered.length * 2 && to - from < min; guard += 1) {
    const before = [...ordered].reverse().find((segment) => segment.start < from - 0.05);
    const after = ordered.find((segment) => segment.end > to + 0.05);

    const growBefore = before ? from - before.start : Infinity;
    const growAfter = after ? after.end - to : Infinity;
    if (!Number.isFinite(growBefore) && !Number.isFinite(growAfter)) break;

    if (growBefore <= growAfter) from = Math.max(0, (before as TranscriptSegment).start);
    else to = Math.min(ceiling, (after as TranscriptSegment).end);
  }

  if (to - from < min) return null;
  return { start: from, end: Math.min(to, from + max) };
}

/**
 * Rebuilds the model's answer into clips we are willing to show.
 *
 * Pure and synchronous, so the whole of it is testable without a network.
 */
export function normalizeClips(
  payload: string,
  segments: TranscriptSegment[],
  options: ViralOptions,
  duration: number,
): ViralClip[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }

  const container = parsed as { clips?: unknown };
  const raw = Array.isArray(container?.clips) ? container.clips : [];
  const band = lengthOf(options.length);

  const out: ViralClip[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as RawClip;

    const start = number(item.start);
    const end = number(item.end);
    if (start === null || end === null) continue;

    const from = Math.max(0, Math.min(start, duration));
    const to = Math.max(0, Math.min(end, duration));
    if (to - from < 1) continue;

    const window = widen(segments, from, to, band.min, band.max, duration);
    if (!window) continue;

    // Overlapping proposals are the model ignoring an instruction, not two
    // clips: the second would ship the same words twice.
    if (out.some((existing) => window.start < existing.end && window.end > existing.start)) {
      continue;
    }

    // The model only ever saw the transcript, so a window with no lines in it
    // is not a quiet moment it judged worth keeping — it is a time range it
    // invented. There is nothing to caption and nothing that was said.
    const lines = segmentsWithin(segments, window.start, window.end);
    if (lines.length === 0) continue;

    const title = text(item.title, 120);
    const score = number(item.score);

    const named = title || 'Extrait sans titre';

    out.push({
      id: uid('viral'),
      title: named,
      hook: hookLine(item.hook, named),
      reason: text(item.reason, 400),
      keywords: Array.isArray(item.keywords)
        ? item.keywords
            .map((word) => text(word, 32).toLowerCase())
            .filter((word) => word.length > 0)
            .slice(0, 4)
        : [],
      start: window.start,
      end: window.end,
      score: score === null ? 50 : Math.round(Math.min(100, Math.max(0, score))),
      focus: 0.5,
      poster: null,
      posterState: 'idle',
      segments: lines,
      placed: false,
    });
  }

  return out
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .slice(0, Math.max(1, options.count));
}

/**
 * Asks the model to find the cuts.
 *
 * The transcript goes as text, not as audio: it has already been paid for
 * during the reading pass, it is a fraction of the tokens, and reading beats
 * remembering — the same reason the alignment mode of the subtitle pass is more
 * reliable than its transcription mode.
 */
export async function findClips(
  segments: TranscriptSegment[],
  settings: AiSettings,
  options: ViralOptions,
  duration: number,
  signal?: AbortSignal,
): Promise<ViralClip[]> {
  const digest = transcriptDigest(segments);

  const result = await generate(
    settings.model,
    {
      systemInstruction: {
        parts: [
          {
            text: analysisSystem({
              length: options.length,
              tone: options.tone,
              count: options.count,
              duration,
              language: options.language,
              instructions: options.brief,
            }),
          },
        ],
      },
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `Voici la transcription horodatée. Trouve les extraits.\n\n${digest}`,
            },
          ],
        },
      ],
      generationConfig: {
        // Some judgement, but not invention: the timings must match the text.
        temperature: 0.4,
        responseMimeType: 'application/json',
        responseSchema: CLIPS_SCHEMA,
      },
    },
    { signal, timeoutSecs: 240, fallbacks: fallbackChain(settings) },
  );

  return normalizeClips(result.text, segments, options, duration);
}
