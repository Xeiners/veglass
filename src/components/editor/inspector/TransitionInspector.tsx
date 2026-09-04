import { Blend, Sunrise, Sunset, Trash2, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatTimecode } from '@/lib/time';
import { Button } from '@/components/ui/Button';
import { Slider } from '@/components/ui/Slider';
import { useEditor } from '@/store/editorStore';
import { resolveTransition } from '@/store/selectors';
import {
  MIN_TRANSITION_DURATION,
  TRANSITIONS,
  transitionDescriptor,
  type TransitionKind,
} from '@/types/transitions';

const ICON: Record<TransitionKind, LucideIcon> = {
  crossfade: Blend,
  'dip-black': Sunset,
  'dip-white': Sunrise,
};

export function TransitionInspector({ transitionId }: { transitionId: string }) {
  const project = useEditor((state) => state.project);
  const setTransitionKind = useEditor((state) => state.setTransitionKind);
  const setTransitionDuration = useEditor((state) => state.setTransitionDuration);
  const removeTransition = useEditor((state) => state.removeTransition);

  const transition = project?.transitions.find((item) => item.id === transitionId) ?? null;
  const resolved = project && transition ? resolveTransition(project, transition) : null;
  if (!project || !transition || !resolved) return null;

  const descriptor = transitionDescriptor(transition.kind);
  const fps = project.settings.fps;
  const junction = resolved.from !== null && resolved.to !== null;
  const nameOf = (clipId: string | null) => {
    const clip = project.clips.find((item) => item.id === clipId);
    return clip?.label ?? '—';
  };

  // A centred window spends half its length on each neighbour.
  const maxDuration = junction
    ? 2 * Math.min(resolved.from?.duration ?? 0, resolved.to?.duration ?? 0)
    : (resolved.from?.duration ?? resolved.to?.duration ?? 1);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.022] p-2.5">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white"
          style={{ backgroundImage: descriptor.swatch }}
        >
          {(() => {
            const Icon = ICON[transition.kind];
            return <Icon size={15} strokeWidth={2.2} />;
          })()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-2xs font-medium text-white/90">{descriptor.label}</p>
          <p className="num mt-0.5 truncate text-[10px] text-white/28">
            {resolved.track.name} · {junction ? 'point de coupe' : resolved.to ? 'ouverture' : 'fermeture'}
          </p>
        </div>
      </div>

      <div>
        <span className="eyebrow mb-2 block">Type</span>
        <div className="space-y-1.5">
          {TRANSITIONS.map((item) => {
            const Icon = ICON[item.kind];
            const disabled = item.requiresJunction && !junction;
            const active = item.kind === transition.kind;
            return (
              <button
                key={item.kind}
                type="button"
                disabled={disabled}
                onClick={() => setTransitionKind(transition.id, item.kind)}
                title={disabled ? 'Nécessite un plan de chaque côté' : item.hint}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left',
                  'transition-all duration-200 ease-smooth',
                  disabled && 'cursor-not-allowed opacity-35',
                  active
                    ? 'border-accent-500/45 bg-accent-500/[0.09]'
                    : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.14] hover:bg-white/[0.045]',
                )}
              >
                <span
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-white"
                  style={{ backgroundImage: item.swatch }}
                >
                  <Icon size={11} strokeWidth={2.4} />
                </span>
                <span className="min-w-0 flex-1 truncate text-2xs text-white/80">{item.label}</span>
                {active && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400" />}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="eyebrow">Durée</span>
          <span className="num text-2xs text-white/60">
            {(resolved.end - resolved.start).toFixed(2)} s
          </span>
        </div>
        <Slider
          aria-label="Durée de la transition"
          value={Math.min(transition.duration, Math.max(maxDuration, MIN_TRANSITION_DURATION))}
          min={MIN_TRANSITION_DURATION}
          max={Math.max(maxDuration, MIN_TRANSITION_DURATION * 2)}
          step={0.05}
          onChange={(value) => setTransitionDuration(transition.id, value)}
        />
        <p className="mt-2 text-[10px] leading-relaxed text-white/28">
          Glissez aussi le bloc hachuré sur la timeline pour ajuster la fenêtre.
        </p>
      </div>

      <div>
        <span className="eyebrow mb-2 block">Plans</span>
        <Row label="Sortant" value={junction || resolved.from ? nameOf(transition.fromClipId) : '—'} />
        <Row label="Entrant" value={resolved.to ? nameOf(transition.toClipId) : '—'} />
        <Row label="Début" value={formatTimecode(resolved.start, fps)} mono />
        <Row label="Coupe" value={formatTimecode(resolved.center, fps)} mono />
        <Row label="Fin" value={formatTimecode(resolved.end, fps)} mono />
      </div>

      <Button
        size="sm"
        variant="danger"
        block
        icon={<Trash2 size={12} strokeWidth={2} />}
        onClick={() => removeTransition(transition.id)}
      >
        Supprimer la transition
      </Button>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex h-8 items-center justify-between gap-3 rounded-lg px-2 transition-colors hover:bg-white/[0.025]">
      <span className="truncate text-2xs text-white/40">{label}</span>
      <span className={cn('truncate text-2xs text-white/55', mono && 'num')}>{value}</span>
    </div>
  );
}
