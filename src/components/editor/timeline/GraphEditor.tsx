import { useCallback, useMemo } from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { cn } from '@/lib/cn';
import { channelLabel, orderedChannels } from '@/lib/channels';
import { useKeyframeMenu } from '@/components/editor/contextMenus';
import { useEditor } from '@/store/editorStore';
import {
  easeAt,
  evaluateKeyframes,
  handlesOf,
  type Keyframe,
  type KeyframeRef,
} from '@/types/animation';
import type { Clip } from '@/types/timeline';

const PAD_TOP = 18;
const PAD_BOTTOM = 22;
/** Head-room above and below the value range, as a fraction of it. */
const RANGE_PADDING = 0.15;
const SAMPLE_STEP = 3;

const CHANNEL_COLORS = [
  'rgb(196 181 253)',
  'rgb(253 224 71)',
  'rgb(125 211 252)',
  'rgb(249 168 212)',
  'rgb(134 239 172)',
  'rgb(252 165 165)',
];

interface Mapping {
  low: number;
  high: number;
  toY(value: number): number;
  fromY(y: number): number;
}

interface Curve {
  channel: string;
  color: string;
  keyframes: Keyframe[];
  mapping: Mapping;
  path: string;
}

/**
 * The value graph — the animation mode.
 *
 * A keyframe is a point in (time, value): dragging it left and right retimes
 * the motion, up and down changes what it reaches. The two round handles either
 * side of a segment are its bézier controls; pulling them flattens or steepens
 * the approach, which is what makes a movement accelerate or ease off.
 *
 * Each channel is mapped to its own vertical range: degrees of rotation and an
 * opacity between 0 and 1 share no scale, and forcing them onto one axis would
 * flatten every curve but the largest.
 */
