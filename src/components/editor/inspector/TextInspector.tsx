import { AlignCenter, AlignLeft, AlignRight, Italic, Type } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Slider } from '@/components/ui/Slider';
import { IconButton } from '@/components/ui/Button';
import { useEditor } from '@/store/editorStore';
import { FONTS, fontOption, textBox, type TextAlign, type TextLayer } from '@/types/text';

const ALIGNMENTS: { id: TextAlign; icon: typeof AlignLeft; label: string }[] = [
  { id: 'left', icon: AlignLeft, label: 'Aligner à gauche' },
  { id: 'center', icon: AlignCenter, label: 'Centrer' },
  { id: 'right', icon: AlignRight, label: 'Aligner à droite' },
];

export function TextInspector({ clipId, layer }: { clipId: string; layer: TextLayer }) {
  const updateText = useEditor((state) => state.updateText);
  const weights = fontOption(layer.fontFamily).weights;

  const patch = (value: Partial<TextLayer>) => updateText(clipId, value);
  const box = textBox(layer);

  return (
    <div className="space-y-5">
      <Section title="Contenu">
        <textarea
          value={layer.content}
          onChange={(event) => patch({ content: event.target.value })}
          rows={3}
          placeholder="Votre texte…"
          className={cn(
            'w-full resize-y rounded-xl border border-white/[0.08] bg-ink-900/60 px-3 py-2',
            'text-[13px] leading-relaxed text-white placeholder:text-white/25',
            'transition-colors hover:border-white/[0.13]',
            'focus:border-accent-500/50 focus:outline-none',
          )}
        />
      </Section>

      <Section title="Police">
        <div className="space-y-1.5">
          <select
            value={layer.fontFamily}
            onChange={(event) => {
              const next = fontOption(event.target.value);
              // Keep the weight valid for the new family.
              const weight = next.weights.includes(layer.fontWeight)
                ? layer.fontWeight
                : (next.weights[next.weights.length - 1] ?? 400);
              patch({ fontFamily: next.id, fontWeight: weight });
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

          <div className="flex items-center gap-1.5">
            <select
              value={layer.fontWeight}
              onChange={(event) => patch({ fontWeight: Number(event.target.value) })}
              className={cn(
                'num h-8 flex-1 rounded-lg border border-white/[0.08] bg-ink-900/60 px-2',
                'text-2xs text-white/75 transition-colors',
                'hover:border-white/[0.13] focus:border-accent-500/50 focus:outline-none',
              )}
            >
              {weights.map((weight) => (
                <option key={weight} value={weight} className="bg-ink-850">
                  {weight}
                </option>
              ))}
            </select>

            <IconButton
              label="Italique"
              className="h-8 w-8"
              active={layer.italic}
              onClick={() => patch({ italic: !layer.italic })}
            >
              <Italic size={12} strokeWidth={2.2} />
            </IconButton>

            {ALIGNMENTS.map((item) => {
              const Icon = item.icon;
              return (
                <IconButton
                  key={item.id}
                  label={item.label}
                  className="h-8 w-8"
                  active={layer.align === item.id}
                  onClick={() => patch({ align: item.id })}
                >
                  <Icon size={12} strokeWidth={2.2} />
                </IconButton>
              );
            })}
          </div>
        </div>
      </Section>

      <Section title="Mise en forme">
        <NumberRow
          label="Corps"
          value={layer.fontSize}
          min={8}
          max={480}
          step={1}
          format={(value) => `${Math.round(value)} px`}
          onChange={(fontSize) => patch({ fontSize })}
        />
        <NumberRow
          label="Interligne"
          value={layer.lineHeight}
          min={0.7}
          max={2.5}
          step={0.01}
          format={(value) => value.toFixed(2)}
          onChange={(lineHeight) => patch({ lineHeight })}
        />
        <NumberRow
          label="Interlettrage"
          value={layer.letterSpacing}
          min={-0.12}
          max={0.5}
          step={0.005}
          format={(value) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)} %`}
          onChange={(letterSpacing) => patch({ letterSpacing })}
        />
        <ColorRow label="Couleur" value={layer.color} onChange={(color) => patch({ color })} />
      </Section>

      <Section title="Contour">
        <NumberRow
          label="Épaisseur"
          value={layer.stroke.width}
          min={0}
          max={24}
          step={0.5}
          format={(value) => `${value.toFixed(1)} px`}
          onChange={(width) => patch({ stroke: { ...layer.stroke, width } })}
        />
        {layer.stroke.width > 0 && (
          <ColorRow
            label="Couleur"
            value={layer.stroke.color}
            onChange={(color) => patch({ stroke: { ...layer.stroke, color } })}
          />
        )}
      </Section>

      <Section title="Fond">
        <NumberRow
          label="Opacité"
          value={box.opacity}
          min={0}
          max={1}
          step={0.01}
          format={(value) => `${Math.round(value * 100)} %`}
          onChange={(opacity) => patch({ box: { ...box, opacity } })}
        />
        {box.opacity > 0 && (
          <>
            <ColorRow
              label="Couleur"
              value={box.color}
              onChange={(color) => patch({ box: { ...box, color } })}
            />
            <NumberRow
              label="Marge horizontale"
              value={box.paddingX}
              min={0}
              max={160}
              step={1}
              format={(value) => `${Math.round(value)} px`}
              onChange={(paddingX) => patch({ box: { ...box, paddingX } })}
            />
            <NumberRow
              label="Marge verticale"
              value={box.paddingY}
              min={0}
              max={160}
              step={1}
              format={(value) => `${Math.round(value)} px`}
              onChange={(paddingY) => patch({ box: { ...box, paddingY } })}
            />
            <NumberRow
              label="Arrondi"
              value={box.radius}
              min={0}
              max={120}
              step={1}
              format={(value) => `${Math.round(value)} px`}
              onChange={(radius) => patch({ box: { ...box, radius } })}
            />
          </>
        )}
      </Section>

      <Section title="Ombre portée">
        <NumberRow
          label="Opacité"
          value={layer.shadow.opacity}
          min={0}
          max={1}
          step={0.01}
          format={(value) => `${Math.round(value * 100)} %`}
          onChange={(opacity) => patch({ shadow: { ...layer.shadow, opacity } })}
        />
        {layer.shadow.opacity > 0 && (
          <>
            <NumberRow
              label="Flou"
              value={layer.shadow.blur}
              min={0}
              max={120}
              step={1}
              format={(value) => `${Math.round(value)} px`}
              onChange={(blur) => patch({ shadow: { ...layer.shadow, blur } })}
            />
            <NumberRow
              label="Décalage X"
              value={layer.shadow.offsetX}
              min={-80}
              max={80}
              step={1}
              format={(value) => `${Math.round(value)} px`}
              onChange={(offsetX) => patch({ shadow: { ...layer.shadow, offsetX } })}
            />
            <NumberRow
              label="Décalage Y"
              value={layer.shadow.offsetY}
              min={-80}
              max={80}
              step={1}
              format={(value) => `${Math.round(value)} px`}
              onChange={(offsetY) => patch({ shadow: { ...layer.shadow, offsetY } })}
            />
            <ColorRow
              label="Couleur"
              value={layer.shadow.color}
              onChange={(color) => patch({ shadow: { ...layer.shadow, color } })}
            />
          </>
        )}
      </Section>

      <p className="flex items-start gap-2 rounded-xl border border-white/[0.05] bg-white/[0.015] px-2.5 py-2.5 text-[11px] leading-relaxed text-white/30">
        <Type size={12} strokeWidth={2} className="mt-px shrink-0 text-white/22" />
        Les tailles sont en pixels du projet ({'à'} sa résolution native), pas en pixels d{'’'}écran —
        le rendu final est identique {'à'} la preview.
      </p>
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
  format(value: number): string;
  onChange(value: number): void;
}) {
  return (
    <div className="px-2 py-1.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] text-white/38">{label}</span>
        <span className="num text-[10px] text-white/60">{format(value)}</span>
      </div>
      <Slider aria-label={label} value={value} min={min} max={max} step={step} onChange={onChange} />
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
    <div className="flex h-9 items-center justify-between gap-3 rounded-lg px-2 transition-colors hover:bg-white/[0.025]">
      <span className="text-2xs text-white/40">{label}</span>
      <div className="flex items-center gap-2">
        <input
          value={value.toUpperCase()}
          onChange={(event) => {
            const next = event.target.value.trim();
            // Only commit a complete hex triplet, so typing stays fluid.
            if (/^#[0-9a-fA-F]{6}$/.test(next)) onChange(next);
          }}
          className={cn(
            'num h-6 w-[74px] rounded-md border border-white/[0.07] bg-ink-900/70 px-1.5 text-right',
            'text-[10px] uppercase text-white/80 transition-colors',
            'focus:border-accent-500/45 focus:outline-none',
          )}
        />
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
    </div>
  );
}
