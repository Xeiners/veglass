import type { Project } from '@/types/project';
import type { MediaAsset } from '@/types/media';
import {
  clipContains,
  clipEnd,
  isGenerated,
  sourceTimeAt,
  type Clip,
  type Track,
} from '@/types/timeline';
import { cssFilterFor, type Effect } from '@/types/effects';
import {
  evaluateKeyframes,
  isAnimated,
  isClipChannel,
  parseBackgroundChannel,
  parseEffectChannel,
  type ClipChannel,
} from '@/types/animation';
import { BACKGROUND_RANGES, type BackgroundLayer } from '@/types/background';
import {
  MIN_TRANSITION_DURATION,
  transitionDescriptor,
  type Transition,
  type TransitionAnchor,
} from '@/types/transitions';

/** Two edges are the same junction when they sit within this many seconds. */
const JUNCTION_EPSILON = 1e-3;

/**
 * The clip as it stands at `timelineTime`, with every animated channel resolved.
 *
 * Returns the clip untouched when nothing is animated — this runs once per
 * layer per frame, so the common case must not allocate.
 */
export function resolveClipAt(clip: Clip, timelineTime: number): Clip {
  const animation = clip.animation;
  if (!animation) return clip;

  const channels = Object.keys(animation);
  if (channels.length === 0) return clip;

  // Keyframe times are clip-relative, so an animation travels with its clip.
  const local = timelineTime - clip.start;
  const patch: Partial<Record<ClipChannel, number>> = {};
  let effects: Effect[] | null = null;
  let background: BackgroundLayer | null = null;

  for (const channel of channels) {
    const keyframes = animation[channel];
    if (!isAnimated(keyframes)) continue;

    if (isClipChannel(channel)) {
      patch[channel] = evaluateKeyframes(keyframes, local, clip[channel]);
      continue;
    }

    const generated = parseBackgroundChannel(channel);
    if (generated) {
      if (!clip.background) continue;
      // Copy lazily: only a clip whose background is animated pays for it.
      if (!background) background = { ...clip.background };
      const range = BACKGROUND_RANGES[generated];
      // Clamped here rather than where the keyframes were written, so every
      // path — the viewer, the export bake, a plan composed by hand — is held
      // to the same bounds by the one function that reads the value.
      const value = evaluateKeyframes(keyframes, local, clip.background[generated]);
      background[generated] = Math.min(range.max, Math.max(range.min, value));
      continue;
    }

    const parsed = parseEffectChannel(channel);
    if (!parsed) continue;

    // Copy lazily: only a clip with animated filter params pays for it.
    if (!effects) effects = clip.effects.map((item) => ({ ...item, params: { ...item.params } }));
    const effect = effects.find((item) => item.id === parsed.effectId);
    if (!effect) continue;
    effect.params[parsed.key] = evaluateKeyframes(
      keyframes,
      local,
      effect.params[parsed.key] ?? 0,
    );
  }

  if (!effects && !background && Object.keys(patch).length === 0) return clip;
  return {
    ...clip,
    ...patch,
    ...(effects ? { effects } : {}),
    ...(background ? { background } : {}),
  };
}

export interface ResolvedClip {
  clip: Clip;
  track: Track;
  asset: MediaAsset;
}

/** Media clips only — callers that need sound or a source file use this. */
function resolve(project: Project, clip: Clip): ResolvedClip | null {
  const track = project.tracks.find((item) => item.id === clip.trackId);
  const asset = project.assets.find((item) => item.id === clip.assetId);
  if (!track || !asset || asset.missing) return null;
  return { clip, track, asset };
}

export interface ResolvedVisual {
  clip: Clip;
  track: Track;
  /** `null` on a text clip, which carries its own content. */
  asset: MediaAsset | null;
}

/** Anything that can appear on screen, media-backed or not. */
function resolveVisual(project: Project, clip: Clip): ResolvedVisual | null {
  const track = project.tracks.find((item) => item.id === clip.trackId);
  if (!track) return null;

  // Titles, backgrounds and banners carry their own pixels: they are visible
  // without an asset, and testing for one would drop them from the frame.
  if (isGenerated(clip)) return { clip, track, asset: null };

  const asset = project.assets.find((item) => item.id === clip.assetId);
  if (!asset || asset.missing || asset.kind === 'audio') return null;
  return { clip, track, asset };
}

