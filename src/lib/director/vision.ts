/**
 * Showing the rushes to the model.
 *
 * The complaint this answers is exact: a copilot handed nothing but filenames
 * and durations can only decide *how fast* to cut, never *what to cut to*. It
 * places clips in whatever order the shuffle produced, and the montage comes
 * out mechanically correct and editorially blind.
 *
 * So the clips are looked at. ffmpeg pulls a few frames out of each one — the
 * same `ai_poster` the viral cards and the tutorial analyser already use — and
 * one multimodal call comes back with a line about each: what is in it, and
 * whether it moves. Those lines go into the director's system prompt, and from
 * there the model can cast a clip into a movement for a reason.
 *
 * # Deliberately one call, deliberately cheap
 *
 * Frames are small and few. Three per clip at thumbnail width says whether a
 * shot is a face, a landscape or a fight without paying for a shot-by-shot
 * description nobody reads. And they travel in a single request rather than one
 * per clip: thirty round trips would cost thirty times the latency to learn the
 * same thing, and would rate-limit long before it finished.
 *
 * # Failure is not fatal
 *
 * A clip that will not yield a frame simply has no note, and the prompt says so
 * — the model is then told to treat it as an unlabelled shot rather than being
 * handed a confident description of something nobody looked at.
 */

import { generate } from '@/lib/ai/client';
import { fallbackChain, type AiSettings } from '@/types/ai';
import { CLIP_NOTES_SCHEMA } from '@/lib/ai/schema';
import type { MediaAsset } from '@/types/media';

/**
 * Where in a clip the frames are taken from, as fractions of its length.
 *
 * Not the very ends: a rush that opens on black and closes on a fade would be
 * described as two black frames and something in the middle. Three points also
 * catch a cut *inside* a source that was never trimmed, which a single frame
 * would report as whichever half it landed in.
 */
const SAMPLE_AT = [0.15, 0.5, 0.82];

/** Small enough to send ninety of them, large enough to recognise a subject. */
const FRAME_WIDTH = 256;

/**
 * How many clips are described in one pass.
 *
 * Past this the request stops being one call and starts being a payload. A bank
 * larger than this gets its first thirty described and the rest treated as
 * unlabelled, which is a far better outcome than a request that is refused for
 * its size and leaves every clip unlabelled.
 */
const MAX_CLIPS = 30;

/** Long enough for a multimodal call with ninety thumbnails. */
const TIMEOUT = 180;

interface RustPoster {
  data: string;
  mimeType: string;
}

/** One frame, or `null` when the file will not give one up. */
async function frame(path: string, at: number): Promise<RustPoster | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<RustPoster>('ai_poster', { path, at, width: FRAME_WIDTH });
  } catch {
    return null;
  }
}

const SYSTEM = `Tu regardes les rushs d'un monteur. Pour chaque clip on te donne son nom puis deux ou trois images prises à des moments différents.

Écris une seule ligne par clip, en français, quinze mots maximum. Dis ce qu'on voit et surtout **si ça bouge** : « gros plan visage, immobile », « combat, mouvement rapide », « panoramique paysage, lent », « foule, agitation ».

Le mouvement est l'information la plus utile : c'est ce qui décide si un plan tient un temps calme ou un impact. Ne suppose rien que les images ne montrent pas, et ne décris pas le style ni la qualité.`;

export interface ClipNote {
  id: string;
  /** What the model saw, or `null` when it was never shown or never answered. */
  note: string | null;
}

/**
 * A line about each clip, from its own frames.
 *
 * Returns a note for every asset it was given — `null` where nothing could be
 * looked at or nothing came back — so the caller never has to guess whether a
 * missing entry means "not described" or "not attempted".
 */
export async function describeClips(
  assets: MediaAsset[],
  settings: AiSettings,
  signal?: AbortSignal,
): Promise<ClipNote[]> {
  const notes: ClipNote[] = assets.map((asset) => ({ id: asset.id, note: null }));
  const looked = assets.slice(0, MAX_CLIPS).filter((asset) => asset.path !== null);
  if (looked.length === 0) return notes;

  /*
   * One `parts` array: a label, then that clip's frames, then the next label.
   *
   * Interleaving the names with the pictures is what lets one answer cover
   * thirty clips — a flat wall of ninety images would come back as thirty
   * descriptions in an order nobody could map back.
   */
  const parts: Record<string, unknown>[] = [];
  const shown: MediaAsset[] = [];

  for (const asset of looked) {
    const times = SAMPLE_AT.map((ratio) => Math.max(0.05, asset.duration * ratio));
    const frames = (await Promise.all(times.map((at) => frame(asset.path as string, at)))).filter(
      (item): item is RustPoster => item !== null,
    );
    if (signal?.aborted) return notes;
    // Nothing to look at is nothing to describe: sending the name alone would
    // invite the model to invent a shot from a filename.
    if (frames.length === 0) continue;

    shown.push(asset);
    parts.push({ text: `Clip ${shown.length} — « ${asset.name} » :` });
    for (const item of frames) {
      parts.push({ inlineData: { mimeType: item.mimeType, data: item.data } });
    }
  }

  if (shown.length === 0) return notes;

  const result = await generate(
    settings.model,
    {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        // Description, not invention: the lowest useful setting.
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: CLIP_NOTES_SCHEMA,
      },
    },
    { signal, timeoutSecs: TIMEOUT, fallbacks: fallbackChain(settings) },
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    // A malformed answer costs the descriptions, not the montage: every clip
    // keeps its `null` note and the prompt tells the model it is working blind.
    return notes;
  }

  const answers = (parsed as { clips?: unknown }).clips;
  if (!Array.isArray(answers)) return notes;

  /*
   * Matched by position, and only for as many as were actually shown.
   *
   * The model is asked for one line per clip in the order it was given them.
   * An answer with too few entries labels the ones it covered and leaves the
   * rest unlabelled; one with too many is truncated. Neither is allowed to
   * shift a description onto a clip it does not belong to.
   */
  shown.forEach((asset, index) => {
    const answer = answers[index];
    const text =
      typeof answer === 'string'
        ? answer
        : typeof (answer as { note?: unknown })?.note === 'string'
          ? ((answer as { note: string }).note)
          : '';
    if (text.trim() === '') return;

    const slot = notes.find((item) => item.id === asset.id);
    if (slot) slot.note = text.trim().slice(0, 140);
  });

  return notes;
}
