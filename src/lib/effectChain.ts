import { isTauri } from './env';
import type { Effect } from '@/types/effects';

export interface EffectChain {
  /** One ffmpeg filter fragment per enabled effect, in order. */
  filters: string[];
  /** The fragments joined into a filtergraph chain. */
  chain: string;
  engine: 'rust' | 'typescript';
}

/**
 * Reference implementation of the effect → ffmpeg mapping.
 *
 * The native engine owns this contract (`src-tauri/src/engine/render.rs`); this
 * twin keeps the browser build honest and documents the expected output. Both
 * must agree — the inspector shows whichever one answered.
 */
export function effectFiltersLocally(effects: Effect[]): string[] {
  const filters: string[] = [];

  for (const effect of effects) {
    if (!effect.enabled) continue;
    const p = effect.params;

    switch (effect.kind) {
      case 'brightness': {
        const amount = p.amount ?? 0;
        if (amount !== 0) filters.push(`eq=brightness=${amount.toFixed(3)}`);
        break;
      }
      case 'contrast': {
        const amount = p.amount ?? 1;
        if (amount !== 1) filters.push(`eq=contrast=${amount.toFixed(3)}`);
        break;
      }
      case 'saturation': {
        const amount = p.amount ?? 1;
        if (amount !== 1) filters.push(`eq=saturation=${amount.toFixed(3)}`);
        break;
      }
      case 'blur': {
        const radius = p.radius ?? 0;
        // CSS blur() takes a radius; ffmpeg's gblur takes a standard deviation.
        if (radius > 0) filters.push(`gblur=sigma=${(radius / 2).toFixed(2)}`);
        break;
      }
      case 'hue': {
        const angle = p.angle ?? 0;
        if (angle !== 0) filters.push(`hue=h=${Math.round(angle)}`);
        break;
      }
      case 'grayscale': {
        const amount = p.amount ?? 0;
        if (amount > 0) filters.push(`hue=s=${(1 - amount).toFixed(3)}`);
        break;
      }
    }
  }

  return filters;
}

export function chainOf(filters: string[]): string {
  return filters.join(',');
}

/** Asks the native engine to map the stack; falls back to the local twin. */
export async function describeEffectChain(effects: Effect[]): Promise<EffectChain> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<EffectChain>('describe_effect_chain', { effects });
    } catch (error) {
      console.error('native effect mapping unavailable, falling back', error);
    }
  }
  const filters = effectFiltersLocally(effects);
  return { filters, chain: chainOf(filters), engine: 'typescript' };
}
