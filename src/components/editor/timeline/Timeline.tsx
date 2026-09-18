import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Captions,
  Mic,
  Copy,
  Magnet,
  LineChart,
  Palette,
  Plus,
  Scissors,
  ScissorsLineDashed,
  Type,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { clamp, snapToFrame } from '@/lib/time';
import { useDrag } from '@/hooks/useDrag';
import { IconButton } from '@/components/ui/Button';
import { projectDuration, useEditor } from '@/store/editorStore';
import { useAi } from '@/store/aiStore';
import { useRangeNarration } from '@/store/rangeNarrationStore';
import {
  applySnap,
  nearestAnchor,
  resolveTransitions,
  snapTargets,
  transitionAnchors,
  type ResolvedTransition,
} from '@/store/selectors';
import { ASSET_DND_TYPE } from '@/components/editor/MediaPool';
import { TRANSITION_DND_TYPE } from '@/components/editor/EffectsPanel';
import { clipEnd, type Clip } from '@/types/timeline';
import {
  MIN_TRANSITION_DURATION,
  type TransitionAnchor,
  type TransitionKind,
} from '@/types/transitions';
import { Ruler, RULER_HEIGHT } from './Ruler';
import {
  PlayheadFollower,
  PlayheadGrip,
  PlayheadLine,
  TimecodeReadout,
} from './PlayheadLayer';
import { TrackHead } from './TrackHead';
import { TimelineClip, type ClipGesture } from './TimelineClip';
import { TransitionBlock } from './TransitionBlock';
import { KeyframeLane } from './KeyframeLane';
import { GraphEditor } from './GraphEditor';
import { orderedChannels } from '@/lib/channels';
import { useLaneMenu } from '@/components/editor/contextMenus';

const HEAD_WIDTH = 158;
/** Empty runway kept after the last clip so there is always room to drop. */
const TRAILING_SECONDS = 8;
const SNAP_PIXELS = 9;
/** Zoom bounds, mirrored from the store so anchored zoom can pre-compute scroll. */
const MIN_PPS = 6;
const MAX_PPS = 480;
/** How close the cursor must come to a cut for a dropped transition to catch. */
const ANCHOR_PIXELS = 26;

interface Gesture {
  clipId: string;
  mode: ClipGesture;
  /** Distance, in seconds, between the clip start and the grab point. */
  grabOffset: number;
}

