import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  AudioLines,
  Check,
  Download,
  Info,
  Loader2,
  Radio,
  Search,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatBytes, formatClock } from '@/lib/time';
import { useDownloads } from '@/store/downloadStore';
import {
  AUDIO_TARGETS,
  DURATION_OPTIONS,
  KIND_OPTIONS,
  SORT_OPTIONS,
  describeOffer,
  formatCount,
  isDefaultFilters,
  isStale,
  type SearchResult,
  type Selection,
  type VideoOffer,
} from '@/types/online';
import { Button } from '@/components/ui/Button';
import { SkeletonBlock, SkeletonLine } from '@/components/ui/Skeleton';
import { DownloadQueue } from './DownloadQueue';
import { YtdlpSetup } from './YtdlpSetup';

/**
 * The online media browser.
 *
 * A dedicated overlay rather than a tab in the side rail, for a reason that is
 * about pixels rather than taste: a thumbnail grid and a live queue side by
 * side need roughly nine hundred of them, and the rail is under three hundred.
 * The rail keeps the queue — a list fits a narrow column — and hands the
 * browsing off to this.
 *
 * Split down the middle, the way every media manager is: what you have on the
 * left, what you are looking for on the right.
 */
export function MediaBrowser() {
  const open = useDownloads((state) => state.browserOpen);
  const setOpen = useDownloads((state) => state.openBrowser);
  const select = useDownloads((state) => state.select);
  const selected = useDownloads((state) => state.selected);
  const tool = useDownloads((state) => state.tool);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      // Escape steps back out of the picker before it closes the browser, which
      // is the only reading that does not lose the search behind it.
      if (useDownloads.getState().selected) select(null);
      else setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = overflow;
    };
  }, [open, select, setOpen]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-5">
      <div
        className="absolute inset-0 animate-fade-in bg-ink-950/75 backdrop-blur-md"
        onClick={() => setOpen(false)}
        aria-hidden
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Médias en ligne"
        className={cn(
          'relative flex h-full w-full max-w-[1180px] animate-scale-in flex-col overflow-hidden',
          'rounded-2xl border border-white/[0.08] bg-ink-850/95 shadow-lift backdrop-blur-2xl',
        )}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />

        <header className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tightest text-white">
              Médias en ligne
            </h2>
            <p
              className={cn(
                'num mt-0.5 truncate text-[10px]',
                isStale(tool) ? 'text-amber-300/70' : 'text-white/28',
              )}
            >
              {tool.version ? `yt-dlp ${tool.version}` : 'yt-dlp'}
              {isStale(tool) && ' · version périmée'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Fermer"
            className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/80"
          >
            <X size={15} strokeWidth={2} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Left — what you already have. */}
          <aside className="flex w-[320px] shrink-0 flex-col border-r border-white/[0.06] bg-ink-900/40">
            <div className="shrink-0 px-4 pb-2 pt-3.5">
              <h3 className="eyebrow">File de téléchargement</h3>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <DownloadQueue />
            </div>
            <Disclaimer />
          </aside>

          {/* Right — what you are looking for. */}
          <section className="flex min-w-0 flex-1 flex-col">
            {selected ? <FormatPicker result={selected} /> : <Browser />}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */

/**
 * Said once, where it cannot be missed and does not nag.
 *
 * The app has no way to know whether a given video may be downloaded, and
 * pretending otherwise by staying silent would be the dishonest choice.
 */
function Disclaimer() {
  return (
    <p className="flex shrink-0 gap-1.5 border-t border-white/[0.06] px-4 py-3 text-[10px] leading-relaxed text-white/28">
      <Info size={11} strokeWidth={2} className="mt-0.5 shrink-0" />
      <span>
        Le téléchargement peut contrevenir aux conditions du site et aux droits sur l’œuvre.
        Assurez-vous d’avoir les droits sur ce que vous récupérez.
      </span>
    </p>
  );
}

/* ------------------------------------------------------------------ *
 * Searching
 * ------------------------------------------------------------------ */

