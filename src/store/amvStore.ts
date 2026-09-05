/**
 * The rhythmic-montage generator's own state.
 *
 * Session-scoped, like `viralStore` and `tutorialStore` and for the same
 * reason: a wizard's answers, a run's progress and a set of *proposed* beats
 * are not part of the document. Folding them into `editorStore` would put them
 * inside the undo history and inside the saved project, and undoing a montage
 * change would quietly rewind a beat analysis.
 *
 * It touches the document at exactly one point — `importAll` — and that point is
 * a single `transact`. The music, the clips it used, three tracks, a few
 * hundred shots with their camera curves, the flashes over them, the dissolves
 * between them and the markers under them are one edit and one press of Ctrl+Z.
 *
 * # Two things this store is careful about
 *
 * Media picked in the wizard does **not** join the project until the montage
 * does. Someone who opens the wizard, points at a folder and changes their mind
 * should be left with the project they started with, not with sixty clips in
 * the pool. And re-detection is free: the measured curve is kept here, out of
 * the rendered state, so dragging the sensitivity re-picks the beats without
 * going near ffmpeg again.
 *
 * # Two origins, one bank
 *
 * The music and the clips can come from the project's own media or from the
 * disk, and the sequencer is told nothing about which. What it gets either way
 * is a `MediaAsset` with a path and a probed duration — an asset already in the
 * pool simply arrives with both filled in. `importAll` matches on the **path**
 * for exactly this reason: picking a clip that is already in the project must
 * point the montage at the asset that is there, not add a second copy of it.
 */

import { create } from 'zustand';

import { AiError, toAiError } from '@/lib/ai/client';
import { assetFromPath, probeMedia } from '@/lib/media';
import { listFolder, onsetCurve } from '@/lib/amv/client';
import { detectBeats, estimateTempo, type Beat, type OnsetCurve } from '@/lib/amv/beats';
import { placeAmv, type AmvBuild } from '@/lib/amv/build';
import { usableSources } from '@/lib/amv/sources';
import { readStructure, type Structure } from '@/lib/amv/structure';
import { useEditor } from '@/store/editorStore';
import type { MediaAsset } from '@/types/media';
import type { Project } from '@/types/project';
import {
  AMV_LIMITS,
  DEFAULT_AMV_OPTIONS,
  type AmvOptions,
  type AmvRecipe,
  type AmvStage,
  type PhaseId,
} from '@/types/amv';

/** How the run summary names each movement. */
const PHASE_WORD: Record<PhaseId, string> = {
  intro: 'en intro',
  build: 'en montée',
  drop: 'au drop',
};

export type WizardStep = 'source' | 'settings' | 'work' | 'review';

export const STEP_ORDER: WizardStep[] = ['source', 'settings', 'work', 'review'];

/** What the folder picker will pick up. Video only — see `usableSources`. */
const CLIP_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi'];
const MUSIC_EXTENSIONS = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus'];

/**
 * Ceiling on the clips read from one folder.
 *
 * Each has to be opened by the platform decoder to learn how long it is, and
 * that is the slow part of the whole wizard. Well past the point where more
 * sources make a montage more varied, and low enough that pointing at the wrong
 * folder costs seconds rather than minutes.
 */
const MAX_SOURCES = 120;

/**
 * How many probes run at once.
 *
 * Each is a `<video>` element decoding a header. All of them at once makes the
 * webview thrash and every one of them time out together; one at a time makes a
 * sixty-clip folder take a minute. A dozen keeps the pass moving and the
 * progress bar honest.
 */
const PROBE_BATCH = 12;

/** How the two phases share the bar. Probing is the one that can be measured. */
const READ_SHARE = 0.6;

interface AmvState {
  open: boolean;
  step: WizardStep;
  options: AmvOptions;

  /** Picked in the wizard, not yet in the project. */
  music: MediaAsset | null;
  sources: MediaAsset[];
  folder: string | null;
  /** Files in the folder that could not be read, reported rather than hidden. */
  skipped: number;

  stage: AmvStage;
  /** 0 → 1 over the whole run, weighted across its phases. */
  progress: number;
  /**
   * When the run began, so the wait can show elapsed seconds.
   *
   * The analysis is one opaque ffmpeg pass with nothing to report until it
   * finishes, and a bar frozen at 60 % is indistinguishable from a hang unless
   * something on screen is still moving.
   */
  startedAt: number | null;
  detail: string;
  error: string | null;

