import { formatOf, heightFor, type ExportSettings } from '@/types/export';

/**
 * What a render will weigh, and how long it will take.
 *
 * The constants below are *measured*, not guessed: each one comes from running
 * the app's own filtergraph through ffmpeg on this project's reference build
 * (1080p30, decode → scale → overlay → encode), because an estimate assembled
 * from folklore is worse than no estimate at all.
 *
 * They are still only a starting point, and the weight far more so than the
 * time. Measured on the same encoder, same settings, same resolution, a smooth
 * source and a grainy one differed by a factor of *fourteen* — 0.10 against
 * 1.46 bits per pixel at CRF 23. No model keyed on resolution and rate factor
 * can see that coming.
 *
 * Rescaling moves it again, and not in one direction: a project exported at its
 * own resolution is the hardest case, because every other size passes through a
 * resampler that smooths the detail away. Bits per pixel is therefore held
 * constant across resolutions here, which errs high when downscaling rather
 * than promising a file smaller than the one that arrives.
 *
 * So the first estimate is a starting position, not a promise. Every finished
 * render is fed back through {@link recordRender}, and within one or two
 * exports the numbers describe this machine and this kind of footage instead of
 * a synthetic clip on a reference build.
 */

/** Bits per pixel at a reference rate factor, and how fast the scale moves. */
interface CodecModel {
  /** Rate factor the measurement was taken at. */
  refCrf: number;
  /** Bits per pixel there — measured. */
  refBpp: number;
  /**
   * Rate-factor steps that halve the bitrate.
   *
   * ~6 for the H.26x family, far flatter for VP9, whose scale runs to 63.
   */
  crfPerDoubling: number;
  /** Encoding speed relative to x264 — measured on the full pipeline. */
  speed: number;
}

const CODECS: Record<string, CodecModel> = {
  // Measured: CRF 14→30 on x264, six points, 0.2084 → 0.0358 bpp.
  libx264: { refCrf: 23, refBpp: 0.0992, crfPerDoubling: 6.3, speed: 1 },
  // Measured: CRF 23 → 0.1289 bpp, CRF 28 → 0.0741 bpp. 42 img/s against 111.
  libx265: { refCrf: 23, refBpp: 0.1289, crfPerDoubling: 6.3, speed: 0.38 },
  // Measured: CRF 23 → 0.1600 bpp, CRF 31 → 0.1149 bpp. Ten times slower.
  'libvpx-vp9': { refCrf: 23, refBpp: 0.16, crfPerDoubling: 16.7, speed: 0.097 },
  prores_ks: { refCrf: 0, refBpp: 1, crfPerDoubling: 1, speed: 0.37 },
};

/**
 * Seconds per frame at preset `medium` on x264: a fixed cost plus a per-pixel
 * one.
 *
 * Least squares over six resolutions from 360p to 2160p — a 36-fold range of
 * pixel counts — with every residual inside 8%. The fixed term is not a
 * rounding artefact: it is per-frame work that does not shrink with the frame,
 * and ignoring it is what made a pure megapixels-per-second model overestimate
 * a 480p render by 212%.
 *
 * Process start-up is absorbed in it too, which is why no separate overhead is
 * added below.
 */
const FRAME_COST = { fixed: 0.00268, perMegapixel: 0.00464 };

/**
 * ProRes has no rate factor: the profile is the bitrate.
 *
 * Measured at 1.3265 bpp for 422 HQ; the others follow Apple's published data
 * rates relative to it.
 */
const PRORES_BPP = [0.265, 0.61, 0.888, 1.3265];

/** Encoding speed relative to `medium` — measured on the full pipeline. */
const PRESET_SPEED: Record<string, number> = {
  veryfast: 1.78,
  fast: 1.07,
  medium: 1.0,
  slow: 0.65,
};

