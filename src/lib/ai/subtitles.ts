/**
 * Speech to subtitle clips.
 *
 * Three steps, kept apart because only the middle one needs a network:
 *
 * 1. `audioJobs` (in `./scope`) works out *what* to listen to. Transcribing a
 *    mixdown of the whole timeline would be one big request, but it would also
 *    lose the mapping back to clips — so each media clip carrying sound is
 *    transcribed from its own source file, over its own in/out points, and the
 *    timings are shifted onto the timeline afterwards. Trimming a clip
 *    therefore transcribes exactly what is heard, not what the file contains.
 * 2. [`transcribe`] is the one Gemini call.
 * 3. [`buildSubtitleClips`] is pure: segments in, a new `Project` out. That is
 *    what lets a hundred subtitles land as a single undo step.
 */

import { clamp, snapToFrame } from '@/lib/time';
import { uid } from '@/lib/id';
import { audioExcerpt, generate, AiError } from './client';
import { alignmentSystem, transcriptionSystem } from './prompts';
import { TRANSCRIPT_SCHEMA } from './schema';
import { entranceAnimation } from './motion';
import type { AudioJob } from './scope';
import type { Project, ProjectSettings } from '@/types/project';
import {
  DEFAULT_TRACK_HEIGHT,
  MIN_CLIP_DURATION,
  clipEnd,
  type Clip,
  type Track,
} from '@/types/timeline';
import { defaultTextLayer, type TextLayer } from '@/types/text';
import {
  SUBTITLE_TRACK_NAME,
  fallbackChain,
  type AiSettings,
  type SubtitleOptions,
  type SubtitlePreset,
  type TranscriptSegment,
} from '@/types/ai';

/** A subtitle shorter than this flashes; it is stretched into the gap after it. */
const MIN_SUBTITLE = 0.7;

/* ------------------------------------------------------------------ *
 * Transcription
 * ------------------------------------------------------------------ */

interface RawSegment {
  start: number;
  end: number;
  text: string;
}

function readSegments(payload: string): RawSegment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new AiError('format', "La transcription n'est pas revenue en JSON exploitable.");
  }
  const entries = (parsed as { segments?: unknown }).segments;
  if (!Array.isArray(entries)) return [];

  const out: RawSegment[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { start, end, text } = entry as Record<string, unknown>;
    if (typeof start !== 'number' || typeof end !== 'number') continue;
    if (typeof text !== 'string' || !text.trim()) continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    out.push({ start, end, text: text.trim() });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The script, trimmed to lines the model can be asked to place.
 *
 * Blank lines are separators, not content, and a line of pure punctuation —
 * `[Refrain]`, `♪♪` — is a marker someone pasted along with the words rather
 * than something anyone sings.
 */
function scriptLines(script: string): string[] {
  return script
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /\p{L}|\p{N}/u.test(line));
}

/**
 * Transcribes one job and returns segments **on the timeline**.
 *
 * The mapping is the subtle part. An excerpt covers source time
 * `[excerpt.sourceStart, …)`, and the clip maps source time `s` onto the
 * timeline at `clip.start + (s - clip.offset)`. Under Tauri the excerpt starts
 * exactly at the clip's in-point and the two terms cancel; in the browser the
 * whole file is sent and they do not. Composing them explicitly is what makes
 * both hosts land the subtitles in the same place.
 */
