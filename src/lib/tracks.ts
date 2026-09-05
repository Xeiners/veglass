/**
 * Finding, or making, the track a generated layer belongs on.
 *
 * Lifted out of `lib/tutorial/build` when the AMV sequencer needed the same two
 * functions. They were about to become a fifth near-copy of "look for a track
 * with this name, invent one if it is not there" — and the rule they encode is
 * one every generator has to agree on, not one each is entitled to its own
 * version of.
 *
 * Both are pure. Neither touches a store, and neither writes to the project:
 * they hand back a track and a flag, and the caller folds it into the document
 * inside its own transaction.
 */

import { uid } from '@/lib/id';
import { DEFAULT_TRACK_HEIGHT, type Track } from '@/types/timeline';
import type { Project } from '@/types/project';

/**
 * A named track, reused across runs rather than stacked.
 *
 * The bargain every generator strikes with "Clips viraux", "Écran" and
 * "Montage AMV" alike: running a wizard twice should give two montages one
 * after the other, not two layers of tracks that have to be tidied up by hand.
 */
export function namedTrack(
  project: Project,
  name: string,
  kind: Track['kind'],
): { track: Track; created: boolean } {
  const existing = project.tracks.find((track) => track.kind === kind && track.name === name);
  if (existing) return { track: existing, created: false };

  return {
    track: {
      id: uid('tr'),
      kind,
      name,
      height: DEFAULT_TRACK_HEIGHT,
      muted: false,
      solo: false,
      locked: false,
      hidden: false,
    },
    created: true,
  };
}

/** Video layers stack on top, audio layers below — the compositing order. */
export const withTrack = (tracks: Track[], created: Track | null): Track[] => {
  if (!created) return tracks;
  return created.kind === 'video' ? [created, ...tracks] : [...tracks, created];
};
