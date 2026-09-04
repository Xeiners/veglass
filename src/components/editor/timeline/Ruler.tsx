import { useMemo } from 'react';

import { chooseTicks, formatRulerTime } from '@/lib/time';
import { useEditor } from '@/store/editorStore';
import { MarkerLane } from './MarkerLane';

export const RULER_HEIGHT = 32;

/**
 * Time ruler.
 *
 * Tick positions are derived from an integer index times the interval, never by
 * accumulating one step at a time: repeated addition of a fraction drifts, and
 * the drift is exactly what makes graduations creep out of alignment and minor
 * ticks land on top of major ones.
 */
export function Ruler({
  pixelsPerSecond,
  fps,
  width,
  seconds,
  from,
  to,
}: {
  pixelsPerSecond: number;
  fps: number;
  width: number;
  seconds: number;
  /** Visible window, in seconds — ticks outside it are never mounted. */
  from: number;
  to: number;
}) {
  const workIn = useEditor((state) => state.workIn);
  const workOut = useEditor((state) => state.workOut);

  const ticks = useMemo(() => {
    const { interval, minor } = chooseTicks(pixelsPerSecond, fps);

    const majors: number[] = [];
    const firstMajor = Math.max(0, Math.floor(from / interval));
    const lastMajor = Math.min(Math.floor(seconds / interval), Math.ceil(to / interval));
    for (let index = firstMajor; index <= lastMajor; index += 1) {
      majors.push(index * interval);
    }

    const minors: number[] = [];
    if (minor > 0) {
      // The interval is always a whole number of subdivisions, so the ones that
      // coincide with a label can be skipped by index alone.
      const perInterval = Math.round(interval / minor);
      const firstMinor = Math.max(0, Math.floor(from / minor));
      const lastMinor = Math.min(Math.floor(seconds / minor), Math.ceil(to / minor));
      for (let index = firstMinor; index <= lastMinor; index += 1) {
        if (index % perInterval === 0) continue;
        minors.push(index * minor);
      }
    }

    return { interval, majors, minors };
  }, [pixelsPerSecond, fps, seconds, from, to]);

  return (
    <div
      className="relative select-none border-b border-white/[0.07] bg-ink-850"
      style={{ width, height: RULER_HEIGHT }}
    >
      {/* Work area: the slice the export can be limited to. */}
      {(workIn !== null || workOut !== null) && (
        <span
          aria-hidden
          className="absolute inset-y-0 border-x border-accent-300/70 bg-accent-500/[0.16]"
          style={{
            left: (workIn ?? 0) * pixelsPerSecond,
            width: Math.max(((workOut ?? seconds) - (workIn ?? 0)) * pixelsPerSecond, 2),
          }}
        />
      )}

      {ticks.minors.map((time) => (
        <span
          key={`m${time}`}
          className="absolute bottom-0 h-1.5 w-px bg-white/[0.09]"
          style={{ left: Math.round(time * pixelsPerSecond) }}
        />
      ))}

      {/* Chapters sit above the graduations: a flag that reads as a tick is a
          flag nobody notices. Its own component — see `MarkerLane`. */}
      <MarkerLane pixelsPerSecond={pixelsPerSecond} from={from} to={to} />

      {ticks.majors.map((time) => (
        <div
          key={time}
          className="absolute bottom-0 top-0"
          style={{ left: Math.round(time * pixelsPerSecond) }}
        >
          <span className="absolute bottom-0 h-2.5 w-px bg-white/25" />
          <span className="num absolute bottom-3 left-1.5 whitespace-nowrap text-[10px] leading-none text-white/40">
            {formatRulerTime(time, ticks.interval)}
          </span>
        </div>
      ))}
    </div>
  );
}