export async function transcribe(
  job: AudioJob,
  settings: AiSettings,
  options: SubtitleOptions,
  signal?: AbortSignal,
): Promise<TranscriptSegment[]> {
  const excerpt = await audioExcerpt(job.asset, job.sourceStart, job.duration);
  if (signal?.aborted) throw new AiError('cancelled', 'Transcription annulée.');

  const lines = options.mode === 'align' ? scriptLines(options.script) : [];
  if (options.mode === 'align' && lines.length === 0) {
    throw new AiError('request', 'Collez le texte à caler avant de lancer la passe.');
  }

  // Aligning and transcribing are the same round trip with a different job:
  // one asks what was said, the other only when. The second is far more
  // reliable, because the model is reading rather than remembering.
  const instruction =
    options.mode === 'align'
      ? alignmentSystem({ maxCharsPerLine: options.maxCharsPerLine })
      : transcriptionSystem({
          language: options.language,
          maxCharsPerLine: options.maxCharsPerLine,
          maxDuration: options.maxDuration,
        });

  const request =
    options.mode === 'align'
      ? [
          `Cale ce texte sur l'extrait de « ${job.asset.name} » (environ ${job.duration.toFixed(1)} s).`,
          `Reprends chaque ligne mot pour mot ; omets celles que tu n'entends pas ici.`,
          '',
          lines.join('\n'),
        ].join('\n')
      : `Transcris cet extrait de « ${job.asset.name} ». Il dure environ ${job.duration.toFixed(1)} s.`;

  const result = await generate(
    settings.transcriptionModel || settings.model,
    {
      systemInstruction: { parts: [{ text: instruction }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: request },
            { inlineData: { mimeType: excerpt.mimeType, data: excerpt.data } },
          ],
        },
      ],
      generationConfig: {
        // Transcription is a reading task, not a writing one.
        temperature: 0.05,
        responseMimeType: 'application/json',
        responseSchema: TRANSCRIPT_SCHEMA,
      },
    },
    // Audio is the slow case by a wide margin: an hour of speech is minutes of
    // work, and cutting it short would throw away a request already paid for.
    { signal, timeoutSecs: 420, fallbacks: fallbackChain(settings) },
  );

  const shift = job.clip.start + excerpt.sourceStart - job.clip.offset;
  const from = job.clip.start;
  const to = clipEnd(job.clip);

  const mapped: TranscriptSegment[] = [];
  for (const segment of readSegments(result.text)) {
    const start = clamp(segment.start + shift, from, to);
    const end = clamp(segment.end + shift, from, to);
    if (end - start < 0.1) continue;
    mapped.push({ start, end, text: segment.text });
  }

  return mapped;
}

/**
 * Merges the results of several jobs into one ordered, non-overlapping list.
 *
 * Two clips of the same interview on stacked layers would otherwise produce two
 * subtitles at the same instant, and the second would be dropped silently by
 * the placement pass. Resolving it here keeps that decision visible.
 */
