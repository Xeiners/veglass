import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  AudioLines,
  Copy,
  Film,
  Image as ImageIcon,
  RotateCcw,
  Scissors,
  SlidersHorizontal,
  Trash2,
  Captions,
  MousePointer2,
  Palette,
  Type,
  Volume2,
  VolumeX,
  Wand2,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatBytes, formatTimecode } from '@/lib/time';
import { Button, IconButton } from '@/components/ui/Button';
import { projectDuration, useEditor } from '@/store/editorStore';
import { clipById, resolveClipAt } from '@/store/selectors';
import { resolutionLabel } from '@/types/project';
import { MIN_CLIP_DURATION } from '@/types/timeline';
import { TransitionInspector } from './inspector/TransitionInspector';
import { TextInspector } from './inspector/TextInspector';
import { BackgroundInspector } from './inspector/BackgroundInspector';
import { BannerInspector } from './inspector/BannerInspector';
import { CropInspector } from './inspector/CropInspector';
import { BackdropInspector } from './inspector/BackdropInspector';
import { AnimatableRow } from './inspector/AnimatableRow';
import { Spline } from 'lucide-react';

export function Inspector() {
  const project = useEditor((state) => state.project);
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const selectedTransitionId = useEditor((state) => state.selectedTransitionId);
  const clip = clipById(project, selectedClipId);

  const title = clip ? 'Propriétés du clip' : selectedTransitionId ? 'Transition' : 'Projet';

  return (
    <aside className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 px-4 pb-2.5 pt-4">
        <SlidersHorizontal size={13} strokeWidth={2} className="text-white/25" />
        <h2 className="eyebrow">{title}</h2>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">
        {clip ? (
          <ClipInspector clipId={clip.id} />
        ) : selectedTransitionId ? (
          <TransitionInspector transitionId={selectedTransitionId} />
        ) : (
          <ProjectInspector />
        )}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */

function ClipInspector({ clipId }: { clipId: string }) {
  const project = useEditor((state) => state.project);
  const updateClip = useEditor((state) => state.updateClip);
  const moveClip = useEditor((state) => state.moveClip);
  const trimClip = useEditor((state) => state.trimClip);
  const removeClip = useEditor((state) => state.removeClip);
  const duplicateClip = useEditor((state) => state.duplicateClip);
  const splitAtPlayhead = useEditor((state) => state.splitAtPlayhead);
  const setLeftTab = useEditor((state) => state.setLeftTab);
  const setAnimationPanel = useEditor((state) => state.setAnimationPanel);
  const playhead = useEditor((state) => state.playhead);

  const stored = clipById(project, clipId);
  // Displayed values are the *animated* ones: what the inspector shows must be
  // what the viewer shows, on this frame.
  const clip = stored ? resolveClipAt(stored, playhead) : null;
  const animated = Object.keys(stored?.animation ?? {}).length > 0;
  const asset = project?.assets.find((item) => item.id === clip?.assetId) ?? null;
  const track = project?.tracks.find((item) => item.id === clip?.trackId);
  const fps = project?.settings.fps ?? 30;

  if (!clip || !track) return null;

  const isText = clip.kind === 'text';
  const isBackground = clip.kind === 'background';
  const isBanner = clip.kind === 'banner';
  const isCursor = clip.kind === 'cursor';
  const isAudioLayer = track.kind === 'audio' || asset?.kind === 'audio';
  const Icon = isText
    ? Type
    : isCursor
      ? MousePointer2
      : isBanner
        ? Captions
      : isBackground
        ? Palette
      : asset?.kind === 'audio'
      ? AudioLines
      : asset?.kind === 'image'
        ? ImageIcon
        : Film;

  return (
    <div className="space-y-5">
      {/* Identity */}
      <div className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.022] p-2.5">
        <span
          className={cn(
            'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
            isAudioLayer ? 'bg-wave-500/[0.16] text-wave-300' : 'bg-accent-500/[0.14] text-accent-300',
          )}
        >
          <Icon size={15} strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <NameField
            value={clip.label ?? asset?.name ?? 'Calque'}
            onCommit={(label) => updateClip(clip.id, { label })}
          />
          <p className="num mt-0.5 truncate text-[10px] text-white/28">
            {[
              track.name,
              isText ? 'Texte' : null,
              isBanner ? 'Habillage' : null,
              isCursor ? 'Curseur' : null,
              isBackground ? 'Fond généré' : null,
              asset?.width && asset?.height ? `${asset.width}×${asset.height}` : null,
              asset?.size ? formatBytes(asset.size) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
      </div>

      {/* Timing */}
      <Section title="Placement">
        <TimeRow
          label="Début"
          value={clip.start}
          fps={fps}
          onChange={(value) => moveClip(clip.id, { start: Math.max(0, value) })}
        />
        <TimeRow
          label="Durée"
          value={clip.duration}
          fps={fps}
          onChange={(value) =>
            trimClip(clip.id, 'end', clip.start + Math.max(MIN_CLIP_DURATION, value))
          }
        />
        <TimeRow
          label="Point d'entrée"
          value={clip.offset}
          fps={fps}
          onChange={(value) => trimClip(clip.id, 'start', clip.start + (value - clip.offset))}
        />
        <Row label="Fin">
          <span className="num text-2xs text-white/45">
            {formatTimecode(clip.start + clip.duration, fps)}
          </span>
        </Row>
      </Section>

      {/* Framing, for anything that carries a picture from a file. Titles and
          banners compose rather than crop, and a background fills the frame by
          definition — none of the three has a subject to keep in shot. */}
      {!isAudioLayer && clip.kind === 'media' && (
        <Section title="Cadrage">
          <CropInspector clip={clip} asset={asset} />
        </Section>
      )}

      {!isAudioLayer && clip.kind === 'media' && (
        <Section title="Fond flouté">
          <BackdropInspector clip={clip} asset={asset} />
        </Section>
      )}

      {isText && clip.text && <TextInspector clipId={clip.id} layer={clip.text} />}
      {isBanner && clip.banner && <BannerInspector clipId={clip.id} layer={clip.banner} />}
      {isBackground && clip.background && (
        <BackgroundInspector clipId={clip.id} layer={clip.background} />
      )}

      {/* Spatial transform — the numeric twin of the canvas gizmo. A generated
          background covers the frame, so moving or scaling it would only
          expose the corners it exists to fill. */}
      {!isAudioLayer && !isBackground && (
        <Section
          title="Transformation"
          action={
            <ResetButton
              onClick={() =>
                updateClip(clip.id, { x: 0, y: 0, rotation: 0, scale: 1 }, { label: 'transformation' })
              }
              disabled={clip.x === 0 && clip.y === 0 && clip.rotation === 0 && clip.scale === 1}
            />
          }
        >
          <AnimatableRow
            clipId={clip.id}
            channel="x"
            label="Position X"
            value={clip.x}
            min={-2000}
            max={2000}
            step={1}
            display={`${Math.round(clip.x)} px`}
            defaultValue={0}
          />
          <AnimatableRow
            clipId={clip.id}
            channel="y"
            label="Position Y"
            value={clip.y}
            min={-2000}
            max={2000}
            step={1}
            display={`${Math.round(clip.y)} px`}
            defaultValue={0}
          />
          <AnimatableRow
            clipId={clip.id}
            channel="rotation"
            label="Rotation"
            value={clip.rotation}
            min={0}
            max={360}
            step={0.5}
            display={`${Math.round(clip.rotation)}°`}
            defaultValue={0}
          />
        </Section>
      )}

      {animated && (
        <Section title="Animation">
          <button
            type="button"
            onClick={() => setAnimationPanel(true)}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left',
              'border-white/[0.07] bg-white/[0.022] transition-all duration-200 ease-smooth',
              'hover:border-accent-500/40 hover:bg-accent-500/[0.07] active:scale-[0.99]',
            )}
          >
            <Spline size={13} strokeWidth={2} className="shrink-0 text-accent-300" />
            <span className="min-w-0 flex-1">
              <span className="block text-2xs font-medium text-white/80">
                {Object.keys(stored?.animation ?? {}).length} propriété
                {Object.keys(stored?.animation ?? {}).length > 1 ? 's animées' : ' animée'}
              </span>
              <span className="mt-0.5 block text-[10px] text-white/30">
                Courbes et images clés dans le panneau Animation
              </span>
            </span>
            <ArrowLeft size={13} strokeWidth={2} className="shrink-0 text-white/25" />
          </button>
        </Section>
      )}

      {/* Video-only */}
      {!isAudioLayer && (
        <Section
          title="Image"
          action={
            <ResetButton
              onClick={() => updateClip(clip.id, { opacity: 1, scale: 1 })}
              disabled={clip.opacity === 1 && clip.scale === 1}
            />
          }
        >
          <AnimatableRow
            clipId={clip.id}
            channel="opacity"
            label="Opacité"
            value={clip.opacity}
            min={0}
            max={1}
            step={0.01}
            display={`${Math.round(clip.opacity * 100)} %`}
            defaultValue={1}
            scale={100}
          />
          <AnimatableRow
            clipId={clip.id}
            channel="scale"
            label="Échelle"
            value={clip.scale}
            min={0.05}
            max={6}
            step={0.01}
            display={`${clip.scale.toFixed(2)}×`}
            defaultValue={1}
          />
        </Section>
      )}

      {/* The filter chain is edited in the left panel, next to its catalogue. */}
      {!isAudioLayer && (
        <Section title="Effets & filtres">
          <button
            type="button"
            onClick={() => setLeftTab('effects')}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left',
              'border-white/[0.07] bg-white/[0.022] transition-all duration-200 ease-smooth',
              'hover:border-accent-500/40 hover:bg-accent-500/[0.07] active:scale-[0.99]',
            )}
          >
            <Wand2 size={13} strokeWidth={2} className="shrink-0 text-accent-300" />
            <span className="min-w-0 flex-1">
              <span className="block text-2xs font-medium text-white/80">
                {clip.effects.length === 0
                  ? 'Aucun filtre'
                  : `${clip.effects.length} filtre${clip.effects.length > 1 ? 's' : ''} dans la chaîne`}
              </span>
              <span className="mt-0.5 block text-[10px] text-white/30">
                Réglages dans le panneau Effets, à gauche
              </span>
            </span>
            <ArrowLeft size={13} strokeWidth={2} className="shrink-0 text-white/25" />
          </button>
        </Section>
      )}

      {/* Audio — a text layer and a generated background have none. */}
      {!isText && !isBackground && (
      <Section
        title="Son"
        action={
          <IconButton
            label={clip.muted ? 'Réactiver' : 'Couper'}
            className="h-6 w-6"
            active={clip.muted}
            onClick={() => updateClip(clip.id, { muted: !clip.muted })}
          >
            {clip.muted ? <VolumeX size={11} strokeWidth={2} /> : <Volume2 size={11} strokeWidth={2} />}
          </IconButton>
        }
      >
        <AnimatableRow
          clipId={clip.id}
          channel="volume"
          label="Volume"
          value={clip.volume}
          min={0}
          max={1}
          step={0.01}
          display={`${Math.round(clip.volume * 100)} %`}
          defaultValue={1}
          scale={100}
          disabled={clip.muted}
        />
      </Section>
      )}

      {/* Actions */}
      <div className="grid grid-cols-2 gap-2 pt-1">
        <Button size="sm" icon={<Scissors size={12} strokeWidth={2} />} onClick={splitAtPlayhead}>
          Couper
        </Button>
        <Button
          size="sm"
          icon={<Copy size={12} strokeWidth={2} />}
          onClick={() => duplicateClip(clip.id)}
        >
          Dupliquer
        </Button>
        <Button
          size="sm"
          variant="danger"
          block
          className="col-span-2"
          icon={<Trash2 size={12} strokeWidth={2} />}
          onClick={() => removeClip(clip.id)}
        >
          Supprimer le clip
        </Button>
      </div>
    </div>
  );
}

