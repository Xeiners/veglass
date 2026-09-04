import { AlignLeft, AlignRight, Keyboard } from 'lucide-react';

import { cn } from '@/lib/cn';
import { IconButton } from '@/components/ui/Button';
import { Slider } from '@/components/ui/Slider';
import { BannerPreview } from '@/components/editor/banner/BannerPreview';
import { useEditor } from '@/store/editorStore';
import {
  BANNER_PRESETS,
  keysOf,
  type BannerLayer,
  type BannerSide,
} from '@/types/banner';
import { FONTS, fontOption } from '@/types/text';
import { DEFAULT_SETTINGS } from '@/types/project';

const SIDES: { id: BannerSide; icon: typeof AlignLeft; label: string }[] = [
  { id: 'left', icon: AlignLeft, label: 'Bord gauche' },
  { id: 'right', icon: AlignRight, label: 'Bord droit' },
];

/**
 * The banner's own controls.
 *
 * Shaped like `TextInspector` next door, with one addition that earns its
 * space: a live preview at the top. A banner is nine colours and six
 * proportions, and judging a change to any of them from a numeric field alone
 * is guesswork — especially when the layer is off-screen at the playhead, which
 * for a chapter banner is most of the time.
 *
 * Changing the template goes through `setBannerPreset` rather than a spread of
 * patches, because re-dressing has to keep the two strings the user wrote.
 */
