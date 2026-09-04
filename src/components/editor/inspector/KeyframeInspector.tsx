import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { channelLabel } from '@/lib/channels';
import { formatTimecode, snapToFrame } from '@/lib/time';
import { Button } from '@/components/ui/Button';
import { useEditor } from '@/store/editorStore';
import { EASING_LABELS, type Keyframe, type KeyframeRef } from '@/types/animation';
import type { Clip } from '@/types/timeline';
import { Diamond } from './AnimatableRow';
import { EasingEditor } from './EasingEditor';

interface Resolved {
  ref: KeyframeRef;
  clip: Clip;
  keyframe: Keyframe;
}

/**
 * Everything about the selected keyframe: which property, when, what value,
 * and how it eases into the next one.
 *
 * After Effects puts the same four facts in front of you the moment a key is
 * selected, and they are exactly the four you reach for — the curve alone is
 * not enough to place a movement precisely.
 */
export function KeyframeInspector() {
  const project = useEditor((state) => state.project);
  const selected = useEditor((state) => state.selectedKeyframes);
  const setKeyframeValue = useEditor((state) => state.setKeyframeValue);
  const setKeyframeTimes = useEditor((state) => state.setKeyframeTimes);
  const removeKeyframes = useEditor((state) => state.removeKeyframes);
  const setPlayhead = useEditor((state) => state.setPlayhead);

  const resolved: Resolved[] = selected
    .map((ref) => {
      const clip = project?.clips.find((item) => item.id === ref.clipId);
      const keyframe = clip?.animation?.[ref.channel]?.find((item) => item.id === ref.id);
      return clip && keyframe ? { ref, clip, keyframe } : null;
    })
    .filter((entry): entry is Resolved => entry !== null);

  if (resolved.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-white/[0.09] bg-white/[0.012] px-3 py-3.5 text-[11px] leading-relaxed text-white/32">
        Cliquez une image clé — le losange sur le clip, ou dans les voies dépliées — pour voir et
        régler ses paramètres.
      </p>
    );
  }

  const single = resolved.length === 1 ? (resolved[0] as Resolved) : null;
  const fps = project?.settings.fps ?? 30;

  return (
    <div className="space-y-4">
      {single ? (
        <SingleKeyframe
          entry={single}
          fps={fps}
          onValue={(value) => setKeyframeValue([single.ref], value)}
          onTime={(time) => setKeyframeTimes([{ ref: single.ref, time }])}
          onSeek={(time) => setPlayhead(single.clip.start + time)}
        />
      ) : (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.022] px-3 py-2.5">
          <p className="text-2xs font-medium text-white/85">
            {resolved.length} images clés sélectionnées
          </p>
          <p className="mt-0.5 text-[10px] text-white/30">
            La courbe s’applique à toutes ; les valeurs se règlent une par une.
          </p>
        </div>
      )}

      <EasingEditor />

      <Button
        size="sm"
        variant="danger"
        block
        icon={<Trash2 size={12} strokeWidth={2} />}
        onClick={() => removeKeyframes(selected)}
      >
        Supprimer {resolved.length > 1 ? `les ${resolved.length} images clés` : 'l’image clé'}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SingleKeyframe({
  entry,
  fps,
  onValue,
  onTime,
  onSeek,
}: {
  entry: Resolved;
  fps: number;
  onValue(value: number): void;
  onTime(time: number): void;
  onSeek(time: number): void;
}) {
  const { clip, keyframe, ref } = entry;
  const siblings = clip.animation?.[ref.channel] ?? [];
  const index = siblings.findIndex((item) => item.id === keyframe.id);
  const previous = index > 0 ? siblings[index - 1] : null;
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.022] p-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-500/[0.16] text-accent-300">
          <Diamond filled className="h-3 w-3" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-2xs font-medium text-white/90">
            {channelLabel(clip, ref.channel)}
          </p>
          <p className="num mt-0.5 truncate text-[10px] text-white/28">
            {clip.label ?? 'Clip'} · image {index + 1} / {siblings.length} ·{' '}
            {EASING_LABELS[keyframe.easing.kind]}
          </p>
        </div>
        <span className="flex shrink-0 items-center">
          <button
            type="button"
            disabled={!previous}
            onClick={() => previous && onSeek(previous.time)}
            title="Image clé précédente"
            className="grid h-6 w-5 place-items-center text-white/25 transition-colors hover:text-white/70 disabled:opacity-25"
          >
            <ChevronLeft size={12} strokeWidth={2.4} />
          </button>
          <button
            type="button"
            disabled={!next}
            onClick={() => next && onSeek(next.time)}
            title="Image clé suivante"
            className="grid h-6 w-5 place-items-center text-white/25 transition-colors hover:text-white/70 disabled:opacity-25"
          >
            <ChevronRight size={12} strokeWidth={2.4} />
          </button>
        </span>
      </div>

      <NumberField
        label="Valeur"
        value={keyframe.value}
        step={0.01}
        onCommit={onValue}
      />
      <NumberField
        label="Temps"
        value={keyframe.time}
        step={1 / fps}
        suffix="s"
        hint={formatTimecode(clip.start + keyframe.time, fps)}
        onCommit={(time) => onTime(snapToFrame(Math.max(0, time), fps))}
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  step,
  suffix,
  hint,
  onCommit,
}: {
  label: string;
  value: number;
  step: number;
  suffix?: string;
  hint?: string;
  onCommit(value: number): void;
}) {
  const [draft, setDraft] = useState(String(Number(value.toFixed(3))));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(String(Number(value.toFixed(3))));
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const parsed = Number(draft.replace(',', '.'));
    if (Number.isFinite(parsed)) onCommit(parsed);
    else setDraft(String(Number(value.toFixed(3))));
  };

  return (
    <div className="flex h-9 items-center justify-between gap-3 rounded-lg px-2 transition-colors hover:bg-white/[0.025]">
      <span className="truncate text-2xs text-white/40">{label}</span>
      <div className="flex items-center gap-2">
        {hint && <span className="num text-[10px] text-white/22">{hint}</span>}
        <input
          value={draft}
          type="number"
          step={step}
          onFocus={() => setEditing(true)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              setDraft(String(Number(value.toFixed(3))));
              setEditing(false);
              event.currentTarget.blur();
            }
          }}
          className={cn(
            'num h-7 w-[86px] rounded-md border border-white/[0.07] bg-ink-900/70 px-1.5 text-right',
            'text-2xs text-white/85 transition-colors',
            'focus:border-accent-500/45 focus:outline-none',
          )}
        />
        {suffix && <span className="text-[10px] text-white/22">{suffix}</span>}
      </div>
    </div>
  );
}
