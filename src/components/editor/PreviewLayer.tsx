import { useEffect, useMemo, useRef, useState } from 'react';

import type { PreviewLayerSpec } from '@/store/selectors';
import {
  TEXT_PADDING_X,
  TEXT_PADDING_Y,
  fontOption,
  hasBox,
  shadowCss,
  textBox,
  withAlpha,
  type TextLayer,
} from '@/types/text';
import { backgroundPhase, paintBackground } from '@/lib/backgroundPainter';
import { measureBanner, paintBanner } from '@/lib/bannerPainter';
import { paintCursor, resolvedPath } from '@/lib/cursorPainter';
import { cssBlur, cssShadow, cssTint, backdropZoom } from '@/lib/backdrop';
import { fittedSize } from '@/lib/geometry';
import { filterDefs } from '@/lib/svgFilters';
import { filterChainFor, type SvgFilterSpec } from '@/types/effects';
import type { Backdrop } from '@/types/backdrop';
import type { CursorLayer } from '@/types/cursor';
import type { BackgroundLayer } from '@/types/background';
import type { BannerLayer } from '@/types/banner';
import type { ProjectSettings } from '@/types/project';
import { hasOwnSize } from '@/types/timeline';

/** Beyond this drift (seconds) we hard-seek instead of letting playback catch up. */
const DRIFT_TOLERANCE = 0.18;

export interface LayerGeometry {
  /** Screen pixels per project pixel — the viewer's scale factor. */
  unit: number;
}

/**
 * One layer of the compositor, positioned and transformed inside the frame.
 *
 * The wrapper carries `data-clip-id`, which is what makes click-to-select and
 * the gizmo work: the browser already hit-tests transformed boxes exactly, so
 * there is no geometry to reimplement.
 */
