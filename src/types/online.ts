/**
 * Online media — the domain model for searching and fetching.
 *
 * Nothing here is persisted inside a project. A search is a session, a queue is
 * a session, and what survives is the ordinary thing: a file on disk that the
 * media pool imported. The document format does not learn that a clip came from
 * the internet, which is exactly why a downloaded clip behaves like any other.
 */

/** Mirrors `OnlineErrorKind` in `src-tauri/src/online/error.rs`. */
export type OnlineErrorKind =
  | 'missing-binary'
  | 'unsupported'
  | 'network'
  | 'invalid-url'
  | 'unavailable'
  | 'tool'
  | 'format'
  | 'io'
  | 'cancelled';

export interface ToolStatus {
  available: boolean;
  /** Whether this platform has a build the app is willing to fetch. */
  installable: boolean;
  path: string | null;
  /** yt-dlp's version — a date, and the useful part: an old build breaks. */
  version: string | null;
  /** Days since that date, when the version can be read as one. */
  ageDays: number | null;
  /** Whether this is the copy Veglass installed, and so the one it can replace. */
  managed: boolean;
}

/**
 * When a build is old enough to be the first thing to suspect.
 *
 * yt-dlp breaks whenever a site changes, and it ships fixes within days — so
 * "this video is not available" on a video that plainly exists is far more
 * often an outdated binary than a closed video. Two months is well past the
 * point where that becomes the likelier of the two.
 */
export const STALE_AFTER_DAYS = 60;

export function isStale(tool: ToolStatus): boolean {
  return tool.available && tool.ageDays !== null && tool.ageDays > STALE_AFTER_DAYS;
}

/* ------------------------------------------------------------------ *
 * Search filters
 * ------------------------------------------------------------------ */

export type ResultKind = 'any' | 'video' | 'playlist';
export type DurationFilter = 'any' | 'short' | 'medium' | 'long';
export type SortOrder = 'relevance' | 'date' | 'views';

/**
 * The filters YouTube's search actually has.
 *
 * There is no "music only" among them — sound is a property of what you
 * download, not of what you search, and the format picker is where that choice
 * belongs. The licence filter takes its place in the bar, and is the one that
 * genuinely helps someone sourcing material they intend to publish.
 */
export interface SearchFilters {
  kind: ResultKind;
  duration: DurationFilter;
  sort: SortOrder;
  creativeCommons: boolean;
}

export const DEFAULT_FILTERS: SearchFilters = {
  kind: 'any',
  duration: 'any',
  sort: 'relevance',
  creativeCommons: false,
};

export const isDefaultFilters = (filters: SearchFilters): boolean =>
  filters.kind === 'any' &&
  filters.duration === 'any' &&
  filters.sort === 'relevance' &&
  !filters.creativeCommons;

export const KIND_OPTIONS: { id: ResultKind; label: string }[] = [
  { id: 'any', label: 'Tout' },
  { id: 'video', label: 'Vidéos' },
  { id: 'playlist', label: 'Playlists' },
];

export const DURATION_OPTIONS: { id: DurationFilter; label: string }[] = [
  { id: 'any', label: 'Toutes' },
  { id: 'short', label: '< 4 min' },
  { id: 'medium', label: '4 – 20 min' },
  { id: 'long', label: '> 20 min' },
];

export const SORT_OPTIONS: { id: SortOrder; label: string }[] = [
  { id: 'relevance', label: 'Pertinence' },
  { id: 'date', label: 'Date' },
  { id: 'views', label: 'Vues' },
];

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

export interface SearchResult {
  id: string;
  title: string;
  url: string;
  /** Seconds. `null` for a live stream, which has no length yet. */
  duration: number | null;
  uploader: string | null;
  thumbnail: string | null;
  views: number | null;
  /** A stream in progress — it has no end, so fetching it is refused. */
  live: boolean;
}

/** One page of results, and whether there is another behind it. */
export interface SearchPage {
  results: SearchResult[];
  nextOffset: number;
  more: boolean;
}

/* ------------------------------------------------------------------ *
 * Formats
 * ------------------------------------------------------------------ */

export interface VideoOffer {
  height: number;
  /** `1080p`, `2160p · 4K` — what the button says. */
  label: string;
  fps: number | null;
  codec: string;
  ext: string;
  /** Bytes, picture plus the sound it merges with. `null` when unknown. */
  size: number | null;
  /** Already carries sound: no merge step. */
  muxed: boolean;
}

export interface AudioOffer {
  codec: string;
  /** kbit/s. */
  bitrate: number | null;
  ext: string;
  size: number | null;
}

