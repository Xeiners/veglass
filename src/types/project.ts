import type { Marker } from './marker';
import type { ProgressBar } from './progress';
import type { MediaAsset, SerializedAsset } from './media';
import type { Clip, Track } from './timeline';
import type { Transition } from './transitions';

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  settings: ProjectSettings;
  assets: MediaAsset[];
  tracks: Track[];
  clips: Clip[];
  transitions: Transition[];
  /**
   * Chapter flags on the ruler. Optional, and read through `markersOf` — see
   * `types/marker`, and the schema note below.
   */
  markers?: Marker[];
  /**
   * The progress bar drawn over the whole composition. Absent means none —
   * see `types/progress` for why it belongs here and not to a clip.
   */
  progress?: ProgressBar;
  /** Reusable instructions for tutorial narration on timeline selections. */
  tutorialContext?: string;
  /** Bumped whenever the on-disk shape changes, so we can migrate. */
  schemaVersion: number;
}

/** What actually lands in the .json file. */
export interface SerializedProject extends Omit<Project, 'assets'> {
  assets: SerializedAsset[];
}

/** Lightweight row for the home dashboard listing. */
export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  settings: ProjectSettings;
  clipCount: number;
  assetCount: number;
  duration: number;
}

/**
 * 1 → 2 added per-clip `effects` and project-level `transitions`.
 * 2 → 3 added clip `kind`, text layers and spatial transforms.
 * 3 → 4 added keyframe channels (`clip.animation`).
 * 4 → 5 added track solo and the per-track audio bus.
 * 5 → 6 added generated background layers (`clip.background`).
 * 6 → 7 added the plate behind a text layer (`clip.text.box`). Optional, and
 *       read through `textBox`, so a version 6 document needs no migration.
 * 7 → 8 added chapter markers (`project.markers`). Same bargain again:
 *       optional, read through `markersOf`, so a version 7 document needs no
 *       migration either — the version moves so a *downgrade* is legible.
 * 8 → 9 added the `banner` clip kind and `clip.banner`. A new *kind* rather
 *       than a new required field, so nothing that already exists changes
 *       shape: a version 8 document simply contains no banners.
 * 9 → 10 added the `cursor` clip kind and the optional `clip.backdrop`. Both
 *       follow the same bargain a fourth time: a new kind nothing older
 *       contains, and an optional field read through `clip.backdrop ?? …`.
 * 10 → 11 added `project.progress`. Optional, absent on everything written
 *       before it, and read through `draws()` — no migration, again.
 * 11 → 12 adds optional `tutorialContext`, empty on older projects.
 */
export const SCHEMA_VERSION = 12;

export interface ResolutionPreset {
  id: string;
  label: string;
  hint: string;
  width: number;
  height: number;
}

export const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { id: 'uhd', label: '4K UHD', hint: '3840 × 2160', width: 3840, height: 2160 },
  { id: 'fhd', label: 'Full HD', hint: '1920 × 1080', width: 1920, height: 1080 },
  { id: 'hd', label: 'HD', hint: '1280 × 720', width: 1280, height: 720 },
  { id: 'vertical', label: 'Vertical', hint: '1080 × 1920', width: 1080, height: 1920 },
  { id: 'square', label: 'Carré', hint: '1080 × 1080', width: 1080, height: 1080 },
];

export const FPS_PRESETS = [23.976, 24, 25, 30, 50, 60] as const;

export const DEFAULT_SETTINGS: ProjectSettings = { width: 1920, height: 1080, fps: 30 };

export function aspectRatioOf(settings: ProjectSettings): number {
  return settings.height === 0 ? 16 / 9 : settings.width / settings.height;
}

export function resolutionLabel(settings: ProjectSettings): string {
  const preset = RESOLUTION_PRESETS.find(
    (p) => p.width === settings.width && p.height === settings.height,
  );
  return preset ? preset.label : `${settings.width} × ${settings.height}`;
}
