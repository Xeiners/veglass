import { isTauri } from './env';
import { chainOf, effectFiltersLocally } from './effectChain';
import { serializeAsset } from './media';
import type { Project } from '@/types/project';
import type { Effect } from '@/types/effects';
import { clipEnd, isGenerated } from '@/types/timeline';
import { bakesAsSequence } from './bake';
import { resolveTransitions } from '@/store/selectors';

export interface RenderSegment {
  trackName: string;
  kind: 'video' | 'audio';
  layer: number;
  source: string;
  sourcePath: string | null;
  timelineIn: number;
  timelineOut: number;
  sourceIn: number;
  volume: number;
  opacity: number;
  scale: number;
  /** The clip's effect stack, echoed for the encoder. */
  effects: Effect[];
  /** Those effects mapped to ffmpeg filter fragments, in order. */
  filters: string[];
  x: number;
  y: number;
  rotation: number;
  isStill: boolean;
  conform: boolean;
  /** Text and vector layers the front-end must rasterise before encoding. */
  needsBake: boolean;
  /** `sourcePath` is a numbered image sequence rather than one file. */
  isSequence: boolean;
  /** Sampled animation channels, clip-relative. */
  animated: Record<string, { time: number; value: number }[]>;
  trackId: string;
}

export interface TrackBus {
  id: string;
  name: string;
  kind: 'video' | 'audio';
  muted: boolean;
  volume: number;
  pan: number;
  highPass: number;
  lowPass: number;
  compressor: { thresholdDb: number; ratio: number; makeupDb: number } | null;
}

export interface TransitionPlan {
  kind: string;
  trackName: string;
  start: number;
  end: number;
  duration: number;
  fromSource: string | null;
  toSource: string | null;
  /** Filtergraph fragment the encoder will splice in. */
  ffmpeg: string;
}

export interface RenderPlan {
  projectName: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  frameCount: number;
  segments: RenderSegment[];
  tracks: TrackBus[];
  transitions: TransitionPlan[];
  warnings: string[];
  engine: 'rust' | 'typescript';
}

const round = (value: number) => Number(value.toFixed(3));

/**
 * Flattens the timeline into an ordered, per-layer segment list plus the
 * transition schedule — the exact shape an ffmpeg/Rust encoder consumes. The
 * native engine owns this in the desktop build; this TypeScript twin keeps the
 * browser build honest and serves as the reference for the Rust port.
 */
