import { Dices, Plus, X } from 'lucide-react';

import { cn } from '@/lib/cn';
import { useEditor } from '@/store/editorStore';
import { AnimatableRow } from './AnimatableRow';
import {
  BACKGROUNDS,
  BACKGROUND_RANGES,
  PALETTES,
  backgroundDescriptor,
  type BackgroundLayer,
} from '@/types/background';

/** How many accents a preset can usefully cycle before they stop being distinct. */
const MAX_COLORS = 5;

/**
 * Controls for a generated background.
 *
 * The order is the order the decisions are actually made: the look first, then
 * the palette — because choosing three colours that work together is the part
 * people get stuck on, so ready-made sets come before the pickers — and only
 * then the three numbers that tune it.
 */
export function BackgroundInspector({
  clipId,
  layer,
}: {
  clipId: string;
  layer: BackgroundLayer;
}) {
  const update = useEditor((state) => state.updateBackground);
  // What a double-click on a value restores: the look's own starting point.
  const defaults = backgroundDescriptor(layer.kind).preset;

  const setColor = (index: number, value: string) => {
    const colors = [...layer.colors];
    colors[index] = value;
    update(clipId, { colors });
  };

  return (
    <div className="space-y-5 pt-1">
      <Group title="Style">
        <div className="grid grid-cols-2 gap-1.5">
          {BACKGROUNDS.map((item) => (
            <button
              key={item.kind}
              type="button"
              onClick={() => update(clipId, { kind: item.kind })}
              title={item.hint}
              aria-pressed={layer.kind === item.kind}
              className={cn(
                'rounded-lg border px-2.5 py-2 text-left transition-all duration-200 ease-smooth',
                layer.kind === item.kind
                  ? 'border-accent-500/45 bg-accent-500/[0.1] text-white'
                  : 'border-white/[0.07] bg-white/[0.02] text-white/55 hover:border-white/[0.14] hover:text-white/85',
              )}
            >
              <span className="block text-2xs font-medium">{item.label}</span>
            </button>
          ))}
        </div>
      </Group>

      <Group
        title="Palette"
        action={
          <button
            type="button"
            onClick={() =>
              // A new layout rather than new colours: the seed is what decides
              // where the shapes sit, so this is the "I like these colours, not
              // this arrangement" control.
              update(clipId, { seed: Math.floor(Math.random() * 0xffffff) + 1 })
            }
            title="Redistribuer les formes"
            className="inline-flex items-center gap-1 text-[10px] text-white/35 transition-colors hover:text-white/75"
          >
            <Dices size={11} strokeWidth={2.2} />
            Redistribuer
          </button>
        }
      >
        <div className="flex flex-wrap gap-1.5">
          {PALETTES.map((palette) => {
            const active =
              palette.base === layer.base && palette.colors.join() === layer.colors.join();
            return (
              <button
                key={palette.id}
                type="button"
                onClick={() => update(clipId, { base: palette.base, colors: [...palette.colors] })}
                title={palette.label}
                aria-pressed={active}
                className={cn(
                  'flex h-7 items-center gap-0.5 rounded-lg border px-1.5 transition-all duration-200',
                  active
                    ? 'border-accent-400/60 bg-white/[0.06]'
                    : 'border-white/[0.08] hover:border-white/25',
                )}
              >
                {[palette.base, ...palette.colors].map((color, index) => (
                  <span
                    key={`${palette.id}-${index}`}
                    className="h-3.5 w-3.5 rounded-[3px] ring-1 ring-inset ring-white/10"
                    style={{ background: color }}
                  />
                ))}
              </button>
            );
          })}
        </div>

        <Swatch label="Fond" value={layer.base} onChange={(value) => update(clipId, { base: value })} />

        {layer.colors.map((color, index) => (
          <Swatch
            key={index}
            label={`Teinte ${index + 1}`}
            value={color}
            onChange={(value) => setColor(index, value)}
            onRemove={
              layer.colors.length > 2
                ? () => update(clipId, { colors: layer.colors.filter((_, at) => at !== index) })
                : undefined
            }
          />
        ))}

        {layer.colors.length < MAX_COLORS && (
          <button
            type="button"
            onClick={() =>
              update(clipId, {
                colors: [...layer.colors, layer.colors[layer.colors.length - 1] ?? '#FFFFFF'],
              })
            }
            className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/[0.12] text-2xs text-white/35 transition-colors hover:border-white/25 hover:text-white/70"
          >
            <Plus size={11} strokeWidth={2.4} />
            Ajouter une teinte
          </button>
        )}
      </Group>

      {/* Animatable, through the same rows the transform uses: the diamond is
          the stopwatch, and everything downstream — the keyframe lane, the
          curve editor, copy and paste — already works on any channel. */}
      <Group title="Réglages">
        <AnimatableRow
          clipId={clipId}
          channel="bg:speed"
          label="Vitesse"
          value={layer.speed}
          min={BACKGROUND_RANGES.speed.min}
          max={BACKGROUND_RANGES.speed.max}
          step={BACKGROUND_RANGES.speed.step}
          display={layer.speed <= 0 ? 'figé' : `${layer.speed.toFixed(2)}×`}
          defaultValue={defaults.speed}
        />
        <AnimatableRow
          clipId={clipId}
          channel="bg:scale"
          label="Taille"
          value={layer.scale}
          min={BACKGROUND_RANGES.scale.min}
          max={BACKGROUND_RANGES.scale.max}
          step={BACKGROUND_RANGES.scale.step}
          display={`${Math.round(layer.scale * 100)} %`}
          defaultValue={defaults.scale}
          scale={100}
        />
        <AnimatableRow
          clipId={clipId}
          channel="bg:intensity"
          label="Intensité"
          value={layer.intensity}
          min={BACKGROUND_RANGES.intensity.min}
          max={BACKGROUND_RANGES.intensity.max}
          step={BACKGROUND_RANGES.intensity.step}
          display={`${Math.round(layer.intensity * 100)} %`}
          defaultValue={defaults.intensity}
          scale={100}
        />
        <p className="px-2 pt-1 text-[10px] leading-relaxed text-white/30">
          Le losange anime la valeur, comme sur la transformation. Une vitesse à zéro fige le
          motif — l’export l’écrit alors comme une seule image au lieu d’une séquence.
        </p>
      </Group>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Group({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="eyebrow">{title}</span>
        {action}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Swatch({
  label,
  value,
  onChange,
  onRemove,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  onRemove?(): void;
}) {
  return (
    <div className="flex h-8 items-center gap-2 rounded-lg px-2 transition-colors hover:bg-white/[0.025]">
      <span className="flex-1 truncate text-2xs text-white/40">{label}</span>
      <span className="num text-[10px] uppercase text-white/25">{value}</span>
      <label
        className="h-5 w-8 shrink-0 cursor-pointer overflow-hidden rounded-md ring-1 ring-inset ring-white/15"
        style={{ background: value }}
      >
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className="h-full w-full cursor-pointer opacity-0"
          aria-label={label}
        />
      </label>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Retirer ${label}`}
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-white/25 transition-colors hover:bg-white/[0.07] hover:text-white/70"
        >
          <X size={11} strokeWidth={2.4} />
        </button>
      )}
    </div>
  );
}