export interface MediaFormats {
  title: string;
  duration: number | null;
  thumbnail: string | null;
  uploader: string | null;
  /** Tallest first. Empty when the video offers no picture. */
  video: VideoOffer[];
  /** Best first, one row per codec. */
  audio: AudioOffer[];
  live: boolean;
}

export type AudioTarget = 'original' | 'mp3' | 'm4a' | 'wav';

/**
 * What the picker settled on.
 *
 * `height: null` means "the best there is", which is also what a video with a
 * single rendition collapses to - the list *is* what exists, so there is never
 * an option to grey out that the user could have wanted.
 */
export type Selection =
  | { kind: 'video'; height: number | null }
  | { kind: 'audio'; format: AudioTarget };

export const AUDIO_TARGETS: { id: AudioTarget; label: string; hint: string }[] = [
  {
    id: 'original',
    label: 'Sans réencodage',
    hint: 'Le flux tel quel — qualité maximale, conversion instantanée',
  },
  { id: 'mp3', label: 'MP3', hint: 'Universel, V0 — le choix sûr pour la musique' },
  { id: 'm4a', label: 'M4A', hint: 'AAC, léger et lu partout' },
  { id: 'wav', label: 'WAV', hint: 'PCM — bien plus lourd, sans gain sur une source compressée' },
];

/** `1080p · h264 · 60 fps` — the line under a quality button. */
export function describeOffer(offer: VideoOffer): string {
  const parts = [offer.codec];
  if (offer.fps && offer.fps >= 50) parts.push(`${Math.round(offer.fps)} fps`);
  if (offer.muxed) parts.push('son inclus');
  return parts.join(' · ');
}

/**
 * Where a download has got to.
 *
 * `convert` earns its own state rather than being folded into `download`: it
 * takes real time on a long file and has no percentage, so a queue that did not
 * name it would sit at 100 % looking broken.
 */
export type DownloadStage =
  | 'queued'
  | 'download'
  | 'convert'
  | 'done'
  | 'failed'
  | 'cancelled';

export const STAGE_LABELS: Record<DownloadStage, string> = {
  queued: 'En attente',
  download: 'Téléchargement',
  convert: 'Conversion',
  done: 'Terminé',
  failed: 'Échec',
  cancelled: 'Annulé',
};

export interface DownloadJob {
  /** Ours, not yt-dlp's: progress events and cancellation both carry it. */
  id: string;
  title: string;
  url: string;
  thumbnail: string | null;
  /** Kept so a retry repeats the same choice rather than the default. */
  selection: Selection;
  audioOnly: boolean;
  /** `1080p`, `MP3` — what the row says it is fetching. */
  quality: string;

  stage: DownloadStage;
  /** 0 → 1 while downloading; 1 from the moment conversion starts. */
  ratio: number;
  received: number;
  total: number;
  /** Bytes per second, 0 when unknown. */
  speed: number;
  /** Seconds remaining, 0 when unknown. */
  eta: number;

  /** Set once the file exists. */
  path: string | null;
  name: string | null;
  bytes: number;
  /** Whether it has been handed to the media pool. */
  imported: boolean;
  error: string | null;
  startedAt: number;
}

/** Progress as the Rust side emits it. */
export interface DownloadProgress {
  id: string;
  stage: 'download' | 'convert';
  received: number;
  total: number;
  ratio: number;
  speed: number;
  eta: number;
}

export interface DownloadReport {
  id: string;
  path: string;
  name: string;
  bytes: number;
}

export interface InstallProgress {
  stage: 'download' | 'verify';
  received: number;
  total: number;
  ratio: number;
}

export const isFinished = (job: DownloadJob): boolean =>
  job.stage === 'done' || job.stage === 'failed' || job.stage === 'cancelled';

export const isRunning = (job: DownloadJob): boolean =>
  job.stage === 'queued' || job.stage === 'download' || job.stage === 'convert';

/** `4,2 Mo/s` — the reading a queue actually needs. */
export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  const units = ['o/s', 'Ko/s', 'Mo/s', 'Go/s'];
  let value = bytesPerSecond;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** `1,2 M` — view counts, at the precision anyone reads them. */
export function formatCount(views: number | null): string | null {
  if (views === null || !Number.isFinite(views)) return null;
  if (views < 1000) return `${views}`;
  if (views < 1_000_000) return `${(views / 1000).toFixed(views < 10_000 ? 1 : 0)} k`;
  return `${(views / 1_000_000).toFixed(views < 10_000_000 ? 1 : 0)} M`;
}
