/**
 * Transport for the online-media module.
 *
 * Desktop only, and unapologetically so. Everything here drives a child process
 * — searching, fetching, installing — and none of it has a browser equivalent
 * worth pretending to. The browser host therefore gets a clear `unsupported`
 * rather than a stub that fails later and less legibly.
 */

import { isTauri } from '@/lib/env';
import type {
  DownloadProgress,
  DownloadReport,
  InstallProgress,
  MediaFormats,
  OnlineErrorKind,
  SearchFilters,
  SearchPage,
  Selection,
  ToolStatus,
} from '@/types/online';

/**
 * A failure with a machine-readable cause.
 *
 * The panel switches on `kind`: `missing-binary` offers to install, `network`
 * offers a retry, `unavailable` says this particular video is shut and moves
 * on. Anything else is shown and the editor carries on.
 */
export class OnlineError extends Error {
  readonly kind: OnlineErrorKind;
  readonly retryable: boolean;

  constructor(kind: OnlineErrorKind, message: string, retryable = false) {
    super(message);
    this.name = 'OnlineError';
    this.kind = kind;
    this.retryable = retryable;
  }
}

interface RustOnlineError {
  kind: OnlineErrorKind;
  message: string;
  retryable: boolean;
}

const isRustError = (value: unknown): value is RustOnlineError =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as RustOnlineError).kind === 'string' &&
  typeof (value as RustOnlineError).message === 'string';

export function toOnlineError(error: unknown): OnlineError {
  if (error instanceof OnlineError) return error;
  if (isRustError(error)) return new OnlineError(error.kind, error.message, error.retryable);
  if (error instanceof Error) return new OnlineError('io', error.message);
  return new OnlineError('io', String(error));
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new OnlineError(
      'unsupported',
      'Les médias en ligne demandent l’application desktop.',
    );
  }
  const { invoke: call } = await import('@tauri-apps/api/core');
  try {
    return await call<T>(command, args);
  } catch (error) {
    throw toOnlineError(error);
  }
}

/* ------------------------------------------------------------------ *
 * The tool
 * ------------------------------------------------------------------ */

export async function toolStatus(): Promise<ToolStatus> {
  if (!isTauri()) {
    return {
      available: false,
      installable: false,
      path: null,
      version: null,
      ageDays: null,
      managed: false,
    };
  }
  return invoke<ToolStatus>('ytdlp_status');
}

export const installTool = (): Promise<ToolStatus> => invoke<ToolStatus>('install_ytdlp');

/* ------------------------------------------------------------------ *
 * Browsing
 * ------------------------------------------------------------------ */

/**
 * Searches, or reads the video a pasted link points at.
 *
 * `signal` does not stop the child process — it stops the *answer* being used,
 * which is what typing a new query while the last one is still running means.
 */
export async function search(
  query: string,
  filters: SearchFilters,
  offset: number,
  signal?: AbortSignal,
): Promise<SearchPage> {
  if (signal?.aborted) throw new OnlineError('cancelled', 'Recherche abandonnée.');
  const page = await invoke<SearchPage>('search_youtube', { query, filters, offset });
  if (signal?.aborted) throw new OnlineError('cancelled', 'Recherche abandonnée.');
  return page;
}

/**
 * What a video offers, before anything is fetched.
 *
 * Slower than a search — this one resolves the video properly rather than
 * reading a listing — which is why the picker shows a spinner while it runs
 * instead of pretending to know the resolutions in advance.
 */
export const getFormats = (url: string): Promise<MediaFormats> =>
  invoke<MediaFormats>('get_media_formats', { url });

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

export const download = (args: {
  id: string;
  url: string;
  projectId: string;
  /** Only used to name the finished file — the download itself uses the id. */
  title: string;
  selection: Selection;
}): Promise<DownloadReport> => invoke<DownloadReport>('download_media', args);

export const cancelDownload = (id: string): Promise<boolean> =>
  invoke<boolean>('cancel_download', { id });

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

/**
 * Subscribes to download progress. Returns an unsubscribe function.
 *
 * One subscription for every download: the payload carries the job id, and a
 * listener per job would mean tearing down and rebuilding the bridge each time
 * the queue changes.
 */
export async function onDownloadProgress(
  handler: (progress: DownloadProgress) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<DownloadProgress>('veglass://download-progress', (event) =>
    handler(event.payload),
  );
}

export async function onInstallProgress(
  handler: (progress: InstallProgress) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<InstallProgress>('veglass://ytdlp-install', (event) => handler(event.payload));
}
