import { useCallback, useRef } from 'react';

export interface DragState {
  /** Cursor delta from the gesture origin, in pixels. */
  dx: number;
  dy: number;
  /** Current cursor position, in client coordinates. */
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
}

interface DragHandlers {
  onStart?(event: React.PointerEvent): void;
  onMove(state: DragState, event: PointerEvent): void;
  onEnd?(state: DragState): void;
  /** Applied to `document.body` for the duration of the gesture. */
  cursor?: string;
}

/**
 * Pointer-capture drag. Listeners live on `window` for the duration of the
 * gesture so the drag survives the cursor leaving the element — essential when
 * dragging a clip past the edge of the timeline viewport.
 */
export function useDrag({ onStart, onMove, onEnd, cursor }: DragHandlers) {
  const origin = useRef({ x: 0, y: 0 });
  const latest = useRef<DragState>({ dx: 0, dy: 0, x: 0, y: 0, shift: false, alt: false });

  return useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      origin.current = { x: event.clientX, y: event.clientY };
      latest.current = {
        dx: 0,
        dy: 0,
        x: event.clientX,
        y: event.clientY,
        shift: event.shiftKey,
        alt: event.altKey,
      };
      if (cursor) document.body.style.cursor = cursor;
      onStart?.(event);

      const handleMove = (native: PointerEvent) => {
        latest.current = {
          dx: native.clientX - origin.current.x,
          dy: native.clientY - origin.current.y,
          x: native.clientX,
          y: native.clientY,
          shift: native.shiftKey,
          alt: native.altKey,
        };
        onMove(latest.current, native);
      };

      const handleUp = () => {
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        window.removeEventListener('pointercancel', handleUp);
        document.body.style.removeProperty('cursor');
        onEnd?.(latest.current);
      };

      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleUp);
      window.addEventListener('pointercancel', handleUp);
    },
    [onStart, onMove, onEnd, cursor],
  );
}
