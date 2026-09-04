export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Round a time to the nearest frame boundary — keeps edits frame-accurate. */
export function snapToFrame(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || fps <= 0) return 0;
  return Math.round(seconds * fps) / fps;
}

const pad = (n: number, size = 2): string => String(Math.floor(Math.abs(n))).padStart(size, '0');

/** `HH:MM:SS:FF` — the editing timecode shown in the transport. */
export function formatTimecode(seconds: number, fps: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalFrames = Math.round(safe * fps);
  const frames = totalFrames % Math.round(fps);
  const totalSeconds = Math.floor(totalFrames / fps);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(frames)}`;
}

/** `1:02` / `1:02:33` — human reading, used on cards and clips. */
export function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatRelativeDate(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return "à l'instant";
  if (diff < hour) return `il y a ${Math.floor(diff / minute)} min`;
  if (diff < day) return `il y a ${Math.floor(diff / hour)} h`;
  if (diff < 7 * day) return `il y a ${Math.floor(diff / day)} j`;
  return new Date(timestamp).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

export interface RulerTicks {
  /** Seconds between labelled ticks. */
  interval: number;
  /** Seconds between subdivisions; 0 when they would be too dense to read. */
  minor: number;
}

/**
 * Tick spacing for the ruler.
 *
 * Below a second the steps are whole numbers of **frames**, so a tick always
 * lands on a frame the playhead can actually stop at — a ruler graduated in
 * round decimal seconds points at positions that do not exist.
 */
export function chooseTicks(pixelsPerSecond: number, fps: number, minLabelPx = 84): RulerTicks {
  const frame = 1 / Math.max(fps, 1);
  const frameSteps = [1, 2, 5, 10, 15, 30, 60]
    .map((count) => count * frame)
    .filter((step) => step < 1);
  const secondSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const candidates = [...frameSteps, ...secondSteps];

  const interval =
    candidates.find((step) => step * pixelsPerSecond >= minLabelPx) ??
    (candidates[candidates.length - 1] as number);

  // Subdivisions have to divide the interval exactly, or a minor tick would
  // land on top of a major one at irregular intervals.
  const readable = (step: number) => step * pixelsPerSecond >= 7;

  if (interval < 1) {
    // Finest readable subdivision that still divides the interval exactly —
    // single frames when the zoom allows, coarser groups of frames when not.
    const perInterval = Math.round(interval / frame);
    const step = [1, 2, 3, 5].find(
      (count) => perInterval % count === 0 && perInterval / count >= 2 && readable(count * frame),
    );
    return { interval, minor: step ? step * frame : 0 };
  }

  const divisor = [5, 4, 2].find((value) => readable(interval / value));
  return { interval, minor: divisor ? interval / divisor : 0 };
}

/**
 * Ruler label, at the precision the spacing actually resolves.
 *
 * Sub-second steps get decimals rather than a frame count: three colon-separated
 * groups would read as hours:minutes:seconds at a glance, and the ruler has no
 * room to say otherwise.
 */
export function formatRulerTime(seconds: number, interval: number): string {
  if (interval >= 1) return formatClock(seconds);

  const decimals = interval >= 0.1 ? 1 : 2;
  const whole = Math.floor(seconds);
  const fraction = (seconds - whole).toFixed(decimals).slice(1);
  return `${formatClock(whole)}${fraction}`;
}
