import { create } from 'zustand';

import { uid, projectId as newProjectId } from '@/lib/id';
import { isTauri } from '@/lib/env';
import { clamp, snapToFrame } from '@/lib/time';
import type { Waveform } from '@/lib/media';
import {
  assetFromFile,
  assetFromPath,
  captureThumbnail,
  extractWaveform,
  pathToSrc,
  probeMedia,
  rehydrateAssets,
  serializeAsset,
} from '@/lib/media';
import { emptyProject, normalizeProject, storage, summarize } from '@/lib/persistence';
import { parentDirectory, relinkAssets } from '@/lib/relink';
import {
  SCHEMA_VERSION,
  type Project,
  type ProjectSettings,
  type ProjectSummary,
  type SerializedProject,
} from '@/types/project';
import { IMPORT_EXTENSIONS, STILL_DEFAULT_DURATION, type MediaAsset } from '@/types/media';
import {
  DEFAULT_TRACK_HEIGHT,
  MIN_CLIP_DURATION,
  clipEnd,
  defaultTrackAudio,
  trackAudioOf,
  type Clip,
  type Track,
  type TrackAudio,
  type TrackKind,
} from '@/types/timeline';
import { DEFAULT_EXPORT_SETTINGS, reconcile, type ExportSettings } from '@/types/export';
import { initialParams, neutralParams, type Effect, type EffectKind } from '@/types/effects';
import { DEFAULT_TEXT_DURATION, defaultTextLayer, type TextLayer } from '@/types/text';
import { DEFAULT_SPLIT_OPTIONS, splitTextClips, type SplitOptions } from '@/lib/textSplit';
import { placeBackground } from '@/lib/backgroundLayer';
import { bannerAnimation, placePreset } from '@/lib/bannerLayer';
import { cameraOn, fittedSize } from '@/lib/geometry';
import type { Backdrop } from '@/types/backdrop';
import { retargetProject, type RetargetOptions } from '@/lib/retarget';
import type { ScreenPoint } from '@/types/geometry';
import { measureBanner } from '@/lib/bannerPainter';
import { redress, type BannerLayer, type BannerPreset } from '@/types/banner';
import { DEFAULT_MARKER_COLOR, markersOf, sortMarkers, type Marker } from '@/types/marker';
import type { BackgroundKind, BackgroundLayer } from '@/types/background';
import {
  DEFAULT_EASING,
  evaluateKeyframes,
  isAnimated,
  isClipChannel,
  parseBackgroundChannel,
  parseEffectChannel,
  sortKeyframes,
  type AnimationMap,
  type Easing,
  type Keyframe,
  type KeyframeRef,
} from '@/types/animation';
import {
  DEFAULT_TRANSITION_DURATION,
  MIN_TRANSITION_DURATION,
  isJunction,
  transitionDescriptor,
  type Transition,
  type TransitionAnchor,
  type TransitionKind,
} from '@/types/transitions';
import { staleTransitionIds, transitionAnchors } from './selectors';

import type { MenuItem } from '@/components/ui/ContextMenu';

export type View = 'home' | 'editor';

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}
export type LeftTab = 'media' | 'effects' | 'mixer' | 'online';
/** The right column is shared between the inspector and the AI assistant. */
export type RightTab = 'inspector' | 'assistant' | 'director';

/** One undo step: the document as it was, plus what the edit was called. */
export interface HistoryEntry {
  project: Project;
  label: string;
  at: number;
}

/** How a mutation joins the history. */
export type HistoryMode = 'push' | 'coalesce' | 'skip';

export interface HistoryOptions {
  label?: string;
  mode?: HistoryMode;
}

/** Workspace preferences, not project data — they live beside the app. */
const DEFAULT_EASING_KEY = 'veglass:default-easing';
const EXPORT_SETTINGS_KEY = 'veglass:export-settings';

function readExportSettings(): ExportSettings {
  try {
    const raw = localStorage.getItem(EXPORT_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_EXPORT_SETTINGS };
    return reconcile({ ...DEFAULT_EXPORT_SETTINGS, ...(JSON.parse(raw) as ExportSettings) });
  } catch {
    return { ...DEFAULT_EXPORT_SETTINGS };
  }
}

function readDefaultEasing(): Easing {
  try {
    const raw = localStorage.getItem(DEFAULT_EASING_KEY);
    if (!raw) return { ...DEFAULT_EASING };
    const parsed = JSON.parse(raw) as Easing;
    return parsed?.kind ? parsed : { ...DEFAULT_EASING };
  } catch {
    return { ...DEFAULT_EASING };
  }
}

const HISTORY_LIMIT = 80;
/** Consecutive same-label edits inside this window collapse into one step. */
const COALESCE_MS = 700;

/** Fraction of the project resolution the viewer rasterises while playing. */
export type PreviewQuality = 1 | 0.5 | 0.25;

export const PREVIEW_QUALITIES: { value: PreviewQuality; label: string; hint: string }[] = [
  { value: 1, label: 'Intégrale', hint: 'Résolution du projet' },
  { value: 0.5, label: '1/2', hint: 'Moitié — lecture plus fluide' },
  { value: 0.25, label: '1/4', hint: 'Quart — projets 4K / machines modestes' },
];
export type ToastTone = 'info' | 'success' | 'error';

export interface Toast {
  id: string;
  message: string;
  tone: ToastTone;
}

export interface NewProjectInput {
  name: string;
  settings: ProjectSettings;
}

interface EditorState {
  view: View;
  booting: boolean;
  busy: boolean;

  project: Project | null;
  projects: ProjectSummary[];
  storageLocation: string;
  savedAt: number | null;
  dirty: boolean;

  playhead: number;
  isPlaying: boolean;
  loopPlayback: boolean;
  pixelsPerSecond: number;
  masterVolume: number;
  masterMuted: boolean;
  snapEnabled: boolean;
  previewQuality: PreviewQuality;

  /**
   * The clip the inspector is showing — the last one added to the selection.
   * Kept alongside {@link selectedClipIds} rather than derived from it so the
   * dozens of single-clip readers throughout the app carry on unchanged.
   */
  selectedClipId: string | null;
  /** Every selected clip. Ctrl+click adds and removes; a plain click replaces. */
  selectedClipIds: string[];
  selectedAssetId: string | null;
  selectedTransitionId: string | null;
  /** Which library the left rail is showing — shared so the inspector can steer it. */
  leftTab: LeftTab;
  /** Which panel the right column is showing. */
  rightTab: RightTab;

  /** Work area, in seconds. `null` means the whole timeline. */
  workIn: number | null;
  workOut: number | null;
  exportSettings: ExportSettings;

  /** Assets whose file could not be found, even after an automatic search. */
  missingAssetIds: string[];
  relinkOpen: boolean;

  past: HistoryEntry[];
  future: HistoryEntry[];

  /** Clips copied for pasting, with their effects and curves. Session-only. */
  clipClipboard: Clip[] | null;

  /**
   * Space is held down.
   *
   * The timeline reads it to become a hand tool; the transport reads it on
   * release to decide whether the press was a play/pause or the start of a pan.
   */
  spaceHeld: boolean;
  /** Set by the timeline when a space-drag actually moved the view. */
  spacePanned: boolean;

  /** Text layer being typed into directly on the viewer. */
  editingTextClipId: string | null;
  /** Clip whose animation channels are unfolded on the timeline. */
  expandedClipId: string | null;
  /** Timeline shows the value graph instead of the track rows. */
  graphMode: boolean;
  /** The animation column, beside the clip inspector. */
  animationPanelOpen: boolean;
  /** Channels hidden from the graph, by name. Session-only. */
  hiddenGraphChannels: string[];
  selectedKeyframes: KeyframeRef[];
  keyframeClipboard: { channel: string; keyframes: Keyframe[] }[] | null;
  /** Curve given to every keyframe created from now on. */
  defaultEasing: Easing;

  thumbnails: Record<string, string>;
  /** `null` marks an analysis that was attempted and failed. */
  peaks: Record<string, Waveform | null>;

  zoomAnchor: ((factor: number) => void) | null;

  toasts: Toast[];
  /** The one right-click menu, wherever it was opened from. */
  contextMenu: ContextMenuState | null;

  boot(): Promise<void>;
  openContextMenu(x: number, y: number, items: MenuItem[]): void;
  closeContextMenu(): void;
  notify(message: string, tone?: ToastTone): void;
  dismissToast(id: string): void;

  createProject(input: NewProjectInput): Promise<void>;
  duplicateProject(id: string): Promise<void>;
  openProject(id: string): Promise<void>;
  closeProject(): Promise<void>;
  deleteProject(id: string): Promise<void>;
  renameProject(name: string): void;
  saveProject(): Promise<void>;

  importFiles(files: File[]): Promise<void>;
  importFromDialog(): Promise<void>;
  /**
   * Imports files already on disk, by absolute path.
   *
   * The single road into the library for anything that did not arrive as a
   * `File`: the native picker and the online downloader both come through
   * here, which is what makes a fetched clip indistinguishable from a
   * dragged-in one everywhere downstream.
   */
  importPaths(paths: string[]): Promise<number>;
  /**
   * Fills in the thumbnail and waveform of assets that arrived another way.
   *
   * A generator that adds media inside its own `transact` — the AMV sequencer's
   * music and clips, a tutorial's voice-over takes — never passes through
   * `importPaths`, and so never gets the decode pass everything imported by
   * hand does. The result is a music clip on the timeline with no waveform
   * under it, which on a montage cut to that music is precisely the thing you
   * need to see.
   *
   * Asynchronous, and deliberately not awaited by its callers: the document is
   * already correct without it, and this only makes it legible.
   */
  enrichAssets(assetIds: string[]): Promise<void>;
  removeAsset(assetId: string): void;

  addClip(assetId: string, options?: { trackId?: string; at?: number }): string | null;
  moveClip(clipId: string, next: { start: number; trackId?: string }): void;
  trimClip(clipId: string, edge: 'start' | 'end', time: number): void;
  updateClip(clipId: string, patch: Partial<Clip>, history?: HistoryOptions): void;
  removeClip(clipId: string): void;
  /** Deletes every selected clip in one step. */
  removeSelectedClips(): void;
  splitAtPlayhead(): void;
  duplicateClip(clipId: string): void;
  duplicateClips(clipIds: string[]): void;
  /** Copies clips — the current selection when no ids are given. */
  copyClips(clipIds?: string[]): void;
  /** Pastes the clipboard at `at`, or at the playhead. */
  pasteClips(at?: number): void;

  addEffect(clipId: string, kind: EffectKind): void;
  setEffectParam(clipId: string, effectId: string, key: string, value: number): void;
  toggleEffect(clipId: string, effectId: string): void;
  resetEffect(clipId: string, effectId: string): void;
  moveEffect(clipId: string, effectId: string, direction: -1 | 1): void;
  removeEffect(clipId: string, effectId: string): void;
  clearEffects(clipId: string): void;

  addTransition(anchor: TransitionAnchor, kind: TransitionKind): void;
  setTransitionKind(transitionId: string, kind: TransitionKind): void;
  setTransitionDuration(transitionId: string, duration: number): void;
  removeTransition(transitionId: string): void;
  selectTransition(transitionId: string | null): void;
  setLeftTab(tab: LeftTab): void;
  setRightTab(tab: RightTab): void;

  /**
   * One document rewrite, one undo step.
   *
   * The public mutations above each push their own history entry, which is what
   * you want when a person makes one edit at a time. A generated batch is the
   * opposite case: a subtitle pass writes a hundred clips and a smart cut
   * rewrites every track, and both must undo in a single press. `transact`
   * exposes the store's write path directly for those — the caller supplies a
   * pure `Project → Project` function, so the atomicity is real rather than a
   * convention (see `lib/ai/plan.ts` and `lib/ai/silence.ts`).
   *
   * Intended for whole operations, never for a drag: a continuous gesture still
   * belongs on a coalescing mutation.
   */
  transact(label: string, mutate: (project: Project) => Project): void;

