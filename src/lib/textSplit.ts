/**
 * Breaking a text layer into one clip per word.
 *
 * The staple of social-media typography: a line arrives a word at a time, each
 * one landing on the beat. Doing it by hand means cutting a clip fifteen times
 * and retyping every piece, which is why nobody does it by hand.
 *
 * Pure, like the rest of the generated edits: a `Project` in, a `Project` out,
 * so a fifteen-word line becomes one undo step rather than fifteen.
 *
 * The only real decision here is how to share the duration out. Equal slices
 * read badly — "je" and "extraordinaire" hold the screen for the same time,
 * which looks mechanical because it *is* mechanical. Weighting by length is
 * closer to how the words are actually said, and close enough that the result
 * needs nudging rather than redoing.
 */

import { uid } from '@/lib/id';
import { snapToFrame } from '@/lib/time';
import { entranceAnimation } from '@/lib/ai/motion';
import { MIN_CLIP_DURATION, type Clip } from '@/types/timeline';
import type { Project } from '@/types/project';
import type { SubtitleAnimation } from '@/types/ai';

/** How a line is cut up. */
export type SplitUnit = 'word' | 'line';

export interface SplitOptions {
  unit: SplitUnit;
  /** Entrance applied to every piece. */
  animation: SubtitleAnimation;
}

export const DEFAULT_SPLIT_OPTIONS: SplitOptions = { unit: 'word', animation: 'punch' };

/**
 * The pieces a layer's content breaks into.
 *
 * Punctuation stays welded to the word it follows — a comma on a clip of its
 * own would flash for two frames and read as a glitch.
 */
export function tokenize(content: string, unit: SplitUnit): string[] {
  const source = unit === 'line' ? content.split(/\r?\n/) : content.split(/\s+/);
  return source.map((piece) => piece.trim()).filter((piece) => piece.length > 0);
}

/**
 * Seconds per piece, weighted by length and snapped to frames.
 *
 * The floor matters more than the weighting: a two-letter word must still last
 * long enough to be seen, and the frame snap has to leave the run covering
 * exactly the span the original clip did — a rounding error repeated fifteen
 * times is a visible drift.
 */
function share(pieces: string[], duration: number, fps: number): number[] | null {
  const floor = Math.max(MIN_CLIP_DURATION, 1 / fps);
  if (pieces.length === 0 || duration < floor * pieces.length) return null;

  const weights = pieces.map((piece) => Math.max(2, piece.length));
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  const out: number[] = [];
  let used = 0;
  for (let index = 0; index < pieces.length; index += 1) {
    const remaining = pieces.length - index - 1;
    // Whatever is left has to keep the pieces after this one above the floor.
    const ceiling = duration - used - remaining * floor;
    const wanted = (duration * (weights[index] as number)) / total;
    const value =
      index === pieces.length - 1
        ? duration - used
        : snapToFrame(Math.min(Math.max(wanted, floor), ceiling), fps);
    out.push(value);
    used += value;
  }

  return out.every((value) => value >= floor - 1e-9) ? out : null;
}

export interface SplitOutcome {
  project: Project;
  /** Clips created, across every layer that was split. */
  pieces: number;
  /** Clips that could not be split, and why — shown rather than swallowed. */
  skipped: { clipId: string; reason: string }[];
}

/**
 * Replaces each named text clip with a run of one clip per word.
 *
 * Everything else about the layer is carried over untouched: track, style,
 * position, effects. Only the content, the timing and the entrance change.
 */
export function splitTextClips(
  project: Project,
  clipIds: string[],
  options: SplitOptions = DEFAULT_SPLIT_OPTIONS,
): SplitOutcome {
  const { fps } = project.settings;
  const targets = new Set(clipIds);
  const skipped: { clipId: string; reason: string }[] = [];
  const clips: Clip[] = [];
  let pieces = 0;

  for (const clip of project.clips) {
    if (!targets.has(clip.id) || clip.kind !== 'text' || !clip.text) {
      if (targets.has(clip.id)) {
        skipped.push({ clipId: clip.id, reason: 'ce clip ne porte pas de texte' });
      }
      clips.push(clip);
      continue;
    }

    // Captured before the loop: narrowing on `clip.text` does not survive into
    // the closure below, and the layer is what every piece is built from.
    const layer = clip.text;
    const words = tokenize(layer.content, options.unit);
    if (words.length < 2) {
      skipped.push({ clipId: clip.id, reason: 'un seul mot — rien à découper' });
      clips.push(clip);
      continue;
    }

    const durations = share(words, clip.duration, fps);
    if (!durations) {
      skipped.push({
        clipId: clip.id,
        reason: `trop court pour ${words.length} mots`,
      });
      clips.push(clip);
      continue;
    }

    let cursor = clip.start;
    words.forEach((word, index) => {
      const duration = durations[index] as number;
      const piece: Clip = {
        ...clip,
        // The first piece keeps the layer's identity, so a selection or an
        // inspector focus survives the operation.
        id: index === 0 ? clip.id : uid('cl'),
        start: snapToFrame(cursor, fps),
        duration,
        effects: clip.effects.map((effect) => ({
          ...effect,
          id: index === 0 ? effect.id : uid('fx'),
          params: { ...effect.params },
        })),
        label: word.slice(0, 24),
        text: { ...layer, content: word },
      };
      cursor += duration;

      const animation = entranceAnimation(piece, options.animation, fps);
      // An absent map is the signal the rest of the editor tests for, so the
      // key is dropped rather than set to `undefined`.
      if (animation) clips.push({ ...piece, animation });
      else {
        const { animation: _dropped, ...rest } = piece;
        clips.push(rest as Clip);
      }
    });

    pieces += words.length;
  }

  return { project: { ...project, clips }, pieces, skipped };
}
