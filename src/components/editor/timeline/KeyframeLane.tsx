import { cn } from '@/lib/cn';
import { channelLabel } from '@/lib/channels';
import { useKeyframeDrag } from '@/hooks/useKeyframeDrag';
import { useChannelLaneMenu, useKeyframeMenu } from '@/components/editor/contextMenus';
import { Diamond } from '@/components/editor/inspector/AnimatableRow';
import { useEditor } from '@/store/editorStore';
import { EASING_LABELS, type Keyframe } from '@/types/animation';
import type { Clip } from '@/types/timeline';

export const KEYFRAME_ROW_HEIGHT = 22;

/**
 * One property of an unfolded clip, with its keyframes as draggable diamonds.
 *
 * The row spans the whole timeline so the diamonds line up with the ruler, but
 * only the clip's own span is tinted — a keyframe cannot exist outside it.
 */
export function KeyframeLane({
  clip,
  channel,
  keyframes,
  pixelsPerSecond,
  width,
}: {
  clip: Clip;
  channel: string;
  keyframes: Keyframe[];
  pixelsPerSecond: number;
  width: number;
}) {
  const selected = useEditor((state) => state.selectedKeyframes);
  const addKeyframeAt = useEditor((state) => state.addKeyframeAt);
  // The very gesture used by the diamonds drawn on the clip itself.
  const beginDrag = useKeyframeDrag(pixelsPerSecond);
  const openMenu = useKeyframeMenu();
  const openLaneMenu = useChannelLaneMenu();

  const isSelected = (id: string) => selected.some((ref) => ref.id === id);

  const spanLeft = clip.start * pixelsPerSecond;
  const spanWidth = Math.max(clip.duration * pixelsPerSecond, 2);

  return (
    <div className="flex">
      <div
        className="sticky left-0 z-30 flex shrink-0 items-center gap-1.5 border-b border-r border-white/[0.04] bg-ink-850 pl-8 pr-3"
        style={{ width: 'var(--track-head)', height: KEYFRAME_ROW_HEIGHT }}
      >
        <span className="text-accent-300/70">
          <Diamond filled className="h-2 w-2" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-white/45">
          {channelLabel(clip, channel)}
        </span>
        <span className="num text-[9px] text-white/22">{keyframes.length}</span>
      </div>

      <div
        onDoubleClick={(event) => {
          // Double-click on empty lane drops a key on that frame.
          const lane = event.currentTarget.getBoundingClientRect();
          const time = (event.clientX - lane.left) / pixelsPerSecond - clip.start;
          if (time >= 0 && time <= clip.duration) addKeyframeAt(clip.id, channel, time);
        }}
        onContextMenu={(event) => {
          if (event.target !== event.currentTarget) return;
          const lane = event.currentTarget.getBoundingClientRect();
          const time = (event.clientX - lane.left) / pixelsPerSecond - clip.start;
          openLaneMenu(event, clip, channel, Math.max(0, Math.min(time, clip.duration)));
        }}
        className="relative shrink-0 border-b border-white/[0.04] bg-white/[0.008]"
        style={{ width, height: KEYFRAME_ROW_HEIGHT }}
      >
        <span
          aria-hidden
          className="absolute inset-y-0 bg-accent-500/[0.06]"
          style={{ left: spanLeft, width: spanWidth }}
        />

        {keyframes.map((keyframe) => {
          const active = isSelected(keyframe.id);
          return (
            <button
              key={keyframe.id}
              type="button"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                beginDrag(clip, channel, keyframe, event);
              }}
              onContextMenu={(event) => openMenu(event, clip, channel, keyframe)}
              title={`${channelLabel(clip, channel)} · ${keyframe.value.toFixed(2)} · ${
                EASING_LABELS[keyframe.easing.kind]
              }`}
              style={{ left: (clip.start + keyframe.time) * pixelsPerSecond }}
              className={cn(
                'absolute top-1/2 grid h-4 w-4 -translate-x-1/2 -translate-y-1/2 place-items-center',
                'cursor-ew-resize transition-colors',
                active ? 'text-accent-200' : 'text-accent-300/75 hover:text-accent-200',
              )}
            >
              <Diamond
                filled
                className={cn(
                  'h-2.5 w-2.5 drop-shadow-[0_1px_2px_rgba(0,0,0,.6)]',
                  active && 'scale-125',
                )}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