function Browser() {
  const query = useDownloads((state) => state.query);
  const setQuery = useDownloads((state) => state.setQuery);
  const runSearch = useDownloads((state) => state.runSearch);
  const searching = useDownloads((state) => state.searching);
  const results = useDownloads((state) => state.results);
  const error = useDownloads((state) => state.searchError);
  const tool = useDownloads((state) => state.tool);

  const field = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);

  return (
    <>
      <div className="shrink-0 space-y-2.5 px-5 pb-3 pt-3.5">
        <div
          className={cn(
            'flex h-11 items-center gap-2.5 rounded-xl border border-white/[0.08] bg-ink-900/60 px-3.5',
            'transition-all duration-200 focus-within:border-accent-500/45',
            'focus-within:shadow-[0_0_0_3px_rgba(124,58,237,.15)]',
          )}
        >
          <Search size={14} strokeWidth={2} className="shrink-0 text-white/25" />
          <input
            ref={field}
            value={query}
            spellCheck={false}
            disabled={!tool.available}
            placeholder="Mots-clés, ou collez un lien de vidéo"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void runSearch();
            }}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-white placeholder:text-white/25 focus:outline-none disabled:opacity-50"
          />
          {searching && (
            <Loader2 size={13} strokeWidth={2.4} className="shrink-0 animate-spin text-accent-300" />
          )}
        </div>

        {tool.available && <FilterBar />}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {!tool.available ? (
          <YtdlpSetup className="mx-auto mt-10 max-w-md" />
        ) : results.length > 0 ? (
          <Results />
        ) : (
          <Empty message={error} searching={searching} />
        )}
      </div>
    </>
  );
}

/**
 * The filters YouTube's search actually has.
 *
 * A filter change re-runs the search on the spot rather than waiting for Enter:
 * changing one is a different question, not a correction to the current one.
 */
function FilterBar() {
  const filters = useDownloads((state) => state.filters);
  const setFilters = useDownloads((state) => state.setFilters);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <SlidersHorizontal size={11} strokeWidth={2} className="shrink-0 text-white/22" />

      <Choices
        label="Type"
        options={KIND_OPTIONS}
        value={filters.kind}
        onSelect={(kind) => setFilters({ kind })}
      />
      <Choices
        label="Durée"
        options={DURATION_OPTIONS}
        value={filters.duration}
        onSelect={(duration) => setFilters({ duration })}
      />
      <Choices
        label="Tri"
        options={SORT_OPTIONS}
        value={filters.sort}
        onSelect={(sort) => setFilters({ sort })}
      />

      <button
        type="button"
        onClick={() => setFilters({ creativeCommons: !filters.creativeCommons })}
        aria-pressed={filters.creativeCommons}
        title="N’afficher que les vidéos publiées sous licence Creative Commons"
        className={cn(
          'inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px]',
          'transition-all duration-200 ease-smooth',
          filters.creativeCommons
            ? 'border-emerald-400/40 bg-emerald-400/[0.12] text-emerald-200'
            : 'border-white/[0.08] text-white/40 hover:border-white/20 hover:text-white/75',
        )}
      >
        {filters.creativeCommons && <Check size={10} strokeWidth={3} />}
        Creative Commons
      </button>

      {!isDefaultFilters(filters) && (
        <button
          type="button"
          onClick={() =>
            setFilters({ kind: 'any', duration: 'any', sort: 'relevance', creativeCommons: false })
          }
          className="text-[11px] text-white/30 underline underline-offset-2 transition-colors hover:text-white/70"
        >
          Réinitialiser
        </button>
      )}
    </div>
  );
}

