/**
 * The tutorial generator's own state.
 *
 * Session-scoped, like `viralStore` and for the same reason: a wizard's
 * answers, a run's progress and a list of *proposed* steps are not part of the
 * document. Folding them into `editorStore` would put them inside the undo
 * history and inside the saved project, and undoing a montage change would
 * quietly rewind a script.
 *
 * It touches the document at exactly one point — `importAll` — and that point
 * is a single `transact`. The recording, its three animated channels, its
 * ducking curve, a dozen narration clips, a dozen chapter markers and any
 * captions are one edit and one press of Ctrl+Z.
 */

import { create } from 'zustand';

import { AiError, toAiError } from '@/lib/ai/client';
import { assetFromPath, probeMedia } from '@/lib/media';
import { discard } from '@/lib/voice/client';
import { analyseTutorial } from '@/lib/tutorial/analyse';
import { normalizeFrameCount } from '@/lib/tutorial/frames';
import { placeTutorial, type TutorialBuild } from '@/lib/tutorial/build';
import { recordScript, speakableSteps, takeKey } from '@/lib/tutorial/speech';
import { countShots } from '@/lib/tutorial/zoom';
import { useAi } from '@/store/aiStore';
import { useEditor } from '@/store/editorStore';
import { canSpeak, useVoice } from '@/store/voiceStore';
import type { MediaAsset } from '@/types/media';
import {
  DEFAULT_TUTORIAL_OPTIONS,
  isRunning,
  zoomProfileOf,
  type TutorialOptions,
  type TutorialStage,
  type TutorialStep,
} from '@/types/tutorial';
import { countCharacters, type SpeechTake } from '@/types/voice';

export type WizardStep = 'source' | 'settings' | 'work' | 'review';

export const STEP_ORDER: WizardStep[] = ['source', 'settings', 'work', 'review'];

/**
 * How the phases share the progress bar.
 *
 * Sampling and analysis together are the long pole — they are the only part
 * that scales with the length of the recording — so they own most of the bar.
 * Speech is a fixed cost per step and comparatively quick, but it is worth its
 * own fifth because it is the part that is visibly spending money.
 */
const ANALYSE_SHARE = 0.78;

interface TutorialState {
  open: boolean;
  step: WizardStep;
  options: TutorialOptions;

  stage: TutorialStage;
  /** 0 → 1 over the whole run, weighted across its phases. */
  progress: number;
  /**
   * When the run began, so the wait can show elapsed seconds.
   *
   * Without it a request that is working and a request that has stalled look
   * exactly alike — the reason `AiJob` carries the same field. It matters more
   * here than anywhere else in the suite: the analysis phase is a single Gemini
   * call that can run for minutes with the bar frozen at one value, which is
   * indistinguishable from a hang unless something on screen is still moving.
   */
  startedAt: number | null;
  detail: string;
  error: string | null;

  steps: TutorialStep[];
  /** Windows that produced nothing — reported, not hidden. */
  failedWindows: number;
  /** Lines that could not be recorded. */
  failedTakes: number;
  /** Stills actually shown to the model, for the run summary. */
  stills: number;
  /** True once the run has been committed to the document. */
  placed: boolean;

  openWizard(assetId?: string): void;
  close(): void;
  goTo(step: WizardStep): void;
  setOptions(patch: Partial<TutorialOptions>): void;

  run(): Promise<void>;
  cancel(): void;

  toggleStep(stepId: string): void;
  editStep(stepId: string, patch: Pick<Partial<TutorialStep>, 'title' | 'say'>): void;
  revoice(stepId: string): Promise<void>;

  importAll(): void;
  reset(): void;
}