export function Timeline() {
  // Deliberately *not* subscribed to `playhead`: the transport writes it sixty
  // times a second, and only the components in PlayheadLayer need to follow.
  const project = useEditor((state) => state.project);
  const pixelsPerSecond = useEditor((state) => state.pixelsPerSecond);
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const selectedClipIds = useEditor((state) => state.selectedClipIds);
  const snapEnabled = useEditor((state) => state.snapEnabled);
  const thumbnails = useEditor((state) => state.thumbnails);
  const peaks = useEditor((state) => state.peaks);

  const setPlayhead = useEditor((state) => state.setPlayhead);
  const selectClip = useEditor((state) => state.selectClip);
  const moveClip = useEditor((state) => state.moveClip);
  const trimClip = useEditor((state) => state.trimClip);
  const removeSelectedClips = useEditor((state) => state.removeSelectedClips);
  const duplicateClips = useEditor((state) => state.duplicateClips);
  const splitAtPlayhead = useEditor((state) => state.splitAtPlayhead);
  const toggleSnap = useEditor((state) => state.toggleSnap);
  const setZoom = useEditor((state) => state.setZoom);
  const addTrack = useEditor((state) => state.addTrack);
  const addClip = useEditor((state) => state.addClip);
  const selectedTransitionId = useEditor((state) => state.selectedTransitionId);
  const selectTransition = useEditor((state) => state.selectTransition);
  const addTransition = useEditor((state) => state.addTransition);
  const registerZoomAnchor = useEditor((state) => state.registerZoomAnchor);
  const moveTrack = useEditor((state) => state.moveTrack);
  const addTextClip = useEditor((state) => state.addTextClip);
  const addBackgroundClip = useEditor((state) => state.addBackgroundClip);
  const expandedClipId = useEditor((state) => state.expandedClipId);
  const toggleClipExpansion = useEditor((state) => state.toggleClipExpansion);
  const graphMode = useEditor((state) => state.graphMode);
  const toggleGraphMode = useEditor((state) => state.toggleGraphMode);
  const setTransitionDuration = useEditor((state) => state.setTransitionDuration);
  const removeTransition = useEditor((state) => state.removeTransition);
  const notify = useEditor((state) => state.notify);
  const spaceHeld = useEditor((state) => state.spaceHeld);
  const markSpacePan = useEditor((state) => state.markSpacePan);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const laneRefs = useRef(new Map<string, HTMLDivElement>());
  const gesture = useRef<Gesture | null>(null);
  const [dragClipId, setDragClipId] = useState<string | null>(null);
  const [dropTrackId, setDropTrackId] = useState<string | null>(null);
  const [dropAnchor, setDropAnchor] = useState<TransitionAnchor | null>(null);
  const [draggingTrackId, setDraggingTrackId] = useState<string | null>(null);
  /** Time the current gesture is locked onto, drawn as a guide. */
  const [snapGuide, setSnapGuide] = useState<number | null>(null);
  const openLaneMenu = useLaneMenu();
  /** Horizontal window, tracked so the ruler only mounts visible ticks. */
  const [view, setView] = useState({ left: 0, width: 1200, height: 300 });

  const duration = projectDuration(project);
  const fps = project?.settings.fps ?? 30;
  const tracks = project?.tracks ?? [];
  const clips = project?.clips ?? [];
  const anySolo = tracks.some(
    (track) => track.kind === 'audio' && track.solo && !track.muted,
  );

  /**
   * The timeline always spans at least the width of its own viewport.
   *
   * Sized on the content alone, a short project produces a strip narrower than
   * the panel: the ruler stops mid-way and the right-hand side is left blank,
   * with no graduation to read or to drop a clip against. Zooming in used to
   * "fix" it only because the content had grown past the viewport.
   */
  const laneViewport = Math.max(view.width - HEAD_WIDTH, 0);
  const seconds = Math.max(
    duration + TRAILING_SECONDS,
    24,
    laneViewport > 0 ? laneViewport / pixelsPerSecond : 0,
  );
  const contentWidth = seconds * pixelsPerSecond;

  const expandedClip = useMemo(
    () => project?.clips.find((clip) => clip.id === expandedClipId) ?? null,
    [project, expandedClipId],
  );

  // The graph works on whatever is under the cursor of attention: the unfolded
  // clip if there is one, otherwise the selected clip.
  const graphClip = useMemo(
    () =>
      project?.clips.find((clip) => clip.id === (expandedClipId ?? selectedClipId)) ?? null,
    [project, expandedClipId, selectedClipId],
  );

  const anchors = useMemo(() => transitionAnchors(project), [project]);
  const transitionsByTrack = useMemo(() => {
    const map = new Map<string, ResolvedTransition[]>();
    for (const item of resolveTransitions(project)) {
      const bucket = map.get(item.track.id);
      if (bucket) bucket.push(item);
      else map.set(item.track.id, [item]);
    }
    return map;
  }, [project]);

  const visible = useMemo(() => {
    // `scrollLeft` counts from the start of the head column, so the lane's own
    // origin is one head width further in. Forgetting that shifts the whole
    // window and trims the wrong end of it.
    const left = view.left - HEAD_WIDTH;
    // A full viewport of slack on each side. Culling is an optimisation and
    // must never be the reason something is missing: the margin costs a handful
    // of extra nodes and makes a measurement that is a frame stale harmless.
    const margin = Math.max(laneViewport, 480);
    return {
      from: Math.max(0, (left - margin) / pixelsPerSecond),
      to: (left + laneViewport + margin) / pixelsPerSecond,
    };
  }, [view, laneViewport, pixelsPerSecond]);

  const syncFrame = useRef(0);

  /** Reads the viewport immediately — for the moments a frame of lag shows. */
  const measure = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    setView((prev) =>
      prev.left === node.scrollLeft &&
      prev.width === node.clientWidth &&
      prev.height === node.clientHeight
        ? prev
        : { left: node.scrollLeft, width: node.clientWidth, height: node.clientHeight },
    );
  }, []);

  // Scroll fires far more often than the browser paints. Collapsing the reads
  // into one per frame keeps horizontal navigation smooth on long timelines.
  const syncView = useCallback(() => {
    if (syncFrame.current) return;
    syncFrame.current = requestAnimationFrame(() => {
      syncFrame.current = 0;
      measure();
    });
  }, [measure]);

  // Layout, not effect: this runs before the browser paints, so the very first
  // frame is drawn against the real viewport instead of the initial guess.
  // Measuring after the paint meant one frame culled against a made-up width.
  useLayoutEffect(() => {
    measure();
    const node = scrollRef.current;
    if (!node) return;
    const observer = new ResizeObserver(syncView);
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (syncFrame.current) {
        cancelAnimationFrame(syncFrame.current);
        // Clearing the handle is the whole point: the guard in `syncView` reads
        // it, so a stale id silences every later measurement. The viewport then
        // stays frozen on its initial guess, and everything past that guess is
        // culled — clips vanish as soon as zooming pushes them beyond it.
        // StrictMode's mount/unmount/mount makes this the rule in development,
        // not an edge case.
        syncFrame.current = 0;
      }
    };
  }, [measure, syncView]);

  /** Client X → timeline seconds, accounting for the sticky head column. */
  const timeAt = useCallback(
    (clientX: number): number => {
      const node = scrollRef.current;
      if (!node) return 0;
      const rect = node.getBoundingClientRect();
      const x = clientX - rect.left + node.scrollLeft - HEAD_WIDTH;
      return Math.max(0, x / pixelsPerSecond);
    },
    [pixelsPerSecond],
  );

  const trackAt = useCallback((clientY: number): string | null => {
    for (const [trackId, node] of laneRefs.current) {
      const rect = node.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) return trackId;
    }
    return null;
  }, []);

  /**
   * Magnetic alignment on clip edges, the playhead and the origin.
   *
   * The edge it locked onto comes back with the result: an alignment you cannot
   * see is an alignment you have to take on faith, and a rounded corner is not
   * evidence that two clips actually meet.
   */
  const snap = useCallback(
    (
      start: number,
      clipDuration: number,
      excludeId: string | null,
    ): { start: number; guide: number | null } => {
      if (!snapEnabled) return { start, guide: null };
      // Read the playhead at gesture time rather than subscribing to it.
      const targets = snapTargets(project, excludeId, useEditor.getState().playhead);
      const tolerance = SNAP_PIXELS / pixelsPerSecond;
      const byStart = applySnap(start, targets, tolerance);
      const byEnd = applySnap(start + clipDuration, targets, tolerance) - clipDuration;
      const deltaStart = Math.abs(byStart - start);
      const deltaEnd = Math.abs(byEnd - start);
      if (deltaStart === 0 && deltaEnd === 0) return { start, guide: null };
      return deltaStart <= deltaEnd
        ? { start: byStart, guide: byStart }
        : { start: byEnd, guide: byEnd + clipDuration };
    },
    [snapEnabled, project, pixelsPerSecond],
  );

  /* ---------------- Clip gestures ---------------- */

  const beginGesture = useCallback(
    (clip: Clip, mode: ClipGesture, event: React.PointerEvent) => {
      gesture.current = { clipId: clip.id, mode, grabOffset: timeAt(event.clientX) - clip.start };
      setDragClipId(clip.id);
      document.body.style.cursor = mode === 'move' ? 'grabbing' : 'ew-resize';

      const onMove = (native: PointerEvent) => {
        const current = gesture.current;
        if (!current) return;
        const state = useEditor.getState();
        const target = state.project?.clips.find((item) => item.id === current.clipId);
        if (!target) return;

        const time = timeAt(native.clientX);

        if (current.mode === 'move') {
          const aligned = snap(time - current.grabOffset, target.duration, target.id);
          const overTrack = trackAt(native.clientY);
          setSnapGuide(aligned.guide);
          moveClip(target.id, {
            start: snapToFrame(aligned.start, fps),
            trackId: overTrack ?? target.trackId,
          });
        } else {
          const edge = current.mode === 'trim-start' ? 'start' : 'end';
          const targets = snapTargets(state.project, target.id, state.playhead);
          const tolerance = SNAP_PIXELS / state.pixelsPerSecond;
          const aligned = applySnap(time, targets, tolerance);
          setSnapGuide(Math.abs(aligned - time) > 1e-9 ? aligned : null);
          trimClip(target.id, edge, snapToFrame(aligned, fps));
        }
      };

      const onUp = () => {
        gesture.current = null;
        setDragClipId(null);
        setSnapGuide(null);
        document.body.style.removeProperty('cursor');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [timeAt, snap, fps, trackAt, moveClip, trimClip],
  );

  /* ---------------- Track reordering ---------------- */

  /**
   * Vertical drag on a track head. The reorder is applied live as the pointer
   * crosses rows — every step shares one history label, so the whole gesture
   * undoes in a single press.
   */
  const beginTrackDrag = useCallback(
    (trackId: string, event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setDraggingTrackId(trackId);
      document.body.style.cursor = 'grabbing';

      const onMove = (native: PointerEvent) => {
        const overId = trackAt(native.clientY);
        if (!overId || overId === trackId) return;
        const rows = useEditor.getState().project?.tracks ?? [];
        const target = rows.findIndex((item) => item.id === overId);
        if (target >= 0) moveTrack(trackId, target);
      };
      const onUp = () => {
        setDraggingTrackId(null);
        document.body.style.removeProperty('cursor');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [trackAt, moveTrack],
  );

  /* ---------------- Transition resize ---------------- */

  const beginTransitionResize = useCallback(
    (resolved: ResolvedTransition) => {
      const { center } = resolved;
      const junction = resolved.from !== null && resolved.to !== null;
      document.body.style.cursor = 'ew-resize';

      const apply = (clientX: number) => {
        const distance = Math.abs(timeAt(clientX) - center);
        // A junction window is centred on the cut, so the cursor describes half
        // of it; a head/tail fade runs one way only.
        setTransitionDuration(
          resolved.transition.id,
          Math.max(MIN_TRANSITION_DURATION, junction ? distance * 2 : distance),
        );
      };

      const onMove = (native: PointerEvent) => apply(native.clientX);
      const onUp = () => {
        document.body.style.removeProperty('cursor');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [timeAt, setTransitionDuration],
  );

  /* ---------------- Scrubbing ---------------- */

  const scrubTo = useCallback(
    (clientX: number) => setPlayhead(snapToFrame(timeAt(clientX), fps)),
    [setPlayhead, timeAt, fps],
  );

  /** Whether the transport was running when the scrub began. */
  const resumeAfterScrub = useRef(false);

  /**
   * Hand tool — hold space and drag to move the view.
   *
   * Claimed in the capture phase so it wins over everything underneath: over a
   * clip it must pan rather than move the clip, and over the ruler it must pan
   * rather than scrub. Panning is also what tells the transport that this
   * particular space press was not a play/pause (see `useShortcuts`).
   */
  const beginPan = useCallback(
    (event: React.PointerEvent) => {
      const node = scrollRef.current;
      if (!node || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      markSpacePan();

      const origin = {
        x: event.clientX,
        y: event.clientY,
        left: node.scrollLeft,
        top: node.scrollTop,
      };
      document.body.style.cursor = 'grabbing';

      const onMove = (native: PointerEvent) => {
        // Content follows the hand, so the scroll offset moves the other way.
        node.scrollLeft = origin.left - (native.clientX - origin.x);
        node.scrollTop = origin.top - (native.clientY - origin.y);
      };
      const onUp = () => {
        document.body.style.removeProperty('cursor');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [markSpacePan],
  );

  const beginScrub = useDrag({
    cursor: 'ew-resize',
    onStart: (event) => {
      // Scrubbing while the transport runs is a fight between two things
      // moving the playhead. Playback steps aside and picks up where the
      // scrub left it — the behaviour every editor expects.
      const state = useEditor.getState();
      resumeAfterScrub.current = state.isPlaying;
      if (state.isPlaying) state.pause();
      scrubTo(event.clientX);
    },
    onMove: ({ x }) => scrubTo(x),
    onEnd: () => {
      if (!resumeAfterScrub.current) return;
      resumeAfterScrub.current = false;
      const state = useEditor.getState();
      // Releasing on the last frame should stop there, not rewind and restart.
      if (state.playhead < projectDuration(state.project) - 1e-3) state.play();
    },
  });

  /* ---------------- Anchored zoom ---------------- */

  // The scroll offset that keeps the anchor point still, applied after the new
  // zoom has laid out — hence a layout effect rather than a plain one.
  const pendingScroll = useRef<number | null>(null);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || pendingScroll.current === null) return;
    node.scrollLeft = pendingScroll.current;
    pendingScroll.current = null;
    // Synchronous: a zoom changes which clips fall inside the window, and a
    // window that lags by a frame is a window that blinks them out.
    measure();
  }, [pixelsPerSecond, measure]);

  /**
   * Zoom that keeps `anchorTime` pinned under `anchorScreenX` — the After
   * Effects behaviour: the frame under the cursor does not move.
   */
  const zoomAnchored = useCallback(
    (factor: number, anchorTime: number, anchorScreenX: number) => {
      const node = scrollRef.current;
      if (!node) return;
      const before = useEditor.getState().pixelsPerSecond;
      const after = clamp(before * factor, MIN_PPS, MAX_PPS);
      if (Math.abs(after - before) < 1e-6) return;
      pendingScroll.current = Math.max(0, anchorTime * after + HEAD_WIDTH - anchorScreenX);
      setZoom(after);
    },
    [setZoom],
  );

  /** Toolbar and keyboard zoom pivot on the playhead, or on the view centre. */
  const zoomFromToolbar = useCallback(
    (factor: number) => {
      const node = scrollRef.current;
      if (!node) return;
      const pps = useEditor.getState().pixelsPerSecond;
      const playhead = useEditor.getState().playhead;
      const playheadScreenX = HEAD_WIDTH + playhead * pps - node.scrollLeft;

      if (playheadScreenX >= HEAD_WIDTH && playheadScreenX <= node.clientWidth) {
        zoomAnchored(factor, playhead, playheadScreenX);
        return;
      }
      // Playhead off-screen: hold the middle of the visible span instead.
      const centreScreenX = (HEAD_WIDTH + node.clientWidth) / 2;
      const centreTime = (node.scrollLeft + centreScreenX - HEAD_WIDTH) / pps;
      zoomAnchored(factor, centreTime, centreScreenX);
    },
    [zoomAnchored],
  );

  useEffect(() => {
    registerZoomAnchor(zoomFromToolbar);
    return () => registerZoomAnchor(null);
  }, [registerZoomAnchor, zoomFromToolbar]);

  /* ---------------- Wheel: zoom under the cursor, or scroll ---------------- */

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    const onWheel = (event: WheelEvent) => {
      const rect = node.getBoundingClientRect();

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const pps = useEditor.getState().pixelsPerSecond;
        const screenX = event.clientX - rect.left;
        const time = Math.max(0, (node.scrollLeft + screenX - HEAD_WIDTH) / pps);
        // Continuous factor: a trackpad pinch feels analogue rather than stepped.
        zoomAnchored(Math.exp(-event.deltaY * 0.0022), time, screenX);
        return;
      }

      // Shift converts a vertical wheel into horizontal travel; a trackpad
      // already reports deltaX and needs no help.
      if (event.shiftKey && event.deltaX === 0 && event.deltaY !== 0) {
        event.preventDefault();
        node.scrollLeft += event.deltaY;
        syncView();
      }
    };

    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [zoomAnchored, syncView]);

  const fitToWindow = () => {
    const node = scrollRef.current;
    if (!node || duration <= 0) return;
    pendingScroll.current = 0;
    setZoom((node.clientWidth - HEAD_WIDTH - 32) / duration);
  };

  const clipsByTrack = useMemo(() => {
    const map = new Map<string, Clip[]>();
    for (const clip of clips) {
      const bucket = map.get(clip.trackId);
      if (bucket) bucket.push(clip);
      else map.set(clip.trackId, [clip]);
    }
    return map;
  }, [clips]);

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-ink-900"
      style={{ '--track-head': `${HEAD_WIDTH}px` } as React.CSSProperties}
    >
      {/* Toolbar */}
      <header className="flex shrink-0 items-center gap-1 border-b border-white/[0.055] bg-ink-850/70 px-3 py-2 backdrop-blur-xl">
        <IconButton
          label={
            selectedClipIds.length > 1
              ? `Couper ${selectedClipIds.length} clips au curseur (S)`
              : 'Couper au curseur (S)'
          }
          onClick={splitAtPlayhead}
        >
          <Scissors size={14} strokeWidth={2} />
        </IconButton>
        <IconButton
          label={
            selectedClipIds.length > 1
              ? `Dupliquer ${selectedClipIds.length} clips (Ctrl + D)`
              : 'Dupliquer le clip (Ctrl + D)'
          }
          disabled={selectedClipIds.length === 0}
          onClick={() => duplicateClips(selectedClipIds)}
        >
          <Copy size={14} strokeWidth={2} />
        </IconButton>
        <IconButton
          label={
            selectedClipIds.length > 1
              ? `Supprimer ${selectedClipIds.length} clips (Suppr)`
              : 'Supprimer la sélection (Suppr)'
          }
          tone="danger"
          disabled={selectedClipIds.length === 0 && !selectedTransitionId}
          onClick={() => {
            if (selectedClipIds.length > 0) removeSelectedClips();
            else if (selectedTransitionId) removeTransition(selectedTransitionId);
          }}
        >
          <Trash2 size={14} strokeWidth={2} />
        </IconButton>

        <span className="mx-2 h-4 w-px bg-white/[0.08]" />

        <IconButton label="Aimantation (N)" active={snapEnabled} onClick={toggleSnap}>
          <Magnet size={14} strokeWidth={2} />
        </IconButton>

        <IconButton
          label="Mode animation — éditeur de courbes (G)"
          active={graphMode}
          onClick={toggleGraphMode}
        >
          <LineChart size={14} strokeWidth={2} />
        </IconButton>

        <span className="mx-2 h-4 w-px bg-white/[0.08]" />

        <button
          type="button"
          onClick={() => addTextClip()}
          title="Ajouter un calque de texte (Ctrl + ⇧ + T)"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-2xs text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white/85"
        >
          <Type size={12} strokeWidth={2.4} />
          Texte
        </button>

        <button
          type="button"
          onClick={() => addBackgroundClip()}
          title="Ajouter un fond animé — réglable dans l’inspecteur"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-2xs text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white/85"
        >
          <Palette size={12} strokeWidth={2.4} />
          Fond
        </button>

        <span className="mx-1.5 h-4 w-px bg-white/[0.08]" />

        <AiTools />

        <span className="mx-1.5 h-4 w-px bg-white/[0.08]" />

        <button
          type="button"
          onClick={() => addTrack('video')}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-2xs text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white/85"
        >
          <Plus size={12} strokeWidth={2.4} />
          Piste vidéo
        </button>
        <button
          type="button"
          onClick={() => addTrack('audio')}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-2xs text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white/85"
        >
          <Plus size={12} strokeWidth={2.4} />
          Piste audio
        </button>

        <div className="ml-auto mr-2">
          <TimecodeReadout fps={fps} />
        </div>

        <IconButton label="Dézoomer (−)" onClick={() => zoomFromToolbar(0.8)}>
          <ZoomOut size={14} strokeWidth={2} />
        </IconButton>
        <button
          type="button"
          onClick={fitToWindow}
          className="num h-8 rounded-lg px-2 text-2xs text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/80"
          title="Ajuster à la fenêtre"
        >
          {Math.round(pixelsPerSecond)} px/s
        </button>
        <IconButton label="Zoomer (+)" onClick={() => zoomFromToolbar(1.25)}>
          <ZoomIn size={14} strokeWidth={2} />
        </IconButton>
      </header>

      {/* Scrolling body */}
      <div
        ref={scrollRef}
        onScroll={syncView}
        onPointerDownCapture={spaceHeld ? beginPan : undefined}
        className={cn(
          'relative min-h-0 flex-1 overflow-auto',
          // The whole surface reads as grabbable while space is down, including
          // the parts that normally show a resize or text cursor.
          spaceHeld && 'cursor-grab [&_*]:!cursor-grab',
        )}
      >
        <div className="relative" style={{ width: HEAD_WIDTH + contentWidth }}>
          {/* Ruler row */}
          <div className="sticky top-0 z-40 flex">
            <div
              className="sticky left-0 z-50 shrink-0 border-b border-r border-white/[0.07] bg-ink-850"
              style={{ width: HEAD_WIDTH, height: RULER_HEIGHT }}
            />
            <div onPointerDown={beginScrub} className="relative cursor-ew-resize">
              <Ruler
                pixelsPerSecond={pixelsPerSecond}
                fps={fps}
                width={contentWidth}
                seconds={seconds}
                from={visible.from}
                to={visible.to}
              />
              {/* Playhead grip — lives in the ruler so the sticky head column
                  always clips it cleanly. */}
              <PlayheadGrip pixelsPerSecond={pixelsPerSecond} />
            </div>
          </div>

          {/* Track rows */}
          {graphMode && graphClip && (
            <GraphEditor
              clip={graphClip}
              pixelsPerSecond={pixelsPerSecond}
              width={contentWidth}
              height={Math.max(view.height - RULER_HEIGHT, 160)}
              headWidth={HEAD_WIDTH}
            />
          )}

          {graphMode && !graphClip && (
            <p className="px-6 py-10 text-2xs text-white/30">
              Sélectionnez un clip animé pour ouvrir sa courbe.
            </p>
          )}

          {!graphMode &&
            tracks.map((track) => {
            const unfolded = expandedClip?.trackId === track.id ? expandedClip : null;
            // Only what the viewport can show is mounted: a three-hour timeline
            // renders the same handful of nodes as a thirty-second one.
            const rows = (clipsByTrack.get(track.id) ?? []).filter(
              (clip) =>
                // What you are working on stays mounted wherever it sits: the
                // inspector, the gizmo and the curves all read from it.
                clip.id === selectedClipId ||
                clip.id === expandedClipId ||
                (clipEnd(clip) >= visible.from && clip.start <= visible.to),
            );
            const laneTransitions = (transitionsByTrack.get(track.id) ?? []).filter(
              (item) => item.end >= visible.from && item.start <= visible.to,
            );
            return (
              <Fragment key={track.id}>
              <div className="flex">
                <TrackHead
                  track={track}
                  clipCount={clipsByTrack.get(track.id)?.length ?? 0}
                  dragging={draggingTrackId === track.id}
                  anySolo={anySolo}
                  onReorderStart={(event) => beginTrackDrag(track.id, event)}
                />

                <div
                  ref={(node) => {
                    if (node) laneRefs.current.set(track.id, node);
                    else laneRefs.current.delete(track.id);
                  }}
                  onPointerDown={(event) => {
                    if (event.target !== event.currentTarget || event.button !== 0) return;
                    selectClip(null);
                    beginScrub(event);
                  }}
                  onContextMenu={(event) => {
                    // Only the empty part of the lane; a clip has its own menu.
                    if (event.target !== event.currentTarget) return;
                    openLaneMenu(event, track, snapToFrame(timeAt(event.clientX), fps));
                  }}
                  onDragOver={(event) => {
                    const types = event.dataTransfer.types;
                    if (types.includes(TRANSITION_DND_TYPE)) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'copy';
                      setDropTrackId(null);
                      setDropAnchor(
                        nearestAnchor(
                          anchors,
                          track.id,
                          timeAt(event.clientX),
                          ANCHOR_PIXELS / pixelsPerSecond,
                        ),
                      );
                      return;
                    }
                    if (!types.includes(ASSET_DND_TYPE)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'copy';
                    setDropTrackId(track.id);
                  }}
                  onDragLeave={() => {
                    setDropTrackId((id) => (id === track.id ? null : id));
                    setDropAnchor((current) =>
                      current && current.trackId === track.id ? null : current,
                    );
                  }}
                  onDrop={(event) => {
                    const types = event.dataTransfer.types;

                    if (types.includes(TRANSITION_DND_TYPE)) {
                      event.preventDefault();
                      const kind = event.dataTransfer.getData(TRANSITION_DND_TYPE) as TransitionKind;
                      const target =
                        dropAnchor?.trackId === track.id
                          ? dropAnchor
                          : nearestAnchor(
                              anchors,
                              track.id,
                              timeAt(event.clientX),
                              ANCHOR_PIXELS / pixelsPerSecond,
                            );
                      setDropAnchor(null);
                      if (target) addTransition(target, kind);
                      else notify('Déposez la transition sur un point de coupe');
                      return;
                    }

                    const assetId = event.dataTransfer.getData(ASSET_DND_TYPE);
                    setDropTrackId(null);
                    if (!assetId) return;
                    event.preventDefault();
                    addClip(assetId, {
                      trackId: track.id,
                      at: snapToFrame(timeAt(event.clientX), fps),
                    });
                  }}
                  className={cn(
                    'relative shrink-0 border-b border-white/[0.05] transition-colors duration-200',
                    track.kind === 'video' ? 'bg-white/[0.012]' : 'bg-white/[0.022]',
                    dropTrackId === track.id && 'bg-accent-500/[0.07]',
                    track.locked && 'opacity-70',
                  )}
                  style={{ width: contentWidth, height: track.height }}
                >
                  {rows.map((clip) => (
                    <TimelineClip
                      key={clip.id}
                      clip={clip}
                      track={track}
                      asset={project?.assets.find((item) => item.id === clip.assetId)}
                      thumbnail={clip.assetId ? thumbnails[clip.assetId] : undefined}
                      peaks={clip.assetId ? peaks[clip.assetId] : undefined}
                      pixelsPerSecond={pixelsPerSecond}
                      selected={selectedClipIds.includes(clip.id)}
                      dragging={dragClipId === clip.id}
                      onSelect={(additive) => selectClip(clip.id, additive)}
                      onGesture={(mode, event) => beginGesture(clip, mode, event)}
                      animated={Object.keys(clip.animation ?? {}).length > 0}
                      expanded={expandedClipId === clip.id}
                      onToggleExpand={() => toggleClipExpansion(clip.id)}
                      height={track.height}
                    />
                  ))}

                  {laneTransitions.map((item) => (
                    <TransitionBlock
                      key={item.transition.id}
                      resolved={item}
                      pixelsPerSecond={pixelsPerSecond}
                      selected={selectedTransitionId === item.transition.id}
                      onSelect={() => selectTransition(item.transition.id)}
                      onResize={() => beginTransitionResize(item)}
                    />
                  ))}

                  {/* Where a dropped transition would land. */}
                  {dropAnchor?.trackId === track.id && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-1/2 bg-accent-200 shadow-[0_0_10px_rgba(167,139,250,.9)]"
                      style={{ left: dropAnchor.time * pixelsPerSecond }}
                    />
                  )}
                </div>
              </div>

              {/* Animation channels sit directly beneath the track that holds
                  the clip they belong to, the way a layer twirls open. */}
              {unfolded &&
                orderedChannels(unfolded).map((channel) => (
                  <KeyframeLane
                    key={channel}
                    clip={unfolded}
                    channel={channel}
                    keyframes={unfolded.animation?.[channel] ?? []}
                    pixelsPerSecond={pixelsPerSecond}
                    width={contentWidth}
                  />
                ))}
              </Fragment>
            );
          })}

          {tracks.length === 0 && (
            <p className="px-6 py-10 text-2xs text-white/30">
              Aucune piste — ajoutez-en une depuis la barre d'outils.
            </p>
          )}

          {/* The alignment guide. Amber, so it never reads as the playhead. */}
          {snapGuide !== null && (
            <div
              aria-hidden
              className="pointer-events-none absolute bottom-0 z-[26] w-px bg-wave-200"
              style={{
                left: HEAD_WIDTH + snapGuide * pixelsPerSecond,
                top: RULER_HEIGHT,
                boxShadow: '0 0 8px rgba(251,191,36,.75)',
              }}
            />
          )}

          <PlayheadLine
            pixelsPerSecond={pixelsPerSecond}
            headWidth={HEAD_WIDTH}
            top={RULER_HEIGHT}
          />
        </div>
      </div>

      <PlayheadFollower
        scrollRef={scrollRef}
        pixelsPerSecond={pixelsPerSecond}
        headWidth={HEAD_WIDTH}
      />
    </section>
  );
}

/**
 * The two generated passes, sitting where the manual cut tools are.
 *
 * Deliberately in the timeline toolbar rather than only in the assistant panel:
 * both operate on the timeline, and someone reaching for "couper" should find
 * "couper intelligemment" beside it rather than inside a chat.
 */
function AiTools() {
  const openNarration = useRangeNarration(state => state.openWizard);
  const openSubtitles = useAi((state) => state.openSubtitles);
  const openSmartCut = useAi((state) => state.openSmartCut);
  const busy = useAi((state) => state.job !== null);

  const style = cn(
    'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-2xs transition-colors',
    'text-white/45 hover:bg-white/[0.06] hover:text-white/85',
    'disabled:pointer-events-none disabled:opacity-40',
  );

  return (
    <>
      <button type="button" className={style} onClick={openNarration} title="Voix off sur la plage I/O — contexte conservé dans le projet">
        <Mic size={12} strokeWidth={2.4} />
        Voix sur plage
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => openSubtitles(true)}
        title="Transcrire l’audio et poser les sous-titres sur une piste dédiée"
        className={style}
      >
        <Captions size={12} strokeWidth={2.4} />
        Sous-titres
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => openSmartCut(true)}
        title="Repérer les silences et les temps morts, puis refermer la timeline dessus"
        className={style}
      >
        <ScissorsLineDashed size={12} strokeWidth={2.4} />
        Smart cut
      </button>
    </>
  );
}
