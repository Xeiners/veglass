import { useEffect, useMemo, useState } from 'react';
import { Clapperboard, Gauge, Monitor } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { Field, Input, OptionCard } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { useEditor } from '@/store/editorStore';
import {
  DEFAULT_SETTINGS,
  FPS_PRESETS,
  RESOLUTION_PRESETS,
  type ProjectSettings,
} from '@/types/project';

export function NewProjectModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const createProject = useEditor((state) => state.createProject);
  const busy = useEditor((state) => state.busy);

  const [name, setName] = useState('');
  const [presetId, setPresetId] = useState('fhd');
  const [custom, setCustom] = useState({ width: 1920, height: 1080 });
  const [fps, setFps] = useState<number>(DEFAULT_SETTINGS.fps);

  useEffect(() => {
    if (!open) return;
    setName('');
    setPresetId('fhd');
    setCustom({ width: 1920, height: 1080 });
    setFps(DEFAULT_SETTINGS.fps);
  }, [open]);

  const settings: ProjectSettings = useMemo(() => {
    if (presetId === 'custom') {
      return {
        width: Math.max(16, Math.round(custom.width) || 1920),
        height: Math.max(16, Math.round(custom.height) || 1080),
        fps,
      };
    }
    const preset = RESOLUTION_PRESETS.find((item) => item.id === presetId) ?? RESOLUTION_PRESETS[1];
    return { width: preset.width, height: preset.height, fps };
  }, [presetId, custom, fps]);

  const submit = async () => {
    await createProject({ name, settings });
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nouveau projet"
      description="Définissez le format de la timeline. Ces réglages pilotent le cadrage de la preview et la grille temporelle."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={busy}
            icon={<Clapperboard size={15} strokeWidth={2.1} />}
          >
            {busy ? 'Création…' : 'Créer le projet'}
          </Button>
        </>
      }
    >
      <div className="space-y-6 pb-2">
        <Field label="Nom du projet">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Teaser produit — v1"
            maxLength={80}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
          />
        </Field>

        <div>
          <div className="mb-2 flex items-center gap-2">
            <Monitor size={13} strokeWidth={2} className="text-white/30" />
            <span className="eyebrow">Résolution</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {RESOLUTION_PRESETS.map((preset) => (
              <OptionCard
                key={preset.id}
                active={presetId === preset.id}
                onSelect={() => setPresetId(preset.id)}
                title={preset.label}
                subtitle={preset.hint}
                aside={<AspectGlyph width={preset.width} height={preset.height} />}
              />
            ))}
            <OptionCard
              active={presetId === 'custom'}
              onSelect={() => setPresetId('custom')}
              title="Sur mesure"
              subtitle={`${settings.width} × ${settings.height}`}
              aside={<AspectGlyph width={custom.width} height={custom.height} />}
            />
          </div>

          {presetId === 'custom' && (
            <div className="mt-3 grid animate-scale-in grid-cols-2 gap-2.5">
              <Field label="Largeur" hint="px">
                <Input
                  type="number"
                  min={16}
                  max={7680}
                  value={custom.width}
                  onChange={(event) =>
                    setCustom((prev) => ({ ...prev, width: Number(event.target.value) }))
                  }
                />
              </Field>
              <Field label="Hauteur" hint="px">
                <Input
                  type="number"
                  min={16}
                  max={4320}
                  value={custom.height}
                  onChange={(event) =>
                    setCustom((prev) => ({ ...prev, height: Number(event.target.value) }))
                  }
                />
              </Field>
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center gap-2">
            <Gauge size={13} strokeWidth={2} className="text-white/30" />
            <span className="eyebrow">Fréquence d'images</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {FPS_PRESETS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFps(value)}
                aria-pressed={fps === value}
                className={cn(
                  'num h-10 min-w-[74px] rounded-xl border px-3 text-[13px] font-medium',
                  'transition-all duration-200 ease-smooth active:scale-[0.97]',
                  fps === value
                    ? 'border-accent-500/45 bg-accent-500/[0.09] text-accent-200'
                    : 'border-white/[0.07] bg-white/[0.02] text-white/60 hover:border-white/[0.14] hover:bg-white/[0.045] hover:text-white/85',
                )}
              >
                {value % 1 === 0 ? value : value.toFixed(3)}
                <span className="ml-1 text-white/25">fps</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Miniature of the frame ratio — reads faster than the numbers alone. */
function AspectGlyph({ width, height }: { width: number; height: number }) {
  const ratio = height === 0 ? 16 / 9 : width / height;
  const box = 22;
  const w = ratio >= 1 ? box : box * ratio;
  const h = ratio >= 1 ? box / ratio : box;

  return (
    <span className="grid h-6 w-6 shrink-0 place-items-center">
      <span
        className="block rounded-[3px] border border-current opacity-45"
        style={{ width: `${w}px`, height: `${h}px` }}
      />
    </span>
  );
}
