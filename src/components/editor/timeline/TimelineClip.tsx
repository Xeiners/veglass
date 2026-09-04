import {
  AudioLines,
  Captions,
  ChevronDown,
  ChevronRight,
  Image as ImageIcon,
  Lock,
  MousePointer2,
  Type,
  VolumeX,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatClock } from '@/lib/time';
import type { MediaAsset } from '@/types/media';
import type { Clip, Track } from '@/types/timeline';
import type { Waveform as WaveformData } from '@/lib/media';
import { useClipMenu } from '@/components/editor/contextMenus';
import { Waveform } from './Waveform';
import { ClipCurves } from './ClipCurves';

export type ClipGesture = 'move' | 'trim-start' | 'trim-end';

export interface TimelineClipProps {
  clip: Clip;
  track: Track;
  asset: MediaAsset | undefined;
  thumbnail?: string;
  peaks?: WaveformData | null;
  pixelsPerSecond: number;
  selected: boolean;
  dragging: boolean;
  /** `additive` is a Ctrl+click: add to or remove from the selection. */
  onSelect(additive: boolean): void;
  onGesture(gesture: ClipGesture, event: React.PointerEvent): void;
  animated: boolean;
  expanded: boolean;
  onToggleExpand(): void;
  /** Row height, so the curves know how much room they have. */
  height: number;
}

