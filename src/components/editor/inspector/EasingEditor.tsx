import { useCallback, useMemo } from 'react';
import { Bookmark, Spline, Trash2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { useEditor } from '@/store/editorStore';
import {
  EASING_GROUPS,
  EASING_PRESETS,
  easeAt,
  easingOf,
  handlesOf,
  matchPreset,
  type BezierHandles,
  type Easing,
  type EasingPreset,
  type Keyframe,
  type KeyframeRef,
} from '@/types/animation';

const SIZE = 148;
const PAD = 16;

/**
 * Vertical span the thumbnails map to.
 *
 * The overshoot presets leave the 0–1 band by design, so every thumbnail is
 * drawn on the same wider scale: comparing shapes only works if they share one
 * frame of reference.
 */
const THUMB_LOW = -0.6;
const THUMB_HIGH = 1.6;

/** Sampled rather than emitted as a bézier path — `hold` is not a curve. */
function curvePath(easing: Easing, width: number, height: number, steps = 24): string {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps;
    const x = t * width;
    const y = height * (1 - (easeAt(easing, t) - THUMB_LOW) / (THUMB_HIGH - THUMB_LOW));
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

function PresetTile({
  preset,
  active,
  onSelect,
}: {
  preset: EasingPreset;
  active: boolean;
  onSelect(): void;
}) {
  const easing = easingOf(preset);
  return (
    <button
      type="button"
      onClick={onSelect}
      title={preset.label}
      className={cn(
        'group flex flex-col items-center gap-0.5 rounded-lg border p-1',
        'transition-all duration-200 ease-smooth active:scale-95',
        active
          ? 'border-accent-500/50 bg-accent-500/[0.12]'
          : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.16] hover:bg-white/[0.05]',
      )}
    >
      <svg viewBox="0 0 40 28" className="w-full" aria-hidden>
        <path
          d={curvePath(easing, 40, 28)}
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          className={active ? 'stroke-accent-200' : 'stroke-white/40 group-hover:stroke-white/75'}
        />
      </svg>
      <span
        className={cn(
          'w-full truncate text-center text-[9px] leading-tight',
          active ? 'text-accent-200' : 'text-white/35',
        )}
      >
        {preset.label.replace(' · ', ' ')}
      </span>
    </button>
  );
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Speed-curve editor for the selected keyframes.
 *
 * The curve maps progress-in-time (x) to progress-in-value (y): a straight line
 * is constant speed, a flat start is a slow départ. Dragging the two handles
 * switches the easing to `bezier`, because a preset that has been reshaped is
 * no longer that preset.
 */
export function EasingEditor() {
  const project = useEditor((state) => state.project);
  const selected = useEditor((state) => state.selectedKeyframes);
  const setKeyframeEasing = useEditor((state) => state.setKeyframeEasing);
  const removeKeyframes = useEditor((state) => state.removeKeyframes);
  const defaultEasing = useEditor((state) => state.defaultEasing);
  const setDefaultEasing = useEditor((state) => state.setDefaultEasing);

  const keyframes = useMemo(() => {
    if (!project) return [];
    return selected
      .map((ref) => {
        const clip = project.clips.find((item) => item.id === ref.clipId);
        const keyframe = clip?.animation?.[ref.channel]?.find((item) => item.id === ref.id);
        return keyframe ? { ref, keyframe } : null;
      })
      .filter((entry): entry is { ref: KeyframeRef; keyframe: Keyframe } => entry !== null);
  }, [project, selected]);

  const first = keyframes[0]?.keyframe;

  const applyHandles = useCallback(
    (handles: BezierHandles) => {
      setKeyframeEasing(selected, { kind: 'bezier', bezier: handles });
    },
    [selected, setKeyframeEasing],
  );

  const drag = useCallback(
    (index: 0 | 1, event: React.PointerEvent, base: BezierHandles) => {
      event.preventDefault();
      event.stopPropagation();
      const surface = (event.currentTarget as SVGElement).ownerSVGElement;
      if (!surface) return;
      const box = surface.getBoundingClientRect();

      // The svg is laid out at the panel's width while its coordinate system
      // stays `SIZE` wide, so screen pixels and viewBox units are *not* the
      // same thing. Converting between them is what the drag was missing.
      const unitX = box.width / SIZE;
      const unitY = box.height / SIZE;
      const plotX = (SIZE - PAD * 2) * unitX;
      const plotY = (SIZE - PAD * 2) * unitY;
      const originX = box.left + PAD * unitX;
      const originY = box.top + PAD * unitY;

      const onMove = (native: PointerEvent) => {
        const x = clamp01((native.clientX - originX) / (plotX || 1));
        // Y is inverted on screen, and allowed to overshoot for a bit of bounce.
        const raw = 1 - (native.clientY - originY) / (plotY || 1);
        const y = Math.max(-0.6, Math.min(1.6, raw));

        const handles: BezierHandles = [...base] as BezierHandles;
        handles[index * 2] = Number(x.toFixed(3));
        handles[index * 2 + 1] = Number(y.toFixed(3));
        applyHandles(handles);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [applyHandles],
  );

  if (keyframes.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-white/[0.09] bg-white/[0.012] px-3 py-3.5 text-[11px] leading-relaxed text-white/32">
        Cliquez une image clé — le losange sur la timeline, sous le clip déplié — pour choisir sa
        courbe de vitesse.
      </p>
    );
  }

  const easing: Easing = first?.easing ?? { kind: 'linear' };
  const handles = handlesOf(easing);
  const active = matchPreset(easing);
  const isDefault = matchPreset(defaultEasing)?.id === active?.id && active !== null;
  const toX = (value: number) => PAD + value * (SIZE - PAD * 2);
  const toY = (value: number) => SIZE - PAD - value * (SIZE - PAD * 2);

  // Sampled rather than drawn as a path: `hold` is not a bézier at all, and
  // sampling means the picture always matches the evaluator exactly.
  const path = Array.from({ length: 49 }, (_, index) => {
    const t = index / 48;
    return `${index === 0 ? 'M' : 'L'}${toX(t).toFixed(2)},${toY(easeAt(easing, t)).toFixed(2)}`;
  }).join(' ');

  return (
    <div className="space-y-2.5">
      {EASING_GROUPS.map((group) => {
        const presets = EASING_PRESETS.filter((preset) => preset.group === group);
        if (presets.length === 0) return null;
        return (
          <div key={group}>
            <span className="eyebrow mb-1.5 block">{group}</span>
            <div className="grid grid-cols-3 gap-1">
              {presets.map((preset) => (
                <PresetTile
                  key={preset.id}
                  preset={preset}
                  active={active?.id === preset.id}
                  onSelect={() => setKeyframeEasing(selected, easingOf(preset))}
                />
              ))}
            </div>
          </div>
        );
      })}

      <div>
        <span className="eyebrow mb-1.5 block">Réglage fin</span>

        <div className="rounded-xl border border-white/[0.07] bg-ink-900/60 p-1.5">
          <svg
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            className="block w-full"
            style={{ touchAction: 'none' }}
          >
            <rect
              x={PAD}
              y={PAD}
              width={SIZE - PAD * 2}
              height={SIZE - PAD * 2}
              fill="none"
              stroke="rgba(255,255,255,.07)"
            />
            <line
              x1={toX(0)}
              y1={toY(0)}
              x2={toX(1)}
              y2={toY(1)}
              stroke="rgba(255,255,255,.12)"
              strokeDasharray="3 4"
            />

            {easing.kind !== 'hold' && (
              <>
                <line
                  x1={toX(0)}
                  y1={toY(0)}
                  x2={toX(handles[0])}
                  y2={toY(handles[1])}
                  stroke="rgba(167,139,250,.5)"
                />
                <line
                  x1={toX(1)}
                  y1={toY(1)}
                  x2={toX(handles[2])}
                  y2={toY(handles[3])}
                  stroke="rgba(167,139,250,.5)"
                />
              </>
            )}

            <path d={path} fill="none" stroke="rgb(167 139 250)" strokeWidth={2} />

            {easing.kind !== 'hold' && (
              <>
                <circle
                  cx={toX(handles[0])}
                  cy={toY(handles[1])}
                  r={5}
                  className="cursor-grab fill-accent-200 active:cursor-grabbing"
                  onPointerDown={(event) => drag(0, event, handles)}
                />
                <circle
                  cx={toX(handles[2])}
                  cy={toY(handles[3])}
                  r={5}
                  className="cursor-grab fill-accent-200 active:cursor-grabbing"
                  onPointerDown={(event) => drag(1, event, handles)}
                />
              </>
            )}

            <circle cx={toX(0)} cy={toY(0)} r={2.5} fill="rgba(255,255,255,.35)" />
            <circle cx={toX(1)} cy={toY(1)} r={2.5} fill="rgba(255,255,255,.35)" />
          </svg>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setDefaultEasing(easing)}
        disabled={isDefault}
        title="Les prochaines images clés naîtront avec cette courbe"
        className={cn(
          'flex w-full items-center justify-center gap-1.5 rounded-lg border py-1.5',
          'text-[10px] transition-all duration-200 ease-smooth',
          isDefault
            ? 'border-accent-500/35 bg-accent-500/[0.08] text-accent-200/70'
            : 'border-white/[0.07] bg-white/[0.02] text-white/45 hover:border-white/[0.16] hover:text-white/80',
        )}
      >
        <Bookmark size={10} strokeWidth={2.2} />
        {isDefault ? 'Courbe par défaut' : 'Définir comme courbe par défaut'}
      </button>

      <div className="flex items-center justify-between gap-2">
        <span className="num flex items-center gap-1.5 text-[10px] text-white/30">
          <Spline size={11} strokeWidth={2} />
          {keyframes.length} sélectionnée{keyframes.length > 1 ? 's' : ''}
        </span>
        <Button
          size="sm"
          variant="danger"
          icon={<Trash2 size={11} strokeWidth={2} />}
          onClick={() => removeKeyframes(selected)}
        >
          Supprimer
        </Button>
      </div>
    </div>
  );
}
