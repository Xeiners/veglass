import { useState } from 'react';
import { Copy, Film, HardDrive, Layers, Play, Trash2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatClock, formatRelativeDate } from '@/lib/time';
import { aspectRatioOf, resolutionLabel, type ProjectSummary } from '@/types/project';

export function ProjectCard({
  project,
  onOpen,
  onDuplicate,
  onDelete,
}: {
  project: ProjectSummary;
  onOpen(): void;
  onDuplicate(): void;
  onDelete(): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const ratio = aspectRatioOf(project.settings);

  return (
    <div
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-2xl border text-left',
        'border-white/[0.06] bg-white/[0.022] backdrop-blur-xl',
        'transition-all duration-300 ease-smooth',
        'hover:-translate-y-0.5 hover:border-white/[0.12] hover:bg-white/[0.04] hover:shadow-lift',
      )}
    >
      <button type="button" onClick={onOpen} className="block w-full text-left">
        {/* Frame slot — an empty frame in the project's own aspect ratio. */}
        <div className="relative grid h-[132px] place-items-center overflow-hidden bg-ink-950/60">
          <div
            className="absolute inset-0 bg-grid-fade bg-grid opacity-70"
            aria-hidden
          />
          <div
            className={cn(
              'relative rounded-md border border-white/[0.09] bg-ink-900/70',
              'shadow-[0_8px_24px_-12px_rgba(0,0,0,.9)]',
              'transition-transform duration-500 ease-smooth group-hover:scale-[1.04]',
            )}
            style={{
              height: ratio >= 1 ? 74 : 92,
              width: ratio >= 1 ? 74 * ratio : 92 * ratio,
            }}
          >
            <span className="absolute inset-0 grid place-items-center">
              <Film size={17} strokeWidth={1.6} className="text-white/20" />
            </span>
          </div>

          <span
            className={cn(
              'absolute right-3 top-3 rounded-md border border-white/[0.09] bg-ink-900/80 px-1.5 py-0.5',
              'num text-2xs text-white/45 backdrop-blur',
            )}
          >
            {project.settings.fps % 1 === 0
              ? project.settings.fps
              : project.settings.fps.toFixed(2)}{' '}
            fps
          </span>

          <span
            className={cn(
              'absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-300',
              'bg-ink-950/45 backdrop-blur-[2px] group-hover:opacity-100',
            )}
          >
            <span className="grid h-11 w-11 place-items-center rounded-full bg-accent-500 text-white shadow-glow">
              <Play size={16} strokeWidth={2.4} fill="currentColor" className="ml-0.5" />
            </span>
          </span>
        </div>

        <div className="px-4 pb-3.5 pt-3.5">
          <h3 className="truncate text-[14px] font-medium tracking-tight text-white/92">
            {project.name}
          </h3>
          <p className="mt-1 text-2xs text-white/35">
            Modifié {formatRelativeDate(project.updatedAt)}
          </p>
        </div>
      </button>

      <div className="mt-auto flex items-center gap-3 border-t border-white/[0.05] px-4 py-2.5">
        <Meta icon={<HardDrive size={11} strokeWidth={2} />} value={resolutionLabel(project.settings)} />
        <Meta icon={<Layers size={11} strokeWidth={2} />} value={`${project.clipCount}`} />
        <Meta icon={<Film size={11} strokeWidth={2} />} value={formatClock(project.duration)} />

        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDuplicate();
          }}
          aria-label="Dupliquer le projet"
          title="Dupliquer le projet"
          className={cn(
            'ml-auto grid h-7 w-7 place-items-center rounded-lg transition-all duration-200',
            'text-white/25 opacity-0 hover:bg-white/[0.07] hover:text-white/70 group-hover:opacity-100',
          )}
        >
          <Copy size={13} strokeWidth={2} />
        </button>

        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            if (confirming) onDelete();
            else {
              setConfirming(true);
              setTimeout(() => setConfirming(false), 3000);
            }
          }}
          aria-label={confirming ? 'Confirmer la suppression' : 'Supprimer le projet'}
          className={cn(
            'grid h-7 w-7 place-items-center rounded-lg transition-all duration-200',
            confirming
              ? 'bg-red-500/20 text-red-300 ring-1 ring-red-500/40'
              : 'text-white/25 opacity-0 hover:bg-white/[0.07] hover:text-white/70 group-hover:opacity-100',
          )}
        >
          <Trash2 size={13} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

function Meta({ icon, value }: { icon: React.ReactNode; value: string }) {
  return (
    <span className="flex items-center gap-1.5 text-2xs text-white/35">
      <span className="text-white/22">{icon}</span>
      <span className="num">{value}</span>
    </span>
  );
}
