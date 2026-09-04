import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/cn';
import { snapToFrame } from '@/lib/time';
import { Slider } from '@/components/ui/Slider';
import { useEditor } from '@/store/editorStore';
import { isAnimated, type Keyframe } from '@/types/animation';

/**
 * The value read-out, editable in place.
 *
 * Click to type an exact figure — units are tolerated and stripped, so `400px`,
 * `400 px` and `400` all mean the same thing. Double-click restores the
 * property's default, which is the fastest way out of a bad experiment.
 */
function ValueField({
  display,
  value,
  scale,
  animated,
  onCommit,
  onReset,
}: {
  display: string;
  value: number;
  scale: number;
  animated: boolean;
  onCommit(value: number): void;
  onReset?(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (!editing) setDraft(String(Number((value * scale).toFixed(3))));
  }, [value, scale, editing]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(String(Number((value * scale).toFixed(3))));
          setEditing(true);
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          setEditing(false);
          onReset?.();
        }}
        title={onReset ? 'Cliquer pour saisir · double-clic pour la valeur par défaut' : 'Cliquer pour saisir'}
        className={cn(
          'num rounded px-1 text-[10px] transition-colors',
          'hover:bg-white/[0.08] hover:text-white',
          animated ? 'text-accent-200' : 'text-white/60',
        )}
      >
        {display}
      </button>
    );
  }

  const commit = () => {
    setEditing(false);
    // Anything that is not part of the number is treated as a unit and dropped.
    const cleaned = draft.replace(',', '.').replace(/[^\d.+-]/g, '');
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed) && cleaned !== '') onCommit(parsed / scale);
  };

  return (
    <input
      autoFocus
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setEditing(false);
          event.currentTarget.blur();
        }
      }}
      onFocus={(event) => event.currentTarget.select()}
      className={cn(
        'num h-5 w-[68px] rounded border border-accent-500/45 bg-ink-900/80 px-1 text-right',
        'text-[10px] text-white focus:outline-none',
      )}
    />
  );
}

/** Half a frame — the tolerance for "there is a key on this frame". */
const nearby = (fps: number) => 0.5 / Math.max(fps, 1);

export function Diamond({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 10 10" className={cn('h-2.5 w-2.5', className)} aria-hidden>
      <path
        d="M5 0.6 9.4 5 5 9.4 0.6 5Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A property row that can be animated.
 *
 * The diamond is the stopwatch: hollow means the property is a plain number,
 * outlined means it is animated but has no key on this frame, filled means it
 * does. Clicking cycles through exactly those three states, which is the
 * grammar every compositor uses.
 */
export function AnimatableRow({
  clipId,
  channel,
  label,
  value,
  min,
  max,
  step,
  display,
  disabled,
  defaultValue,
  scale = 1,
}: {
  clipId: string;
  channel: string;
  label: string;
  /** Already evaluated at the playhead by the caller. */
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  disabled?: boolean;
  /** Restored on double-click. */
  defaultValue?: number;
  /** Factor between the typed number and the stored one — 100 for percentages. */
  scale?: number;
}) {
  const project = useEditor((state) => state.project);
  const playhead = useEditor((state) => state.playhead);
  const setProperty = useEditor((state) => state.setProperty);
  const toggleChannel = useEditor((state) => state.toggleChannel);
  const addKeyframeAt = useEditor((state) => state.addKeyframeAt);
  const removeKeyframes = useEditor((state) => state.removeKeyframes);
  const selectKeyframes = useEditor((state) => state.selectKeyframes);
  const setPlayhead = useEditor((state) => state.setPlayhead);

  const clip = project?.clips.find((item) => item.id === clipId);
  const fps = project?.settings.fps ?? 30;
  const keyframes = clip?.animation?.[channel];
  const animated = isAnimated(keyframes);

  if (!clip) return null;

  const local = snapToFrame(playhead - clip.start, fps);
  const onFrame: Keyframe | undefined = keyframes?.find(
    (keyframe) => Math.abs(keyframe.time - local) < nearby(fps),
  );

  const previous = [...(keyframes ?? [])]
    .reverse()
    .find((keyframe) => keyframe.time < local - nearby(fps));
  const next = keyframes?.find((keyframe) => keyframe.time > local + nearby(fps));

  const cycle = () => {
    if (!animated) {
      toggleChannel(clipId, channel);
      return;
    }
    if (onFrame) {
      removeKeyframes([{ clipId, channel, id: onFrame.id }]);
      return;
    }
    addKeyframeAt(clipId, channel);
  };

  return (
    <div className={cn('px-2 py-1.5', disabled && 'pointer-events-none opacity-40')}>
      <div className="mb-1.5 flex items-center gap-1">
        <button
          type="button"
          onClick={cycle}
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (animated) toggleChannel(clipId, channel);
          }}
          title={
            animated
              ? onFrame
                ? 'Retirer l’image clé — double-clic : arrêter l’animation'
                : 'Ajouter une image clé ici — double-clic : arrêter l’animation'
              : 'Animer cette propriété'
          }
          className={cn(
            'grid h-5 w-5 shrink-0 place-items-center rounded transition-colors',
            animated
              ? onFrame
                ? 'text-accent-300 hover:bg-accent-500/[0.16]'
                : 'text-accent-300/55 hover:bg-accent-500/[0.12] hover:text-accent-300'
              : 'text-white/22 hover:bg-white/[0.07] hover:text-white/60',
          )}
        >
          <Diamond filled={Boolean(onFrame)} />
        </button>

        <span className="min-w-0 flex-1 truncate text-[10px] text-white/38">{label}</span>

        {animated && (
          <span className="flex items-center">
            <button
              type="button"
              disabled={!previous}
              onClick={() => previous && setPlayhead(clip.start + previous.time)}
              title="Image clé précédente"
              className="grid h-5 w-4 place-items-center text-white/25 transition-colors hover:text-white/70 disabled:opacity-25"
            >
              <ChevronLeft size={11} strokeWidth={2.4} />
            </button>
            <button
              type="button"
              disabled={!next}
              onClick={() => next && setPlayhead(clip.start + next.time)}
              title="Image clé suivante"
              className="grid h-5 w-4 place-items-center text-white/25 transition-colors hover:text-white/70 disabled:opacity-25"
            >
              <ChevronRight size={11} strokeWidth={2.4} />
            </button>
          </span>
        )}

        <ValueField
          display={display}
          value={value}
          scale={scale}
          animated={animated}
          onCommit={(next_) => setProperty(clipId, channel, next_)}
          onReset={
            defaultValue === undefined
              ? undefined
              : () => setProperty(clipId, channel, defaultValue, { label: `${label} par défaut` })
          }
        />
      </div>

      <Slider
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(next_) => {
          setProperty(clipId, channel, next_);
          if (onFrame) selectKeyframes([{ clipId, channel, id: onFrame.id }]);
        }}
      />
    </div>
  );
}