/**
 * The visible layer under the playhead. Track order is the z-order: the first
 * video track in the list wins, matching how the rows are drawn top-down.
 */
export function activeVideoClip(project: Project | null, time: number): ResolvedVisual | null {
  if (!project) return null;
  for (const track of project.tracks) {
    if (track.kind !== 'video' || track.hidden) continue;
    const clip = project.clips.find((item) => item.trackId === track.id && clipContains(item, time));
    if (!clip) continue;
    const resolved = resolveVisual(project, clip);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Every visible layer at `time`, bottom-to-front.
 *
 * Track order is the z-order, so the list is walked in reverse: the last video
 * track paints first and the first one paints last, over everything else.
 */
export function stackAt(project: Project | null, time: number): ResolvedVisual[] {
  if (!project) return [];
  const out: ResolvedVisual[] = [];
  for (let index = project.tracks.length - 1; index >= 0; index -= 1) {
    const track = project.tracks[index];
    if (!track || track.kind !== 'video' || track.hidden) continue;
    for (const clip of project.clips) {
      if (clip.trackId !== track.id || !clipContains(clip, time)) continue;
      const resolved = resolveVisual(project, clip);
      if (resolved) out.push(resolved);
    }
  }
  return out;
}

/** Every audio-track clip sounding at `time` — the preview mixes these live. */
export function activeAudioClips(project: Project | null, time: number): ResolvedClip[] {
  if (!project) return [];
  const out: ResolvedClip[] = [];
  for (const track of project.tracks) {
    if (track.kind !== 'audio' || track.muted) continue;
    for (const clip of project.clips) {
      if (clip.trackId !== track.id || !clipContains(clip, time)) continue;
      const resolved = resolve(project, clip);
      if (resolved) out.push(resolved);
    }
  }
  return out;
}

/** Every audio clip in the project, so the mixer can pre-mount its elements. */
export function audioClips(project: Project | null): ResolvedClip[] {
  if (!project) return [];
  return project.clips
    .map((clip) => resolve(project, clip))
    .filter((item): item is ResolvedClip => item !== null && item.track.kind === 'audio');
}

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

export interface ResolvedTransition {
  transition: Transition;
  track: Track;
  from: Clip | null;
  to: Clip | null;
  /** Absolute window on the timeline. */
  start: number;
  end: number;
  /** The cut itself: mid-window for a junction, the outer edge for head/tail. */
  center: number;
}

/**
 * Turns stored neighbour references into an absolute window, dropping any
 * transition whose clips have drifted apart or disappeared.
 */
export function resolveTransition(
  project: Project,
  transition: Transition,
): ResolvedTransition | null {
  const track = project.tracks.find((item) => item.id === transition.trackId);
  if (!track) return null;

  const from = transition.fromClipId
    ? (project.clips.find((clip) => clip.id === transition.fromClipId) ?? null)
    : null;
  const to = transition.toClipId
    ? (project.clips.find((clip) => clip.id === transition.toClipId) ?? null)
    : null;

  if (transition.fromClipId && !from) return null;
  if (transition.toClipId && !to) return null;
  if (!from && !to) return null;
  if (from && from.trackId !== track.id) return null;
  if (to && to.trackId !== track.id) return null;

  const duration = Math.max(MIN_TRANSITION_DURATION, transition.duration);

  if (from && to) {
    // The clips must still meet for the junction to exist.
    if (Math.abs(clipEnd(from) - to.start) > JUNCTION_EPSILON) return null;
    const center = clipEnd(from);
    return { transition, track, from, to, center, start: center - duration / 2, end: center + duration / 2 };
  }

  if (to) {
    // Fade-in at the head of the track.
    return { transition, track, from: null, to, center: to.start, start: to.start, end: to.start + duration };
  }

  const end = clipEnd(from as Clip);
  return { transition, track, from, to: null, center: end, start: end - duration, end };
}

export function resolveTransitions(project: Project | null): ResolvedTransition[] {
  if (!project) return [];
  return project.transitions
    .map((transition) => resolveTransition(project, transition))
    .filter((item): item is ResolvedTransition => item !== null);
}

/** Transitions that no longer describe a real junction, by id. */
export function staleTransitionIds(project: Project): Set<string> {
  const stale = new Set<string>();
  for (const transition of project.transitions) {
    if (!resolveTransition(project, transition)) stale.add(transition.id);
  }
  return stale;
}

/**
 * Every place a transition may be dropped: each junction between two touching
 * clips, plus the open head and tail of every track that has material.
 */
export function transitionAnchors(project: Project | null): TransitionAnchor[] {
  if (!project) return [];
  const anchors: TransitionAnchor[] = [];

  for (const track of project.tracks) {
    const ordered = project.clips
      .filter((clip) => clip.trackId === track.id)
      .sort((a, b) => a.start - b.start);
    if (ordered.length === 0) continue;

    const first = ordered[0] as Clip;
    anchors.push({
      id: `${track.id}:head:${first.id}`,
      trackId: track.id,
      time: first.start,
      fromClipId: null,
      toClipId: first.id,
      maxDuration: first.duration,
    });

    for (let i = 0; i < ordered.length - 1; i += 1) {
      const a = ordered[i] as Clip;
      const b = ordered[i + 1] as Clip;
      if (Math.abs(clipEnd(a) - b.start) > JUNCTION_EPSILON) continue;
      anchors.push({
        id: `${track.id}:${a.id}:${b.id}`,
        trackId: track.id,
        time: clipEnd(a),
        fromClipId: a.id,
        toClipId: b.id,
        // A centred window spends half its length on each side.
        maxDuration: 2 * Math.min(a.duration, b.duration),
      });
    }

    const last = ordered[ordered.length - 1] as Clip;
    anchors.push({
      id: `${track.id}:${last.id}:tail`,
      trackId: track.id,
      time: clipEnd(last),
      fromClipId: last.id,
      toClipId: null,
      maxDuration: last.duration,
    });
  }

  return anchors;
}

/** Nearest anchor to `time` on `trackId`, within `tolerance` seconds. */
export function nearestAnchor(
  anchors: TransitionAnchor[],
  trackId: string,
  time: number,
  tolerance: number,
): TransitionAnchor | null {
  let best: TransitionAnchor | null = null;
  let bestDelta = tolerance;
  for (const anchor of anchors) {
    if (anchor.trackId !== trackId) continue;
    const delta = Math.abs(anchor.time - time);
    if (delta <= bestDelta) {
      bestDelta = delta;
      best = anchor;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Preview composition
 * ------------------------------------------------------------------ */

export interface PreviewLayerSpec {
  clip: Clip;
  track: Track;
  asset: MediaAsset | null;
  /** Final layer opacity — clip opacity folded into the transition ramp. */
  opacity: number;
  /** Transition ramp alone, used for the audio gain (clip opacity must not affect sound). */
  gain: number;
  /** Where to park the media element, already clamped to the source. */
  sourceTime: number;
  /** CSS `filter` produced by the clip's effect stack. */
  filter: string | undefined;
}

export interface Composition {
  /** Back to front, at most two during a dissolve. */
  layers: PreviewLayerSpec[];
  veilColor: string | null;
  veilOpacity: number;
  /** The transition being played, for the transport read-out. */
  transition: ResolvedTransition | null;
}

const EMPTY_COMPOSITION: Composition = {
  layers: [],
  veilColor: null,
  veilOpacity: 0,
  transition: null,
};

function toLayer(project: Project, source: Clip, time: number, ramp: number): PreviewLayerSpec | null {
  const resolved = resolveVisual(project, source);
  if (!resolved) return null;

  // Everything downstream — opacity, filters, the gizmo — reads the animated
  // values, so the resolution happens once, here.
  const clip = resolveClipAt(source, time);
  const limit =
    resolved.asset && resolved.asset.duration > 0 ? resolved.asset.duration : Infinity;
  // A dissolve reaches past the trim into the source handles; clamping freezes
  // on the first/last frame when no handle is available.
  const raw = sourceTimeAt(clip, time);
  const sourceTime = Math.min(Math.max(raw, 0), limit === Infinity ? raw : limit);
  const gain = Math.max(0, Math.min(1, ramp));
  return {
    ...resolved,
    clip,
    opacity: gain * Math.max(0, Math.min(1, clip.opacity)),
    gain,
    sourceTime,
    filter: cssFilterFor(clip.effects),
  };
}

/**
 * What the preview must draw at `time`.
 *
 * Outside a transition this is a single layer. Inside one, a cross-dissolve
 * yields two layers with complementary opacity; a dip yields one layer plus a
 * coloured veil that peaks on the cut.
 */
export function composeAt(project: Project | null, time: number): Composition {
  if (!project) return EMPTY_COMPOSITION;

  // Only a transition on a visible video track can affect the picture.
  const hit = resolveTransitions(project).find(
    (item) =>
      item.track.kind === 'video' &&
      !item.track.hidden &&
      time >= item.start &&
      time <= item.end &&
      item.end > item.start,
  );

  if (!hit) {
    // No transition: paint the whole stack, bottom-to-front.
    const layers = stackAt(project, time)
      .map((item) => toLayer(project, item.clip, time, 1))
      .filter((item): item is PreviewLayerSpec => item !== null);
    return layers.length > 0
      ? { layers, veilColor: null, veilOpacity: 0, transition: null }
      : EMPTY_COMPOSITION;
  }

  const progress = Math.max(0, Math.min(1, (time - hit.start) / (hit.end - hit.start)));
  const descriptor = transitionDescriptor(hit.transition.kind);

  if (descriptor.kind === 'crossfade' && hit.from && hit.to) {
    // Layers below the dissolving pair keep painting normally underneath it.
    const dissolving = new Set([hit.from.id, hit.to.id]);
    const beneath = stackAt(project, time)
      .filter((item) => !dissolving.has(item.clip.id))
      .map((item) => toLayer(project, item.clip, time, 1))
      .filter((item): item is PreviewLayerSpec => item !== null);

    const outgoing = toLayer(project, hit.from, time, 1 - progress);
    const incoming = toLayer(project, hit.to, time, progress);
    const layers = [
      ...beneath,
      ...[outgoing, incoming].filter((item): item is PreviewLayerSpec => item !== null),
    ];
    return { layers, veilColor: null, veilOpacity: 0, transition: hit };
  }

  // Dips: the veil peaks on the cut and clears at both edges. A head fade
  // starts opaque, a tail fade ends opaque.
  let veilOpacity: number;
  if (hit.from && hit.to) veilOpacity = 1 - Math.abs(2 * progress - 1);
  else if (hit.to) veilOpacity = 1 - progress;
  else veilOpacity = progress;

  const layers = stackAt(project, time)
    .map((item) => toLayer(project, item.clip, time, 1))
    .filter((item): item is PreviewLayerSpec => item !== null);

  return { layers, veilColor: descriptor.veil, veilOpacity, transition: hit };
}

/* ------------------------------------------------------------------ */

/** Magnetic snap targets: clip edges, the playhead and the origin. */
export function snapTargets(
  project: Project | null,
  excludeClipId: string | null,
  playhead: number,
): number[] {
  if (!project) return [0];
  const targets = new Set<number>([0, playhead]);
  for (const clip of project.clips) {
    if (clip.id === excludeClipId) continue;
    targets.add(clip.start);
    targets.add(clipEnd(clip));
  }
  return [...targets].sort((a, b) => a - b);
}

/** Nearest target within `tolerance` seconds, or the original value. */
export function applySnap(value: number, targets: number[], tolerance: number): number {
  let best = value;
  let bestDelta = tolerance;
  for (const target of targets) {
    const delta = Math.abs(target - value);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = target;
    }
  }
  return best;
}

export const clipById = (project: Project | null, id: string | null): Clip | null =>
  (id && project?.clips.find((clip) => clip.id === id)) || null;

export const assetById = (project: Project | null, id: string | null): MediaAsset | null =>
  (id && project?.assets.find((asset) => asset.id === id)) || null;

export const transitionById = (project: Project | null, id: string | null): Transition | null =>
  (id && project?.transitions.find((item) => item.id === id)) || null;
