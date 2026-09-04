import { useMemo } from 'react';

import { cn } from '@/lib/cn';
import { channelLabel, orderedChannels } from '@/lib/channels';
import { useKeyframeDrag } from '@/hooks/useKeyframeDrag';
import { useKeyframeMenu } from '@/components/editor/contextMenus';
import { useEditor } from '@/store/editorStore';
import { evaluateKeyframes, type Keyframe } from '@/types/animation';
import type { Clip } from '@/types/timeline';

/** Room left at the top for the clip's own label. */
const TOP_INSET = 17;
const BOTTOM_INSET = 4;
/** One sample every few pixels is plenty — the eye reads shape, not precision. */
const SAMPLE_STEP = 3;

/**
 * Channels get their own hue so several curves stay legible at once. Kept
 * inside the violet–gold range the rest of the timeline already uses.
 */
const CHANNEL_COLORS = [
  'rgb(196 181 253)',
  'rgb(253 224 71)',
  'rgb(125 211 252)',
  'rgb(249 168 212)',
  'rgb(134 239 172)',
];

interface Series {
  channel: string;
  color: string;
  path: string;
  points: { keyframe: Keyframe; x: number; y: number }[];
}

/**
 * Keyframes drawn straight onto the clip, with the curve they describe.
 *
 * Each channel is normalised against its own range, because a rotation in
 * degrees and an opacity in 0–1 share no scale: what matters here is the
 * *shape* of the motion — where it accelerates, where it holds — not the
 * absolute numbers, which the inspector already reports.
 */
export function ClipCurves({
  clip,
  pixelsPerSecond,
  height,
  width,
}: {
  clip: Clip;
  pixelsPerSecond: number;
  height: number;
  width: number;
}) {
  const selected = useEditor((state) => state.selectedKeyframes);
  const beginDrag = useKeyframeDrag(pixelsPerSecond);
  const openMenu = useKeyframeMenu();

  const top = TOP_INSET;
  const plot = Math.max(height - TOP_INSET - BOTTOM_INSET, 6);

  const series = useMemo<Series[]>(() => {
    const channels = orderedChannels(clip);
    if (channels.length === 0 || width < 12) return [];

    return channels.flatMap((channel, index) => {
      const keyframes = clip.animation?.[channel] ?? [];
      if (keyframes.length === 0) return [];

      const values = keyframes.map((keyframe) => keyframe.value);
      const low = Math.min(...values);
      const high = Math.max(...values);
      // A channel whose keys all share one value is a flat line, not a divide
      // by zero.
      const span = high - low || 1;
      const toY = (value: number) => top + plot - ((value - low) / span) * plot;

      const steps = Math.max(2, Math.floor(width / SAMPLE_STEP));
      const path = Array.from({ length: steps + 1 }, (_, step) => {
        const x = (step / steps) * width;
        const value = evaluateKeyframes(keyframes, x / pixelsPerSecond, low);
        return `${step === 0 ? 'M' : 'L'}${x.toFixed(1)},${toY(value).toFixed(1)}`;
      }).join(' ');

      return [
        {
          channel,
          color: CHANNEL_COLORS[index % CHANNEL_COLORS.length] as string,
          path,
          points: keyframes.map((keyframe) => ({
            keyframe,
            x: keyframe.time * pixelsPerSecond,
            y: toY(keyframe.value),
          })),
        },
      ];
    });
  }, [clip, pixelsPerSecond, width, top, plot]);

  if (series.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0">
      <svg
        width={width}
        height={height}
        className="absolute left-0 top-0 overflow-visible"
        aria-hidden
      >
        {series.map((entry) => (
          <path
            key={entry.channel}
            d={entry.path}
            fill="none"
            stroke={entry.color}
            strokeWidth={1.5}
            strokeLinejoin="round"
            opacity={0.75}
            style={{ filter: 'drop-shadow(0 1px 1px rgba(0,0,0,.7))' }}
          />
        ))}
      </svg>

      {series.map((entry) =>
        entry.points.map(({ keyframe, x, y }) => {
          const active = selected.some((ref) => ref.id === keyframe.id);
          return (
            <button
              key={keyframe.id}
              type="button"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                beginDrag(clip, entry.channel, keyframe, event);
              }}
              onContextMenu={(event) => openMenu(event, clip, entry.channel, keyframe)}
              title={`${channelLabel(clip, entry.channel)} · ${keyframe.value.toFixed(2)}`}
              style={{ left: x, top: y, color: entry.color }}
              className={cn(
                'pointer-events-auto absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2',
                'cursor-ew-resize',
              )}
            >
              <svg viewBox="0 0 10 10" className="h-full w-full" aria-hidden>
                <path
                  d="M5 0.8 9.2 5 5 9.2 0.8 5Z"
                  fill={active ? 'currentColor' : 'rgba(13,15,18,.85)'}
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          );
        }),
      )}
    </div>
  );
}
