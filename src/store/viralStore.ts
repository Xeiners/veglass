/**
 * The viral-clip generator's own state.
 *
 * Session-scoped, like `downloadStore` and for the same reason: a wizard's
 * answers, a run's progress and a list of *proposals* are not part of the
 * document. Folding them into `editorStore` would put them inside the undo
 * history and inside the saved project, and undoing a montage change would
 * quietly rewind a list of suggestions.
 *
 * It touches the document at exactly two points — `importClip` and
 * `makeSequence` — and each goes through one `transact` or one `storage.save`.
 * A cut, its reframe, its caption track and its hundred word pieces are a
 * single undo step.
 */

import { create } from 'zustand';

import { AiError, toAiError } from '@/lib/ai/client';
import { storage, summarize } from '@/lib/persistence';
import { useAi } from '@/store/aiStore';
import { useEditor } from '@/store/editorStore';
import { useStyleKits } from '@/store/styleStore';
import { findClips } from '@/lib/viral/analyse';
import { placeInProject, sequenceFor, sequenceName } from '@/lib/viral/build';
import { poster } from '@/lib/viral/poster';
import { readTranscript } from '@/lib/viral/read';
import type { TranscriptSegment } from '@/types/ai';
import type { MediaAsset } from '@/types/media';
import { findKit, type StyleKit } from '@/types/styleKit';
import {
  DEFAULT_VIRAL_OPTIONS,
  MAX_CLIPS,
  MIN_CLIPS,
  type ViralClip,
  type ViralOptions,
  type ViralStage,
} from '@/types/viral';

export type WizardStep = 'source' | 'settings' | 'work' | 'results';

export const STEP_ORDER: WizardStep[] = ['source', 'settings', 'work', 'results'];

interface ViralState {
  open: boolean;
  step: WizardStep;
  options: ViralOptions;

  stage: ViralStage;
  /** 0 → 1 over the whole run, weighted across its phases. */
  progress: number;
  detail: string;
  error: string | null;

  transcript: TranscriptSegment[];
  /** Windows of audio that failed to transcribe — reported, not hidden. */
  failedWindows: number;
  clips: ViralClip[];

  openWizard(assetId?: string): void;
  close(): void;
  goTo(step: WizardStep): void;
  setOptions(patch: Partial<ViralOptions>): void;

  run(): Promise<void>;
  cancel(): void;

  setFocus(clipId: string, focus: number): void;
  importClip(clipId: string): void;
  makeSequence(clipId: string): Promise<void>;
  importAll(): void;
  reset(): void;
}

/**
 * How the phases share the progress bar.
 *
 * Reading is the long pole by a wide margin — it is the only phase that scales
 * with the length of the recording — so it owns most of the bar. A bar that
 * spends four minutes in its first fifth and then jumps is worse than no bar.
 */
const READ_SHARE = 0.72;
const ANALYSE_SHARE = 0.16;

