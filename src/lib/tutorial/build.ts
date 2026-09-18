/**
 * Turning a set of steps into an edit.
 *
 * A pure `Project → Project`, like every other generator in the suite, and here
 * the reason is at its sharpest: one run produces a screen clip carrying three
 * animated channels, a dozen narration clips on their own track, a ducking
 * curve, a dozen chapter markers and possibly a hundred captions. That is one
 * operation as far as the user is concerned, so it must be one entry in the
 * history and one press of Ctrl+Z.
 *
 * Nothing here touches the network, the disk or a store. The caller has already
 * resolved every voice-over into a real `MediaAsset` — with a path, a duration
 * and a `src` the preview can play — because that resolution is asynchronous
 * and a function that has to await cannot be folded into a transaction.
 */

import { uid } from '@/lib/id';
import { buildSubtitleClips } from '@/lib/ai/subtitles';
import { namedTrack, withTrack } from '@/lib/tracks';
import { snapToFrame } from '@/lib/time';
import { planShots, restingCamera, smartZoom } from './zoom';
import { cursorFromSteps, placeCursor } from './cursor';
import { backdropPreset } from '@/types/backdrop';
import { sourceAspect } from '@/lib/geometry';
import { placeBanner } from '@/lib/bannerLayer';
import {
  DEFAULT_BANNER_DURATION,
  bannerFromPreset,
  type BannerLayer,
} from '@/types/banner';
import { DEFAULT_SUBTITLE_OPTIONS, type TranscriptSegment } from '@/types/ai';
import type { AnimationMap, Easing, Keyframe } from '@/types/animation';
import type { Marker } from '@/types/marker';
import type { MediaAsset } from '@/types/media';
import type { Project } from '@/types/project';
import { clipEnd, type Clip } from '@/types/timeline';
import {
  CHAPTER_COLOR,
  SCREEN_TRACK_NAME,
  VOICE_TRACK_NAME,
  zoomProfileOf,
  type TutorialOptions,
  type TutorialStep,
} from '@/types/tutorial';
import type { SpeechTake } from '@/types/voice';

/* ------------------------------------------------------------------ *
 * Timing
 * ------------------------------------------------------------------ */

/**
 * How far ahead of its step a narration line starts.
 *
 * Speech is slower than a click. If the line began at the exact instant of the
 * action, the viewer would watch the button being pressed and only then be told
 * why — which is the difference between following along and catching up. A beat
 * of lead means the sentence is under way as the camera arrives.
 */
export const NARRATION_LEAD = 0.45;

/** Silence between two takes, so one sentence does not tread on the next. */
export const NARRATION_GAP = 0.28;

export interface Placement {
  step: TutorialStep;
  take: SpeechTake;
  asset: MediaAsset;
  /** Timeline seconds. */
  start: number;
}

/**
 * Lays the takes out on the timeline, in order, without overlaps.
 *
 * Each take *wants* to start a beat before its step. Where two steps are close
 * together the second take would begin inside the first, so it is pushed to
 * where the previous one ends — narration drifting a little late is
 * unremarkable, two voices speaking at once is not.
 *
 * The drift is deliberately never recovered: shortening a gap to catch up would
 * make the narration audibly hurry, and the steps it is running behind are
 * exactly the ones where the viewer is already busy.
 */