  openRelink(): void;
  closeRelink(): void;
  /** Re-runs the search, optionally with folders the user has pointed at. */
  retryRelink(hints?: string[]): Promise<void>;
  /** Desktop: the user located one file; its folder relinks the rest. */
  relinkFromPath(assetId: string, filePath: string): Promise<void>;
  /** Browser: re-attach blobs by filename. */
  relinkFromFiles(files: File[]): void;

  undo(): void;
  redo(): void;

  /* Animation ------------------------------------------------------- */

  /**
   * The single write path for an animatable property: it lands on a keyframe
   * when the channel is animated, and on the static field when it is not.
   */
  setProperty(clipId: string, channel: string, value: number, history?: HistoryOptions): void;

  /**
   * The crop tool.
   *
   * `cropMode` puts the viewer into framing mode — a rule-of-thirds grid, the
   * target frame drawn over the picture, and a handle that moves the subject.
   * `setClipAnchor` is that handle; `retargetTo` is the whole-project format
   * shift, and it is one undo step however many clips it moves.
   */
  cropMode: boolean;
  setCropMode(on: boolean): void;
  /**
   * The glass behind a floating clip. `null` removes it.
   *
   * Its own action rather than a corner of `updateClip` because it is the one
   * clip property the *encoder* reads directly — everything else it needs is
   * baked or sampled first — so the write is worth naming.
   */
  setBackdrop(clipId: string, backdrop: Backdrop | null): void;
  updateBackdrop(clipId: string, patch: Partial<Backdrop>): void;
  setClipAnchor(clipId: string, anchor: ScreenPoint): void;
  retargetTo(settings: ProjectSettings, options?: RetargetOptions): void;
  /** Turns keyframing on (seeding a key at the playhead) or off (freezing the current value). */
  toggleChannel(clipId: string, channel: string): void;
  addKeyframeAt(clipId: string, channel: string, time?: number): void;
  removeKeyframes(refs: KeyframeRef[]): void;
  /**
   * Absolute placement, not a delta: a drag re-sends the target time on every
   * pointer frame, and snapping a *delta* to frames would round tiny increments
   * away to nothing and freeze the gesture.
   */
  setKeyframeTimes(updates: { ref: KeyframeRef; time: number }[]): void;
  setKeyframeEasing(refs: KeyframeRef[], easing: Easing): void;
  setKeyframeValue(refs: KeyframeRef[], value: number): void;
  /** Time and value together — one history step for one graph gesture. */
  setKeyframeAt(updates: { ref: KeyframeRef; time: number; value: number }[]): void;
  toggleGraphMode(): void;
  setAnimationPanel(open: boolean): void;

  setWorkIn(time?: number): void;
  setWorkOut(time?: number): void;
  clearWorkArea(): void;
  setExportSettings(patch: Partial<ExportSettings>): void;

  toggleTrackSolo(trackId: string): void;
  patchTrackAudio(trackId: string, patch: Partial<TrackAudio>, history?: HistoryOptions): void;
  toggleGraphChannel(channel: string): void;
  /** Drops a key on every animated channel of a clip, at the playhead. */
  keyAllChannels(clipId?: string): void;
  selectKeyframes(refs: KeyframeRef[], additive?: boolean): void;
  copyKeyframes(): void;
  pasteKeyframes(clipId?: string): void;
  toggleClipExpansion(clipId: string): void;
  setDefaultEasing(easing: Easing): void;

  addTextClip(options?: { trackId?: string; at?: number }): string | null;
  /**
   * Replaces each text clip with one clip per word, timed across its span.
   *
   * The word-by-word reveal every social edit uses. Doing it by hand is fifteen
   * cuts and fifteen retypes, which is why it goes through one write here.
   */
  splitTextIntoWords(clipIds: string[], options?: Partial<SplitOptions>): void;
  /** Drops a generated background under everything else. */
  addBackgroundClip(kind?: BackgroundKind, options?: { at?: number; duration?: number }): string | null;

  /**
   * Lower thirds and chapter banners.
   *
   * `addBannerClip` and the assistant's own chapter pass both go through
   * `placeBanner`, so a banner dropped by hand lands exactly where a generated
   * one would — see `lib/bannerLayer`.
   */
  /** The template picker, opened from the toolbar and the track menu. */
  bannerPickerOpen: boolean;
  openBannerPicker(open: boolean): void;

  addBannerClip(
    preset: BannerPreset,
    content?: { title?: string; subtitle?: string },
    options?: { at?: number; duration?: number },
  ): string | null;
  updateBanner(clipId: string, patch: Partial<BannerLayer>): void;
  /** Re-dresses a banner with another template, keeping what was typed. */
  setBannerPreset(clipId: string, preset: BannerPreset): void;
  /**
   * Rewrites a banner's entrance from its current settings.
   *
   * Editing `entrance` or `travel` deliberately does *not* touch the keyframes
   * that are already there — a curve someone has adjusted by hand must not be
   * silently thrown away by a slider. This is the explicit way to ask for it.
   */
  restageBanner(clipId: string): void;
  updateBackground(clipId: string, patch: Partial<BackgroundLayer>): void;
  updateText(clipId: string, patch: Partial<TextLayer>): void;
  setEditingText(clipId: string | null): void;

  addTrack(kind: TrackKind): void;
  removeTrack(trackId: string): void;
  /** Reorders a track within the block of its own kind — that block is the z-order. */
  moveTrack(trackId: string, targetIndex: number): void;
  patchTrack(trackId: string, patch: Partial<Track>, history?: HistoryOptions): void;

  /** `additive` toggles membership instead of replacing the selection. */
  selectClip(clipId: string | null, additive?: boolean): void;
  selectClips(clipIds: string[]): void;
  selectAsset(assetId: string | null): void;
  setSpaceHeld(held: boolean): void;
  markSpacePan(): void;

  setPlayhead(time: number): void;
  nudgePlayhead(frames: number): void;

  /**
   * Chapter markers.
   *
   * Document data, so each of these is one history entry — dropping a marker is
   * as undoable as dropping a clip. They carry no duration and occupy no track:
   * everything a marker does, it does on the ruler.
   */
  addMarker(time: number, label?: string, color?: string): void;
  renameMarker(id: string, label: string): void;
  moveMarker(id: string, time: number): void;
  removeMarker(id: string): void;
  clearMarkers(): void;

  play(): void;
  pause(): void;
  togglePlay(): void;
  setZoom(pixelsPerSecond: number): void;
  zoomBy(factor: number): void;
  /**
   * The timeline publishes its cursor/playhead-anchored zoom here so keyboard
   * shortcuts pivot the same way the wheel does, instead of pinning the left
   * edge of the view.
   */
  registerZoomAnchor(handler: ((factor: number) => void) | null): void;
  setMasterVolume(volume: number): void;
  toggleMasterMute(): void;
  toggleSnap(): void;
  toggleLoop(): void;
  setPreviewQuality(quality: PreviewQuality): void;
}

/* ------------------------------------------------------------------ *
 * Pure helpers — exported so the timeline and preview can reuse them.
 * ------------------------------------------------------------------ */

export const defaultTracks = (): Track[] => [
  {
    id: uid('tr'),
    kind: 'video',
    name: 'V1',
    height: DEFAULT_TRACK_HEIGHT,
    muted: false,
    solo: false,
    locked: false,
    hidden: false,
  },
  {
    id: uid('tr'),
    kind: 'audio',
    name: 'A1',
    height: 54,
    muted: false,
    solo: false,
    locked: false,
    hidden: false,
    audio: defaultTrackAudio(),
  },
];

/** Timeline length = furthest clip end. */
export function projectDuration(project: Project | null): number {
  if (!project) return 0;
  return project.clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0);
}

/**
 * Tracks are magnetic: a clip never overlaps a sibling. When the requested
 * position collides we slide to the closest free edge instead of rejecting the
 * gesture, which keeps dragging forgiving.
 */
export function resolveStart(siblings: Clip[], desiredStart: number, duration: number): number {
  let start = Math.max(0, desiredStart);
  for (let guard = 0; guard < 64; guard += 1) {
    const hit = siblings.find((clip) => start < clipEnd(clip) && start + duration > clip.start);
    if (!hit) return start;
    const hitCenter = hit.start + hit.duration / 2;
    if (start + duration / 2 < hitCenter) {
      const left = hit.start - duration;
      start = left >= 0 ? left : clipEnd(hit);
    } else {
      start = clipEnd(hit);
    }
  }
  return start;
}

/** Whether `[start, start + duration)` is clear on a track. */
function isSpanFree(clips: Clip[], trackId: string, start: number, duration: number): boolean {
  return !clips.some(
    (clip) =>
      clip.trackId === trackId && start < clipEnd(clip) && start + duration > clip.start,
  );
}

export interface Placement {
  trackId: string;
  /** A layer that had to be invented; the caller must add it to the document. */
  created: Track | null;
}

/**
 * Where a new clip goes.
 *
 * The time the user asked for is honoured exactly — the search moves *across
 * layers*, never along the timeline. Sliding a clip to the next free gap puts
 * it somewhere nobody pointed at, usually off screen; stacking it on another
 * layer is what having layers is for. When every layer is busy at that instant,
 * one more is created rather than displacing anything.
 */
export function placeOnFreeLayer(
  project: Project,
  kind: TrackKind,
  start: number,
  duration: number,
  preferredTrackId?: string,
): Placement {
  const candidates = project.tracks.filter(
    (track) => track.kind === kind && !track.locked,
  );
  const preferred = candidates.find((track) => track.id === preferredTrackId);
  const ordered = preferred
    ? [preferred, ...candidates.filter((track) => track.id !== preferred.id)]
    : candidates;

  const free = ordered.find((track) => isSpanFree(project.clips, track.id, start, duration));
  if (free) return { trackId: free.id, created: null };

  const count = project.tracks.filter((track) => track.kind === kind).length + 1;
  const created: Track = {
    id: uid('tr'),
    kind,
    name: `${kind === 'video' ? 'V' : 'A'}${count}`,
    height: kind === 'video' ? DEFAULT_TRACK_HEIGHT : 54,
    muted: false,
    solo: false,
    locked: false,
    hidden: false,
    ...(kind === 'audio' ? { audio: defaultTrackAudio() } : {}),
  };
  return { trackId: created.id, created };
}

/** Video layers stack on top, audio layers below — the compositing order. */
function withTrack(tracks: Track[], created: Track | null): Track[] {
  if (!created) return tracks;
  return created.kind === 'video' ? [created, ...tracks] : [...tracks, created];
}

/**
 * Appends a snapshot, folding a continuous gesture into a single step.
 *
 * A clip drag writes the document on every pointer frame; without coalescing,
 * undoing it would take sixty presses. When the label repeats inside the
 * window we keep the *first* snapshot — the state before the gesture began —
 * which is exactly what one press should restore.
 */
function pushHistory(
  past: HistoryEntry[],
  snapshot: Project,
  label: string,
  mode: HistoryMode,
): HistoryEntry[] {
  const last = past[past.length - 1];
  const now = Date.now();

  if (mode === 'coalesce' && last && last.label === label && now - last.at < COALESCE_MS) {
    return [...past.slice(0, -1), { ...last, at: now }];
  }
  return [...past, { project: snapshot, label, at: now }].slice(-HISTORY_LIMIT);
}

/** The scalar a channel falls back to when it carries no keyframes. */
export function staticValueOf(clip: Clip, channel: string): number {
  if (isClipChannel(channel)) return clip[channel];

  const background = parseBackgroundChannel(channel);
  if (background) return clip.background?.[background] ?? 0;

  const parsed = parseEffectChannel(channel);
  if (!parsed) return 0;
  const effect = clip.effects.find((item) => item.id === parsed.effectId);
  return effect?.params[parsed.key] ?? 0;
}

