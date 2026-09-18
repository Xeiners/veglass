import type { Clip } from '@/types/timeline';
import type { MediaAsset } from '@/types/media';

export const FRAMING_CHANNELS = ['scale', 'x', 'y', 'rotation'] as const;

/** Explicit user reset: remove camera curves, keeping audio, opacity and effects. */
export function fitClip(clip: Clip, asset: MediaAsset): Clip {
  if (clip.kind !== 'media' || asset.kind !== 'video') return clip;
  // Video at scale 1 is contained by both renderers, not stretched to cover.
  const { animation, ...rest } = clip;
  const remaining = Object.fromEntries(Object.entries(animation ?? {})
    .filter(([channel]) => !FRAMING_CHANNELS.includes(channel as typeof FRAMING_CHANNELS[number])));
  return { ...rest, scale: 1, x: 0, y: 0, rotation: 0,
    ...(Object.keys(remaining).length ? { animation: remaining } : {}),
  };
}
