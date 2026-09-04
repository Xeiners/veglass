import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';

import { cn } from '@/lib/cn';
import { useEditor } from '@/store/editorStore';
import type { Clip } from '@/types/timeline';

/** The layer's own box: centre in stage coordinates, size before rotation. */
interface Frame {
  cx: number;
  cy: number;
  width: number;
  height: number;
}

type Corner = 'nw' | 'ne' | 'se' | 'sw';

/**
 * Each corner sits on a diagonal; the axis angle is what decides which resize
 * cursor to show once the layer is rotated.
 */
const CORNERS: { id: Corner; style: string; axis: number }[] = [
  { id: 'nw', style: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2', axis: 45 },
  { id: 'ne', style: 'right-0 top-0 translate-x-1/2 -translate-y-1/2', axis: 135 },
  { id: 'se', style: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2', axis: 45 },
  { id: 'sw', style: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2', axis: 135 },
];

/** Cardinal angles worth landing on exactly. */
const CARDINALS = [0, 90, 180, 270, 360];
const SOFT_SNAP = 1.5;
const HANDLE_OFFSET = 22;

const normalise = (angle: number): number => ((angle % 360) + 360) % 360;

/** Shortest signed distance from `angle` to `target`, in degrees. */
const wrap = (delta: number): number => {
  let value = delta;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
};

function cursorFor(axis: number, rotation: number): string {
  const angle = normalise(axis + rotation) % 180;
  if (angle < 22.5 || angle >= 157.5) return 'ew-resize';
  if (angle < 67.5) return 'nwse-resize';
  if (angle < 112.5) return 'ns-resize';
  return 'nesw-resize';
}

/**
 * Bounding box and handles for the selected layer.
 *
 * The box is drawn in the layer's *own* rotated space rather than as an
 * axis-aligned rectangle: the handles stay welded to the real corners and the
 * rotation grip orbits with the object, instead of sliding around a box that
 * balloons as the angle changes.
 *
 * The size is measured from the DOM — the browser already knows text metrics
 * and image intrinsics, and re-deriving them would only be a second source of
 * truth to keep in sync.
 */
export function Gizmo({
  stageRef,
  clip,
  frameWidth,
  viewScale,
}: {
  stageRef: RefObject<HTMLDivElement | null>;
  clip: Clip;
  frameWidth: number;
  /** Screen pixels per stage pixel — 1 unless the viewer is rasterising small. */
  viewScale: number;
}) {
  /**
   * `setProperty`, not `updateClip`: on an animated channel the edit has to
   * become a keyframe under the playhead rather than overwrite a static field
   * the animation no longer reads. The store owns that decision, so dragging a
   * handle behaves exactly like typing in the inspector.
   */
  const setProperty = useEditor((state) => state.setProperty);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [gesture, setGesture] = useState<'idle' | 'scale' | 'rotate'>('idle');

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const node = stage.querySelector<HTMLElement>(`[data-clip-id="${clip.id}"]`);
    if (!node) {
      setFrame(null);
      return;
    }

    // `getBoundingClientRect` is the *rotated* envelope — right for the centre,
    // wrong for the size. `offsetWidth` is the layout box before any transform,
    // which is exactly the unrotated size once the scales are folded back in.
    const envelope = node.getBoundingClientRect();
    const origin = stage.getBoundingClientRect();
    const factor = clip.scale * viewScale;

    setFrame({
      cx: envelope.left - origin.left + envelope.width / 2,
      cy: envelope.top - origin.top + envelope.height / 2,
      width: (node.offsetWidth || envelope.width) * factor,
      height: (node.offsetHeight || envelope.height) * factor,
    });
  }, [
    stageRef,
    clip.id,
    clip.x,
    clip.y,
    clip.scale,
    clip.rotation,
    clip.text,
    frameWidth,
    viewScale,
  ]);

  const centreOnScreen = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !frame) return null;
    const origin = stage.getBoundingClientRect();
    return { x: origin.left + frame.cx, y: origin.top + frame.cy };
  }, [frame, stageRef]);

  /* ---------------------------------------------------------------- scale */

  const beginScale = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const centre = centreOnScreen();
      if (!centre) return;

      const start = Math.hypot(event.clientX - centre.x, event.clientY - centre.y);
      if (start < 4) return;
      const base = clip.scale;

      setGesture('scale');
      document.body.style.cursor = 'nwse-resize';

      const onMove = (native: PointerEvent) => {
        const distance = Math.hypot(native.clientX - centre.x, native.clientY - centre.y);
        const next = Math.max(0.05, Math.min(12, (base * distance) / start));
        setProperty(
          clip.id,
          'scale',
          native.shiftKey ? Math.round(next * 10) / 10 : Number(next.toFixed(3)),
          { label: `échelle:${clip.id}`, mode: 'coalesce' },
        );
      };
      const onUp = () => {
        setGesture('idle');
        document.body.style.removeProperty('cursor');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [centreOnScreen, clip.id, clip.scale, setProperty],
  );

  /* -------------------------------------------------------------- rotate */

  const beginRotate = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const centre = centreOnScreen();
      if (!centre) return;

      const angleOf = (x: number, y: number) =>
        (Math.atan2(y - centre.y, x - centre.x) * 180) / Math.PI;

      const base = clip.rotation;
      let previous = angleOf(event.clientX, event.clientY);
      let travelled = 0;

      setGesture('rotate');
      document.body.style.cursor = 'grabbing';

      const onMove = (native: PointerEvent) => {
        const current = angleOf(native.clientX, native.clientY);

        // Accumulate *wrapped* increments. Taking `current - start` directly
        // makes the layer jump a whole turn the moment the pointer crosses the
        // ±180° seam; this also lets the gesture wind past a full rotation.
        travelled += wrap(current - previous);
        previous = current;

        let next = base + travelled;

        if (native.shiftKey) {
          next = Math.round(next / 15) * 15;
        } else if (!native.altKey) {
          // A tight pull towards the cardinals — just enough to land square
          // without fighting the user anywhere else on the dial.
          const cardinal = CARDINALS.find(
            (value) => Math.abs(wrap(normalise(next) - value)) <= SOFT_SNAP,
          );
          if (cardinal !== undefined) next = cardinal;
        }

        setProperty(clip.id, 'rotation', Number(normalise(next).toFixed(1)), {
          label: `rotation:${clip.id}`,
          mode: 'coalesce',
        });
      };

      const onUp = () => {
        setGesture('idle');
        document.body.style.removeProperty('cursor');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [centreOnScreen, clip.id, clip.rotation, setProperty],
  );

  /* ---------------------------------------------------------------- draw */

  if (!frame) return null;

  const rotating = gesture === 'rotate';
  // Signed reading: −5° is easier to correct than 355°.
  const display = wrap(clip.rotation);

  return (
    <>
      {/* Radius guide, drawn under the box while the angle is being set. */}
      {rotating && (
        <div
          aria-hidden
          className="pointer-events-none absolute z-20"
          style={{
            left: frame.cx,
            top: frame.cy,
            width: Math.max(frame.width, frame.height) / 2 + HANDLE_OFFSET,
            height: 1,
            transformOrigin: 'left center',
            transform: `rotate(${clip.rotation - 90}deg)`,
            background:
              'repeating-linear-gradient(90deg, rgba(167,139,250,.85) 0 4px, transparent 4px 8px)',
          }}
        />
      )}

      <div
        className="pointer-events-none absolute z-20"
        style={{
          left: frame.cx,
          top: frame.cy,
          width: frame.width,
          height: frame.height,
          transform: `translate(-50%, -50%) rotate(${clip.rotation}deg)`,
          transformOrigin: 'center',
        }}
      >
        <div
          className={cn(
            'absolute inset-0 border shadow-[0_0_0_1px_rgba(13,15,18,.55)] transition-colors',
            gesture === 'idle' ? 'border-accent-300/90' : 'border-accent-200',
          )}
        />

        {CORNERS.map((corner) => (
          <span
            key={corner.id}
            onPointerDown={beginScale}
            style={{ cursor: cursorFor(corner.axis, clip.rotation) }}
            className={cn(
              'pointer-events-auto absolute h-2.5 w-2.5 rounded-[2px]',
              'border border-ink-950/70 bg-accent-200',
              corner.style,
            )}
          />
        ))}

        {/* The grip orbits with the layer, so it always reads as "the top". */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 w-px -translate-x-1/2 bg-accent-300/70"
          style={{ height: HANDLE_OFFSET, transform: 'translate(-50%, -100%)' }}
        />
        <span
          onPointerDown={beginRotate}
          onDoubleClick={(event) => {
            event.stopPropagation();
            setProperty(clip.id, 'rotation', 0, { label: 'rotation' });
          }}
          title="Pivoter — Maj : pas de 15° · Alt : libre · double-clic : remettre à plat"
          className={cn(
            'pointer-events-auto absolute left-1/2 top-0 h-3.5 w-3.5 rounded-full',
            'border border-ink-950/70 bg-accent-200 active:cursor-grabbing',
            rotating ? 'cursor-grabbing ring-2 ring-accent-300/40' : 'cursor-grab',
          )}
          style={{ transform: `translate(-50%, calc(-100% - ${HANDLE_OFFSET}px))` }}
        />

        {/* Read-outs are counter-rotated so they stay upright. */}
        {(rotating || clip.rotation !== 0 || clip.scale !== 1) && (
          <span
            className={cn(
              'num pointer-events-none absolute left-1/2 top-full mt-2 -translate-x-1/2',
              'whitespace-nowrap rounded bg-ink-950/85 px-1.5 py-0.5 text-[10px] backdrop-blur',
              rotating ? 'text-accent-200' : 'text-white/70',
            )}
            style={{ transform: `translate(-50%, 0) rotate(${-clip.rotation}deg)` }}
          >
            {rotating
              ? `${display > 0 ? '+' : ''}${display.toFixed(1)}°`
              : [
                  clip.scale !== 1 ? `${Math.round(clip.scale * 100)} %` : null,
                  clip.rotation !== 0 ? `${display.toFixed(1)}°` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </span>
        )}
      </div>
    </>
  );
}

/** Screen delta → project-pixel delta, shared by the stage drag. */
export const screenToProject = (delta: number, frameWidth: number, projectWidth: number): number =>
  frameWidth > 0 ? (delta * projectWidth) / frameWidth : delta;