export interface Estimate {
  /** Predicted output size, in bytes. */
  bytes: number;
  /** Predicted wall-clock render time, in seconds. */
  seconds: number;
  /** Video bitrate the prediction is built on. */
  bitrateKbps: number;
  /** Whether past renders on this machine contributed. */
  calibrated: boolean;
}

export interface Frame {
  width: number;
  height: number;
  fps: number;
  /** Seconds of timeline actually being rendered. */
  duration: number;
}

/** The frame the export will actually produce, after any resolution override. */
export function outputFrame(settings: ExportSettings, project: Frame): Frame {
  const height = heightFor(settings.resolution);
  const fps = settings.fps === 'source' ? project.fps : settings.fps;

  if (height === null || project.height === 0) {
    return { ...project, fps };
  }
  // Same rule as the encoder: height drives, width follows the aspect ratio,
  // rounded to an even number because the pixel formats demand it.
  const scale = height / project.height;
  return {
    width: Math.max(2, Math.round((project.width * scale) / 2) * 2),
    height,
    fps,
    duration: project.duration,
  };
}

/* ----------------------------- calibration ----------------------------- */

interface Calibration {
  /** Multiplier on the modelled bitrate. 1 means the model was right. */
  bppScale: number;
  /** Multiplier on the modelled speed. */
  speedScale: number;
  samples: number;
}

const STORAGE_KEY = 'veglass.render-calibration.v1';
/** How much a fresh render is allowed to move the running estimate. */
const LEARNING_RATE = 0.4;
/** A single odd render should not send the estimate somewhere absurd. */
const SCALE_LIMITS = { min: 0.2, max: 5 };

function loadAll(): Record<string, Calibration> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Calibration>) : {};
  } catch {
    // A private window, cleared storage, a browser that refuses: the estimate
    // simply falls back to the measured defaults.
    return {};
  }
}

function calibrationFor(codec: string): Calibration | null {
  return loadAll()[codec] ?? null;
}

function clampScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(SCALE_LIMITS.max, Math.max(SCALE_LIMITS.min, value));
}

/**
 * Teaches the estimator what this machine and this footage actually did.
 *
 * Called once a render finishes, with what really happened. Nothing here can
 * fail loudly: a refused `localStorage` costs accuracy, never the export.
 */
export function recordRender(
  settings: ExportSettings,
  frame: Frame,
  observed: { seconds: number; bytes: number },
): void {
  if (observed.seconds <= 0 || observed.bytes <= 0 || frame.duration <= 0) return;

  const codec = formatOf(settings.format).videoCodec;
  const predicted = estimate(settings, frame, { calibrated: false });
  if (predicted.bytes <= 0 || predicted.seconds <= 0) return;

  const previous = calibrationFor(codec) ?? { bppScale: 1, speedScale: 1, samples: 0 };
  const sampleBpp = clampScale((observed.bytes / predicted.bytes) * previous.bppScale);
  const sampleSpeed = clampScale((predicted.seconds / observed.seconds) * previous.speedScale);

  // Exponential moving average: the estimate follows the machine without
  // lurching after one unusual timeline.
  const blend = (before: number, sample: number) =>
    previous.samples === 0 ? sample : before + (sample - before) * LEARNING_RATE;

  const next: Calibration = {
    bppScale: clampScale(blend(previous.bppScale, sampleBpp)),
    speedScale: clampScale(blend(previous.speedScale, sampleSpeed)),
    samples: previous.samples + 1,
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadAll(), [codec]: next }));
  } catch {
    /* storage refused — the defaults stay in use */
  }
}

/** Forgets everything learned, for when a machine or a project changes character. */
export function resetCalibration(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to forget, then */
  }
}

/* ------------------------------- estimate ------------------------------- */

/**
 * The x264 curve, measured point by point.
 *
 * A single exponential through these misses by 28% at CRF 30, because the
 * relation flattens at both ends rather than staying log-linear. Six
 * measurements interpolated beat one formula fitted to them, and this is the
 * codec almost every export uses.
 */
