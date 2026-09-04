import {
  AudioLines,
  Check,
  Film,
  Plus,
  RotateCcw,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatBytes, formatClock } from '@/lib/time';
import { useDownloads } from '@/store/downloadStore';
import {
  STAGE_LABELS,
  formatRate,
  isFinished,
  isRunning,
  type DownloadJob,
} from '@/types/online';

/**
 * The download queue.
 *
 * One component, two homes — the rail tab and the browser overlay — because a
 * queue rendered twice would drift, and the whole point of the panel is that
 * what you see in the corner is what you see in the browser.
 *
 * Each row carries its own state in *form* as well as in words: a bar while
 * bytes are moving, a stripe of colour for the outcome, and the one action that
 * makes sense right now. A finished download's only useful verb is "add it to
 * the project", so that is the only button it offers.
 */
export function DownloadQueue({ compact = false }: { compact?: boolean }) {
  const jobs = useDownloads((state) => state.jobs);
  const importFinished = useDownloads((state) => state.importFinished);
  const clearFinished = useDownloads((state) => state.clearFinished);

  const ready = jobs.filter((job) => job.stage === 'done' && !job.imported).length;
  const settled = jobs.filter(isFinished).length;

  if (jobs.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-2xs leading-relaxed text-white/30">
          Rien en file. Cherchez une vidéo, puis choisissez de récupérer l’image ou seulement le
          son.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      {(ready > 0 || settled > 0) && (
        <div className="flex shrink-0 items-center gap-2 px-3 pb-2">
          {ready > 0 && (
            <button
              type="button"
              onClick={() => void importFinished()}
              className={cn(
                'inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5',
                'bg-accent-500 text-2xs font-medium text-white shadow-glow',
                'transition-all duration-200 ease-smooth hover:bg-accent-400 active:scale-[0.985]',
              )}
            >
              <Plus size={11} strokeWidth={2.6} />
              Ajouter {ready} au projet
            </button>
          )}
          {settled > 0 && (
            <button
              type="button"
              onClick={clearFinished}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-2xs text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/75"
            >
              <Trash2 size={11} strokeWidth={2.2} />
              Vider
            </button>
          )}
        </div>
      )}

      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3">
        {jobs.map((job) => (
          <QueueRow key={job.id} job={job} compact={compact} />
        ))}
      </ul>
    </div>
  );
}

/**
 * Transferred, rate, remaining — the three numbers a download is judged by.
 *
 * Rendered as a fixed row rather than as items that appear once they are known:
 * yt-dlp reports `NA` for the rate and the estimate on its first few ticks, and
 * a line whose contents come and go makes the whole row jump every quarter of a
 * second. A dash holds the place instead, and the layout settles once.
 */
function Transfer({ job }: { job: DownloadJob }) {
  return (
    <dl className="num mt-1 flex items-baseline gap-x-3 text-[10px]">
      <Stat
        label="reçu"
        value={
          job.total > 0
            ? `${formatBytes(job.received)} / ${formatBytes(job.total)}`
            : job.received > 0
              ? formatBytes(job.received)
              : null
        }
      />
      <Stat label="débit" value={job.speed > 0 ? formatRate(job.speed) : null} strong />
      <Stat label="reste" value={job.eta > 0 ? formatClock(job.eta) : null} />
    </dl>
  );
}

