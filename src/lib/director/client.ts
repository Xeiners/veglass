/**
 * Fetching a reference, and measuring it.
 *
 * Two tools the editor already carries, pointed at a new problem. yt-dlp brings
 * the file down — the same downloader the online panel uses, so a machine that
 * can fetch a clip can fetch a reference. ffmpeg then measures it twice: once
 * for where it cuts, once for the beats of its own soundtrack.
 *
 * Desktop only, and it says so rather than degrading. There is no browser
 * equivalent of either half, and a "reference analysis" that guessed from the
 * URL would be a fabrication dressed as a measurement.
 */

import { isTauri } from '@/lib/env';
import { AiError } from '@/lib/ai/client';
import { onsetCurve } from '@/lib/amv/client';
import { detectBeats } from '@/lib/amv/beats';
import { download } from '@/lib/online/client';
import { uid } from '@/lib/id';
import { readReference } from './reference';
import type { ReferenceProfile, ReferenceSource } from '@/types/director';

/**
 * Height the reference is fetched at.
 *
 * Scene detection compares whole frames, and it reaches the same verdict on a
 * small one — while a 360p copy of a three-minute video is a few megabytes and
 * arrives in seconds. Fetching at full resolution would multiply both the wait
 * and the disk for a measurement that would not change.
 */
const REFERENCE_HEIGHT = 360;

/**
 * How much of a reference is looked at, in seconds.
 *
 * Matches the ceiling the Rust side enforces. Stated here too because the
 * *audio* pass has its own limit, and the two measurements have to cover the
 * same stretch or the cut rates would be attributed to the wrong movements.
 */
export const REFERENCE_WINDOW = 180;

/** Sensitivity the reference's own beats are picked at. */
const REFERENCE_SENSITIVITY = 0.5;

export interface SceneCuts {
  cuts: number[];
  scores: number[];
  duration: number;
}

const sceneCuts = async (path: string): Promise<SceneCuts> => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<SceneCuts>('ai_scene_cuts', {
    path,
    // Zero means the Rust side's own default, which is the one number here that
    // should not be restated in two places.
    threshold: 0,
    seconds: REFERENCE_WINDOW,
  });
};

export interface FetchedReference {
  source: ReferenceSource;
  profile: ReferenceProfile;
}

/**
 * Brings a reference down and reads it.
 *
 * `onStage` is called as it moves between the two long parts, because they fail
 * for entirely different reasons — a dead link, and a file ffmpeg cannot open —
 * and a panel that said only "working" would leave someone guessing which.
 */
export async function fetchReference(
  url: string,
  projectId: string,
  onStage: (stage: 'fetching' | 'reading') => void,
): Promise<FetchedReference> {
  if (!isTauri()) {
    throw new AiError(
      'unsupported',
      "L'analyse d'une référence demande l'application de bureau : elle télécharge la vidéo puis la mesure avec ffmpeg.",
    );
  }

  onStage('fetching');
  const report = await download({
    id: uid('ref'),
    url,
    projectId,
    title: 'reference',
    selection: { kind: 'video', height: REFERENCE_HEIGHT },
  });

  onStage('reading');
  const scenes = await sceneCuts(report.path);

  /*
   * The soundtrack, if it has one worth reading.
   *
   * A reference with no audio — a silent loop, a stream that came down without
   * it — is still perfectly useful: its cuts are the thing being copied. So a
   * failure here is swallowed rather than raised, and the arc falls back to the
   * conventional proportions, which `readReference` reports honestly.
   */
  let beats: ReturnType<typeof detectBeats> = [];
  try {
    const curve = await onsetCurve(report.path, 0, REFERENCE_WINDOW);
    beats = detectBeats(curve, REFERENCE_SENSITIVITY);
  } catch {
    beats = [];
  }

  const duration = scenes.duration > 0 ? scenes.duration : REFERENCE_WINDOW;

  return {
    source: { url, title: report.name, path: report.path, duration },
    profile: readReference(scenes.cuts, beats, duration),
  };
}
