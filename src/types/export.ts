/**
 * Output settings.
 *
 * A format is described once here — codec, container, how quality is expressed —
 * and both the dialog and the Rust encoder read that description rather than
 * hard-coding a matrix of special cases.
 */

export type ContainerId = 'mp4-h264' | 'mp4-h265' | 'webm-vp9' | 'mov-prores';
export type RateMode = 'crf' | 'bitrate';
export type ResolutionChoice =
  | 'source'
  | '2160'
  | '1440'
  | '1080'
  | '720'
  | '480'
  | '360';
export type FpsChoice = 'source' | 24 | 25 | 30 | 60;
export type RangeChoice = 'all' | 'work';

export interface FormatDescriptor {
  id: ContainerId;
  label: string;
  hint: string;
  extension: string;
  videoCodec: string;
  audioCodec: string;
  /** ProRes has no rate factor: its profile *is* the quality dial. */
  supportsCrf: boolean;
  crf: { min: number; max: number; default: number };
  /** Lower is better for CRF-style scales; used for the slider's labels. */
  crfHint: [string, string];
  /** Encoder presets, when the codec has any. */
  presets: string[];
  defaultBitrateKbps: number;
}

export const FORMATS: FormatDescriptor[] = [
  {
    id: 'mp4-h264',
    label: 'MP4 · H.264',
    hint: 'Compatible partout — le choix par défaut',
    extension: 'mp4',
    videoCodec: 'libx264',
    audioCodec: 'aac',
    supportsCrf: true,
    crf: { min: 12, max: 34, default: 18 },
    crfHint: ['Qualité', 'Poids'],
    presets: ['veryfast', 'fast', 'medium', 'slow'],
    defaultBitrateKbps: 12000,
  },
  {
    id: 'mp4-h265',
    label: 'MP4 · H.265',
    hint: 'Moitié du poids, encodage plus lent',
    extension: 'mp4',
    videoCodec: 'libx265',
    audioCodec: 'aac',
    supportsCrf: true,
    crf: { min: 18, max: 38, default: 24 },
    crfHint: ['Qualité', 'Poids'],
    presets: ['veryfast', 'fast', 'medium', 'slow'],
    defaultBitrateKbps: 8000,
  },
  {
    id: 'webm-vp9',
    label: 'WebM · VP9',
    hint: 'Libre de droits, pour le web',
    extension: 'webm',
    videoCodec: 'libvpx-vp9',
    audioCodec: 'libopus',
    supportsCrf: true,
    crf: { min: 20, max: 45, default: 31 },
    crfHint: ['Qualité', 'Poids'],
    presets: [],
    defaultBitrateKbps: 6000,
  },
  {
    id: 'mov-prores',
    label: 'MOV · ProRes',
    hint: 'Maquette d’intermédiaire — fichiers très lourds',
    extension: 'mov',
    videoCodec: 'prores_ks',
    audioCodec: 'pcm_s16le',
    supportsCrf: false,
    crf: { min: 0, max: 3, default: 2 },
    crfHint: ['Proxy', 'HQ'],
    presets: [],
    defaultBitrateKbps: 0,
  },
];

export const PRORES_PROFILES = ['Proxy', 'LT', 'Standard', 'HQ'];

export const formatOf = (id: ContainerId): FormatDescriptor =>
  FORMATS.find((item) => item.id === id) ?? (FORMATS[0] as FormatDescriptor);

export interface ExportSettings {
  format: ContainerId;
  rateMode: RateMode;
  /** Rate factor, or the ProRes profile index when the format has no CRF. */
  crf: number;
  bitrateKbps: number;
  audioBitrateKbps: number;
  preset: string;
  resolution: ResolutionChoice;
  fps: FpsChoice;
  range: RangeChoice;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: 'mp4-h264',
  rateMode: 'crf',
  crf: 18,
  bitrateKbps: 12000,
  audioBitrateKbps: 192,
  preset: 'medium',
  resolution: 'source',
  fps: 'source',
  range: 'all',
};

