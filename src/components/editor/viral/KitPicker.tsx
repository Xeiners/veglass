import { useState } from 'react';
import { Copy, Trash2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button, IconButton } from '@/components/ui/Button';
import { Slider } from '@/components/ui/Slider';
import { useStyleKits } from '@/store/styleStore';
import {
  POSITION_OPTIONS,
  kitLayer,
  kitText,
  type KitText,
  type StyleKit,
} from '@/types/styleKit';
import { FONTS, fontOption, hasBox, textBox, withAlpha } from '@/types/text';
import { SUBTITLE_ANIMATIONS } from '@/types/ai';

/** The frame every preview is drawn against, so kits compare like for like. */
const PREVIEW = { width: 1080, height: 1920, fps: 30 };
const PREVIEW_HEIGHT = 128;

/**
 * Brand kits — choosing one, and editing your own.
 *
 * The previews are drawn with the same `kitLayer` the generator uses, at the
 * same 9:16 frame, scaled down. That is the point: a swatch of colours would
 * say nothing about whether a caption is legible at that weight over that
 * plate, which is the only question being asked here.
 *
 * A built-in is never edited in place — it is the reference the copies come
 * from, and losing one to a stray slider would leave no way back. But the
 * controls are shown for it all the same, and the first change forks it: making
 * someone find a "duplicate" button before they can move their captions is how
 * a working setting comes to look broken.
 */
export function KitPicker() {
  const kits = useStyleKits((state) => state.kits);
  const selectedId = useStyleKits((state) => state.selectedId);
  const select = useStyleKits((state) => state.select);
  const duplicate = useStyleKits((state) => state.duplicate);
  const remove = useStyleKits((state) => state.remove);

  const selected = kits.find((kit) => kit.id === selectedId) ?? kits[0];

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        {kits.map((kit) => (
          <button
            key={kit.id}
            type="button"
            onClick={() => select(kit.id)}
            aria-pressed={kit.id === selectedId}
            className={cn(
              'group overflow-hidden rounded-xl border text-left transition-all duration-200',
              kit.id === selectedId
                ? 'border-accent-500/45 bg-accent-500/[0.09]'
                : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.14]',
            )}
          >
            <KitPreview kit={kit} />
            <span className="flex items-center gap-1.5 px-2.5 py-2">
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-2xs font-medium',
                  kit.id === selectedId ? 'text-white' : 'text-white/70',
                )}
              >
                {kit.name}
              </span>
              {!kit.builtIn && (
                <span className="shrink-0 rounded border border-white/[0.09] px-1 py-px text-[9px] text-white/35">
                  perso
                </span>
              )}
            </span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={<Copy size={12} strokeWidth={2} />}
            onClick={() => duplicate(selected.id)}
          >
            {selected.builtIn ? 'Dupliquer pour modifier' : 'Dupliquer'}
          </Button>
          {!selected.builtIn && (
            <IconButton label="Supprimer ce kit" onClick={() => remove(selected.id)}>
              <Trash2 size={13} strokeWidth={2} />
            </IconButton>
          )}
          {selected.builtIn && (
            <p className="text-[10px] leading-relaxed text-white/28">
              Modifier un kit fourni en crée automatiquement une copie.
            </p>
          )}
        </div>
      )}

      {selected && <KitEditor kit={selected} />}
    </div>
  );
}

/**
 * A 9:16 frame with the kit's caption and banner in place.
 *
 * `unit` converts project pixels to preview pixels, exactly as the real preview
 * does — so what is shown here is what lands on the timeline, at 1/15th scale.
 */
function KitPreview({ kit }: { kit: StyleKit }) {
  const unit = PREVIEW_HEIGHT / PREVIEW.height;
  const captions = kitLayer(kit.captions, PREVIEW);
  const hook = kitLayer(kit.hook, PREVIEW);

  return (
    <div
      className="relative w-full overflow-hidden bg-gradient-to-br from-ink-800 to-ink-950"
      style={{ height: PREVIEW_HEIGHT }}
    >
      <Sample layer={hook.text} y={hook.y} unit={unit} text={kitText(kit.hook, 'Le hook ici')} />
      <Sample
        layer={captions.text}
        y={captions.y}
        unit={unit}
        text={kitText(kit.captions, 'sous-titre')}
      />
    </div>
  );
}

