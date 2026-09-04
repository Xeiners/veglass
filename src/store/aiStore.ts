/**
 * The AI suite's own state.
 *
 * Kept apart from `editorStore` on purpose. Nothing here belongs to the
 * document: a conversation, a pending plan, a key status and a job's progress
 * are all session-scoped, and folding them into the editor store would put them
 * inside the undo history and inside the saved project — neither of which is
 * where they belong.
 *
 * The two stores meet at exactly one point: every document change this store
 * makes goes through `useEditor.getState().transact(...)`, once per operation.
 * That is what makes a plan, a subtitle pass or a smart cut a single undo step.
 */

import { create } from 'zustand';

import { uid } from '@/lib/id';
import { useEditor } from '@/store/editorStore';
import {
  AiError,
  clearApiKey,
  onRetry,
  onModelFallback,
  keyStatus as readKeyStatus,
  listModels,
  generate,
  setApiKey,
  toAiError,
  audioExcerpt,
  audioEnvelope,
} from '@/lib/ai/client';
import { describeProject } from '@/lib/ai/context';
import { ASSISTANT_SYSTEM } from '@/lib/ai/prompts';
import { PLAN_SCHEMA } from '@/lib/ai/schema';
import { applyPlan, buildPlan, expandSelection, normalizePlan } from '@/lib/ai/plan';
import { audioJobs, type AudioJob } from '@/lib/ai/scope';
import { buildSubtitleClips, mergeSegments, transcribe } from '@/lib/ai/subtitles';
import {
  detectFillers,
  detectSilences,
  envelopeFromWaveform,
  mergeCuts,
  rippleDelete,
  suggestThreshold,
  totalCut,
} from '@/lib/ai/silence';
import {
  AI_SETTINGS_VERSION,
  DEFAULT_AI_SETTINGS,
  RETIRED_MODELS,
  fallbackChain,
  type AiSettings,
  type ChatMessage,
  type CutInterval,
  type KeyStatus,
  type ModelInfo,
  type SmartCutOptions,
  type SubtitleOptions,
  type TranscriptSegment,
} from '@/types/ai';

/** Preferences live beside the app, like the export settings and the layout. */
const SETTINGS_KEY = 'veglass:ai-settings';
/** How many past turns travel with a request. Beyond this the cost outruns the use. */
const HISTORY_TURNS = 12;

/**
 * Moves preferences saved by an older build onto models that still exist.
 *
 * Google retires a model id by refusing it for *new* keys while the docs still
 * list it, so the failure arrives as a 404 on the first real request rather
 * than at startup. Migrating on load turns that into nothing at all — and the
 * stamped version means someone who deliberately types an old id back keeps it.
 */
function migrate(settings: AiSettings): AiSettings {
  const forward = (id: string): string => RETIRED_MODELS[id] ?? id;
  const next: AiSettings = {
    ...settings,
    model: forward(settings.model),
    transcriptionModel: forward(settings.transcriptionModel),
    version: AI_SETTINGS_VERSION,
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — the migration simply runs again next time */
  }
  return next;
}

function readSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_AI_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    const stored = { ...DEFAULT_AI_SETTINGS, ...parsed };
    // Read the version off the *parsed* blob, not the merged one: the defaults
    // carry the current version, so merging first would make every old
    // preference look already-migrated and quietly skip the rewrite.
    return (parsed.version ?? 0) >= AI_SETTINGS_VERSION ? stored : migrate(stored);
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

/** A long operation, so the panel can show what it is doing and how far along. */
export interface AiJob {
  kind: 'chat' | 'subtitles' | 'analysis';
  label: string;
  /** 0 → 1, or `null` when the step has no measurable length. */
  progress: number | null;
  /**
   * When it began, so the panel can show elapsed seconds.
   *
   * Without it a request that is working and a request that has stalled look
   * exactly alike, and the only honest thing a spinner can say is "still".
   */
  startedAt: number;
  /** A retry notice, or anything else worth saying mid-flight. */
  detail?: string;
}

