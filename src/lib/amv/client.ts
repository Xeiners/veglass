/**
 * The two native calls the AMV generator makes.
 *
 * Both are desktop-only, and both say so rather than degrading. The reason is
 * the same one `audioEnvelope` gives: the browser host could *approximate* an
 * onset curve from the decoded waveform the media pool already holds, and a
 * montage cut on approximate beats is a montage that lands slightly off the
 * music everywhere — which is worse than not offering the feature at all.
 * Reading a folder has no browser equivalent to be wrong about.
 *
 * Errors come back as `AiError` because these are `ai::error::Result` on the
 * Rust side, and the wizard already knows how to show one. That is reuse of a
 * vocabulary, not a claim that anything here talks to a model.
 */

import { isTauri } from '@/lib/env';
import { AiError } from '@/lib/ai/client';
import type { OnsetCurve } from './beats';

/**
 * How finely the transient curve is measured, in frames per second.
 *
 * Five milliseconds a frame — well under the ~33 ms a 30 fps timeline can
 * actually cut on, so the frame the beat snaps to is the nearest one rather
 * than the nearest one the *analysis* could see. Going finer would sharpen a
 * number that is rounded away immediately afterwards.
 */
const ONSET_FRAMES_PER_SECOND = 200;

/**
 * The per-band transient curve of a music file.
 *
 * `duration` of zero means "to the end of the track", which is what the wizard
 * always wants: the montage is capped afterwards, on the beats, rather than by
 * analysing a truncated file.
 */
export async function onsetCurve(
  path: string | null,
  start = 0,
  duration = 0,
): Promise<OnsetCurve> {
  if (!isTauri()) {
    throw new AiError(
      'unsupported',
      "L'analyse du rythme demande l'application desktop — elle décode la piste avec ffmpeg.",
    );
  }
  if (!path) throw new AiError('io', "Ce morceau n'a pas de fichier sur le disque.");

  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<OnsetCurve>('ai_audio_onsets', {
    path,
    start,
    duration,
    framesPerSecond: ONSET_FRAMES_PER_SECOND,
  });
}

/**
 * Every media file sitting directly in `folder`, sorted by name.
 *
 * Shallow, and sorted by the Rust side rather than here — the sequencer draws
 * from this list through a seeded shuffle, so the order it starts from has to
 * be the same on every run and on every machine.
 */
export async function listFolder(folder: string, extensions: string[]): Promise<string[]> {
  if (!isTauri()) {
    throw new AiError(
      'unsupported',
      "Choisir un dossier de clips demande l'application desktop. Glissez les vidéos dans les médias du projet à la place.",
    );
  }

  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string[]>('list_media_folder', { path: folder, extensions });
}
