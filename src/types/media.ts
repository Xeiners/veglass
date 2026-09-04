export type MediaKind = 'video' | 'audio' | 'image';

/**
 * A file imported into the project library.
 *
 * `src` is only valid for the current session: blob URLs die with the page and
 * Tauri `asset://` URLs are rebuilt from `path` on load. `path` is therefore the
 * only field that survives serialisation — an asset without one is flagged
 * `missing` when the project is reopened.
 */
export interface MediaAsset {
  id: string;
  name: string;
  kind: MediaKind;
  src: string;
  path: string | null;
  /** Seconds. 0 until the browser has decoded metadata. */
  duration: number;
  width: number | null;
  height: number | null;
  /** Bytes, when known. */
  size: number | null;
  addedAt: number;
  missing?: boolean;
}

/** Everything we persist about an asset — `src` is deliberately dropped. */
export type SerializedAsset = Omit<MediaAsset, 'src' | 'missing'>;

const VIDEO_EXT = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'ogv'];
const AUDIO_EXT = ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'oga', 'flac', 'opus'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg'];

export const IMPORT_EXTENSIONS = [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT];

export function extensionOf(nameOrPath: string): string {
  const clean = nameOrPath.split(/[?#]/)[0] ?? '';
  const dot = clean.lastIndexOf('.');
  return dot === -1 ? '' : clean.slice(dot + 1).toLowerCase();
}

export function kindFromName(nameOrPath: string, mime?: string): MediaKind {
  // `image/svg+xml` matches the image prefix, so vectors need no special case.
  if (mime?.startsWith('video/')) return 'video';
  if (mime?.startsWith('audio/')) return 'audio';
  if (mime?.startsWith('image/')) return 'image';

  const ext = extensionOf(nameOrPath);
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (IMAGE_EXT.includes(ext)) return 'image';
  return 'video';
}

/** Images have no intrinsic duration; they get a default when dropped on the timeline. */
export const STILL_DEFAULT_DURATION = 5;
