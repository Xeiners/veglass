import { isTauri } from './env';
import { pathToSrc } from './media';
import type { MediaAsset } from '@/types/media';

export type MediaStatus = 'ok' | 'relocated' | 'missing';

export interface MediaResolution {
  id: string;
  status: MediaStatus;
  path: string | null;
}

export interface RelinkOutcome {
  assets: MediaAsset[];
  /** Assets whose path changed — the project must be written back. */
  relocated: number;
  missingIds: string[];
}

/**
 * Re-points assets at the files they describe.
 *
 * An absolute path only has to survive until the next time a folder moves, so
 * a project is verified rather than trusted on every open: the native side
 * checks each path and, when one is gone, searches for the same filename in
 * the folders the project is most likely to have travelled with.
 *
 * `hints` are directories the user has pointed at explicitly — picking one
 * missing file usually relinks the whole batch.
 */
export async function relinkAssets(
  assets: MediaAsset[],
  hints: string[] = [],
): Promise<RelinkOutcome> {
  const withPaths = assets.filter((asset) => asset.path);

  if (!isTauri() || withPaths.length === 0) {
    // In the browser a blob URL cannot be revived; the dialog offers a re-import.
    return {
      assets,
      relocated: 0,
      missingIds: assets.filter((asset) => !asset.src || asset.missing).map((asset) => asset.id),
    };
  }

  const { invoke } = await import('@tauri-apps/api/core');
  const resolutions = await invoke<MediaResolution[]>('resolve_media', {
    requests: withPaths.map((asset) => ({ id: asset.id, name: asset.name, path: asset.path })),
    hints,
  });

  const byId = new Map(resolutions.map((item) => [item.id, item]));
  let relocated = 0;
  const missingIds: string[] = [];

  const next = await Promise.all(
    assets.map(async (asset): Promise<MediaAsset> => {
      const resolution = byId.get(asset.id);

      if (!resolution) {
        // No recorded path at all — nothing to search for.
        if (!asset.src) missingIds.push(asset.id);
        return asset;
      }

      if (resolution.status === 'missing' || !resolution.path) {
        missingIds.push(asset.id);
        return { ...asset, src: '', missing: true };
      }

      if (resolution.status === 'relocated') relocated += 1;

      return {
        ...asset,
        path: resolution.path,
        src: await pathToSrc(resolution.path),
        missing: false,
      };
    }),
  );

  return { assets: next, relocated, missingIds };
}

/** Directory holding a file — used as the hint for a batch relink. */
export async function parentDirectory(path: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string | null>('parent_directory', { path });
}
