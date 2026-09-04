import { useMemo } from 'react';

import type { Waveform as WaveformData } from '@/lib/media';

/** Roughly one bar per this many pixels — finer reads as noise. */
const PIXELS_PER_BAR = 2;

/**
 * Audio envelope for the slice of the source a clip actually shows.
 *
 * Two shapes, not one: a solid RMS body for perceived loudness, and a lighter
 * peak envelope over it for transients. A drawing with only peaks looks like
 * spiky noise; only RMS, like a shapeless blob. Together they read the way a
 * waveform is supposed to.
 *
 * The data is decimated to the number of bars the clip can actually show, so a
 * three-minute file collapsed into eighty pixels costs eighty aggregations
 * rather than twenty thousand path points.
 */
export function Waveform({
  data,
  from,
  to,
  width,
  className,
}: {
  data: WaveformData;
  /** Portion of the source the clip covers, as ratios. */
  from: number;
  to: number;
  /** Rendered width in pixels — decides the level of detail. */
  width: number;
  className?: string;
}) {
  const shapes = useMemo(() => {
    const length = data.peaks.length;
    if (length === 0) return null;

    const start = Math.max(0, Math.min(length - 1, Math.floor(from * length)));
    const end = Math.max(start + 1, Math.min(length, Math.ceil(to * length)));
    const span = end - start;

    const bars = Math.max(1, Math.min(Math.floor(width / PIXELS_PER_BAR) || 1, span));
    const step = span / bars;

    const peakTop: string[] = [];
    const peakBottom: string[] = [];
    const rmsTop: string[] = [];
    const rmsBottom: string[] = [];

    for (let bar = 0; bar < bars; bar += 1) {
      const first = start + Math.floor(bar * step);
      const last = Math.min(end, start + Math.floor((bar + 1) * step) || first + 1);

      let peak = 0;
      let body = 0;
      for (let i = first; i < Math.max(last, first + 1); i += 1) {
        const p = data.peaks[i] ?? 0;
        const r = data.rms[i] ?? 0;
        if (p > peak) peak = p;
        if (r > body) body = r;
      }

      const x = (bar / Math.max(bars - 1, 1)) * 100;
      // A floor of one unit keeps silence visible as a hairline rather than a
      // gap, which reads as "no data" instead of "no sound".
      const peakHeight = Math.max(peak, 0.012) * 47;
      const bodyHeight = Math.max(body, 0.008) * 47;

      peakTop.push(`${x.toFixed(3)},${(50 - peakHeight).toFixed(3)}`);
      peakBottom.unshift(`${x.toFixed(3)},${(50 + peakHeight).toFixed(3)}`);
      rmsTop.push(`${x.toFixed(3)},${(50 - bodyHeight).toFixed(3)}`);
      rmsBottom.unshift(`${x.toFixed(3)},${(50 + bodyHeight).toFixed(3)}`);
    }

    return {
      peak: `M${peakTop.join(' L')} L${peakBottom.join(' L')} Z`,
      rms: `M${rmsTop.join(' L')} L${rmsBottom.join(' L')} Z`,
    };
  }, [data, from, to, width]);

  if (!shapes) return null;

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className={className}
      aria-hidden
      focusable="false"
    >
      <path d={shapes.peak} fill="currentColor" opacity={0.4} />
      <path d={shapes.rms} fill="currentColor" opacity={0.85} />
    </svg>
  );
}
