import { create } from 'zustand';
import { uid } from '@/lib/id';
import { snapToFrame } from '@/lib/time';
import { assetFromPath } from '@/lib/media';
import { speak, discard } from '@/lib/voice/client';
import { draftRangeNarration, narrationFingerprint, placeRangeNarration, validateNarrationRange,
  MAX_NARRATION_CONTEXT, MAX_NARRATION_TEXT, type NarrationRange } from '@/lib/tutorial/rangeNarration';
import { SCHEMA_VERSION } from '@/types/project';
import type { MediaAsset } from '@/types/media';
import type { SpeechTake } from '@/types/voice';
import { useEditor, projectDuration } from './editorStore';
import { useAi } from './aiStore';
import { useVoice, canSpeak } from './voiceStore';
import { useTutorial } from './tutorialStore';

interface State {
  open: boolean;
  projectId: string | null;
  range: NarrationRange;
  context: string;
  instruction: string;
  text: string;
  title: string;
  busy: boolean;
  detail: string;
  error: string | null;
  images: number | null;
  missing: number;
  take: SpeechTake | null;
  asset: MediaAsset | null;
  key: string | null;
  fingerprint: string | null;
  placed: boolean;
  openWizard(): void;
  close(): void;
  cancel(): void;
  configure(patch: Partial<Pick<State, 'range' | 'context' | 'instruction' | 'text'>>): void;
  saveContext(): void;
  generate(): Promise<void>;
  synthesize(): Promise<void>;
  insert(): void;
}