function Stat({
  label,
  value,
  strong,
}: {
  label: string;
  value: string | null;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1">
      <dt className="text-white/22">{label}</dt>
      <dd className={cn('tabular-nums', strong ? 'text-white/60' : 'text-white/40')}>
        {value ?? '—'}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ */

const STRIPE: Record<DownloadJob['stage'], string> = {
  queued: 'bg-white/20',
  download: 'bg-accent-400',
  convert: 'bg-wave-400',
  done: 'bg-emerald-400',
  failed: 'bg-red-400',
  cancelled: 'bg-white/20',
};

function QueueRow({ job, compact }: { job: DownloadJob; compact: boolean }) {
  const cancel = useDownloads((state) => state.cancel);
  const retry = useDownloads((state) => state.retry);
  const importJob = useDownloads((state) => state.importJob);
  const dismiss = useDownloads((state) => state.dismiss);

  const running = isRunning(job);
  const Icon = job.audioOnly ? AudioLines : Film;

  return (
    <li
      className={cn(
        'group relative overflow-hidden rounded-[3px] border border-white/[0.06] bg-white/[0.022]',
        'transition-colors duration-200 hover:border-white/[0.11]',
      )}
    >
      {/* The outcome, readable before a word is: a hairline down the edge. */}
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-0.5', STRIPE[job.stage])} />

      <div className="flex items-start gap-2.5 py-2 pl-3 pr-2">
        <span
          className={cn(
            'mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-[3px]',
            job.audioOnly ? 'bg-wave-500/[0.16] text-wave-300' : 'bg-accent-500/[0.14] text-accent-300',
          )}
        >
          <Icon size={12} strokeWidth={2} />
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-2xs leading-snug text-white/80" title={job.title}>
            {job.title}
          </p>

          <p className="num mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-white/35">
            <span className={job.stage === 'failed' ? 'text-red-300/80' : undefined}>
              {STAGE_LABELS[job.stage]}
            </span>
            {/* The choice made in the picker, so a queue of three is legible. */}
            <span className="text-white/28">{job.quality}</span>
            {job.stage === 'done' && job.bytes > 0 && <span>{formatBytes(job.bytes)}</span>}
            {job.imported && <span className="text-emerald-300/70">dans le projet</span>}
          </p>

          {job.error && !compact && (
            <p className="mt-1 flex gap-1.5 text-[10px] leading-snug text-red-300/75">
              <TriangleAlert size={10} strokeWidth={2.2} className="mt-0.5 shrink-0" />
              <span className="min-w-0">{job.error}</span>
            </p>
          )}

          {job.stage === 'download' && <Transfer job={job} />}

          {running && (
            <div className="mt-1.5 h-0.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
              <div
                className={cn(
                  'h-full rounded-full transition-[width] duration-200 ease-smooth',
                  job.stage === 'convert'
                    ? 'w-full animate-pulse bg-wave-400'
                    : 'bg-accent-500',
                )}
                style={
                  job.stage === 'convert'
                    ? undefined
                    : { width: `${Math.round(Math.max(0.02, job.ratio) * 100)}%` }
                }
              />
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {job.stage === 'done' && !job.imported && (
            <button
              type="button"
              onClick={() => void importJob(job.id)}
              title="Ajouter aux médias du projet"
              aria-label="Ajouter aux médias du projet"
              className="grid h-6 w-6 place-items-center rounded-[3px] bg-accent-500/[0.16] text-accent-200 transition-colors hover:bg-accent-500/30"
            >
              <Plus size={12} strokeWidth={2.6} />
            </button>
          )}
          {job.imported && (
            <span
              className="grid h-6 w-6 place-items-center text-emerald-400/70"
              title="Déjà dans les médias"
            >
              <Check size={12} strokeWidth={2.6} />
            </span>
          )}
          {(job.stage === 'failed' || job.stage === 'cancelled') && (
            <button
              type="button"
              onClick={() => void retry(job.id)}
              title="Réessayer"
              aria-label="Réessayer"
              className="grid h-6 w-6 place-items-center rounded-[3px] text-white/35 transition-colors hover:bg-white/[0.07] hover:text-white/80"
            >
              <RotateCcw size={12} strokeWidth={2.2} />
            </button>
          )}
          <button
            type="button"
            onClick={() => (running ? void cancel(job.id) : dismiss(job.id))}
            title={running ? 'Annuler' : 'Retirer de la liste'}
            aria-label={running ? 'Annuler' : 'Retirer de la liste'}
            className="grid h-6 w-6 place-items-center rounded-[3px] text-white/30 transition-colors hover:bg-white/[0.07] hover:text-white/70"
          >
            <X size={12} strokeWidth={2.2} />
          </button>
        </div>
      </div>
    </li>
  );
}