export interface SmartCutReport {
  cuts: CutInterval[];
  /** Seconds the montage would lose. */
  saved: number;
  /** Clips that were listened to, for the summary line. */
  analysed: number;
  /** Told to the user when part of the timeline could not be measured. */
  warnings: string[];
  /**
   * A threshold derived from the material itself.
   *
   * Offered when the current one found nothing: "aucun silence" almost always
   * means the setting is wrong for this recording rather than that the montage
   * is already tight, and the measurement is the only thing that can say so.
   */
  suggestedThreshold: number | null;
}

interface AiState {
  keyStatus: KeyStatus;
  settings: AiSettings;
  settingsOpen: boolean;
  models: ModelInfo[];
  modelsLoading: boolean;

  messages: ChatMessage[];
  job: AiJob | null;

  subtitlesOpen: boolean;
  smartCutOpen: boolean;
  smartCut: SmartCutReport | null;

  boot(): Promise<void>;
  openSettings(open: boolean): void;
  saveKey(key: string, verify: boolean): Promise<boolean>;
  removeKey(): Promise<void>;
  /** `announce` reports success as well as failure — the settings panel's test. */
  loadModels(announce?: boolean): Promise<void>;
  patchSettings(patch: Partial<AiSettings>): void;

  ask(prompt: string): Promise<void>;
  cancel(): void;
  clearChat(): void;
  commitPlan(messageId: string): void;

  openSubtitles(open: boolean): void;
  generateSubtitles(options: SubtitleOptions): Promise<void>;

  openSmartCut(open: boolean): void;
  analyseSmartCut(options: SmartCutOptions): Promise<void>;
  applySmartCut(cuts: CutInterval[]): void;
  clearSmartCut(): void;
}

/**
 * The in-flight request.
 *
 * Module-level rather than in the store because it is not state anyone renders,
 * and because replacing it must not schedule a React update mid-request.
 */
let inflight: AbortController | null = null;

/** Unsubscribe for the retry feed, kept so `boot` only ever subscribes once. */
let stopRetryFeed: (() => void) | null = null;
let stopFallbackFeed: (() => void) | null = null;

const notify = (message: string, tone?: 'info' | 'success' | 'error') =>
  useEditor.getState().notify(message, tone);

