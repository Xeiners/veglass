/**
 * The front-end's side of the speech bridge.
 *
 * Thin on purpose. Every call is an `invoke` into `commands::ai`, because the
 * key must never enter the renderer and because a generated take has to reach
 * the *disk* — the preview plays it, the exporter reads it, and neither can do
 * anything with an array of bytes in a JavaScript heap.
 *
 * That is also why there is no browser fallback here, unlike `lib/ai/client`.
 * Gemini can be talked to from a page with a key in `localStorage`, which is
 * good enough to develop a prompt against. A voice-over cannot: there is no
 * filesystem to write it to and no asset to point a clip at. Outside the
 * desktop shell this module says so plainly rather than half-working.
 */

import { isTauri } from '@/lib/env';
import { AiError, toAiError } from '@/lib/ai/client';
import type { KeyStatus } from '@/types/ai';
import type { SpeechTake, VoiceInfo, VoiceSettings } from '@/types/voice';

const UNAVAILABLE =
  "La voix off n'est disponible que dans l'application de bureau : le fichier audio doit être écrit sur le disque pour rejoindre le montage.";

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new AiError('io', UNAVAILABLE);
  const { invoke: call } = await import('@tauri-apps/api/core');
  try {
    return await call<T>(command, args);
  } catch (error) {
    throw toAiError(error);
  }
}

/** Whether the desktop shell can speak at all. Used to gate the UI, not to fail. */
export const speechAvailable = (): boolean => isTauri();

/* ---------------- Key ---------------- */

export function keyStatus(): Promise<KeyStatus> {
  if (!isTauri()) {
    return Promise.resolve({ configured: false, backend: 'none', hint: null });
  }
  return invoke<KeyStatus>('voice_key_status');
}

/**
 * Saves the key, listing the account's voices first to prove it works.
 *
 * `verify` exists for the same reason it does on the Gemini side: an offline
 * machine, or a key restricted in a way that forbids the listing, should still
 * be able to store one and find out later.
 */
export function setApiKey(key: string, verify = true): Promise<KeyStatus> {
  return invoke<KeyStatus>(verify ? 'voice_set_key' : 'voice_set_key_unchecked', { key });
}

export function clearApiKey(): Promise<KeyStatus> {
  return invoke<KeyStatus>('voice_clear_key');
}

/* ---------------- Voices ---------------- */

export function listVoices(): Promise<VoiceInfo[]> {
  return invoke<VoiceInfo[]>('voice_list');
}

/* ---------------- Speech ---------------- */

export interface SpeechRequest {
  voiceId: string;
  modelId: string;
  text: string;
  settings: VoiceSettings;
  /**
   * Basename for the file on disk.
   *
   * Composed from the project id and the step id so a second run of the same
   * step overwrites its own take rather than littering, and so two projects
   * generating the same step never collide. Sanitised again in Rust — this side
   * choosing well is a convenience, not a guarantee.
   */
  key: string;
}

interface RustTake {
  path: string;
  duration: number;
  words: { word: string; start: number; end: number }[];
  bytes: number;
  attempts: number;
}

/** Speaks one passage and writes it to disk. */
export async function speak(request: SpeechRequest): Promise<SpeechTake> {
  const take = await invoke<RustTake>('voice_speak', { request });
  return {
    path: take.path,
    duration: take.duration,
    words: take.words,
    bytes: take.bytes,
  };
}

export interface VoicePreview {
  /** A `data:` URI, ready for an `<audio>` element. */
  url: string;
  duration: number;
}

interface RustPreview {
  data: string;
  mimeType: string;
  duration: number;
}

/** The audition button. Never touches the disk. */
export async function preview(request: SpeechRequest): Promise<VoicePreview> {
  const answer = await invoke<RustPreview>('voice_preview', { request });
  return { url: `data:${answer.mimeType};base64,${answer.data}`, duration: answer.duration };
}

/**
 * Deletes takes nothing will reference.
 *
 * Called when a run is abandoned or its steps are dropped. Failures are
 * swallowed: an orphaned file is untidy, and interrupting someone who has just
 * pressed "annuler" to tell them so would be worse.
 */
export async function discard(keys: string[]): Promise<void> {
  if (keys.length === 0 || !isTauri()) return;
  try {
    await invoke<void>('voice_discard', { keys });
  } catch {
    /* housekeeping — never worth a toast */
  }
}
