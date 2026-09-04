import { uid } from './id';
import { isTauri } from './env';
import { kindFromName, type MediaAsset, type MediaKind, type SerializedAsset } from '@/types/media';

interface Probe {
  duration: number;
  width: number | null;
  height: number | null;
}

/** Read intrinsic metadata by letting the platform decoder open the file. */
export function probeMedia(src: string, kind: MediaKind): Promise<Probe> {
  return new Promise((resolve) => {
    const fallback: Probe = { duration: 0, width: null, height: null };
    const settle = (probe: Probe) => {
      clearTimeout(timer);
      resolve(probe);
    };
    const timer = setTimeout(() => settle(fallback), 12_000);

    if (kind === 'image') {
      const img = new Image();
      img.onload = () => settle({ duration: 0, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => settle(fallback);
      img.src = src;
      return;
    }

    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () => {
      const media = el as HTMLVideoElement;
      settle({
        duration: Number.isFinite(el.duration) ? el.duration : 0,
        width: kind === 'video' ? media.videoWidth || null : null,
        height: kind === 'video' ? media.videoHeight || null : null,
      });
    };
    el.onerror = () => settle(fallback);
    el.src = src;
  });
}

/**
 * Grab a poster frame ~12% into the clip. Returns null when the canvas is
 * tainted (Tauri serves media from a different origin), and the UI falls back
 * to a typographic placeholder.
 */
export function captureThumbnail(src: string, atRatio = 0.12): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 10_000);

    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'auto';

    video.onloadeddata = () => {
      const target = Math.min(Math.max(video.duration * atRatio, 0.05), Math.max(video.duration - 0.05, 0.05));
      if (Number.isFinite(target)) video.currentTime = target;
      else finish(null);
    };

    video.onseeked = () => {
      try {
        const width = 320;
        const ratio = video.videoWidth ? video.videoHeight / video.videoWidth : 9 / 16;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = Math.round(width * ratio);
        const ctx = canvas.getContext('2d');
        if (!ctx) return finish(null);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', 0.72));
      } catch {
        finish(null);
      }
    };

    video.onerror = () => finish(null);
    video.src = src;
  });
}

const MAX_WAVEFORM_BYTES = 200 * 1024 * 1024;
/**
 * Buckets per second of audio.
 *
 * A *fixed* bucket count was the flaw in the previous version: spread over a
 * long file it left a handful of buckets per clip, so a trimmed clip drew a
 * near-flat line carrying no information. Resolution has to follow duration.
 */
const BUCKETS_PER_SECOND = 120;
const MAX_BUCKETS = 40_000;

export interface Waveform {
  /** Loudest sample of each bucket, 0 → 1. */
  peaks: number[];
  /** Average energy of each bucket — the solid body of the drawing. */
  rms: number[];
}

/**
 * Envelope of a sound file, at a resolution that survives zooming in.
 *
 * Peaks and RMS are kept apart because they say different things: peaks show
 * transients, RMS shows perceived loudness. Drawing only the first gives spiky
 * noise, only the second a shapeless blob.
 */
async function readBytes(src: string, path: string | null): Promise<ArrayBuffer> {
  // Prefer the disk. `fetch` over the asset protocol is subject to the
  // webview's cross-origin rules and fails silently when they say no — which
  // is exactly how a waveform goes missing with nothing in the console.
  if (path && isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<ArrayBuffer>('read_media_bytes', { path });
  }
  const response = await fetch(src);
  if (!response.ok) throw new Error(`réponse ${response.status}`);
  return response.arrayBuffer();
}

export async function extractWaveform(
  asset: Pick<MediaAsset, 'src' | 'path' | 'name'>,
  duration = 0,
): Promise<Waveform | null> {
  try {
    const raw = await readBytes(asset.src, asset.path);
    if (raw.byteLength > MAX_WAVEFORM_BYTES) {
      throw new Error(`fichier trop volumineux (${Math.round(raw.byteLength / 1e6)} Mo)`);
    }

    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio indisponible');

    const ctx = new Ctor();
    const buffer = await ctx.decodeAudioData(raw);
    void ctx.close();

    const seconds = duration > 0 ? duration : buffer.duration;
    const buckets = Math.max(
      64,
      Math.min(MAX_BUCKETS, Math.round(seconds * BUCKETS_PER_SECOND)),
    );

    // Both channels folded together: a timeline waveform is a mono summary.
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    const step = Math.max(1, Math.floor(left.length / buckets));

    const peaks: number[] = [];
    const rms: number[] = [];
    let ceiling = 0;

    for (let index = 0; index < buckets; index += 1) {
      const from = index * step;
      const to = Math.min(from + step, left.length);
      let peak = 0;
      let energy = 0;
      let counted = 0;

      for (let i = from; i < to; i += 1) {
        const sample = right
          ? ((left[i] ?? 0) + (right[i] ?? 0)) / 2
          : (left[i] ?? 0);
        const magnitude = Math.abs(sample);
        if (magnitude > peak) peak = magnitude;
        energy += sample * sample;
        counted += 1;
      }

      peaks.push(peak);
      rms.push(counted > 0 ? Math.sqrt(energy / counted) : 0);
      if (peak > ceiling) ceiling = peak;
    }

    // A file that decodes to pure silence has a waveform: a flat one.
    if (ceiling <= 0) return { peaks: peaks.map(() => 0), rms: rms.map(() => 0) };
    // Normalised against the file's own ceiling, so quiet material is still
    // legible — the timeline shows shape, the meters show level.
    return {
      peaks: peaks.map((value) => value / ceiling),
      rms: rms.map((value) => Math.min(1, value / ceiling)),
    };
  } catch (error) {
    console.error(`waveform failed for ${asset.name}:`, error);
    return null;
  }
}

/** Turn an absolute disk path into a URL the webview is allowed to play. */
export async function pathToSrc(path: string): Promise<string> {
  if (!isTauri()) return path;
  const { convertFileSrc } = await import('@tauri-apps/api/core');
  return convertFileSrc(path);
}

export const baseName = (path: string): string =>
  path.split(/[\/]/).pop() ?? path;

export function assetFromFile(file: File): MediaAsset {
  const kind = kindFromName(file.name, file.type);
  return {
    id: uid('as'),
    name: file.name,
    kind,
    src: URL.createObjectURL(file),
    path: null,
    duration: 0,
    width: null,
    height: null,
    size: file.size,
    addedAt: Date.now(),
  };
}

export async function assetFromPath(path: string): Promise<MediaAsset> {
  const name = baseName(path);
  return {
    id: uid('as'),
    name,
    kind: kindFromName(name),
    src: await pathToSrc(path),
    path,
    duration: 0,
    width: null,
    height: null,
    size: null,
    addedAt: Date.now(),
  };
}

/** Rebuild playable assets when a project is reopened. */
export async function rehydrateAssets(serialized: SerializedAsset[]): Promise<MediaAsset[]> {
  return Promise.all(
    serialized.map(async (asset) => {
      if (!asset.path) return { ...asset, src: '', missing: true } satisfies MediaAsset;
      return { ...asset, src: await pathToSrc(asset.path), missing: false } satisfies MediaAsset;
    }),
  );
}

export const serializeAsset = (asset: MediaAsset): SerializedAsset => ({
  id: asset.id,
  name: asset.name,
  kind: asset.kind,
  path: asset.path,
  duration: asset.duration,
  width: asset.width,
  height: asset.height,
  size: asset.size,
  addedAt: asset.addedAt,
});
