import { useState } from 'react';

import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { useEditor } from '@/store/editorStore';
import {
  BANNER_PRESETS,
  bannerFromPreset,
  presetOption,
  type BannerPreset,
} from '@/types/banner';
import { BannerPreview } from './BannerPreview';

/**
 * The template picker.
 *
 * Three cards, each drawing the actual preset through the actual painter, plus
 * the two strings that are the whole content of a banner. Deliberately not a
 * dropdown of names: "Modern SaaS" and "Corporate" mean nothing until you have
 * seen them, and the difference between the three is entirely visual.
 *
 * The fields are seeded with each preset's own sample and only replaced when
 * the user has not typed anything — switching template to see what it looks
 * like must never eat a title someone has already written.
 */
export function BannerPicker() {
  const open = useEditor((state) => state.bannerPickerOpen);
  const setOpen = useEditor((state) => state.openBannerPicker);
  const addBanner = useEditor((state) => state.addBannerClip);
  const project = useEditor((state) => state.project);

  const [preset, setPreset] = useState<BannerPreset>('saas');
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');

  const sample = presetOption(preset).sample;
  const layer = bannerFromPreset(preset, {
    title: title.trim() || sample.title,
    subtitle: subtitle.trim() || sample.subtitle,
  });

  const submit = () => {
    addBanner(preset, {
      title: title.trim() || sample.title,
      subtitle: subtitle.trim() || sample.subtitle,
    });
    setTitle('');
    setSubtitle('');
    setOpen(false);
  };

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Habillage"
      description="Une bande titre posée sur sa propre piste, au-dessus de l’image, à la position de la tête de lecture."
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Annuler
          </Button>
          <Button variant="primary" disabled={!project} onClick={submit}>
            Ajouter
          </Button>
        </>
      }
    >
      <div className="space-y-5 pb-2">
        <div className="grid gap-2.5 sm:grid-cols-3">
          {BANNER_PRESETS.map((option) => {
            const active = option.id === preset;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setPreset(option.id)}
                aria-pressed={active}
                className={cn(
                  'group overflow-hidden rounded-xl border text-left transition-all duration-200',
                  'active:scale-[0.99]',
                  active
                    ? 'border-accent-500/50 bg-accent-500/[0.08]'
                    : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.16]',
                )}
              >
                {/* A neutral grey stands in for footage: a banner judged against
                    the panel's own background would look wrong over a video. */}
                <span className="block bg-[#2A2F38] px-2 py-2">
                  <BannerPreview
                    layer={bannerFromPreset(option.id, {
                      title: title.trim() || option.sample.title,
                      subtitle: subtitle.trim() || option.sample.subtitle,
                    })}
                    width={248}
                    height={88}
                    className="mx-auto block"
                  />
                </span>
                <span className="block px-3 py-2.5">
                  <span
                    className={cn(
                      'block text-[13px] font-medium',
                      active ? 'text-white' : 'text-white/80',
                    )}
                  >
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-2xs leading-relaxed text-white/35">
                    {option.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Titre">
            <Input
              value={title}
              placeholder={sample.title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit();
              }}
            />
          </Field>
          <Field
            label={layer.keycaps ? 'Touches' : 'Sous-titre'}
            hint={layer.keycaps ? 'séparées par +' : undefined}
          >
            <Input
              value={subtitle}
              placeholder={sample.subtitle}
              onChange={(event) => setSubtitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit();
              }}
            />
          </Field>
        </div>

        <p className="text-2xs leading-relaxed text-white/30">
          L’habillage arrive en glissant depuis son bord et repart en fondu — une animation faite de
          vraies images clés, modifiables ensuite dans l’éditeur de courbes comme n’importe quelle
          autre.
        </p>
      </div>
    </Modal>
  );
}
