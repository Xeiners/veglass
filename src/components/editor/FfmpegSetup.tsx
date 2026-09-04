import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Download, FolderOpen, HardDriveDownload, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import {
  adoptFfmpeg,
  encoderStatus,
  installFfmpeg,
  onInstallProgress,
  type EncoderStatus,
  type InstallProgress,
} from '@/lib/exporter';
import { isTauri } from '@/lib/env';
import { useEditor } from '@/store/editorStore';

/** Measured on the published Windows build; only used to set expectations. */
const APPROX_MB = 165;

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(0)} Mo`;
}

/**
 * Running the download, wherever it is offered from.
 *
 * Progress arrives as events rather than as a return value, because the useful
 * part of a ninety-second download is what happens during it.
 */
export function useFfmpegInstall(onInstalled?: (status: EncoderStatus) => void) {
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notify = useEditor((state) => state.notify);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    setProgress(null);

    // Attached before the command is sent, so no tick can be missed.
    const dispose = await onInstallProgress(setProgress);
    try {
      const status = await installFfmpeg();
      notify(`ffmpeg installé — ${status.version ?? 'prêt à encoder'}`);
      onInstalled?.(status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      dispose();
      setBusy(false);
    }
  }, [notify, onInstalled]);

  /**
   * Points the app at a copy the user already has.
   *
   * Offered beside the download rather than behind a failure, because the
   * people who need it — a locked-down network, a machine with no route out —
   * generally know it before the download has failed three times.
   */
  const adopt = useCallback(async () => {
    setError(null);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const chosen = await open({
        multiple: false,
        directory: false,
        title: 'Choisissez le binaire ffmpeg',
        filters: isWindows() ? [{ name: 'ffmpeg', extensions: ['exe'] }] : undefined,
      });
      if (typeof chosen !== 'string') return;

      setBusy(true);
      const status = await adoptFfmpeg(chosen);
      notify(`ffmpeg adopté — ${status.version ?? 'prêt à encoder'}`);
      onInstalled?.(status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [notify, onInstalled]);

  const reveal = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_binaries_dir');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  return { start, adopt, reveal, busy, progress, error };
}

const isWindows = (): boolean =>
  typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent);

/* ------------------------------------------------------------------ */

function ProgressBar({ progress }: { progress: InstallProgress }) {
  const ratio = Math.max(0, Math.min(1, progress.ratio));
  const label =
    progress.stage === 'download'
      ? progress.total > 0
        ? `${megabytes(progress.received)} sur ${megabytes(progress.total)}`
        : megabytes(progress.received)
      : progress.stage === 'extract'
        ? 'Extraction…'
        : progress.stage === 'verify'
          ? 'Vérification…'
          : 'Terminé';

  return (
    <div className="mt-3">
      <div className="h-1 overflow-hidden rounded-full bg-white/[0.08]">
        <div
          className="h-full rounded-full bg-accent-400 transition-[width] duration-200"
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-white/40">
        <span>{label}</span>
        <span className="num">{Math.round(ratio * 100)} %</span>
      </div>
    </div>
  );
}

/**
 * The card shown wherever a missing encoder blocks the way.
 *
 * It states the problem, offers the one-click fix, and still gives the manual
 * routes — an automatic download is a convenience, not the only way in.
 */
export function FfmpegNotice({
  status,
  onInstalled,
}: {
  status: EncoderStatus;
  onInstalled(status: EncoderStatus): void;
}) {
  const { start, adopt, reveal, busy, progress, error } = useFfmpegInstall(onInstalled);

  return (
    <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-3">
      <div className="flex items-start gap-2.5">
        <TriangleAlert size={14} strokeWidth={2.2} className="mt-px shrink-0 text-amber-300" />
        <div className="min-w-0 flex-1 text-2xs leading-relaxed">
          <p className="font-medium text-amber-100/90">ffmpeg introuvable</p>
          <p className="mt-1 text-amber-200/60">
            L’encodage passe par ffmpeg. Veglass peut le télécharger dans son propre dossier —
            rien n’est installé sur le système ni ajouté au PATH. Comptez ≈ {APPROX_MB} Mo à
            télécharger et ≈ 300 Mo sur le disque une fois décompressé.
          </p>

          {status.installable ? (
            <Button
              size="sm"
              variant="primary"
              className="mt-2.5"
              icon={<Download size={13} strokeWidth={2.2} />}
              disabled={busy}
              onClick={() => void start()}
            >
              {busy ? 'Installation…' : `Installer ffmpeg (≈ ${APPROX_MB} Mo)`}
            </Button>
          ) : (
            <p className="mt-2 text-amber-200/60">
              Sur cette plateforme, installez-le par votre gestionnaire de paquets — c’est la
              copie que le système attend.
            </p>
          )}

          {/* Beside the download, not hidden behind its failure: on a network
              that blocks the fetch, the second attempt fails just as the first
              did, and the way out should already be in view. */}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon={<HardDriveDownload size={13} strokeWidth={2.2} />}
              disabled={busy}
              onClick={() => void adopt()}
            >
              J’ai déjà ffmpeg…
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<FolderOpen size={13} strokeWidth={2.2} />}
              onClick={() => void reveal()}
            >
              Ouvrir le dossier
            </Button>
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-amber-200/45">
            Si le téléchargement échoue, récupérez une build ffmpeg par vos propres moyens :
            « J’ai déjà ffmpeg » en prend une copie, ou déposez <span className="num">ffmpeg.exe</span>{' '}
            directement dans le dossier.
          </p>

          {progress && <ProgressBar progress={progress} />}

          {error && (
            <p className="mt-2 rounded-lg border border-red-500/25 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-200">
              {error}
            </p>
          )}

          <p className="mt-2.5 text-[10px] text-amber-200/40">
            Ou manuellement : ffmpeg dans le PATH, le binaire à côté de Veglass, ou la variable{' '}
            <code className="font-mono">VEGLASS_FFMPEG</code>.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Asked once at launch, when the machine has no encoder.
 *
 * Deliberately not blocking: editing, cutting and previewing all work without
 * ffmpeg, and only the export needs it. The dialog states that, and takes no
 * for an answer — the same offer waits in the export panel.
 */
export function FfmpegSetupDialog() {
  const [status, setStatus] = useState<EncoderStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<EncoderStatus | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void encoderStatus().then((result) => {
      if (cancelled) return;
      setStatus(result);
      // Nothing to offer on a platform we would not install on anyway.
      if (!result.available && result.installable) setOpen(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) return null;

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Un dernier composant"
      description="Veglass encode avec ffmpeg, qui n’est pas présent sur cette machine."
      width="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)} data-close>
            {done ? 'Fermer' : 'Plus tard'}
          </Button>
        </div>
      }
    >
      {done ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-3 py-3">
          <CheckCircle2 size={14} strokeWidth={2.2} className="mt-px shrink-0 text-emerald-300" />
          <div className="min-w-0 text-2xs leading-relaxed">
            <p className="font-medium text-emerald-100/90">ffmpeg est prêt</p>
            <p className="mt-1 truncate text-emerald-200/60">{done.version ?? 'installé'}</p>
          </div>
        </div>
      ) : (
        <>
          <p className="mb-3 text-2xs leading-relaxed text-white/45">
            Le montage, la lecture et les effets fonctionnent sans lui. Il n’est nécessaire que
            pour produire le fichier final.
          </p>
          <FfmpegNotice
            status={status}
            onInstalled={(next) => {
              setStatus(next);
              setDone(next);
            }}
          />
        </>
      )}
    </Modal>
  );
}