export function TimelineClip({
  clip,
  track,
  asset,
  thumbnail,
  peaks,
  pixelsPerSecond,
  selected,
  dragging,
  onSelect,
  onGesture,
  animated,
  expanded,
  onToggleExpand,
  height,
}: TimelineClipProps) {
  const openMenu = useClipMenu();
  const width = Math.max(clip.duration * pixelsPerSecond, 8);
  const isAudio = track.kind === 'audio';
  const isText = clip.kind === 'text';
  const isBanner = clip.kind === 'banner';
  const isCursor = clip.kind === 'cursor';
  const isStill = asset?.kind === 'image';
  const sourceDuration = asset?.duration ?? 0;
  const compact = width < 68;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onPointerDown={(event) => {
        // Right-click selects but must not start a move gesture.
        if (event.button !== 0) {
          if (!selected) onSelect(false);
          return;
        }
        // Ctrl+click builds a selection; dragging on the same gesture would
        // move a clip the user was only trying to add, so it selects and stops.
        if (event.ctrlKey) {
          event.preventDefault();
          onSelect(true);
          return;
        }
        // A plain click always starts a fresh single selection, because the
        // drag that follows moves one clip. Leaving a group selected while
        // dragging one of its members would make the highlight lie about what
        // the gesture is about to affect.
        onSelect(false);
        if (!track.locked) onGesture('move', event);
      }}
      onContextMenu={(event) => openMenu(event, clip, track)}
      style={{ left: clip.start * pixelsPerSecond, width }}
      className={cn(
        // Barely rounded on purpose. An 8 px corner hides a third of a frame at
        // high zoom, and two clips that touch stop looking like they touch.
        'group absolute top-1 bottom-1 select-none overflow-hidden rounded-[3px]',
        'ring-1 transition-shadow duration-150',
        track.locked ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing',
        isAudio
          ? 'bg-wave-500/[0.16] ring-wave-400/25'
          : isText
            ? 'bg-accent-300/[0.16] ring-accent-200/30'
            : isBanner
              // Teal rather than violet: a dressing row reads at a glance as
              // something other than the titles it sits above.
              ? 'bg-emerald-400/[0.14] ring-emerald-300/30'
              : 'bg-accent-500/[0.14] ring-accent-400/25',
        selected &&
          (isAudio
            ? 'ring-2 ring-wave-300 shadow-[0_0_0_1px_rgba(13,15,18,.9),0_6px_20px_-6px_rgba(251,191,36,.55)]'
            : 'ring-2 ring-accent-300 shadow-[0_0_0_1px_rgba(13,15,18,.9),0_6px_20px_-6px_rgba(124,58,237,.75)]'),
        dragging && 'z-20 opacity-90 shadow-lift',
        track.hidden && 'opacity-40',
      )}
    >
      {/* The exact bounds, on the frame itself: a bright seam where the clip
          starts, a dim one where it ends. Butt-joined clips then read as a
          single continuous edge, and a gap of one frame is visible as a gap. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 z-10 w-px bg-white/35"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 z-10 w-px bg-black/40"
      />

      {/* Filmstrip: the poster frame tiled horizontally. */}
      {!isAudio && thumbnail && (
        <div
          aria-hidden
          className="absolute inset-0 opacity-40 mix-blend-luminosity"
          style={{
            backgroundImage: `url(${thumbnail})`,
            backgroundSize: 'auto 100%',
            backgroundRepeat: 'repeat-x',
            backgroundPosition: `${-clip.offset * pixelsPerSecond}px center`,
          }}
        />
      )}

      {isAudio &&
        (peaks && sourceDuration > 0 ? (
          <Waveform
            data={peaks}
            from={clip.offset / sourceDuration}
            to={Math.min(1, (clip.offset + clip.duration) / sourceDuration)}
            width={width}
            className="absolute inset-x-0 bottom-0.5 top-4 h-auto w-full text-wave-200"
          />
        ) : (
          // Pending and failed look different on purpose: a shimmer says "wait",
          // a still line says "there will be nothing".
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-x-2 top-1/2 h-px -translate-y-1/2',
              peaks === null ? 'bg-wave-200/25' : 'animate-pulse bg-wave-200/40',
            )}
          />
        ))}

      {/* Keyframes and their curve, drawn on the clip itself. */}
      {animated && (
        <ClipCurves
          clip={clip}
          pixelsPerSecond={pixelsPerSecond}
          width={width}
          height={height - 8}
        />
      )}

      {/* Top sheen keeps the label legible over busy frames. */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-ink-950/75 to-transparent"
      />

      <div className="relative flex items-center gap-1 px-1.5 pt-1">
        {/* Twirl-down: only offered once the clip actually has animation. */}
        {animated && !compact && (
          <span
            role="button"
            tabIndex={-1}
            onPointerDown={(event) => {
              event.stopPropagation();
              onToggleExpand();
            }}
            title={expanded ? 'Replier les propriétés' : 'Déplier les propriétés animées'}
            className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded text-white/55 transition-colors hover:bg-white/15 hover:text-white"
          >
            {expanded ? (
              <ChevronDown size={10} strokeWidth={2.6} />
            ) : (
              <ChevronRight size={10} strokeWidth={2.6} />
            )}
          </span>
        )}
        {isAudio ? (
          <AudioLines size={10} strokeWidth={2.2} className="shrink-0 text-wave-200/80" />
        ) : isText ? (
          <Type size={10} strokeWidth={2.4} className="shrink-0 text-accent-100" />
        ) : isCursor ? (
          <MousePointer2 size={10} strokeWidth={2.4} className="shrink-0 text-sky-200" />
        ) : isBanner ? (
          <Captions size={10} strokeWidth={2.4} className="shrink-0 text-emerald-200" />
        ) : isStill ? (
          <ImageIcon size={10} strokeWidth={2.2} className="shrink-0 text-accent-200/80" />
        ) : null}
        {!compact && (
          <span
            className={cn(
              'truncate text-[10px] font-medium leading-[14px]',
              isAudio
                ? 'text-wave-100/90'
                : isBanner
                  ? 'text-emerald-100/90'
                  : 'text-accent-100/90',
            )}
          >
            {isCursor
              ? 'Curseur'
              : isText
              ? clip.text?.content || 'Texte'
              : isBanner
                ? clip.banner?.title || 'Habillage'
                : (clip.label ?? asset?.name ?? 'Clip')}
          </span>
        )}
        {clip.muted && <VolumeX size={9} strokeWidth={2.4} className="ml-auto shrink-0 text-white/45" />}
        {track.locked && <Lock size={9} strokeWidth={2.4} className="ml-auto shrink-0 text-white/45" />}
      </div>

      {!compact && (
        <span className="num absolute bottom-1 right-1.5 rounded bg-ink-950/55 px-1 text-[9px] leading-[13px] text-white/45 opacity-0 transition-opacity group-hover:opacity-100">
          {formatClock(clip.duration)}
        </span>
      )}

      {/* Trim handles */}
      {!track.locked && (
        <>
          <TrimHandle side="start" onPointerDown={(event) => onGesture('trim-start', event)} />
          <TrimHandle side="end" onPointerDown={(event) => onGesture('trim-end', event)} />
        </>
      )}
    </div>
  );
}

function TrimHandle({
  side,
  onPointerDown,
}: {
  side: 'start' | 'end';
  onPointerDown(event: React.PointerEvent): void;
}) {
  return (
    <div
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown(event);
      }}
      className={cn(
        'absolute inset-y-0 z-10 w-2.5 cursor-ew-resize',
        'opacity-0 transition-opacity duration-150 group-hover:opacity-100',
        side === 'start' ? 'left-0' : 'right-0',
      )}
    >
      <span
        className={cn(
          'absolute inset-y-1 w-1 rounded-full bg-white/70',
          side === 'start' ? 'left-0.5' : 'right-0.5',
        )}
      />
    </div>
  );
}
