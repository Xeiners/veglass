import { effectDescriptor } from '@/types/effects';
import { isClipChannel, parseBackgroundChannel, parseEffectChannel } from '@/types/animation';
import type { Clip } from '@/types/timeline';

const CLIP_LABELS: Record<string, string> = {
  x: 'Position X',
  y: 'Position Y',
  scale: 'Échelle',
  rotation: 'Rotation',
  opacity: 'Opacité',
  volume: 'Volume',
};

const BACKGROUND_LABELS: Record<string, string> = {
  speed: 'Fond · Vitesse',
  scale: 'Fond · Taille',
  intensity: 'Fond · Intensité',
};

/** Human name for an animation channel, resolved against the clip it belongs to. */
export function channelLabel(clip: Clip, channel: string): string {
  if (isClipChannel(channel)) return CLIP_LABELS[channel] ?? channel;

  const background = parseBackgroundChannel(channel);
  if (background) return BACKGROUND_LABELS[background] ?? channel;

  const parsed = parseEffectChannel(channel);
  if (!parsed) return channel;

  const effect = clip.effects.find((item) => item.id === parsed.effectId);
  if (!effect) return channel;

  const descriptor = effectDescriptor(effect.kind);
  const spec = descriptor.params.find((item) => item.key === parsed.key);
  return spec ? `${descriptor.label} · ${spec.label}` : descriptor.label;
}

/** Channels in a stable, readable order: transform first, filters after. */
export function orderedChannels(clip: Clip): string[] {
  const all = Object.keys(clip.animation ?? {});
  const rank = (channel: string) => {
    const index = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'].indexOf(channel);
    if (index !== -1) return index;
    // Background parameters sit between the transform and the filter stack:
    // they belong to the layer itself, not to a filter applied over it.
    return channel.startsWith('bg:') ? 50 : 100;
  };
  return all.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
