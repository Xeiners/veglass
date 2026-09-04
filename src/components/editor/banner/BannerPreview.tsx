import { useEffect, useMemo, useRef } from 'react';

import { measureBanner, paintBanner } from '@/lib/bannerPainter';
import type { BannerLayer } from '@/types/banner';
import { DEFAULT_SETTINGS, type ProjectSettings } from '@/types/project';

/**
 * A banner, drawn small.
 *
 * Used by the template picker and by the inspector, and in both cases the point
 * is that it is not a *mock-up*: it runs `paintBanner`, the same function the
 * viewer and the export bake run. A picker showing hand-drawn approximations of
 * three templates would be three more things to keep in step with the painter,
 * and the first place a design change would be forgotten.
 *
 * The banner is measured against a real frame and then scaled down to fit the
 * card, rather than being measured against the card — so the proportions on a
 * 96-pixel-tall thumbnail are the proportions of the finished 1080p banner.
 */
export function BannerPreview({
  layer,
  width,
  height,
  settings = DEFAULT_SETTINGS,
  className,
}: {
  layer: BannerLayer;
  /** Box to draw inside, in CSS pixels. */
  width: number;
  height: number;
  /** The frame the banner sizes itself against. */
  settings?: ProjectSettings;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const metrics = useMemo(() => measureBanner(layer, settings), [layer, settings]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) return;

    const density = Math.min(window.devicePixelRatio || 1, 2);
    const backing = {
      width: Math.max(1, Math.round(width * density)),
      height: Math.max(1, Math.round(height * density)),
    };
    if (canvas.width !== backing.width || canvas.height !== backing.height) {
      canvas.width = backing.width;
      canvas.height = backing.height;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, backing.width, backing.height);

    // Fit, with a little air: a card whose banner touches both edges reads as
    // cropped rather than as a preview.
    const fit = Math.min(
      (width * 0.92) / Math.max(1, metrics.width),
      (height * 0.82) / Math.max(1, metrics.height),
    );

    ctx.save();
    ctx.translate(backing.width / 2, backing.height / 2);
    ctx.scale(fit * density, fit * density);
    paintBanner(ctx, layer, settings, metrics);
    ctx.restore();
  }, [layer, settings, metrics, width, height]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width, height }}
      aria-label={`Aperçu : ${layer.title}`}
      role="img"
    />
  );
}
