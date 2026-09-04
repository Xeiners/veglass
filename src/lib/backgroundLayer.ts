/**
 * Placing a generated background.
 *
 * Its own module because two callers need exactly the same answer — the toolbar
 * button and the assistant's `addBackground` action — and a background placed
 * one way by hand and another way by the assistant would be a bug nobody could
 * explain.
 *
 * The rule it encodes is short: **a background goes at the bottom of the video
 * stack**. List order is compositing order, so one dropped on top would hide
 * the montage it exists to sit behind.
 */

import { uid } from '@/lib/id';
import { snapToFrame } from '@/lib/time';
import {
  DEFAULT_BACKGROUND_DURATION,
  defaultBackground,
  type BackgroundKind,
  type BackgroundLayer,
} from '@/types/background';
import {
  DEFAULT_TRACK_HEIGHT,
  MIN_CLIP_DURATION,
  clipEnd,
  type Clip,
  type Track,
} from '@/types/timeline';
import type { Project } from '@/types/project';

export interface BackgroundPlacement {
  project: Project;
  clip: Clip;
}

/**
 * Adds a background clip, choosing the lowest video layer that is free.
 *
 * When every one of them is busy at that instant a layer is invented at the
 * *foot* of the video block — after the last picture track, before the audio —
 * rather than on top, which is where every other new track goes.
 */
export function placeBackground(
  project: Project,
  kind: BackgroundKind,
  options: { at?: number; duration?: number; layer?: Partial<BackgroundLayer> } = {},
): BackgroundPlacement {
  const { fps } = project.settings;
  const start = snapToFrame(Math.max(0, options.at ?? 0), fps);
  const duration = snapToFrame(
    Math.max(MIN_CLIP_DURATION, options.duration ?? DEFAULT_BACKGROUND_DURATION),
    fps,
  );

  const free = [...project.tracks]
    .reverse()
    .find(
      (track) =>
        track.kind === 'video' &&
        !track.locked &&
        !project.clips.some(
          (clip) =>
            clip.trackId === track.id && start < clipEnd(clip) && start + duration > clip.start,
        ),
    );

  const created: Track | null = free
    ? null
    : {
        id: uid('tr'),
        kind: 'video',
        name: `V${project.tracks.filter((track) => track.kind === 'video').length + 1}`,
        height: DEFAULT_TRACK_HEIGHT,
        muted: false,
        solo: false,
        locked: false,
        hidden: false,
      };

  const clip: Clip = {
    id: uid('cl'),
    kind: 'background',
    assetId: null,
    trackId: free?.id ?? (created as Track).id,
    start,
    duration,
    offset: 0,
    volume: 1,
    opacity: 1,
    scale: 1,
    x: 0,
    y: 0,
    rotation: 0,
    muted: true,
    label: 'Fond',
    effects: [],
    background: { ...defaultBackground(kind), ...options.layer },
  };

  if (!created) {
    return { project: { ...project, clips: [...project.clips, clip] }, clip };
  }

  const lastVideo = project.tracks.reduce(
    (index, track, at) => (track.kind === 'video' ? at : index),
    -1,
  );
  const tracks = [...project.tracks];
  tracks.splice(lastVideo + 1, 0, created);

  return { project: { ...project, tracks, clips: [...project.clips, clip] }, clip };
}
