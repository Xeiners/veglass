import { useEffect } from 'react';
import { ArrowUpCircle, Loader2, TriangleAlert } from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/time';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useUpdates } from '@/store/updateStore';

/**
 * The offer to update.
 *
 * Only ever shown when there is genuinely something newer: the check that feeds
 * it is silent about every kind of failure, so this component has no "checking"
 * state and no "you are up to date" state to render. Nothing appears unless
 * there is something to say.
 *
 * The dialog cannot be dismissed by accident while installing — closing it
 * mid-download would leave a half-fetched installer and no way back to the
 * progress bar.
 */
export function UpdateDialog() {
  const stage = useUpdates((state) => state.stage);
  const update = useUpdates((state) => state.update);
  const progress = useUpdates((state) => state.progress);
  const received = useUpdates((state) => state.received);
  const total = useUpdates((state) => state.total);
  const error = useUpdates((state) => state.error);
  const install = useUpdates((state) => state.install);
  const dismiss = useUpdates((state) => state.dismiss);
  const boot = useUpdates((state) => state.boot);

  useEffect(() => {
    boot();
  }, [boot]);

  const installing = stage === 'installing';
  const open = stage === 'available' || installing || stage === 'failed';
  if (!open || !update) return null;

  return (
    <Modal
      open
      onClose={() => {
        if (!installing) dismiss();
      }}
      title="Une nouvelle version est disponible"
      description={`Veglass ${update.version}`}
      width="sm"
      footer={
        <div className="flex items-center gap-2">
          <Button variant="ghost" disabled={installing} onClick={dismiss}>
            Plus tard
          </Button>
          <Button
            variant="primary"
            disabled={installing}
            icon={
              installing ? (
                <Loader2 size={14} strokeWidth={2} className="animate-spin" />
              ) : (
                <ArrowUpCircle size={14} strokeWidth={2} />
              )
            }
            onClick={() => void install()}
          >
            {installing
              ? 'Installation…'
              : stage === 'failed'
                ? 'Réessayer'
                : 'Installer et redémarrer'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-2xs leading-relaxed text-white/45">
          Veglass va télécharger la mise à jour, l’installer, puis redémarrer.{' '}
          {/* Said plainly: a restart mid-edit is the thing that would make
              someone regret pressing the button. */}
          <span className="text-white/65">
            Enregistrez votre projet avant de continuer.
          </span>
        </p>

        {update.notes && (
          <div className="max-h-48 overflow-y-auto rounded-xl border border-white/[0.07] bg-white/[0.022] px-3.5 py-3">
            <h3 className="eyebrow mb-1.5">Nouveautés</h3>
            {/* Plain text on purpose — a release note is written elsewhere and
                is not markup we are willing to render into our own window. */}
            <p className="whitespace-pre-wrap text-2xs leading-relaxed text-white/55">
              {update.notes}
            </p>
          </div>
        )}

        {installing && (
          <div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.07]">
              <div
                className={cn(
                  'h-full rounded-full bg-accent-500 transition-[width] duration-300 ease-smooth',
                  // No announced length: animate rather than sit at zero.
                  total === 0 && 'w-1/3 animate-pulse',
                )}
                style={total > 0 ? { width: `${Math.round(progress * 100)}%` } : undefined}
              />
            </div>
            <p className="num mt-2 text-[10px] text-white/30">
              {total > 0
                ? `${formatBytes(received)} / ${formatBytes(total)}`
                : 'Téléchargement…'}
            </p>
          </div>
        )}

        {error && (
          <p className="flex gap-1.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-3 text-2xs leading-relaxed text-amber-100/80">
            <TriangleAlert size={12} strokeWidth={2.2} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}

        {update.date && (
          <p className="num text-[10px] text-white/25">Publiée le {update.date}</p>
        )}
      </div>
    </Modal>
  );
}