export function packTakes(
  steps: TutorialStep[],
  takes: Map<string, SpeechTake>,
  assets: Map<string, MediaAsset>,
  at: number,
  offset: number,
  fps: number,
): Placement[] {
  const out: Placement[] = [];
  let floor = at;

  for (const step of [...steps].sort((a, b) => a.at - b.at)) {
    if (!step.enabled) continue;
    const take = takes.get(step.id);
    const asset = assets.get(step.id);
    if (!take || !asset || take.duration <= 0) continue;

    // Source time to timeline time: where this step sits once the recording is
    // laid at `at`, minus the in-point the clip was trimmed to.
    const wanted = at + (step.at - offset) - NARRATION_LEAD;
    const start = snapToFrame(Math.max(floor, wanted, at), fps);

    out.push({ step, take, asset, start });
    floor = start + take.duration + NARRATION_GAP;
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Ducking
 * ------------------------------------------------------------------ */

/** Level the recording's own sound sits at under the narration. */
const DUCK_LEVEL = 0.22;
/** Seconds the level takes to move. Long enough not to pump, short enough to work. */
const DUCK_RAMP = 0.35;

/** `sine-in-out` — a level change should never be heard happening. */
const DUCK_EASING: Easing = { kind: 'bezier', bezier: [0.37, 0, 0.63, 1] };

/**
 * A volume curve for the screen clip that gets out of the narration's way.
 *
 * Ducked rather than muted, on purpose. A screen recording's own sound is
 * mostly keyboard and mouse, and those clicks are what confirm to the viewer
 * that the action landed — silencing them entirely makes the tutorial feel like
 * a slideshow with commentary. Held at a fifth of its level, they are still
 * there under the voice.
 *
 * Overlapping or near-adjacent takes are merged into one duck: coming back up
 * to full for a third of a second between two sentences is the classic
 * automated-ducking artefact, and it is far more noticeable than staying down.
 */
export function duckingCurve(
  placements: Placement[],
  clipStart: number,
  duration: number,
  fps: number,
  full: number,
): Keyframe[] | null {
  if (placements.length === 0) return null;

  // Clip-relative spans, padded by the ramp on each side.
  const spans: { from: number; to: number }[] = [];
  for (const placement of placements) {
    const from = placement.start - clipStart - DUCK_RAMP;
    const to = placement.start - clipStart + placement.take.duration + DUCK_RAMP;
    const last = spans[spans.length - 1];
    if (last && from <= last.to + DUCK_RAMP) last.to = Math.max(last.to, to);
    else spans.push({ from, to });
  }

  const keys: Keyframe[] = [];
  const key = (time: number, value: number, easing: Easing) => {
    const at = snapToFrame(Math.min(Math.max(time, 0), duration), fps);
    const previous = keys[keys.length - 1];
    // Same rule as the camera: a move with no room to happen does not happen.
    if (previous && at <= previous.time) return;
    keys.push({ id: uid('kf'), time: at, value, easing: { ...easing } });
  };

  // A curve that starts mid-ramp would have the clip open at whatever level the
  // first keyframe happens to carry, so the full level is pinned at t = 0 —
  // unless the very first take begins there, in which case it opens ducked.
  if ((spans[0] as { from: number }).from > 0) key(0, full, DUCK_EASING);

  for (const span of spans) {
    key(Math.max(0, span.from), full, DUCK_EASING);
    key(span.from + DUCK_RAMP, DUCK_LEVEL, { kind: 'linear' });
    key(span.to - DUCK_RAMP, DUCK_LEVEL, DUCK_EASING);
    key(span.to, full, { kind: 'linear' });
  }

  return keys.length >= 2 ? keys : null;
}

/* ------------------------------------------------------------------ *
 * Captions
 * ------------------------------------------------------------------ */

/** Roughly one comfortable line of burnt-in caption. */
const CAPTION_CHARS = 42;
/** No caption stays up longer than this, however slowly it was said. */
const CAPTION_MAX = 5;

/**
 * Caption lines from the narration's own word alignment.
 *
 * This is what the timestamped endpoint is *for*. A caption built from the
 * script alone has to guess where each line falls; one built from the alignment
 * lands on the word, so the text on screen and the voice stay together for the
 * whole tutorial rather than drifting apart over twelve minutes.
 *
 * A take that came back with no alignment gets one caption spanning the whole
 * line, which is still correct — merely less precise than it could have been.
 */
export function captionSegments(placements: Placement[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];

  for (const placement of placements) {
    const { words } = placement.take;

    if (words.length === 0) {
      out.push({
        start: placement.start,
        end: placement.start + placement.take.duration,
        text: placement.step.say,
      });
      continue;
    }

    let line: string[] = [];
    let from = words[0].start;
    let to = words[0].end;

    const flush = () => {
      if (line.length === 0) return;
      out.push({
        start: placement.start + from,
        end: placement.start + Math.min(to, from + CAPTION_MAX),
        text: line.join(' '),
      });
      line = [];
    };

    for (const word of words) {
      const wouldBe = [...line, word.word].join(' ');
      const tooLong = wouldBe.length > CAPTION_CHARS;
      const tooSlow = word.end - from > CAPTION_MAX;

      if (line.length > 0 && (tooLong || tooSlow)) {
        flush();
        from = word.start;
      }
      if (line.length === 0) from = word.start;
      line.push(word.word);
      to = word.end;
    }

    flush();
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * The assembly
 * ------------------------------------------------------------------ */

/**
 * How long a generated banner holds.
 *
 * Capped by the step that follows it, so a lower third never outlives the part
 * it announces — and floored well below that, because a chapter banner that
 * sits on screen for the whole chapter stops being a marker and becomes a
 * watermark.
 */
function bannerSpan(step: TutorialStep, steps: TutorialStep[]): number {
  const next = steps.find((item) => item.at > step.at + 1e-6);
  const room = next ? next.at - step.at : Number.POSITIVE_INFINITY;
  return Math.max(1.4, Math.min(DEFAULT_BANNER_DURATION, room));
}

export interface TutorialBuild {
  project: Project;
  /** Where the recording landed on the timeline, in seconds. */
  start: number;
  /** How many camera moves were written. */
  shots: number;
  takes: number;
  markers: number;
  captions: number;
  banners: number;
  /** Whether a drawn pointer was laid over the recording. */
  cursor: boolean;
}

/**
 * Places a whole tutorial in the open project.
 *
 * The recording goes on its own track, after whatever is already there — the
 * same queuing rule the viral pass uses, and for the same reason: overlapping
 * would silently hide one behind the other.
 */
export function placeTutorial(
  project: Project,
  asset: MediaAsset,
  steps: TutorialStep[],
  options: TutorialOptions,
  takes: Map<string, SpeechTake>,
  voiceAssets: Map<string, MediaAsset>,
): TutorialBuild {
  const { fps } = project.settings;
  const profile = zoomProfileOf(options.zoom);

  /* ---- 1. The recording ---- */

  const screen = namedTrack(project, SCREEN_TRACK_NAME, 'video');
  const occupied = project.clips.filter((clip) => clip.trackId === screen.track.id);
  const at = snapToFrame(
    occupied.reduce((furthest, clip) => Math.max(furthest, clipEnd(clip)), 0),
    fps,
  );

  const duration = Math.max(0.1, asset.duration);
  const enabled = steps.filter((step) => step.enabled);

  /*
   * Begin with the whole source, without a crop, even when its aspect differs
   * from the project. Only explicit action zooms leave this resting framing.
   */
  const rest = restingCamera(enabled, asset, project.settings);

  const base: Clip = {
    id: uid('clip'),
    kind: 'media',
    assetId: asset.id,
    trackId: screen.track.id,
    start: at,
    duration,
    offset: 0,
    volume: 1,
    opacity: 1,
    scale: rest.scale,
    x: rest.x,
    y: rest.y,
    rotation: 0,
    muted: false,
    label: asset.name,
    effects: [],
  };

  const shots = planShots(enabled, base, asset, project.settings, profile);
  const camera = smartZoom(enabled, base, asset, project.settings, profile);

  /* ---- 2. The narration ---- */

  const placements = options.voiceover
    ? packTakes(enabled, takes, voiceAssets, at, base.offset, fps)
    : [];

  const voice = namedTrack(project, VOICE_TRACK_NAME, 'audio');
  const voiceClips: Clip[] = placements.map((placement) => ({
    id: uid('clip'),
    kind: 'media',
    assetId: placement.asset.id,
    trackId: voice.track.id,
    start: placement.start,
    duration: Math.max(0.1, placement.take.duration),
    offset: 0,
    volume: 1,
    opacity: 1,
    scale: 1,
    x: 0,
    y: 0,
    rotation: 0,
    muted: false,
    label: placement.step.title,
    effects: [],
  }));

  /*
   * The camera and the ducking both animate the same clip, so they meet in one
   * map. Writing them as two would mean the second overwrote the first — the
   * animation map is a whole-clip field, not a per-channel one.
   */
  const duck = options.duckOriginal
    ? duckingCurve(placements, at, duration, fps, base.volume)
    : null;

  const animation: AnimationMap = { ...(camera ?? {}), ...(duck ? { volume: duck } : {}) };
  const framed: Clip = Object.keys(animation).length > 0 ? { ...base, animation } : base;

  // The glass, when asked for. A property of *this* clip's framing rather than
  // a layer of its own: it moves with the clip and undoes with it.
  const screenClip: Clip = options.backdrop
    ? { ...framed, backdrop: backdropPreset(options.backdrop).backdrop }
    : framed;

  /* ---- 3. Everything lands ---- */

  const created: MediaAsset[] = placements
    .map((placement) => placement.asset)
    .filter((item) => !project.assets.some((existing) => existing.id === item.id));

  let next: Project = {
    ...project,
    assets: [...project.assets, ...created],
    // The screen track goes on top of the video stack, the voice track under
    // the audio one — and the voice track is only created if anything is
    // actually going on it.
    tracks: withTrack(
      withTrack(project.tracks, screen.created ? screen.track : null),
      voiceClips.length > 0 && voice.created ? voice.track : null,
    ),
    clips: [...project.clips, screenClip, ...voiceClips],
  };

  /* ---- 4. The pointer ---- */

  let cursorPlaced = false;
  if (options.cursor) {
    const pointer = cursorFromSteps(enabled, base.offset, sourceAspect(asset) ?? 16 / 9);
    if (pointer) {
      // Placed after the screen track exists, so its own track is prepended
      // above it — and before the banners, which are prepended above both.
      const placed = placeCursor(next, screenClip, pointer);
      next = placed.project;
      cursorPlaced = true;
    }
  }

  /* ---- 5. Chapters ---- */

  const markers: Marker[] = options.chapters
    ? enabled.map((step) => ({
        id: uid('mk'),
        time: snapToFrame(Math.max(0, at + (step.at - base.offset)), fps),
        label: step.title,
        color: CHAPTER_COLOR,
        note: step.say,
      }))
    : [];

  if (markers.length > 0) {
    next = { ...next, markers: [...(next.markers ?? []), ...markers] };
  }

  /* ---- 6. Banners ---- */

  let banners = 0;
  if (options.banners) {
    /*
     * Where they sit vertically.
     *
     * A lower third and a burnt-in caption both live at the bottom of the
     * frame, and two things at the bottom of the frame are one thing on top of
     * the other. When captions are on, the banners move to the top — which is
     * also where a broadcast chapter card usually goes, so nothing is lost.
     */
    const anchor = options.captions ? ('top' as const) : ('bottom' as const);

    const dress = (layer: BannerLayer): BannerLayer => ({ ...layer, anchor });

    for (const step of enabled) {
      const timeline = at + (step.at - base.offset);

      if (step.banner) {
        const placed = placeBanner(
          next,
          dress(
            bannerFromPreset(options.bannerPreset, {
              title: step.banner.title,
              subtitle: step.banner.subtitle,
            }),
          ),
          { at: timeline, duration: bannerSpan(step, enabled) },
        );
        next = placed.project;
        banners += 1;
      }

      if (step.shortcut) {
        // A beat late on purpose: the badge is confirming the key that was just
        // pressed, so it should land with the result rather than before it.
        const placed = placeBanner(
          next,
          dress(bannerFromPreset('shortcut', { title: step.title, subtitle: step.shortcut })),
          { at: timeline + 0.2, duration: Math.min(2.8, bannerSpan(step, enabled)) },
        );
        next = placed.project;
        banners += 1;
      }
    }
  }

  /* ---- 7. Captions ---- */

  let captions = 0;
  if (options.captions && placements.length > 0) {
    const before = new Set(next.clips.map((clip) => clip.id));
    const built = buildSubtitleClips(next, captionSegments(placements), {
      ...DEFAULT_SUBTITLE_OPTIONS,
      language: options.language,
      maxCharsPerLine: CAPTION_CHARS,
      maxDuration: CAPTION_MAX,
    });
    captions = built.project.clips.filter(
      (clip) => !before.has(clip.id) && clip.kind === 'text',
    ).length;
    next = built.project;
  }

  return {
    project: next,
    start: at,
    shots: camera ? shots.length : 0,
    takes: placements.length,
    markers: markers.length,
    captions,
    banners,
    cursor: cursorPlaced,
  };
}
