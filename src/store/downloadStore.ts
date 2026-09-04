/**
 * Session state for the online-media panel.
 *
 * Apart from the editor store on purpose, for the same reason the AI suite is:
 * a search, a queue and a tool status belong to this run of the application,
 * not to the document. Folding them in would put a download queue inside the
 * undo history and inside the saved project.
 *
 * The two stores meet at one point, and only one: a finished download is handed
 * to `useEditor.getState().importPaths(...)`, the same road the native file
 * picker takes. From there the editor has no idea the file came from a search.
 */

import { create } from 'zustand';

import { uid } from '@/lib/id';
import { useEditor } from '@/store/editorStore';
import {
  OnlineError,
  cancelDownload,
  download,
  getFormats,
  installTool,
  onDownloadProgress,
  onInstallProgress,
  search,
  toOnlineError,
  toolStatus,
} from '@/lib/online/client';
import {
  DEFAULT_FILTERS,
  isFinished,
  isRunning,
  type DownloadJob,
  type InstallProgress,
  type MediaFormats,
  type OnlineErrorKind,
  type SearchFilters,
  type SearchResult,
  type Selection,
  type ToolStatus,
} from '@/types/online';

/** Past this, the queue is a wall rather than a list; finished rows are trimmed. */
const MAX_HISTORY = 40;

/**
 * How much of the new reading to believe. Lower is calmer.
 *
 * yt-dlp reports the *instantaneous* rate, which on a real connection swings by
 * a factor of three between two ticks — a figure that changes four times a
 * second is a figure nobody can read. An exponential average keeps it responsive
 * to a genuine change while ignoring the jitter.
 */
const SPEED_WEIGHT = 0.25;

const smooth = (previous: number, incoming: number): number => {
  if (incoming <= 0) return previous;
  // The first real reading is taken whole: easing up from zero would show a
  // rate that was never true.
  if (previous <= 0) return incoming;
  return previous * (1 - SPEED_WEIGHT) + incoming * SPEED_WEIGHT;
};

interface DownloadState {
  tool: ToolStatus;
  installing: boolean;
  install: InstallProgress | null;

  browserOpen: boolean;
  query: string;
  filters: SearchFilters;
  results: SearchResult[];
  searching: boolean;
  /** A page is being appended, as opposed to a fresh search running. */
  loadingMore: boolean;
  /** Where the next page starts, and whether there is one. */
  offset: number;
  more: boolean;
  searchError: string | null;

  /** The result whose detail panel is open, if any. */
  selected: SearchResult | null;
  /** What that result actually offers — read before anything is fetched. */
  formats: MediaFormats | null;
  inspecting: boolean;
  formatError: string | null;
  /** Why the inspection failed — the picker acts on this, not on the wording. */
  formatErrorKind: OnlineErrorKind | null;
  /** The quality or audio target currently chosen in the picker. */
  selection: Selection;

  jobs: DownloadJob[];

  boot(): Promise<void>;
  openBrowser(open: boolean): void;
  refreshTool(): Promise<void>;
  setupTool(): Promise<void>;

  setQuery(query: string): void;
  setFilters(patch: Partial<SearchFilters>): void;
  runSearch(query?: string): Promise<void>;
  loadMore(): Promise<void>;
  select(result: SearchResult | null): void;
  choose(selection: Selection): void;

  enqueue(result: SearchResult, selection: Selection): Promise<void>;
  cancel(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  importJob(id: string): Promise<void>;
  importFinished(): Promise<void>;
  dismiss(id: string): void;
  clearFinished(): void;
}

/**
 * The event bridges and the in-flight search.
 *
 * Module-level because none of it is rendered, and because replacing the
 * search controller must not schedule a React update mid-request.
 */
let stopProgress: (() => void) | null = null;
let stopInstall: (() => void) | null = null;
let inflight: AbortController | null = null;

const notify = (message: string, tone?: 'info' | 'success' | 'error') =>
  useEditor.getState().notify(message, tone);

export const useDownloads = create<DownloadState>((set, get) => {
  const patchJob = (id: string, patch: Partial<DownloadJob>) => {
    set((state) => ({
      jobs: state.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)),
    }));
  };

  /**
   * Turns a failure into something visible, and where it helps, actionable.
   *
   * A missing binary is not an error the user caused, so it opens the offer to
   * install rather than only complaining about it.
   */
  const report = (error: unknown, prefix: string): OnlineError => {
    const failure = toOnlineError(error);
    if (failure.kind === 'cancelled') return failure;
    if (failure.kind === 'missing-binary') void get().refreshTool();
    notify(`${prefix} — ${failure.message}`, 'error');
    return failure;
  };

  /**
   * Whether there is somewhere to put the file.
   *
   * Checked before a row is created rather than after: a job enqueued with no
   * project open used to sit on "En attente" for ever, because the guard was
   * inside `start` and the row had already been added by then.
   */
  const destination = (): string | null => {
    const project = useEditor.getState().project;
    if (project) return project.id;
    notify('Ouvrez un projet avant de télécharger', 'error');
    return null;
  };

