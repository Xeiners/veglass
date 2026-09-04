import {
  AudioLines,
  Eye,
  EyeOff,
  Film,
  GripVertical,
  Headphones,
  Lock,
  LockOpen,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react';

import { useRef } from 'react';

import { cn } from '@/lib/cn';
import { IconButton } from '@/components/ui/Button';
import { useTrackMenu } from '@/components/editor/contextMenus';
import { TrackMeter } from '@/components/editor/TrackMeter';
import { useDrag } from '@/hooks/useDrag';
import { DEFAULT_TRACK_HEIGHT } from '@/types/timeline';

const MIN_TRACK_HEIGHT = 34;
const MAX_TRACK_HEIGHT = 240;
const DEFAULT_AUDIO_HEIGHT = 54;
import { useEditor } from '@/store/editorStore';
import type { Track } from '@/types/timeline';

export function TrackHead({
  track,
  clipCount,
  dragging,
  anySolo,
  onReorderStart,
}: {
  anySolo: boolean;
  track: Track;
  clipCount: number;
  dragging: boolean;
  onReorderStart(event: React.PointerEvent): void;
}) {
  const patchTrack = useEditor((state) => state.patchTrack);
  const removeTrack = useEditor((state) => state.removeTrack);
  const toggleSolo = useEditor((state) => state.toggleTrackSolo);
  const openMenu = useTrackMenu();
  const isVideo = track.kind === 'video';

  // Row height is a comfort setting, so it is stored on the track and travels
  // with the project rather than living in a per-machine preference.
  const startHeight = useRef(track.height);
  const resize = useDrag({
    cursor: 'ns-resize',
    onStart: () => {
      startHeight.current = track.height;
    },
    onMove: ({ dy }) =>
      patchTrack(
        track.id,
        {
          height: Math.max(
            MIN_TRACK_HEIGHT,
            Math.min(MAX_TRACK_HEIGHT, Math.round(startHeight.current + dy)),
          ),
        },
        { label: `hauteur:${track.id}`, mode: 'coalesce' },
      ),
  });

  return (
    <div
      className={cn(
        'group/head sticky left-0 z-30 flex shrink-0 flex-col justify-center gap-1.5',
        'relative',
        'border-b border-r border-white/[0.05] bg-ink-850 pl-1.5 pr-3',
        'transition-colors duration-150',
        dragging && 'bg-accent-500/[0.14] ring-1 ring-inset ring-accent-400/40',
      )}
      style={{ width: 'var(--track-head)', height: track.height }}
      data-silenced={!isVideo && anySolo && !track.solo ? '' : undefined}
      onContextMenu={(event) => openMenu(event, track)}
    >
      {/* Bottom edge doubles as a height grip. */}
      <span
        onPointerDown={resize}
        onDoubleClick={() =>
          patchTrack(track.id, {
            height: isVideo ? DEFAULT_TRACK_HEIGHT : DEFAULT_AUDIO_HEIGHT,
          })
        }
        title="Glisser pour changer la hauteur · double-clic pour la valeur par défaut"
        className="absolute inset-x-0 bottom-0 z-10 h-1.5 cursor-ns-resize transition-colors hover:bg-accent-500/40"
      />
      <div className="flex items-center gap-1.5">
        {/* Drag handle — the list order *is* the compositing order. */}
        <span
          onPointerDown={onReorderStart}
          title="Glisser pour changer l’ordre des calques"
          className={cn(
            'grid h-5 w-3.5 shrink-0 cursor-grab place-items-center rounded text-white/20',
            'transition-colors hover:text-white/60 active:cursor-grabbing',
          )}
        >
          <GripVertical size={12} strokeWidth={2} />
        </span>

        <span
          className={cn(
            'grid h-5 w-5 shrink-0 place-items-center rounded-md',
            isVideo ? 'bg-accent-500/[0.14] text-accent-300' : 'bg-wave-500/[0.16] text-wave-300',
          )}
        >
          {isVideo ? <Film size={11} strokeWidth={2.2} /> : <AudioLines size={11} strokeWidth={2.2} />}
        </span>

        <span className="num truncate text-2xs font-semibold tracking-tight text-white/75">
          {track.name}
        </span>

        {!isVideo && track.height >= 44 && (
          <TrackMeter trackId={track.id} className="ml-auto w-10 shrink-0" />
        )}
        <span
          className={cn(
            'num text-[10px] text-white/22',
            isVideo || track.height < 44 ? 'ml-auto' : '',
          )}
        >
          {clipCount}
        </span>

        <IconButton
          label="Supprimer la piste"
          tone="danger"
          className="h-6 w-6 opacity-0 transition-opacity group-hover/head:opacity-100"
          onClick={() => removeTrack(track.id)}
        >
          <Trash2 size={11} strokeWidth={2} />
        </IconButton>
      </div>

      <div className="ml-[22px] flex items-center gap-0.5">
        <IconButton
          label={track.muted ? 'Réactiver la piste' : 'Muter la piste'}
          className="h-6 w-6"
          active={track.muted}
          onClick={() => patchTrack(track.id, { muted: !track.muted })}
        >
          {track.muted ? <VolumeX size={11} strokeWidth={2} /> : <Volume2 size={11} strokeWidth={2} />}
        </IconButton>

        {isVideo && (
          <IconButton
            label={track.hidden ? 'Afficher la piste' : 'Masquer la piste'}
            className="h-6 w-6"
            active={track.hidden}
            onClick={() => patchTrack(track.id, { hidden: !track.hidden })}
          >
            {track.hidden ? <EyeOff size={11} strokeWidth={2} /> : <Eye size={11} strokeWidth={2} />}
          </IconButton>
        )}

        {!isVideo && (
          <button
            type="button"
            onClick={() => toggleSolo(track.id)}
            title="Solo"
            className={cn(
              'grid h-6 w-6 place-items-center rounded-lg transition-all duration-200',
              track.solo
                ? 'bg-wave-500/25 text-wave-300 shadow-[inset_0_0_0_1px_rgba(251,191,36,.35)]'
                : 'text-white/35 hover:bg-white/[0.07] hover:text-white/80',
            )}
          >
            <Headphones size={11} strokeWidth={2.2} />
          </button>
        )}

        <IconButton
          label={track.locked ? 'Déverrouiller' : 'Verrouiller'}
          className="h-6 w-6"
          active={track.locked}
          onClick={() => patchTrack(track.id, { locked: !track.locked })}
        >
          {track.locked ? <Lock size={11} strokeWidth={2} /> : <LockOpen size={11} strokeWidth={2} />}
        </IconButton>
      </div>
    </div>
  );
}
