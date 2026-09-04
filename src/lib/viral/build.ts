/**
 * Turning a proposal into an edit.
 *
 * Everything here is a pure `Project → Project` (or `→ SerializedProject`), for
 * the same reason the rest of the AI suite is: the caller commits the result in
 * a single `transact`, so placing a clip, its reframe, its caption track and a
 * hundred word-by-word pieces is one press of Ctrl+Z.
 *
 * Two destinations, and they mean different things:
 *
 * * `placeInProject` drops the cut into the montage that is open, framed for
 *   **that project's** format. Putting a 9:16 crop into a 16:9 timeline would
 *   be pillarboxed nonsense, so the reframe follows the destination, not the
 *   wizard's answer.
 * * `sequenceFor` builds a new project at the format the wizard *did* ask for.
 *   This is where a vertical clip actually belongs, and it is the one that
 *   produces something ready to export for a phone.
 */

import { uid, projectId as newProjectId } from '@/lib/id';
import { buildSubtitleClips } from '@/lib/ai/subtitles';
import { splitTextClips } from '@/lib/textSplit';
import { serializeAsset } from '@/lib/media';
import { reframe } from './frame';
import { onTimeline, paceOf, silentGaps } from './gaps';
import { rippleDelete } from '@/lib/ai/silence';
import { DEFAULT_PROGRESS } from '@/types/progress';
import { DEFAULT_SUBTITLE_OPTIONS, SUBTITLE_TRACK_NAME, type TranscriptSegment } from '@/types/ai';
import type { MediaAsset } from '@/types/media';
import type { Project, ProjectSettings, SerializedProject } from '@/types/project';
import { SCHEMA_VERSION } from '@/types/project';
import type { Clip, Track } from '@/types/timeline';
import { DEFAULT_TRACK_HEIGHT, clipEnd } from '@/types/timeline';
import { VIRAL_TRACK_NAME, frameOf, type ViralClip, type ViralOptions } from '@/types/viral';
import {
  HOOK_SECONDS,
  HOOK_TRACK_NAME,
  kitLayer,
  kitText,
  type StyleKit,
} from '@/types/styleKit';

export interface PlaceOutcome {
  project: Project;
  /** Where the cut landed on the timeline, in seconds. */
  start: number;
  /** Seconds of dead air removed by the jump-cut pass. */
  tightened: number;
  captions: number;
  /** Whether the opening banner was written — it is skipped on an empty hook. */
  hooked: boolean;
  /** True when the destination's shape differs from the format the user picked. */
  reframed: boolean;
}

/** Timeline time for a moment in the source, once the cut is laid at `at`. */
const toTimeline = (segment: TranscriptSegment, from: number, at: number): TranscriptSegment => ({
  start: at + (segment.start - from),
  end: at + (segment.end - from),
  text: segment.text,
});

/**
 * Adds the captions for one placed cut, and breaks them into words if asked.
 *
 * Returns the document and how many text clips ended up on it — the caller
 * reports that number rather than guessing from the segment count, because the
 * placement pass drops any line that would collide with something already there.
 */
function addCaptions(
  project: Project,
  segments: TranscriptSegment[],
  options: ViralOptions,
  kit: StyleKit,
): { project: Project; captions: number } {
  if (!options.subtitles || segments.length === 0) return { project, captions: 0 };

  const before = new Set(project.clips.map((clip) => clip.id));

  // The kit resolves its fractions against *this* frame, so the same preset
  // gives captions that read the same in 9:16 and in 16:9.
  const style = kitLayer(kit.captions, project.settings);

  const built = buildSubtitleClips(
    project,
    segments.map((segment) => ({ ...segment, text: kitText(kit.captions, segment.text) })),
    {
      ...DEFAULT_SUBTITLE_OPTIONS,
      style,
      animation: kit.animation,
      language: options.language,
      // Short lines: these are captions for a phone held at arm's length.
      maxCharsPerLine: options.wordByWord ? 90 : 28,
      maxDuration: 5,
    },
  );

  const fresh = built.project.clips
    .filter((clip) => !before.has(clip.id) && clip.kind === 'text')
    .map((clip) => clip.id);

  if (!options.wordByWord || fresh.length === 0) {
    return { project: built.project, captions: fresh.length };
  }

  const split = splitTextClips(built.project, fresh, {
    unit: 'word',
    animation: kit.animation,
  });
  return { project: split.project, captions: split.pieces };
}

