import { useState } from 'react';
import {
  Captions,
  ChevronLeft,
  Cloud,
  CloudOff,
  Command,
  Download,
  Gauge,
  Redo2,
  Sparkles,
  Type,
  Undo2,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatRelativeDate } from '@/lib/time';
import { Button, IconButton } from '@/components/ui/Button';
import { Logo } from '@/components/ui/Logo';
import { Modal } from '@/components/ui/Modal';
import { PREVIEW_QUALITIES, useEditor } from '@/store/editorStore';
import { useAi } from '@/store/aiStore';
import { resolutionLabel } from '@/types/project';
import { ExportDialog } from './ExportDialog';

const SHORTCUTS: [string, string][] = [
  ['Espace', 'Lecture / pause'],
  ['Espace maintenu + glisser', 'Déplacer la vue de la timeline'],
  ['Ctrl + clic', 'Ajouter / retirer un clip de la sélection'],
  ['S', 'Couper au curseur — toute la sélection'],
  ['N', 'Aimantation'],
  ['L', 'Lecture en boucle'],
  ['M', 'Couper le son'],
  ['← / →', 'Reculer / avancer d’une image'],
  ['⇧ ← / →', 'Saut de 10 images'],
  ['Début / Fin', 'Début / fin du montage'],
  ['Suppr', 'Supprimer la sélection'],
  ['Ctrl + D', 'Dupliquer la sélection'],
  ['Ctrl + S', 'Enregistrer'],
  ['Ctrl + Z', 'Annuler'],
  ['Ctrl + ⇧ + Z', 'Rétablir'],
  ['Ctrl + ⇧ + T', 'Nouveau calque de texte'],
  ['Ctrl + C / V', 'Copier / coller les clips (ou les images clés)'],
  ['K', 'Poser une image clé sur les propriétés animées'],
  ['G', 'Mode animation (éditeur de courbes)'],
  ['I / O', 'Point d’entrée / de sortie de la zone de travail'],
  ['X', 'Effacer la zone de travail'],
  ['⌥⇧ P / S / R / T', 'Animer position / échelle / rotation / opacité'],
  ['+ / −', 'Zoom timeline'],
  ['Ctrl + molette', 'Zoom continu'],
];

export function TopBar() {
  const project = useEditor((state) => state.project);
  const dirty = useEditor((state) => state.dirty);
  const savedAt = useEditor((state) => state.savedAt);
  const closeProject = useEditor((state) => state.closeProject);

  const [helpOpen, setHelpOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  if (!project) return null;

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.055] bg-ink-850/80 px-3 backdrop-blur-xl">
      <IconButton label="Retour aux projets" onClick={() => void closeProject()}>
        <ChevronLeft size={17} strokeWidth={2.2} />
      </IconButton>

      <Logo size={22} />

      <div className="min-w-0">
        <h1 className="truncate text-[13px] font-medium tracking-tight text-white/90">
          {project.name}
        </h1>
        <p className="flex items-center gap-1.5 text-[10px] text-white/30">
          {dirty ? (
            <>
              <CloudOff size={10} strokeWidth={2} className="text-amber-400/70" />
              Modifications en cours…
            </>
          ) : (
            <>
              <Cloud size={10} strokeWidth={2} className="text-accent-300/70" />
              Enregistré {savedAt ? formatRelativeDate(savedAt) : ''}
            </>
          )}
        </p>
      </div>

      <div className="ml-4 flex items-center gap-1.5">
        <Chip>{resolutionLabel(project.settings)}</Chip>
        <Chip>
          {project.settings.fps % 1 === 0
            ? project.settings.fps
            : project.settings.fps.toFixed(3)}{' '}
          fps
        </Chip>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <HistoryControls />
        <TextTool />
        <BannerTool />
        <AssistantTool />

        <span className="mx-1 h-4 w-px bg-white/[0.08]" />

        <PreviewQualityPicker />

        <span className="mx-1 h-4 w-px bg-white/[0.08]" />

        <IconButton label="Raccourcis clavier" onClick={() => setHelpOpen(true)}>
          <Command size={15} strokeWidth={2} />
        </IconButton>
        <Button
          size="sm"
          variant="primary"
          icon={<Download size={13} strokeWidth={2.2} />}
          onClick={() => setExportOpen(true)}
        >
          Exporter
        </Button>
      </div>

      <Modal
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        title="Raccourcis"
        description="Le montage se pilote presque entièrement au clavier."
      >
        <ul className="grid gap-px overflow-hidden rounded-xl border border-white/[0.06] pb-1">
          {SHORTCUTS.map(([keys, action]) => (
            <li
              key={keys}
              className="flex items-center justify-between gap-4 bg-white/[0.018] px-3 py-2.5"
            >
              <span className="text-2xs text-white/60">{action}</span>
              <kbd className="num rounded-md border border-white/[0.09] bg-ink-900/80 px-2 py-1 text-[10px] text-white/70">
                {keys}
              </kbd>
            </li>
          ))}
        </ul>
      </Modal>

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </header>
  );
}