export function mergeSegments(groups: TranscriptSegment[][]): TranscriptSegment[] {
  const all = groups.flat().sort((a, b) => a.start - b.start || a.end - b.end);
  const out: TranscriptSegment[] = [];

  for (const segment of all) {
    const previous = out[out.length - 1];
    if (previous && segment.start < previous.end - 0.02) {
      // Overlap: keep the longer line, which is almost always the more complete
      // transcription of the same speech.
      if (segment.end - segment.start > previous.end - previous.start) {
        out[out.length - 1] = segment;
      }
      continue;
    }
    out.push(segment);
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Style
 * ------------------------------------------------------------------ */

export interface SubtitleStyle {
  text: TextLayer;
  /** Offset from the centre of the frame, in project pixels. */
  y: number;
}

/**
 * Type scaled to the frame, not to 1080p.
 *
 * Sizes are expressed as a fraction of the frame height so a vertical 1080×1920
 * export and a 4K master both get subtitles that read the same on screen —
 * which is the whole reason text layers are measured in project pixels.
 */
export function subtitleStyle(preset: SubtitlePreset, settings: ProjectSettings): SubtitleStyle {
  const height = Math.max(settings.height, 240);
  const base = defaultTextLayer('');

  if (preset === 'broadcast') {
    const fontSize = Math.round(height * 0.058);
    return {
      text: {
        ...base,
        fontSize,
        fontWeight: 700,
        letterSpacing: -0.01,
        lineHeight: 1.18,
        stroke: { width: Math.max(2, Math.round(fontSize * 0.045)), color: '#000000' },
        shadow: { blur: Math.round(fontSize * 0.35), offsetX: 0, offsetY: Math.round(fontSize * 0.08), color: '#000000', opacity: 0.7 },
      },
      y: Math.round(height * 0.5 - height * 0.145),
    };
  }

  if (preset === 'social') {
    const fontSize = Math.round(height * 0.062);
    return {
      text: {
        ...base,
        fontSize,
        fontWeight: 800,
        letterSpacing: -0.03,
        lineHeight: 1.1,
        stroke: { width: Math.max(3, Math.round(fontSize * 0.07)), color: '#000000' },
        shadow: { blur: Math.round(fontSize * 0.3), offsetX: 0, offsetY: 0, color: '#000000', opacity: 0.5 },
      },
      // Nearer the middle: on a phone, the bottom eighth is under the interface.
      y: Math.round(height * 0.09),
    };
  }

  const fontSize = Math.round(height * 0.046);
  return {
    text: {
      ...base,
      fontSize,
      fontWeight: 600,
      letterSpacing: -0.005,
      lineHeight: 1.22,
      stroke: { width: Math.max(1, Math.round(fontSize * 0.03)), color: '#000000' },
      shadow: { blur: Math.round(fontSize * 0.4), offsetX: 0, offsetY: Math.round(fontSize * 0.06), color: '#000000', opacity: 0.55 },
    },
    y: Math.round(height * 0.5 - height * 0.115),
  };
}

/* ------------------------------------------------------------------ *
 * Placement
 * ------------------------------------------------------------------ */

export interface SubtitleBuild {
  project: Project;
  added: number;
  /** Segments dropped because the chosen track was already busy there. */
  skipped: number;
  trackName: string;
}

/**
 * Turns timeline segments into text clips on a dedicated layer.
 *
 * Pure — it returns a new document and writes nothing. The caller commits it in
 * one `transact`, which is what makes a hundred subtitles a single undo step.
 */
export function buildSubtitleClips(
  project: Project,
  segments: TranscriptSegment[],
  options: SubtitleOptions,
): SubtitleBuild {
  const { fps } = project.settings;
  const style = options.style ?? subtitleStyle(options.preset, project.settings);

  // A named track the user picked, the one a previous pass created, or a new
  // one on top. Reusing "Sous-titres" means running the pass twice does not
  // leave a stack of near-identical layers behind.
  const chosen =
    project.tracks.find((track) => track.id === options.trackId && track.kind === 'video') ??
    project.tracks.find(
      (track) => track.kind === 'video' && track.name === SUBTITLE_TRACK_NAME,
    ) ??
    null;

  const created: Track | null = chosen
    ? null
    : {
        id: uid('tr'),
        kind: 'video',
        name: SUBTITLE_TRACK_NAME,
        height: DEFAULT_TRACK_HEIGHT,
        muted: false,
        solo: false,
        locked: false,
        hidden: false,
      };

  const trackId = chosen?.id ?? (created as Track).id;
  const occupied = project.clips.filter((clip) => clip.trackId === trackId);

  const clips: Clip[] = [];
  let skipped = 0;

  const ordered = [...segments].sort((a, b) => a.start - b.start);
  for (let index = 0; index < ordered.length; index += 1) {
    const segment = ordered[index] as TranscriptSegment;
    const next = ordered[index + 1];

    const start = snapToFrame(Math.max(0, segment.start), fps);
    // A subtitle may grow into the gap that follows it, but never past the next
    // line: two captions on screen at once is worse than one that leaves early.
    const ceiling = next ? snapToFrame(Math.max(0, next.start), fps) : Infinity;
    const wanted = Math.max(segment.end - segment.start, MIN_SUBTITLE);
    const end = Math.min(
      snapToFrame(start + Math.min(wanted, options.maxDuration), fps),
      ceiling,
    );
    const duration = end - start;
    if (duration < MIN_CLIP_DURATION) {
      skipped += 1;
      continue;
    }

    const collides = [...occupied, ...clips].some(
      (clip) => start < clipEnd(clip) && start + duration > clip.start,
    );
    if (collides) {
      skipped += 1;
      continue;
    }

    const clip: Clip = {
      id: uid('cl'),
      kind: 'text',
      assetId: null,
      trackId,
      start,
      duration,
      offset: 0,
      volume: 1,
      opacity: 1,
      scale: 1,
      x: 0,
      y: style.y,
      rotation: 0,
      muted: true,
      label: segment.text.replace(/\n/g, ' ').slice(0, 32),
      effects: [],
      text: { ...style.text, content: segment.text },
    };

    const animation = entranceAnimation(clip, options.animation, fps);
    clips.push(animation ? { ...clip, animation } : clip);
  }

  return {
    project: {
      ...project,
      // A subtitle layer belongs above the picture it captions.
      tracks: created ? [created, ...project.tracks] : project.tracks,
      clips: [...project.clips, ...clips],
    },
    added: clips.length,
    skipped,
    trackName: chosen?.name ?? SUBTITLE_TRACK_NAME,
  };
}
