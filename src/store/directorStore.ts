/**
 * The editing copilot's own state.
 *
 * Session-scoped, like the three generators before it, and for the same reason:
 * a conversation, a reference and a proposal are not part of the document.
 *
 * # It drives the montage engine, it does not duplicate it
 *
 * The music, the clips, the beats and the arc all live in `amvStore`, and this
 * reads them there. What the director adds is a reference, a strategy and a
 * conversation about both — and when the strategy is accepted it goes through
 * `amvStore.importAll`, which is the same single `transact` the wizard commits
 * through. One montage engine, one atomic write, two ways of asking for it.
 *
 * # Every word in the panel came over the wire
 *
 * There is no local answer generator here, and there deliberately is not. An
 * earlier version wrote its own prose when no key was configured — measured
 * numbers, honestly derived, phrased as though the copilot had said them — and
 * the result was a panel that looked identical whether or not it had ever
 * reached the network. That is worse than an error: it is an error nobody can
 * see. So a missing key and a failed request now both surface as failures, and
 * every turn attributed to the director carries the model that produced it.
 *
 * The measurements are still measurements. `strategyFromReference` derives a
 * baseline from ffmpeg's numbers with no model involved, and that baseline is
 * *input* to the conversation — it goes into the system prompt as "proposition
 * actuelle". What it never does is masquerade as the model's opinion.
 *
 * Anything the model returns goes through `normalizeStrategy`, which rebuilds
 * the strategy field by field on top of the current one, so the worst a bad
 * answer can do is change nothing.
 */

import { create } from 'zustand';

import { uid } from '@/lib/id';
import { AiError, generate, toAiError } from '@/lib/ai/client';
import { fetchReference } from '@/lib/director/client';
import {
  clipsOf,
  defaultStrategy,
  normalizeStrategy,
  optionsFor,
  resolveRecipe,
  strategyFromReference,
} from '@/lib/director/strategy';
import { describeClips, type ClipNote } from '@/lib/director/vision';
import { directorSystem, openingRequest } from '@/lib/director/prompt';
import { STRATEGY_SCHEMA } from '@/lib/ai/schema';
import { useAi } from '@/store/aiStore';
import { useAmv } from '@/store/amvStore';
import { useEditor } from '@/store/editorStore';
import { fallbackChain } from '@/types/ai';
import { DEFAULT_SETTINGS } from '@/types/project';
import {
  referenceUrl,
  type DirectorContext,
  type DirectorStage,
  type DirectorTurn,
  type ReferenceProfile,
  type ReferenceSource,
  type Strategy,
} from '@/types/director';

/** A chat turn that has not answered in this long is not going to. */
const TURN_TIMEOUT = 90;

/** How many turns of history the model is given. Enough to argue, not to drift. */
const HISTORY = 12;

interface DirectorState {
  reference: ReferenceSource | null;
  profile: ReferenceProfile | null;
  strategy: Strategy;
  turns: DirectorTurn[];

  stage: DirectorStage;
  error: string | null;
  /** True once this strategy has been committed to the document. */
  placed: boolean;

  /** True once the copilot has opened the conversation for this material. */
  briefed: boolean;

  /** Downloads and measures a reference edit. */
  ingest(url: string): Promise<void>;
  /**
   * Has the model open the conversation.
   *
   * The panel calls this when it has something to brief on. Nothing else does:
   * a copilot that spoke the moment an unrelated project was opened would be
   * talking to an empty room, and paying for it.
   */
  brief(): Promise<void>;
  /** One turn of conversation. Falls back to a written answer with no key. */
  send(text: string): Promise<void>;
  /**
   * Applies an adjustment from the proposal card, then asks the model about it.
   *
   * `label` is what the user pressed, and it becomes their turn in the
   * conversation — so the history the model sees contains the change rather
   * than being surprised by it on the next message.
   */
  tune(patch: Partial<Strategy>, label: string): Promise<void>;
  /**
   * Writes the montage from a strategy Gemini answered with.
   *
   * Takes the strategy rather than reading the current one, because the button
   * that calls it lives on a specific message in the conversation: what gets
   * committed is what that message proposed, not whatever the state has drifted
   * to since.
   */
  commit(strategy: Strategy): void;
  clearReference(): void;
  reset(): void;
}