/** Writes a scalar into whichever field the channel names. */
function writeStatic(clip: Clip, channel: string, value: number): Clip {
  if (isClipChannel(channel)) return { ...clip, [channel]: value };

  const background = parseBackgroundChannel(channel);
  if (background) {
    return clip.background
      ? { ...clip, background: { ...clip.background, [background]: value } }
      : clip;
  }

  const parsed = parseEffectChannel(channel);
  if (!parsed) return clip;
  return {
    ...clip,
    effects: clip.effects.map((effect) =>
      effect.id === parsed.effectId
        ? { ...effect, params: { ...effect.params, [parsed.key]: value } }
        : effect,
    ),
  };
}

function withChannel(clip: Clip, channel: string, keyframes: Keyframe[] | null): Clip {
  const animation: AnimationMap = { ...(clip.animation ?? {}) };
  if (keyframes === null || keyframes.length === 0) delete animation[channel];
  else animation[channel] = sortKeyframes(keyframes);
  return Object.keys(animation).length > 0
    ? { ...clip, animation }
    : // Drop the map entirely when nothing is animated: an absent map is the
      // signal the rest of the code tests for.
      (({ animation: _drop, ...rest }) => rest as Clip)(clip);
}

/** Fresh ids so a duplicated clip owns its effect instances outright. */
const cloneEffects = (effects: Effect[]): Effect[] =>
  effects.map((effect) => ({ ...effect, id: uid('fx'), params: { ...effect.params } }));

const cloneAnimation = (animation: AnimationMap | undefined): AnimationMap | undefined => {
  if (!animation) return undefined;
  const out: AnimationMap = {};
  for (const [channel, keyframes] of Object.entries(animation)) {
    out[channel] = keyframes.map((keyframe) => ({ ...keyframe, id: uid('kf') }));
  }
  return out;
};

/**
 * A free name for a copy: `Teaser (copie)`, then `(copie 2)`, `(copie 3)`…
 *
 * Duplicating the same project twice must not produce two identical rows in the
 * dashboard, and duplicating a copy should not give `Teaser (copie) (copie)`.
 */