export function buildRenderPlanLocally(project: Project): RenderPlan {
  const segments: RenderSegment[] = [];
  const warnings: string[] = [];

  project.tracks.forEach((track, layer) => {
    if (track.hidden && track.kind === 'video') {
      warnings.push(`Piste ${track.name} masquée — ignorée au rendu`);
      return;
    }
    if (track.muted && track.kind === 'audio') {
      warnings.push(`Piste ${track.name} muette — ignorée au rendu`);
      return;
    }

    const ordered = project.clips
      .filter((clip) => clip.trackId === track.id)
      .sort((a, b) => a.start - b.start);

    for (const clip of ordered) {
      if (isGenerated(clip)) {
        // The TypeScript twin describes the plan; only the native engine
        // consumes the baked PNGs, so a generated layer is reported, not
        // resolved. A moving background is a *sequence* of PNGs rather than
        // one, which is what `isSequence` says further down.
        segments.push({
          trackName: track.name,
          kind: track.kind,
          layer,
          source:
            clip.label ??
            (clip.kind === 'background'
              ? 'Fond'
              : clip.kind === 'banner'
                ? 'Habillage'
                : clip.kind === 'cursor'
                  ? 'Curseur'
                  : 'Texte'),
          sourcePath: null,
          timelineIn: clip.start,
          timelineOut: clipEnd(clip),
          sourceIn: 0,
          volume: 0,
          opacity: clip.opacity,
          scale: clip.scale,
          x: clip.x,
          y: clip.y,
          rotation: clip.rotation,
          isStill: true,
          conform: false,
          needsBake: true,
          // Asked of `bake.ts` rather than restated here: this used to say only
          // a moving background was a sequence, which described an animated
          // title — and would have described an animated banner — as a single
          // frozen frame while the bake was writing one PNG per output frame.
          isSequence: bakesAsSequence(clip),
          animated: {},
          trackId: track.id,
          effects: clip.effects,
          filters: [],
        });
        continue;
      }

      const asset = project.assets.find((item) => item.id === clip.assetId);
      if (!asset) {
        warnings.push(`Clip « ${clip.label ?? clip.id} » sans média source`);
        continue;
      }
      if (!asset.path) {
        warnings.push(`« ${asset.name} » n'a pas de chemin disque — réimportez-le pour le rendu`);
      }

      segments.push({
        trackName: track.name,
        kind: track.kind,
        layer,
        source: asset.name,
        sourcePath: asset.path,
        x: clip.x,
        y: clip.y,
        rotation: clip.rotation,
        isStill: asset.kind === 'image',
        conform: asset.kind !== 'image',
        isSequence: false,
        animated: {},
        trackId: track.id,
        needsBake: /\.svg$/i.test(asset.name),
        timelineIn: clip.start,
        timelineOut: clipEnd(clip),
        sourceIn: clip.offset,
        volume: clip.muted || track.muted ? 0 : clip.volume,
        opacity: clip.opacity,
        scale: clip.scale,
        effects: clip.effects,
        filters: effectFiltersLocally(clip.effects),
      });
    }
  });

  const transitions: TransitionPlan[] = resolveTransitions(project).map((item) => {
    const name = (id: string | null) => {
      const clip = project.clips.find((c) => c.id === id);
      const asset = clip && project.assets.find((a) => a.id === clip.assetId);
      return asset?.name ?? null;
    };
    return {
      kind: item.transition.kind,
      trackName: item.track.name,
      start: round(item.start),
      end: round(item.end),
      duration: round(item.end - item.start),
      fromSource: name(item.transition.fromClipId),
      toSource: name(item.transition.toClipId),
      ffmpeg: transitionFilter(
        item.transition.kind,
        item.start,
        item.end,
        item.center,
        item.from !== null,
        item.to !== null,
      ),
    };
  });

  const duration = project.clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0);

  return {
    projectName: project.name,
    width: project.settings.width,
    height: project.settings.height,
    fps: project.settings.fps,
    duration,
    frameCount: Math.round(duration * project.settings.fps),
    segments,
    tracks: project.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      kind: track.kind,
      muted: track.muted,
      volume: track.audio?.volume ?? 1,
      pan: track.audio?.pan ?? 0,
      highPass: track.audio?.highPass ?? 0,
      lowPass: track.audio?.lowPass ?? 0,
      compressor: null,
    })),
    transitions,
    warnings,
    engine: 'typescript',
  };
}

/** Reference mapping — mirrored by `engine::render::transition_filter` in Rust. */
export function transitionFilter(
  kind: string,
  start: number,
  end: number,
  center: number,
  hasFrom: boolean,
  hasTo: boolean,
): string {
  const duration = round(end - start);

  if (kind === 'crossfade' && hasFrom && hasTo) {
    return `xfade=transition=fade:duration=${duration}:offset=${round(start)}`;
  }

  const color = kind === 'dip-white' ? 'white' : 'black';

  if (hasFrom && hasTo) {
    const half = round((end - start) / 2);
    return (
      `fade=t=out:st=${round(start)}:d=${half}:color=${color},` +
      `fade=t=in:st=${round(center)}:d=${half}:color=${color}`
    );
  }
  if (hasTo) return `fade=t=in:st=${round(start)}:d=${duration}:color=${color}`;
  return `fade=t=out:st=${round(start)}:d=${duration}:color=${color}`;
}

export const chainFor = chainOf;

/** Asks the native engine when it is there, falls back to the local twin. */
export async function buildRenderPlan(project: Project): Promise<RenderPlan> {
  if (!isTauri()) return buildRenderPlanLocally(project);
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<RenderPlan>('process_timeline_segments', {
      project: { ...project, assets: project.assets.map(serializeAsset) },
    });
  } catch (error) {
    console.error('native engine unavailable, falling back', error);
    return buildRenderPlanLocally(project);
  }
}
