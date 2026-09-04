import { useMemo, useState } from 'react';

import { cn } from '@/lib/cn';
import { useDrag } from '@/hooks/useDrag';
import {
  anchorOf,
  cropWindow,
  fittedSize,
  keptArea,
  type Camera,
} from '@/lib/geometry';
import { previewFraming } from '@/lib/retarget';
import { useEditor } from '@/store/editorStore';
import { resolveClipAt } from '@/store/selectors';
import type { ProjectSettings } from '@/types/project';

/**
 * The framing tool, drawn over the picture.
 *
 * Three things at once, and they answer three different questions:
 *
 * * a **rule-of-thirds grid**, which is the only reason anyone opens a crop
 *   tool without a target format in mind;
 * * the **target frame**, when one is chosen — the rectangle that will survive
 *   the shift, so "how much am I losing" stops being a guess;
 * * a **handle**, which drags the subject rather than the picture. Moving the
 *   layer left to see something on the right is the inversion that makes crop
 *   tools infuriating, so here the grab follows the cursor.
 *
 * It reads the *same* geometry the export will use — `previewFraming` is the
 * function the real retarget calls — so what is drawn here is the result, not
 * an illustration of it.
 */
export function CropOverlay({
  target,
  unit,
  settings,
}: {
  /** The frame being aimed at, or `null` to just show the grid. */
  target: ProjectSettings | null;
  /** Screen pixels per project pixel. */
  unit: number;
  settings: ProjectSettings;
}) {
  const project = useEditor((state) => state.project);
  const playhead = useEditor((state) => state.playhead);
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const setClipAnchor = useEditor((state) => state.setClipAnchor);

  const [dragging, setDragging] = useState(false);

  const resolved = useMemo(() => {
    const clip = project?.clips.find((item) => item.id === selectedClipId) ?? null;
    if (!project || !clip || clip.kind !== 'media') return null;
    const asset = project.assets.find((item) => item.id === clip.assetId);
    if (!asset?.width || !asset.height) return null;
    return { clip, asset };
  }, [project, selectedClipId]);

  const geometry = useMemo(() => {
    if (!resolved || !project) return null;
    const fit = fittedSize(resolved.asset, settings);
    if (!fit) return null;

    // The framing on this frame, animation included — what the viewer is
    // actually showing, not the clip's static fallback.
    const shown = resolveClipAt(resolved.clip, playhead);
    const camera: Camera = { scale: shown.scale, x: shown.x, y: shown.y };

    const aimed = target
      ? previewFraming(resolved.clip, resolved.asset, settings, target)
      : camera;

    return {
      fit,
      camera,
      anchor: anchorOf(camera, fit),
      window: aimed ? cropWindow(aimed, fittedSize(resolved.asset, target ?? settings) ?? fit, target ?? settings) : null,
    };
  }, [resolved, project, playhead, settings, target]);

  const onPointerDown = useDrag({
    cursor: 'grabbing',
    onStart: () => setDragging(true),
    onMove: (state) => {
      if (!resolved || !geometry) return;
      // Cursor pixels → source fractions. Dividing by the *displayed* size of
      // the source is what makes the subject track the cursor exactly, at any
      // zoom: a pixel of travel on screen is a smaller fraction of a source
      // that has been enlarged.
      const shownWidth = geometry.camera.scale * geometry.fit.width * unit;
      const shownHeight = geometry.camera.scale * geometry.fit.height * unit;
      if (shownWidth <= 0 || shownHeight <= 0) return;

      setClipAnchor(resolved.clip.id, {
        x: geometry.anchor.x - state.dx / shownWidth,
        y: geometry.anchor.y - state.dy / shownHeight,
      });
    },
    onEnd: () => setDragging(false),
  });

  const kept = geometry?.window ? keptArea(geometry.window) : 1;

  return (
    <div
      className={cn(
        'absolute inset-0 z-10',
        resolved ? 'cursor-grab' : 'cursor-default',
        dragging && 'cursor-grabbing',
      )}
      onPointerDown={resolved ? onPointerDown : undefined}
    >
      {/* Thirds. Drawn thin and dim: it is a reference, not a subject. */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
        {[1, 2].map((index) => (
          <line
            key={`v${index}`}
            x1={`${(index * 100) / 3}%`}
            y1="0"
            x2={`${(index * 100) / 3}%`}
            y2="100%"
            stroke="rgba(255,255,255,.28)"
            strokeWidth="1"
          />
        ))}
        {[1, 2].map((index) => (
          <line
            key={`h${index}`}
            x1="0"
            y1={`${(index * 100) / 3}%`}
            x2="100%"
            y2={`${(index * 100) / 3}%`}
            stroke="rgba(255,255,255,.28)"
            strokeWidth="1"
          />
        ))}
      </svg>

      {target && <TargetFrame target={target} settings={settings} />}

      {!resolved && (
        <p className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-[11px] text-white/45">
          Sélectionnez un clip vidéo pour recadrer
        </p>
      )}

      {resolved && target && (
        <p className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-[11px] text-white/60">
          <span className="num rounded bg-ink-950/70 px-2 py-1">
            {Math.round(kept * 100)} % de l’image conservée · glissez pour recentrer
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * The rectangle that survives the shift.
 *
 * Drawn as a hole in a wash rather than as an outline: an outline says "here is
 * a box", a hole says "everything outside this is going", which is the fact
 * that matters. The wash is deliberately heavy enough to read at a glance and
 * light enough to still judge the picture through.
 */
function TargetFrame({ target, settings }: { target: ProjectSettings; settings: ProjectSettings }) {
  const current = settings.width / Math.max(1, settings.height);
  const wanted = target.width / Math.max(1, target.height);

  // The target frame, as a share of the frame on screen. The narrower of the
  // two ratios binds: a taller target loses width, a wider one loses height.
  const width = wanted <= current ? wanted / current : 1;
  const height = wanted <= current ? 1 : current / wanted;

  const inset = {
    left: `${((1 - width) / 2) * 100}%`,
    right: `${((1 - width) / 2) * 100}%`,
    top: `${((1 - height) / 2) * 100}%`,
    bottom: `${((1 - height) / 2) * 100}%`,
  };

  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {/* Four bands rather than a box-shadow: a shadow would be clipped by the
          frame's own overflow on some engines, and these are exact. */}
      <span className="absolute left-0 right-0 top-0 bg-ink-950/62" style={{ height: inset.top }} />
      <span className="absolute bottom-0 left-0 right-0 bg-ink-950/62" style={{ height: inset.bottom }} />
      <span
        className="absolute left-0 bg-ink-950/62"
        style={{ width: inset.left, top: inset.top, bottom: inset.bottom }}
      />
      <span
        className="absolute right-0 bg-ink-950/62"
        style={{ width: inset.right, top: inset.top, bottom: inset.bottom }}
      />
      <span
        className="absolute border border-accent-300/80"
        style={{ left: inset.left, right: inset.right, top: inset.top, bottom: inset.bottom }}
      />
    </div>
  );
}