export const useViral = create<ViralState>((set, get) => {
  /** The run in flight, if any. Kept out of the store: it is not rendered. */
  let inflight: AbortController | null = null;

  const notify = (message: string, tone: 'info' | 'success' | 'error' = 'info') =>
    useEditor.getState().notify(message, tone);

  const assetOf = (id: string | null): MediaAsset | null => {
    const project = useEditor.getState().project;
    if (!project || !id) return null;
    return project.assets.find((asset) => asset.id === id) ?? null;
  };

  const clipOf = (id: string): ViralClip | null =>
    get().clips.find((clip) => clip.id === id) ?? null;

  /** The kit the wizard is set to, resolved against what is actually stored. */
  const kitOf = (): StyleKit => findKit(useStyleKits.getState().kits, get().options.kitId);

  const patchClip = (id: string, patch: Partial<ViralClip>) =>
    set((state) => ({
      clips: state.clips.map((clip) => (clip.id === id ? { ...clip, ...patch } : clip)),
    }));

  /**
   * Fills in thumbnails one at a time, after the cards are already on screen.
   *
   * Sequential on purpose: each one is an ffmpeg process, and ten at once on a
   * long file makes the machine unusable for the seconds it takes.
   */
  const loadPosters = async (asset: MediaAsset, signal: AbortSignal) => {
    for (const clip of get().clips) {
      if (signal.aborted) return;
      if (clip.posterState !== 'idle') continue;

      patchClip(clip.id, { posterState: 'loading' });
      try {
        // A little past the start: the first frame of a cut is often a blink
        // or a mouth mid-word, and the second is more representative.
        const url = await poster(asset, clip.start + Math.min(1.5, (clip.end - clip.start) / 4));
        if (signal.aborted) return;
        patchClip(clip.id, { poster: url, posterState: 'ready' });
      } catch {
        patchClip(clip.id, { posterState: 'failed' });
      }
    }
  };

  return {
    open: false,
    step: 'source',
    options: DEFAULT_VIRAL_OPTIONS,

    stage: 'idle',
    progress: 0,
    detail: '',
    error: null,

    transcript: [],
    failedWindows: 0,
    clips: [],

    openWizard(assetId) {
      const project = useEditor.getState().project;
      const candidates = (project?.assets ?? []).filter(
        (asset) => asset.kind === 'video' && !asset.missing,
      );

      set((state) => ({
        open: true,
        step: 'source',
        // Pre-select what the user came from, the only candidate, or nothing.
        options: {
          ...state.options,
          assetId: assetId ?? state.options.assetId ?? candidates[0]?.id ?? null,
        },
      }));
    },

    close() {
      // A run keeps going only if it is already past the point of being useful
      // to stop; leaving the wizard is a clear signal to stop paying for it.
      inflight?.abort();
      inflight = null;
      set({ open: false });
    },

    goTo(step) {
      set({ step });
    },

    setOptions(patch) {
      set((state) => ({
        options: {
          ...state.options,
          ...patch,
          count: Math.min(
            MAX_CLIPS,
            Math.max(MIN_CLIPS, patch.count ?? state.options.count),
          ),
        },
      }));
    },

    async run() {
      if (inflight) return;

      const asset = assetOf(get().options.assetId);
      if (!asset) {
        set({ error: 'Choisissez une vidéo à analyser.', step: 'source' });
        return;
      }
      if (!asset.duration || asset.duration < 30) {
        set({
          error:
            "Cette vidéo est trop courte pour y découper des extraits — il faut au moins une trentaine de secondes.",
          step: 'source',
        });
        return;
      }

      const controller = new AbortController();
      inflight = controller;

      set({
        step: 'work',
        stage: 'reading',
        progress: 0,
        detail: '',
        error: null,
        clips: [],
        transcript: [],
        failedWindows: 0,
      });

      try {
        const settings = useAi.getState().settings;
        const options = get().options;

        /* ---- 1. Listen to it ---- */
        const read = await readTranscript(
          asset,
          settings,
          options.language,
          ({ ratio, window, total }) =>
            set({
              progress: ratio * READ_SHARE,
              detail:
                total > 1
                  ? `Transcription — partie ${window} sur ${total}`
                  : 'Transcription en cours',
            }),
          controller.signal,
        );

        if (controller.signal.aborted) throw new AiError('cancelled', 'Analyse annulée.');

        if (read.segments.length === 0) {
          set({
            stage: 'failed',
            error:
              "Aucune parole n'a été reconnue dans cette vidéo. Le générateur travaille à partir de ce qui est dit ; une vidéo sans dialogue ne lui donne rien à découper.",
          });
          return;
        }

        set({
          transcript: read.segments,
          failedWindows: read.failed,
          stage: 'analysing',
          progress: READ_SHARE,
          detail: 'Lecture de la transcription',
        });

        /* ---- 2. Find the moments ---- */
        const found = await findClips(
          read.segments,
          settings,
          options,
          asset.duration,
          controller.signal,
        );

        if (controller.signal.aborted) throw new AiError('cancelled', 'Analyse annulée.');

        if (found.length === 0) {
          set({
            stage: 'failed',
            error:
              "Aucun extrait ne tenait debout seul dans cette vidéo, à la durée demandée. Essayez une durée plus courte, ou un autre ton.",
          });
          return;
        }

        set({
          clips: found,
          stage: 'previewing',
          progress: READ_SHARE + ANALYSE_SHARE,
          detail: `${found.length} extrait${found.length > 1 ? 's' : ''} — extraction des aperçus`,
        });

        /* ---- 3. Show them ---- */
        set({ step: 'results', stage: 'ready', progress: 1, detail: '' });
        void loadPosters(asset, controller.signal);

        if (read.failed > 0) {
          notify(
            `${read.failed} partie${read.failed > 1 ? 's' : ''} de la vidéo n’${read.failed > 1 ? 'ont' : 'a'} pas pu être transcrite${read.failed > 1 ? 's' : ''} — l’analyse porte sur le reste.`,
            'info',
          );
        }
      } catch (error) {
        const failure = toAiError(error);
        if (failure.kind === 'cancelled') {
          set({ stage: 'cancelled', detail: '', error: null });
          return;
        }
        set({ stage: 'failed', error: failure.message, detail: '' });
      } finally {
        if (inflight === controller) inflight = null;
      }
    },

    cancel() {
      inflight?.abort();
      inflight = null;
      set({ stage: 'cancelled', detail: '' });
    },

    setFocus(clipId, focus) {
      patchClip(clipId, { focus: Math.min(1, Math.max(0, focus)) });
    },

    importClip(clipId) {
      const clip = clipOf(clipId);
      const asset = assetOf(get().options.assetId);
      if (!clip || !asset || !useEditor.getState().project) return;

      const options = get().options;

      // Built inside the transaction, from the document the store hands over,
      // rather than from a snapshot taken before it: returning a project
      // derived from a stale copy would discard anything written in between.
      let captionCount = 0;
      let tightened = 0;
      let mismatched = false;
      const kit = kitOf();
      useEditor.getState().transact(`clip viral « ${clip.title} »`, (current) => {
        const outcome = placeInProject(current, asset, clip, options, kit);
        captionCount = outcome.captions;
        tightened = outcome.tightened;
        mismatched = outcome.reframed;
        return outcome.project;
      });

      patchClip(clipId, { placed: true });

      const extras = [
        captionCount > 0 ? `${captionCount} sous-titres` : null,
        tightened > 0.05 ? `${tightened.toFixed(1).replace('.', ',')} s de blancs retirés` : null,
      ].filter(Boolean);
      notify(
        `« ${clip.title} » ajouté au projet${extras.length > 0 ? `, ${extras.join(', ')}` : ''}`,
        'success',
      );

      if (mismatched) {
        notify(
          "Le projet ouvert n’a pas le format choisi : le clip a été cadré pour ce projet. Utilisez « Séquence dédiée » pour obtenir le format vertical.",
          'info',
        );
      }
    },

    importAll() {
      const asset = assetOf(get().options.assetId);
      const pending = get().clips.filter((clip) => !clip.placed);
      if (!asset || !useEditor.getState().project || pending.length === 0) return;

      const options = get().options;

      // One transaction for the whole batch: importing six clips is one edit
      // and must undo as one, which is why this folds rather than looping over
      // `importClip`.
      const kit = kitOf();
      let captions = 0;
      let hooks = 0;
      let tightened = 0;
      useEditor.getState().transact(`${pending.length} clips viraux`, (current) => {
        let next = current;
        for (const clip of pending) {
          const outcome = placeInProject(next, asset, clip, options, kit);
          next = outcome.project;
          captions += outcome.captions;
          tightened += outcome.tightened;
          if (outcome.hooked) hooks += 1;
        }
        return next;
      });

      set((state) => ({ clips: state.clips.map((clip) => ({ ...clip, placed: true })) }));

      const extras = [
        hooks > 0 ? `${hooks} accroche${hooks > 1 ? 's' : ''}` : null,
        captions > 0 ? `${captions} sous-titres` : null,
        tightened > 0.05 ? `${tightened.toFixed(1).replace('.', ',')} s de blancs retirés` : null,
      ].filter(Boolean);
      notify(
        `${pending.length} clips ajoutés${extras.length > 0 ? `, ${extras.join(' et ')}` : ''}`,
        'success',
      );
    },

    async makeSequence(clipId) {
      const clip = clipOf(clipId);
      const asset = assetOf(get().options.assetId);
      const editor = useEditor.getState();
      if (!clip || !asset || !editor.project) return;

      try {
        const name = sequenceName(clip, editor.projects.map((item) => item.name));
        const sequence = sequenceFor(
          asset,
          clip,
          get().options,
          kitOf(),
          editor.project.settings.fps,
          name,
        );

        await storage.save(sequence);
        useEditor.setState((state) => ({ projects: [summarize(sequence), ...state.projects] }));
        patchClip(clipId, { placed: true });
        notify(`Séquence « ${name} » créée`, 'success');
      } catch (error) {
        console.error(error);
        notify('Création de la séquence impossible', 'error');
      }
    },

    reset() {
      inflight?.abort();
      inflight = null;
      set({
        step: 'source',
        stage: 'idle',
        progress: 0,
        detail: '',
        error: null,
        clips: [],
        transcript: [],
        failedWindows: 0,
      });
    },
  };
});