export const useAi = create<AiState>((set, get) => {
  /**
   * Turns a failure into something visible and, where it helps, actionable.
   *
   * A key problem opens the settings panel rather than only complaining: the
   * fix is one field away, and making the user go looking for it is the kind of
   * small friction that makes an assistant feel unfinished.
   */
  const report = (error: unknown, prefix: string): AiError => {
    const failure = toAiError(error);
    if (failure.kind === 'cancelled') return failure;

    // A refused key and a model that no longer exists are both fixed in the same
    // panel, so both open it rather than only complaining in a toast.
    const wrongModel = failure.kind === 'request' && failure.status === 404;
    if (failure.kind === 'missing-key' || failure.kind === 'invalid-key' || wrongModel) {
      set({ settingsOpen: true });
      // The panel is only useful here if it can show what the key *can* reach.
      if (wrongModel) void get().loadModels();
    }
    notify(`${prefix} — ${failure.message}`, 'error');
    return failure;
  };

  const finish = () => {
    inflight = null;
    set({ job: null });
  };

  return {
    keyStatus: { configured: false, backend: 'none', hint: null },
    settings: readSettings(),
    settingsOpen: false,
    models: [],
    modelsLoading: false,

    messages: [],
    job: null,

    subtitlesOpen: false,
    smartCutOpen: false,
    smartCut: null,

    async boot() {
      // A retry is the one thing that happens mid-request and would otherwise
      // be invisible: three short connect failures look exactly like one slow
      // answer unless the panel is told which it is.
      if (!stopRetryFeed) {
        stopRetryFeed = await onRetry((notice) => {
          set((state) =>
            state.job
              ? {
                  job: {
                    ...state.job,
                    detail: `${notice.reason} Nouvelle tentative ${notice.attempt}/${notice.total} dans ${Math.round(notice.delay)} s.`,
                  },
                }
              : {},
          );
        }).catch(() => null);
      }

      // A model switch is worth saying out loud: the answer that follows came
      // from a different model than the one in the settings, and a user who is
      // not told will reasonably wonder why the tone changed.
      if (!stopFallbackFeed) {
        stopFallbackFeed = onModelFallback((from, to) => {
          notify(`Quota épuisé sur ${from} — bascule sur ${to}`);
          set((state) =>
            state.job
              ? { job: { ...state.job, detail: `Quota épuisé sur ${from} — essai avec ${to}.` } }
              : {},
          );
        });
      }

      try {
        set({ keyStatus: await readKeyStatus() });
      } catch {
        // A key store that will not answer is not a reason to fail startup;
        // the panel simply shows "aucune clé" until it does.
      }
    },

    openSettings(open) {
      set({ settingsOpen: open });
    },

    async saveKey(key, verify) {
      try {
        const status = await setApiKey(key, verify);
        set({ keyStatus: status });
        notify('Clé Gemini enregistrée', 'success');
        void get().loadModels();
        return true;
      } catch (error) {
        const failure = toAiError(error);
        notify(`Clé refusée — ${failure.message}`, 'error');
        return false;
      }
    },

    async removeKey() {
      set({ keyStatus: await clearApiKey(), models: [] });
      notify('Clé Gemini supprimée');
    },

    async loadModels(announce = false) {
      if (get().modelsLoading) return;
      set({ modelsLoading: true });
      try {
        const models = await listModels();
        set({ models });
        if (announce) {
          notify(`Connexion établie — ${models.length} modèles accessibles`, 'success');
        }
      } catch (error) {
        const failure = toAiError(error);
        // Silent for a missing key: the panel already says there is none.
        if (failure.kind !== 'missing-key') {
          notify(`Liste des modèles indisponible — ${failure.message}`, 'error');
        }
      } finally {
        set({ modelsLoading: false });
      }
    },

    patchSettings(patch) {
      const next = { ...get().settings, ...patch };
      set({ settings: next });
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable — the choice stays session-local */
      }
    },

    /* ---------------- Chat ---------------- */

    async ask(prompt) {
      const text = prompt.trim();
      if (!text || get().job) return;

      const editor = useEditor.getState();
      const project = editor.project;
      if (!project) {
        notify('Ouvrez un projet pour discuter avec l’assistant');
        return;
      }

      const question: ChatMessage = { id: uid('msg'), role: 'user', text, at: Date.now() };
      set((state) => ({ messages: [...state.messages, question] }));

      const controller = new AbortController();
      inflight = controller;
      set({ job: { kind: 'chat', label: 'Réflexion…', progress: null, startedAt: Date.now() } });

      // Only the readable halves travel, and only the turns *before* this one:
      // the question just pushed onto `messages` becomes the final turn below,
      // and including it here would send two consecutive user turns.
      const history = get()
        .messages.slice(0, -1)
        .slice(-HISTORY_TURNS)
        .filter((message) => !message.error && message.text.trim())
        .map((message) => ({
          role: message.role === 'user' ? 'user' : 'model',
          parts: [{ text: message.text }],
        }));

      // Captured now, not at commit time: a plan aimed at "the selection" must
      // mean the clips that were selected when it was asked for.
      const selection = [...editor.selectedClipIds];
      const context = describeProject(project, {
        playhead: editor.playhead,
        selectedClipIds: selection,
        workIn: editor.workIn,
        workOut: editor.workOut,
      });

      try {
        const settings = get().settings;
        const result = await generate(
          settings.model,
          {
            systemInstruction: { parts: [{ text: ASSISTANT_SYSTEM }] },
            contents: [
              ...history,
              {
                role: 'user',
                // The question and the project state are two parts of one turn.
                // Sending the state as a turn of its own put two user roles back
                // to back, which is not a conversation any model expects.
                parts: [{ text }, { text: `État actuel du projet :\n${context}` }],
              },
            ],
            generationConfig: {
              temperature: settings.temperature,
              responseMimeType: 'application/json',
              responseSchema: PLAN_SCHEMA,
            },
          },
          // A chat turn that has not answered in ninety seconds is not going to.
          // Failing here, while the user is still watching, beats failing
          // silently several minutes later.
          {
            signal: controller.signal,
            timeoutSecs: 90,
            fallbacks: fallbackChain(settings),
          },
        );

        const parsed = normalizePlan(result.text);
        const answer: ChatMessage = {
          id: uid('msg'),
          role: 'model',
          text: parsed.reply || 'Voici ce que je propose.',
          at: Date.now(),
          usage: result.usage,
          ...(parsed.actions.length > 0
            ? {
                // An action aimed at "the selection" becomes one action per
                // clip here, so the card lists real names and applying it later
                // cannot act on a selection that has since changed.
                plan: buildPlan(parsed.title, expandSelection(parsed.actions, selection)),
              }
            : {}),
        };

        set((state) => ({ messages: [...state.messages, answer] }));

        if (parsed.malformed > 0) {
          notify(
            `${parsed.malformed} action${parsed.malformed > 1 ? 's illisibles ont' : ' illisible a'} été ignorée${parsed.malformed > 1 ? 's' : ''}`,
          );
        }
        if (answer.plan && get().settings.autoApply) get().commitPlan(answer.id);
      } catch (error) {
        const failure = report(error, 'Assistant');
        if (failure.kind === 'cancelled') return;
        set((state) => ({
          messages: [
            ...state.messages,
            {
              id: uid('msg'),
              role: 'model',
              text: '',
              at: Date.now(),
              error: { kind: failure.kind, message: failure.message },
            },
          ],
        }));
      } finally {
        if (inflight === controller) finish();
      }
    },

    cancel() {
      inflight?.abort();
      inflight = null;
      set({ job: null });
    },

    clearChat() {
      set({ messages: [] });
    },

    /**
     * Commits a proposed plan in one write.
     *
     * The plan is validated against the document *as it is now*, not as it was
     * when the answer arrived — the user may well have edited in between, and
     * an action pointing at a clip they have since deleted must be reported,
     * not applied to whatever now holds that id.
     */
    commitPlan(messageId) {
      const message = get().messages.find((item) => item.id === messageId);
      const plan = message?.plan;
      if (!plan || plan.appliedAt) return;

      const project = useEditor.getState().project;
      if (!project) return;

      const outcome = applyPlan(project, plan.actions);
      if (outcome.applied.length === 0) {
        notify('Aucune action de ce plan ne s’applique au montage actuel', 'error');
        set((state) => ({
          messages: state.messages.map((item) =>
            item.id === messageId && item.plan
              ? { ...item, plan: { ...item.plan, rejected: outcome.rejected } }
              : item,
          ),
        }));
        return;
      }

      useEditor.getState().transact(plan.title, () => outcome.project);

      set((state) => ({
        messages: state.messages.map((item) =>
          item.id === messageId && item.plan
            ? { ...item, plan: { ...item.plan, rejected: outcome.rejected, appliedAt: Date.now() } }
            : item,
        ),
      }));

      const skipped = outcome.rejected.length;
      notify(
        skipped > 0
          ? `${outcome.applied.length} modification${outcome.applied.length > 1 ? 's appliquées' : ' appliquée'}, ${skipped} ignorée${skipped > 1 ? 's' : ''}`
          : `${outcome.applied.length} modification${outcome.applied.length > 1 ? 's appliquées' : ' appliquée'}`,
        'success',
      );
    },

    /* ---------------- Subtitles ---------------- */

    openSubtitles(open) {
      set({ subtitlesOpen: open });
    },

    async generateSubtitles(options) {
      if (get().job) return;
      const editor = useEditor.getState();
      const project = editor.project;
      if (!project) return;

      const jobs = audioJobs(project, options.scope, {
        selectedClipId: editor.selectedClipId,
        workIn: editor.workIn,
        workOut: editor.workOut,
      });

      if (jobs.length === 0) {
        notify(
          options.scope === 'clip'
            ? 'Sélectionnez un clip contenant du son'
            : 'Aucun clip audible à transcrire dans cette étendue',
          'error',
        );
        return;
      }

      const controller = new AbortController();
      inflight = controller;
      set({ subtitlesOpen: false });
      // The dialog closes, so progress needs somewhere to live: a transcription
      // runs for minutes, and a pulsing icon is not a report.
      useEditor.getState().setRightTab('assistant');

      const groups: TranscriptSegment[][] = [];
      const failures: string[] = [];

      try {
        for (let index = 0; index < jobs.length; index += 1) {
          if (controller.signal.aborted) throw new AiError('cancelled', 'Transcription annulée.');
          const job = jobs[index] as AudioJob;
          set({
            job: {
              kind: 'subtitles',
              label: `Transcription — ${job.asset.name} (${index + 1}/${jobs.length})`,
              progress: index / jobs.length,
              startedAt: Date.now(),
            },
          });

          try {
            groups.push(await transcribe(job, get().settings, options, controller.signal));
          } catch (error) {
            const failure = toAiError(error);
            if (failure.kind === 'cancelled') throw failure;
            // One unreadable file must not lose the transcription of the rest.
            failures.push(`${job.asset.name} : ${failure.message}`);
          }
        }

        const segments = mergeSegments(groups);
        if (segments.length === 0) {
          notify(
            failures.length > 0
              ? `Transcription impossible — ${failures[0]}`
              : 'Aucune parole détectée dans cette étendue',
            'error',
          );
          return;
        }

        // The document may have moved while we were listening; the build runs
        // against the project as it is at the moment of writing.
        const current = useEditor.getState().project;
        if (!current) return;

        const build = buildSubtitleClips(current, segments, options);
        useEditor.getState().transact('sous-titres', () => build.project);

        const parts = [`${build.added} sous-titre${build.added > 1 ? 's' : ''} sur « ${build.trackName} »`];
        if (build.skipped > 0) parts.push(`${build.skipped} ignoré${build.skipped > 1 ? 's' : ''} (piste occupée)`);
        if (failures.length > 0) parts.push(`${failures.length} média${failures.length > 1 ? 's' : ''} en échec`);
        notify(parts.join(' · '), 'success');
      } catch (error) {
        report(error, 'Sous-titres');
      } finally {
        if (inflight === controller) finish();
      }
    },

    /* ---------------- Smart cut ---------------- */

    openSmartCut(open) {
      set({ smartCutOpen: open, ...(open ? {} : { smartCut: null }) });
    },

    clearSmartCut() {
      set({ smartCut: null });
    },

    /**
     * Measures the timeline and proposes cuts, without touching the document.
     *
     * Analysis and application are deliberately two steps: dead air is a
     * judgement call at the margins, and a montage that silently shortens
     * itself is not something anyone wants twice.
     */
    async analyseSmartCut(options) {
      if (get().job) return;
      const editor = useEditor.getState();
      const project = editor.project;
      if (!project) return;

      const jobs = audioJobs(project, options.scope, {
        selectedClipId: editor.selectedClipId,
        workIn: editor.workIn,
        workOut: editor.workOut,
      });
      if (jobs.length === 0) {
        notify(
          options.scope === 'clip'
            ? 'Sélectionnez un clip contenant du son'
            : 'Aucun clip audible à analyser dans cette étendue',
          'error',
        );
        return;
      }

      const controller = new AbortController();
      inflight = controller;

      const cuts: CutInterval[] = [];
      const warnings: string[] = [];
      const suggestions: number[] = [];
      let analysed = 0;

      try {
        for (let index = 0; index < jobs.length; index += 1) {
          if (controller.signal.aborted) throw new AiError('cancelled', 'Analyse annulée.');
          const job = jobs[index] as AudioJob;
          set({
            job: {
              kind: 'analysis',
              label: `Analyse — ${job.asset.name} (${index + 1}/${jobs.length})`,
              progress: index / jobs.length,
              startedAt: Date.now(),
            },
          });

          // The excerpt begins here on the timeline, so a time measured from
          // the excerpt's own start becomes a timeline time by adding it.
          const anchor = job.timelineStart;
          const until = anchor + job.duration;
          const within = (cut: CutInterval) => cut.end > anchor && cut.start < until;

          try {
            const envelope = await audioEnvelope(job.asset.path, job.sourceStart, job.duration);
            cuts.push(...detectSilences(envelope, options, anchor).filter(within));
            suggestions.push(suggestThreshold(envelope));
            analysed += 1;
          } catch (error) {
            const failure = toAiError(error);
            if (failure.kind === 'cancelled') throw failure;

            // The browser host has no decoder; the waveform the media pool
            // already extracted is coarser but says the same thing. It covers
            // the whole file, so it is anchored to the clip's in-point instead
            // and then clipped to the part that is actually on screen.
            const waveform = useEditor.getState().peaks[job.asset.id];
            if (failure.kind === 'unsupported' && waveform) {
              const envelope = envelopeFromWaveform(waveform, job.asset.duration);
              suggestions.push(suggestThreshold(envelope));
              const fileAnchor = job.clip.start - job.clip.offset;
              cuts.push(
                ...detectSilences(envelope, options, fileAnchor)
                  .filter(within)
                  .map((cut) => ({
                    ...cut,
                    start: Math.max(cut.start, anchor),
                    end: Math.min(cut.end, until),
                  })),
              );
              analysed += 1;
            } else {
              warnings.push(`${job.asset.name} : ${failure.message}`);
            }
          }

          if (options.detectFillers) {
            try {
              const excerpt = await audioExcerpt(job.asset, job.sourceStart, job.duration);
              cuts.push(
                ...(await detectFillers(
                  excerpt,
                  get().settings,
                  // Under Tauri the excerpt starts at the clip's in-point; in
                  // the browser it is the whole file, and `sourceStart` says so.
                  job.clip.start + (excerpt.sourceStart - job.clip.offset),
                  controller.signal,
                )).filter(within),
              );
            } catch (error) {
              const failure = toAiError(error);
              if (failure.kind === 'cancelled') throw failure;
              warnings.push(`Hésitations — ${job.asset.name} : ${failure.message}`);
            }
          }
        }

        const merged = mergeCuts(cuts).filter((cut) => cut.end - cut.start > 0);
        // The median rather than the extreme: one very quiet clip should not
        // drag the suggestion for a whole timeline.
        const ranked = [...suggestions].sort((a, b) => a - b);
        set({
          smartCut: {
            cuts: merged,
            saved: totalCut(merged),
            analysed,
            warnings,
            suggestedThreshold: ranked[Math.floor(ranked.length / 2)] ?? null,
          },
          smartCutOpen: true,
        });

        if (merged.length === 0) {
          notify('Rien à retirer — le montage est déjà serré', 'success');
        }
      } catch (error) {
        report(error, 'Smart cut');
      } finally {
        if (inflight === controller) finish();
      }
    },

    /** Removes the accepted intervals from every track, as one undo step. */
    applySmartCut(cuts) {
      const project = useEditor.getState().project;
      if (!project || cuts.length === 0) return;

      const result = rippleDelete(project, cuts);
      if (result.removed <= 0) {
        notify('Aucune coupe applicable', 'error');
        return;
      }

      useEditor.getState().transact('smart cut', () => result.project);
      set({ smartCut: null, smartCutOpen: false });

      const saved = result.removed.toFixed(1).replace('.', ',');
      notify(
        `${saved} s retirées sur ${result.touched} clip${result.touched > 1 ? 's' : ''}${result.dropped > 0 ? ` · ${result.dropped} supprimé${result.dropped > 1 ? 's' : ''}` : ''}`,
        'success',
      );
    },
  };
});