export const RESOLUTION_CHOICES: { id: ResolutionChoice; label: string }[] = [
  { id: 'source', label: 'Projet' },
  { id: '2160', label: '2160p' },
  { id: '1440', label: '1440p' },
  { id: '1080', label: '1080p' },
  { id: '720', label: '720p' },
  { id: '480', label: '480p' },
  { id: '360', label: '360p' },
];

/** The familiar ladder, with the wording people already know it by. */
export const RESOLUTION_PRESETS: {
  id: ResolutionChoice;
  label: string;
  hint: string;
}[] = [
  { id: '2160', label: '2160p', hint: '4K UHD' },
  { id: '1440', label: '1440p', hint: '2K' },
  { id: '1080', label: '1080p', hint: 'Full HD' },
  { id: '720', label: '720p', hint: 'HD' },
  { id: '480', label: '480p', hint: 'SD' },
  { id: 'source', label: 'Projet', hint: 'Taille d’origine' },
];

/**
 * The single dial of the simple tab: 0 is the lightest file, 100 the best
 * picture. Each codec keeps its own rate-factor scale underneath, so the same
 * position means the same quality whichever one is selected.
 */
export function crfFromQuality(format: FormatDescriptor, quality: number): number {
  const t = Math.min(100, Math.max(0, quality)) / 100;
  return Math.round(format.crf.max - t * (format.crf.max - format.crf.min));
}

export function qualityFromCrf(format: FormatDescriptor, crf: number): number {
  const span = format.crf.max - format.crf.min;
  if (span <= 0) return 100;
  const value = ((format.crf.max - crf) / span) * 100;
  return Math.round(Math.min(100, Math.max(0, value)));
}

export function qualityLabel(quality: number): string {
  if (quality >= 85) return 'Maximale';
  if (quality >= 60) return 'Élevée';
  if (quality >= 35) return 'Équilibrée';
  return 'Légère';
}

export const FPS_CHOICES: { id: FpsChoice; label: string }[] = [
  { id: 'source', label: 'Projet' },
  { id: 24, label: '24' },
  { id: 25, label: '25' },
  { id: 30, label: '30' },
  { id: 60, label: '60' },
];

/** Output height for a choice, or `null` to keep the project's own frame. */
export function heightFor(choice: ResolutionChoice): number | null {
  return choice === 'source' ? null : Number(choice);
}

/** Keeps a settings object coherent when the format changes under it. */
export function reconcile(settings: ExportSettings): ExportSettings {
  const format = formatOf(settings.format);
  const next = { ...settings };

  if (!format.supportsCrf) {
    next.rateMode = 'crf';
    next.crf = Math.round(Math.min(Math.max(next.crf, format.crf.min), format.crf.max));
  } else {
    next.crf = Math.min(Math.max(next.crf, format.crf.min), format.crf.max);
  }

  if (format.presets.length === 0) next.preset = '';
  else if (!format.presets.includes(next.preset)) {
    next.preset = format.presets[Math.min(2, format.presets.length - 1)] as string;
  }

  return next;
}

/**
 * The slice of the timeline an export actually writes, clamped to what exists.
 *
 * The TypeScript twin of `ExportSettings::window` in `engine::ffmpeg`, and it
 * has to stay one: the progress bar fills across *this* span on both sides, so
 * a disagreement about where an export begins is a bar that reads 40 % in the
 * viewer and 0 % in the file.
 *
 * A degenerate work area falls back to the whole timeline rather than producing
 * an empty export — the same rule, and for the same reason, as the Rust twin.
 */
export function exportWindow(
  duration: number,
  settings: Pick<ExportSettings, 'range'>,
  work: { in: number | null; out: number | null },
): { from: number; to: number } {
  if (settings.range !== 'work') return { from: 0, to: duration };

  const from = Math.min(Math.max(work.in ?? 0, 0), duration);
  const to = Math.min(Math.max(work.out ?? duration, from), duration);
  return to - from < 1e-3 ? { from: 0, to: duration } : { from, to };
}