export const useDirector = create<DirectorState>((set, get) => {
  let inflight: AbortController | null = null;
  /**
   * What the model saw in each clip, keyed by asset id.
   *
   * Held outside the rendered state — it is prompt material, never drawn — and
   * cached for the session: the frames do not change, so looking twice would
   * pay for the same answer.
   */
  let notes = new Map<string, string>();
  let looked = false;

  const push = (turn: Omit<DirectorTurn, 'id' | 'at'>) =>
    set((state) => ({
      turns: [...state.turns, { ...turn, id: uid('turn'), at: Date.now() }],
    }));

  /** A turn the user caused — a message, a link, a button on the card. */
  const asked = (text: string, strategy?: Strategy) =>
    push({ role: 'user', text, ...(strategy ? { strategy } : {}) });

  /**
   * A failure, shown as a failure.
   *
   * Never accompanied by a strategy or by prose that reads like an answer: a
   * turn that failed has to be visibly a turn that failed, or the panel is back
   * to looking like it worked.
   */
  const failed = (message: string) =>
    push({ role: 'director', text: 'La requête n’a pas abouti.', error: message });

  const fps = () => useEditor.getState().project?.settings.fps ?? DEFAULT_SETTINGS.fps;

  /**
   * Everything measured about this montage, gathered for the prompt.
   *
   * Read fresh on every turn from the montage store rather than cached: the
   * user can change the music or add clips between two messages, and a stale
   * brief is worse than none — it is a confident answer about a montage that no
   * longer exists.
   */
  const context = (): DirectorContext => {
    const amv = useAmv.getState();
    const reference = get().profile;
    const source = get().reference;

    return {
      music: amv.music ? { name: amv.music.name, duration: amv.music.duration } : null,
      tempo: amv.tempo,
      beats: amv.beats.length,
      arc: amv.structure?.phases.map((phase) => ({ ...phase })) ?? [],
      arcSource: amv.structure?.source ?? 'proportional',
      clips: amv.sources.map((asset) => ({
        id: asset.id,
        name: asset.name,
        duration: asset.duration,
        note: notes.get(asset.id) ?? null,
      })),
      looked,
      reference:
        reference && source
          ? {
              title: source.title,
              cuts: reference.cuts,
              duration: reference.duration,
              shot: reference.shot,
              arcSource: reference.arcSource,
              dropAt: reference.arc.drop,
            }
          : null,
      strategy: get().strategy,
      fps: fps(),
    };
  };

  /**
   * One round trip to Gemini, and the strategy it arrives at.
   *
   * The single place a model is spoken to, so the system prompt, the schema,
   * the history window and — above all — the normaliser cannot be applied in
   * one path and forgotten in another.
   */
  const ask = async (
    request: string,
    signal: AbortSignal,
  ): Promise<{
    text: string;
    strategy: Strategy;
    changed: boolean;
    /** The model that actually answered — not always the one asked for. */
    model: string;
    tokens: number;
  }> => {
    const ai = useAi.getState();

    const history = get()
      .turns.slice(-HISTORY)
      .map((turn) => ({
        role: turn.role === 'user' ? ('user' as const) : ('model' as const),
        parts: [{ text: turn.text }],
      }));

    const result = await generate(
      ai.settings.model,
      {
        systemInstruction: { parts: [{ text: directorSystem(context()) }] },
        contents: [...history, { role: 'user', parts: [{ text: request }] }],
        generationConfig: {
          // Warmer than a plan, which has to be exact; this is an opinion about
          // pacing, and an opinion delivered identically every time is not one.
          temperature: 0.5,
          responseMimeType: 'application/json',
          responseSchema: STRATEGY_SCHEMA,
        },
      },
      {
        signal,
        timeoutSecs: TURN_TIMEOUT,
        fallbacks: fallbackChain(ai.settings),
      },
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      throw new AiError('format', 'La réponse n’est pas revenue en JSON exploitable.');
    }

    const before = get().strategy;
    const strategy = normalizeStrategy(parsed, before, clipsOf(context()));
    const answer = parsed as { say?: unknown };

    const spoken = typeof answer.say === 'string' ? answer.say.trim() : '';
    if (spoken === '') {
      // The schema makes `say` required, so an empty one is a malformed answer
      // rather than a quiet turn — and inventing a sentence to stand in for it
      // is exactly the artifice this module no longer commits.
      throw new AiError('format', 'Le modèle a répondu sans rien dire.');
    }

    return {
      text: spoken,
      strategy,
      changed: JSON.stringify(strategy) !== JSON.stringify(before),
      model: result.model,
      tokens: result.usage.totalTokens,
    };
  };

  /**
   * One turn of conversation, over the network, or a visible failure.
   *
   * The single path by which anything reaches the panel with the director's
   * name on it. Everything that wants the copilot to speak goes through here,
   * so there is exactly one place where a request is made and exactly one place
   * where the absence of a key is handled — and neither of them can be bypassed
   * by a future caller in a hurry.
   */
  const converse = async (request: string): Promise<void> => {
    if (inflight) return;

    const ai = useAi.getState();
    if (!ai.keyStatus.configured) {
      set({
        stage: 'failed',
        error:
          'Aucune clé Gemini enregistrée. Le chef monteur a besoin de l’API pour répondre — ouvrez les réglages IA pour en ajouter une.',
      });
      return;
    }

    const controller = new AbortController();
    inflight = controller;
    set({ stage: 'thinking', error: null });

    try {
      const answer = await ask(request, controller.signal);
      if (controller.signal.aborted) return;

      set({ strategy: answer.strategy, stage: 'ready' });
      /*
       * The strategy rides on every model turn, changed or not.
       *
       * The card is what carries the commit button, and the button is the only
       * road to the timeline — so attaching it only when the numbers moved
       * would mean an answer of "oui, ça me va" left the user with nothing to
       * press. What a turn proposes is the strategy in force when it was said.
       */
      push({
        role: 'director',
        text: answer.text,
        strategy: answer.strategy,
        model: answer.model,
        tokens: answer.tokens,
      });
    } catch (error) {
      const failure = toAiError(error);
      if (failure.kind === 'cancelled') {
        set({ stage: 'ready' });
        return;
      }
      set({ stage: 'failed', error: failure.message });
      failed(failure.message);
    } finally {
      if (inflight === controller) inflight = null;
    }
  };

  return {
    reference: null,
    profile: null,
    strategy: defaultStrategy('aggressive'),
    turns: [],
    stage: 'idle',
    error: null,
    placed: false,
    briefed: false,

    async ingest(url) {
      const clean = referenceUrl(url);
      if (!clean) {
        set({ error: 'Ce lien n’est pas reconnu — YouTube, Shorts, TikTok, Vimeo…' });
        return;
      }
      if (inflight) return;

      const controller = new AbortController();
      inflight = controller;
      set({ stage: 'fetching', error: null, placed: false });

      set((state) => ({
        turns: [
          ...state.turns,
          { id: uid('turn'), role: 'user' as const, text: url, at: Date.now() },
        ],
      }));

      try {
        const projectId = useEditor.getState().project?.id ?? 'veglass';
        const found = await fetchReference(url, projectId, (stage) => set({ stage }));
        if (controller.signal.aborted) return;

        const strategy = strategyFromReference(found.profile);
        set({
          reference: found.source,
          profile: found.profile,
          strategy,
          stage: 'ready',
          // A new reference is new material: the copilot gets to open the
          // conversation again rather than carrying on about the old one.
          briefed: false,
        });

        /*
         * Nothing is said here.
         *
         * The measurements are displayed by the reference chip, where they
         * belong — they are a read-out, not a remark. The first sentence in the
         * conversation is Gemini's, which is the whole point of the panel.
         */
        inflight = null;
        await get().brief();
      } catch (error) {
        const failure = toAiError(error);
        set({ stage: 'failed', error: failure.message });
        failed(failure.message);
      } finally {
        if (inflight === controller) inflight = null;
      }
    },

    async brief() {
      if (get().briefed || inflight) return;

      const amv = useAmv.getState();
      if (!amv.music || amv.beats.length === 0 || amv.sources.length === 0) return;

      const ai = useAi.getState();
      if (!ai.keyStatus.configured) {
        set({
          stage: 'failed',
          error:
            'Aucune clé Gemini enregistrée. Le chef monteur a besoin de l’API pour répondre — ouvrez les réglages IA pour en ajouter une.',
        });
        return;
      }

      // Marked before the request, not after: a failed opening must not be
      // retried on every re-render of the panel.
      set({ briefed: true });

      /*
       * The rushes are looked at before anything is proposed.
       *
       * This is the difference between a copilot that distributes durations and
       * one that casts clips. It costs one extra call, once per session, and it
       * is what every editorial choice in the briefing rests on — so it happens
       * first and its own stage is shown, because extracting ninety frames and
       * waiting on a multimodal answer is visibly longer than a chat turn.
       */
      if (!looked && amv.sources.length > 0) {
        const controller = new AbortController();
        inflight = controller;
        set({ stage: 'watching', error: null });
        try {
          const seen = await describeClips(amv.sources, ai.settings, controller.signal);
          notes = new Map(
            seen.filter((item: ClipNote) => item.note !== null).map((item) => [item.id, item.note as string]),
          );
          looked = true;
        } catch (error) {
          // Working blind is a worse briefing, not a failed one — and the
          // prompt says plainly that nothing was seen.
          looked = true;
          console.error('clip description failed', toAiError(error).message);
        } finally {
          if (inflight === controller) inflight = null;
        }
        if (controller.signal.aborted) return;
      }

      await converse(openingRequest(context()));
    },

    async send(text) {
      const trimmed = text.trim();
      if (trimmed === '' || inflight) return;

      // A link in the message box is a reference, not a question.
      if (referenceUrl(trimmed)) {
        await get().ingest(trimmed);
        return;
      }

      asked(trimmed);
      await converse(trimmed);
    },

    async tune(patch, label) {
      // Through the same normaliser the model's answers go through, so a button
      // and a sentence cannot land the strategy in two different states.
      const strategy = normalizeStrategy(
        {
          ...(patch.profile ? { profile: patch.profile } : {}),
          ...(patch.shot
            ? {
                introShot: patch.shot.intro,
                buildShot: patch.shot.build,
                dropShot: patch.shot.drop,
              }
            : {}),
          ...(patch.punch !== undefined ? { punch: patch.punch } : {}),
          ...(patch.flashes !== undefined ? { flashes: patch.flashes } : {}),
          ...(patch.split !== undefined ? { split: patch.split } : {}),
          ...(patch.smear !== undefined ? { smear: patch.smear } : {}),
        },
        get().strategy,
      );
      set({ strategy, placed: false });

      /*
       * Recorded as the user's turn, because that is what it is.
       *
       * The card carries the new strategy so the panel shows what changed, and
       * the model is then asked to react — which keeps the conversation
       * continuous and, more to the point, keeps every *director* turn
       * something a model actually said. With no key the adjustment still
       * lands; only the reply to it is missing, and the panel says so.
       */
      asked(label, strategy);
      await converse(
        `J'ai ajusté la stratégie : ${label.toLowerCase()}. Réagis en une phrase ou deux, et corrige si tu penses que ça déséquilibre le montage.`,
      );
    },

    commit(strategy) {
      const amv = useAmv.getState();

      if (!amv.music || amv.beats.length === 0 || !amv.structure) {
        set({ error: 'Choisis ta musique et lance l’analyse avant de monter.' });
        return;
      }
      if (amv.sources.length === 0) {
        set({ error: 'Choisis au moins un clip source.' });
        return;
      }

      // The strategy reaches the engine as what it already understands: the
      // wizard's own options, and a tuned set of movements. No second path into
      // the document, and therefore no second way for the two to disagree.
      amv.setOptions(optionsFor(strategy, amv.options));
      amv.importAll(resolveRecipe(strategy, amv.beats, amv.structure));

      set({ strategy, placed: true, error: null });
    },

    clearReference() {
      set({
        reference: null,
        profile: null,
        strategy: defaultStrategy(get().strategy.profile),
        stage: 'idle',
        error: null,
        briefed: false,
      });
    },

    reset() {
      inflight?.abort();
      inflight = null;
      notes = new Map();
      looked = false;
      set({
        reference: null,
        profile: null,
        strategy: defaultStrategy('aggressive'),
        turns: [],
        stage: 'idle',
        error: null,
        placed: false,
        briefed: false,
      });
    },
  };
});

/**
 * Whether the engine has everything it needs to be told to go.
 *
 * A **boolean**, like everything else this module offers to be read with
 * `useDirector(…)`. zustand compares a selector's result by identity, so
 * anything composite has to be built with `useMemo` in the component that wants
 * it — see the note in `amvStore`, which learned this the expensive way.
 */
export const canCommit = (): boolean => {
  const amv = useAmv.getState();
  return amv.music !== null && amv.beats.length > 0 && amv.structure !== null && amv.sources.length > 0;
};
