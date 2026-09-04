/**
 * Transport for the AI suite.
 *
 * Like every other native capability in this app, it has two hosts. On the
 * desktop the request is made from Rust: the API key never enters the renderer,
 * there is no CORS to satisfy, and ffmpeg is there to compress audio before it
 * is sent. In the browser — `npm run dev` — the same functions call the API
 * directly with a key kept in local storage, which is enough to build and test
 * every prompt without leaving the dev server.
 *
 * The two hosts are not equal, and this module does not pretend otherwise:
 * `audioEnvelope` has no browser implementation and says so with an
 * `unsupported` error rather than returning something plausible and wrong.
 */

import { isTauri } from '@/lib/env';
import type { AiErrorKind, GenerateUsage, KeyStatus, ModelInfo } from '@/types/ai';
import type { LoudnessEnvelope } from '@/types/ai';

/** Browser-host key storage. Never used under Tauri. */
const BROWSER_KEY = 'veglass:gemini-key';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * A failure with a machine-readable cause.
 *
 * The UI switches on `kind`: `missing-key` and `invalid-key` open the settings
 * panel, `quota` says to come back later, `network` offers a retry. Anything
 * else is shown as a message and the editor carries on.
 */
export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(kind: AiErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'AiError';
    this.kind = kind;
    this.status = status;
    this.retryable = kind === 'rate-limit' || kind === 'network' || kind === 'server';
  }
}

/** Shape Rust rejects with — an object, not a string, unlike the other commands. */
interface RustAiError {
  kind: AiErrorKind;
  message: string;
  status: number | null;
  retryable: boolean;
}

const isRustAiError = (value: unknown): value is RustAiError =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as RustAiError).kind === 'string' &&
  typeof (value as RustAiError).message === 'string';

/** Anything a rejected `invoke` can throw, normalised. */
export function toAiError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (isRustAiError(error)) {
    return new AiError(error.kind, error.message, error.status);
  }
  if (error instanceof Error) {
    return new AiError('io', error.message);
  }
  return new AiError('io', String(error));
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import('@tauri-apps/api/core');
  try {
    return await call<T>(command, args);
  } catch (error) {
    throw toAiError(error);
  }
}

/* ------------------------------------------------------------------ *
 * Key
 * ------------------------------------------------------------------ */

const browserKey = (): string | null => {
  try {
    return localStorage.getItem(BROWSER_KEY);
  } catch {
    return null;
  }
};

const hintOf = (key: string): string => `…${key.slice(-4)}`;

export async function keyStatus(): Promise<KeyStatus> {
  if (isTauri()) return invoke<KeyStatus>('ai_key_status');
  const key = browserKey();
  return key
    ? { configured: true, backend: 'browser', hint: hintOf(key) }
    : { configured: false, backend: 'none', hint: null };
}

/**
 * Stores a key, checking it against the live service first.
 *
 * Verifying before saving is what makes the panel trustworthy: a typo is caught
 * while the field is still on screen instead of surfacing an hour later as a
 * failed transcription. Listing models costs no tokens.
 */
export async function setApiKey(key: string, verify = true): Promise<KeyStatus> {
  const trimmed = key.trim();
  if (!trimmed) throw new AiError('invalid-key', 'La clé est vide.');

  if (isTauri()) {
    return verify
      ? invoke<KeyStatus>('ai_set_key', { key: trimmed })
      : invoke<KeyStatus>('ai_set_key_unchecked', { key: trimmed });
  }

  if (verify) await listModelsWith(trimmed);
  try {
    localStorage.setItem(BROWSER_KEY, trimmed);
  } catch {
    throw new AiError('io', "Le stockage local du navigateur n'est pas disponible.");
  }
  return { configured: true, backend: 'browser', hint: hintOf(trimmed) };
}

export async function clearApiKey(): Promise<KeyStatus> {
  if (isTauri()) return invoke<KeyStatus>('ai_clear_key');
  try {
    localStorage.removeItem(BROWSER_KEY);
  } catch {
    /* nothing stored is the same outcome as nothing to remove */
  }
  return { configured: false, backend: 'none', hint: null };
}

export async function listModels(): Promise<ModelInfo[]> {
  if (isTauri()) return invoke<ModelInfo[]>('ai_list_models');
  const key = browserKey();
  if (!key) throw new AiError('missing-key', 'Aucune clé API Gemini enregistrée.');
  return listModelsWith(key);
}