  /** Sends one job to Rust and follows it to its end. */
  const start = async (job: DownloadJob, projectId: string) => {
    // Cleared first, so a retry never shows the previous run's rate while the
    // new one is still finding its feet.
    patchJob(job.id, {
      stage: 'download',
      error: null,
      ratio: 0,
      received: 0,
      speed: 0,
      eta: 0,
    });

    try {
      const report_ = await download({
        id: job.id,
        url: job.url,
        projectId,
        title: job.title,
        selection: job.selection,
      });
      patchJob(job.id, {
        stage: 'done',
        ratio: 1,
        path: report_.path,
        name: report_.name,
        bytes: report_.bytes,
      });
      notify(`« ${report_.name} » téléchargé`, 'success');
    } catch (error) {
      const failure = toOnlineError(error);
      if (failure.kind === 'cancelled') {
        patchJob(job.id, { stage: 'cancelled', error: null });
        return;
      }
      patchJob(job.id, { stage: 'failed', error: failure.message });
      report(failure, 'Téléchargement');
    }
  };

  return {
    tool: {
      available: false,
      installable: false,
      path: null,
      version: null,
      ageDays: null,
      managed: false,
    },
    installing: false,
    install: null,

    browserOpen: false,
    query: '',
    filters: { ...DEFAULT_FILTERS },
    results: [],
    searching: false,
    loadingMore: false,
    offset: 0,
    more: false,
    searchError: null,

    selected: null,
    formats: null,
    inspecting: false,
    formatError: null,
    formatErrorKind: null,
    selection: { kind: 'video', height: null },

    jobs: [],

    async boot() {
      // One subscription for the whole queue: the payload carries the job id,
      // so a listener per download would only churn the bridge.
      if (!stopProgress) {
        stopProgress = await onDownloadProgress((progress) => {
          set((state) => ({
            jobs: state.jobs.map((job) =>
              job.id === progress.id
                ? {
                    ...job,
                    stage: progress.stage,
                    ratio: progress.ratio,
                    received: progress.received,
                    total: progress.total,
                    speed: smooth(job.speed, progress.speed),
                    eta: progress.eta,
                  }
                : job,
            ),
          }));
        }).catch(() => null);
      }
      if (!stopInstall) {
        stopInstall = await onInstallProgress((install) => set({ install })).catch(() => null);
      }
      await get().refreshTool();
    },

    openBrowser(open) {
      set({ browserOpen: open });
    },

    async refreshTool() {
      try {
        set({ tool: await toolStatus() });
      } catch {
        // A tool that will not answer is reported as absent, which is what the
        // panel would show anyway; failing startup over it would be worse.
      }
    },

    async setupTool() {
      if (get().installing) return;
      set({ installing: true, install: null });
      try {
        const had = get().tool.available;
        const tool = await installTool();
        set({ tool });
        const what = had ? 'yt-dlp mis à jour' : 'yt-dlp installé';
        notify(`${what}${tool.version ? ` (${tool.version})` : ''}`, 'success');
      } catch (error) {
        report(error, 'Installation');
      } finally {
        set({ installing: false, install: null });
      }
    },

    /* ---------------- Browsing ---------------- */

    setQuery(query) {
      set({ query });
    },

    setFilters(patch) {
      set((state) => ({ filters: { ...state.filters, ...patch } }));
      // A filter change is a different question, so it is asked immediately
      // rather than waiting for the user to press Enter again.
      if (get().query.trim()) void get().runSearch();
    },

    async runSearch(query) {
      const text = (query ?? get().query).trim();
      set({ query: text });
      if (!text) {
        set({ results: [], searchError: null, selected: null });
        return;
      }
      if (!get().tool.available) {
        await get().refreshTool();
        if (!get().tool.available) {
          notify('yt-dlp est requis pour la recherche', 'error');
          return;
        }
      }

      // A new query abandons the last one rather than racing it.
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      set({ searching: true, searchError: null, selected: null, formats: null, offset: 0 });

      try {
        const page = await search(text, get().filters, 0, controller.signal);
        if (controller.signal.aborted) return;
        set({
          results: page.results,
          offset: page.nextOffset,
          more: page.more,
          searchError: page.results.length === 0 ? 'Aucun résultat' : null,
        });
      } catch (error) {
        const failure = toOnlineError(error);
        if (failure.kind === 'cancelled') return;
        set({ results: [], more: false, searchError: failure.message });
        if (failure.kind === 'missing-binary') void get().refreshTool();
      } finally {
        if (inflight === controller) {
          inflight = null;
          set({ searching: false });
        }
      }
    },

    /**
     * Appends the next page.
     *
     * Guarded on both flags: the sentinel at the foot of the grid can fire
     * again while a page is still in flight, and a scroll that asked twice
     * would show every row twice.
     */
    async loadMore() {
      const state = get();
      if (!state.more || state.searching || state.loadingMore) return;

      set({ loadingMore: true });
      try {
        const page = await search(state.query, state.filters, state.offset);
        set((current) => ({
          // Deduplicated by id: YouTube's paging is not a stable cursor, and a
          // shifted page would otherwise repeat a row already on screen.
          results: [
            ...current.results,
            ...page.results.filter(
              (item) => !current.results.some((existing) => existing.id === item.id),
            ),
          ],
          offset: page.nextOffset,
          more: page.more,
        }));
      } catch (error) {
        const failure = toOnlineError(error);
        if (failure.kind !== 'cancelled') set({ more: false });
      } finally {
        set({ loadingMore: false });
      }
    },

    /**
     * Opens a result, and reads what it actually offers.
     *
     * The inspection is why clicking a tile no longer starts a download: the
     * resolutions on the picker are the ones this video has, so there is
     * nothing to grey out and nothing to fall back from.
     */
    select(result) {
      set({
        selected: result,
        formats: null,
        formatError: null,
        formatErrorKind: null,
        selection: { kind: 'video', height: null },
      });
      if (!result) return;

      set({ inspecting: true });
      void getFormats(result.url)
        .then((formats) => {
          // The user may have gone back, or opened another, while we asked.
          if (get().selected?.id !== result.id) return;
          set({ formats });
        })
        .catch((error) => {
          if (get().selected?.id !== result.id) return;
          const failure = toOnlineError(error);
          set({ formatError: failure.message, formatErrorKind: failure.kind });
        })
        .finally(() => {
          if (get().selected?.id === result.id) set({ inspecting: false });
        });
    },

    choose(selection) {
      set({ selection });
    },

    /* ---------------- Fetching ---------------- */

    async enqueue(result, selection) {
      if (result.live) {
        notify('Un direct n’a pas de fin — impossible à télécharger', 'error');
        return;
      }
      const projectId = destination();
      if (!projectId) return;

      const audioOnly = selection.kind === 'audio';
      const job: DownloadJob = {
        id: uid('dl'),
        title: result.title,
        url: result.url,
        thumbnail: result.thumbnail,
        selection,
        audioOnly,
        quality:
          selection.kind === 'audio'
            ? selection.format.toUpperCase()
            : selection.height
              ? `${selection.height}p`
              : 'Meilleure',
        stage: 'queued',
        ratio: 0,
        received: 0,
        total: 0,
        speed: 0,
        eta: 0,
        path: null,
        name: null,
        bytes: 0,
        imported: false,
        error: null,
        startedAt: Date.now(),
      };
      set((state) => ({ jobs: [job, ...state.jobs].slice(0, MAX_HISTORY) }));
      await start(job, projectId);
    },

    async cancel(id) {
      const job = get().jobs.find((item) => item.id === id);
      if (!job || !isRunning(job)) return;
      // Marked first: the command resolves once the child is dead, and the row
      // should stop animating the moment the user asks it to.
      patchJob(id, { stage: 'cancelled' });
      try {
        await cancelDownload(id);
      } catch {
        /* already gone — the state above is still the right one */
      }
    },

    async retry(id) {
      const job = get().jobs.find((item) => item.id === id);
      if (!job || isRunning(job)) return;
      const projectId = destination();
      if (!projectId) return;
      await start({ ...job, stage: 'queued' }, projectId);
    },

    /* ---------------- Into the project ---------------- */

    async importJob(id) {
      const job = get().jobs.find((item) => item.id === id);
      if (!job?.path || job.imported) return;

      const added = await useEditor.getState().importPaths([job.path]);
      if (added === 0) {
        notify('Ouvrez un projet pour y ajouter ce média', 'error');
        return;
      }
      patchJob(id, { imported: true });
      notify(`« ${job.name ?? job.title} » ajouté aux médias`, 'success');
    },

    async importFinished() {
      const ready = get().jobs.filter((job) => job.stage === 'done' && !job.imported && job.path);
      if (ready.length === 0) return;

      const added = await useEditor
        .getState()
        .importPaths(ready.map((job) => job.path as string));
      if (added === 0) {
        notify('Ouvrez un projet pour y ajouter ces médias', 'error');
        return;
      }
      const done = new Set(ready.map((job) => job.id));
      set((state) => ({
        jobs: state.jobs.map((job) => (done.has(job.id) ? { ...job, imported: true } : job)),
      }));
      notify(`${added} média${added > 1 ? 's ajoutés' : ' ajouté'} au projet`, 'success');
    },

    dismiss(id) {
      const job = get().jobs.find((item) => item.id === id);
      if (job && isRunning(job)) void get().cancel(id);
      set((state) => ({ jobs: state.jobs.filter((item) => item.id !== id) }));
    },

    clearFinished() {
      set((state) => ({ jobs: state.jobs.filter((job) => !isFinished(job)) }));
    },
  };
});
