import { Crop, Frame, RotateCcw } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Slider } from '@/components/ui/Slider';
import { anchorOf, cropWindow, fittedSize, keptArea } from '@/lib/geometry';
import { previewFraming } from '@/lib/retarget';
import { useEditor } from '@/store/editorStore';
import { resolveClipAt } from '@/store/selectors';
import { CENTRE } from '@/types/geometry';
import { RESOLUTION_PRESETS, type ProjectSettings } from '@/types/project';
import type { Clip } from '@/types/timeline';
import type { MediaAsset } from '@/types/media';

/**
 * Framing, and the format the framing is for.
 *
 * Two controls that belong together even though they act at different scales.
 * The anchor moves one clip inside the frame it already has; the format buttons
 * change the frame itself and re-crop every layer in the project. Someone
 * shifting a montage to 9:16 does both, in that order, and separating them
 * across two panels would hide the connection.
 *
 * Everything shown here — the kept-area percentage above all — is computed by
 * the same functions the retarget and the export use. It is a preview of the
 * result rather than an estimate of it.
 */
export function CropInspector({ clip, asset }: { clip: Clip; asset: MediaAsset | null }) {
  const settings = useEditor((state) => state.project?.settings);
  const playhead = useEditor((state) => state.playhead);
  const cropMode = useEditor((state) => state.cropMode);
  const setCropMode = useEditor((state) => state.setCropMode);
  const setClipAnchor = useEditor((state) => state.setClipAnchor);
  const retargetTo = useEditor((state) => state.retargetTo);

  if (!settings) return null;

  const measured = asset?.width && asset.height ? asset : null;
  const fit = measured ? fittedSize(measured, settings) : null;

  const shown = resolveClipAt(clip, playhead);
  const anchor = fit ? anchorOf({ scale: shown.scale, x: shown.x, y: shown.y }, fit) : CENTRE;

  const formats = RESOLUTION_PRESETS.filter(
    (preset) => preset.width !== settings.width || preset.height !== settings.height,
  );

  const costOf = (target: ProjectSettings): number => {
    if (!measured) return 1;
    const aimed = previewFraming(clip, measured, settings, target);
    const targetFit = fittedSize(measured, target);
    if (!aimed || !targetFit) return 1;
    return keptArea(cropWindow(aimed, targetFit, target));
  };

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => setCropMode(!cropMode)}
        aria-pressed={cropMode}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left',
          'transition-all duration-200 ease-smooth active:scale-[0.99]',
          cropMode
            ? 'border-accent-500/45 bg-accent-500/[0.1]'
            : 'border-white/[0.07] bg-white/[0.022] hover:border-white/[0.14]',
        )}
      >
        <Crop size={13} strokeWidth={2} className={cropMode ? 'text-accent-300' : 'text-white/45'} />
        <span className="min-w-0 flex-1">
          <span className="block text-2xs font-medium text-white/85">
            {cropMode ? 'Recadrage actif' : 'Mode recadrage'}
          </span>
          <span className="mt-0.5 block text-[10px] leading-relaxed text-white/35">
            Grille des tiers dans l’aperçu, et glisser pour recentrer le sujet
          </span>
        </span>
      </button>

      {!measured ? (
        <p className="rounded-xl border border-white/[0.07] bg-white/[0.022] px-3 py-2.5 text-[10px] leading-relaxed text-white/40">
          Les dimensions de ce média ne sont pas connues : Veglass ne peut pas calculer son
          cadrage. Lisez-le une fois dans l’aperçu pour qu’il soit mesuré.
        </p>
      ) : (
        <>
          <AnchorRow
            label="Sujet · horizontal"
            value={anchor.x}
            onChange={(x) => setClipAnchor(clip.id, { ...anchor, x })}
          />
          <AnchorRow
            label="Sujet · vertical"
            value={anchor.y}
            onChange={(y) => setClipAnchor(clip.id, { ...anchor, y })}
          />
          <button
            type="button"
            onClick={() => setClipAnchor(clip.id, CENTRE)}
            className="inline-flex items-center gap-1.5 text-[10px] text-white/35 transition-colors hover:text-white/70"
          >
            <RotateCcw size={10} strokeWidth={2.2} />
            Recentrer
          </button>
        </>
      )}

      <div>
        <span className="eyebrow mb-2 block">Format du projet</span>
        <div className="space-y-1.5">
          {formats.map((preset) => {
            const kept = costOf({ ...preset, fps: settings.fps });
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => retargetTo({ ...preset, fps: settings.fps })}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left',
                  'border-white/[0.07] bg-white/[0.02] transition-all duration-200',
                  'hover:border-accent-500/40 hover:bg-accent-500/[0.06] active:scale-[0.99]',
                )}
              >
                <Frame size={12} strokeWidth={2} className="shrink-0 text-white/40" />
                <span className="min-w-0 flex-1">
                  <span className="block text-2xs text-white/80">{preset.label}</span>
                  <span className="num mt-0.5 block text-[10px] text-white/30">{preset.hint}</span>
                </span>
                {measured && kept < 0.995 && (
                  <span
                    className="num shrink-0 text-[10px] text-amber-300/70"
                    title="Part de l’image conservée sur le clip sélectionné"
                  >
                    −{Math.round((1 - kept) * 100)} %
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-white/28">
          Change le format et recadre tous les calques — images, titres, habillages et mouvements de
          caméra compris. Une seule opération, annulable d’un Ctrl + Z.
        </p>
      </div>
    </div>
  );
}

function AnchorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg px-1 py-1">
      <span className="w-28 shrink-0 text-2xs text-white/45">{label}</span>
      <Slider value={value} min={0} max={1} step={0.005} onChange={onChange} aria-label={label} />
      <span className="num w-10 shrink-0 text-right text-2xs text-white/60">
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}
