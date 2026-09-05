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
/**
 * A partial colour inversion, as a lookup table.
 *
 * CSS defines `invert(a)` as the straight line `out = in·(1−2a) + a` over the
 * 0 → 1 range; `lutrgb` evaluates the identical line over 0 → `maxval`, per
 * channel, in RGB. The preview's filter and the encoder's are therefore the
 * same function rather than an approximation of one another.
 *
 * The twin of `engine::effects::invert_filter`, and it has to match character
 * for character — see the Rust test that pins the string.
 */
export function invertFilter(amount: number): string {
  const ramp = `val*(${(1 - 2 * amount).toFixed(3)})+(${amount.toFixed(3)})*maxval`;
  return `lutrgb=r=${ramp}:g=${ramp}:b=${ramp}`;
}

/**
 * The channel offsets a chromatic split asks the encoder for.
 *
 * `rgbashift` counts in whole pixels, so the amount is rounded here rather than
 * left to the option parser — the viewer rounds to the same integers, and a
 * value only one of them rounds is a value the two disagree about.
 *
 * The signs were checked against the binary: `rh=+10` moves the red channel ten
 * pixels to the **right** and `rv=+8` moves it eight **down**, which is exactly
 * what SVG's `feOffset dx dy` does. Blue takes the opposite of both.
 *
 * `edge=smear` holds the border pixel out to the frame edge instead of leaving
 * the strip the shift uncovered transparent. It is the closest thing the
 * encoder has to what the viewer does with a filter region that reaches past
 * the layer, and it is the one that does not put a coloured band down the side
 * of the picture.
 */
export function rgbSplitFilter(amount: number, angle: number): string | null {
  const radians = (angle * Math.PI) / 180;
  const dx = Math.round(amount * Math.cos(radians));
  const dy = Math.round(amount * Math.sin(radians));
  if (dx === 0 && dy === 0) return null;
  return `rgbashift=rh=${dx}:rv=${dy}:bh=${-dx}:bv=${-dy}:edge=smear`;
}

/**
 * A Gaussian blurred along one axis.
 *
 * `sigma` is horizontal and `sigmaV` vertical, both standard deviations in
 * pixels — the same two numbers SVG's `stdDeviation="x y"` takes. Passing
 * `sigmaV` explicitly is not optional: left out it defaults to -1, which means
 * "the same as sigma", and the directional blur would come back isotropic.
 *
 * `steps=2` matches the backdrop's blur: one pass of a box approximation is
 * visibly boxy at the deviations an impact smear uses.
 */
export function motionBlurFilter(amount: number, angle: number): string | null {
  const radians = (angle * Math.PI) / 180;
  const x = amount * Math.abs(Math.cos(radians));
  const y = amount * Math.abs(Math.sin(radians));
  if (x < 0.05 && y < 0.05) return null;
  return `gblur=sigma=${x.toFixed(2)}:sigmaV=${y.toFixed(2)}:steps=2`;
}

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
      case 'invert': {
        const amount = p.amount ?? 0;
        if (amount > 0) filters.push(invertFilter(amount));
        break;
      }
      case 'rgbsplit': {
        const filter = rgbSplitFilter(p.amount ?? 0, p.angle ?? 0);
        if (filter) filters.push(filter);
        break;
      }
      case 'motionblur': {
        const filter = motionBlurFilter(p.amount ?? 0, p.angle ?? 0);
        if (filter) filters.push(filter);
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