export function BannerInspector({ clipId, layer }: { clipId: string; layer: BannerLayer }) {
  const update = useEditor((state) => state.updateBanner);
  const setPreset = useEditor((state) => state.setBannerPreset);
  const settings = useEditor((state) => state.project?.settings) ?? DEFAULT_SETTINGS;

  const patch = (value: Partial<BannerLayer>) => update(clipId, value);
  const weights = fontOption(layer.fontFamily).weights;

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-[#2A2F38]">
        <BannerPreview layer={layer} width={252} height={92} settings={settings} className="mx-auto block" />
      </div>

      <Section title="Modèle">
        <div className="grid grid-cols-3 gap-1.5">
          {BANNER_PRESETS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setPreset(clipId, option.id)}
              aria-pressed={layer.preset === option.id}
              title={option.hint}
              className={cn(
                'rounded-lg border px-2 py-1.5 text-2xs transition-all duration-200',
                layer.preset === option.id
                  ? 'border-accent-500/45 bg-accent-500/[0.1] text-white'
                  : 'border-white/[0.07] bg-white/[0.02] text-white/55 hover:border-white/[0.14]',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Contenu">
        <input
          value={layer.title}
          placeholder="Titre"
          onChange={(event) => patch({ title: event.target.value })}
          className={cn(
            'h-9 w-full rounded-lg border border-white/[0.08] bg-ink-900/60 px-2.5',
            'text-2xs text-white placeholder:text-white/25 transition-colors',
            'hover:border-white/[0.13] focus:border-accent-500/50 focus:outline-none',
          )}
        />
        <input
          value={layer.subtitle}
          placeholder={layer.keycaps ? 'Ctrl + S' : 'Sous-titre'}
          onChange={(event) => patch({ subtitle: event.target.value })}
          className={cn(
            'h-9 w-full rounded-lg border border-white/[0.08] bg-ink-900/60 px-2.5',
            'text-2xs text-white placeholder:text-white/25 transition-colors',
            'hover:border-white/[0.13] focus:border-accent-500/50 focus:outline-none',
          )}
        />

        <Toggle
          checked={layer.keycaps}
          onChange={(keycaps) => patch({ keycaps })}
          icon={<Keyboard size={11} strokeWidth={2.2} />}
          label="Touches clavier"
          hint={
            layer.keycaps
              ? `${keysOf(layer.subtitle).length} touche${keysOf(layer.subtitle).length > 1 ? 's' : ''}, séparées par +`
              : 'Le sous-titre est dessiné en touches'
          }
        />
        {!layer.keycaps && (
          <Toggle
            checked={layer.uppercaseSubtitle}
            onChange={(uppercaseSubtitle) => patch({ uppercaseSubtitle })}
            label="Sous-titre en capitales"
            hint="Le titre n’est jamais transformé"
          />
        )}
      </Section>

      <Section title="Police">
        <select
          value={layer.fontFamily}
          onChange={(event) => {
            const next = fontOption(event.target.value);
            // Keep both weights valid for the new family.
            const keep = (weight: number) =>
              next.weights.includes(weight) ? weight : (next.weights[next.weights.length - 1] ?? 400);
            patch({
              fontFamily: next.id,
              titleWeight: keep(layer.titleWeight),
              subtitleWeight: keep(layer.subtitleWeight),
            });
          }}
          className={cn(
            'h-9 w-full rounded-lg border border-white/[0.08] bg-ink-900/60 px-2.5',
            'text-2xs text-white/85 transition-colors',
            'hover:border-white/[0.13] focus:border-accent-500/50 focus:outline-none',
          )}
        >
          {FONTS.map((font) => (
            <option key={font.id} value={font.id} className="bg-ink-850">
              {font.label}
            </option>
          ))}
        </select>

        <select
          value={layer.titleWeight}
          onChange={(event) => patch({ titleWeight: Number(event.target.value) })}
          className={cn(
            'num h-8 w-full rounded-lg border border-white/[0.08] bg-ink-900/60 px-2',
            'text-2xs text-white/75 transition-colors',
            'hover:border-white/[0.13] focus:border-accent-500/50 focus:outline-none',
          )}
        >
          {weights.map((weight) => (
            <option key={weight} value={weight} className="bg-ink-850">
              Titre · {weight}
            </option>
          ))}
        </select>

        {/* A fraction of the frame height, not a pixel count — the same bargain
            `types/styleKit` strikes, and what makes one banner read the same on
            a 720p draft and a 4K master. */}
        <NumberRow
          label="Taille"
          value={layer.size}
          min={0.018}
          max={0.09}
          step={0.002}
          format={(value) => `${Math.round(value * Math.max(settings.height, 240))} px`}
          onChange={(size) => patch({ size })}
        />
        <NumberRow
          label="Sous-titre"
          value={layer.subtitleRatio}
          min={0.3}
          max={1}
          step={0.02}
          format={(value) => `${Math.round(value * 100)} %`}
          onChange={(subtitleRatio) => patch({ subtitleRatio })}
        />
      </Section>

      <Section title="Couleurs">
        <ColorRow label="Titre" value={layer.titleColor} onChange={(titleColor) => patch({ titleColor })} />
        <ColorRow
          label="Sous-titre"
          value={layer.subtitleColor}
          onChange={(subtitleColor) => patch({ subtitleColor })}
        />
        <ColorRow label="Fond" value={layer.plateColor} onChange={(plateColor) => patch({ plateColor })} />
        <NumberRow
          label="Opacité du fond"
          value={layer.plateOpacity}
          min={0}
          max={1}
          step={0.02}
          format={(value) => `${Math.round(value * 100)} %`}
          onChange={(plateOpacity) => patch({ plateOpacity })}
        />
        <ColorRow
          label="Accent"
          value={layer.accentColor}
          onChange={(accentColor) => patch({ accentColor })}
        />
        <NumberRow
          label="Barre d’accent"
          value={layer.accentWidth}
          min={0}
          max={0.3}
          step={0.01}
          format={(value) => (value <= 0 ? 'aucune' : `${Math.round(value * 100)} %`)}
          onChange={(accentWidth) => patch({ accentWidth })}
        />
        <ColorRow
          label="Filet"
          value={layer.borderColor}
          onChange={(borderColor) => patch({ borderColor })}
        />
        <NumberRow
          label="Épaisseur du filet"
          value={layer.borderWidth}
          min={0}
          max={0.09}
          step={0.004}
          format={(value) => (value <= 0 ? 'aucun' : `${Math.round(value * 100)} %`)}
          onChange={(borderWidth) => patch({ borderWidth })}
        />
        <NumberRow
          label="Arrondi"
          value={layer.radius}
          min={0}
          max={0.6}
          step={0.02}
          format={(value) => `${Math.round(value * 100)} %`}
          onChange={(radius) => patch({ radius })}
        />
      </Section>

      <Section title="Bord">
        <div className="flex items-center gap-1">
          {SIDES.map((side) => {
            const Icon = side.icon;
            return (
              <IconButton
                key={side.id}
                label={side.label}
                active={layer.side === side.id}
                onClick={() => patch({ side: side.id })}
              >
                <Icon size={13} strokeWidth={2} />
              </IconButton>
            );
          })}
          <span className="ml-2 text-[10px] leading-tight text-white/30">
            Le côté décide aussi d’où l’habillage arrive.
          </span>
        </div>
      </Section>

      <Section title="Arrivée">
        <NumberRow
          label="Durée"
          value={layer.entrance}
          min={0}
          max={1.2}
          step={0.02}
          format={(value) => (value <= 0 ? 'immédiate' : `${value.toFixed(2)} s`)}
          onChange={(entrance) => patch({ entrance })}
        />
        <NumberRow
          label="Glissement"
          value={layer.travel}
          min={0}
          max={1}
          step={0.02}
          format={(value) => `${Math.round(value * 100)} %`}
          onChange={(travel) => patch({ travel })}
        />
        <p className="pt-1 text-[10px] leading-relaxed text-white/28">
          Ces réglages décrivent l’arrivée voulue ; les images clés déjà posées sur ce calque ne sont
          pas réécrites. Utilisez « Recomposer l’arrivée » dans le menu contextuel pour les refaire.
        </p>
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="eyebrow mb-2 block">{title}</span>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function NumberRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange(value: number): void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg px-1 py-1">
      <span className="w-28 shrink-0 text-2xs text-white/45">{label}</span>
      <Slider value={value} min={min} max={max} step={step} onChange={onChange} aria-label={label} />
      <span className="num w-16 shrink-0 text-right text-2xs text-white/60">{format(value)}</span>
    </div>
  );
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg px-1 py-1">
      <span className="w-28 shrink-0 text-2xs text-white/45">{label}</span>
      <span className="num flex-1 text-2xs text-white/35">{value.toUpperCase()}</span>
      <label className="relative h-6 w-8 cursor-pointer overflow-hidden rounded-md ring-1 ring-white/15">
        <span className="absolute inset-0" style={{ backgroundColor: value }} />
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className="absolute inset-0 cursor-pointer opacity-0"
          aria-label={label}
        />
      </label>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  icon,
}: {
  checked: boolean;
  onChange(value: boolean): void;
  label: string;
  hint: string;
  icon?: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 transition-colors hover:border-white/[0.12]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent-500"
      />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-2xs font-medium text-white/80">
          {icon}
          {label}
        </span>
        <span className="mt-0.5 block text-[10px] leading-relaxed text-white/35">{hint}</span>
      </span>
    </label>
  );
}
