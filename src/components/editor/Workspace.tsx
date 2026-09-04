import { useEffect, useRef } from 'react';

import { cn } from '@/lib/cn';
import { useDrag } from '@/hooks/useDrag';
import { useElementSize } from '@/hooks/useElementSize';
import { usePlaybackClock } from '@/hooks/usePlaybackClock';
import { useShortcuts } from '@/hooks/useShortcuts';
import { MIN_VIEWER, usePanelLayout } from '@/hooks/usePanelLayout';
import { useEditor } from '@/store/editorStore';
import { AnimationPanel } from './AnimationPanel';
import { AudioMixer } from './AudioMixer';
import { LeftRail } from './LeftRail';
import { RightPanel } from './RightPanel';
import { RelinkDialog } from './RelinkDialog';
import { TopBar } from './TopBar';
import { VideoPreview } from './VideoPreview';
import { Timeline } from './timeline/Timeline';

export function Workspace() {
  usePlaybackClock();
  useShortcuts(true);

  const { layout, setPanel, resetPanel } = usePanelLayout();

  // The animation column appears on its own as soon as the selected clip has
  // something to animate, and can be dismissed from its own header.
  const project = useEditor((state) => state.project);
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const expandedClipId = useEditor((state) => state.expandedClipId);
  const animationPanelOpen = useEditor((state) => state.animationPanelOpen);

  const animatedClip = project?.clips.find(
    (clip) => clip.id === (selectedClipId ?? expandedClipId),
  );
  const showAnimation =
    animationPanelOpen && Object.keys(animatedClip?.animation ?? {}).length > 0;

  // Sizes at the moment a drag starts; deltas are applied to these rather than
  // accumulated, so a gesture can never drift.
  const origin = useRef({ left: 0, right: 0, animation: 0, timeline: 0 });

  // The viewer's live width and the current sizes, mirrored into refs: the drag
  // handlers are long-lived closures that must read current values, not the ones
  // captured when the gesture began.
  const { ref: viewerRef, size: viewerSize } = useElementSize<HTMLElement>();
  const viewerWidth = useRef(0);
  const current = useRef(layout);
  useEffect(() => {
    viewerWidth.current = viewerSize.width;
    current.current = layout;
  }, [viewerSize.width, layout]);

  /**
   * A side panel may only grow into the slack the viewer has left. Expressed as
   * a ceiling rather than a directional veto, so reversing mid-gesture always
   * works — a veto would strand the panel at its maximum.
   */
  const guarded = (key: 'left' | 'right' | 'animation', candidate: number) => {
    const slack = Math.max(0, viewerWidth.current - MIN_VIEWER);
    setPanel(key, Math.min(candidate, current.current[key] + slack));
  };

  const dragLeft = useDrag({
    cursor: 'col-resize',
    onStart: () => {
      origin.current.left = layout.left;
    },
    onMove: ({ dx }) => guarded('left', origin.current.left + dx),
  });

  const dragRight = useDrag({
    cursor: 'col-resize',
    // Dragging left (negative dx) widens a right-hand panel.
    onStart: () => {
      origin.current.right = layout.right;
    },
    onMove: ({ dx }) => guarded('right', origin.current.right - dx),
  });

  const dragAnimation = useDrag({
    cursor: 'col-resize',
    onStart: () => {
      origin.current.animation = layout.animation;
    },
    onMove: ({ dx }) => guarded('animation', origin.current.animation - dx),
  });

  const dragTimeline = useDrag({
    cursor: 'ns-resize',
    onStart: () => {
      origin.current.timeline = layout.timeline;
    },
    // Dragging up (negative dy) grows the timeline.
    onMove: ({ dy }) => setPanel('timeline', origin.current.timeline - dy),
  });

  return (
    <div className="flex h-full flex-col overflow-hidden bg-ink-900">
      <TopBar />

      <div className="flex min-h-0 flex-1">
        <div
          className="shrink-0 border-r border-white/[0.055] bg-ink-850/45 backdrop-blur-xl"
          style={{ width: layout.left }}
        >
          <LeftRail />
        </div>

        <Divider
          orientation="vertical"
          label="Redimensionner le panneau gauche"
          onPointerDown={dragLeft}
          onReset={() => resetPanel('left')}
        />

        <main ref={viewerRef} className="flex min-w-0 flex-1 flex-col">
          <VideoPreview />
        </main>

        {showAnimation && (
          <>
            <Divider
              orientation="vertical"
              label="Redimensionner le panneau d’animation"
              className="hidden lg:block"
              onPointerDown={dragAnimation}
              onReset={() => resetPanel('animation')}
            />
            <div
              className="hidden shrink-0 border-l border-white/[0.055] bg-ink-850/45 backdrop-blur-xl lg:block"
              style={{ width: layout.animation }}
            >
              <AnimationPanel />
            </div>
          </>
        )}

        <Divider
          orientation="vertical"
          label="Redimensionner le panneau droit"
          className="hidden md:block"
          onPointerDown={dragRight}
          onReset={() => resetPanel('right')}
        />

        <div
          className="hidden shrink-0 border-l border-white/[0.055] bg-ink-850/45 backdrop-blur-xl md:block"
          style={{ width: layout.right }}
        >
          <RightPanel />
        </div>
      </div>

      <Divider
        orientation="horizontal"
        label="Redimensionner la timeline"
        onPointerDown={dragTimeline}
        onReset={() => resetPanel('timeline')}
      />

      <div className="shrink-0" style={{ height: layout.timeline }}>
        <Timeline />
      </div>

      <AudioMixer />
      <RelinkDialog />
    </div>
  );
}

/**
 * Splitter between two regions. Six pixels of hit area for a one-pixel seam,
 * and a double-click to snap back to the default width.
 */
function Divider({
  orientation,
  label,
  className,
  onPointerDown,
  onReset,
}: {
  orientation: 'vertical' | 'horizontal';
  label: string;
  className?: string;
  onPointerDown(event: React.PointerEvent): void;
  onReset(): void;
}) {
  const vertical = orientation === 'vertical';

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      title={`${label} — double-clic pour réinitialiser`}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      className={cn(
        'group relative shrink-0 bg-ink-850/70 transition-colors duration-200',
        'hover:bg-accent-500/25 active:bg-accent-500/40',
        vertical
          ? 'w-1.5 cursor-col-resize border-x border-white/[0.04]'
          : 'h-1.5 cursor-ns-resize border-y border-white/[0.04]',
        className,
      )}
    >
      <span
        className={cn(
          'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full',
          'bg-white/12 transition-colors duration-200 group-hover:bg-white/40',
          vertical ? 'h-9 w-0.5' : 'h-0.5 w-9',
        )}
      />
    </div>
  );
}
