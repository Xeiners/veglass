import { useState } from 'react';
import { FolderOpen, Keyboard, Plus, Sparkles } from 'lucide-react';

import { cn } from '@/lib/cn';
import { hostLabel, isTauri } from '@/lib/env';
import { Button } from '@/components/ui/Button';
import { Logo, Wordmark } from '@/components/ui/Logo';
import { SkeletonBlock } from '@/components/ui/Skeleton';
import { useEditor } from '@/store/editorStore';
import { NewProjectModal } from './NewProjectModal';
import { ProjectCard } from './ProjectCard';

export function HomeDashboard() {
  const projects = useEditor((state) => state.projects);
  const booting = useEditor((state) => state.booting);
  const storageLocation = useEditor((state) => state.storageLocation);
  const openProject = useEditor((state) => state.openProject);
  const deleteProject = useEditor((state) => state.deleteProject);
  const duplicateProject = useEditor((state) => state.duplicateProject);

  const [creating, setCreating] = useState(false);

  return (
    <div className="relative h-full overflow-y-auto">
      {/* Ambient light: one warm accent bloom, kept far off-centre. */}
      <div className="pointer-events-none fixed inset-0" aria-hidden>
        <div className="absolute -left-40 -top-56 h-[520px] w-[520px] rounded-full bg-accent-500/[0.07] blur-[130px]" />
        <div className="absolute -right-32 top-1/3 h-[420px] w-[420px] rounded-full bg-accent-700/[0.16] blur-[130px]" />
        <div className="absolute inset-0 bg-grid-fade bg-grid opacity-40" />
      </div>

      <div className="relative mx-auto flex min-h-full max-w-6xl flex-col px-8 py-10 lg:px-12">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo size={30} />
            <div className="flex items-baseline gap-2">
              <Wordmark />
              <span className="num rounded-md border border-white/[0.07] px-1.5 py-px text-2xs text-white/30">
                0.1.0
              </span>
            </div>
          </div>

          <span className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.025] px-2.5 py-1.5 text-2xs text-white/40">
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                isTauri() ? 'bg-accent-300 shadow-[0_0_8px_rgba(167,139,250,.85)]' : 'bg-wave-400',
              )}
            />
            {hostLabel()}
          </span>
        </header>

        <section className="py-16 lg:py-20">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.025] px-3 py-1.5 text-2xs text-white/45">
            <Sparkles size={12} strokeWidth={2} className="text-accent-300" />
            Montage hybride, moteur natif
          </span>

          <h1 className="mt-6 max-w-2xl text-[42px] font-semibold leading-[1.06] tracking-tightest text-white lg:text-[52px]">
            Montez vite.
            <br />
            <span className="text-white/35">Livrez propre.</span>
          </h1>

          <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-white/45">
            Un plan de travail unique : bibliothèque, preview synchronisée et timeline multi-pistes.
            Vos projets restent sur votre machine, en JSON lisible.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              size="lg"
              onClick={() => setCreating(true)}
              icon={<Plus size={16} strokeWidth={2.4} />}
            >
              Nouveau projet
            </Button>
            <span className="flex items-center gap-2 text-2xs text-white/28">
              <Keyboard size={13} strokeWidth={1.8} />
              Espace lecture · S couper · Ctrl + S enregistrer
            </span>
          </div>
        </section>

        <section className="pb-14">
          <div className="mb-5 flex items-baseline justify-between">
            <h2 className="eyebrow">Projets récents</h2>
            {projects.length > 0 && (
              <span className="num text-2xs text-white/25">{projects.length}</span>
            )}
          </div>

          {booting ? (
            <SkeletonGrid />
          ) : projects.length === 0 ? (
            <EmptyState onCreate={() => setCreating(true)} />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onOpen={() => void openProject(project.id)}
                  onDuplicate={() => void duplicateProject(project.id)}
                  onDelete={() => void deleteProject(project.id)}
                />
              ))}
            </div>
          )}
        </section>

        <footer className="mt-auto flex items-center gap-2 border-t border-white/[0.05] pt-5 text-2xs text-white/25">
          <FolderOpen size={12} strokeWidth={1.8} />
          <span className="selectable truncate">{storageLocation || '…'}</span>
        </footer>
      </div>

      <NewProjectModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate(): void }) {
  return (
    <button
      type="button"
      onClick={onCreate}
      className={cn(
        'flex w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed',
        'border-white/[0.09] bg-white/[0.012] px-6 py-16',
        'transition-all duration-300 ease-smooth',
        'hover:border-accent-500/35 hover:bg-accent-500/[0.03]',
      )}
    >
      <span className="grid h-12 w-12 place-items-center rounded-xl border border-white/[0.08] bg-white/[0.03]">
        <Plus size={18} strokeWidth={2} className="text-white/40" />
      </span>
      <span className="text-[14px] font-medium text-white/70">Aucun projet pour l'instant</span>
      <span className="max-w-xs text-center text-[13px] leading-relaxed text-white/32">
        Créez votre premier montage — il sera enregistré automatiquement à chaque modification.
      </span>
    </button>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {[0, 1, 2].map((index) => (
        <SkeletonBlock
          key={index}
          className="h-[218px] rounded-2xl border border-white/[0.05]"
        />
      ))}
    </div>
  );
}
