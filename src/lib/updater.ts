/**
 * Looking for a new version, quietly.
 *
 * The rule this module exists to enforce: **a failed check is a non-event.**
 * Someone opening a video editor on a train has not asked about updates, and
 * has certainly not asked to be told their network is down. So every path here
 * resolves rather than rejects, and the only thing a caller ever learns is
 * whether there is an update — never why there is not.
 *
 * That covers more cases than being offline. The updater plugin is registered
 * only when `tauri.conf.json` carries an `updater` block (see `lib.rs`), so on
 * a build with no endpoint configured the command does not exist at all and
 * `check()` rejects with "command not found". That is the normal state of a
 * local build, and it must look exactly like "you are up to date".
 */

import { isTauri } from '@/lib/env';

/** An update the user could install, reduced to what the dialog needs. */
export interface Available {
  version: string;
  /** The release notes from the manifest, when it carries any. */
  notes: string | null;
  /** Publication date as the manifest gave it — never reformatted here. */
  date: string | null;
  /** Kept so the download can start without asking the endpoint twice. */
  handle: UpdateHandle;
}

/**
 * The parts of the plugin's `Update` object this app uses.
 *
 * Declared structurally rather than imported as a type so this module can be
 * read — and tested — without the plugin present.
 */
export interface UpdateHandle {
  version: string;
  body?: string | null;
  date?: string | null;
  downloadAndInstall(onEvent?: (event: DownloadEvent) => void): Promise<void>;
}

export type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

/**
 * Asks the endpoint whether anything newer exists.
 *
 * Returns `null` for every reason a check might not produce an update: nothing
 * newer, no network, no endpoint configured, a malformed manifest, a signature
 * that does not verify. The distinction matters to a developer reading a log,
 * not to someone opening a project — so it is logged and swallowed.
 */
export async function checkForUpdate(): Promise<Available | null> {
  if (!isTauri()) return null;

  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = (await check()) as UpdateHandle | null;
    if (!update) return null;

    return {
      version: update.version,
      notes: cleanNotes(update.body),
      date: update.date ?? null,
      handle: update,
    };
  } catch (error) {
    // Deliberately console-only. See the module note.
    console.info('[updater] vérification ignorée :', error);
    return null;
  }
}

/**
 * Release notes, trimmed to something a dialog can hold.
 *
 * The manifest is written by whoever publishes the release, so this treats it
 * as text rather than markup: no rendering, no links, nothing that could turn a
 * release note into an injection into our own interface.
 */
export function cleanNotes(body: string | null | undefined): string | null {
  if (typeof body !== 'string') return null;

  const text = body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();

  if (text.length === 0) return null;
  return text.length > 1200 ? `${text.slice(0, 1200).trimEnd()}…` : text;
}

/**
 * Downloads and installs, then brings the app back up.
 *
 * `relaunch` never returns on success — the process is replaced. On Windows the
 * NSIS installer takes over and closes the app itself, so anything written
 * after this call must not be relied upon.
 */
export async function installUpdate(
  update: UpdateHandle,
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  let received = 0;
  let total = 0;

  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? 0;
      received = 0;
    } else if (event.event === 'Progress') {
      received += event.data.chunkLength;
    } else {
      received = total;
    }
    onProgress(received, total);
  });

  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
