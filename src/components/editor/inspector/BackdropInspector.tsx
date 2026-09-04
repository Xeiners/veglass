import { Layers, Sparkles } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Slider } from '@/components/ui/Slider';
import { useEditor } from '@/store/editorStore';
import { coverFactor, fittedSize } from '@/lib/geometry';
import { BACKDROP_PRESETS, DEFAULT_BACKDROP, type Backdrop } from '@/types/backdrop';
import type { Clip } from '@/types/timeline';
import type { MediaAsset } from '@/types/media';

/**
 * The glass behind a floating clip.
 *
 * Deliberately opens with a plain statement of when it is worth having. A
 * backdrop is invisible on a clip that already fills the frame — every pixel of
 * it is behind the picture — and someone who turns it on there and sees nothing
 * concludes the feature is broken rather than that it had nothing to do.
 */
export function BackdropInspector({ clip, asset }: { clip: Clip; asset: MediaAsset | null }) {
  const settings = useEditor((state) => state.project?.settings);
  const setBackdrop = useEditor((state) => state.setBackdrop);
  const update = useEditor((state) => state.updateBackdrop);

  if (!settings) return null;

  const backdrop = clip.backdrop;
  const measured = asset?.width && asset.height ? asset : null;

  /*
   * Whether any of the glass would actually show.
   *
   * The picture covers the frame when it is scaled at or past the cover factor
   * *and* the two shapes match. Anything less leaves a margin, and the margin
   * is the whole point.
   */
  const fit = measured ? fittedSize(measured, settings) : null;
  const shows =
    fit !== null &&
    (clip.scale * fit.width < settings.width - 1 || clip.scale * fit.height < settings.height - 1);
  const cover = measured ? coverFactor(measured, settings) : 1;

  const patch = (value: Partial<Backdrop>) => update(clip.id, value);

  return (
    <div className="space-y-4">
      {!backdrop ? (
        <button
          type="button"
          onClick={() => setBackdrop(clip.id, DEFAULT_BACKDROP)}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left',
            'border-white/[0.07] bg-white/[0.022] transition-all duration-200',
            'hover:border-accent-500/40 hover:bg-accent-500/[0.06] active:scale-[0.99]',
          )}
        >
          <Sparkles size={13} strokeWidth={2} className="shrink-0 text-accent-300" />
          <span className="min-w-0 flex-1">
            <span className="block text-2xs font-medium text-white/85">Ajouter un fond flouté</span>
            <span className="mt-0.5 block text-[10px] leading-relaxed text-white/35">
              Une copie floutée et teintée de l’image, derrière elle
            </span>
          </span>
        </button>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-1.5">
            {BACKDROP_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                title={preset.hint}
                onClick={() => setBackdrop(clip.id, preset.backdrop)}
                className={cn(
                  'rounded-lg border px-2 py-1.5 text-2xs transition-all duration-200',
                  'border-white/[0.07] bg-white/[0.02] text-white/55',
                  'hover:border-accent-500/40 hover:text-white',
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <NumberRow
            label="Flou"
            value={backdrop.blur}
            min={0}
            max={120}
            step={1}
            format={(value) => `${Math.round(value)} px`}
            onChange={(blur) => patch({ blur })}
          />
          <NumberRow
            label="Teinte"
            value={backdrop.tintOpacity}
            min={0}
            max={1}
            step={0.02}
            format={(value) => `${Math.round(value * 100)} %`}
            onChange={(tintOpacity) => patch({ tintOpacity })}
          />
          <ColorRow
            label="Couleur"
            value={backdrop.tint}
            onChange={(tint) => patch({ tint })}
          />
          <NumberRow
            label="Débord"
            value={backdrop.zoom}
            min={1}
            max={1.4}
            step={0.01}
            format={(value) => `×${value.toFixed(2)}`}
            onChange={(zoom) => patch({ zoom })}
          />
          <p className="-mt-1 text-[10px] leading-relaxed text-white/28">
            Le débord donne au flou de la matière à étaler : sans lui, les bords de l’écran pâlissent.
          </p>

          <NumberRow
            label="Arrondi"
            value={backdrop.radius}
            min={0}
            max={80}
            step={1}
            format={(value) => `${Math.round(value)} px`}
            onChange={(radius) => patch({ radius })}
          />
          <NumberRow
            label="Ombre"
            value={backdrop.shadow.opacity}
            min={0}
            max={1}
            step={0.02}
            format={(value) => (value <= 0 ? 'aucune' : `${Math.round(value * 100)} %`)}
            onChange={(opacity) => patch({ shadow: { ...backdrop.shadow, opacity } })}
          />
          <NumberRow
            label="Diffusion"
            value={backdrop.shadow.blur}
            min={0}
            max={80}
            step={1}
            format={(value) => `${Math.round(value)} px`}
            onChange={(blur) => patch({ shadow: { ...backdrop.shadow, blur } })}
          />
          <NumberRow
            label="Décalage"
            value={backdrop.shadow.y}
            min={-40}
            max={60}
            step={1}
            format={(value) => `${Math.round(value)} px`}
            onChange={(y) => patch({ shadow: { ...backdrop.shadow, y } })}
          />

          <button
            type="button"
            onClick={() => setBackdrop(clip.id, null)}
            className="text-[10px] text-red-300/60 transition-colors hover:text-red-300"
          >
            Retirer le fond
          </button>
        </>
      )}

      {backdrop && !shows && (
        <p className="flex gap-1.5 rounded-xl border border-white/[0.07] bg-white/[0.022] px-3 py-2.5 text-[10px] leading-relaxed text-white/40">
          <Layers size={11} strokeWidth={2.2} className="mt-0.5 shrink-0" />
          <span>
            L’image remplit déjà le cadre : le fond est là mais entièrement caché derrière elle.
            Réduisez l’échelle sous {cover > 1.01 ? `×${cover.toFixed(2)}` : '×1'}, ou passez le
            projet dans un autre format, pour le voir.
          </span>
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

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
      <span className="w-24 shrink-0 text-2xs text-white/45">{label}</span>
      <Slider value={value} min={min} max={max} step={step} onChange={onChange} aria-label={label} />
      <span className="num w-14 shrink-0 text-right text-2xs text-white/60">{format(value)}</span>
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
      <span className="w-24 shrink-0 text-2xs text-white/45">{label}</span>
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
