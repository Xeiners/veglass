import { useEffect, useMemo, useRef } from 'react';
import {
  Maximize2,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  Sparkles,
  Volume2,
  VolumeX,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatTimecode } from '@/lib/time';
import { useElementSize } from '@/hooks/useElementSize';
import { IconButton } from '@/components/ui/Button';
import { Slider } from '@/components/ui/Slider';
import { projectDuration, useEditor } from '@/store/editorStore';
import { composeAt } from '@/store/selectors';
import { DEFAULT_SETTINGS, aspectRatioOf } from '@/types/project';
import { draws } from '@/types/progress';
import { exportWindow } from '@/types/export';
import { transitionDescriptor } from '@/types/transitions';
import { PreviewLayer } from './PreviewLayer';
import { Gizmo, screenToProject } from './Gizmo';
import { CropOverlay } from './CropOverlay';
import { ProgressOverlay } from './ProgressOverlay';

export function VideoPreview() {
  const project = useEditor((state) => state.project);
  const playhead = useEditor((state) => state.playhead);
  const isPlaying = useEditor((state) => state.isPlaying);
  const loopPlayback = useEditor((state) => state.loopPlayback);
  const masterVolume = useEditor((state) => state.masterVolume);
  const masterMuted = useEditor((state) => state.masterMuted);
  const previewQuality = useEditor((state) => state.previewQuality);
  const setPlayhead = useEditor((state) => state.setPlayhead);
  const togglePlay = useEditor((state) => state.togglePlay);
  const toggleLoop = useEditor((state) => state.toggleLoop);
  const setMasterVolume = useEditor((state) => state.setMasterVolume);
  const toggleMasterMute = useEditor((state) => state.toggleMasterMute);
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const cropMode = useEditor((state) => state.cropMode);
  const exportSettings = useEditor((state) => state.exportSettings);
  const workIn = useEditor((state) => state.workIn);
  const workOut = useEditor((state) => state.workOut);
  const selectClip = useEditor((state) => state.selectClip);
  /**
   * `setProperty`, not `updateClip`: on an animated channel the drag has to
   * land on a keyframe under the playhead instead of overwriting a static
   * field the animation no longer reads.
   */
  const setProperty = useEditor((state) => state.setProperty);
  const updateText = useEditor((state) => state.updateText);
  const editingTextClipId = useEditor((state) => state.editingTextClipId);
  const setEditingText = useEditor((state) => state.setEditingText);

  const { ref: stageRef, size: stageSize } = useElementSize<HTMLDivElement>();
  const fullscreenRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  const duration = projectDuration(project);
  const fps = project?.settings.fps ?? 30;
  const ratio = project ? aspectRatioOf(project.settings) : 16 / 9;

  /** Which layers to stack, their opacities, and any dip veil, at this instant. */
  const composition = useMemo(() => composeAt(project, playhead), [project, playhead]);

  // The frame is sized in pixels rather than with `aspect-ratio` so it stays
  // exact whichever dimension is the binding constraint.
  const frame = useMemo(() => {
    const padding = 48;
    const available = {
      width: Math.max(stageSize.width - padding, 0),
      height: Math.max(stageSize.height - padding, 0),
    };
    if (available.width === 0 || available.height === 0) return { width: 0, height: 0 };
    const byWidth = { width: available.width, height: available.width / ratio };
    return byWidth.height <= available.height
      ? byWidth
      : { width: available.height * ratio, height: available.height };
  }, [stageSize, ratio]);

  const requestFullscreen = () => {
    const node = fullscreenRef.current;
    if (!node) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void node.requestFullscreen().catch(() => undefined);
  };

  const resumeAfterScrub = useRef(false);

  /** The transport scrubber behaves like the timeline's: pause, then resume. */
  const holdPlayback = () => {
    const state = useEditor.getState();
    resumeAfterScrub.current = state.isPlaying;
    if (state.isPlaying) state.pause();
  };

  const releasePlayback = () => {
    if (!resumeAfterScrub.current) return;
    resumeAfterScrub.current = false;
    const state = useEditor.getState();
    if (state.playhead < duration - 1e-3) state.play();
  };

  const hasClips = (project?.clips.length ?? 0) > 0;
  const activeTransition = composition.transition;

  /**
   * Reduced quality applies to playback only — a parked frame is always shown
   * at full resolution, and the encoder never sees this value at all.
   *
   * The layer stack is laid out at `frame x quality` and scaled back up by CSS.
   * The decoder still emits full-resolution frames (only proxies would change
   * that), but the compositor fills a quarter of the pixels at 1/2 and a
   * sixteenth at 1/4 — which is where a 4K timeline actually stalls.
   */
  const quality = isPlaying ? previewQuality : 1;
  const stage = {
    width: Math.max(1, Math.round(frame.width * quality)),
    height: Math.max(1, Math.round(frame.height * quality)),
  };

  // Falls back to the app default rather than bailing: the viewer renders an
  // empty stage before a project is open, and a banner sizing itself against a
  // frame is one of the things that has to have an answer either way.
  const settings = project?.settings ?? DEFAULT_SETTINGS;
  const projectWidth = settings.width;
  /** Screen pixels per project pixel, inside the (possibly reduced) stage. */
  const unit = stage.width / projectWidth;

  /**
   * The span the progress bar fills across.
   *
   * The window the *export* will write, not the whole timeline: someone
   * exporting a work area gets a bar that runs from empty to full across that
   * slice, and the viewer has to show the same thing or the bar is the one
   * element that lies about the finished file.
   */
  const barWindow = exportWindow(duration, exportSettings, { in: workIn, out: workOut });

  const selected = composition.layers.find((layer) => layer.clip.id === selectedClipId) ?? null;
  const canManipulate = !isPlaying;

  /**
   * Click-to-select, then drag to move. The hit test is delegated to the DOM:
   * each layer wrapper carries `data-clip-id`, so rotation and text metrics are
   * already accounted for.
   */
  const onStagePointerDown = (event: React.PointerEvent) => {
    if (editingTextClipId) {
      const inside = (event.target as HTMLElement).closest(
        `[data-clip-id="${editingTextClipId}"]`,
      );
      // A click inside the field belongs to the field; anywhere else ends the
      // edit, the way clicking off a title does in any editor.
      if (inside) return;
      setEditingText(null);
    }
    if (!canManipulate || !project) return;
    const node = (event.target as HTMLElement).closest<HTMLElement>('[data-clip-id]');
    const clipId = node?.dataset.clipId;

    if (!clipId) {
      selectClip(null);
      return;
    }
    selectClip(clipId);

    // The *resolved* layer, not the stored clip: on an animated channel the
    // number on screen is the keyframed one, and starting the drag from the
    // static field would make the layer jump on the first pointer move.
    const clip = composition.layers.find((layer) => layer.clip.id === clipId)?.clip;
    if (!clip) return;

    const origin = { x: event.clientX, y: event.clientY, cx: clip.x, cy: clip.y };
    document.body.style.cursor = 'move';

    const onMove = (native: PointerEvent) => {
      let dx = screenToProject(native.clientX - origin.x, frame.width, projectWidth);
      let dy = screenToProject(native.clientY - origin.y, frame.width, projectWidth);
      // Shift constrains to the dominant axis, as in every design tool.
      if (native.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      // Two channels, two writes — `x` and `y` animate independently, so a
      // drag on a clip with only `y` keyed must not key `x` as well.
      const history = { label: `position:${clipId}`, mode: 'coalesce' } as const;
      setProperty(clipId, 'x', Math.round(origin.cx + dx), history);
      setProperty(clipId, 'y', Math.round(origin.cy + dy), history);
    };
    const onUp = () => {
      document.body.style.removeProperty('cursor');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /** Double click on a title opens it for typing. */
  const onStageDoubleClick = (event: React.MouseEvent) => {
    if (!canManipulate || !project) return;
    const node = (event.target as HTMLElement).closest<HTMLElement>('[data-clip-id]');
    const clipId = node?.dataset.clipId;
    if (!clipId) return;
    const clip = project.clips.find((item) => item.id === clipId);
    if (clip?.kind !== 'text') return;
    event.preventDefault();
    setEditingText(clipId);
  };

  // The field cannot outlive what it is editing: playback starts, the playhead
  // leaves the clip, the clip is deleted — the edit closes on its own.
  useEffect(() => {
    if (!editingTextClipId) return;
    const onScreen = composition.layers.some(
      (layer) => layer.clip.id === editingTextClipId,
    );
    if (isPlaying || !onScreen) setEditingText(null);
  }, [editingTextClipId, composition.layers, isPlaying, setEditingText]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={(node) => {
          stageRef.current = node;
          fullscreenRef.current = node;
        }}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6"
      >
        <div
          ref={frameRef}
          onPointerDown={onStagePointerDown}
          onDoubleClick={onStageDoubleClick}
          className={cn(
            'relative overflow-hidden rounded-xl bg-black',
            'shadow-[0_32px_80px_-32px_rgba(0,0,0,1)] ring-1 ring-white/[0.07]',
          )}
          style={{ width: frame.width || undefined, height: frame.height || undefined }}
        >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{
              width: stage.width,
              height: stage.height,
              transform: quality === 1 ? undefined : `scale(${1 / quality})`,
            }}
          >
            {/* Keyed by clip id so a layer survives being reordered when a
                dissolve ends and the incoming clip becomes the only one left. */}
            {composition.layers.map((layer) => (
              <PreviewLayer
                key={layer.clip.id}
                spec={layer}
                unit={unit}
                settings={settings}
                time={playhead}
                interactive={canManipulate}
                isPlaying={isPlaying}
                masterVolume={masterVolume}
                masterMuted={masterMuted}
                editing={editingTextClipId === layer.clip.id}
                onChangeText={(content) =>
                  // One history entry per burst of typing, not one per letter.
                  updateText(layer.clip.id, { content })
                }
                onExitEdit={() => setEditingText(null)}
              />
            ))}

            {composition.veilColor && composition.veilOpacity > 0 && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  backgroundColor: composition.veilColor,
                  opacity: composition.veilOpacity,
                }}
              />
            )}
          </div>

          {composition.layers.length === 0 && composition.veilOpacity === 0 && (
            <EmptyStage hasClips={hasClips} />
          )}

          {/* Safe-area guides, only while parked. */}
          {!isPlaying && composition.layers.length > 0 && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-[6%] rounded-sm border border-white/[0.07]"
            />
          )}

          {/* The bar spans the window the export will actually write, which is
              why it reads the range and the work area rather than the whole
              timeline — see `exportWindow`, whose Rust twin the encoder uses. */}
          {draws(project?.progress) && (
            <ProgressOverlay
              bar={project.progress}
              settings={settings}
              unit={unit}
              time={playhead}
              from={barWindow.from}
              to={barWindow.to}
            />
          )}

          {/* Framing mode owns the pointer while it is on: the gizmo and the
              crop handle would otherwise fight over the same drag, and the
              transform handles are the wrong tool for choosing a subject. */}
          {cropMode && <CropOverlay target={null} unit={unit} settings={settings} />}

          {/* The handles would only get in the way of the caret. */}
          {selected && canManipulate && !cropMode && editingTextClipId !== selected.clip.id && (
            <Gizmo
              stageRef={frameRef}
              clip={selected.clip}
              frameWidth={frame.width}
              viewScale={frame.width > 0 ? frame.width / stage.width : 1}
            />
          )}

          {editingTextClipId && (
            <span className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md border border-white/[0.12] bg-ink-950/80 px-2.5 py-1 text-[10px] text-white/60 backdrop-blur">
              Échap pour terminer
            </span>
          )}

          {quality < 1 && (
            <span className="num pointer-events-none absolute right-3 top-3 rounded-md border border-white/[0.12] bg-ink-950/70 px-2 py-1 text-[10px] text-white/60 backdrop-blur">
              Aperçu {quality === 0.5 ? '1/2' : '1/4'}
            </span>
          )}

          {activeTransition && (
            <span className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-md border border-white/[0.12] bg-ink-950/70 px-2 py-1 text-[10px] text-white/70 backdrop-blur">
              <Sparkles size={10} strokeWidth={2.2} className="text-accent-300" />
              {transitionDescriptor(activeTransition.transition.kind).label}
            </span>
          )}
        </div>
      </div>

      {/* Transport */}
      <div className="shrink-0 border-t border-white/[0.055] bg-ink-850/60 px-4 py-3 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <IconButton label="Début (Home)" onClick={() => setPlayhead(0)}>
            <SkipBack size={15} strokeWidth={2} />
          </IconButton>

          <button
            type="button"
            onClick={togglePlay}
            aria-label={isPlaying ? 'Pause (Espace)' : 'Lecture (Espace)'}
            className={cn(
              'grid h-10 w-10 shrink-0 place-items-center rounded-full',
              'bg-accent-500 text-white shadow-glow',
              'transition-all duration-200 ease-smooth hover:bg-accent-400 active:scale-95',
            )}
          >
            {isPlaying ? (
              <Pause size={16} strokeWidth={2.6} fill="currentColor" />
            ) : (
              <Play size={16} strokeWidth={2.6} fill="currentColor" className="ml-0.5" />
            )}
          </button>

          <IconButton label="Fin (End)" onClick={() => setPlayhead(duration)}>
            <SkipForward size={15} strokeWidth={2} />
          </IconButton>

          <div className="num ml-1 flex items-baseline gap-1.5 tabular-nums">
            <span className="text-[13px] font-medium tracking-tight text-white">
              {formatTimecode(playhead, fps)}
            </span>
            <span className="text-2xs text-white/25">/ {formatTimecode(duration, fps)}</span>
          </div>

          <div
            className="mx-2 flex-1"
            onPointerDown={holdPlayback}
            onPointerUp={releasePlayback}
            onPointerCancel={releasePlayback}
          >
            <Slider
              aria-label="Position de lecture"
              value={duration > 0 ? Math.min(playhead, duration) : 0}
              min={0}
              max={Math.max(duration, 0.001)}
              step={1 / fps}
              onChange={setPlayhead}
            />
          </div>

          <IconButton label="Lecture en boucle (L)" active={loopPlayback} onClick={toggleLoop}>
            <Repeat size={14} strokeWidth={2} />
          </IconButton>

          <div className="group flex items-center gap-2">
            <IconButton
              label={masterMuted ? 'Réactiver le son (M)' : 'Couper le son (M)'}
              onClick={toggleMasterMute}
            >
              {masterMuted ? (
                <VolumeX size={15} strokeWidth={2} />
              ) : (
                <Volume2 size={15} strokeWidth={2} />
              )}
            </IconButton>
            <div className="w-[72px]">
              <Slider
                aria-label="Volume général"
                value={masterMuted ? 0 : masterVolume}
                onChange={setMasterVolume}
              />
            </div>
          </div>

          <IconButton label="Plein écran" onClick={requestFullscreen}>
            <Maximize2 size={14} strokeWidth={2} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function EmptyStage({ hasClips }: { hasClips: boolean }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-ink-950">
      <div className="flex flex-col items-center gap-2.5 px-8 text-center">
        <span className="grid h-11 w-11 place-items-center rounded-xl border border-white/[0.07] bg-white/[0.02]">
          <Play size={16} strokeWidth={1.8} className="ml-0.5 text-white/25" />
        </span>
        <p className="text-[13px] text-white/40">
          {hasClips ? 'Aucun clip sous le curseur' : 'La preview attend un premier clip'}
        </p>
        <p className="max-w-[260px] text-2xs leading-relaxed text-white/25">
          {hasClips
            ? 'Déplacez le curseur de lecture sur un bloc de la timeline.'
            : 'Importez un média puis glissez-le sur une piste.'}
        </p>
      </div>
    </div>
  );
}
