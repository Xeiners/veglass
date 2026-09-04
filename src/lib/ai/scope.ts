/**
 * What a pass listens to.
 *
 * Subtitling and smart cut ask the same question — *which stretches of which
 * source files are actually audible in this part of the montage?* — so they ask
 * it in one place. Answering per clip rather than per file is what keeps both
 * features honest about the edit: a clip trimmed to its middle ten seconds is
 * analysed over those ten seconds of source, not over the whole take.
 */

import { clipEnd, type Clip } from '@/types/timeline';
import type { MediaAsset } from '@/types/media';
import type { Project } from '@/types/project';

/** Below this, a clip is a frame or two of handle — nothing to listen to. */
const MIN_DURATION = 0.4;

/** The part of the timeline a pass covers. */
export type AudioScope = 'clip' | 'work' | 'timeline';

export interface AudioJob {
  clip: Clip;
  asset: MediaAsset;
  /** In-point inside the source file. */
  sourceStart: number;
  /** Seconds of source to read — the audible length, after any clamping. */
  duration: number;
  /**
   * Where this excerpt begins on the timeline. Timings that come back relative
   * to the excerpt are shifted by exactly this to become timeline times.
   */
  timelineStart: number;
}

export interface ScopeContext {
  selectedClipId: string | null;
  workIn: number | null;
  workOut: number | null;
}

/**
 * The audible clips in `scope`, in timeline order.
 *
 * Muted clips and muted tracks are skipped: transcribing something the audience
 * cannot hear, or cutting silence out of a layer that is off, is a bug rather
 * than a thorough pass.
 */
export function audioJobs(
  project: Project,
  scope: AudioScope,
  context: ScopeContext,
): AudioJob[] {
  const window =
    scope === 'work' && (context.workIn !== null || context.workOut !== null)
      ? { from: context.workIn ?? 0, to: context.workOut ?? Infinity }
      : null;

  const candidates =
    scope === 'clip'
      ? project.clips.filter((clip) => clip.id === context.selectedClipId)
      : project.clips;

  const jobs: AudioJob[] = [];

  for (const clip of candidates) {
    if (clip.kind !== 'media' || clip.muted) continue;
    const track = project.tracks.find((item) => item.id === clip.trackId);
    if (!track || track.muted) continue;

    const asset = project.assets.find((item) => item.id === clip.assetId);
    if (!asset || asset.missing || asset.kind === 'image') continue;

    // A work area that starts mid-clip clamps the excerpt rather than dropping
    // it — the range the user set is the range they expect to be treated.
    let start = clip.start;
    let end = clipEnd(clip);
    if (window) {
      start = Math.max(start, window.from);
      end = Math.min(end, window.to);
    }
    const duration = end - start;
    if (duration < MIN_DURATION) continue;

    jobs.push({
      clip,
      asset,
      sourceStart: clip.offset + (start - clip.start),
      duration,
      timelineStart: start,
    });
  }

  return jobs.sort((a, b) => a.timelineStart - b.timelineStart);
}