function Sample({
  layer,
  y,
  unit,
  text,
}: {
  layer: ReturnType<typeof kitLayer>['text'];
  y: number;
  unit: number;
  text: string;
}) {
  const box = textBox(layer);

  return (
    <span
      className="absolute left-1/2 whitespace-nowrap"
      style={{
        top: '50%',
        transform: `translate(-50%, calc(-50% + ${y * unit}px))`,
        fontFamily: fontOption(layer.fontFamily).stack,
        fontSize: Math.max(5, layer.fontSize * unit),
        fontWeight: layer.fontWeight,
        letterSpacing: `${layer.letterSpacing}em`,
        lineHeight: layer.lineHeight,
        color: layer.color,
        padding: `${box.paddingY * unit}px ${box.paddingX * unit}px`,
        ...(hasBox(box)
          ? {
              backgroundColor: withAlpha(box.color, box.opacity),
              borderRadius: `${box.radius * unit}px`,
            }
          : {}),
        ...(layer.stroke.width > 0
          ? {
              WebkitTextStrokeWidth: `${Math.max(0.4, layer.stroke.width * unit)}px`,
              WebkitTextStrokeColor: layer.stroke.color,
              paintOrder: 'stroke fill',
            }
          : {}),
      }}
    >
      {text}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Editing one's own kit
 * ------------------------------------------------------------------ */

type Part = 'captions' | 'hook';

function KitEditor({ kit }: { kit: StyleKit }) {
  const update = useStyleKits((state) => state.update);
  const rename = useStyleKits((state) => state.rename);
  const duplicate = useStyleKits((state) => state.duplicate);
  const [part, setPart] = useState<Part>('captions');

  const current = kit[part];

  /**
   * The id an edit should land on.
   *
   * Touching a built-in forks it first. Hiding the controls behind a
   * "duplicate" button instead was a trap: someone who wants their captions at
   * the bottom sees no way to say so, and concludes the setting does not work.
   * Editing a shipped preset and getting your own copy is the behaviour every
   * other application with presets has.
   */
  const own = (): string => (kit.builtIn ? duplicate(kit.id) : kit.id);

  const patch = (value: Partial<KitText>) =>
    update(own(), (previous) => ({ ...previous, [part]: { ...previous[part], ...value } }));
  const patchPlate = (value: Partial<KitText['plate']>) =>
    patch({ plate: { ...current.plate, ...value } });

  return (
    <div className="space-y-4 rounded-xl border border-white/[0.07] bg-white/[0.015] p-3.5">
      {!kit.builtIn && (
        <input
          value={kit.name}
          onChange={(event) => rename(kit.id, event.target.value)}
          aria-label="Nom du kit"
          className={cn(
            'h-8 w-full rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5',
            'text-2xs text-white/85 transition-colors',
            'focus:border-accent-500/40 focus:bg-white/[0.04] focus:outline-none',
          )}
        />
      )}

      <div className="flex gap-1 rounded-lg bg-white/[0.03] p-1">
        {(
          [
            ['captions', 'Sous-titres'],
            ['hook', 'Accroche'],
          ] as [Part, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setPart(id)}
            className={cn(
              'flex-1 rounded-md px-2 py-1.5 text-2xs transition-colors',
              part === id ? 'bg-white/[0.09] text-white' : 'text-white/40 hover:text-white/70',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <Row label="Police">
        <select
          value={current.fontFamily}
          onChange={(event) => patch({ fontFamily: event.target.value })}
          className="h-7 w-full rounded-md border border-white/[0.07] bg-ink-850 px-2 text-2xs text-white/80 focus:outline-none"
        >
          {FONTS.map((font) => (
            <option key={font.id} value={font.id}>
              {font.label}
            </option>
          ))}
        </select>
      </Row>

      <Row label="Corps" value={`${Math.round(current.size * 1000) / 10} %`}>
        <Slider
          value={current.size}
          min={0.02}
          max={0.12}
          step={0.002}
          onChange={(size) => patch({ size })}
          aria-label="Corps"
        />
      </Row>

      <Row label="Graisse" value={String(current.weight)}>
        <Slider
          value={current.weight}
          min={300}
          max={900}
          step={100}
          onChange={(weight) => patch({ weight: Math.round(weight) })}
          aria-label="Graisse"
        />
      </Row>

      <Row label="Couleur du texte">
        <Colour value={current.color} onChange={(color) => patch({ color })} />
      </Row>

      <Row label="Contour" value={`${Math.round(current.strokeWidth * 100)} %`}>
        <Slider
          value={current.strokeWidth}
          min={0}
          max={0.14}
          step={0.005}
          onChange={(strokeWidth) => patch({ strokeWidth })}
          aria-label="Contour"
        />
      </Row>
      {current.strokeWidth > 0 && (
        <Row label="Couleur du contour">
          <Colour value={current.strokeColor} onChange={(strokeColor) => patch({ strokeColor })} />
        </Row>
      )}

      <Row label="Fond" value={`${Math.round(current.plate.opacity * 100)} %`}>
        <Slider
          value={current.plate.opacity}
          min={0}
          max={1}
          step={0.02}
          onChange={(opacity) => patchPlate({ opacity })}
          aria-label="Opacité du fond"
        />
      </Row>
      {current.plate.opacity > 0 && (
        <>
          <Row label="Couleur du fond">
            <Colour value={current.plate.color} onChange={(color) => patchPlate({ color })} />
          </Row>
          <Row label="Arrondi" value={`${Math.round(current.plate.radius * 100)} %`}>
            <Slider
              value={current.plate.radius}
              min={0}
              max={0.5}
              step={0.02}
              onChange={(radius) => patchPlate({ radius })}
              aria-label="Arrondi"
            />
          </Row>
        </>
      )}

      <Row label="Position">
        <div className="flex gap-1">
          {POSITION_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => patch({ position: option.id })}
              className={cn(
                'flex-1 rounded-md border px-2 py-1 text-[10px] transition-colors',
                current.position === option.id
                  ? 'border-accent-500/45 bg-accent-500/[0.1] text-white'
                  : 'border-white/[0.07] text-white/40 hover:text-white/70',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </Row>

      <Row label="Majuscules">
        <button
          type="button"
          role="switch"
          aria-checked={current.uppercase}
          onClick={() => patch({ uppercase: !current.uppercase })}
          className={cn(
            'relative h-[16px] w-7 rounded-full transition-colors',
            current.uppercase ? 'bg-accent-500' : 'bg-white/[0.14]',
          )}
        >
          <span
            className={cn(
              'absolute top-[3px] h-2.5 w-2.5 rounded-full bg-white transition-[left] duration-200',
              current.uppercase ? 'left-[15px]' : 'left-[3px]',
            )}
          />
        </button>
      </Row>

      {part === 'captions' && (
        <Row label="Animation">
          <select
            value={kit.animation}
            onChange={(event) =>
              update(own(), (previous) => ({
                ...previous,
                animation: event.target.value as StyleKit['animation'],
              }))
            }
            className="h-7 w-full rounded-md border border-white/[0.07] bg-ink-850 px-2 text-2xs text-white/80 focus:outline-none"
          >
            {SUBTITLE_ANIMATIONS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Row>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-[13ch] shrink-0 text-2xs text-white/40">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {value && <span className="num w-[5ch] shrink-0 text-right text-[10px] text-white/28">{value}</span>}
    </div>
  );
}

function Colour({ value, onChange }: { value: string; onChange(value: string): void }) {
  return (
    <label className="flex items-center gap-2">
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-6 w-9 cursor-pointer rounded border border-white/[0.1] bg-transparent p-0"
      />
      <span className="num text-[10px] uppercase text-white/30">{value}</span>
    </label>
  );
}
