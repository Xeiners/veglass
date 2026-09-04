import { Globe, Search } from 'lucide-react';

import { cn } from '@/lib/cn';
import { useDownloads } from '@/store/downloadStore';
import { isRunning } from '@/types/online';
import { DownloadQueue } from './DownloadQueue';
import { YtdlpSetup } from './YtdlpSetup';

/**
 * The rail's view of the online module: the queue, and a way into the browser.
 *
 * The column is under three hundred pixels, which a list fits and a thumbnail
 * grid does not — so browsing happens in the overlay and the rail keeps what it
 * can render well. The two show the same queue, from the same store.
 */
export function OnlinePanel() {
  const tool = useDownloads((state) => state.tool);
  const openBrowser = useDownloads((state) => state.openBrowser);
  const jobs = useDownloads((state) => state.jobs);

  const active = jobs.filter(isRunning).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-3 pb-2 pt-3">
        <button
          type="button"
          onClick={() => openBrowser(true)}
          className={cn(
            'flex h-9 w-full items-center justify-center gap-2 rounded-xl',
            'bg-accent-500 text-2xs font-medium text-white shadow-glow',
            'transition-all duration-200 ease-smooth hover:bg-accent-400 active:scale-[0.985]',
          )}
        >
          <Search size={13} strokeWidth={2.4} />
          Chercher en ligne
        </button>
      </div>

      {!tool.available ? (
        <div className="px-3 pt-2">
          <YtdlpSetup />
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-2">
            <Globe size={11} strokeWidth={2} className="text-white/25" />
            <h3 className="eyebrow">File</h3>
            {active > 0 && (
              <span className="num ml-auto rounded-md bg-accent-500/[0.16] px-1.5 py-0.5 text-[10px] text-accent-200">
                {active} en cours
              </span>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            <DownloadQueue compact />
          </div>
        </>
      )}
    </div>
  );
}
