import { CloudDownload, Loader2, TriangleAlert } from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/time';
import { Button } from '@/components/ui/Button';
import { useDownloads } from '@/store/downloadStore';

/**
 * The offer to fetch yt-dlp, shown wherever its absence blocks something.
 *
 * The same bargain the app already makes for ffmpeg: asking someone who wants a
 * piece of reference footage to install a command-line tool and put it on their
 * PATH is a strange place to stop, so the app fetches its own copy. Nothing goes
 * system-wide, and the panel says where it went.
 */
export function YtdlpSetup({ className }: { className?: string }) {
  const tool = useDownloads((state) => state.tool);
  const installing = useDownloads((state) => state.installing);
  const progress = useDownloads((state) => state.install);
  const setup = useDownloads((state) => state.setupTool);

  if (tool.available) return null;

  return (
    <div
      className={cn(
        'rounded-xl border border-white/[0.07] bg-white/[0.022] p-4 text-center',
        className,
      )}
    >
      <div className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-accent-500/[0.12] text-accent-300">
        {installing ? (
          <Loader2 size={17} strokeWidth={2} className="animate-spin" />
        ) : (
          <CloudDownload size={17} strokeWidth={2} />
        )}
      </div>

      <h3 className="mt-3 text-[14px] font-medium text-white/90">
        {installing ? 'Installation de yt-dlp…' : 'yt-dlp est requis'}
      </h3>

      <p className="mx-auto mt-1.5 max-w-[34ch] text-2xs leading-relaxed text-white/40">
        {installing
          ? 'Le binaire est écrit dans le dossier de l’application — rien n’est installé sur le système.'
          : 'C’est lui qui interroge les sites et récupère les fichiers. Veglass peut le télécharger dans son propre dossier, comme il le fait pour ffmpeg.'}
      </p>

      {installing && progress && (
        <div className="mt-3">
          <div className="h-0.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
            <div
              className="h-full rounded-full bg-accent-500 transition-[width] duration-200 ease-smooth"
              style={{ width: `${Math.round(Math.max(0.02, progress.ratio) * 100)}%` }}
            />
          </div>
          <p className="num mt-1.5 text-[10px] text-white/30">
            {progress.total > 0
              ? `${formatBytes(progress.received)} / ${formatBytes(progress.total)}`
              : formatBytes(progress.received)}
          </p>
        </div>
      )}

      {!installing && !tool.installable && (
        <p className="mx-auto mt-3 flex max-w-[34ch] gap-1.5 text-left text-[11px] leading-relaxed text-amber-300/75">
          <TriangleAlert size={11} strokeWidth={2.2} className="mt-0.5 shrink-0" />
          <span>
            Aucun binaire publié pour cette plateforme. Installez yt-dlp vous-même, puis pointez la
            variable d’environnement <span className="num">VEGLASS_YTDLP</span> sur votre copie.
          </span>
        </p>
      )}

      {!installing && tool.installable && (
        <Button size="sm" variant="primary" className="mt-4" onClick={() => void setup()}>
          Télécharger yt-dlp
        </Button>
      )}
    </div>
  );
}