  beats: Beat[];
  tempo: number | null;
  /**
   * The narrative arc read off those beats.
   *
   * Kept beside them, and rebuilt with them, because it is a *function* of them
   * — a sensitivity drag that changed the beats and left the structure alone
   * would leave the montage describing an arc the music no longer has.
   *
   * `null` only before a run has produced anything.
   */
  structure: Structure | null;
  /** True once the montage has been committed to the document. */
  placed: boolean;

  openWizard(musicAssetId?: string): void;
  close(): void;
  goTo(step: WizardStep): void;
  setOptions(patch: Partial<AmvOptions>): void;

  /** Takes the soundtrack from the project's own media. */
  pickMusic(assetId: string): void;
  /** Adds or removes one of the project's videos from the bank. */
  toggleSource(assetId: string): void;
  /** Ticks or clears every usable video the project holds. */
  selectAllSources(on: boolean): void;

  chooseMusic(): Promise<void>;
  chooseFolder(): Promise<void>;

  run(): Promise<void>;
  cancel(): void;

  /**
   * Writes the montage, in one undo step.
   *
   * The recipe is a **required argument** and not a piece of state, and that is
   * the lock rather than a convenience. Only the director produces one — from a
   * strategy Gemini answered with — so there is no longer any way to reach the
   * timeline by pressing a button that quietly applies a default profile. A
   * caller that wants to commit has to have been given something to commit.
   */
  importAll(recipe: AmvRecipe): void;
  reset(): void;
}

