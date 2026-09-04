import { useCallback } from 'react';

import { useEditor } from '@/store/editorStore';
import type { Keyframe, KeyframeRef } from '@/types/animation';
import type { Clip } from '@/types/timeline';

/**
 * Dragging a keyframe, wherever it is drawn.
 *
 * The same gesture serves the lanes under an unfolded clip and the diamonds
 * drawn on the clip itself, so the two can never drift apart in behaviour.
 *
 * Origins are captured once at pointer-down and the drag then sets *absolute*
 * times: sending deltas instead would let frame snapping round each small
 * increment away to nothing and freeze the gesture.
 *
 * Touching a keyframe also parks the playhead on it, and the playhead then
 * follows it for the whole drag. A keyframe is a statement about one instant,
 * and you cannot judge it without seeing that instant in the viewer.
 */
export function useKeyframeDrag(pixelsPerSecond: number) {
  const selectKeyframes = useEditor((state) => state.selectKeyframes);
  const setKeyframeTimes = useEditor((state) => state.setKeyframeTimes);
  const setPlayhead = useEditor((state) => state.setPlayhead);

  return useCallback(
    (clip: Clip, channel: string, keyframe: Keyframe, event: React.PointerEvent) => {
      event.preventDefault();
      // Without this the clip underneath would start moving too.
      event.stopPropagation();

      const ref: KeyframeRef = { clipId: clip.id, channel, id: keyframe.id };
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      const already = useEditor
        .getState()
        .selectedKeyframes.some((item) => item.id === keyframe.id);

      // Dragging an unselected diamond takes the selection with it; dragging a
      // selected one moves the whole set.
      if (!already || additive) selectKeyframes([ref], additive);

      const store = useEditor.getState();
      const moving = additive || !already ? [ref] : store.selectedKeyframes;

      const origins = moving
        .map((item) => {
          const source = store.project?.clips.find((entry) => entry.id === item.clipId);
          const found = source?.animation?.[item.channel]?.find((k) => k.id === item.id);
          return found ? { ref: item, time: found.time } : null;
        })
        .filter((entry): entry is { ref: KeyframeRef; time: number } => entry !== null);

      const startX = event.clientX;
      document.body.style.cursor = 'ew-resize';
      setPlayhead(clip.start + keyframe.time);

      const onMove = (native: PointerEvent) => {
        const delta = (native.clientX - startX) / pixelsPerSecond;
        setKeyframeTimes(origins.map((entry) => ({ ref: entry.ref, time: entry.time + delta })));
        // Read the time back rather than reusing the requested one: the store
        // clamps to the clip and snaps to the frame grid, and the playhead has
        // to sit on the keyframe as it actually landed, not as it was asked for.
        const landed = useEditor
          .getState()
          .project?.clips.find((item) => item.id === clip.id)
          ?.animation?.[channel]?.find((item) => item.id === keyframe.id);
        if (landed) setPlayhead(clip.start + landed.time);
      };
      const onUp = () => {
        document.body.style.removeProperty('cursor');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [pixelsPerSecond, selectKeyframes, setKeyframeTimes, setPlayhead],
  );
}
