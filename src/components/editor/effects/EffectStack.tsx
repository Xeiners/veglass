import { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Cpu,
  Eye,
  EyeOff,
  RotateCcw,
  Trash2,
  Wand2,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { describeEffectChain, type EffectChain } from '@/lib/effectChain';
import { IconButton } from '@/components/ui/Button';
import { useEditor } from '@/store/editorStore';
import { effectDescriptor, isNeutral, type Effect } from '@/types/effects';
import { effectChannel } from '@/types/animation';
import { AnimatableRow } from '@/components/editor/inspector/AnimatableRow';

/**
 * The applied side of the effects workflow: the clip's filter chain, in order,
 * with live parameters. The footer shows the ffmpeg translation the render
 * engine produced — the same mapping the encoder will run.
 */
export function EffectStack({ clipId, effects }: { clipId: string; effects: Effect[] }) {
  const moveEffect = useEditor((state) => state.moveEffect);
  const removeEffect = useEditor((state) => state.removeEffect);
  const toggleEffect = useEditor((state) => state.toggleEffect);
  const resetEffect = useEditor((state) => state.resetEffect);
  const clearEffects = useEditor((state) => state.clearEffects);

  const [chain, setChain] = useState<EffectChain | null>(null);

  // Re-ask the engine whenever the stack changes; it is a pure mapping, so the
  // round-trip is cheap and always reflects what would actually be rendered.
  useEffect(() => {
    let cancelled = false;
    if (effects.length === 0) {
      setChain(null);
      return;
    }
    void describeEffectChain(effects).then((result) => {
      if (!cancelled) setChain(result);
    });
    return () => {
      cancelled = true;
    };
  }, [effects]);

  if (effects.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-white/[0.09] bg-white/[0.012] px-3 py-3.5 text-center text-[11px] leading-relaxed text-white/30">
        Aucun filtre — cliquez-en un ci-dessus.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {effects.map((effect, index) => {
        const descriptor = effectDescriptor(effect.kind);
        return (
          <div
            key={effect.id}
            className={cn(
              'rounded-xl border transition-colors duration-200',
              effect.enabled
                ? 'border-white/[0.07] bg-white/[0.022]'
                : 'border-white/[0.05] bg-white/[0.01] opacity-55',
            )}
          >
            <div className="flex items-center gap-1 px-2 py-1.5">
              <Wand2 size={11} strokeWidth={2.2} className="shrink-0 text-accent-300" />
              <span className="min-w-0 flex-1 truncate text-2xs font-medium text-white/80">
                {descriptor.label}
              </span>

              <IconButton
                label="Monter dans la chaîne"
                className="h-6 w-6"
                disabled={index === 0}
                onClick={() => moveEffect(clipId, effect.id, -1)}
              >
                <ArrowUp size={11} strokeWidth={2.2} />
              </IconButton>
              <IconButton
                label="Descendre dans la chaîne"
                className="h-6 w-6"
                disabled={index === effects.length - 1}
                onClick={() => moveEffect(clipId, effect.id, 1)}
              >
                <ArrowDown size={11} strokeWidth={2.2} />
              </IconButton>
              <IconButton
                label="Valeurs neutres"
                className="h-6 w-6"
                disabled={isNeutral(effect)}
                onClick={() => resetEffect(clipId, effect.id)}
              >
                <RotateCcw size={11} strokeWidth={2} />
              </IconButton>
              <IconButton
                label={effect.enabled ? 'Désactiver' : 'Activer'}
                className="h-6 w-6"
                active={!effect.enabled}
                onClick={() => toggleEffect(clipId, effect.id)}
              >
                {effect.enabled ? (
                  <Eye size={11} strokeWidth={2} />
                ) : (
                  <EyeOff size={11} strokeWidth={2} />
                )}
              </IconButton>
              <IconButton
                label="Retirer le filtre"
                tone="danger"
                className="h-6 w-6"
                onClick={() => removeEffect(clipId, effect.id)}
              >
                <Trash2 size={11} strokeWidth={2} />
              </IconButton>
            </div>

            <div className="space-y-0.5 pb-1.5">
              {descriptor.params.map((spec) => {
                const value = effect.params[spec.key] ?? spec.neutral;
                return (
                  <AnimatableRow
                    key={spec.key}
                    clipId={clipId}
                    channel={effectChannel(effect.id, spec.key)}
                    label={spec.label}
                    value={value}
                    min={spec.min}
                    max={spec.max}
                    step={spec.step}
                    display={spec.format(value)}
                    defaultValue={spec.neutral}
                    scale={spec.inputScale ?? 1}
                  />
                );
              })}
            </div>
          </div>
        );
      })}

      {chain && (
        <div className="rounded-xl border border-white/[0.06] bg-ink-900/60 p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5">
            <Cpu size={10} strokeWidth={2.2} className="text-accent-300" />
            <span className="eyebrow">
              Chaîne {chain.engine === 'rust' ? 'Rust' : 'TypeScript'}
            </span>
          </div>
          <code className="selectable block break-all font-mono text-[10px] leading-relaxed text-white/50">
            {chain.chain || '— aucun filtre actif —'}
          </code>
        </div>
      )}

      <button
        type="button"
        onClick={() => clearEffects(clipId)}
        className="w-full rounded-lg py-1.5 text-[10px] text-white/28 transition-colors hover:bg-white/[0.04] hover:text-white/60"
      >
        Tout retirer
      </button>
    </div>
  );
}