const X264_BPP: [number, number][] = [
  [14, 0.2084],
  [18, 0.1595],
  [20, 0.135],
  [23, 0.1017],
  [26, 0.0666],
  [30, 0.0358],
];

/** Log-linear interpolation across the table, extrapolating on the end slopes. */
function interpolate(table: [number, number][], x: number): number {
  const first = table[0];
  const last = table[table.length - 1];
  if (!first || !last) return 0.1;

  let lower = first;
  let upper = last;
  for (let i = 0; i < table.length - 1; i += 1) {
    const a = table[i];
    const b = table[i + 1];
    if (!a || !b) continue;
    if (x <= b[0] || i === table.length - 2) {
      lower = a;
      upper = b;
      if (x <= b[0]) break;
    }
  }

  const span = upper[0] - lower[0];
  if (span === 0) return lower[1];
  const t = (x - lower[0]) / span;
  // Interpolating the logarithm keeps the curve smooth and always positive.
  return Math.exp(Math.log(lower[1]) + t * (Math.log(upper[1]) - Math.log(lower[1])));
}

/** Bits per pixel for a rate factor on a codec's own scale. */
function bitsPerPixel(codec: string, crf: number): number {
  if (codec === 'prores_ks') {
    const index = Math.round(Math.min(Math.max(crf, 0), PRORES_BPP.length - 1));
    return PRORES_BPP[index] ?? PRORES_BPP[PRORES_BPP.length - 1] ?? 1;
  }
  if (codec === 'libx264') return interpolate(X264_BPP, crf);

  const model = CODECS[codec] ?? CODECS.libx264;
  if (!model) return 0.1;
  return model.refBpp * Math.pow(2, (model.refCrf - crf) / model.crfPerDoubling);
}

export function estimate(
  settings: ExportSettings,
  project: Frame,
  options: { calibrated?: boolean } = {},
): Estimate {
  const format = formatOf(settings.format);
  const frame = outputFrame(settings, project);
  const pixels = frame.width * frame.height;

  if (pixels <= 0 || frame.duration <= 0) {
    return { bytes: 0, seconds: 0, bitrateKbps: 0, calibrated: false };
  }

  const useCalibration = options.calibrated !== false;
  const learned = useCalibration ? calibrationFor(format.videoCodec) : null;

  // --- weight -----------------------------------------------------------
  let videoKbps: number;
  if (settings.rateMode === 'bitrate' && format.supportsCrf) {
    // A target bitrate is not a prediction; it is the answer.
    videoKbps = settings.bitrateKbps;
  } else {
    const bpp = bitsPerPixel(format.videoCodec, settings.crf) * (learned?.bppScale ?? 1);
    videoKbps = (pixels * frame.fps * bpp) / 1000;
  }

  const audioKbps = format.audioCodec === 'pcm_s16le' ? 1536 : settings.audioBitrateKbps;
  const bytes = ((videoKbps + audioKbps) * 1000 * frame.duration) / 8;

  // --- time -------------------------------------------------------------
  const model = CODECS[format.videoCodec];
  const rate =
    (model?.speed ?? 0.4) * (PRESET_SPEED[settings.preset] ?? 1) * (learned?.speedScale ?? 1);

  const frames = frame.fps * frame.duration;
  const perFrame = FRAME_COST.fixed + FRAME_COST.perMegapixel * (pixels / 1e6);
  const seconds = (frames * perFrame) / Math.max(rate, 0.01);

  return {
    bytes: Math.max(0, Math.round(bytes)),
    seconds: Math.max(0, seconds),
    bitrateKbps: Math.round(videoKbps),
    calibrated: (learned?.samples ?? 0) > 0,
  };
}

/* -------------------------------- display ------------------------------- */

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_073_741_824).toFixed(1)} Go`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_048_576)} Mo`;
  return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}
