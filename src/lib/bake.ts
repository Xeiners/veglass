import { isTauri } from './env';
import { resolveClipAt } from '@/store/selectors';
import { cssFilterFor } from '@/types/effects';
import {
  TEXT_PADDING_X,
  TEXT_PADDING_Y,
  fontOption,
  hasBox,
  textBox,
  withAlpha,
  type TextLayer,
} from '@/types/text';
import { backgroundPhase, paintBackground } from './backgroundPainter';
import { paintBanner } from './bannerPainter';
import { paintCursor } from './cursorPainter';
import type { ProjectSettings } from '@/types/project';
import { isContinuous, isGenerated, type Clip } from '@/types/timeline';
import type { MediaAsset } from '@/types/media';

/**
 * Rasterising layers ffmpeg cannot draw itself.
 *
 * Text is the reason this exists. `drawtext` needs a font *file*, escapes
 * badly, and would never quite match the webview's own typography — so the
 * webview draws the layer instead, at the project's native resolution, with the
 * transform and the effect chain already applied. What ffmpeg receives is a
 * plain transparent PNG it overlays at 0,0, which makes the export identical to
 * the preview by construction rather than by approximation.
 *
 * SVG takes the same road: most ffmpeg builds have no vector decoder.
 */

export interface BakedLayer {
  clipId: string;
  path: string;
}

/**
 * Ceiling on a rasterised sequence.
 *
 * At 30 fps this is two minutes of animated title — well past anything sane,
 * and low enough that a mistake cannot fill the disk.
 */
export const MAX_SEQUENCE_FRAMES = 3600;

const isSvg = (asset: MediaAsset): boolean => /\.svg$/i.test(asset.name);

/** Clips whose pixels must be produced by the front-end. */
export function clipsNeedingBake(
  clips: Clip[],
  assets: MediaAsset[],
): { clip: Clip; asset: MediaAsset | null }[] {
  return clips
    .map((clip) => {
      // A generated layer has no source file: its pixels come from the same
      // canvas that draws it in the viewer.
      if (isGenerated(clip)) return { clip, asset: null };
      const asset = assets.find((item) => item.id === clip.assetId) ?? null;
      return asset && isSvg(asset) ? { clip, asset } : null;
    })
    .filter((entry): entry is { clip: Clip; asset: MediaAsset | null } => entry !== null);
}

function applyTransform(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  settings: ProjectSettings,
): void {
  ctx.translate(settings.width / 2 + clip.x, settings.height / 2 + clip.y);
  if (clip.rotation) ctx.rotate((clip.rotation * Math.PI) / 180);
  if (clip.scale !== 1) ctx.scale(clip.scale, clip.scale);
}

/** Wraps on explicit newlines only — the preview does the same. */
function linesOf(layer: TextLayer): string[] {
  return (layer.content || '').split('\n');
}

