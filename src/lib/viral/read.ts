/**
 * Reading a long recording, in pieces.
 *
 * `ai::audio::excerpt` refuses anything over 13 MB and says so — which, at the
 * bitrate it encodes to, lands somewhere near a hundred minutes. This feature's
 * entire premise is long recordings, so hitting that ceiling is the expected
 * case rather than the edge one, and a single request would also mean a single
 * progress bar that sits at nothing for four minutes.
 *
 * So the file is read in windows, sequentially. Sequential rather than parallel
 * on purpose: the account has a request-per-minute quota, and three requests
 * racing to exhaust it is a worse failure than one taking longer.
 */

import { transcribe } from '@/lib/ai/subtitles';
import { mergeSegments } from '@/lib/ai/subtitles';
import type { AudioJob } from '@/lib/ai/scope';
import type { AiSettings, SubtitleOptions, TranscriptSegment } from '@/types/ai';
import { DEFAULT_SUBTITLE_OPTIONS } from '@/types/ai';
import type { MediaAsset } from '@/types/media';
import type { Clip } from '@/types/timeline';

/**
 * How much audio goes in one request.
 *
 * Comfortably inside the size ceiling, and short enough that a failure costs
 * one window rather than the whole recording.
 */
export const WINDOW_SECONDS = 15 * 60;

/** A window shorter than this is not worth a round trip of its own. */
const MIN_TAIL = 20;

/**
 * The windows a recording is read in.
 *
 * A short trailing remainder is folded into the previous window instead of
 * becoming a request that transcribes nine seconds of goodbyes.
 */
export function windows(duration: number, span = WINDOW_SECONDS): { start: number; duration: number }[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  if (duration <= span) return [{ start: 0, duration }];

  const out: { start: number; duration: number }[] = [];
  for (let start = 0; start < duration; start += span) {
    out.push({ start, duration: Math.min(span, duration - start) });
  }

  const last = out[out.length - 1];
  if (out.length > 1 && last && last.duration < MIN_TAIL) {
    out.pop();
    const previous = out[out.length - 1] as { start: number; duration: number };
    previous.duration += last.duration;
  }

  return out;
}

/**
 * A transcription job for a window of a bare asset.
 *
 * `transcribe` is written against a clip on the timeline, and maps what comes
 * back through it. Here there is no clip — the source may not be on the
 * timeline at all — so this hands it a stand-in laid at t = 0 with no in-point.
 * Both terms of its shift then cancel and the timings come back in **source
 * time**, which is what the analysis and the framing both work in.
 */
export function sourceJob(asset: MediaAsset, start: number, duration: number): AudioJob {
  const stand_in: Clip = {
    id: `viral-source-${asset.id}`,
    kind: 'media',
    assetId: asset.id,
    trackId: '',
    start: 0,
    duration: Math.max(asset.duration, start + duration),
    offset: 0,
    volume: 1,
    opacity: 1,
    scale: 1,
    x: 0,
    y: 0,
    rotation: 0,
    muted: false,
    effects: [],
  };

  return { clip: stand_in, asset, sourceStart: start, duration, timelineStart: start };
}

export interface ReadProgress {
  /** 0 → 1 across the whole recording. */
  ratio: number;
  window: number;
  total: number;
}

/**
 * The whole recording, as one ordered transcript in source time.
 *
 * A window that fails does not sink the run: its words are missing from the
 * analysis, which is a smaller loss than starting again. The caller is told how
 * many were lost so it can say so rather than pretending the reading was clean.
 */
export async function readTranscript(
  asset: MediaAsset,
  settings: AiSettings,
  language: string,
  onProgress: (progress: ReadProgress) => void,
  signal?: AbortSignal,
): Promise<{ segments: TranscriptSegment[]; failed: number }> {
  const spans = windows(asset.duration);
  const groups: TranscriptSegment[][] = [];
  let failed = 0;

  const options: SubtitleOptions = {
    ...DEFAULT_SUBTITLE_OPTIONS,
    mode: 'transcribe',
    language,
    // Longer lines than a caption would take: this transcript is read by the
    // analysis first, and broken up again later if captions are wanted.
    maxCharsPerLine: 90,
    maxDuration: 12,
  };

  for (let index = 0; index < spans.length; index += 1) {
    if (signal?.aborted) break;
    const span = spans[index] as { start: number; duration: number };
    onProgress({ ratio: index / spans.length, window: index + 1, total: spans.length });

    try {
      groups.push(
        await transcribe(sourceJob(asset, span.start, span.duration), settings, options, signal),
      );
    } catch (error) {
      // A cancellation is the user's decision and must not be swallowed as a
      // failed window; anything else costs us this slice of the recording.
      if (signal?.aborted) throw error;
      failed += 1;
    }
  }

  onProgress({ ratio: 1, window: spans.length, total: spans.length });
  return { segments: mergeSegments(groups), failed };
}
