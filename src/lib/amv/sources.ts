/**
 * Choosing what to show, and from where inside it.
 *
 * Two decisions, and they are different problems. *Which* clip comes next is
 * about variety — the montage should not show the same source twice in a row,
 * and should not favour whichever file the filesystem happened to list first.
 * *Where* in that clip is about not showing the same three seconds every time
 * it comes round, which is what makes a twenty-shot montage built from six
 * files look like twenty shots rather than six on a loop.
 *
 * Everything here is seeded. Two runs over the same folder with the same seed
 * produce the same montage, and changing the seed produces a genuinely
 * different one — which is the difference between "try another arrangement" and
 * "re-import everything and hope".
 */

import type { MediaAsset } from '@/types/media';
import type { PhaseId } from '@/types/amv';
import type { ClipRole } from '@/types/director';

/**
 * xorshift32 — small, fast, and above all *reproducible*.
 *
 * The same generator the background painter uses, for the same reason: the
 * quality of the randomness matters far less than the fact that one seed always
 * gives one answer. Restated rather than shared because a painter has no
 * business exporting a PRNG, and eight lines of arithmetic is a cheaper
 * coupling than a module that exists to hold them.
 */
function rng(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/**
 * Seconds skipped at each end of a source.
 *
 * Clips assembled from anything real — a rip, an export, a download — tend to
 * open on a fade and close on one, and a montage that keeps landing on black
 * frames looks broken rather than rhythmic. Cheap insurance, and small enough
 * that it costs nothing on a clip that does not need it.
 */
const HEAD_SKIP = 0.4;
const TAIL_SKIP = 0.3;

/** What one shot will be cut from. */
export interface SourceShot {
  asset: MediaAsset;
  /** In-point inside the source, in seconds. */
  offset: number;
  /**
   * Seconds actually available from `offset`.
   *
   * Equal to what was asked for, except on a source too short to supply it —
   * the caller shortens the clip rather than running past the end of the file,
   * and says how often that happened.
   */
  available: number;
}

/** A source has to be able to give at least this much to be worth using. */
const MIN_USABLE = 0.3;

/**
 * Sources long enough to cut from, in the order they were given.
 *
 * Video only, and only video that reported a duration. A still has nothing to
 * walk an in-point through, and a file that failed to probe reports zero — it
 * would be picked, produce a zero-length clip, and leave a hole in the montage.
 */
export const usableSources = (assets: MediaAsset[]): MediaAsset[] =>
  assets.filter(
    (asset) =>
      !asset.missing && asset.kind === 'video' && asset.duration > MIN_USABLE + HEAD_SKIP,
  );

/**
 * A picker that walks the bank without repeating itself.
 *
 * Shuffled deck rather than round-robin or plain random. Round-robin gives the
 * same rotation every time and reads as a pattern within about four shots;
 * plain random clusters, and a montage that shows one clip four times in six
 * looks like a bug in the picker. A deck dealt out and reshuffled gives every
 * source an equal turn *and* a fresh order each pass — and the reshuffle
 * refuses to open on the card it just closed with, which is the one place the
 * two passes could still show the same clip twice in a row.
 *
 * The in-point walks forward through each source independently, so the second
 * time a clip comes round it shows what happens next rather than replaying its
 * own opening.
 */
export function createPicker(
  sources: MediaAsset[],
  seed: number,
  /**
   * Which movement each clip was cast into, when something has an opinion.
   *
   * Empty is the wizard's own case — every clip is eligible everywhere, and the
   * behaviour is exactly what it was before casting existed.
   */
  roles: Record<string, ClipRole> = {},
  /** The clip to open on, dealt first and then returned to the bank. */
  opening: string | null = null,
): (duration: number, phase?: PhaseId) => SourceShot | null {
  const bank = usableSources(sources);
  if (bank.length === 0) return () => null;

  const random = rng(seed);
  const cursors = new Map<string, number>();
  const decks = new Map<string, MediaAsset[]>();
  let previous: MediaAsset | null = null;
  let opened = false;

  /**
   * The clips eligible for a movement.
   *
   * A cast that is thin — one clip for the whole drop — falls back to the whole
   * bank rather than showing that clip forty times in a row. The casting is a
   * preference the sequencer honours where it can, not a fence it will walk a
   * montage into a wall for.
   */
  const eligible = (phase: PhaseId | undefined): MediaAsset[] => {
    if (!phase) return bank;
    const cast = bank.filter((asset) => roles[asset.id] === phase);
    const open = bank.filter((asset) => (roles[asset.id] ?? 'any') === 'any');
    const pool = [...cast, ...open];
    return pool.length >= 2 ? pool : bank;
  };

  const shuffle = (pool: MediaAsset[]): MediaAsset[] => {
    const out = [...pool];
    // Fisher–Yates, walked from the end so every permutation is equally likely.
    for (let index = out.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [out[index], out[swap]] = [out[swap], out[index]];
    }
    // One source cannot avoid following itself, and pretending otherwise would
    // spin here forever.
    if (out.length > 1 && out[out.length - 1] === previous) {
      [out[0], out[out.length - 1]] = [out[out.length - 1], out[0]];
    }
    return out;
  };

  return (duration, phase) => {
    /*
     * The opening shot, once.
     *
     * Dealt ahead of any deck and then left in the bank like everything else:
     * "open on this" is a decision about the first frame, not a reservation.
     */
    let asset: MediaAsset | null = null;
    if (!opened && opening) {
      asset = bank.find((item) => item.id === opening) ?? null;
      opened = true;
    }

    if (!asset) {
      // A deck per movement, so a cast clip is not spent by the movement before
      // the one it was cast into.
      const key = phase ?? 'any';
      const deck = decks.get(key) ?? [];
      if (deck.length === 0) deck.push(...shuffle(eligible(phase)));
      // Dealt from the end: `pop` is the cheap end of the array, and the
      // shuffle above put the guarded card there.
      asset = deck.pop() ?? (bank[0] as MediaAsset);
      decks.set(key, deck);
    }
    previous = asset;

    const last = Math.max(HEAD_SKIP, asset.duration - TAIL_SKIP);
    const cursor = cursors.get(asset.id) ?? HEAD_SKIP;
    // Back to the head when what is left would not fill the shot — a wrap that
    // shows a fragment first would put the same partial moment on screen every
    // time the source came round.
    const offset = cursor + duration > last ? HEAD_SKIP : cursor;

    cursors.set(asset.id, offset + duration);

    return {
      asset,
      offset,
      available: Math.max(0, Math.min(duration, asset.duration - offset)),
    };
  };
}
