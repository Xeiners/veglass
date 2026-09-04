/**
 * The speech provider's own state.
 *
 * Session- and workspace-scoped, like `aiStore`: a key status, the account's
 * voice list and which voice was chosen are not document data, and folding them
 * into `editorStore` would put a preference inside the undo history.
 *
 * Separate from `aiStore` rather than a corner of it, because the two services
 * are independently optional. Someone may have a Gemini key and no ElevenLabs
 * one — that is the normal state of this application until the day they want a
 * voice-over — and a single store would make one empty state look like the
 * other's failure.
 */

import { create } from 'zustand';

import { toAiError } from '@/lib/ai/client';
import {
  clearApiKey,
  keyStatus as readKeyStatus,
  listVoices,
  preview,
  setApiKey,
  speechAvailable,
} from '@/lib/voice/client';
import { useEditor } from '@/store/editorStore';
import type { KeyStatus } from '@/types/ai';
import {
  DEFAULT_VOICE_PREFERENCES,
  VOICE_SETTINGS_VERSION,
  type VoiceInfo,
  type VoicePreferences,
  type VoiceSettings,
} from '@/types/voice';

/** Preferences live beside the app, like the export settings and the layout. */
const SETTINGS_KEY = 'veglass:voice-settings';

/** What the audition button says, when the user has not typed their own line. */
export const SAMPLE_LINE =
  "Voilà : on ouvre la fiche du client, on saisit le montant, et la vente est enregistrée.";

function readPreferences(): VoicePreferences {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_VOICE_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<VoicePreferences>;
    return {
      ...DEFAULT_VOICE_PREFERENCES,
      ...parsed,
      settings: { ...DEFAULT_VOICE_PREFERENCES.settings, ...(parsed.settings ?? {}) },
      version: VOICE_SETTINGS_VERSION,
    };
  } catch {
    return { ...DEFAULT_VOICE_PREFERENCES };
  }
}

function writePreferences(preferences: VoicePreferences): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(preferences));
  } catch {
    /* storage unavailable — the choice simply does not survive the session */
  }
}

interface VoiceState {
  keyStatus: KeyStatus;
  voices: VoiceInfo[];
  voicesLoading: boolean;
  preferences: VoicePreferences;
  /** A preview being fetched or played, so the button can say so. */
  auditioning: boolean;
  /** Whether the host can speak at all — false outside the desktop shell. */
  available: boolean;

  boot(): Promise<void>;
  saveKey(key: string, verify: boolean): Promise<boolean>;
  removeKey(): Promise<void>;
  loadVoices(announce?: boolean): Promise<void>;
  choose(voiceId: string): void;
  patch(patch: Partial<Omit<VoicePreferences, 'settings' | 'version'>>): void;
  patchSettings(patch: Partial<VoiceSettings>): void;
  audition(line?: string): Promise<void>;
  stopAudition(): void;
}

/** True once a key is stored *and* a voice has been chosen — the run gate. */
export const canSpeak = (state: VoiceState): boolean =>
  state.available && state.keyStatus.configured && state.preferences.voiceId.trim() !== '';

export const useVoice = create<VoiceState>((set, get) => {
  /** The audition in flight. Kept out of the store: it is not rendered. */
  let player: HTMLAudioElement | null = null;

  const notify = (message: string, tone: 'info' | 'success' | 'error' = 'info') =>
    useEditor.getState().notify(message, tone);

  const stop = () => {
    if (!player) return;
    player.pause();
    player.src = '';
    player = null;
  };

  return {
    keyStatus: { configured: false, backend: 'none', hint: null },
    voices: [],
    voicesLoading: false,
    preferences: readPreferences(),
    auditioning: false,
    available: speechAvailable(),

    async boot() {
      if (!speechAvailable()) return;
      try {
        const status = await readKeyStatus();
        set({ keyStatus: status });
        // The voice list is what turns a stored id into a name on screen, so it
        // is worth fetching at startup rather than when the panel opens.
        if (status.configured) void get().loadVoices(false);
      } catch {
        /* the panel shows the empty state, which is the truth */
      }
    },

    async saveKey(key, verify) {
      try {
        const status = await setApiKey(key, verify);
        set({ keyStatus: status });
        notify('Clé ElevenLabs enregistrée', 'success');
        if (status.configured) void get().loadVoices(false);
        return true;
      } catch (error) {
        notify(`Clé refusée — ${toAiError(error).message}`, 'error');
        return false;
      }
    },

    async removeKey() {
      stop();
      set({ keyStatus: await clearApiKey(), voices: [] });
      notify('Clé ElevenLabs supprimée');
    },

    async loadVoices(announce = true) {
      set({ voicesLoading: true });
      try {
        const voices = await listVoices();
        set({ voices });

        // A stored voice that is no longer on the account would otherwise fail
        // silently on the first line of a twelve-step tutorial.
        const chosen = get().preferences.voiceId;
        if (chosen && !voices.some((voice) => voice.id === chosen)) {
          get().patch({ voiceId: '' });
          notify(
            "La voix choisie n'existe plus sur votre compte ElevenLabs — sélectionnez-en une autre.",
            'error',
          );
        }

        if (announce) {
          notify(`${voices.length} voix disponibles`, 'success');
        }
      } catch (error) {
        if (announce) notify(`Liste des voix indisponible — ${toAiError(error).message}`, 'error');
      } finally {
        set({ voicesLoading: false });
      }
    },

    choose(voiceId) {
      get().patch({ voiceId });
    },

    patch(patch) {
      const next = { ...get().preferences, ...patch };
      writePreferences(next);
      set({ preferences: next });
    },

    patchSettings(patch) {
      const current = get().preferences;
      const next: VoicePreferences = {
        ...current,
        settings: { ...current.settings, ...patch },
      };
      writePreferences(next);
      set({ preferences: next });
    },

    async audition(line) {
      const { preferences } = get();
      if (!preferences.voiceId) {
        notify("Choisissez d'abord une voix", 'error');
        return;
      }

      stop();
      set({ auditioning: true });

      try {
        const heard = await preview({
          voiceId: preferences.voiceId,
          modelId: preferences.modelId,
          text: (line ?? SAMPLE_LINE).trim() || SAMPLE_LINE,
          settings: preferences.settings,
          key: 'preview',
        });

        const audio = new Audio(heard.url);
        player = audio;
        audio.addEventListener('ended', () => {
          if (player === audio) player = null;
          set({ auditioning: false });
        });
        await audio.play();
      } catch (error) {
        set({ auditioning: false });
        notify(`Écoute impossible — ${toAiError(error).message}`, 'error');
      }
    },

    stopAudition() {
      stop();
      set({ auditioning: false });
    },
  };
});