export function copyName(name: string, taken: string[]): string {
  const stem = name.replace(/\s*\(copie(?:\s+\d+)?\)\s*$/i, '').trim() || name;
  const used = new Set(taken);
  const first = `${stem} (copie)`;
  if (!used.has(first)) return first;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem} (copie ${index})`;
    if (!used.has(candidate)) return candidate;
  }
  return `${stem} (copie ${Date.now()})`;
}

/** Longest window the material around an anchor can absorb. */
function clampTransitionDuration(anchor: TransitionAnchor, duration: number): number {
  return Math.max(MIN_TRANSITION_DURATION, Math.min(duration, Math.max(anchor.maxDuration, MIN_TRANSITION_DURATION)));
}

function toSerializable(project: Project): SerializedProject {
  return {
    ...project,
    assets: project.assets.map(serializeAsset),
    schemaVersion: SCHEMA_VERSION,
  };
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useEditor = create<EditorState>((set, get) => {
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void get().saveProject();
    }, 700);
  };

  /**
   * The single write path for the document: one `set` per mutation (dragging a
   * clip runs this every pointer frame), then a debounced save.
   */
  /** Keeps a keyframe inside its clip, on a frame boundary. */
  const clampLocalTime = (clip: Clip, time: number, fps: number): number =>
    snapToFrame(clamp(time, 0, clip.duration), fps);

  /**
   * Sets a keyframe at `time`, replacing one already sitting on that frame.
   *
   * Snapping to frames is what makes this stable: without it, scrubbing and
   * dragging would sprinkle near-duplicate keys a microsecond apart.
   */
  const upsert = (
    clipId: string,
    channel: string,
    time: number,
    value: number,
    history: HistoryOptions,
  ) => {
    const state = get();
    const fps = state.project?.settings.fps ?? 30;
    const tolerance = 0.5 / fps;

    const existing = state.project?.clips
      .find((clip) => clip.id === clipId)
      ?.animation?.[channel] ?? [];
    const hit = existing.find((keyframe) => Math.abs(keyframe.time - time) < tolerance);
    // Resolved before the patch so the selection can point at it afterwards.
    const id = hit?.id ?? uid('kf');

    patchProject((project) => ({
      ...project,
      clips: project.clips.map((clip) => {
        if (clip.id !== clipId) return clip;
        const current = clip.animation?.[channel] ?? [];
        const next = hit
          ? current.map((keyframe) => (keyframe.id === id ? { ...keyframe, value } : keyframe))
          : [...current, { id, time, value, easing: { ...state.defaultEasing } }];
        return withChannel(clip, channel, next);
      }),
    }), history);

    // The keyframe you just touched becomes the selected one, so the speed
    // curve in the inspector is always about what you are editing.
    const selected = get().selectedKeyframes;
    if (selected.length !== 1 || selected[0]?.id !== id) {
      set({ selectedKeyframes: [{ clipId, channel, id }] });
    }
  };

  const patchProject = (
    mutate: (project: Project) => Project,
    history: HistoryOptions = {},
  ) => {
    const current = get().project;
    if (!current) return;
    let next = mutate(current);

    // A transition only exists while its neighbours still meet. Moving,
    // trimming or deleting a clip can dissolve that junction, so every write
    // sweeps the orphans instead of leaving them in the document.
    const stale = staleTransitionIds(next);
    if (stale.size > 0) {
      next = { ...next, transitions: next.transitions.filter((item) => !stale.has(item.id)) };
    }

    const mode = history.mode ?? 'push';
    if (mode !== 'skip') {
      set((state) => ({
        past: pushHistory(state.past, current, history.label ?? 'modification', mode),
        // Any new edit abandons the redo branch, as everywhere else.
        future: [],
      }));
    }

    set({ project: { ...next, updatedAt: Date.now() }, dirty: true });
    if (stale.size > 0 && get().selectedTransitionId && stale.has(get().selectedTransitionId as string)) {
      set({ selectedTransitionId: null });
    }
    scheduleSave();
  };

  /** Drops selections that point at objects the restored document no longer has. */
  const reconcileSelection = (project: Project) => {
    set((state) => {
      const alive = state.selectedClipIds.filter((id) =>
        project.clips.some((clip) => clip.id === id),
      );
      return {
        selectedClipIds: alive,
        // The inspector keeps its subject when it survived, and otherwise falls
        // back to whatever is still selected rather than to nothing.
        selectedClipId:
          state.selectedClipId && alive.includes(state.selectedClipId)
            ? state.selectedClipId
            : alive[alive.length - 1] ?? null,
        selectedTransitionId: project.transitions.some(
          (item) => item.id === state.selectedTransitionId,
        )
          ? state.selectedTransitionId
          : null,
      };
    });
  };

  /** Decode metadata, then poster frame / waveform, without blocking the UI. */
  const enrichAsset = async (asset: MediaAsset) => {
    if (!asset.src) return;
    const probe = await probeMedia(asset.src, asset.kind);
    const duration = asset.kind === 'image' ? STILL_DEFAULT_DURATION : probe.duration;

    // The user may have closed or swapped projects while we were decoding.
    if (get().project?.assets.some((item) => item.id === asset.id)) {
      patchProject(
        (project) => ({
          ...project,
          assets: project.assets.map((item) =>
            item.id === asset.id
              ? { ...item, duration, width: probe.width, height: probe.height }
              : item,
          ),
        }),
        // Metadata the decoder discovered is not an edit the user made.
        { mode: 'skip' },
      );
    }

    if (asset.kind === 'video') {
      const thumb = await captureThumbnail(asset.src);
      if (thumb) set((state) => ({ thumbnails: { ...state.thumbnails, [asset.id]: thumb } }));
    } else if (asset.kind === 'audio') {
      const waveform = await extractWaveform(asset, duration);
      // Recorded either way: `undefined` means still analysing, `null` means it
      // was tried and failed, and the clip says so instead of looking empty.
      set((state) => ({ peaks: { ...state.peaks, [asset.id]: waveform } }));
      if (!waveform) {
        get().notify(`Forme d’onde indisponible pour « ${asset.name} »`, 'error');
      }
    }
  };

  const registerAssets = async (assets: MediaAsset[]) => {
    if (assets.length === 0) return;
    patchProject((project) => ({ ...project, assets: [...project.assets, ...assets] }));
    set({ selectedAssetId: assets[assets.length - 1]?.id ?? null });
    await Promise.all(assets.map(enrichAsset));
  };

  return {
    view: 'home',
    booting: true,
    busy: false,

    project: null,
    projects: [],
    storageLocation: '',
    savedAt: null,
    dirty: false,

    playhead: 0,
    isPlaying: false,
    loopPlayback: false,
    pixelsPerSecond: 64,
    masterVolume: 1,
    masterMuted: false,
    snapEnabled: true,
    previewQuality: 1,

    selectedClipId: null,
    selectedClipIds: [],
    selectedAssetId: null,
    selectedTransitionId: null,
    clipClipboard: null,
    spaceHeld: false,
    spacePanned: false,
    leftTab: 'media',
    rightTab: 'inspector',
    workIn: null,
    workOut: null,
    exportSettings: readExportSettings(),
    missingAssetIds: [],
    relinkOpen: false,
    past: [],
    future: [],
    editingTextClipId: null,
    expandedClipId: null,
    graphMode: false,
    animationPanelOpen: true,
    hiddenGraphChannels: [],
    selectedKeyframes: [],
    keyframeClipboard: null,
    defaultEasing: readDefaultEasing(),

    thumbnails: {},
    peaks: {},
    zoomAnchor: null,
    toasts: [],
    contextMenu: null,

    async boot() {
      try {
        const [projects, location] = await Promise.all([storage.list(), storage.location()]);
        set({ projects, storageLocation: location, booting: false });
      } catch (error) {
        console.error(error);
        set({ booting: false });
        get().notify('Impossible de lire la bibliothèque de projets', 'error');
      }
    },

    openContextMenu(x, y, items) {
      if (items.length === 0) return;
      set({ contextMenu: { x, y, items } });
    },

    closeContextMenu() {
      if (get().contextMenu) set({ contextMenu: null });
    },

    notify(message, tone = 'info') {
      const toast: Toast = { id: uid('t'), message, tone };
      set((state) => ({ toasts: [...state.toasts, toast] }));
      setTimeout(() => get().dismissToast(toast.id), 4200);
    },

    dismissToast(id) {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    },

    async createProject({ name, settings }) {
      set({ busy: true });
      try {
        const serialized = emptyProject(
          newProjectId(),
          name.trim() || 'Projet sans titre',
          settings,
          defaultTracks(),
        );
        await storage.save(serialized);
        set({
          project: { ...serialized, assets: [] },
          view: 'editor',
          playhead: 0,
          isPlaying: false,
          selectedClipId: null,
          selectedClipIds: [],
          selectedAssetId: null,
          selectedTransitionId: null,
          missingAssetIds: [],
          relinkOpen: false,
          past: [],
          future: [],
          expandedClipId: null,
          selectedKeyframes: [],
          thumbnails: {},
          peaks: {},
          savedAt: Date.now(),
          dirty: false,
          projects: [summarize(serialized), ...get().projects],
        });
      } catch (error) {
        console.error(error);
        get().notify('Création du projet impossible', 'error');
      } finally {
        set({ busy: false });
      }
    },

    /**
     * Copies a project under a new name.
     *
     * Only the *project* id changes. Clip, track, effect and asset ids are
     * scoped to the document, so keeping them costs nothing — and keeping the
     * asset ids means the copy points at the same files on disk rather than
     * re-importing anything.
     */
    async duplicateProject(id) {
      set({ busy: true });
      try {
        const raw = await storage.load(id);
        if (!raw) {
          get().notify('Projet introuvable', 'error');
          return;
        }
        const source = normalizeProject(raw);
        const now = Date.now();
        const copy: SerializedProject = {
          ...source,
          id: newProjectId(),
          name: copyName(source.name, get().projects.map((item) => item.name)),
          createdAt: now,
          updatedAt: now,
        };

        await storage.save(copy);
        set((state) => ({ projects: [summarize(copy), ...state.projects] }));
        get().notify(`« ${copy.name} » créé`, 'success');
      } catch (error) {
        console.error(error);
        get().notify('Duplication impossible', 'error');
      } finally {
        set({ busy: false });
      }
    },

    async openProject(id) {
      set({ busy: true });
      try {
        const raw = await storage.load(id);
        if (!raw) {
          get().notify('Projet introuvable', 'error');
          return;
        }
        // Documents written by an older schema get their missing collections
        // filled in before anything else touches them.
        const serialized = normalizeProject(raw);
        const hydrated = await rehydrateAssets(serialized.assets);

        // Paths are verified — and quietly repaired — before the editor opens,
        // so a moved folder is a non-event rather than a wall of red.
        const outcome = await relinkAssets(hydrated);

        set({
          project: { ...serialized, assets: outcome.assets },
          view: 'editor',
          playhead: 0,
          isPlaying: false,
          selectedClipId: null,
          selectedClipIds: [],
          selectedAssetId: null,
          selectedTransitionId: null,
          missingAssetIds: outcome.missingIds,
          relinkOpen: outcome.missingIds.length > 0,
          past: [],
          future: [],
          expandedClipId: null,
          selectedKeyframes: [],
          thumbnails: {},
          peaks: {},
          savedAt: serialized.updatedAt,
          dirty: false,
        });

        if (outcome.relocated > 0) {
          get().notify(
            `${outcome.relocated} média${outcome.relocated > 1 ? 's relocalisés' : ' relocalisé'}`,
            'success',
          );
          void get().saveProject();
        }

        void Promise.all(
          outcome.assets.filter((asset) => !asset.missing).map(enrichAsset),
        );
      } catch (error) {
        console.error(error);
        get().notify('Ouverture impossible', 'error');
      } finally {
        set({ busy: false });
      }
    },

    async closeProject() {
      if (saveTimer) clearTimeout(saveTimer);
      await get().saveProject();
      const projects = await storage.list();
      set({ view: 'home', project: null, isPlaying: false, playhead: 0, projects });
    },

    async deleteProject(id) {
      await storage.remove(id);
      set((state) => ({ projects: state.projects.filter((project) => project.id !== id) }));
      get().notify('Projet supprimé');
    },

    renameProject(name) {
      patchProject((project) => ({ ...project, name: name.trim() || project.name }));
    },

    async saveProject() {
      const project = get().project;
      if (!project) return;
      try {
        const serialized = toSerializable(project);
        await storage.save(serialized);
        set((state) => ({
          dirty: false,
          savedAt: Date.now(),
          projects: [
            summarize(serialized),
            ...state.projects.filter((item) => item.id !== project.id),
          ].sort((a, b) => b.updatedAt - a.updatedAt),
        }));
      } catch (error) {
        console.error(error);
        get().notify('Sauvegarde échouée', 'error');
      }
    },

    undo() {
      const { past, future, project } = get();
      const entry = past[past.length - 1];
      if (!entry || !project) return;

      set({
        past: past.slice(0, -1),
        future: [{ project, label: entry.label, at: Date.now() }, ...future].slice(0, HISTORY_LIMIT),
        project: entry.project,
        dirty: true,
      });
      reconcileSelection(entry.project);
      scheduleSave();
      get().notify(`Annulé — ${entry.label}`);
    },

    redo() {
      const { past, future, project } = get();
      const entry = future[0];
      if (!entry || !project) return;

      set({
        future: future.slice(1),
        past: [...past, { project, label: entry.label, at: Date.now() }].slice(-HISTORY_LIMIT),
        project: entry.project,
        dirty: true,
      });
      reconcileSelection(entry.project);
      scheduleSave();
      get().notify(`Rétabli — ${entry.label}`);
    },

    async importFiles(files) {
      const assets = files.map(assetFromFile);
      await registerAssets(assets);
      if (assets.length > 0) {
        get().notify(
          `${assets.length} média${assets.length > 1 ? 's importés' : ' importé'}`,
          'success',
        );
      }
    },

    async importFromDialog() {
      if (!isTauri()) {
        get().notify('Glissez vos fichiers ici — le sélecteur natif requiert le mode Desktop');
        return;
      }
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        multiple: true,
        filters: [{ name: 'Médias', extensions: IMPORT_EXTENSIONS }],
      });
      if (!picked) return;
      const paths = (Array.isArray(picked) ? picked : [picked]) as string[];
      const count = await get().importPaths(paths);
      if (count > 0) {
        get().notify(`${count} média${count > 1 ? 's importés' : ' importé'}`, 'success');
      }
    },

    async importPaths(paths) {
      const wanted = paths.filter((path) => path.trim() !== '');
      if (wanted.length === 0 || !get().project) return 0;

      const assets = await Promise.all(wanted.map(assetFromPath));
      await registerAssets(assets);
      return assets.length;
    },

    async enrichAssets(assetIds) {
      const project = get().project;
      if (!project) return;

      const wanted = new Set(assetIds);
      const assets = project.assets.filter((asset) => wanted.has(asset.id) && !asset.missing);
      await Promise.all(assets.map(enrichAsset));
    },

    removeAsset(assetId) {
      patchProject((project) => ({
        ...project,
        assets: project.assets.filter((asset) => asset.id !== assetId),
        clips: project.clips.filter((clip) => clip.assetId !== assetId),
      }));
      set((state) => ({
        selectedAssetId: state.selectedAssetId === assetId ? null : state.selectedAssetId,
      }));
    },

    addClip(assetId, options = {}) {
      const project = get().project;
      if (!project) return null;
      const asset = project.assets.find((item) => item.id === assetId);
      if (!asset || asset.missing) return null;

      const { fps } = project.settings;
      // Sound goes on a sound layer, picture on a picture layer — a requested
      // track of the wrong kind is a mistake, not an instruction. A video clip
      // parked on an audio track never reaches the compositor, and simply
      // disappears from the viewer.
      const kind: TrackKind = asset.kind === 'audio' ? 'audio' : 'video';

      const duration = snapToFrame(
        Math.max(
          MIN_CLIP_DURATION,
          asset.kind === 'image'
            ? STILL_DEFAULT_DURATION
            : asset.duration || STILL_DEFAULT_DURATION,
        ),
        fps,
      );
      // Always where the user pointed: the playhead, or the drop position.
      const start = snapToFrame(Math.max(0, options.at ?? get().playhead), fps);
      const { trackId, created } = placeOnFreeLayer(
        project,
        kind,
        start,
        duration,
        options.trackId,
      );

      const clip: Clip = {
        id: uid('cl'),
        kind: 'media',
        assetId,
        trackId,
        start,
        duration,
        offset: 0,
        volume: 1,
        opacity: 1,
        scale: 1,
        x: 0,
        y: 0,
        rotation: 0,
        muted: false,
        label: asset.name,
        effects: [],
      };

      patchProject(
        (current) => ({
          ...current,
          tracks: withTrack(current.tracks, created),
          clips: [...current.clips, clip],
        }),
        { label: 'ajout de clip' },
      );
      set({ selectedClipId: clip.id, selectedTransitionId: null });
      if (created) get().notify(`Piste ${created.name} créée pour ce clip`);
      return clip.id;
    },

    setProperty(clipId, channel, value, history) {
      const state = get();
      const project = state.project;
      const clip = project?.clips.find((item) => item.id === clipId);
      if (!project || !clip) return;

      const keyframes = clip.animation?.[channel];

      if (!isAnimated(keyframes)) {
        patchProject(
          (current) => ({
            ...current,
            clips: current.clips.map((item) =>
              item.id === clipId ? writeStatic(item, channel, value) : item,
            ),
          }),
          history ?? { label: `${channel}:${clipId}`, mode: 'coalesce' },
        );
        return;
      }

      // Animated: the edit becomes a keyframe under the playhead, exactly as it
      // would in a compositor — the static field is no longer in play.
      const local = clampLocalTime(clip, state.playhead - clip.start, project.settings.fps);
      upsert(clipId, channel, local, value, history ?? { label: `${channel}:${clipId}`, mode: 'coalesce' });
    },

    setCropMode(on) {
      set({ cropMode: on });
    },

    setBackdrop(clipId, backdrop) {
      patchProject(
        (project) => ({
          ...project,
          clips: project.clips.map((clip) => {
            if (clip.id !== clipId) return clip;
            if (backdrop) return { ...clip, backdrop };
            // Removed rather than left as an empty object: `clip.backdrop`
            // being absent is what every renderer tests for.
            const { backdrop: _dropped, ...rest } = clip;
            return rest as typeof clip;
          }),
        }),
        { label: backdrop ? 'ajout d’un fond flouté' : 'retrait du fond flouté' },
      );
    },

    updateBackdrop(clipId, patch) {
      patchProject(
        (project) => ({
          ...project,
          clips: project.clips.map((clip) =>
            clip.id === clipId && clip.backdrop
              ? {
                  ...clip,
                  backdrop: {
                    ...clip.backdrop,
                    ...patch,
                    ...(patch.shadow ? { shadow: { ...clip.backdrop.shadow, ...patch.shadow } } : {}),
                  },
                }
              : clip,
          ),
        }),
        // Dragging a blur is continuous; one history step per burst.
        { label: `fond:${clipId}`, mode: 'coalesce' },
      );
    },

    setClipAnchor(clipId, anchor) {
      const state = get();
      const project = state.project;
      const clip = project?.clips.find((item) => item.id === clipId);
      const asset = project?.assets.find((item) => item.id === clip?.assetId);
      if (!project || !clip || !asset) return;

      const fit = fittedSize(asset, project.settings);
      if (!fit) return;

      // The zoom is the user's; only what is centred changes. Read at the
      // playhead so a clip carrying a camera move is re-aimed from the framing
      // actually on screen rather than from its static fallback.
      const at = clampLocalTime(clip, state.playhead - clip.start, project.settings.fps);
      const scale = evaluateKeyframes(clip.animation?.scale, at, clip.scale);
      const target = cameraOn(anchor, scale, fit, project.settings);

      /*
       * On an animated channel the whole curve shifts, rather than one key
       * being planted under the playhead.
       *
       * That is the difference between this and `setProperty`, and it is the
       * point of a crop handle: re-framing a shot means moving the *shot*, not
       * introducing a lurch at the instant the handle happened to be dragged.
       * The camera move keeps its shape and plays out in its new place — the
       * same reasoning as `setChannel` in `lib/ai/plan.ts`.
       */
      patchProject(
        (current) => ({
          ...current,
          clips: current.clips.map((item) => {
            if (item.id !== clipId) return item;

            let next = item;
            for (const channel of ['x', 'y'] as const) {
              const keys = next.animation?.[channel];
              const value = target[channel];
              next = writeStatic(next, channel, value);
              if (!isAnimated(keys)) continue;

              const shown = evaluateKeyframes(keys, at, item[channel]);
              const delta = value - shown;
              if (delta === 0) continue;
              next = withChannel(
                next,
                channel,
                (keys as Keyframe[]).map((key) => ({ ...key, value: key.value + delta })),
              );
            }
            return next;
          }),
        }),
        { label: `recadrage:${clipId}`, mode: 'coalesce' },
      );
    },

    retargetTo(settings, options) {
      const project = get().project;
      if (!project) return;

      let outcome: { touched: number; unmeasured: number } = { touched: 0, unmeasured: 0 };
      const label = `${settings.width}×${settings.height}`;

      // One transaction for the whole document: a format shift touches every
      // clip, every title and every banner, and it has to undo as one press.
      get().transact(`passage en ${label}`, (current) => {
        const result = retargetProject(current, settings, options ?? {});
        outcome = { touched: result.touched, unmeasured: result.unmeasured };
        return result.project;
      });

      get().notify(
        `Projet passé en ${label} — ${outcome.touched} calque${outcome.touched > 1 ? 's' : ''} recadré${outcome.touched > 1 ? 's' : ''}`,
        'success',
      );

      if (outcome.unmeasured > 0) {
        get().notify(
          `${outcome.unmeasured} clip${outcome.unmeasured > 1 ? 's' : ''} sans dimensions connues ${outcome.unmeasured > 1 ? 'ont' : 'a'} gardé son cadrage — lisez-le une fois dans l’aperçu pour que Veglass le mesure.`,
          'info',
        );
      }
    },

    toggleChannel(clipId, channel) {
      const state = get();
      const project = state.project;
      const clip = project?.clips.find((item) => item.id === clipId);
      if (!project || !clip) return;

      const keyframes = clip.animation?.[channel];
      const local = clampLocalTime(clip, state.playhead - clip.start, project.settings.fps);

      if (isAnimated(keyframes)) {
        // Turning animation off freezes what is on screen right now, so the
        // picture never jumps when the stopwatch goes out.
        const frozen = evaluateKeyframes(keyframes, local, staticValueOf(clip, channel));
        patchProject(
          (current) => ({
            ...current,
            clips: current.clips.map((item) =>
              item.id === clipId
                ? withChannel(writeStatic(item, channel, frozen), channel, null)
                : item,
            ),
          }),
          { label: 'désactivation de l’animation' },
        );
        set((prev) => ({
          selectedKeyframes: prev.selectedKeyframes.filter(
            (ref) => !(ref.clipId === clipId && ref.channel === channel),
          ),
        }));
        return;
      }

      const seed: Keyframe = {
        id: uid('kf'),
        time: local,
        value: staticValueOf(clip, channel),
        easing: { ...get().defaultEasing },
      };
      patchProject(
        (current) => ({
          ...current,
          clips: current.clips.map((item) =>
            item.id === clipId ? withChannel(item, channel, [seed]) : item,
          ),
        }),
        { label: 'activation de l’animation' },
      );
      // Unfold the clip *and* select the seed: the speed-curve library is only
      // useful if it appears the moment animation is switched on.
      set({
        expandedClipId: clipId,
        selectedKeyframes: [{ clipId, channel, id: seed.id }],
        animationPanelOpen: true,
      });
    },

    addKeyframeAt(clipId, channel, time) {
      const state = get();
      const project = state.project;
      const clip = project?.clips.find((item) => item.id === clipId);
      if (!project || !clip) return;

      const local =
        time ?? clampLocalTime(clip, state.playhead - clip.start, project.settings.fps);
      const value = evaluateKeyframes(
        clip.animation?.[channel],
        local,
        staticValueOf(clip, channel),
      );
      upsert(clipId, channel, local, value, { label: 'image clé' });
    },

    removeKeyframes(refs) {
      if (refs.length === 0) return;
      patchProject(
        (project) => ({
          ...project,
          clips: project.clips.map((clip) => {
            const mine = refs.filter((ref) => ref.clipId === clip.id);
            if (mine.length === 0 || !clip.animation) return clip;

            let next = clip;
            for (const channel of new Set(mine.map((ref) => ref.channel))) {
              const doomed = new Set(
                mine.filter((ref) => ref.channel === channel).map((ref) => ref.id),
              );
              const kept = (next.animation?.[channel] ?? []).filter(
                (keyframe) => !doomed.has(keyframe.id),
              );
              next = withChannel(next, channel, kept.length > 0 ? kept : null);
            }
            return next;
          }),
        }),
        { label: 'suppression d’images clés' },
      );
      set((prev) => ({
        selectedKeyframes: prev.selectedKeyframes.filter(
          (ref) => !refs.some((doomed) => doomed.id === ref.id),
        ),
      }));
    },

    setKeyframeTimes(updates) {
      if (updates.length === 0) return;
      const fps = get().project?.settings.fps ?? 30;

      patchProject(
        (project) => ({
          ...project,
          clips: project.clips.map((clip) => {
            const mine = updates.filter((update) => update.ref.clipId === clip.id);
            if (mine.length === 0 || !clip.animation) return clip;

            let next = clip;
            for (const channel of new Set(mine.map((update) => update.ref.channel))) {
              const target = new Map(
                mine
                  .filter((update) => update.ref.channel === channel)
                  .map((update) => [update.ref.id, update.time]),
              );
              const moved = (next.animation?.[channel] ?? []).map((keyframe) =>
                target.has(keyframe.id)
                  ? {
                      ...keyframe,
                      time: clampLocalTime(clip, target.get(keyframe.id) as number, fps),
                    }
                  : keyframe,
              );
              next = withChannel(next, channel, moved);
            }
            return next;
          }),
        }),
        { label: 'déplacement d’images clés', mode: 'coalesce' },
      );
    },

    setKeyframeAt(updates) {
      if (updates.length === 0) return;
      const fps = get().project?.settings.fps ?? 30;

      patchProject(
        (project) => ({
          ...project,
          clips: project.clips.map((clip) => {
            const mine = updates.filter((update) => update.ref.clipId === clip.id);
            if (mine.length === 0 || !clip.animation) return clip;

            let next = clip;
            for (const channel of new Set(mine.map((update) => update.ref.channel))) {
              const target = new Map(
                mine
                  .filter((update) => update.ref.channel === channel)
                  .map((update) => [update.ref.id, update]),
              );
              const moved = (next.animation?.[channel] ?? []).map((keyframe) => {
                const update = target.get(keyframe.id);
                if (!update) return keyframe;
                return {
                  ...keyframe,
                  time: clampLocalTime(clip, update.time, fps),
                  value: update.value,
                };
              });
              next = withChannel(next, channel, moved);
            }
            return next;
          }),
        }),
        { label: 'image clé (graphe)', mode: 'coalesce' },
      );
    },

    toggleGraphMode() {
      set((state) => ({ graphMode: !state.graphMode }));
    },

    setAnimationPanel(open) {
      set({ animationPanelOpen: open });
    },

    setWorkIn(time) {
      const state = get();
      const at = time ?? state.playhead;
      // In and out cannot cross; setting one past the other pushes it along.
      set({
        workIn: at,
        workOut: state.workOut !== null && state.workOut <= at ? null : state.workOut,
      });
    },

    setWorkOut(time) {
      const state = get();
      const at = time ?? state.playhead;
      set({
        workOut: at,
        workIn: state.workIn !== null && state.workIn >= at ? null : state.workIn,
      });
    },

    clearWorkArea() {
      set({ workIn: null, workOut: null });
      get().notify('Zone de travail effacée');
    },

    setExportSettings(patch) {
      const next = reconcile({ ...get().exportSettings, ...patch });
      set({ exportSettings: next });
      try {
        localStorage.setItem(EXPORT_SETTINGS_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable — the choice stays session-local */
      }
    },

    toggleTrackSolo(trackId) {
      patchProject(
        (project) => ({
          ...project,
          tracks: project.tracks.map((track) =>
            track.id === trackId ? { ...track, solo: !track.solo } : track,
          ),
        }),
        { label: 'solo' },
      );
    },

    patchTrackAudio(trackId, patch, history) {
      patchProject(
        (project) => ({
          ...project,
          tracks: project.tracks.map((track) =>
            track.id === trackId
              ? { ...track, audio: { ...trackAudioOf(track), ...patch } }
              : track,
          ),
        }),
        history ?? { label: `audio:${trackId}`, mode: 'coalesce' },
      );
    },

    toggleGraphChannel(channel) {
      set((state) => ({
        hiddenGraphChannels: state.hiddenGraphChannels.includes(channel)
          ? state.hiddenGraphChannels.filter((item) => item !== channel)
          : [...state.hiddenGraphChannels, channel],
      }));
    },

    setKeyframeValue(refs, value) {
      if (refs.length === 0) return;
      patchProject(
        (project) => ({
          ...project,
          clips: project.clips.map((clip) => {
            const mine = refs.filter((ref) => ref.clipId === clip.id);
            if (mine.length === 0 || !clip.animation) return clip;

            let next = clip;
            for (const channel of new Set(mine.map((ref) => ref.channel))) {
              const targets = new Set(
                mine.filter((ref) => ref.channel === channel).map((ref) => ref.id),
              );
              const updated = (next.animation?.[channel] ?? []).map((keyframe) =>
                targets.has(keyframe.id) ? { ...keyframe, value } : keyframe,
              );
              next = withChannel(next, channel, updated);
            }
            return next;
          }),
        }),
        { label: 'valeur d’image clé', mode: 'coalesce' },
      );
    },

    keyAllChannels(clipId) {
      const state = get();
      const targetId = clipId ?? state.selectedClipId ?? state.expandedClipId;
      const clip = state.project?.clips.find((item) => item.id === targetId);
      if (!clip) {
        state.notify('Sélectionnez un clip');
        return;
      }

      const channels = Object.keys(clip.animation ?? {}).filter(
        (channel) => (clip.animation?.[channel]?.length ?? 0) > 0,
      );
      if (channels.length === 0) {
        state.notify('Aucune propriété animée sur ce clip — activez un losange d’abord');
        return;
      }

      for (const channel of channels) state.addKeyframeAt(clip.id, channel);
      state.notify(
        `${channels.length} image${channels.length > 1 ? 's clés posées' : ' clé posée'}`,
        'success',
      );
    },

    setKeyframeEasing(refs, easing) {
      if (refs.length === 0) return;
      patchProject(
        (project) => ({
          ...project,
          clips: project.clips.map((clip) => {
            const mine = refs.filter((ref) => ref.clipId === clip.id);
            if (mine.length === 0 || !clip.animation) return clip;

            let next = clip;
            for (const channel of new Set(mine.map((ref) => ref.channel))) {
              const targets = new Set(
                mine.filter((ref) => ref.channel === channel).map((ref) => ref.id),
              );
              const updated = (next.animation?.[channel] ?? []).map((keyframe) =>
                targets.has(keyframe.id) ? { ...keyframe, easing: { ...easing } } : keyframe,
              );
              next = withChannel(next, channel, updated);
            }
            return next;
          }),
        }),
        { label: 'courbe de vitesse', mode: 'coalesce' },
      );
    },

    selectKeyframes(refs, additive = false) {
      set((prev) => {
        if (!additive) return { selectedKeyframes: refs };
        const merged = [...prev.selectedKeyframes];
        for (const ref of refs) {
          const at = merged.findIndex((item) => item.id === ref.id);
          if (at >= 0) merged.splice(at, 1);
          else merged.push(ref);
        }
        return { selectedKeyframes: merged };
      });
    },

    copyKeyframes() {
      const { project, selectedKeyframes } = get();
      if (!project || selectedKeyframes.length === 0) return;

      const buckets = new Map<string, Keyframe[]>();
      for (const ref of selectedKeyframes) {
        const clip = project.clips.find((item) => item.id === ref.clipId);
        const keyframe = clip?.animation?.[ref.channel]?.find((item) => item.id === ref.id);
        if (!keyframe) continue;
        const bucket = buckets.get(ref.channel);
        if (bucket) bucket.push(keyframe);
        else buckets.set(ref.channel, [keyframe]);
      }
      if (buckets.size === 0) return;

      // Times are stored relative to the earliest key, so a paste lands where
      // the playhead is rather than where the copy came from.
      const earliest = Math.min(
        ...[...buckets.values()].flat().map((keyframe) => keyframe.time),
      );
      set({
        keyframeClipboard: [...buckets.entries()].map(([channel, keyframes]) => ({
          channel,
          keyframes: keyframes.map((keyframe) => ({
            ...keyframe,
            time: keyframe.time - earliest,
          })),
        })),
      });
      get().notify(`${selectedKeyframes.length} image${selectedKeyframes.length > 1 ? 's clés copiées' : ' clé copiée'}`);
    },

    pasteKeyframes(clipId) {
      const state = get();
      const project = state.project;
      const clipboard = state.keyframeClipboard;
      const targetId = clipId ?? state.expandedClipId ?? state.selectedClipId;
      const clip = project?.clips.find((item) => item.id === targetId);
      if (!project || !clipboard || !clip) return;

      const fps = project.settings.fps;
      const anchor = clampLocalTime(clip, state.playhead - clip.start, fps);
      const created: KeyframeRef[] = [];

      patchProject(
        (current) => ({
          ...current,
          clips: current.clips.map((item) => {
            if (item.id !== clip.id) return item;
            let next = item;
            for (const entry of clipboard) {
              const existing = next.animation?.[entry.channel] ?? [];
              const added = entry.keyframes.map((keyframe) => {
                const copy: Keyframe = {
                  ...keyframe,
                  id: uid('kf'),
                  time: clampLocalTime(item, anchor + keyframe.time, fps),
                };
                created.push({ clipId: item.id, channel: entry.channel, id: copy.id });
                return copy;
              });
              next = withChannel(next, entry.channel, [...existing, ...added]);
            }
            return next;
          }),
        }),
        { label: 'collage d’images clés' },
      );

      set({ selectedKeyframes: created, expandedClipId: clip.id });
      get().notify(`${created.length} image${created.length > 1 ? 's clés collées' : ' clé collée'}`, 'success');
    },

    setDefaultEasing(easing) {
      set({ defaultEasing: easing });
      try {
        localStorage.setItem(DEFAULT_EASING_KEY, JSON.stringify(easing));
      } catch {
        /* storage unavailable — the choice simply stays session-local */
      }
    },

    toggleClipExpansion(clipId) {
      set((prev) => ({
        expandedClipId: prev.expandedClipId === clipId ? null : clipId,
        selectedClipId: clipId,
        selectedTransitionId: null,
      }));
    },

    addTextClip(options = {}) {
      const project = get().project;
      if (!project) return null;

      const { fps } = project.settings;
      const duration = snapToFrame(DEFAULT_TEXT_DURATION, fps);
      const start = snapToFrame(Math.max(0, options.at ?? get().playhead), fps);
      // A title lands on the playhead, on whichever layer is free above.
      const { trackId, created } = placeOnFreeLayer(
        project,
        'video',
        start,
        duration,
        options.trackId,
      );

      const clip: Clip = {
        id: uid('cl'),
        kind: 'text',
        assetId: null,
        trackId,
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
        label: 'Texte',
        effects: [],
        text: defaultTextLayer(),
      };

      patchProject(
        (current) => ({
          ...current,
          tracks: withTrack(current.tracks, created),
          clips: [...current.clips, clip],
        }),
        { label: 'ajout de texte' },
      );
      set({ selectedClipId: clip.id, selectedTransitionId: null });
      if (created) get().notify(`Piste ${created.name} créée pour ce texte`);
      return clip.id;
    },

    addBackgroundClip(kind = 'aurora', options = {}) {
      const project = get().project;
      if (!project) return null;

      // The placement rule lives in `lib/backgroundLayer` so the assistant
      // drops a background exactly where this button does.
      const placed = placeBackground(project, kind, {
        at: options.at ?? get().playhead,
        ...(options.duration !== undefined ? { duration: options.duration } : {}),
      });

      patchProject(() => placed.project, { label: 'ajout de fond' });
      get().selectClip(placed.clip.id);
      return placed.clip.id;
    },

    bannerPickerOpen: false,
    cropMode: false,

    openBannerPicker(open) {
      set({ bannerPickerOpen: open });
    },

    addBannerClip(preset, content = {}, options = {}) {
      const project = get().project;
      if (!project) return null;

      const placed = placePreset(project, preset, content, {
        at: options.at ?? get().playhead,
        ...(options.duration !== undefined ? { duration: options.duration } : {}),
      });

      patchProject(() => placed.project, { label: 'ajout d’un habillage' });
      get().selectClip(placed.clip.id);

      // The slot logic may have pushed the banner past a busy row rather than
      // dropping it under the playhead; saying so beats leaving someone
      // hunting for a banner that is not where they clicked.
      if (Math.abs(placed.clip.start - (options.at ?? get().playhead)) > 1e-3) {
        get().notify('La piste Habillages était occupée — l’habillage a été placé à la suite.');
      }
      return placed.clip.id;
    },

    updateBanner(clipId, patch) {
      patchProject(
        (project) => ({
          ...project,
          clips: project.clips.map((clip) =>
            clip.id === clipId && clip.banner
              ? { ...clip, banner: { ...clip.banner, ...patch } }
              : clip,
          ),
        }),
        // Typing a title or dragging a colour is continuous; one step per burst.
        { label: `habillage:${clipId}`, mode: 'coalesce' },
      );
    },

    setBannerPreset(clipId, preset) {
      patchProject(
        (project) => ({
          ...project,
          clips: project.clips.map((clip) =>
            clip.id === clipId && clip.banner
              ? { ...clip, banner: redress(clip.banner, preset) }
              : clip,
          ),
        }),
        // A whole change of template, unlike a nudged colour: its own step.
        { label: 'changement d’habillage' },
      );
    },

    restageBanner(clipId) {
      const project = get().project;
      const clip = project?.clips.find((item) => item.id === clipId);
      if (!project || !clip?.banner) return;

      const metrics = measureBanner(clip.banner, project.settings);
      const animation = bannerAnimation(clip, clip.banner, metrics.width, project.settings.fps);

      patchProject(
        (current) => ({
          ...current,
          clips: current.clips.map((item) => {
            if (item.id !== clipId) return item;
            // An entrance of zero means "no animation", and the map is dropped
            // rather than left behind empty — the rule the store applies
            // everywhere else a channel is cleared.
            if (!animation) {
              const { animation: _dropped, ...rest } = item;
              return rest as typeof item;
            }
            return { ...item, animation };
          }),
        }),
        { label: 'arrivée de l’habillage' },
      );
    },

    updateBackground(clipId, patch) {
      patchProject(
        (project) => ({
          ...project,
          clips: project.clips.map((clip) =>
            clip.id === clipId && clip.background
              ? { ...clip, background: { ...clip.background, ...patch } }
              : clip,
          ),
        }),
        // Dragging a colour or a speed is continuous; one step per burst.
        { label: `fond:${clipId}`, mode: 'coalesce' },
      );
    },

    splitTextIntoWords(clipIds, options) {
      const project = get().project;
      if (!project || clipIds.length === 0) return;

      const outcome = splitTextClips(project, clipIds, { ...DEFAULT_SPLIT_OPTIONS, ...options });
      if (outcome.pieces === 0) {
        get().notify(
          outcome.skipped[0]?.reason
            ? `Découpage impossible — ${outcome.skipped[0].reason}`
            : 'Sélectionnez un calque de texte à découper',
          'error',
        );
        return;
      }

      get().transact('découpage mot à mot', () => outcome.project);
      const skipped = outcome.skipped.length;
      get().notify(
        skipped > 0
          ? `${outcome.pieces} mots posés · ${skipped} calque${skipped > 1 ? 's ignorés' : ' ignoré'}`
          : `${outcome.pieces} mots posés`,
        'success',
      );
    },

    setEditingText(clipId) {
      set({
        editingTextClipId: clipId,
        // Editing implies selecting: the inspector should follow the caret.
        ...(clipId ? { selectedClipId: clipId, selectedTransitionId: null } : {}),
      });
    },

    updateText(clipId, patch) {
      patchProject(
        (project) => ({
          ...project,
          clips: project.clips.map((clip) =>
            clip.id === clipId && clip.text
              ? { ...clip, text: { ...clip.text, ...patch } }
              : clip,
          ),
        }),
        // Typing and dragging sliders are continuous; one step per burst.
        { label: `texte:${clipId}`, mode: 'coalesce' },
      );
    },

    moveClip(clipId, next) {
      const project = get().project;
      if (!project) return;
      const clip = project.clips.find((item) => item.id === clipId);
      if (!clip) return;

      const targetTrackId = next.trackId ?? clip.trackId;
      const track = project.tracks.find((item) => item.id === targetTrackId);
      if (!track || track.locked) return;

      const asset = project.assets.find((item) => item.id === clip.assetId);
      const assetKind: TrackKind = asset?.kind === 'audio' ? 'audio' : 'video';
      // Material stays on a matching track kind so the compositor order and the
      // audio mixer keep a one-to-one mapping with what the user sees.
      const trackId = track.kind === assetKind ? track.id : clip.trackId;

      const siblings = project.clips.filter((item) => item.trackId === trackId && item.id !== clipId);
      const start = snapToFrame(
        resolveStart(siblings, next.start, clip.duration),
        project.settings.fps,
      );

      patchProject(
        (current) => ({
          ...current,
          clips: current.clips.map((item) =>
            item.id === clipId ? { ...item, start, trackId } : item,
          ),
        }),
        { label: `déplacement:${clipId}`, mode: 'coalesce' },
      );
    },

    trimClip(clipId, edge, time) {
      const project = get().project;
      if (!project) return;
      const clip = project.clips.find((item) => item.id === clipId);
      if (!clip) return;
      const asset = project.assets.find((item) => item.id === clip.assetId);
      const sourceDuration =
        asset && asset.kind !== 'image' && asset.duration > 0 ? asset.duration : Infinity;
      const { fps } = project.settings;
      const siblings = project.clips.filter(
        (item) => item.trackId === clip.trackId && item.id !== clipId,
      );

      let start = clip.start;
      let duration = clip.duration;
      let offset = clip.offset;

      if (edge === 'start') {
        // Dragging the head moves the in-point; the source frame under the cut
        // stays anchored, exactly like a ripple-free trim in an NLE.
        const leftBound = siblings
          .filter((item) => clipEnd(item) <= clip.start + 1e-6)
          .reduce((max, item) => Math.max(max, clipEnd(item)), 0);
        const minStart = Math.max(leftBound, clip.start - clip.offset);
        const maxStart = clipEnd(clip) - MIN_CLIP_DURATION;
        const nextStart = snapToFrame(clamp(time, minStart, maxStart), fps);
        const delta = nextStart - clip.start;
        start = nextStart;
        offset = Math.max(0, clip.offset + delta);
        duration = clip.duration - delta;
      } else {
        const rightBound = siblings
          .filter((item) => item.start >= clipEnd(clip) - 1e-6)
          .reduce((min, item) => Math.min(min, item.start), Infinity);
        const sourceLimit =
          sourceDuration === Infinity ? Infinity : clip.start + (sourceDuration - clip.offset);
        const maxEnd = Math.min(rightBound, sourceLimit);
        const nextEnd = snapToFrame(
          clamp(time, clip.start + MIN_CLIP_DURATION, maxEnd === Infinity ? time : maxEnd),
          fps,
        );
        duration = nextEnd - clip.start;
      }

      if (duration < MIN_CLIP_DURATION) return;

      patchProject(
        (current) => ({
          ...current,
          clips: current.clips.map((item) =>
            item.id === clipId ? { ...item, start, duration, offset } : item,
          ),
        }),
        { label: `rognage:${clipId}:${edge}`, mode: 'coalesce' },
      );
    },

    updateClip(clipId, patch, history) {
      patchProject(
        (project) => ({
          ...project,
          clips: project.clips.map((clip) => (clip.id === clipId ? { ...clip, ...patch } : clip)),
        }),
        history ?? { label: 'propriétés du clip' },
      );
    },

    removeClip(clipId) {
      patchProject((project) => ({
        ...project,
        clips: project.clips.filter((clip) => clip.id !== clipId),
      }));
      set((state) => {
        const remaining = state.selectedClipIds.filter((id) => id !== clipId);
        return {
          selectedClipIds: remaining,
          selectedClipId:
            state.selectedClipId === clipId
              ? remaining[remaining.length - 1] ?? null
              : state.selectedClipId,
          editingTextClipId:
            state.editingTextClipId === clipId ? null : state.editingTextClipId,
        };
      });
    },

    /**
     * Deletes the whole selection as one edit.
     *
     * Looping over `removeClip` would work, but it would also push one history
     * entry per clip — so undoing a five-clip delete would take five presses.
     */
    removeSelectedClips() {
      const state = get();
      const ids = new Set(state.selectedClipIds);
      if (ids.size === 0) return;

      const locked = new Set(
        state.project?.tracks.filter((track) => track.locked).map((track) => track.id) ?? [],
      );
      const removable = (state.project?.clips ?? []).filter(
        (clip) => ids.has(clip.id) && !locked.has(clip.trackId),
      );
      if (removable.length === 0) {
        get().notify('Les clips sélectionnés sont sur une piste verrouillée', 'error');
        return;
      }

      const doomed = new Set(removable.map((clip) => clip.id));
      patchProject(
        (project) => ({ ...project, clips: project.clips.filter((clip) => !doomed.has(clip.id)) }),
        { label: removable.length > 1 ? 'suppression de clips' : 'suppression' },
      );
      set((current) => ({
        selectedClipIds: current.selectedClipIds.filter((id) => !doomed.has(id)),
        selectedClipId: doomed.has(current.selectedClipId ?? '') ? null : current.selectedClipId,
        editingTextClipId: doomed.has(current.editingTextClipId ?? '')
          ? null
          : current.editingTextClipId,
      }));
      if (removable.length > 1) {
        get().notify(`${removable.length} clips supprimés`, 'success');
      }
    },

    splitAtPlayhead() {
      const { project, playhead } = get();
      if (!project) return;
      const { fps } = project.settings;
      const time = snapToFrame(playhead, fps);

      const cuttable = (clip: Clip) => {
        const track = project.tracks.find((item) => item.id === clip.trackId);
        return (
          !track?.locked &&
          time > clip.start + MIN_CLIP_DURATION &&
          time < clipEnd(clip) - MIN_CLIP_DURATION
        );
      };

      // A cut belongs to the clips you are working on. Slicing every layer at
      // once is almost never what is meant, and it is tedious to undo one by
      // one — so the selection decides, and only falls back to the whole stack
      // when nothing is selected. With several clips selected, they are all cut
      // in the same step.
      const chosen = new Set(get().selectedClipIds);
      const selected = project.clips.filter((clip) => chosen.has(clip.id));
      const targets =
        selected.length > 0 ? selected.filter(cuttable) : project.clips.filter(cuttable);

      if (targets.length === 0) {
        get().notify(
          selected.length > 0
            ? 'Le curseur n’est sur aucun des clips sélectionnés'
            : 'Placez le curseur sur un clip pour le couper',
        );
        return;
      }

      const additions: Clip[] = [];
      const updated = project.clips.map((clip) => {
        if (!targets.some((target) => target.id === clip.id)) return clip;
        const head = time - clip.start;
        additions.push({
          ...clip,
          id: uid('cl'),
          start: time,
          duration: clip.duration - head,
          offset: clip.offset + head,
          effects: cloneEffects(clip.effects),
          animation: cloneAnimation(clip.animation),
        });
        return { ...clip, duration: head };
      });

      patchProject((current) => ({ ...current, clips: [...updated, ...additions] }));
      get().notify(`${targets.length} clip${targets.length > 1 ? 's coupés' : ' coupé'}`, 'success');
    },

    duplicateClip(clipId) {
      get().duplicateClips([clipId]);
    },

    /** Each clip is copied just after itself, all in one history step. */
    duplicateClips(clipIds) {
      const project = get().project;
      if (!project) return;
      const sources = project.clips.filter((clip) => clipIds.includes(clip.id));
      if (sources.length === 0) return;

      // Siblings accumulate as we go: two copies landing on the same track must
      // see each other, or the second would be placed on top of the first.
      const placed: Clip[] = [];
      for (const clip of sources) {
        const siblings = [
          ...project.clips.filter((item) => item.trackId === clip.trackId),
          ...placed.filter((item) => item.trackId === clip.trackId),
        ];
        placed.push({
          ...clip,
          id: uid('cl'),
          start: resolveStart(siblings, clipEnd(clip), clip.duration),
          effects: cloneEffects(clip.effects),
          animation: cloneAnimation(clip.animation),
          ...(clip.text ? { text: { ...clip.text } } : {}),
        });
      }

      patchProject(
        (current) => ({ ...current, clips: [...current.clips, ...placed] }),
        { label: placed.length > 1 ? 'duplication de clips' : 'duplication' },
      );
      get().selectClips(placed.map((clip) => clip.id));
    },

    /**
     * Copies clips whole — effects, curves, text, source in-point and all.
     *
     * Positions are stored relative to the earliest clip in the set, so a paste
     * reproduces the *shape* of what was copied wherever the playhead is,
     * rather than putting everything back where it came from.
     */
    copyClips(clipIds) {
      const state = get();
      const ids = clipIds ?? state.selectedClipIds;
      const clips = (state.project?.clips ?? []).filter((clip) => ids.includes(clip.id));
      if (clips.length === 0) {
        state.notify('Sélectionnez un clip à copier');
        return;
      }

      const earliest = Math.min(...clips.map((clip) => clip.start));
      set({
        clipClipboard: clips
          .map((clip) => ({
            ...clip,
            start: clip.start - earliest,
            effects: clip.effects.map((effect) => ({ ...effect, params: { ...effect.params } })),
            ...(clip.text ? { text: { ...clip.text } } : {}),
          }))
          .sort((a, b) => a.start - b.start),
      });
      state.notify(`${clips.length} clip${clips.length > 1 ? 's copiés' : ' copié'}`);
    },

    pasteClips(at) {
      const state = get();
      const project = state.project;
      const clipboard = state.clipClipboard;
      if (!project || !clipboard || clipboard.length === 0) return;

      const { fps } = project.settings;
      const anchor = snapToFrame(Math.max(0, at ?? state.playhead), fps);

      // The document is built up as we go — `placeOnFreeLayer` has to see the
      // clips and layers the earlier pastes in this batch already claimed.
      let working = project;
      const created: Clip[] = [];

      for (const source of clipboard) {
        const asset = project.assets.find((item) => item.id === source.assetId);
        const kind: TrackKind = asset?.kind === 'audio' ? 'audio' : 'video';
        const start = snapToFrame(anchor + source.start, fps);
        // The original layer is preferred, so a paste lands on the same row
        // when there is room and stacks upwards only when there is not.
        const placement = placeOnFreeLayer(working, kind, start, source.duration, source.trackId);

        const clip: Clip = {
          ...source,
          id: uid('cl'),
          trackId: placement.trackId,
          start,
          effects: cloneEffects(source.effects),
          animation: cloneAnimation(source.animation),
          ...(source.text ? { text: { ...source.text } } : {}),
        };
        created.push(clip);
        working = {
          ...working,
          tracks: withTrack(working.tracks, placement.created),
          clips: [...working.clips, clip],
        };
      }

      const snapshot = working;
      patchProject(() => snapshot, {
        label: created.length > 1 ? 'collage de clips' : 'collage',
      });
      get().selectClips(created.map((clip) => clip.id));
      get().notify(`${created.length} clip${created.length > 1 ? 's collés' : ' collé'}`, 'success');
    },

    /* ---------------- Effects ---------------- */

    addEffect(clipId, kind) {
      const effect: Effect = {
        id: uid('fx'),
        kind,
        enabled: true,
        params: initialParams(kind),
      };
      patchProject((project) => ({
        ...project,
        clips: project.clips.map((clip) =>
          clip.id === clipId ? { ...clip, effects: [...clip.effects, effect] } : clip,
        ),
      }));
      set({ selectedClipId: clipId, selectedTransitionId: null, leftTab: 'effects' });
    },

    setEffectParam(clipId, effectId, key, value) {
      patchProject(
        (project) => ({
        ...project,
        clips: project.clips.map((clip) =>
          clip.id !== clipId
            ? clip
            : {
                ...clip,
                effects: clip.effects.map((effect) =>
                  effect.id === effectId
                    ? { ...effect, params: { ...effect.params, [key]: value } }
                    : effect,
                ),
              },
          ),
        }),
        { label: `effet:${effectId}:${key}`, mode: 'coalesce' },
      );
    },

    toggleEffect(clipId, effectId) {
      patchProject((project) => ({
        ...project,
        clips: project.clips.map((clip) =>
          clip.id !== clipId
            ? clip
            : {
                ...clip,
                effects: clip.effects.map((effect) =>
                  effect.id === effectId ? { ...effect, enabled: !effect.enabled } : effect,
                ),
              },
        ),
      }));
    },

    resetEffect(clipId, effectId) {
      patchProject((project) => ({
        ...project,
        clips: project.clips.map((clip) =>
          clip.id !== clipId
            ? clip
            : {
                ...clip,
                effects: clip.effects.map((effect) =>
                  effect.id === effectId
                    ? { ...effect, params: neutralParams(effect.kind) }
                    : effect,
                ),
              },
        ),
      }));
    },

    /** Order is the filter-chain order, so moving an effect changes the render. */
    moveEffect(clipId, effectId, direction) {
      patchProject((project) => ({
        ...project,
        clips: project.clips.map((clip) => {
          if (clip.id !== clipId) return clip;
          const index = clip.effects.findIndex((effect) => effect.id === effectId);
          const target = index + direction;
          if (index === -1 || target < 0 || target >= clip.effects.length) return clip;
          const effects = [...clip.effects];
          const [moved] = effects.splice(index, 1);
          effects.splice(target, 0, moved as Effect);
          return { ...clip, effects };
        }),
      }));
    },

    removeEffect(clipId, effectId) {
      patchProject((project) => ({
        ...project,
        clips: project.clips.map((clip) =>
          clip.id === clipId
            ? { ...clip, effects: clip.effects.filter((effect) => effect.id !== effectId) }
            : clip,
        ),
      }));
    },

    clearEffects(clipId) {
      patchProject((project) => ({
        ...project,
        clips: project.clips.map((clip) => (clip.id === clipId ? { ...clip, effects: [] } : clip)),
      }));
    },

    /* ---------------- Transitions ---------------- */

    addTransition(anchor, kind) {
      const project = get().project;
      if (!project) return;

      if (transitionDescriptor(kind).requiresJunction && !isJunction(anchor)) {
        get().notify('Un fondu enchaîné demande un plan de chaque côté', 'error');
        return;
      }

      // One transition per anchor: dropping again replaces what is there.
      const existing = project.transitions.find(
        (item) =>
          item.trackId === anchor.trackId &&
          item.fromClipId === anchor.fromClipId &&
          item.toClipId === anchor.toClipId,
      );

      const transition: Transition = {
        id: existing?.id ?? uid('tx'),
        kind,
        trackId: anchor.trackId,
        fromClipId: anchor.fromClipId,
        toClipId: anchor.toClipId,
        duration: clampTransitionDuration(
          anchor,
          existing?.duration ?? DEFAULT_TRANSITION_DURATION,
        ),
      };

      patchProject((current) => ({
        ...current,
        transitions: existing
          ? current.transitions.map((item) => (item.id === existing.id ? transition : item))
          : [...current.transitions, transition],
      }));
      set({ selectedTransitionId: transition.id, selectedClipId: null });
      get().notify(`${transitionDescriptor(kind).label} appliqué`, 'success');
    },

    setTransitionKind(transitionId, kind) {
      const project = get().project;
      if (!project) return;
      const transition = project.transitions.find((item) => item.id === transitionId);
      if (!transition) return;

      const junction = transition.fromClipId !== null && transition.toClipId !== null;
      if (transitionDescriptor(kind).requiresJunction && !junction) {
        get().notify('Un fondu enchaîné demande un plan de chaque côté', 'error');
        return;
      }

      patchProject((current) => ({
        ...current,
        transitions: current.transitions.map((item) =>
          item.id === transitionId ? { ...item, kind } : item,
        ),
      }));
    },

    setTransitionDuration(transitionId, duration) {
      const project = get().project;
      if (!project) return;
      const transition = project.transitions.find((item) => item.id === transitionId);
      if (!transition) return;

      const anchor = transitionAnchors(project).find(
        (item) =>
          item.trackId === transition.trackId &&
          item.fromClipId === transition.fromClipId &&
          item.toClipId === transition.toClipId,
      );
      const clamped = anchor
        ? clampTransitionDuration(anchor, duration)
        : Math.max(MIN_TRANSITION_DURATION, duration);

      patchProject(
        (current) => ({
          ...current,
          transitions: current.transitions.map((item) =>
            item.id === transitionId ? { ...item, duration: clamped } : item,
          ),
        }),
        { label: `transition:${transitionId}`, mode: 'coalesce' },
      );
    },

    removeTransition(transitionId) {
      patchProject((project) => ({
        ...project,
        transitions: project.transitions.filter((item) => item.id !== transitionId),
      }));
      set((state) => ({
        selectedTransitionId:
          state.selectedTransitionId === transitionId ? null : state.selectedTransitionId,
      }));
    },

    addTrack(kind) {
      patchProject(
        (project) => {
          const count = project.tracks.filter((track) => track.kind === kind).length + 1;
          const track: Track = {
            id: uid('tr'),
            kind,
            name: `${kind === 'video' ? 'V' : 'A'}${count}`,
            height: kind === 'video' ? DEFAULT_TRACK_HEIGHT : 54,
            muted: false,
            solo: false,
            locked: false,
            hidden: false,
            ...(kind === 'audio' ? { audio: defaultTrackAudio() } : {}),
          };

          // List order *is* the compositing order, top-down. A new video track
          // goes on top (V2 above V1, as every NLE numbers them); a new audio
          // track goes to the bottom, keeping video above audio throughout.
          const tracks =
            kind === 'video' ? [track, ...project.tracks] : [...project.tracks, track];
          return { ...project, tracks };
        },
        { label: 'ajout de piste' },
      );
    },

    moveTrack(trackId, targetIndex) {
      patchProject(
        (project) => {
          const from = project.tracks.findIndex((track) => track.id === trackId);
          const moving = project.tracks[from];
          if (from === -1 || !moving) return project;

          // The move is bounded to the block of tracks of the same kind:
          // interleaving picture and sound rows would mean nothing.
          const indices = project.tracks
            .map((track, index) => ({ track, index }))
            .filter((entry) => entry.track.kind === moving.kind)
            .map((entry) => entry.index);
          const lower = Math.min(...indices);
          const upper = Math.max(...indices);
          const to = Math.max(lower, Math.min(targetIndex, upper));
          if (to === from) return project;

          const tracks = [...project.tracks];
          tracks.splice(from, 1);
          tracks.splice(to, 0, moving);
          return { ...project, tracks };
        },
        { label: 'ordre des pistes' },
      );
    },

    removeTrack(trackId) {
      const project = get().project;
      if (!project) return;
      if (project.tracks.length <= 1) {
        get().notify('Au moins une piste est requise', 'error');
        return;
      }
      patchProject((current) => ({
        ...current,
        tracks: current.tracks.filter((track) => track.id !== trackId),
        clips: current.clips.filter((clip) => clip.trackId !== trackId),
      }));
    },

    patchTrack(trackId, patch, history) {
      patchProject(
        (project) => ({
          ...project,
          tracks: project.tracks.map((track) =>
            track.id === trackId ? { ...track, ...patch } : track,
          ),
        }),
        history ?? { label: 'réglage de piste' },
      );
    },

    selectClip(clipId, additive = false) {
      if (!clipId) {
        set({ selectedClipId: null, selectedClipIds: [], selectedTransitionId: null });
        return;
      }
      if (!additive) {
        set({ selectedClipId: clipId, selectedClipIds: [clipId], selectedTransitionId: null });
        return;
      }
      set((state) => {
        // Ctrl+click on an already-selected clip removes it, which is the only
        // way to correct a selection without starting it over.
        const next = state.selectedClipIds.includes(clipId)
          ? state.selectedClipIds.filter((id) => id !== clipId)
          : [...state.selectedClipIds, clipId];
        return {
          selectedClipIds: next,
          selectedClipId: next[next.length - 1] ?? null,
          selectedTransitionId: null,
        };
      });
    },

    selectClips(clipIds) {
      set({
        selectedClipIds: clipIds,
        selectedClipId: clipIds[clipIds.length - 1] ?? null,
        selectedTransitionId: null,
      });
    },

    setSpaceHeld(held) {
      // Releasing also clears the pan flag, so the next press starts clean.
      set(held ? { spaceHeld: true } : { spaceHeld: false, spacePanned: false });
    },

    markSpacePan() {
      set({ spacePanned: true });
    },

    selectTransition(transitionId) {
      set({ selectedTransitionId: transitionId, selectedClipId: null });
    },

    setLeftTab(tab) {
      set({ leftTab: tab });
    },

    setRightTab(tab) {
      set({ rightTab: tab });
    },

    addMarker(time, label, color) {
      const project = get().project;
      if (!project) return;

      const at = snapToFrame(clamp(time, 0, Math.max(0, projectDuration(project))), project.settings.fps);
      // A second marker on the same frame is a double press, not two chapters.
      if (markersOf(project).some((marker) => Math.abs(marker.time - at) < 1e-3)) return;

      const named = (label ?? '').trim() || `Repère ${markersOf(project).length + 1}`;
      const marker: Marker = {
        id: uid('mk'),
        time: at,
        label: named,
        color: color ?? DEFAULT_MARKER_COLOR,
      };

      patchProject(
        (current) => ({ ...current, markers: sortMarkers([...markersOf(current), marker]) }),
        { label: 'ajout d’un repère' },
      );
    },

    renameMarker(id, label) {
      const named = label.trim();
      if (named === '') return;
      patchProject(
        (current) => ({
          ...current,
          markers: markersOf(current).map((marker) =>
            marker.id === id ? { ...marker, label: named } : marker,
          ),
        }),
        // Coalesced: typing a name is one edit, not one per keystroke.
        { label: 'renommage d’un repère', mode: 'coalesce' },
      );
    },

    moveMarker(id, time) {
      const project = get().project;
      if (!project) return;
      const at = snapToFrame(clamp(time, 0, Math.max(0, projectDuration(project))), project.settings.fps);

      patchProject(
        (current) => ({
          ...current,
          markers: sortMarkers(
            markersOf(current).map((marker) =>
              marker.id === id ? { ...marker, time: at } : marker,
            ),
          ),
        }),
        { label: 'déplacement d’un repère', mode: 'coalesce' },
      );
    },

    removeMarker(id) {
      patchProject(
        (current) => ({ ...current, markers: markersOf(current).filter((marker) => marker.id !== id) }),
        { label: 'suppression d’un repère' },
      );
    },

    clearMarkers() {
      patchProject((current) => ({ ...current, markers: [] }), {
        label: 'suppression des repères',
      });
    },

    transact(label, mutate) {
      patchProject(mutate, { label, mode: 'push' });
      // A batch rewrite can delete the clip the inspector is showing — a smart
      // cut closing over it, a plan removing it. Undo/redo already sweeps a
      // stale selection; a whole-document write has to do the same.
      const next = get().project;
      if (next) reconcileSelection(next);
    },

    openRelink() {
      set({ relinkOpen: true });
    },

    closeRelink() {
      set({ relinkOpen: false });
    },

    async retryRelink(hints = []) {
      const project = get().project;
      if (!project) return;
      set({ busy: true });
      try {
        const outcome = await relinkAssets(project.assets, hints);
        set((state) => ({
          project: state.project ? { ...state.project, assets: outcome.assets } : null,
          missingAssetIds: outcome.missingIds,
          relinkOpen: outcome.missingIds.length > 0,
        }));

        if (outcome.relocated > 0) {
          get().notify(
            `${outcome.relocated} média${outcome.relocated > 1 ? 's reliés' : ' relié'}`,
            'success',
          );
          await get().saveProject();
          void Promise.all(
            outcome.assets.filter((asset) => !asset.missing).map(enrichAsset),
          );
        } else if (hints.length > 0) {
          get().notify('Aucun fichier correspondant dans ce dossier', 'error');
        }
      } finally {
        set({ busy: false });
      }
    },

    async relinkFromPath(assetId, filePath) {
      const project = get().project;
      if (!project) return;

      // Adopt the chosen file for this asset, then let its folder resolve the
      // rest of the batch — media that moved together usually moved together.
      const src = await pathToSrc(filePath);
      set({
        project: {
          ...project,
          assets: project.assets.map((asset) =>
            asset.id === assetId ? { ...asset, path: filePath, src, missing: false } : asset,
          ),
        },
      });

      const folder = await parentDirectory(filePath);
      await get().retryRelink(folder ? [folder] : []);
    },

    relinkFromFiles(files) {
      const project = get().project;
      if (!project) return;

      const byName = new Map(files.map((file) => [file.name.toLowerCase(), file]));
      let matched = 0;

      const assets = project.assets.map((asset) => {
        if (!asset.missing) return asset;
        const file = byName.get(asset.name.toLowerCase());
        if (!file) return asset;
        matched += 1;
        return { ...asset, src: URL.createObjectURL(file), size: file.size, missing: false };
      });

      const missingIds = assets.filter((asset) => asset.missing).map((asset) => asset.id);
      set({
        project: { ...project, assets },
        missingAssetIds: missingIds,
        relinkOpen: missingIds.length > 0,
      });

      if (matched > 0) {
        get().notify(`${matched} média${matched > 1 ? 's reliés' : ' relié'}`, 'success');
        void Promise.all(
          assets.filter((asset) => !asset.missing).map(enrichAsset),
        );
      } else {
        get().notify('Aucun fichier ne correspond aux médias manquants', 'error');
      }
    },

    selectAsset(assetId) {
      set({ selectedAssetId: assetId });
    },

    setPlayhead(time) {
      const duration = projectDuration(get().project);
      set({ playhead: clamp(time, 0, Math.max(duration, 0)) });
    },

    nudgePlayhead(frames) {
      const project = get().project;
      const fps = project?.settings.fps ?? 30;
      get().setPlayhead(snapToFrame(get().playhead + frames / fps, fps));
    },

    play() {
      const duration = projectDuration(get().project);
      if (duration <= 0) {
        get().notify('Ajoutez un clip à la timeline pour lancer la lecture');
        return;
      }
      if (get().playhead >= duration - 1e-3) set({ playhead: 0 });
      set({ isPlaying: true });
    },

    pause() {
      set({ isPlaying: false });
    },

    togglePlay() {
      if (get().isPlaying) get().pause();
      else get().play();
    },

    setZoom(pixelsPerSecond) {
      set({ pixelsPerSecond: clamp(pixelsPerSecond, 6, 480) });
    },

    zoomBy(factor) {
      const anchored = get().zoomAnchor;
      if (anchored) anchored(factor);
      else get().setZoom(get().pixelsPerSecond * factor);
    },

    registerZoomAnchor(handler) {
      set({ zoomAnchor: handler });
    },

    setMasterVolume(volume) {
      set({ masterVolume: clamp(volume, 0, 1), masterMuted: volume === 0 });
    },

    toggleMasterMute() {
      set((state) => ({ masterMuted: !state.masterMuted }));
    },

    toggleSnap() {
      set((state) => ({ snapEnabled: !state.snapEnabled }));
    },

    toggleLoop() {
      set((state) => ({ loopPlayback: !state.loopPlayback }));
    },

    setPreviewQuality(quality) {
      set({ previewQuality: quality });
    },
  };
});
