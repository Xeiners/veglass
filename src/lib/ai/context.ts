/**
 * What the model is told about the project.
 *
 * A language model cannot see the timeline, so every request carries a
 * description of it. The shape below is chosen for two things at once:
 *
 * * **Grounding.** Ids are included because the plan comes back referring to
 *   them; without ids every action would have to be matched by name, and names
 *   repeat. The registries of effects, transitions and fonts are included for
 *   the same reason — a model that is shown the six filters that exist does not
 *   propose a seventh.
 * * **Economy.** A four-hundred-clip montage would otherwise spend the whole
 *   context window describing itself. Long lists are truncated, and the
 *   truncation is stated in the payload so the model knows it is looking at a
 *   sample rather than the whole.
 *
 * Nothing here is a secret: file *names* travel, absolute paths do not.
 */

import { projectDuration } from '@/store/editorStore';
import { clipEnd, type Clip } from '@/types/timeline';
import { BACKGROUNDS } from '@/types/background';
import { EFFECTS } from '@/types/effects';
import { TRANSITIONS } from '@/types/transitions';
import { FONTS } from '@/types/text';
import type { Project } from '@/types/project';

/** Past this, a description costs more than it informs. */
const MAX_CLIPS = 160;
const MAX_ASSETS = 60;
/** Text content is summarised rather than quoted in full. */
const MAX_TEXT_CHARS = 120;

const round = (value: number, decimals = 3): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

export interface ContextOptions {
  playhead: number;
  /** Every selected clip, in selection order. */
  selectedClipIds: string[];
  workIn: number | null;
  workOut: number | null;
}

/**
 * The project as JSON the model can read.
 *
 * Returned as a string rather than an object because it goes straight into a
 * prompt part; building it here keeps the rounding and the truncation in one
 * place instead of scattered across three features.
 */
export function describeProject(project: Project, options: ContextOptions): string {
  const duration = projectDuration(project);

  const tracks = project.tracks.map((track, index) => ({
    id: track.id,
    name: track.name,
    kind: track.kind,
    // Index *is* the compositing order, top-down — the model needs to know
    // that V2 sits above V1 to place a title correctly.
    layer: index,
    locked: track.locked || undefined,
    muted: track.muted || undefined,
    hidden: track.hidden || undefined,
  }));

  const assets = project.assets.slice(0, MAX_ASSETS).map((asset) => ({
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    duration: round(asset.duration, 2),
    ...(asset.width && asset.height ? { size: `${asset.width}×${asset.height}` } : {}),
    ...(asset.missing ? { missing: true } : {}),
  }));

  const selected = new Set(options.selectedClipIds);
  const ordered = [...project.clips].sort((a, b) => a.start - b.start);
  // Selected clips are always described, however long the montage is: they are
  // the ones the request is most likely to be about, and truncating them away
  // is the one omission that would make an answer wrong rather than vague.
  const shown = ordered.slice(0, MAX_CLIPS);
  for (const clip of ordered.slice(MAX_CLIPS)) {
    if (selected.has(clip.id)) shown.push(clip);
  }
  const clips = shown.map((clip) => describeClip(clip, selected.has(clip.id)));

  const payload = {
    settings: {
      width: project.settings.width,
      height: project.settings.height,
      fps: project.settings.fps,
      durationSeconds: round(duration, 2),
    },
    playhead: round(options.playhead, 2),
    // The reference an action may use instead of naming each id in turn.
    selection: options.selectedClipIds,
    workArea:
      options.workIn !== null || options.workOut !== null
        ? { in: round(options.workIn ?? 0, 2), out: round(options.workOut ?? duration, 2) }
        : null,
    tracks,
    assets,
    assetsTruncated: project.assets.length > MAX_ASSETS ? project.assets.length : undefined,
    clips,
    clipsTruncated: ordered.length > MAX_CLIPS ? ordered.length : undefined,
    // The vocabulary of the plan, so nothing has to be guessed.
    available: {
      effects: EFFECTS.map((effect) => effect.kind),
      // Listed here as well as in the instruction: this block is the concrete
      // vocabulary, and a capability missing from it reads as unavailable
      // however clearly the prompt says otherwise.
      backgrounds: BACKGROUNDS.map((item) => item.kind),
      transitions: TRANSITIONS.map((item) => item.kind),
      fonts: FONTS.map((font) => font.id),
      animatableChannels: [
        'x',
        'y',
        'scale',
        'rotation',
        'opacity',
        'volume',
        'bg:speed',
        'bg:scale',
        'bg:intensity',
      ],
    },
  };

  return JSON.stringify(payload);
}

/**
 * One clip, with the values a relative request needs.
 *
 * The transform and level fields are emitted only when they differ from the
 * default, which keeps a long montage compact while still letting "agrandis-le
 * de 20 %" be answered — a model that cannot see the current scale can only
 * guess at the new one.
 */
function describeClip(clip: Clip, selected: boolean) {
  const animated = Object.keys(clip.animation ?? {});
  return {
    id: clip.id,
    ...(selected ? { selected: true } : {}),
    kind: clip.kind,
    track: clip.trackId,
    start: round(clip.start, 2),
    end: round(clipEnd(clip), 2),
    duration: round(clip.duration, 2),
    ...(clip.offset > 0 ? { sourceIn: round(clip.offset, 2) } : {}),
    ...(clip.assetId ? { asset: clip.assetId } : {}),
    ...(clip.label ? { label: clip.label } : {}),
    ...(clip.text ? { text: truncate(clip.text.content, MAX_TEXT_CHARS) } : {}),
    ...(clip.effects.length > 0
      ? { effects: clip.effects.map((effect) => effect.kind) }
      : {}),
    ...(animated.length > 0 ? { animated } : {}),
    ...(clip.muted ? { muted: true } : {}),
    ...(clip.scale !== 1 ? { scale: round(clip.scale, 3) } : {}),
    ...(clip.opacity !== 1 ? { opacity: round(clip.opacity, 3) } : {}),
    ...(clip.x !== 0 ? { x: round(clip.x, 1) } : {}),
    ...(clip.y !== 0 ? { y: round(clip.y, 1) } : {}),
    ...(clip.rotation !== 0 ? { rotation: round(clip.rotation, 1) } : {}),
    ...(clip.volume !== 1 ? { volume: round(clip.volume, 3) } : {}),
  };
}
