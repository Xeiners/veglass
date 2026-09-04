import { useEffect, type RefObject } from 'react';

import { formatTimecode } from '@/lib/time';
import { useEditor } from '@/store/editorStore';

/**
 * Everything that moves with the playhead, isolated from the rest of the
 * timeline.
 *
 * The transport clock writes the playhead sixty times a second. If `Timeline`
 * itself subscribed to it, every one of those ticks would re-render the ruler,
 * the track heads and every clip. These four tiny components subscribe instead,
 * so playback repaints a line and a timecode — nothing else.
 */

export function PlayheadLine({
  pixelsPerSecond,
  headWidth,
  top,
}: {
  pixelsPerSecond: number;
  headWidth: number;
  top: number;
}) {
  const playhead = useEditor((state) => state.playhead);

  return (
    <div
      className="pointer-events-none absolute bottom-0 z-[25] w-px bg-accent-300"
      style={{
        left: headWidth + playhead * pixelsPerSecond,
        top,
        boxShadow: '0 0 10px rgba(167,139,250,.65)',
      }}
    />
  );
}

export function PlayheadGrip({ pixelsPerSecond }: { pixelsPerSecond: number }) {
  const playhead = useEditor((state) => state.playhead);

  return (
    <span
      className="pointer-events-none absolute top-0 z-10 h-3.5 w-[13px] -translate-x-1/2 rounded-b-[3px] bg-accent-300 shadow-[0_2px_6px_rgba(0,0,0,.55)]"
      style={{ left: playhead * pixelsPerSecond }}
    />
  );
}

export function TimecodeReadout({ fps }: { fps: number }) {
  const playhead = useEditor((state) => state.playhead);
  return <div className="num text-2xs text-white/30">{formatTimecode(playhead, fps)}</div>;
}

/** Keeps the playhead in view during playback, without re-rendering the tracks. */
export function PlayheadFollower({
  scrollRef,
  pixelsPerSecond,
  headWidth,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  pixelsPerSecond: number;
  headWidth: number;
}) {
  const playhead = useEditor((state) => state.playhead);
  const isPlaying = useEditor((state) => state.isPlaying);

  useEffect(() => {
    if (!isPlaying) return;
    const node = scrollRef.current;
    if (!node) return;

    // In scroll coordinates the lane starts one head width in, and both the
    // test and the correction have to say so — otherwise the playhead is judged
    // off-screen a head width early and the strip jumps for no reason.
    const x = headWidth + playhead * pixelsPerSecond;
    const viewport = node.clientWidth - headWidth;
    const left = node.scrollLeft;
    if (x < left + headWidth || x > left + headWidth + viewport * 0.82) {
      node.scrollTo({
        left: Math.max(0, x - headWidth - viewport * 0.35),
        behavior: 'auto',
      });
    }
  }, [playhead, isPlaying, pixelsPerSecond, headWidth, scrollRef]);

  return null;
}
