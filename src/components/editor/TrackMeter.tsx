import { useEffect, useRef } from 'react';

import { cn } from '@/lib/cn';
import { audioEngine, meterScale, toDb } from '@/lib/audioEngine';

/**
 * A level meter that never re-renders.
 *
 * Metering runs at animation frequency; routing it through React state would
 * repaint the track head sixty times a second for two coloured bars. The bars
 * are written straight to the DOM instead, and the component itself renders
 * once.
 */
export function TrackMeter({
  trackId,
  orientation = 'horizontal',
  className,
}: {
  trackId: string;
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}) {
  const rms = useRef<HTMLSpanElement | null>(null);
  const peak = useRef<HTMLSpanElement | null>(null);
  const clip = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let frame = 0;
    const vertical = orientation === 'vertical';

    const tick = () => {
      const levels = audioEngine.levels(trackId);
      const body = meterScale(toDb(levels.rms));
      const top = meterScale(toDb(levels.peak));

      if (rms.current) {
        rms.current.style[vertical ? 'height' : 'width'] = `${body * 100}%`;
      }
      if (peak.current) {
        peak.current.style[vertical ? 'bottom' : 'left'] = `${top * 100}%`;
        peak.current.style.opacity = top > 0.01 ? '1' : '0';
      }
      if (clip.current) {
        // Anything at or above 0 dBFS is already clipped by the time it is here.
        clip.current.style.opacity = levels.peak >= 0.999 ? '1' : '0';
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [trackId, orientation]);

  const vertical = orientation === 'vertical';

  return (
    <span
      className={cn(
        'relative block overflow-hidden rounded-full bg-white/[0.07]',
        vertical ? 'w-1.5' : 'h-1.5',
        className,
      )}
      aria-hidden
    >
      <span
        ref={rms}
        className={cn(
          'absolute rounded-full bg-gradient-to-r from-wave-500 via-wave-400 to-rose-400',
          vertical ? 'bottom-0 left-0 right-0 h-0' : 'bottom-0 left-0 top-0 w-0',
        )}
        style={{ transition: 'none' }}
      />
      <span
        ref={peak}
        className={cn(
          'absolute bg-white/80 opacity-0',
          vertical ? 'left-0 right-0 h-px' : 'bottom-0 top-0 w-px',
        )}
      />
      <span
        ref={clip}
        className={cn(
          'absolute bg-rose-400 opacity-0',
          vertical ? 'left-0 right-0 top-0 h-1' : 'bottom-0 right-0 top-0 w-1',
        )}
      />
    </span>
  );
}