function drawText(ctx: CanvasRenderingContext2D, layer: TextLayer): void {
  const family = fontOption(layer.fontFamily).stack;
  const style = layer.italic ? 'italic ' : '';
  ctx.font = `${style}${layer.fontWeight} ${layer.fontSize}px ${family}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = layer.align === 'left' ? 'left' : layer.align === 'right' ? 'right' : 'center';
  if ('letterSpacing' in ctx) {
    // Supported in Chromium, which is the only engine we render in.
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
      `${layer.letterSpacing}em`;
  }

  const lines = linesOf(layer);
  const step = layer.fontSize * layer.lineHeight;
  const first = -((lines.length - 1) * step) / 2;

  // The plate, before anything else and before the shadow is armed: it is the
  // surface the text sits on, not another thing casting one. Its rectangle is
  // the preview's shrink-wrapped box — widest line by total line height, plus
  // the padding both sides share.
  const box = textBox(layer);
  if (hasBox(box)) {
    const widest = lines.reduce((widest, line) => Math.max(widest, ctx.measureText(line).width), 0);
    const width = widest + 2 * (TEXT_PADDING_X + box.paddingX);
    const height = lines.length * step + 2 * (TEXT_PADDING_Y + box.paddingY);
    const radius = Math.min(box.radius, width / 2, height / 2);

    ctx.save();
    ctx.fillStyle = withAlpha(box.color, box.opacity);
    ctx.beginPath();
    // `roundRect` is recent enough that an older engine would throw here and
    // take the whole export down with it. Square corners are a worse plate,
    // not a broken one.
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(-width / 2, -height / 2, width, height, radius);
    } else {
      ctx.rect(-width / 2, -height / 2, width, height);
    }
    ctx.fill();
    ctx.restore();
  }

  if (layer.shadow.opacity > 0) {
    ctx.shadowColor = withAlpha(layer.shadow.color, layer.shadow.opacity);
    ctx.shadowBlur = layer.shadow.blur;
    ctx.shadowOffsetX = layer.shadow.offsetX;
    ctx.shadowOffsetY = layer.shadow.offsetY;
  }

  lines.forEach((line, index) => {
    const y = first + index * step;
    // Stroke first so it sits behind the fill, matching `paint-order: stroke`.
    if (layer.stroke.width > 0) {
      ctx.lineWidth = layer.stroke.width * 2;
      ctx.strokeStyle = layer.stroke.color;
      ctx.lineJoin = 'round';
      ctx.strokeText(line, 0, y);
    }
    ctx.fillStyle = layer.color;
    ctx.fillText(line, 0, y);
    // The shadow is drawn once, with the first pass.
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Image illisible'));
    image.src = src;
  });
}

/** Draws one layer onto a transparent frame-sized canvas and returns a PNG. */
export async function bakeLayer(
  clip: Clip,
  asset: MediaAsset | null,
  settings: ProjectSettings,
  /** Seconds since the clip started — only a generated background reads it. */
  at = 0,
): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = settings.width;
  canvas.height = settings.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas indisponible');

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, clip.opacity));

  // The effect chain is the same CSS the preview uses, so both agree.
  const filter = cssFilterFor(clip.effects);
  if (filter) ctx.filter = filter;

  applyTransform(ctx, clip, settings);

  if (clip.kind === 'background' && clip.background) {
    // Drawn before the transform: a background fills the frame, and scaling or
    // rotating it would expose the corners it exists to cover.
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, clip.opacity));
    if (filter) ctx.filter = filter;
    paintBackground(
      ctx,
      clip.background,
      backgroundPhase(clip.background, clip.animation?.['bg:speed'], at),
      settings.width,
      settings.height,
    );
  } else if (clip.kind === 'text' && clip.text) {
    drawText(ctx, clip.text);
  } else if (clip.kind === 'cursor' && clip.cursor) {
    // Drawn under the clip's own transform, which is a *copy* of the screen
    // recording's: that is what puts the pointer on the button rather than
    // beside it once the virtual camera has pushed in. See `types/cursor`.
    paintCursor(ctx, clip.cursor, settings, at);
  } else if (clip.kind === 'banner' && clip.banner) {
    // The same painter the viewer runs, on the same origin — see
    // `lib/bannerPainter` for why a banner is drawn rather than laid out twice.
    paintBanner(ctx, clip.banner, settings);
  } else if (asset?.src) {
    const image = await loadImage(asset.src);
    const width = asset.width ?? image.naturalWidth ?? settings.width;
    const height = asset.height ?? image.naturalHeight ?? settings.height;
    ctx.drawImage(image, -width / 2, -height / 2, width, height);
  }

  ctx.restore();
  return canvas.toDataURL('image/png');
}

const hasAnimation = (clip: Clip): boolean =>
  Object.values(clip.animation ?? {}).some((keyframes) => keyframes.length > 0);

/**
 * Whether a layer has to be baked as a numbered sequence rather than one still.
 *
 * Exported because `lib/renderPlan` describes the same decision and used to
 * state it differently — it called only a moving background a sequence, which
 * made an animated title, and now an animated banner, describe itself as a
 * single frame while this function wrote thirty per second of them.
 *
 * A moving background and a cursor are the cases animation alone would miss:
 * both change every frame whether or not a keyframe says so — see
 * `isContinuous`.
 */
export const bakesAsSequence = (clip: Clip): boolean =>
  hasAnimation(clip) || isContinuous(clip);

/**
 * Bakes every layer that needs it and writes the PNGs to the app cache.
 * Returns the clip-id → path map the render command expects.
 *
 * A still layer becomes one PNG. An *animated* one becomes a numbered sequence,
 * one frame per output frame — which is how a moving title reaches the encoder
 * with its easing intact, given that ffmpeg cannot draw the glyphs itself.
 */
export async function bakeLayers(
  clips: Clip[],
  assets: MediaAsset[],
  settings: ProjectSettings,
  onProgress?: (done: number, total: number) => void,
): Promise<Record<string, string>> {
  const pending = clipsNeedingBake(clips, assets);
  if (pending.length === 0 || !isTauri()) return {};

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('clear_baked_layers').catch(() => undefined);

  const out: Record<string, string> = {};
  let done = 0;

  for (const { clip, asset } of pending) {
    try {
      // A moving background changes every frame whether or not a keyframe says
      // so, which is the one case where the still path would be wrong.
      if (!bakesAsSequence(clip)) {
        const png = await bakeLayer(clip, asset, settings);
        // Clip ids are already `[a-z0-9_]`, which is what the writer accepts.
        out[clip.id] = await invoke<string>('write_baked_layer', {
          key: clip.id,
          pngBase64: png,
        });
      } else {
        const frames = Math.min(
          MAX_SEQUENCE_FRAMES,
          Math.max(1, Math.round(clip.duration * settings.fps)),
        );
        let pattern = '';
        for (let index = 0; index < frames; index += 1) {
          // Evaluated on the timeline, exactly where the viewer would be.
          const at = clip.start + index / settings.fps;
          const png = await bakeLayer(resolveClipAt(clip, at), asset, settings, at - clip.start);
          pattern = await invoke<string>('write_baked_frame', {
            key: clip.id,
            index: index + 1,
            pngBase64: png,
          });
        }
        out[clip.id] = pattern;
      }
    } catch (error) {
      console.error(`bake failed for clip ${clip.id}`, error);
    }
    done += 1;
    onProgress?.(done, pending.length);
  }

  return out;
}