export function PreviewLayer({
  spec,
  unit,
  settings,
  time,
  isPlaying,
  masterVolume,
  masterMuted,
  interactive,
  editing = false,
  onChangeText,
  onExitEdit,
}: {
  spec: PreviewLayerSpec;
  unit: number;
  /** The project frame — a banner sizes itself against it. */
  settings: ProjectSettings;
  /** Timeline position, in seconds — only a generated background reads it. */
  time: number;
  isPlaying: boolean;
  masterVolume: number;
  masterMuted: boolean;
  interactive: boolean;
  /** This layer's text is being typed into, right here on the frame. */
  editing?: boolean;
  onChangeText?(content: string): void;
  onExitEdit?(): void;
}) {
  const { clip, opacity } = spec;

  /*
   * The effect stack, in the viewer's own pixels.
   *
   * Built here rather than in the selector because a filter is **not** scaled
   * by the transform that positions the layer, so a length in project pixels
   * has to be converted by hand — and `unit` is a property of the stage, which
   * a selector over the document has no business knowing. A blur of forty that
   * ignored it would look right on a maximised window and three times too
   * strong on a small one, while the file did something else again.
   */
  const chain = useMemo(
    () => filterChainFor(clip.effects, unit, clip.id),
    [clip.effects, clip.id, unit],
  );
  const filter = chain.css;

  /*
   * The glass, and the frame that floats on it.
   *
   * The backdrop is a sibling of the transformed layer, not a child: it fills
   * the frame whatever the clip does, exactly as the encoder overlays it at
   * 0,0 with no transform of its own. And the picture is drawn at its *fitted*
   * size rather than filling the element, because that is the box ffmpeg rounds
   * the corners of — rounding an element that letterboxes its own content would
   * round the wrong rectangle.
   */
  const backdrop = clip.kind === 'media' ? clip.backdrop : undefined;
  const fit = backdrop && spec.asset ? fittedSize(spec.asset, settings) : null;

  // Video conforms to the frame; titles, banners and stills keep their natural
  // size, which is what makes them behave like overlays and gives the gizmo a
  // real box to grab.
  // A backdropped clip is drawn at its fitted size, so it no longer fills the
  // element — that is what gives the rounded corners a rectangle to round.
  const fillsFrame = !hasOwnSize(clip) && spec.asset?.kind !== 'image' && !fit;

  // A background covers the frame, so it is not moved, scaled or turned: any of
  // those would expose the corners it exists to fill. The export bake skips the
  // transform for the same reason, which is what keeps the two identical.
  const isBackground = clip.kind === 'background';

  const transform = isBackground
    ? ''
    : [
        `translate(${clip.x * unit}px, ${clip.y * unit}px)`,
        clip.rotation ? `rotate(${clip.rotation}deg)` : '',
        clip.scale !== 1 ? `scale(${clip.scale})` : '',
      ]
        .filter(Boolean)
        .join(' ');

  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center">
      <EffectFilters specs={chain.svg} />
      {backdrop && spec.asset && (
        <BackdropContent
          spec={spec}
          backdrop={backdrop}
          unit={unit}
          isPlaying={isPlaying}
          opacity={opacity}
          filter={filter}
        />
      )}
      <div
        data-clip-id={clip.id}
        style={{ transform, opacity, filter, transformOrigin: 'center' }}
        className={[
          fillsFrame ? 'h-full w-full' : '',
          editing
            ? 'pointer-events-auto cursor-text'
            : interactive
              ? 'pointer-events-auto cursor-move'
              : 'pointer-events-none',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {isBackground && clip.background ? (
          <BackgroundContent
            layer={clip.background}
            // The *integral* of the speed, not the clock: see `backgroundPhase`.
            phase={backgroundPhase(clip.background, clip.animation?.['bg:speed'], time - clip.start)}
          />
        ) : clip.kind === 'cursor' && clip.cursor ? (
          <CursorContent
            layer={clip.cursor}
            settings={settings}
            // Clip-relative, the clock the samples and the clicks are stamped in.
            time={time - clip.start}
          />
        ) : clip.kind === 'banner' && clip.banner ? (
          <BannerContent layer={clip.banner} unit={unit} settings={settings} />
        ) : clip.kind === 'text' && clip.text ? (
          <TextContent
            layer={clip.text}
            unit={unit}
            editing={editing}
            onChange={onChangeText}
            onExit={onExitEdit}
          />
        ) : (
          <MediaContent
            spec={spec}
            unit={unit}
            isPlaying={isPlaying}
            masterVolume={masterVolume}
            masterMuted={masterMuted}
            frame={fit}
            radius={backdrop ? backdrop.radius : 0}
            shadow={backdrop ? cssShadow(backdrop.shadow, unit) : undefined}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * A generated background, drawn on a canvas.
 *
 * The backing store is capped well below the project resolution: these are soft
 * gradients with no detail to lose, and rasterising a 4K frame sixty times a
 * second to draw five blurred discs would cost far more than it shows. The
 * export bakes at full resolution through the same painter.
 */
function BackgroundContent({ layer, phase }: { layer: BackgroundLayer; phase: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;

    const factor = Math.min(1, 960 / width);
    const target = { width: Math.round(width * factor), height: Math.round(height * factor) };
    if (canvas.width !== target.width || canvas.height !== target.height) {
      canvas.width = target.width;
      canvas.height = target.height;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    paintBackground(ctx, layer, phase, canvas.width, canvas.height);
  }, [layer, phase]);

  return <canvas ref={canvasRef} className="h-full w-full" />;
}

/**
 * A banner, drawn by the same painter the export uses.
 *
 * Deliberately a canvas rather than a stack of divs. A banner is a plate, a
 * border, an accent bar, two type sizes and a row of keycaps; laying that out
 * in CSS here and drawing it again in `bake.ts` would be two implementations
 * kept in step by hand, which is precisely the arrangement that lets a preview
 * and an export drift apart. One painter means the two agree by construction.
 *
 * The backing store is the on-screen size times the device pixel ratio — unlike
 * the background canvas next door, which caps itself because it draws blurred
 * gradients with no detail to lose. Type has detail to lose.
 */
function BannerContent({
  layer,
  unit,
  settings,
}: {
  layer: BannerLayer;
  unit: number;
  settings: ProjectSettings;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const metrics = useMemo(() => measureBanner(layer, settings), [layer, settings]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Capped at 2: past that the memory cost climbs faster than anything a
    // viewer can see, and a 4K banner on a retina display is a large surface.
    const density = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(metrics.width * unit * density));
    const height = Math.max(1, Math.round(metrics.height * unit * density));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    // Into project pixels, origin at the banner's centre — the space the
    // painter works in, and the same one `bake.ts` hands it.
    ctx.scale(unit * density, unit * density);
    ctx.translate(metrics.width / 2, metrics.height / 2);
    paintBanner(ctx, layer, settings, metrics);
    ctx.restore();
  }, [layer, settings, unit, metrics]);

  return (
    <canvas
      ref={canvasRef}
      className="block"
      style={{ width: metrics.width * unit, height: metrics.height * unit }}
    />
  );
}

/* ------------------------------------------------------------------ */

/**
 * The title as the viewer shows it — and, on a double click, the field you type
 * it in.
 *
 * While editing, the DOM owns the string and the store follows it. The reverse
 * would re-render the element on every keystroke and send the caret back to the
 * start, which is the classic way `contentEditable` goes wrong. Hence children
 * of `null` during the edit and a single imperative seeding when it opens.
 */
function TextContent({
  layer,
  unit,
  editing = false,
  onChange,
  onExit,
}: {
  layer: TextLayer;
  unit: number;
  editing?: boolean;
  onChange?(content: string): void;
  onExit?(): void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!editing) return;
    const node = ref.current;
    if (!node) return;
    node.textContent = layer.content;
    node.focus();
    // The whole title is selected on entry, so typing replaces it — the
    // behaviour of every title tool. One click puts the caret where you clicked.
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    // Deliberately not reacting to `layer.content`: re-seeding mid-edit would
    // fight the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const stroke =
    layer.stroke.width > 0
      ? {
          WebkitTextStrokeWidth: `${layer.stroke.width * unit}px`,
          WebkitTextStrokeColor: layer.stroke.color,
          paintOrder: 'stroke fill',
        }
      : {};

  // The plate. The element already shrink-wraps its text, so a background here
  // is exactly the rectangle `bake.ts` measures and draws for the export.
  const box = textBox(layer);
  const plate = hasBox(box)
    ? { backgroundColor: withAlpha(box.color, box.opacity), borderRadius: `${box.radius * unit}px` }
    : {};

  return (
    <div
      ref={ref}
      contentEditable={editing}
      suppressContentEditableWarning
      spellCheck={false}
      onInput={(event) => onChange?.(event.currentTarget.innerText)}
      onBlur={() => onExit?.()}
      onPointerDown={(event) => {
        // Placing a caret, not dragging the layer around.
        if (editing) event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (!editing) return;
        if (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) {
          event.preventDefault();
          onExit?.();
        }
      }}
      className={editing ? 'rounded-sm outline-none ring-2 ring-accent-300/80' : undefined}
      style={{
        // Everything scales with `unit`, so a 96 px title stays 96 project
        // pixels whatever size the viewer happens to be.
        fontFamily: fontOption(layer.fontFamily).stack,
        fontSize: layer.fontSize * unit,
        fontWeight: layer.fontWeight,
        fontStyle: layer.italic ? 'italic' : 'normal',
        lineHeight: layer.lineHeight,
        letterSpacing: `${layer.letterSpacing}em`,
        color: layer.color,
        textAlign: layer.align,
        textShadow: shadowCss(layer.shadow),
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        padding: `${(TEXT_PADDING_Y + box.paddingY) * unit}px ${(TEXT_PADDING_X + box.paddingX) * unit}px`,
        ...plate,
        ...(editing ? { cursor: 'text', userSelect: 'text' as const } : {}),
        ...stroke,
      }}
    >
      {editing ? null : layer.content || ' '}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The virtual cursor, drawn by the same painter the export bake runs.
 *
 * Frame-sized and untransformed *inside* its layer: the wrapper already carries
 * the clip's transform, which for a cursor clip is a copy of the screen
 * recording's. That is what carries the pointer along when the virtual camera
 * pushes in — see `types/cursor`.
 *
 * The path is smoothed once per layer rather than once per frame. It is a pure
 * function of the samples, so hoisting it out of the paint is free and keeps a
 * sixty-times-a-second redraw from re-filtering a thousand points.
 */
function CursorContent({
  layer,
  settings,
  time,
}: {
  layer: CursorLayer;
  settings: ProjectSettings;
  time: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const path = useMemo(() => resolvedPath(layer), [layer]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;

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
    ctx.save();
    // Into project pixels, origin at the frame centre — the space the painter
    // works in, and the same one `bake.ts` hands it.
    ctx.scale(backing.width / settings.width, backing.height / settings.height);
    ctx.translate(settings.width / 2, settings.height / 2);
    paintCursor(ctx, layer, settings, time, path);
    ctx.restore();
  }, [layer, settings, time, path]);

  return <canvas ref={canvasRef} className="h-full w-full" />;
}

/* ------------------------------------------------------------------ */

/**
 * The blurred copy behind a floating clip.
 *
 * A second element playing the same file, covered rather than contained,
 * magnified past the frame and blurred — the CSS twin of the `scale=…increase`,
 * `gblur`, `crop` chain the encoder builds. `lib/backdrop` owns both spellings
 * of every number so the two cannot drift apart.
 *
 * Its clock is deliberately loose. This copy is blurred past recognition; a
 * frame of drift between it and the picture in front is not observable, and
 * chasing exact sync on a decorative layer would double the seeking work in the
 * viewer for nothing.
 */
/**
 * The SVG filters this layer's stack refers to.
 *
 * Rendered beside the layer rather than in one shared bank at the root, because
 * the numbers change every frame — a chromatic split ramping down over four
 * frames is four different filters — and a bank would have to be rebuilt from
 * the whole document on each of them. Here React updates the attributes of a
 * handful of nodes it already owns, alongside the layer they belong to.
 *
 * The markup comes from `lib/svgFilters` rather than being written as JSX, so
 * the export bake mounts character-for-character the same filters when it draws
 * a generated layer. Two renderers of one filter is how a preview and a file
 * drift apart, which is the whole thing this feature is trying not to do.
 */
function EffectFilters({ specs }: { specs: SvgFilterSpec[] }) {
  const markup = useMemo(() => filterDefs(specs), [specs]);
  if (specs.length === 0) return null;

  return (
    <svg aria-hidden focusable="false" className="pointer-events-none absolute h-0 w-0">
      {/* Generated entirely from numbers we formatted — there is no user text
          anywhere in it, and the ids come from `uid`'s own alphabet. */}
      <defs dangerouslySetInnerHTML={{ __html: markup }} />
    </svg>
  );
}

function BackdropContent({
  spec,
  backdrop,
  unit,
  isPlaying,
  opacity,
  filter,
}: {
  spec: PreviewLayerSpec;
  backdrop: Backdrop;
  unit: number;
  isPlaying: boolean;
  opacity: number;
  filter: string | undefined;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { asset, sourceTime } = spec;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // Always silent: the picture in front already carries the sound, and two
    // elements playing one file would double it.
    video.muted = true;

    if (Number.isFinite(sourceTime) && Math.abs(video.currentTime - sourceTime) > 0.4) {
      try {
        video.currentTime = sourceTime;
      } catch {
        /* the element rejects seeks while loading — corrected next tick */
      }
    }
    if (isPlaying && video.paused) void video.play().catch(() => undefined);
    else if (!isPlaying && !video.paused) video.pause();
  }, [sourceTime, isPlaying]);

  if (!asset?.src) return null;

  const zoom = backdropZoom(backdrop);
  const common = {
    position: 'absolute' as const,
    inset: 0,
    width: '100%',
    height: '100%',
  };

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ opacity, filter }}>
      {asset.kind === 'image' ? (
        <img
          src={asset.src}
          alt=""
          aria-hidden
          draggable={false}
          style={{ ...common, objectFit: 'cover', transform: `scale(${zoom})`, filter: cssBlur(backdrop.blur, unit) }}
        />
      ) : (
        <video
          ref={videoRef}
          src={asset.src}
          playsInline
          preload="auto"
          aria-hidden
          style={{ ...common, objectFit: 'cover', transform: `scale(${zoom})`, filter: cssBlur(backdrop.blur, unit) }}
        />
      )}
      {backdrop.tintOpacity > 0 && (
        <span aria-hidden style={{ ...common, backgroundColor: cssTint(backdrop) }} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function MediaContent({
  spec,
  unit,
  isPlaying,
  masterVolume,
  masterMuted,
  frame = null,
  radius = 0,
  shadow,
}: {
  spec: PreviewLayerSpec;
  unit: number;
  isPlaying: boolean;
  masterVolume: number;
  masterMuted: boolean;
  /**
   * The picture's own box, in project pixels.
   *
   * Set only when the clip has a backdrop. The element is then sized to the
   * contained rectangle rather than to the frame, which is the box the encoder
   * rounds the corners of — and the only one a `border-radius` can match.
   */
  frame?: { width: number; height: number } | null;
  /** Corner radius, in project pixels. */
  radius?: number;
  /** Ready-made `box-shadow`, already in the viewer's units. */
  shadow?: string | undefined;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const [ready, setReady] = useState(false);

  const { clip, track, asset, sourceTime, gain } = spec;
  const isStill = asset?.kind === 'image';

  useEffect(() => {
    setReady(false);
    pendingSeek.current = null;
  }, [asset?.src]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || isStill) return;

    const audible = !track.muted && !clip.muted && !masterMuted;
    video.volume = Math.max(0, Math.min(1, clip.volume * masterVolume * gain));
    video.muted = !audible;

    if (!ready) {
      pendingSeek.current = sourceTime;
      return;
    }

    if (Number.isFinite(sourceTime) && Math.abs(video.currentTime - sourceTime) > DRIFT_TOLERANCE) {
      try {
        video.currentTime = sourceTime;
      } catch {
        /* the element rejects seeks while loading — retried on the next tick */
      }
    }

    if (isPlaying && video.paused) {
      void video.play().catch(() => undefined);
    } else if (!isPlaying && !video.paused) {
      video.pause();
    }
  }, [isStill, sourceTime, isPlaying, ready, gain, masterVolume, masterMuted, clip, track]);

  const onLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    if (pendingSeek.current != null && Number.isFinite(pendingSeek.current)) {
      try {
        video.currentTime = pendingSeek.current;
      } catch {
        /* ignore — the sync effect corrects on the next tick */
      }
      pendingSeek.current = null;
    }
    setReady(true);
  };

  if (!asset) return null;

  if (isStill) {
    // Stills keep their natural size in project pixels: an overlay logo is an
    // overlay, not a background. A full-frame still simply fills the frame.
    const width = asset.width ? asset.width * unit : undefined;
    const height = asset.height ? asset.height * unit : undefined;
    return (
      <img
        src={asset.src}
        alt={asset.name}
        draggable={false}
        className="block max-w-none select-none"
        style={{
          width: frame ? frame.width * unit : width,
          height: frame ? frame.height * unit : height,
          ...(frame ? { borderRadius: radius * unit, boxShadow: shadow } : {}),
        }}
      />
    );
  }

  const floating = frame
    ? {
        width: frame.width * unit,
        height: frame.height * unit,
        borderRadius: radius * unit,
        boxShadow: shadow,
      }
    : undefined;

  return (
    <video
      ref={videoRef}
      src={asset.src}
      playsInline
      preload="auto"
      onLoadedMetadata={onLoadedMetadata}
      onLoadedData={() => setReady(true)}
      className={floating ? 'block object-cover' : 'block h-full w-full object-contain'}
      style={floating}
    />
  );
}
