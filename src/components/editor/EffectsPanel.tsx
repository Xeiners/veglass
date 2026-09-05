import {
  Aperture,
  Blend,
  Contrast,
  Droplet,
  Eclipse,
  Info,
  Layers2,
  Moon,
  MousePointerClick,
  Palette,
  Sun,
  Waves,
  Sunrise,
  Sunset,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { useEditor } from '@/store/editorStore';
import { resolveClipAt } from '@/store/selectors';
import { EFFECTS, type EffectKind } from '@/types/effects';
import { TRANSITIONS, type TransitionKind } from '@/types/transitions';
import { EffectStack } from './effects/EffectStack';

export const TRANSITION_DND_TYPE = 'application/x-veglass-transition';

const EFFECT_ICON: Record<EffectKind, LucideIcon> = {
  brightness: Sun,
  contrast: Contrast,
  saturation: Droplet,
  blur: Aperture,
  hue: Palette,
  grayscale: Moon,
  invert: Eclipse,
  rgbsplit: Layers2,
  motionblur: Waves,
};

const TRANSITION_ICON: Record<TransitionKind, LucideIcon> = {
  crossfade: Blend,
  'dip-black': Sunset,
  'dip-white': Sunrise,
};

/**
 * The effects workspace.
 *
 * Catalogue and applied chain live side by side on purpose: you pick a filter
 * and its parameters appear immediately underneath, without the eye crossing
 * the window. The inspector on the right keeps what belongs to the clip itself
 * — placement, framing, sound.
 */
export function EffectsPanel() {
  const project = useEditor((state) => state.project);
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const addEffect = useEditor((state) => state.addEffect);
  const notify = useEditor((state) => state.notify);

  const playhead = useEditor((state) => state.playhead);
  const stored = project?.clips.find((item) => item.id === selectedClipId) ?? null;
  // The stack shows the values in force on this frame, animated ones included.
  const clip = stored ? resolveClipAt(stored, playhead) : null;
  const track = clip ? project?.tracks.find((item) => item.id === clip.trackId) : null;
  const canFilter = Boolean(clip && track?.kind === 'video');

  const applyEffect = (kind: EffectKind) => {
    if (!clip) {
      notify('Sélectionnez d’abord un clip sur la timeline');
      return;
    }
    if (!canFilter) {
      notify('Les filtres image ne s’appliquent qu’aux clips vidéo', 'error');
      return;
    }
    addEffect(clip.id, kind);
  };

  return (
    <section className="flex h-full min-h-0 flex-col">
      {/* Catalogue — pinned, so the way to add another filter never scrolls away. */}
      <div className="shrink-0 border-b border-white/[0.05] px-3 pb-3 pt-4">
        <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
          <h2 className="eyebrow">Filtres</h2>
          <span className="truncate text-[10px] text-white/28">
            {clip ? (clip.label ?? 'Clip sélectionné') : 'Aucun clip'}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          {EFFECTS.map((descriptor) => {
            const Icon = EFFECT_ICON[descriptor.kind];
            const applied =
              clip?.effects.filter((effect) => effect.kind === descriptor.kind).length ?? 0;
            return (
              <button
                key={descriptor.kind}
                type="button"
                onClick={() => applyEffect(descriptor.kind)}
                title={descriptor.hint}
                className={cn(
                  'group flex items-center gap-2 rounded-xl border px-2 py-1.5 text-left',
                  'transition-all duration-200 ease-smooth active:scale-[0.98]',
                  canFilter
                    ? 'border-white/[0.07] bg-white/[0.022] hover:border-accent-500/40 hover:bg-accent-500/[0.07]'
                    : 'border-white/[0.05] bg-white/[0.012] opacity-45',
                )}
              >
                <span
                  className={cn(
                    'grid h-6 w-6 shrink-0 place-items-center rounded-lg transition-colors',
                    applied > 0
                      ? 'bg-accent-500/[0.18] text-accent-300'
                      : 'bg-white/[0.05] text-white/45 group-hover:text-accent-300',
                  )}
                >
                  <Icon size={12} strokeWidth={2} />
                </span>
                <span className="min-w-0 flex-1 truncate text-2xs font-medium text-white/80">
                  {descriptor.label}
                </span>
                {applied > 0 && (
                  <span className="num shrink-0 rounded bg-accent-500/20 px-1 text-[9px] leading-[14px] text-accent-200">
                    {applied}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Applied chain, then the transition library. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3.5">
        <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
          <h2 className="eyebrow">Chaîne du clip</h2>
          {clip && clip.effects.length > 0 && (
            <span className="num text-[10px] text-white/28">{clip.effects.length}</span>
          )}
        </div>

        {clip && canFilter ? (
          <EffectStack clipId={clip.id} effects={clip.effects} />
        ) : (
          <p className="flex items-start gap-2 rounded-xl border border-dashed border-white/[0.09] bg-white/[0.012] px-3 py-3.5 text-[11px] leading-relaxed text-white/30">
            <MousePointerClick size={12} strokeWidth={2} className="mt-px shrink-0 text-white/22" />
            {clip
              ? 'Les filtres image ne s’appliquent qu’aux clips vidéo.'
              : 'Sélectionnez un clip sur la timeline, puis cliquez un filtre ci-dessus.'}
          </p>
        )}

        <div className="mb-2 mt-6 px-1">
          <h2 className="eyebrow">Transitions</h2>
        </div>

        <ul className="space-y-1.5">
          {TRANSITIONS.map((descriptor) => {
            const Icon = TRANSITION_ICON[descriptor.kind];
            return (
              <li key={descriptor.kind}>
                <div
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(TRANSITION_DND_TYPE, descriptor.kind);
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                  className={cn(
                    'group flex cursor-grab items-center gap-2.5 rounded-xl border p-2 active:cursor-grabbing',
                    'border-white/[0.07] bg-white/[0.022]',
                    'transition-all duration-200 ease-smooth',
                    'hover:border-accent-500/40 hover:bg-accent-500/[0.07]',
                  )}
                >
                  <span
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white/90"
                    style={{ backgroundImage: descriptor.swatch }}
                  >
                    <Icon size={14} strokeWidth={2.2} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-2xs font-medium text-white/85">
                      {descriptor.label}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-white/30">
                      {descriptor.hint}
                    </span>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>

        <p className="mt-3 flex items-start gap-2 rounded-xl border border-white/[0.05] bg-white/[0.015] px-2.5 py-2.5 text-[11px] leading-relaxed text-white/32">
          <Info size={12} strokeWidth={2} className="mt-px shrink-0 text-white/22" />
          Déposez une transition sur un point de coupe de la timeline. Le fondu au noir et au blanc
          acceptent aussi le tout début et la toute fin d’une piste.
        </p>
      </div>
    </section>
  );
}