function ProjectInspector() {
  const project = useEditor((state) => state.project);
  const renameProject = useEditor((state) => state.renameProject);
  const duration = projectDuration(project);

  if (!project) return null;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.022] p-3">
        <NameField value={project.name} onCommit={renameProject} className="text-[14px]" />
        <p className="num mt-1 text-[10px] text-white/28">
          Créé le {new Date(project.createdAt).toLocaleDateString('fr-FR')}
        </p>
      </div>

      <Section title="Format">
        <Row label="Résolution">
          <span className="num text-2xs text-white/60">{resolutionLabel(project.settings)}</span>
        </Row>
        <Row label="Dimensions">
          <span className="num text-2xs text-white/45">
            {project.settings.width} × {project.settings.height}
          </span>
        </Row>
        <Row label="Cadence">
          <span className="num text-2xs text-white/45">{project.settings.fps} fps</span>
        </Row>
      </Section>

      <Section title="Contenu">
        <Row label="Durée">
          <span className="num text-2xs text-white/60">
            {formatTimecode(duration, project.settings.fps)}
          </span>
        </Row>
        <Row label="Clips">
          <span className="num text-2xs text-white/45">{project.clips.length}</span>
        </Row>
        <Row label="Médias">
          <span className="num text-2xs text-white/45">{project.assets.length}</span>
        </Row>
        <Row label="Pistes">
          <span className="num text-2xs text-white/45">{project.tracks.length}</span>
        </Row>
      </Section>

      <p className="rounded-xl border border-white/[0.05] bg-white/[0.015] px-3 py-2.5 text-[11px] leading-relaxed text-white/30">
        Sélectionnez un clip sur la timeline pour ajuster son placement, son opacité et son volume.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Building blocks
 * ------------------------------------------------------------------ */

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="eyebrow">{title}</span>
        {action}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-8 items-center justify-between gap-3 rounded-lg px-2 transition-colors hover:bg-white/[0.025]">
      <span className="truncate text-2xs text-white/40">{label}</span>
      {children}
    </div>
  );
}

