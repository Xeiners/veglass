import { progressAt, progressRect, type ProgressBar } from '@/types/progress';
import { withAlpha } from '@/types/text';
import type { ProjectSettings } from '@/types/project';

/**
 * The progress bar, over the finished frame.
 *
 * Two absolutely-positioned boxes — the groove and the fill — laid out from
 * `progressRect`, which is the same function that hands the encoder its
 * `drawbox` coordinates. Neither side computes the geometry itself, so there is
 * no second implementation to drift.
 *
 * Square ends on purpose: `drawbox` cannot round, and rounding here alone would
 * make the preview and the file disagree at exactly the place this feature is
 * supposed to be exact. See `types/progress`.
 */
export function ProgressOverlay({
  bar,
  settings,
  unit,
  time,
  from,
  to,
}: {
  bar: ProgressBar;
  settings: ProjectSettings;
  /** Screen pixels per project pixel. */
  unit: number;
  /** Playhead, in timeline seconds. */
  time: number;
  /** The window the export will write, which is the span the bar fills over. */
  from: number;
  to: number;
}) {
  const rect = progressRect(bar, settings);
  const ratio = progressAt(time, from, to);

  const groove = {
    position: 'absolute' as const,
    left: rect.x * unit,
    top: rect.y * unit,
    width: rect.width * unit,
    height: rect.height * unit,
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-20" aria-hidden>
      {bar.trackOpacity > 0 && (
        <span style={{ ...groove, backgroundColor: withAlpha(bar.trackColor, bar.trackOpacity) }} />
      )}
      {bar.opacity > 0 && (
        <span
          style={{
            ...groove,
            width: rect.width * unit * ratio,
            backgroundColor: withAlpha(bar.color, bar.opacity),
          }}
        />
      )}
    </div>
  );
}