function Choices<T extends string>({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onSelect(id: T): void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-[0.1em] text-white/25">{label}</span>
      <div className="flex gap-0.5 rounded-md border border-white/[0.07] bg-ink-900/50 p-0.5">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onSelect(option.id)}
            aria-pressed={value === option.id}
            className={cn(
              'rounded-[4px] px-2 py-0.5 text-[11px] transition-all duration-200 ease-smooth',
              value === option.id
                ? 'bg-accent-500/[0.18] text-accent-200'
                : 'text-white/40 hover:text-white/80',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The grid, and the sentinel that keeps it growing.
 *
 * An `IntersectionObserver` rather than a scroll handler: it fires once when the
 * foot of the list comes into view and costs nothing in between, where a scroll
 * listener would run on every pixel of every wheel event.
 */
function Results() {
  const results = useDownloads((state) => state.results);
  const more = useDownloads((state) => state.more);
  const loadingMore = useDownloads((state) => state.loadingMore);
  const loadMore = useDownloads((state) => state.loadMore);

  const sentinel = useRef<HTMLDivElement | null>(null);

  const observe = useCallback(
    (node: HTMLDivElement | null) => {
      sentinel.current = node;
    },
    [],
  );

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !more) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      // Fetched a little before the foot is reached, so the grid grows without
      // the scroll ever stopping at an empty edge.
      { rootMargin: '400px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [more, loadMore, results.length]);

  return (
    <>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
        {results.map((result) => (
          <ResultTile key={result.id} result={result} />
        ))}
        {/* Appended rather than shown below the grid: the next page arrives
            where it will actually sit, so the scroll never lurches. */}
        {loadingMore && <ResultSkeletons count={4} keyPrefix="more" />}
      </ul>

      <div ref={observe} className="h-10">
        {!more && !loadingMore && results.length > 0 && (
          <p className="num pt-3 text-center text-[10px] text-white/20">
            {results.length} résultats
          </p>
        )}
      </div>
    </>
  );
}

/**
 * The grid, before it has anything in it.
 *
 * Deliberately the same geometry as `ResultTile` down to the corner radius: the
 * point of a skeleton is that nothing moves when the answer arrives. The title
 * widths vary with the index because every row being the same length is the
 * tell that a placeholder is a placeholder.
 */
function ResultSkeletons({ count, keyPrefix = 'sk' }: { count: number; keyPrefix?: string }) {
  const WIDTHS = ['w-[92%]', 'w-[78%]', 'w-[85%]', 'w-[64%]'];
  const TAILS = ['w-[46%]', 'w-[38%]', 'w-[52%]'];

  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <li key={`${keyPrefix}-${index}`} aria-hidden>
          <div className="overflow-hidden rounded-[3px] border border-white/[0.06] bg-white/[0.022]">
            <SkeletonBlock className="aspect-video w-full" />
            <div className="space-y-1.5 px-2.5 py-2">
              <SkeletonLine className={cn('text-2xs', WIDTHS[index % WIDTHS.length])} />
              {/* A second line only sometimes: real titles wrap unevenly. */}
              {index % 3 !== 1 && <SkeletonLine className="w-[55%] text-2xs" />}
              <SkeletonLine className={cn('!mt-2 text-[10px]', TAILS[index % TAILS.length])} />
            </div>
          </div>
        </li>
      ))}
    </>
  );
}

function Empty({ message, searching }: { message: string | null; searching: boolean }) {
  if (searching) {
    return (
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
        <ResultSkeletons count={8} />
      </ul>
    );
  }
  return (
    <div className="pt-16 text-center">
      {message ? (
        <p className="mx-auto flex max-w-[42ch] justify-center gap-1.5 text-2xs leading-relaxed text-amber-300/70">
          <TriangleAlert size={12} strokeWidth={2.2} className="mt-0.5 shrink-0" />
          <span>{message}</span>
        </p>
      ) : (
        <p className="mx-auto max-w-[40ch] text-2xs leading-relaxed text-white/30">
          Cherchez une musique, un bruitage, un plan de coupe. Un lien collé ouvre directement la
          vidéo qu’il désigne.
        </p>
      )}
    </div>
  );
}