export function GraphEditor({
  clip,
  pixelsPerSecond,
  width,
  height,
  headWidth,
}: {
  clip: Clip;
  pixelsPerSecond: number;
  width: number;
  height: number;
  headWidth: number;
}) {
  const selected = useEditor((state) => state.selectedKeyframes);
  const hidden = useEditor((state) => state.hiddenGraphChannels);
  const toggleChannelVisible = useEditor((state) => state.toggleGraphChannel);
  const selectKeyframes = useEditor((state) => state.selectKeyframes);
  const setPlayhead = useEditor((state) => state.setPlayhead);
  const setKeyframeAt = useEditor((state) => state.setKeyframeAt);
  const setKeyframeEasing = useEditor((state) => state.setKeyframeEasing);
  const openMenu = useKeyframeMenu();

  const plot = Math.max(height - PAD_TOP - PAD_BOTTOM, 40);

  const curves = useMemo<Curve[]>(() => {
    return orderedChannels(clip).flatMap((channel, index) => {
      const keyframes = clip.animation?.[channel] ?? [];
      if (keyframes.length === 0 || hidden.includes(channel)) return [];

      const values = keyframes.map((keyframe) => keyframe.value);
      const rawLow = Math.min(...values);
      const rawHigh = Math.max(...values);
      const margin = (rawHigh - rawLow || Math.abs(rawHigh) || 1) * RANGE_PADDING;
      const low = rawLow - margin;
      const high = rawHigh + margin;
      const span = high - low || 1;

      const mapping: Mapping = {
        low,
        high,
        toY: (value) => PAD_TOP + plot - ((value - low) / span) * plot,
        fromY: (y) => low + ((PAD_TOP + plot - y) / plot) * span,
      };

      // The curve is drawn across the clip only: a property does not exist
      // before the clip starts or after it ends, and a flat line running to the
      // end of the timeline would suggest otherwise.
      const left = clip.start * pixelsPerSecond;
      const right = (clip.start + clip.duration) * pixelsPerSecond;
      const steps = Math.max(2, Math.floor((right - left) / SAMPLE_STEP));
      const path = Array.from({ length: steps + 1 }, (_, step) => {
        const x = left + ((right - left) * step) / steps;
        const value = evaluateKeyframes(keyframes, x / pixelsPerSecond - clip.start, rawLow);
        return `${step === 0 ? 'M' : 'L'}${x.toFixed(1)},${mapping.toY(value).toFixed(1)}`;
      }).join(' ');

      return [
        {
          channel,
          color: CHANNEL_COLORS[index % CHANNEL_COLORS.length] as string,
          keyframes,
          mapping,
          path,
        },
      ];
    });
  }, [clip, hidden, pixelsPerSecond, width, plot]);

  /* ------------------------------------------------ two-dimensional drag */

  const dragPoint = useCallback(
    (curve: Curve, keyframe: Keyframe, event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const ref: KeyframeRef = { clipId: clip.id, channel: curve.channel, id: keyframe.id };
      selectKeyframes([ref]);

      const origin = { x: event.clientX, y: event.clientY };
      // The mapping is frozen for the gesture: recomputing it while the value
      // moves would make the range chase the pointer.
      const { mapping } = curve;
      const startY = mapping.toY(keyframe.value);
      document.body.style.cursor = 'move';
      // The viewer shows the instant being shaped, here as in the lanes.
      setPlayhead(clip.start + keyframe.time);

      const onMove = (native: PointerEvent) => {
        const time = keyframe.time + (native.clientX - origin.x) / pixelsPerSecond;
        const value = mapping.fromY(startY + (native.clientY - origin.y));
        setKeyframeAt([
          {
            ref,
            // Shift locks the gesture to one axis, as in every curve editor.
            time: native.shiftKey && Math.abs(native.clientY - origin.y) > Math.abs(native.clientX - origin.x)
              ? keyframe.time
              : time,
            value: native.shiftKey && Math.abs(native.clientX - origin.x) >= Math.abs(native.clientY - origin.y)
              ? keyframe.value
              : Number(value.toFixed(4)),
          },
        ]);
        const landed = useEditor
          .getState()
          .project?.clips.find((item) => item.id === clip.id)
          ?.animation?.[curve.channel]?.find((item) => item.id === keyframe.id);
        if (landed) setPlayhead(clip.start + landed.time);
      };
      const onUp = () => {
        document.body.style.removeProperty('cursor');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [clip.id, clip.start, pixelsPerSecond, selectKeyframes, setKeyframeAt, setPlayhead],
  );

  /* ------------------------------------------------------ bézier handles */

  const dragHandle = useCallback(
    (
      curve: Curve,
      from: Keyframe,
      to: Keyframe,
      side: 0 | 1,
      event: React.PointerEvent,
    ) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const ref: KeyframeRef = { clipId: clip.id, channel: curve.channel, id: from.id };
      const spanTime = Math.max(to.time - from.time, 1e-4);
      const spanValue = to.value - from.value;
      const base = handlesOf(from.easing);

      // Measured now, not inside the move handler: a React synthetic event is
      // recycled after dispatch, and `currentTarget` is null by then — which is
      // why dragging a handle did nothing at all.
      const surface = (event.currentTarget as SVGElement).ownerSVGElement;
      if (!surface) return;
      const box = surface.getBoundingClientRect();
      document.body.style.cursor = 'grabbing';

      const onMove = (native: PointerEvent) => {
        const x = (native.clientX - box.left) / pixelsPerSecond - clip.start;
        const value = curve.mapping.fromY(native.clientY - box.top);

        // Handles live in the segment's own normalised space.
        const nx = Math.max(0, Math.min(1, (x - from.time) / spanTime));
        const ny =
          Math.abs(spanValue) < 1e-6
            ? base[side * 2 + 1]
            : Math.max(-1, Math.min(2, (value - from.value) / spanValue));

        const handles: [number, number, number, number] = [...base];
        handles[side * 2] = Number(nx.toFixed(3));
        handles[side * 2 + 1] = Number(ny.toFixed(3));
        setKeyframeEasing([ref], { kind: 'bezier', bezier: handles });
      };
      const onUp = () => {
        document.body.style.removeProperty('cursor');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [clip.id, clip.start, pixelsPerSecond, setKeyframeEasing],
  );

  const channels = orderedChannels(clip);

  return (
    <div className="flex">
      {/* Legend, sticky like a track head. */}
      <div
        className="sticky left-0 z-30 shrink-0 border-r border-white/[0.05] bg-ink-850 px-2 py-2"
        style={{ width: headWidth, height }}
      >
        <span className="eyebrow mb-1.5 block px-1">Propriétés</span>
        <ul className="space-y-0.5">
          {channels.map((channel, index) => {
            const off = hidden.includes(channel);
            return (
              <li key={channel}>
                <button
                  type="button"
                  onClick={() => toggleChannelVisible(channel)}
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left',
                    'transition-colors hover:bg-white/[0.06]',
                    off && 'opacity-40',
                  )}
                >
                  <span
                    className="h-0.5 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: CHANNEL_COLORS[index % CHANNEL_COLORS.length] }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[10px] text-white/65">
                    {channelLabel(clip, channel)}
                  </span>
                  <span className="shrink-0 text-white/25">
                    {off ? <EyeOff size={10} strokeWidth={2} /> : <Eye size={10} strokeWidth={2} />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div
        className="relative shrink-0 bg-ink-900"
        style={{ width, height }}
      >
        {/* The clip's own span, so the graph is readable against the timeline. */}
        <span
          aria-hidden
          className="absolute inset-y-0 border-x border-white/[0.06] bg-white/[0.012]"
          style={{ left: clip.start * pixelsPerSecond, width: clip.duration * pixelsPerSecond }}
        />

        <svg width={width} height={height} className="absolute left-0 top-0 overflow-visible">
          {curves.map((curve) => (
            <path
              key={curve.channel}
              d={curve.path}
              fill="none"
              stroke={curve.color}
              strokeWidth={1.75}
              opacity={0.85}
            />
          ))}

          {curves.map((curve) =>
            curve.keyframes.map((keyframe, index) => {
              const next = curve.keyframes[index + 1];
              if (!next || keyframe.easing.kind === 'hold') return null;

              const handles = handlesOf(keyframe.easing);
              const spanTime = next.time - keyframe.time;
              const spanValue = next.value - keyframe.value;
              const active = selected.some((ref) => ref.id === keyframe.id);
              if (!active) return null;

              const point = (nx: number, ny: number) => ({
                x: (clip.start + keyframe.time + nx * spanTime) * pixelsPerSecond,
                y: curve.mapping.toY(keyframe.value + ny * spanValue),
              });
              const out = point(handles[0], handles[1]);
              const into = point(handles[2], handles[3]);
              const anchorA = point(0, 0);
              const anchorB = point(1, 1);

              return (
                <g key={`h-${keyframe.id}`}>
                  <line
                    x1={anchorA.x}
                    y1={anchorA.y}
                    x2={out.x}
                    y2={out.y}
                    stroke={curve.color}
                    strokeOpacity={0.5}
                  />
                  <line
                    x1={anchorB.x}
                    y1={anchorB.y}
                    x2={into.x}
                    y2={into.y}
                    stroke={curve.color}
                    strokeOpacity={0.5}
                  />
                  <circle
                    cx={out.x}
                    cy={out.y}
                    r={4.5}
                    fill={curve.color}
                    className="cursor-grab active:cursor-grabbing"
                    onPointerDown={(event) => dragHandle(curve, keyframe, next, 0, event)}
                  />
                  <circle
                    cx={into.x}
                    cy={into.y}
                    r={4.5}
                    fill={curve.color}
                    className="cursor-grab active:cursor-grabbing"
                    onPointerDown={(event) => dragHandle(curve, keyframe, next, 1, event)}
                  />
                </g>
              );
            }),
          )}

          {curves.map((curve) =>
            curve.keyframes.map((keyframe) => {
              const active = selected.some((ref) => ref.id === keyframe.id);
              const x = (clip.start + keyframe.time) * pixelsPerSecond;
              const y = curve.mapping.toY(keyframe.value);
              return (
                <g key={keyframe.id}>
                  <rect
                    x={x - 4.5}
                    y={y - 4.5}
                    width={9}
                    height={9}
                    transform={`rotate(45 ${x} ${y})`}
                    fill={active ? curve.color : 'rgba(13,15,18,.85)'}
                    stroke={curve.color}
                    strokeWidth={2}
                    className="cursor-move"
                    onPointerDown={(event) => dragPoint(curve, keyframe, event)}
                    onContextMenu={(event) => openMenu(event, clip, curve.channel, keyframe)}
                  />
                  {active && (
                    <text
                      x={x}
                      y={y - 10}
                      textAnchor="middle"
                      className="num pointer-events-none"
                      fill="rgba(255,255,255,.75)"
                      fontSize={9}
                    >
                      {Number(keyframe.value.toFixed(2))}
                    </text>
                  )}
                </g>
              );
            }),
          )}
        </svg>

        {curves.length === 0 && (
          <p className="absolute inset-0 grid place-items-center text-2xs text-white/28">
            Aucune propriété animée sur ce clip
          </p>
        )}
      </div>
    </div>
  );
}

/** Sampled easing, exposed for the legend's mini previews. */
export const previewEase = easeAt;