export const useRangeNarration = create<State>((set, get) => {
  let job = 0;
  let abort: AbortController | null = null;
  const sameProject = () => useEditor.getState().project?.id === get().projectId;
  const release = () => { const state = get(); if (state.key && !state.placed) void discard([state.key]); };
  const initial = { text: '', title: 'Complément tutoriel', busy: false, detail: '', error: null,
    images: null, missing: 0, take: null, asset: null, key: null, fingerprint: null, placed: false };
  const currentProject = () => {
    const project = useEditor.getState().project;
    if (!project || project.id !== get().projectId) throw new Error('Le projet a changé. Rouvrez la voix off depuis la timeline.');
    validateNarrationRange(project, get().range);
    return project;
  };
  return {
    open: false, projectId: null, range: { start: 0, end: 15 }, context: '', instruction: '', ...initial,
    openWizard() {
      const editor = useEditor.getState(), project = editor.project;
      if (!project) return;
      const end = projectDuration(project);
      const range = editor.workIn !== null && editor.workOut !== null
        ? { start: editor.workIn, end: editor.workOut }
        : { start: editor.playhead, end: Math.min(end, editor.playhead + 15) };
      editor.pause();
      if (get().projectId === project.id && get().range.start === range.start && get().range.end === range.end) { set({ open: true }); return; }
      get().cancel(); release();
      const tutorial = useTutorial.getState().options;
      set({ ...initial, open: true, projectId: project.id, range,
        context: project.tutorialContext ?? (project.assets.some(asset => asset.id === tutorial.assetId) ? tutorial.brief : ''), instruction: '' });
    },
    close() { get().cancel(); set({ open: false }); },
    cancel() { job++; abort?.abort(); abort = null; set({ busy: false, detail: '' }); },
    configure(patch) {
      if (get().busy) return;
      release();
      const frameRate = useEditor.getState().project?.settings.fps ?? 30;
      const range = patch.range && { start: Number.isFinite(patch.range.start) ? snapToFrame(patch.range.start, frameRate) : NaN,
        end: Number.isFinite(patch.range.end) ? snapToFrame(patch.range.end, frameRate) : NaN };
      const resetText = 'range' in patch || 'context' in patch || 'instruction' in patch;
      set({ ...patch, ...(range ? { range } : {}), ...(resetText ? { text: '', images: null, missing: 0, fingerprint: null } : {}),
        take: null, asset: null, key: null, placed: false, error: null });
    },
    saveContext() {
      if (!sameProject()) { set({ error: 'Le projet a changé.' }); return; }
      const context = get().context.trim().slice(0, MAX_NARRATION_CONTEXT);
      if (useEditor.getState().project?.tutorialContext === context) return;
      useEditor.getState().transact('contexte du tutoriel', project => ({ ...project, schemaVersion: SCHEMA_VERSION, tutorialContext: context }));
    },
    async generate() {
      if (get().busy) return;
      let project;
      try {
        project = currentProject();
        if (!get().context.trim()) throw new Error('Décrivez le contexte du tutoriel.');
        if (!useAi.getState().keyStatus.configured) throw new Error('Configurez la clé Gemini dans les réglages IA.');
      } catch (error) { set({ error: String(error instanceof Error ? error.message : error) }); return; }
      get().saveContext();
      const state = get(), controller = new AbortController(), run = ++job;
      abort = controller;
      release();
      set({ busy: true, error: null, detail: 'Préparation des images', take: null, asset: null, key: null, placed: false });
      try {
        const proposal = await draftRangeNarration(project, state.range, state.context, state.instruction,
          useAi.getState().settings, controller.signal, detail => { if (run === job && sameProject()) set({ detail }); });
        if (run !== job || !sameProject()) return;
        set({ ...proposal, fingerprint: narrationFingerprint(project, state.range) });
      } catch (error) { if (run === job && sameProject()) set({ error: error instanceof Error ? error.message : String(error) }); }
      finally { if (run === job) { abort = null; set({ busy: false, detail: '' }); } }
    },
    async synthesize() {
      if (get().busy) return;
      let project;
      try {
        project = currentProject();
        if (!get().text.trim() || get().text.length > MAX_NARRATION_TEXT) throw new Error('Écrivez un texte de 1 à 4 000 caractères.');
        if (!canSpeak(useVoice.getState())) throw new Error('Configurez ElevenLabs et choisissez une voix dans les réglages. La voix nécessite l’application de bureau.');
        if (get().fingerprint && get().fingerprint !== narrationFingerprint(project, get().range)) throw new Error('Les images de la plage ont changé. Relancez la rédaction avant de générer la voix.');
      } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); return; }
      get().saveContext();
      const state = get(), run = ++job, key = uid('range-voice');
      const preferences = useVoice.getState().preferences;
      release();
      set({ busy: true, error: null, detail: 'Enregistrement de la voix off', take: null, asset: null, key: null, placed: false });
      try {
        const take = await speak({ key, voiceId: preferences.voiceId, modelId: preferences.modelId, settings: preferences.settings, text: state.text.trim() });
        if (run !== job || !sameProject()) { await discard([key]); return; }
        if (!Number.isFinite(take.duration) || take.duration <= 0) throw new Error('La voix générée n’a pas de durée valide. Réessayez.');
        const loaded = await assetFromPath(take.path);
        if (run !== job || !sameProject()) { await discard([key]); return; }
        set({ take, asset: { ...loaded, kind: 'audio', name: `Voix — ${state.title}`, duration: take.duration }, key,
          fingerprint: narrationFingerprint(project, state.range) });
      } catch (error) {
        await discard([key]);
        if (run === job && sameProject()) set({ error: error instanceof Error ? error.message : String(error) });
      } finally { if (run === job) set({ busy: false, detail: '' }); }
    },
    insert() {
      const state = get();
      if (state.busy || state.placed || !state.take || !state.asset) return;
      try {
        const project = currentProject();
        if (state.fingerprint !== narrationFingerprint(project, state.range)) throw new Error('Les images de la plage ont changé. Relancez la rédaction.');
        const take = state.take, asset = state.asset;
        const ids = { clip: uid('cl'), track: uid('tr') };
        useEditor.getState().transact('voix off sur la sélection', current => placeRangeNarration(current, state.range, take, asset, state.title, ids));
        set({ placed: true, key: null, error: null });
        useEditor.getState().selectClip(ids.clip);
        useEditor.getState().notify('Voix ajoutée dans la plage, sur sa propre piste — Ctrl + Z pour annuler.', 'success');
      } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); }
    },
  };
});
