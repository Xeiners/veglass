import { isTauri } from './env';
import { bakeLayers } from './bake';
import { serializeAsset } from './media';
import type { Project } from '@/types/project';
import type { Clip } from '@/types/timeline';
import { sampleChannel, type Breakpoint } from '@/types/animation';
import { formatOf, type ExportSettings } from '@/types/export';

/** clip id → channel → flattened curve. */
export type SampledChannels = Record<string, Record<string, Breakpoint[]>>;

/**
 * Flattens every animated channel with the *same* evaluator the preview uses.
 *
 * The engine never sees a bézier: it receives straight breakpoints and turns
 * them into ffmpeg expressions. One evaluator, so the export cannot drift from
 * what was on screen.
 */
export function sampleAnimation(clips: Clip[]): SampledChannels {
  const out: SampledChannels = {};
  for (const clip of clips) {
    if (!clip.animation) continue;
    const channels: Record<string, Breakpoint[]> = {};
    for (const [channel, keyframes] of Object.entries(clip.animation)) {
      if (keyframes.length === 0) continue;
      channels[channel] = sampleChannel(keyframes);
    }
    if (Object.keys(channels).length > 0) out[clip.id] = channels;
  }
  return out;
}

export interface EncoderStatus {
  available: boolean;
  path: string | null;
  version: string | null;
  probeAvailable: boolean;
  /** Whether this platform can fetch a build from inside the app. */
  installable: boolean;
}

export interface InstallProgress {
  /** `download`, `extract`, `verify` or `done`. */
  stage: string;
  received: number;
  /** 0 when the server declines to announce a length. */
  total: number;
  /** 0 → 1 across the whole install, not just the file in flight. */
  ratio: number;
  detail: string;
}

export const FFMPEG_INSTALL_EVENT = 'veglass://ffmpeg-install';

export interface ExportProgress {
  frame: number;
  totalFrames: number;
  stage: string;
  ratio: number;
  /** ffmpeg's throughput in times real-time. */
  speed: number;
}

/**
 * Wall-clock seconds left, or `null` while ffmpeg has yet to settle.
 *
 * The estimate comes from ffmpeg's own reported speed rather than from elapsed
 * time: encoding rate varies wildly between the easy and hard parts of a
 * timeline, and an average over the whole run lags badly behind reality.
 */
export function estimateRemaining(progress: ExportProgress, fps: number): number | null {
  if (progress.speed <= 0.01 || progress.frame <= 0) return null;
  const framesLeft = Math.max(progress.totalFrames - progress.frame, 0);
  return framesLeft / Math.max(fps, 1) / progress.speed;
}

export interface ExportReport {
  output: string;
  /** Size of the finished file, in bytes. */
  bytes: number;
  duration: number;
  frameCount: number;
  segments: number;
  transitions: number;
  warnings: string[];
}

export const EXPORT_PROGRESS_EVENT = 'veglass://export-progress';

/** Characters no filesystem we target will accept in a name. */
const FORBIDDEN = new RegExp('[\\\\/:*?"<>|]', 'g');

const UNAVAILABLE: EncoderStatus = {
  available: false,
  path: null,
  version: null,
  probeAvailable: false,
  installable: false,
};

/** Whether an encoder is installed, and which build answered. */
export async function encoderStatus(): Promise<EncoderStatus> {
  if (!isTauri()) return UNAVAILABLE;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<EncoderStatus>('encoder_status');
  } catch (error) {
    console.error('encoder probe failed', error);
    return UNAVAILABLE;
  }
}

/**
 * Downloads a static ffmpeg build into the app's own directory.
 *
 * Resolves with the status the engine reports *after* the binary has answered
 * `-version`: a download that lands but will not run is a failure, and saying
 * otherwise would only move the disappointment to the first export.
 */
export async function installFfmpeg(): Promise<EncoderStatus> {
  if (!isTauri()) throw new Error('installation disponible seulement dans l’application');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<EncoderStatus>('install_ffmpeg');
}

/**
 * Adopts an ffmpeg the user already has, copying it into the app's own folder.
 *
 * The way out when the download cannot work: a network with no route, a proxy
 * the app cannot see, a resolver that keeps failing. Anyone who can get the
 * file by other means is then never blocked.
 */
export async function adoptFfmpeg(path: string): Promise<EncoderStatus> {
  if (!isTauri()) throw new Error('disponible seulement dans l’application');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<EncoderStatus>('adopt_ffmpeg', { path });
}

/** Subscribes to install progress; resolves with the unsubscribe function. */
export async function onInstallProgress(
  handler: (progress: InstallProgress) => void,
): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen<InstallProgress>(FFMPEG_INSTALL_EVENT, (event) => handler(event.payload));
}

/** Native save dialog, pre-filled with the project name. */
export async function pickExportTarget(
  projectName: string,
  settings: ExportSettings,
): Promise<string | null> {
  if (!isTauri()) return null;
  const { save } = await import('@tauri-apps/plugin-dialog');
  const format = formatOf(settings.format);
  const safe = projectName.replace(FORBIDDEN, '-').trim() || 'export';
  const chosen = await save({
    defaultPath: safe + '.' + format.extension,
    filters: [{ name: format.label, extensions: [format.extension] }],
  });
  return chosen ?? null;
}

/** Stops the running render; the engine removes the partial file. */
export async function cancelExport(): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('cancel_export');
}

/** Subscribes to render progress. Resolves to an unsubscribe function. */
export async function onExportProgress(
  handler: (progress: ExportProgress) => void,
): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<ExportProgress>(EXPORT_PROGRESS_EVENT, (event) =>
    handler(event.payload),
  );
  return unlisten;
}

/**
 * Runs the render. The promise settles when ffmpeg exits; progress arrives on
 * the event channel in the meantime.
 *
 * Text and vector layers are rasterised here first: the webview draws them at
 * the project's resolution and hands ffmpeg plain PNGs, which is what makes the
 * export match the preview rather than approximate it.
 */
export async function exportRender(
  project: Project,
  output: string,
  settings: ExportSettings,
  workArea: { workIn: number | null; workOut: number | null },
  onBakeProgress?: (done: number, total: number) => void,
): Promise<ExportReport> {
  if (!isTauri()) throw new Error('Le rendu nécessite le mode Desktop.');

  const baked = await bakeLayers(
    project.clips,
    project.assets,
    project.settings,
    onBakeProgress,
  );
  const channels = sampleAnimation(project.clips);

  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<ExportReport>('export_render', {
    project: { ...project, assets: project.assets.map(serializeAsset) },
    output,
    baked,
    channels,
    // The work area rides along with the settings: the engine needs both to
    // know which slice of the timeline to write.
    settings: { ...settings, workIn: workArea.workIn, workOut: workArea.workOut },
  });
}