export const useAmv = create<AmvState>((set, get) => {
  /** The run in flight, if any. Kept out of the store: it is not rendered. */
  let inflight: AbortController | null = null;
  /**
   * The measured curve, held outside the rendered state.
   *
   * Three arrays of tens of thousands of numbers, never read during a render,
   * and the whole reason the sensitivity slider is free. Cleared with the run
   * that produced it.
   */
  let curve: OnsetCurve | null = null;

  const notify = (message: string, tone: 'info' | 'success' | 'error' = 'info') =>
    useEditor.getState().notify(message, tone);

  /**
   * Turns a path into an asset with its duration filled in.
   *
   * `null` when the file will not open — a placeholder in the folder, something
   * the decoder does not support, a broken download. The caller counts those
   * and says so rather than letting a zero-length clip into the montage.
   */
  const probed = async (path: string, kind: 'video' | 'audio'): Promise<MediaAsset | null> => {
    const asset = await assetFromPath(path);
    const probe = await probeMedia(asset.src, kind);
    if (!(probe.duration > 0)) return null;
    return { ...asset, kind, duration: probe.duration, width: probe.width, height: probe.height };
  };

  /**
   * Re-picks the beats from the curve already in memory, and re-reads the arc
   * from those beats. Cheap by design — no decode, no disk.
   */
  const redetect = (sensitivity: number, span: number) => {
    if (!curve) return;
    const beats = detectBeats(curve, sensitivity);
    set({ beats, tempo: estimateTempo(beats), structure: readStructure(beats, span) });
  };

  return {
    open: false,
    step: 'source',
    options: DEFAULT_AMV_OPTIONS,

    music: null,
    sources: [],
    folder: null,
    skipped: 0,

    stage: 'idle',
    progress: 0,
    startedAt: null,
    detail: '',
    error: null,

    beats: [],
    tempo: null,
    structure: null,
    placed: false,

    openWizard(musicAssetId) {
      const project = useEditor.getState().project;
      const assets = project?.assets ?? [];

      const chosen =
        assets.find(
          (asset) => asset.id === musicAssetId && asset.kind === 'audio' && !asset.missing,
        ) ?? null;

      set((state) => ({
        open: true,
        step: 'source',
        error: null,
        // The selection in the media pool, when it is a piece of music. Same
        // courtesy the other two wizards extend: arriving with the file already
        // chosen skips the step someone had effectively just completed.
        music: chosen ?? state.music,
        /*
         * Every usable video in the project, ticked, on a first open.
         *
         * An AMV is normally built from *everything* to hand, so the empty bank
         * is the answer nobody wants — and unticking a few is quicker than
         * ticking thirty. A run already in progress keeps whatever it had.
         */
        sources: state.sources.length > 0 ? state.sources : usableSources(assets),
      }));
    },

    pickMusic(assetId) {
      const asset = useEditor
        .getState()
        .project?.assets.find((item) => item.id === assetId && item.kind === 'audio');
      if (!asset) return;

      if (!asset.path) {
        set({
          error:
            "Ce morceau n'a pas de fichier sur le disque — réimportez-le pour que le rythme puisse être analysé.",
        });
        return;
      }
      if (!(asset.duration > 0)) {
        set({ error: "La durée de ce morceau n'a pas encore été lue. Réessayez dans un instant." });
        return;
      }
      if (asset.duration < AMV_LIMITS.minMusic) {
        set({
          error: `Ce morceau dure ${asset.duration.toFixed(1)} s — il n'y a pas de quoi monter dessus.`,
        });
        return;
      }

      // A new track invalidates the beats found in the previous one.
      curve = null;
      set({ music: asset, beats: [], tempo: null, structure: null, error: null, placed: false });
    },

    toggleSource(assetId) {
      const asset = useEditor.getState().project?.assets.find((item) => item.id === assetId);
      if (!asset) return;

      set((state) => ({
        sources: state.sources.some((item) => item.id === assetId)
          ? state.sources.filter((item) => item.id !== assetId)
          : [...state.sources, asset],
        error: null,
      }));
    },

    selectAllSources(on) {
      const assets = useEditor.getState().project?.assets ?? [];
      const pool = usableSources(assets);
      const ids = new Set(pool.map((asset) => asset.id));

      set((state) => ({
        // Only the project's own clips are touched: a folder someone browsed to
        // is not shown as a row here, so a button they can see must not empty it.
        sources: on
          ? [...state.sources.filter((asset) => !ids.has(asset.id)), ...pool]
          : state.sources.filter((asset) => !ids.has(asset.id)),
        error: null,
      }));
    },

    close() {
      inflight?.abort();
      inflight = null;
      set({ open: false });
    },

    goTo(step) {
      set({ step });
    },

    setOptions(patch) {
      const before = get().options.sensitivity;
      set((state) => ({ options: { ...state.options, ...patch } }));

      // The one option that changes the answer without re-running anything.
      if (patch.sensitivity !== undefined && patch.sensitivity !== before) {
        redetect(patch.sensitivity, plannedSpan(get()));
      }
      // The arc is measured over the montage, not over the track, so shortening
      // it moves the boundaries — a thirty-second cut of a four-minute song has
      // its own opening and its own drop.
      if (patch.limit !== undefined && patch.limit !== get().options.limit) {
        redetect(get().options.sensitivity, plannedSpan(get()));
      }
    },

    async chooseMusic() {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const picked = await open({
          multiple: false,
          filters: [{ name: 'Musique', extensions: MUSIC_EXTENSIONS }],
        });
        if (typeof picked !== 'string') return;

        set({ detail: 'Lecture du morceau', error: null });
        const asset = await probed(picked, 'audio');
        if (!asset) {
          set({ error: "Ce fichier audio n'a pas pu être lu.", detail: '' });
          return;
        }
        if (asset.duration < AMV_LIMITS.minMusic) {
          set({
            error: `Ce morceau dure ${asset.duration.toFixed(1)} s — il n'y a pas de quoi monter dessus.`,
            detail: '',
          });
          return;
        }

        // A new track invalidates the beats found in the previous one.
        curve = null;
        set({
          music: asset,
          beats: [],
          tempo: null,
          structure: null,
          detail: '',
          error: null,
          placed: false,
        });
      } catch (error) {
        set({ error: toAiError(error).message, detail: '' });
      }
    },

    async chooseFolder() {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const picked = await open({ directory: true, multiple: false });
        if (typeof picked !== 'string') return;

        set({ folder: picked, detail: 'Lecture du dossier', error: null, skipped: 0 });

        const paths = await listFolder(picked, CLIP_EXTENSIONS);
        if (paths.length === 0) {
          set({
            sources: [],
            error: 'Aucune vidéo dans ce dossier.',
            detail: '',
          });
          return;
        }

        const wanted = paths.slice(0, MAX_SOURCES);
        const found: MediaAsset[] = [];
        for (let index = 0; index < wanted.length; index += PROBE_BATCH) {
          const batch = await Promise.all(
            wanted.slice(index, index + PROBE_BATCH).map((path) => probed(path, 'video')),
          );
          found.push(...batch.filter((asset): asset is MediaAsset => asset !== null));
          set({ detail: `Lecture des clips — ${Math.min(index + PROBE_BATCH, wanted.length)} / ${wanted.length}` });
        }

        const usable = usableSources(found);
        set((state) => ({
          /*
           * Added to the bank rather than replacing it.
           *
           * The clips ticked from the project are visible on screen, so a folder
           * pick that silently emptied them would undo a choice the user can see
           * they made. Matching on the path keeps a folder browsed to twice from
           * doubling every clip in it.
           */
          sources: [
            ...state.sources.filter(
              (asset) => !usable.some((item) => item.path === asset.path),
            ),
            ...usable,
          ],
          skipped: paths.length - usable.length,
          detail: '',
          error:
            usable.length === 0
              ? 'Aucun clip de ce dossier ne peut être monté — ils sont trop courts ou illisibles.'
              : null,
        }));
      } catch (error) {
        set({ error: toAiError(error).message, detail: '' });
      }
    },

    async run() {
      if (inflight) return;

      const { music, sources, options } = get();
      if (!music) {
        set({ error: 'Choisissez un morceau.', step: 'source' });
        return;
      }
      if (sources.length === 0) {
        set({ error: 'Choisissez un dossier de clips.', step: 'source' });
        return;
      }

      const controller = new AbortController();
      inflight = controller;

      set({
        step: 'work',
        stage: 'listening',
        progress: READ_SHARE,
        startedAt: Date.now(),
        detail: 'Repérage des temps forts',
        error: null,
        beats: [],
        tempo: null,
        structure: null,
        placed: false,
      });

      try {
        const measured = await onsetCurve(music.path);
        if (controller.signal.aborted) throw new AiError('cancelled', 'Analyse annulée.');

        curve = measured;
        const beats = detectBeats(measured, options.sensitivity);

        if (beats.length === 0) {
          set({
            stage: 'failed',
            error:
              "Aucun temps n'a été trouvé dans ce morceau. Montez la sensibilité, ou vérifiez que la piste n'est pas silencieuse.",
            detail: '',
          });
          return;
        }

        set({
          beats,
          tempo: estimateTempo(beats),
          structure: readStructure(beats, plannedSpan({ ...get(), beats })),
          step: 'review',
          stage: 'ready',
          progress: 1,
          detail: '',
        });
      } catch (error) {
        const failure = toAiError(error);
        if (failure.kind === 'cancelled') {
          set({ stage: 'cancelled', detail: '', error: null });
          return;
        }
        set({ stage: 'failed', error: failure.message, detail: '' });
      } finally {
        if (inflight === controller) inflight = null;
        set({ startedAt: null });
      }
    },

    cancel() {
      inflight?.abort();
      inflight = null;
      set({ stage: 'cancelled', detail: '', startedAt: null });
    },

    importAll(recipe) {
      const state = get();
      const editor = useEditor.getState();
      if (!editor.project || !state.music) return;

      if (state.beats.length === 0) {
        notify('Aucun temps détecté', 'error');
        return;
      }
      if (state.sources.length === 0) {
        notify('Aucun clip source', 'error');
        return;
      }
      if (!state.structure) {
        notify("La structure du morceau n'a pas été lue", 'error');
        return;
      }

      /*
       * A holder rather than a bare `let`.
       *
       * The build happens inside the transaction callback, and TypeScript
       * cannot see that `transact` calls it synchronously — a `let` assigned in
       * there still reads as `null` afterwards. A property on an object is not
       * narrowed that way, and is honest about what is going on.
       */
      const captured: { build: AmvBuild | null; added: string[] } = { build: null, added: [] };

      /**
       * The asset the document should point at for this file.
       *
       * A second run over the same folder must not fill the pool with a second
       * copy of every clip. Matching on the path rather than the id is what
       * makes that work: the wizard mints fresh ids each time it reads a folder,
       * and the file on disk is the thing that is actually the same.
       */
      const adopt = (asset: MediaAsset, project: Project): MediaAsset =>
        project.assets.find((item) => item.path !== null && item.path === asset.path) ?? asset;

      // Built inside the transaction, from the document the store hands over
      // rather than from a snapshot taken before it: returning a project derived
      // from a stale copy would discard anything written in between.
      editor.transact(`montage AMV « ${state.music.name} »`, (current) => {
        const music = adopt(state.music as MediaAsset, current);
        const sources = state.sources.map((asset) => adopt(asset, current));

        const outcome = placeAmv(
          current,
          music,
          sources,
          state.beats,
          state.options,
          state.structure as Structure,
          recipe.phases,
        );
        captured.build = outcome;

        /*
         * Only what the montage actually points at joins the library.
         *
         * A folder of eighty clips can easily yield a montage that uses thirty
         * of them, and importing the other fifty would leave someone tidying up
         * a media pool they never asked for. The set is taken from the clips
         * that were written, so it is exactly right by construction rather than
         * by a second guess at what the picker did.
         */
        const used = new Set(outcome.project.clips.map((clip) => clip.assetId));
        const added = [music, ...sources].filter(
          (asset) =>
            used.has(asset.id) && !current.assets.some((item) => item.id === asset.id),
        );
        captured.added = added.map((asset) => asset.id);

        return { ...outcome.project, assets: [...outcome.project.assets, ...added] };
      });

      set({ placed: true });

      const built = captured.build;
      if (!built || built.shots === 0) {
        notify("Le montage n'a rien produit — vérifiez les clips sources.", 'error');
        return;
      }

      const arc = (['intro', 'build', 'drop'] as const)
        .filter((id) => built.byPhase[id] > 0)
        .map((id) => `${built.byPhase[id]} ${PHASE_WORD[id]}`)
        .join(' · ');

      const parts = [
        `${built.shots} plans (${arc})`,
        built.punches > 0 ? `${built.punches} zooms` : null,
        built.flashes > 0 ? `${built.flashes} flashs` : null,
        built.inverts > 0 ? `${built.inverts} négatifs` : null,
        built.splits > 0 ? `${built.splits} aberrations` : null,
        built.smears > 0 ? `${built.smears} flous de coupe` : null,
        built.dissolves > 0 ? `${built.dissolves} fondus` : null,
        built.markers > 0 ? `${built.markers} repères` : null,
      ].filter(Boolean);

      notify(`Montage AMV — ${parts.join(', ')}`, 'success');

      if (built.short > 0) {
        notify(
          `${built.short} plan${built.short > 1 ? 's ont' : ' a'} été raccourci${
            built.short > 1 ? 's' : ''
          } : le clip source s'arrêtait avant le temps suivant.`,
          'info',
        );
      }

      // Thumbnails and the music's waveform, after the fact. The document is
      // already correct without them; this only makes the timeline legible.
      void editor.enrichAssets(captured.added);
    },

    reset() {
      inflight?.abort();
      inflight = null;
      curve = null;
      set({
        step: 'source',
        stage: 'idle',
        structure: null,
        progress: 0,
        startedAt: null,
        detail: '',
        error: null,
        music: null,
        sources: [],
        folder: null,
        skipped: 0,
        beats: [],
        tempo: null,
        placed: false,
      });
    },
  };
});

/**
 * Seconds of montage the current answers would lay down.
 *
 * A **number**, and everything else this module exports to be read with
 * `useAmv(…)` has to be one too — or a value the store itself holds, so that
 * the same reference comes back each time.
 *
 * That is not style. zustand compares what a selector returns by identity, so
 * one that builds a fresh object or array on every call reads to React's
 * `useSyncExternalStore` as "the store changed again", every pass, for ever.
 * There used to be a `plannedByPhase` here returning `{ intro, build, drop }`,
 * and it took the whole editor down to a blank window the instant the review
 * step mounted. Derived composites are built with `useMemo` in the component
 * that needs them; `types/marker` keeps the same rule for the same reason.
 */
export function plannedSpan(state: AmvState): number {
  if (!state.music) return 0;
  return Math.min(
    state.music.duration,
    state.options.limit > 0 ? state.options.limit : AMV_LIMITS.maxMontage,
    AMV_LIMITS.maxMontage,
  );
}