/* ------------------------------------------------------------------ *
 * Browser host — direct calls
 * ------------------------------------------------------------------ */

/** Google's error envelope, mapped onto the same kinds Rust produces. */
function browserFailure(status: number, body: string): AiError {
  let detail = '';
  try {
    detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? '';
  } catch {
    /* a non-JSON body is still a failure, just an unexplained one */
  }
  const say = (sentence: string) => (detail ? `${sentence} (${detail})` : sentence);

  if (status === 400 && /API_KEY_INVALID|API key not valid/.test(body)) {
    return new AiError('invalid-key', say('Clé API refusée par Google.'), status);
  }
  if (status === 401) return new AiError('invalid-key', say('Clé API manquante ou invalide.'), status);
  if (status === 403) {
    return new AiError('invalid-key', say("Accès refusé — l'API n'est pas activée pour cette clé."), status);
  }
  if (status === 404) return new AiError('request', say('Modèle introuvable.'), status);
  if (status === 429) return new AiError('rate-limit', say('Quota atteint.'), status);
  if (status >= 500) {
    return new AiError('server', say('Le service Gemini est momentanément indisponible.'), status);
  }
  return new AiError('request', say("L'API Gemini a renvoyé une erreur."), status);
}

async function listModelsWith(key: string): Promise<ModelInfo[]> {
  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': key },
    });
  } catch (error) {
    throw new AiError('network', `Réseau indisponible : ${(error as Error).message}`);
  }
  if (!response.ok) throw browserFailure(response.status, await response.text());

  const body = (await response.json()) as {
    models?: {
      name: string;
      displayName?: string;
      description?: string;
      inputTokenLimit?: number;
      supportedGenerationMethods?: string[];
    }[];
  };

  return (body.models ?? [])
    .filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
    .map((model) => {
      const id = model.name.replace(/^models\//, '');
      return {
        id,
        label: model.displayName ?? id,
        description: model.description ?? null,
        inputTokenLimit: model.inputTokenLimit ?? null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

export interface GenerateResult {
  text: string;
  finishReason: string | null;
  usage: GenerateUsage;
  /** The model that actually answered — not always the one asked for. */
  model: string;
}

interface RustOutcome {
  text: string;
  finishReason: string | null;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  attempts: number;
}

export interface GenerateOptions {
  signal?: AbortSignal;
  /**
   * How long to wait for one attempt.
   *
   * There is no sensible shared value: a chat turn that has not answered in
   * ninety seconds never will, while an hour of audio genuinely takes minutes.
   * Callers state their own budget so a stalled request fails while the user is
   * still watching, rather than several minutes later.
   */
  timeoutSecs?: number;
  /** Models to try, in order, when the chosen one has no quota left. */
  fallbacks?: string[];
  /** Called before each switch, so the panel can say what happened. */
  onFallback?(from: string, to: string, reason: string): void;
}

/**
 * Session-wide listener for model switches.
 *
 * A subscription rather than a parameter because the three callers — chat,
 * transcription, filler detection — sit at different depths, and threading a
 * callback through all of them to reach the one place that can show it would be
 * plumbing for its own sake. Mirrors `onRetry` just below.
 */
let fallbackListener: ((from: string, to: string, reason: string) => void) | null = null;

export function onModelFallback(
  handler: (from: string, to: string, reason: string) => void,
): () => void {
  fallbackListener = handler;
  return () => {
    if (fallbackListener === handler) fallbackListener = null;
  };
}

/**
 * One `generateContent` round trip.
 *
 * `body` is the whole request minus the key, composed by the caller. Keeping
 * the shape here rather than in Rust means a schema change is a TypeScript
 * change, and the schemas live next to the code that parses what comes back.
 *
 * `signal` does not stop the desktop request — nothing can, once it is with
 * Google — but it stops the *answer* from being used, which is what a user
 * pressing "arrêter" actually means.
 */
export async function generate(
  model: string,
  body: Record<string, unknown>,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const { signal, timeoutSecs, fallbacks = [], onFallback } = options;

  // The chosen model first, then the alternates — deduplicated, because a
  // fallback list that repeats the primary would spend a second refusal on it.
  const chain = [model, ...fallbacks].filter(
    (candidate, index, all) => candidate.trim() !== '' && all.indexOf(candidate) === index,
  );

  let last: AiError | null = null;
  for (let index = 0; index < chain.length; index += 1) {
    const candidate = chain[index] as string;
    if (signal?.aborted) throw new AiError('cancelled', 'Requête annulée.');

    try {
      const result = isTauri()
        ? await generateNative(candidate, body, timeoutSecs)
        : await generateBrowser(candidate, body, signal, timeoutSecs);
      if (signal?.aborted) throw new AiError('cancelled', 'Requête annulée.');
      return { ...result, model: candidate };
    } catch (error) {
      const failure = toAiError(error);
      const next = chain[index + 1];

      /*
       * Only an exhausted quota is worth trying a different model for.
       *
       * Quotas are counted per model, so the next one starts from a clean
       * allowance and the switch is genuinely free. Everything else — a refused
       * key, a malformed request, a network that is down — would fail exactly
       * the same way on every model in the list, and walking the chain would
       * only multiply the wait before saying so.
       */
      if (failure.kind !== 'quota' || next === undefined) throw failure;

      onFallback?.(candidate, next, failure.message);
      fallbackListener?.(candidate, next, failure.message);
      last = failure;
    }
  }

  throw last ?? new AiError('request', 'Aucun modèle disponible.');
}

type Answer = Omit<GenerateResult, 'model'>;

async function generateNative(
  model: string,
  body: Record<string, unknown>,
  timeoutSecs?: number,
): Promise<Answer> {
  const outcome = await invoke<RustOutcome>('ai_generate', { model, body, timeoutSecs });
  return {
    text: outcome.text,
    finishReason: outcome.finishReason,
    usage: {
      promptTokens: outcome.promptTokens,
      outputTokens: outcome.outputTokens,
      totalTokens: outcome.totalTokens,
      attempts: outcome.attempts,
    },
  };
}

interface CandidatePart {
  text?: string;
  thought?: boolean;
}

async function generateBrowser(
  model: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutSecs?: number,
): Promise<Answer> {
  const key = browserKey();
  if (!key) throw new AiError('missing-key', 'Aucune clé API Gemini enregistrée.');

  // The deadline and the user's own cancel share one controller, so whichever
  // fires first stops the fetch — and `expired` is what tells them apart after.
  const controller = new AbortController();
  let expired = false;
  const budget = Math.max(5, timeoutSecs ?? 120);
  const deadline = setTimeout(() => {
    expired = true;
    controller.abort();
  }, budget * 1000);
  const relay = () => controller.abort();
  signal?.addEventListener('abort', relay);

  const id = model.trim().replace(/^models\//, '');
  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}/models/${id}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw expired
        ? new AiError('network', `Aucune réponse après ${budget} s.`)
        : new AiError('cancelled', 'Requête annulée.');
    }
    throw new AiError('network', `Réseau indisponible : ${(error as Error).message}`);
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', relay);
  }

  if (!response.ok) throw browserFailure(response.status, await response.text());

  const payload = (await response.json()) as {
    candidates?: { content?: { parts?: CandidatePart[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };

  if (payload.promptFeedback?.blockReason) {
    throw new AiError(
      'blocked',
      `Requête bloquée par les filtres de sécurité (${payload.promptFeedback.blockReason}).`,
    );
  }

  const candidate = payload.candidates?.[0];
  // Thinking models return their reasoning as parts flagged `thought`; those
  // are not the answer and must not be concatenated into it.
  const text = (candidate?.content?.parts ?? [])
    .filter((part) => part.thought !== true)
    .map((part) => part.text ?? '')
    .join('');

  if (!text.trim()) {
    const reason = candidate?.finishReason;
    if (reason === 'SAFETY' || reason === 'RECITATION' || reason === 'PROHIBITED_CONTENT') {
      throw new AiError('blocked', 'Réponse bloquée par les filtres de sécurité de Gemini.');
    }
    if (reason === 'MAX_TOKENS') {
      throw new AiError('format', 'Réponse tronquée — réduisez le contexte envoyé.');
    }
    throw new AiError('format', 'Gemini a renvoyé une réponse vide.');
  }

  return {
    text,
    finishReason: candidate?.finishReason ?? null,
    usage: {
      promptTokens: payload.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
      totalTokens: payload.usageMetadata?.totalTokenCount ?? 0,
      attempts: 1,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Audio
 * ------------------------------------------------------------------ */

export interface AudioExcerpt {
  /** Base64, ready for an `inlineData` part. */
  data: string;
  mimeType: string;
  bytes: number;
  /**
   * Source time the excerpt begins at. Under Tauri this is the in-point we
   * asked ffmpeg for; in the browser the whole file is sent, so it is 0 — and
   * segment timings have to be shifted accordingly. Callers must use this
   * rather than assuming.
   */
  sourceStart: number;
  codec: string;
}

interface RustExcerpt {
  data: string;
  mimeType: string;
  bytes: number;
  duration: number;
  codec: string;
}

/** Gemini takes 20 MB of inline payload; base64 costs a third on top. */
const MAX_BROWSER_BYTES = 13 * 1024 * 1024;

/**
 * A compressed mono excerpt of a media file's audio.
 *
 * The desktop path transcodes the requested window to 16 kHz mono Opus, which
 * is roughly a hundredth of the source and loses nothing a transcriber needs.
 * The browser path has no transcoder, so it posts the file as it is — fine for
 * a voice-over, refused for a feature-length master.
 */
export async function audioExcerpt(
  source: { path: string | null; src: string; name: string },
  sourceStart: number,
  duration: number,
): Promise<AudioExcerpt> {
  if (isTauri()) {
    if (!source.path) {
      throw new AiError('io', `« ${source.name} » n'a pas de fichier sur le disque.`);
    }
    const excerpt = await invoke<RustExcerpt>('ai_audio_excerpt', {
      path: source.path,
      start: sourceStart,
      duration,
    });
    return { ...excerpt, sourceStart };
  }

  let bytes: ArrayBuffer;
  try {
    const response = await fetch(source.src);
    if (!response.ok) throw new Error(`réponse ${response.status}`);
    bytes = await response.arrayBuffer();
  } catch (error) {
    throw new AiError('io', `Lecture de « ${source.name} » impossible : ${(error as Error).message}`);
  }

  if (bytes.byteLength > MAX_BROWSER_BYTES) {
    throw new AiError(
      'unsupported',
      `« ${source.name} » fait ${Math.round(bytes.byteLength / 1e6)} Mo. Sans ffmpeg, le navigateur envoie le fichier entier — utilisez l'application desktop pour ce média.`,
    );
  }

  return {
    data: base64Of(bytes),
    mimeType: mimeOf(source.name),
    bytes: bytes.byteLength,
    // No transcoder means no trimming: the model hears the file from its start.
    sourceStart: 0,
    codec: 'source',
  };
}

/** Chunked so a large buffer cannot blow the argument limit of `fromCharCode`. */
function base64Of(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  const size = 0x8000;
  let binary = '';
  for (let index = 0; index < view.length; index += size) {
    binary += String.fromCharCode(...view.subarray(index, index + size));
  }
  return btoa(binary);
}

const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mp3',
  m4a: 'audio/aac',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  aiff: 'audio/aiff',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

function mimeOf(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[extension] ?? 'audio/mp3';
}

/**
 * The loudness curve silence detection reads.
 *
 * Desktop only — it decodes raw PCM through ffmpeg, which is what makes the
 * result deterministic. The browser host falls back to the waveform the media
 * pool already extracted; see `lib/ai/silence.ts`.
 */
export async function audioEnvelope(
  path: string | null,
  sourceStart: number,
  duration: number,
  bucketsPerSecond = 50,
): Promise<LoudnessEnvelope> {
  if (!isTauri()) {
    throw new AiError('unsupported', "L'analyse audio native demande l'application desktop.");
  }
  if (!path) throw new AiError('io', "Ce média n'a pas de fichier sur le disque.");
  return invoke<LoudnessEnvelope>('ai_audio_envelope', {
    path,
    start: sourceStart,
    duration,
    bucketsPerSecond,
  });
}

/* ------------------------------------------------------------------ *
 * Progress
 * ------------------------------------------------------------------ */

export interface RetryNotice {
  /** The attempt about to start, 1-based. */
  attempt: number;
  total: number;
  reason: string;
  /** Seconds being waited before this attempt. */
  delay: number;
}

/**
 * Subscribes to the retry notices the Rust client emits between attempts.
 *
 * Without them, a transport failure being retried twice looks exactly like a
 * request that is simply slow — which is how three short connect failures added
 * up to one unexplained minute of "Réflexion…". Returns an unsubscribe function;
 * in the browser host there is nothing to listen to and it is a no-op.
 */
export async function onRetry(handler: (notice: RetryNotice) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<RetryNotice>('veglass://ai-progress', (event) => handler(event.payload));
}
