/**
 * Showing the model the screen.
 *
 * Gemini can take a whole video file, and for a two-minute recording that would
 * be the obvious thing to do. It is not what happens here, for three reasons
 * that all point the same way:
 *
 * * a screen recording is enormous and almost entirely redundant — a 4K capture
 *   of someone reading a form is thousands of near-identical frames;
 * * the inline payload ceiling is a few megabytes, which a raw recording of any
 *   useful length blows through immediately;
 * * ffmpeg is already here, and `ai_poster` already extracts one frame from
 *   anywhere in a file quickly, by seeking to the nearest keyframe.
 *
 * So the recording is sampled into stills, at a width where interface labels
 * are actually legible, and a fixed number of them per request. That number is
 * the real design constraint: it sets both the cost of a run and the finest
 * action the model can possibly notice, and it is why long recordings are read
 * in windows rather than in one enormous request.
 */

import { poster, READABLE_WIDTH } from '@/lib/viral/poster';
import type { MediaAsset } from '@/types/media';

/** The width every still is taken at. */
export const FRAME_WIDTH = READABLE_WIDTH;

/**
 * Stills per request.
 *
 * At this width a frame is roughly 60 – 90 kB of JPEG, so forty of them plus
 * the base64 expansion lands near 5 MB — comfortably inside the ceiling, with
 * room for the audio track beside it.
 */
export const MAX_FRAMES = 40;

/**
 * How much recording one request covers.
 *
 * Six minutes across forty frames is a still every nine seconds, which is about
 * the coarsest sampling that still catches a deliberate click. Going wider
 * would mean either more frames than the payload allows or a sampling rate that
 * walks straight past whole steps.
 */
export const WINDOW_SECONDS = 6 * 60;

/** A window shorter than this is folded into the one before it. */
const MIN_TAIL = 30;

export interface Window {
  start: number;
  duration: number;
}

/**
 * The windows a recording is analysed in.
 *
 * Same shape and the same reasoning as `lib/viral/read`: sequential, because
 * the account has a request-per-minute quota and three requests racing to
 * exhaust it is a worse failure than one taking longer. A short trailing
 * remainder joins its predecessor rather than becoming a request that analyses
 * eleven seconds of someone closing a window.
 */
export function windows(duration: number, span = WINDOW_SECONDS): Window[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  if (duration <= span) return [{ start: 0, duration }];

  const out: Window[] = [];
  for (let start = 0; start < duration; start += span) {
    out.push({ start, duration: Math.min(span, duration - start) });
  }

  const last = out[out.length - 1];
  if (out.length > 1 && last && last.duration < MIN_TAIL) {
    out.pop();
    const previous = out[out.length - 1] as Window;
    previous.duration += last.duration;
  }

  return out;
}

/**
 * When to take the stills for one window.
 *
 * Sampled at the *midpoint* of each slice rather than at its edge. A frame
 * taken exactly at t = 0 of a slice tends to catch a transition — a menu half
 * open, a dialog mid-fade — while the middle of the slice is the screen as it
 * actually sat there. The first and last frames of the whole recording are
 * pulled slightly inwards for the same reason.
 */
export function sampleTimes(window: Window, max = MAX_FRAMES): number[] {
  if (!Number.isFinite(window.duration) || window.duration <= 0) return [];

  const count = Math.max(1, Math.min(max, Math.round(window.duration / 2)));
  const slice = window.duration / count;

  return Array.from({ length: count }, (_, index) => {
    const at = window.start + slice * (index + 0.5);
    return Math.round(at * 100) / 100;
  });
}

export interface Still {
  /** Seconds from the start of the recording. */
  at: number;
  /** Raw base64, without the `data:` prefix — ready for an `inlineData` part. */
  data: string;
  mimeType: string;
}

/** Splits a `data:` URI back into the two halves an inline part wants. */
function partsOf(uri: string): { data: string; mimeType: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(uri);
  if (!match) return null;
  return { mimeType: match[1] as string, data: match[2] as string };
}

export interface SampleProgress {
  taken: number;
  total: number;
}

/**
 * Extracts the stills, one at a time.
 *
 * Sequential on purpose, exactly as the viral wizard's thumbnail pass is: each
 * one is an ffmpeg process, and forty at once on a 4K file makes the machine
 * unusable for as long as it takes.
 *
 * A frame that cannot be extracted is skipped rather than fatal. A recording
 * with a corrupt second in the middle should still produce a tutorial for the
 * rest of it, and the model is told nothing about the gap because there is
 * nothing useful it could do with the information.
 */
export async function grabStills(
  asset: MediaAsset,
  times: number[],
  onProgress: (progress: SampleProgress) => void,
  signal?: AbortSignal,
): Promise<Still[]> {
  const out: Still[] = [];

  for (let index = 0; index < times.length; index += 1) {
    if (signal?.aborted) break;
    const at = times[index] as number;

    try {
      const parts = partsOf(await poster(asset, at, FRAME_WIDTH));
      if (parts) out.push({ at, ...parts });
    } catch {
      /* one unreadable instant does not sink the recording */
    }

    onProgress({ taken: index + 1, total: times.length });
  }

  return out;
}
