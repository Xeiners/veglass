import { useEffect } from 'react';

import { projectDuration, useEditor } from '@/store/editorStore';

/**
 * The transport clock.
 *
 * The playhead is driven by wall time rather than by the `<video>` element, so
 * a gap in the timeline, a still image or a muted layer all keep advancing at
 * the same rate. The media elements then chase the playhead (see VideoPreview
 * and AudioMixer), which is what keeps multi-track playback in sync.
 */
export function usePlaybackClock(): void {
  const isPlaying = useEditor((state) => state.isPlaying);

  useEffect(() => {
    if (!isPlaying) return;

    let frame = 0;
    let last = performance.now();

    const tick = (now: number) => {
      // Clamp long stalls (backgrounded window) so we never jump the playhead.
      const delta = Math.min((now - last) / 1000, 0.25);
      last = now;

      const state = useEditor.getState();
      const duration = projectDuration(state.project);
      const next = state.playhead + delta;

      if (duration <= 0) {
        state.pause();
        return;
      }

      if (next >= duration) {
        if (state.loopPlayback) {
          state.setPlayhead(0);
        } else {
          state.setPlayhead(duration);
          state.pause();
          return;
        }
      } else {
        state.setPlayhead(next);
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying]);
}
