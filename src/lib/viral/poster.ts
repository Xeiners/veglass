/**
 * A thumbnail for a proposed cut.
 *
 * Under Tauri this is `ai_poster`, which drives ffmpeg and works on anything
 * ffmpeg can open. In a browser there is no path and no ffmpeg, so it falls
 * back to seeking a detached `<video>` and reading one frame off a canvas —
 * which only works for codecs the browser itself decodes, and is therefore a
 * fallback rather than the implementation.
 *
 * Either way a failure is not an error worth interrupting anyone for: the card
 * shows its title and its timings, and simply has no picture.
 */

import { isTauri } from '@/lib/env';
import type { MediaAsset } from '@/types/media';

/** Wide enough to read a face on a card, small enough to send ten of them. */
export const POSTER_WIDTH = 320;

/**
 * Wide enough to *read* an interface.
 *
 * The tutorial generator shows these frames to a model and asks it where a
 * button is; at card width the labels are unreadable and the answers are
 * guesses. Rust clamps anything past 960, which is also about where the payload
 * stops being worth the extra pixels.
 */
export const READABLE_WIDTH = 768;

interface RustPoster {
  data: string;
  mimeType: string;
  width: number;
}

/** How long the browser fallback waits for a seek before giving up. */
const SEEK_TIMEOUT = 6000;

async function nativePoster(path: string, at: number, width: number): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  const poster = await invoke<RustPoster>('ai_poster', { path, at, width });
  return `data:${poster.mimeType};base64,${poster.data}`;
}

function browserPoster(src: string, at: number, width: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'metadata';

    let settled = false;
    const done = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      outcome();
    };

    const timer = window.setTimeout(
      () => done(() => reject(new Error('délai dépassé'))),
      SEEK_TIMEOUT,
    );

    video.addEventListener('loadedmetadata', () => {
      // Seeking past the end never fires `seeked`, which is what the timeout
      // above is really guarding against.
      video.currentTime = Math.min(Math.max(0, at), Math.max(0, video.duration - 0.1));
    });

    video.addEventListener('seeked', () => {
      const ratio = video.videoWidth > 0 ? video.videoHeight / video.videoWidth : 9 / 16;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = Math.max(1, Math.round(width * ratio));

      const context = canvas.getContext('2d');
      if (!context) {
        done(() => reject(new Error('canvas indisponible')));
        return;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        const url = canvas.toDataURL('image/jpeg', 0.72);
        done(() => resolve(url));
      } catch (error) {
        // A tainted canvas — the frame is there but cannot be read back.
        done(() => reject(error instanceof Error ? error : new Error('image illisible')));
      }
    });

    video.addEventListener('error', () => done(() => reject(new Error('lecture impossible'))));

    video.src = src;
  });
}

/** One frame of `asset`, `at` seconds in, as a `data:` URI. */
export async function poster(
  asset: MediaAsset,
  at: number,
  width = POSTER_WIDTH,
): Promise<string> {
  if (isTauri() && asset.path) return nativePoster(asset.path, at, width);
  if (asset.src) return browserPoster(asset.src, at, width);
  throw new Error('média introuvable');
}