export const useTutorial = create<TutorialState>((set, get) => {
  /** The run in flight, if any. Kept out of the store: it is not rendered. */
  let inflight: AbortController | null = null;
  /**
   * Takes and their assets, held outside the rendered state.
   *
   * A `MediaAsset` carries a `src` the preview can play and a `Map` is not
   * serialisable; neither belongs in a store React subscribes to, and neither
   * is ever read during a render.
   */
  let takes = new Map<string, SpeechTake>();
  let voiceAssets = new Map<string, MediaAsset>();
  /** Files on disk this run has written, so an abandoned one can sweep up. */
  let written: string[] = [];

  const notify = (message: string, tone: 'info' | 'success' | 'error' = 'info') =>
    useEditor.getState().notify(message, tone);

  const assetOf = (id: string | null): MediaAsset | null => {
    const project = useEditor.getState().project;
    if (!project || !id) return null;
    return project.assets.find((asset) => asset.id === id) ?? null;
  };

  const patchStep = (id: string, patch: Partial<TutorialStep>) =>
    set((state) => ({
      steps: state.steps.map((step) => (step.id === id ? { ...step, ...patch } : step)),
    }));

  /**
   * Turns a written take into an asset the timeline can point at.
   *
   * The duration comes from the service's own alignment, which is exact and
   * already paid for. Probing is the fallback for the case where the answer
   * carried no alignment at all — rare, and not worth failing a whole run over.
   */
  const assetForTake = async (
    step: TutorialStep,
    take: SpeechTake,
  ): Promise<MediaAsset> => {
    const asset = await assetFromPath(take.path);
    const duration =
      take.duration > 0 ? take.duration : (await probeMedia(asset.src, 'audio')).duration;

    return { ...asset, kind: 'audio', name: `Voix — ${step.title}`, duration };
  };

  /** Drops every take this run wrote. Called when it is abandoned. */
  const sweep = () => {
    const keys = written;
    written = [];
    takes = new Map();
    voiceAssets = new Map();
    void discard(keys);
  };

  return {
    open: false,
    step: 'source',
    options: DEFAULT_TUTORIAL_OPTIONS,

    stage: 'idle',
    progress: 0,
    startedAt: null,
    detail: '',
    error: null,

    steps: [],
    failedWindows: 0,
    failedTakes: 0,
    stills: 0,
    placed: false,

    openWizard(assetId) {
      const project = useEditor.getState().project;
      const candidates = (project?.assets ?? []).filter(
        (asset) => asset.kind === 'video' && !asset.missing,
      );

      set((state) => ({
        open: true,
        step: 'source',
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
      // Takes that were never placed are files nothing will ever reference.
      if (!get().placed) sweep();
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
          ...('frameCount' in patch ? { frameCount: normalizeFrameCount(patch.frameCount) } : {}),
        },
      }));
    },

    async run() {
      if (inflight) return;

      const asset = assetOf(get().options.assetId);
      if (!asset) {
        set({ error: 'Choisissez un enregistrement à analyser.', step: 'source' });
        return;
      }
      if (!asset.duration || asset.duration < 8) {
        set({
          error:
            "Cet enregistrement est trop court pour en tirer un tutoriel — il faut au moins une dizaine de secondes.",
          step: 'source',
        });
        return;
      }

      const options = get().options;
      const voice = useVoice.getState();
      // Checked before the analysis rather than after it: discovering there is
      // no voice configured *after* four minutes of sampling would waste the
      // expensive half of the run.
      if (options.voiceover && !canSpeak(voice)) {
        set({
          error: voice.available
            ? "La voix off demande une clé ElevenLabs et une voix choisie — ouvrez les réglages, onglet Voix, ou décochez la voix off."
            : "La voix off n'est disponible que dans l'application de bureau. Décochez-la pour obtenir le montage et les chapitres.",
          step: 'settings',
        });
        return;
      }

      // Anything left from a previous run in this session is now orphaned.
      sweep();

      const controller = new AbortController();
      inflight = controller;

      set({
        step: 'work',
        stage: 'sampling',
        progress: 0,
        startedAt: Date.now(),
        detail: '',
        error: null,
        steps: [],
        failedWindows: 0,
        failedTakes: 0,
        stills: 0,
        placed: false,
      });

      try {
        const settings = useAi.getState().settings;

        /* ---- 1. Watch it ---- */
        const analysis = await analyseTutorial(
          asset,
          settings,
          options,
          (progress) => {
            const many = progress.total > 1 ? ` — partie ${progress.window}/${progress.total}` : '';
            set({
              stage: progress.phase === 'sampling' ? 'sampling' : 'analysing',
              progress: progress.ratio * ANALYSE_SHARE,
              detail:
                progress.phase === 'sampling'
                  ? `Extraction des images${many}${
                      progress.sample ? ` — ${progress.sample.taken}/${progress.sample.total}` : ''
                    }`
                  : `Repérage des étapes${many}`,
            });
          },
          controller.signal,
        );

        if (controller.signal.aborted) throw new AiError('cancelled', 'Analyse annulée.');

        if (analysis.steps.length === 0) {
          set({
            stage: 'failed',
            error:
              "Aucune étape n'a pu être repérée dans cet enregistrement. Le générateur travaille à partir de ce qui se passe à l'écran ; une capture sans manipulation ne lui donne rien à découper.",
          });
          return;
        }

        set({
          steps: analysis.steps,
          failedWindows: analysis.failed,
          stills: analysis.stills,
          progress: ANALYSE_SHARE,
        });

        /* ---- 2. Say it ---- */
        if (options.voiceover) {
          set({ stage: 'speaking', detail: 'Enregistrement de la voix off' });

          const spoken = await recordScript(
            analysis.steps,
            useVoice.getState().preferences,
            useEditor.getState().project?.id ?? 'veglass',
            (progress) => {
              set({
                progress: ANALYSE_SHARE + progress.ratio * (1 - ANALYSE_SHARE),
                detail: `Voix off — phrase ${progress.index} sur ${progress.total}`,
              });
            },
            controller.signal,
          );

          takes = spoken.takes;
          written = spoken.keys;

          // The assets are resolved here, before the review step, so the cards
          // can play their own take and `placeTutorial` stays synchronous.
          const resolved = new Map<string, MediaAsset>();
          for (const [stepId, take] of takes) {
            const step = analysis.steps.find((item) => item.id === stepId);
            if (!step) continue;
            resolved.set(stepId, await assetForTake(step, take));
          }
          voiceAssets = resolved;

          set((state) => ({
            failedTakes: spoken.failed,
            steps: state.steps.map((step) => ({ ...step, take: takes.get(step.id) ?? null })),
          }));
        }

        /* ---- 3. Show it ---- */
        set({ step: 'review', stage: 'ready', progress: 1, detail: '' });

        if (analysis.failed > 0) {
          notify(
            `${analysis.failed} partie${analysis.failed > 1 ? 's' : ''} de l'enregistrement n'${
              analysis.failed > 1 ? 'ont' : 'a'
            } rien donné — le tutoriel porte sur le reste.`,
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
        set({ startedAt: null });
      }
    },

    cancel() {
      inflight?.abort();
      inflight = null;
      set({ stage: 'cancelled', detail: '', startedAt: null });
    },

    toggleStep(stepId) {
      const step = get().steps.find((item) => item.id === stepId);
      if (step) patchStep(stepId, { enabled: !step.enabled });
    },

    editStep(stepId, patch) {
      const step = get().steps.find((item) => item.id === stepId);
      if (!step) return;

      // Changing the line invalidates the take that says the old one. It is
      // dropped rather than silently kept, because a card showing new text over
      // audio saying something else is the worst of both.
      const rewritten = patch.say !== undefined && patch.say.trim() !== step.say.trim();
      if (rewritten) {
        takes.delete(stepId);
        voiceAssets.delete(stepId);
      }

      patchStep(stepId, { ...patch, ...(rewritten ? { take: null } : {}) });
    },

    async revoice(stepId) {
      const step = get().steps.find((item) => item.id === stepId);
      const voice = useVoice.getState();
      if (!step || !canSpeak(voice)) return;

      set({ detail: `Voix off — « ${step.title} »` });
      try {
        const projectId = useEditor.getState().project?.id ?? 'veglass';
        // Forced enabled: revoicing a step the user has unticked is a
        // deliberate act, and `recordScript` skips disabled steps by design.
        const spoken = await recordScript(
          [{ ...step, enabled: true }],
          voice.preferences,
          projectId,
          () => {},
        );

        const take = spoken.takes.get(step.id);
        if (!take) {
          notify('Cette phrase n’a pas pu être enregistrée', 'error');
          return;
        }

        takes.set(step.id, take);
        voiceAssets.set(step.id, await assetForTake(step, take));
        const key = takeKey(projectId, step.id);
        if (!written.includes(key)) written.push(key);

        patchStep(step.id, { take });
      } catch (error) {
        notify(toAiError(error).message, 'error');
      } finally {
        set({ detail: '' });
      }
    },

    importAll() {
      const asset = assetOf(get().options.assetId);
      const editor = useEditor.getState();
      if (!asset || !editor.project) return;

      const kept = get().steps.filter((step) => step.enabled);
      if (kept.length === 0) {
        notify('Aucune étape retenue', 'error');
        return;
      }

      const options = get().options;
      /*
       * A holder rather than a bare `let`.
       *
       * The build happens inside the transaction callback, and TypeScript
       * cannot see that `transact` calls it synchronously — a `let` assigned in
       * there still reads as `null` afterwards. A property on an object is not
       * narrowed that way, and is honest about what is going on.
       */
      const captured: { build: TutorialBuild | null } = { build: null };

      // Built inside the transaction, from the document the store hands over
      // rather than from a snapshot taken before it: returning a project
      // derived from a stale copy would discard anything written in between.
      editor.transact(`tutoriel « ${asset.name} »`, (current) => {
        const outcome = placeTutorial(current, asset, kept, options, takes, voiceAssets);
        captured.build = outcome;
        return outcome.project;
      });

      /*
       * The takes now belong to the document, not to this run.
       *
       * `written` is the sweep list — every file an *abandoned* run should
       * delete. Leaving placed takes on it would mean a second run in the same
       * session sweeping away the audio the first one's clips point at, and the
       * montage would come back with its voice-over missing.
       */
      written = [];
      set({ placed: true });

      const built = captured.build;
      const parts = [
        `${kept.length} étape${kept.length > 1 ? 's' : ''}`,
        built && built.shots > 0 ? `${built.shots} zoom${built.shots > 1 ? 's' : ''}` : null,
        built && built.takes > 0 ? `${built.takes} phrases dites` : null,
        built && built.markers > 0 ? `${built.markers} chapitres` : null,
        built && built.banners > 0
          ? `${built.banners} habillage${built.banners > 1 ? 's' : ''}`
          : null,
        built && built.captions > 0 ? `${built.captions} sous-titres` : null,
        built && built.cursor ? 'curseur lissé' : null,
      ].filter(Boolean);

      notify(`Tutoriel monté — ${parts.join(', ')}`, 'success');

      if (get().failedTakes > 0) {
        notify(
          `${get().failedTakes} phrase${get().failedTakes > 1 ? 's' : ''} sans voix off — les étapes sont là, le son manque.`,
          'info',
        );
      }
    },

    reset() {
      inflight?.abort();
      inflight = null;
      if (!get().placed) sweep();
      set({
        step: 'source',
        stage: 'idle',
        progress: 0,
        startedAt: null,
        detail: '',
        error: null,
        steps: [],
        failedWindows: 0,
        failedTakes: 0,
        stills: 0,
        placed: false,
      });
    },
  };
});

/**
 * What closing the wizard right now would discard.
 *
 * Two distinct losses, and they are worth different words. A run in flight has
 * been paid for at Gemini and is about to be abandoned mid-request. A finished
 * run that has not been placed holds a script *and* the voice-over takes, which
 * cost real characters at ElevenLabs and are swept from disk on close — that is
 * the more expensive of the two, and the one someone is likelier to lose by
 * reflex, because the wizard looks idle.
 *
 * `null` means nothing is at stake and the wizard should simply close.
 */
export function closingCost(state: TutorialState): 'running' | 'unplaced' | null {
  if (isRunning(state.stage)) return 'running';
  if (state.steps.length > 0 && !state.placed) return 'unplaced';
  return null;
}

/**
 * How many camera moves the current answers would actually produce.
 *
 * Read by the review step to say "huit zooms" before anything is committed —
 * the count comes from the same `planShots` the build uses, so the number shown
 * is the number written rather than an estimate of it.
 */
export function plannedShots(state: TutorialState): number {
  const project = useEditor.getState().project;
  const asset = project?.assets.find((item) => item.id === state.options.assetId);
  if (!project || !asset) return 0;

  return countShots(
    state.steps.filter((step) => step.enabled),
    { offset: 0, duration: Math.max(0.1, asset.duration) },
    asset,
    project.settings,
    zoomProfileOf(state.options.zoom),
  );
}

/** Characters the current script would cost, for the warning before a run. */
export const scriptCost = (steps: TutorialStep[]): number =>
  countCharacters(speakableSteps(steps).map((step) => step.say));