/** Seconds field shown as a timecode, edited as a decimal. */
function TimeRow({
  label,
  value,
  fps,
  onChange,
}: {
  label: string;
  value: number;
  fps: number;
  onChange(value: number): void;
}) {
  const [draft, setDraft] = useState(value.toFixed(2));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(value.toFixed(2));
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const parsed = Number(draft.replace(',', '.'));
    if (Number.isFinite(parsed)) onChange(parsed);
    else setDraft(value.toFixed(2));
  };

  return (
    <div className="flex h-8 items-center justify-between gap-3 rounded-lg px-2 transition-colors hover:bg-white/[0.025]">
      <span className="truncate text-2xs text-white/40">{label}</span>
      <div className="flex items-center gap-2">
        <span className="num text-[10px] text-white/22">{formatTimecode(value, fps)}</span>
        <input
          value={draft}
          onFocus={() => setEditing(true)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              setDraft(value.toFixed(2));
              setEditing(false);
              event.currentTarget.blur();
            }
          }}
          className={cn(
            'num h-6 w-[62px] rounded-md border border-white/[0.07] bg-ink-900/70 px-1.5 text-right',
            'text-2xs text-white/80 transition-colors',
            'focus:border-accent-500/45 focus:outline-none',
          )}
        />
        <span className="text-[10px] text-white/22">s</span>
      </div>
    </div>
  );
}

function NameField({
  value,
  onCommit,
  className,
}: {
  value: string;
  onCommit(value: string): void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  return (
    <input
      value={draft}
      onFocus={() => setEditing(true)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        setEditing(false);
        onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
      className={cn(
        'w-full truncate rounded-md bg-transparent px-1 py-0.5 text-2xs font-medium text-white/90',
        'transition-colors hover:bg-white/[0.04] focus:bg-white/[0.06] focus:outline-none',
        className,
      )}
    />
  );
}

function ResetButton({ onClick, disabled }: { onClick(): void; disabled?: boolean }) {
  return (
    <IconButton label="Réinitialiser" className="h-6 w-6" onClick={onClick} disabled={disabled}>
      <RotateCcw size={11} strokeWidth={2} />
    </IconButton>
  );
}