/** The banner track — its own layer, so it sits over the captions. */
function hookTrack(project: Project): { track: Track; created: boolean } {
  const existing = project.tracks.find(
    (track) => track.kind === 'video' && track.name === HOOK_TRACK_NAME,
  );
  if (existing) return { track: existing, created: false };

  return {
    track: {
      id: uid('tr'),
      kind: 'video',
      name: HOOK_TRACK_NAME,
      height: DEFAULT_TRACK_HEIGHT,
      muted: false,
      solo: false,
      locked: false,
      hidden: false,
    },
    created: true,
  };
}

/**
 * The banner over the opening seconds.
 *
 * Deliberately not a subtitle: it is fixed rather than word-by-word, it sits
 * where the captions do not, and it is dressed from the kit's `hook` half. The
 * whole job is to be legible in the quarter-second someone spends deciding
 * whether to keep watching, and something that animates in is already too late.
 *
 * It never outlives the cut it belongs to — a three-second banner on a
 * two-second clip would hang over whatever came next on the track.
 */
function addHook(
  project: Project,
  clip: ViralClip,
  at: number,
  duration: number,
  kit: StyleKit,
): { project: Project; added: boolean } {
  const content = kitText(kit.hook, clip.hook).trim();
  if (content.length === 0) return { project, added: false };

  const { track, created } = hookTrack(project);
  const style = kitLayer(kit.hook, project.settings);
  const hold = Math.min(HOOK_SECONDS, duration);
  if (hold < 0.2) return { project, added: false };

  const banner: Clip = {
    id: uid('clip'),
    kind: 'text',
    assetId: null,
    trackId: track.id,
    start: at,
    duration: hold,
    offset: 0,
    volume: 1,
    opacity: 1,
    scale: 1,
    x: 0,
    y: style.y,
    rotation: 0,
    muted: false,
    label: 'Accroche',
    text: { ...style.text, content },
    effects: [],
  };

  return {
    project: {
      ...project,
      tracks: created ? [track, ...project.tracks] : project.tracks,
      clips: [...project.clips, banner],
    },
    added: true,
  };
}

/** The video track the cuts go on — reused across runs rather than stacked. */
function viralTrack(project: Project): { track: Track; created: boolean } {
  const existing = project.tracks.find(
    (track) => track.kind === 'video' && track.name === VIRAL_TRACK_NAME,
  );
  if (existing) return { track: existing, created: false };

  return {
    track: {
      id: uid('tr'),
      kind: 'video',
      name: VIRAL_TRACK_NAME,
      height: DEFAULT_TRACK_HEIGHT,
      muted: false,
      solo: false,
      locked: false,
      hidden: false,
    },
    created: true,
  };
}

/** The media clip for one cut, framed for `settings`. */
function cutClip(
  asset: MediaAsset,
  clip: ViralClip,
  trackId: string,
  at: number,
  settings: ProjectSettings,
): Clip {
  const framing = reframe(asset, settings, clip.focus);

  return {
    id: uid('clip'),
    kind: 'media',
    assetId: asset.id,
    trackId,
    start: at,
    duration: Math.max(0.1, clip.end - clip.start),
    // The cut is an in-point into the original file. Nothing is copied or
    // re-encoded here: the same asset is referenced from a different offset.
    offset: clip.start,
    volume: 1,
    opacity: 1,
    scale: framing.scale,
    x: framing.x,
    y: framing.y,
    rotation: 0,
    muted: false,
    label: clip.title,
    effects: [],
  };
}

/**
 * Places one cut in the open project, after whatever is already on its track.
 *
 * Queuing rather than overlapping means importing six clips gives six clips in
 * a row, which is both what someone expects and the only arrangement that does
 * not silently hide five of them behind the sixth.
 */
export function placeInProject(
  project: Project,
  asset: MediaAsset,
  clip: ViralClip,
  options: ViralOptions,
  kit: StyleKit,
): PlaceOutcome {
  const { track, created } = viralTrack(project);

  const occupied = project.clips.filter((item) => item.trackId === track.id);
  const at = occupied.reduce((furthest, item) => Math.max(furthest, clipEnd(item)), 0);

  const placed = cutClip(asset, clip, track.id, at, project.settings);

  const withClip: Project = {
    ...project,
    tracks: created ? [track, ...project.tracks] : project.tracks,
    clips: [...project.clips, placed],
  };

  const captioned = addCaptions(
    withClip,
    clip.segments.map((segment) => toTimeline(segment, clip.start, at)),
    options,
    kit,
  );

  const hooked = options.hooks
    ? addHook(captioned.project, clip, at, placed.duration, kit)
    : { project: captioned.project, added: false };

  const tightened = tighten(hooked.project, clip, at, placed.duration, options);

  const target = frameOf(options.format, project.settings.fps);
  return {
    project: tightened.project,
    start: at,
    tightened: tightened.removed,
    captions: captioned.captions,
    hooked: hooked.added,
    reframed:
      Math.abs(target.width / target.height - project.settings.width / project.settings.height) >
      0.01,
  };
}