function HistoryControls() {
  const past = useEditor((state) => state.past);
  const future = useEditor((state) => state.future);
  const undo = useEditor((state) => state.undo);
  const redo = useEditor((state) => state.redo);

  const last = past[past.length - 1];
  const next = future[0];

  return (
    <>
      <IconButton
        label={last ? `Annuler — ${last.label} (Ctrl + Z)` : 'Annuler (Ctrl + Z)'}
        disabled={past.length === 0}
        onClick={undo}
      >
        <Undo2 size={15} strokeWidth={2} />
      </IconButton>
      <IconButton
        label={next ? `Rétablir — ${next.label} (Ctrl + ⇧ + Z)` : 'Rétablir (Ctrl + ⇧ + Z)'}
        disabled={future.length === 0}
        onClick={redo}
      >
        <Redo2 size={15} strokeWidth={2} />
      </IconButton>
    </>
  );
}

function TextTool() {
  const addTextClip = useEditor((state) => state.addTextClip);
  return (
    <IconButton label="Calque de texte (Ctrl + ⇧ + T)" onClick={() => addTextClip()}>
      <Type size={15} strokeWidth={2.2} />
    </IconButton>
  );
}

/** Opens the template picker rather than adding a banner blind: the three
    looks are entirely visual, and a name means nothing before you have seen
    one. See `banner/BannerPicker`. */
function BannerTool() {
  const openPicker = useEditor((state) => state.openBannerPicker);
  return (
    <IconButton label="Bande titre / habillage" onClick={() => openPicker(true)}>
      <Captions size={15} strokeWidth={2.2} />
    </IconButton>
  );
}

/** Brings the assistant forward in the right column, wherever the focus is. */
function AssistantTool() {
  const tab = useEditor((state) => state.rightTab);
  const setTab = useEditor((state) => state.setRightTab);
  const working = useAi((state) => state.job !== null);

  return (
    <IconButton
      label="Assistant IA"
      active={tab === 'assistant'}
      onClick={() => setTab(tab === 'assistant' ? 'inspector' : 'assistant')}
      className={cn(working && 'text-accent-300')}
    >
      <Sparkles size={15} strokeWidth={2.2} className={cn(working && 'animate-pulse')} />
    </IconButton>
  );
}

/**
 * Playback resolution, the After Effects way: a lower setting rasterises the
 * viewer at a fraction of the frame while the transport runs, and is ignored
 * when parked or exporting.
 */
function PreviewQualityPicker() {
  const quality = useEditor((state) => state.previewQuality);
  const setQuality = useEditor((state) => state.setPreviewQuality);

  return (
    <div
      className="flex items-center gap-0.5 rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5"
      role="group"
      aria-label="Qualité de prévisualisation"
    >
      <Gauge size={11} strokeWidth={2} className="ml-1.5 mr-0.5 shrink-0 text-white/28" />
      {PREVIEW_QUALITIES.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => setQuality(item.value)}
          aria-pressed={quality === item.value}
          title={item.hint}
          className={cn(
            'num rounded-[6px] px-2 py-1 text-[10px] font-medium',
            'transition-all duration-200 ease-smooth',
            quality === item.value
              ? 'bg-accent-500/[0.18] text-accent-200 shadow-[inset_0_0_0_1px_rgba(124,58,237,.3)]'
              : 'text-white/38 hover:text-white/75',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'num rounded-md border border-white/[0.07] bg-white/[0.025] px-2 py-1',
        'text-[10px] text-white/40',
      )}
    >
      {children}
    </span>
  );
}