function ResultTile({ result }: { result: SearchResult }) {
  const select = useDownloads((state) => state.select);
  const views = formatCount(result.views);

  return (
    <li>
      <button
        type="button"
        onClick={() => select(result)}
        className={cn(
          'group block w-full overflow-hidden rounded-[3px] border border-white/[0.06] text-left',
          'bg-white/[0.022] transition-all duration-200 ease-smooth',
          'hover:border-white/[0.14] hover:bg-white/[0.045] active:scale-[0.99]',
        )}
      >
        <span className="relative block aspect-video overflow-hidden bg-ink-950">
          {result.thumbnail ? (
            <img
              src={result.thumbnail}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-500 ease-smooth group-hover:scale-[1.04]"
            />
          ) : (
            <span className="grid h-full place-items-center text-white/15">
              <AudioLines size={20} strokeWidth={1.6} />
            </span>
          )}

          <span
            className={cn(
              'num absolute bottom-1.5 right-1.5 rounded-[3px] px-1.5 py-0.5 text-[10px]',
              'bg-ink-950/85 text-white/75 backdrop-blur',
            )}
          >
            {result.live ? (
              <span className="flex items-center gap-1 text-red-300">
                <Radio size={9} strokeWidth={2.6} />
                direct
              </span>
            ) : result.duration ? (
              formatClock(result.duration)
            ) : (
              '—'
            )}
          </span>
        </span>

        <span className="block px-2.5 py-2">
          <span className="line-clamp-2 text-2xs leading-snug text-white/80">{result.title}</span>
          <span className="num mt-1 flex items-center gap-2 text-[10px] text-white/30">
            {result.uploader && <span className="truncate">{result.uploader}</span>}
            {views && <span className="shrink-0">{views} vues</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * Choosing what to fetch
 * ------------------------------------------------------------------ */

/**
 * What this video actually offers, and which of it to take.
 *
 * Clicking a result inspects before it fetches, which is what makes this list
 * honest: the resolutions shown are the ones that exist. A video that stops at
 * 720p has no 1080p row to grey out — there is nothing to disable and nothing
 * to fall back from, because the list *is* the answer.
 */
function FormatPicker({ result }: { result: SearchResult }) {
  const select = useDownloads((state) => state.select);
  const formats = useDownloads((state) => state.formats);
  const inspecting = useDownloads((state) => state.inspecting);
  const error = useDownloads((state) => state.formatError);
  const errorKind = useDownloads((state) => state.formatErrorKind);
  const selection = useDownloads((state) => state.selection);
  const choose = useDownloads((state) => state.choose);
  const enqueue = useDownloads((state) => state.enqueue);

  const views = formatCount(result.views);
  const live = result.live || formats?.live === true;

  const confirm = async () => {
    await enqueue(result, selection);
    // Back to the grid: the queue on the left is now where the story continues.
    select(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-5 pb-2 pt-3.5">
        <button
          type="button"
          onClick={() => select(null)}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-2xs text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white/85"
        >
          <ArrowLeft size={13} strokeWidth={2.2} />
          Retour aux résultats
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
        <div className="mx-auto max-w-[680px]">
          <div className="flex gap-4">
            <div className="w-[240px] shrink-0 overflow-hidden rounded-[3px] border border-white/[0.07] bg-ink-950">
              {result.thumbnail ? (
                <img src={result.thumbnail} alt="" className="aspect-video w-full object-cover" />
              ) : (
                <div className="grid aspect-video place-items-center text-white/15">
                  <AudioLines size={24} strokeWidth={1.4} />
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <h3 className="text-[15px] font-medium leading-snug tracking-tight text-white/92">
                {result.title}
              </h3>
              <p className="num mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-white/35">
                {result.uploader && <span>{result.uploader}</span>}
                {result.duration && <span>{formatClock(result.duration)}</span>}
                {views && <span>{views} vues</span>}
                {live && <span className="text-red-300/80">en direct</span>}
              </p>
            </div>
          </div>

          {live ? (
            <Notice tone="warn">
              Un direct n’a pas de fin : il n’y a rien à récupérer tant qu’il n’est pas terminé.
            </Notice>
          ) : inspecting ? (
            <FormatSkeletons />
          ) : error ? (
            <>
              <Notice tone="warn">{error}</Notice>
              {(errorKind === 'unavailable' || errorKind === 'tool') && <StaleTool />}
            </>
          ) : formats ? (
            <div className="mt-5 space-y-5">
              <section>
                <h4 className="eyebrow mb-2">Vidéo</h4>
                {formats.video.length === 0 ? (
                  <p className="text-2xs text-white/30">
                    Aucune piste vidéo — seul le son est disponible.
                  </p>
                ) : (
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    <Offer
                      title="Meilleure qualité"
                      hint={
                        formats.video[0]
                          ? `${formats.video[0].label} · ${describeOffer(formats.video[0])}`
                          : 'La plus haute disponible'
                      }
                      size={formats.video[0]?.size ?? null}
                      active={selection.kind === 'video' && selection.height === null}
                      onSelect={() => choose({ kind: 'video', height: null })}
                    />
                    {formats.video.map((offer) => (
                      <VideoRow
                        key={offer.height}
                        offer={offer}
                        active={selection.kind === 'video' && selection.height === offer.height}
                        onSelect={() => choose({ kind: 'video', height: offer.height })}
                      />
                    ))}
                  </div>
                )}
              </section>

              <section>
                <h4 className="eyebrow mb-2">
                  Audio uniquement
                  {formats.audio[0]?.bitrate && (
                    <span className="num ml-2 font-normal normal-case tracking-normal text-white/25">
                      source {Math.round(formats.audio[0].bitrate)} kbit/s{' '}
                      {formats.audio[0].codec}
                    </span>
                  )}
                </h4>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {AUDIO_TARGETS.map((target) => (
                    <Offer
                      key={target.id}
                      title={target.label}
                      hint={target.hint}
                      size={target.id === 'original' ? formats.audio[0]?.size ?? null : null}
                      active={selection.kind === 'audio' && selection.format === target.id}
                      onSelect={() => choose({ kind: 'audio', format: target.id })}
                    />
                  ))}
                </div>
              </section>
            </div>
          ) : null}

          <p className="num mt-4 truncate text-[10px] text-white/22" title={result.url}>
            {result.url}
          </p>
        </div>
      </div>

      {!live && (
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-white/[0.06] bg-white/[0.015] px-5 py-3">
          <p className="num truncate text-2xs text-white/35">{describeSelection(selection)}</p>
          <button
            type="button"
            disabled={inspecting}
            onClick={() => void confirm()}
            className={cn(
              'inline-flex h-9 shrink-0 items-center gap-2 rounded-xl px-4',
              'bg-accent-500 text-2xs font-semibold text-white shadow-glow',
              'transition-all duration-200 ease-smooth hover:bg-accent-400 active:scale-[0.985]',
              'disabled:pointer-events-none disabled:opacity-40',
            )}
          >
            <Download size={13} strokeWidth={2.4} />
            Valider le téléchargement
          </button>
        </footer>
      )}
    </div>
  );
}

/** The picker's own shape, held while yt-dlp is asked what exists. */
function FormatSkeletons() {
  return (
    <div className="mt-5 space-y-5" aria-hidden>
      {[
        { title: 'Vidéo', rows: 4 },
        { title: 'Audio uniquement', rows: 4 },
      ].map((section) => (
        <section key={section.title}>
          <h4 className="eyebrow mb-2">{section.title}</h4>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {Array.from({ length: section.rows }, (_, index) => (
              <div
                key={index}
                className="flex items-center gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.022] px-3 py-2"
              >
                <SkeletonBlock className="h-4 w-4 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <SkeletonLine className="w-[42%] text-2xs" />
                  <SkeletonLine className="w-[70%] text-[10px]" />
                </div>
                <SkeletonBlock className="h-2 w-9 shrink-0 rounded-[2px]" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

const describeSelection = (selection: Selection): string =>
  selection.kind === 'audio'
    ? `Audio · ${AUDIO_TARGETS.find((item) => item.id === selection.format)?.label ?? selection.format}`
    : selection.height
      ? `Vidéo · ${selection.height}p maximum`
      : 'Vidéo · meilleure qualité';

function VideoRow({
  offer,
  active,
  onSelect,
}: {
  offer: VideoOffer;
  active: boolean;
  onSelect(): void;
}) {
  return (
    <Offer
      title={offer.label}
      hint={describeOffer(offer)}
      size={offer.size}
      active={active}
      onSelect={onSelect}
    />
  );
}

function Offer({
  title,
  hint,
  size,
  active,
  onSelect,
}: {
  title: string;
  hint: string;
  size: number | null;
  active: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left',
        'transition-all duration-200 ease-smooth active:scale-[0.99]',
        active
          ? 'border-accent-500/45 bg-accent-500/[0.1]'
          : 'border-white/[0.07] bg-white/[0.022] hover:border-white/[0.16] hover:bg-white/[0.045]',
      )}
    >
      <span
        className={cn(
          'grid h-4 w-4 shrink-0 place-items-center rounded-full border transition-all duration-200',
          active ? 'border-accent-400 bg-accent-500' : 'border-white/15',
        )}
      >
        {active && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-2xs font-medium text-white/85">{title}</span>
        <span className="mt-0.5 block truncate text-[10px] text-white/35">{hint}</span>
      </span>

      {size !== null && (
        <span className="num shrink-0 text-[10px] text-white/30">{formatBytes(size)}</span>
      )}
    </button>
  );
}

/**
 * The other explanation for a refusal.
 *
 * yt-dlp is the one part of Veglass with an expiry date: it breaks whenever a
 * site changes its player, and what that looks like from here is a video
 * reported as unavailable — indistinguishable, from the panel's side, from one
 * that really is closed. Leaving it at the first reading tells the user their
 * video is gone when the fix is a two-second download, so when the binary is
 * old enough to be the likelier cause, the panel says so and offers it.
 */
function StaleTool() {
  const tool = useDownloads((state) => state.tool);
  const installing = useDownloads((state) => state.installing);
  const setup = useDownloads((state) => state.setupTool);

  if (!tool.available) return null;

  const stale = isStale(tool);
  const age = stale
    ? `Votre copie de yt-dlp date de ${tool.version} — ${tool.ageDays} jours. Une version périmée produit exactement ce message sur des vidéos pourtant en ligne.`
    : 'Si la vidéo se lit normalement dans un navigateur, c’est yt-dlp qui décroche plutôt que la vidéo qui manque.';

  // A copy from the PATH, or one pointed at by VEGLASS_YTDLP, is not ours to
  // replace: installing would write a second binary that `locate` never picks
  // up, and the button would look like it had done nothing.
  const ours = tool.managed && tool.installable;

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 pl-[18px]">
      <p className="min-w-[22ch] flex-1 text-2xs leading-relaxed text-white/35">
        {age}
        {!ours && tool.path && (
          <>
            {' '}
            Cette copie n’est pas gérée par Veglass —{' '}
            <span className="num text-white/45">{tool.path}</span> — c’est donc à vous de la
            mettre à jour.
          </>
        )}
      </p>
      {ours && (
        <Button
          size="sm"
          variant={stale ? 'primary' : 'ghost'}
          disabled={installing}
          onClick={() => void setup()}
        >
          {installing ? 'Mise à jour…' : 'Mettre à jour yt-dlp'}
        </Button>
      )}
    </div>
  );
}

function Notice({ tone, children }: { tone: 'warn'; children: React.ReactNode }) {
  return (
    <p
      className={cn(
        'mt-5 flex gap-1.5 rounded-xl border px-3.5 py-3 text-2xs leading-relaxed',
        tone === 'warn' && 'border-amber-500/25 bg-amber-500/[0.06] text-amber-100/80',
      )}
    >
      <TriangleAlert size={12} strokeWidth={2.2} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