/**
 * Removes the dead air inside a cut that has just been placed.
 *
 * Run *after* everything else is on the timeline rather than folded into the
 * placement, and that is the whole design: `rippleDelete` already knows how to
 * contract a document — clips, keyframe curves, cursor paths, markers — so the
 * captions, the banner and any camera move come along for free instead of each
 * needing its own arithmetic. Reimplementing that contraction inside the
 * placement would be the same maths written a second time, and the second copy
 * is the one that would be wrong.
 *
 * Safe to ripple globally because a cut is always appended at the *end* of its
 * track: every gap is later than anything already on the timeline, so nothing
 * that was there before it moves.
 */
function tighten(
  project: Project,
  clip: ViralClip,
  at: number,
  duration: number,
  options: ViralOptions,
): { project: Project; removed: number } {
  if (!options.jumpCuts) return { project, removed: 0 };

  const gaps = silentGaps(clip.segments, clip.start, clip.end, paceOf(options.pace).options);
  if (gaps.length === 0) return { project, removed: 0 };

  // A pass that would leave almost nothing is a pass that misread the
  // transcript, not a very quiet clip: better to place the cut untouched than
  // to hand back two seconds of a thirty-second extract.
  const outcome = rippleDelete(project, onTimeline(gaps, clip.start, at));
  if (duration - outcome.removed < MIN_KEPT) return { project, removed: 0 };

  return { project: outcome.project, removed: outcome.removed };
}

/** Shortest a tightened cut may end up, in seconds. */
const MIN_KEPT = 4;

/**
 * A standalone project holding one cut, at the format the wizard asked for.
 *
 * The asset is carried across by reference: ids are scoped to a document, so
 * keeping this one means the new project points at the same file on disk rather
 * than importing a second copy of a two-gigabyte recording.
 */
export function sequenceFor(
  asset: MediaAsset,
  clip: ViralClip,
  options: ViralOptions,
  kit: StyleKit,
  fps: number,
  name: string,
): SerializedProject {
  const settings = frameOf(options.format, fps);
  const now = Date.now();

  const track: Track = {
    id: uid('tr'),
    kind: 'video',
    name: 'V1',
    height: DEFAULT_TRACK_HEIGHT,
    muted: false,
    solo: false,
    locked: false,
    hidden: false,
  };

  const base: Project = {
    id: newProjectId(),
    name,
    createdAt: now,
    updatedAt: now,
    settings,
    assets: [asset],
    tracks: [track],
    clips: [cutClip(asset, clip, track.id, 0, settings)],
    transitions: [],
    schemaVersion: SCHEMA_VERSION,
  };

  const captioned = addCaptions(
    base,
    clip.segments.map((segment) => toTimeline(segment, clip.start, 0)),
    options,
    kit,
  );

  const cut = captioned.project.clips.find((item) => item.kind === 'media');
  const hooked = options.hooks
    ? addHook(captioned.project, clip, 0, cut?.duration ?? HOOK_SECONDS, kit)
    : { project: captioned.project, added: false };

  const tightened = tighten(hooked.project, clip, 0, cut?.duration ?? HOOK_SECONDS, options);

  return {
    ...tightened.project,
    // The bar spans the composition, and here the composition *is* the clip —
    // which is the one arrangement where it means what a viewer expects.
    ...(options.progressBar ? { progress: { ...DEFAULT_PROGRESS } } : {}),
    assets: tightened.project.assets.map(serializeAsset),
  };
}

/** A filename-safe, human-readable name for a generated sequence. */
export function sequenceName(clip: ViralClip, taken: string[]): string {
  const cleaned = clip.title
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);

  const base = cleaned.length > 0 ? cleaned : 'Clip vertical';
  if (!taken.includes(base)) return base;

  for (let index = 2; index < 500; index += 1) {
    const candidate = `${base} ${index}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

export { SUBTITLE_TRACK_NAME };
