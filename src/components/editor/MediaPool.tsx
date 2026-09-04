import { useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  FileWarning,
  Film,
  Image as ImageIcon,
  Plus,
  Search,
  GraduationCap,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatBytes, formatClock } from '@/lib/time';
import { Button, IconButton } from '@/components/ui/Button';
import { useEditor } from '@/store/editorStore';
import { useViral } from '@/store/viralStore';
import { useTutorial } from '@/store/tutorialStore';
import { useAssetMenu } from '@/components/editor/contextMenus';
import type { MediaAsset, MediaKind } from '@/types/media';

export const ASSET_DND_TYPE = 'application/x-veglass-asset';

const KIND_ICON: Record<MediaKind, typeof Film> = {
  video: Film,
  audio: AudioLines,
  image: ImageIcon,
};

export function MediaPool() {
  const project = useEditor((state) => state.project);
  const thumbnails = useEditor((state) => state.thumbnails);
  const selectedAssetId = useEditor((state) => state.selectedAssetId);
  const openViral = useViral((state) => state.openWizard);
  const openTutorial = useTutorial((state) => state.openWizard);
  const importFiles = useEditor((state) => state.importFiles);
  const importFromDialog = useEditor((state) => state.importFromDialog);
  const removeAsset = useEditor((state) => state.removeAsset);
  const selectAsset = useEditor((state) => state.selectAsset);
  const addClip = useEditor((state) => state.addClip);

  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const depth = useRef(0);

  const assets = project?.assets ?? [];

  // Start the wizard on the selected media when that selection is a video,
  // so the common path — pick the recording, press the button — skips step one.
  const selectedVideoId =
    assets.find((asset) => asset.id === selectedAssetId && asset.kind === 'video' && !asset.missing)
      ?.id ?? null;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return assets;
    return assets.filter((asset) => asset.name.toLowerCase().includes(needle));
  }, [assets, query]);

  const handleFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    void importFiles(Array.from(list));
  };

  return (
    <section
      className="relative flex h-full min-h-0 flex-col"
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        depth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        depth.current = 0;
        setDragging(false);
        handleFiles(event.dataTransfer.files);
      }}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 px-4 pb-2.5 pt-4">
        <div className="flex items-baseline gap-2">
          <h2 className="eyebrow">Médias</h2>
          {assets.length > 0 && <span className="num text-2xs text-white/22">{assets.length}</span>}
        </div>
        <IconButton label="Importer des fichiers" onClick={() => void importFromDialog()}>
          <Plus size={15} strokeWidth={2.2} />
        </IconButton>
      </header>

      {assets.length > 3 && (
        <div className="shrink-0 px-4 pb-2.5">
          <div className="relative">
            <Search
              size={13}
              strokeWidth={2}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-white/25"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filtrer…"
              className={cn(
                'h-8 w-full rounded-lg border border-white/[0.06] bg-white/[0.02] pl-8 pr-2.5',
                'text-2xs text-white/80 placeholder:text-white/25',
                'transition-colors focus:border-accent-500/40 focus:bg-white/[0.04] focus:outline-none',
              )}
            />
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {assets.length === 0 ? (
          <DropHint onBrowse={() => inputRef.current?.click()} onNative={() => void importFromDialog()} />
        ) : filtered.length === 0 ? (
          <p className="px-2 py-8 text-center text-2xs text-white/28">Aucun média ne correspond</p>
        ) : (
          <ul className="space-y-1">
            {filtered.map((asset) => (
              <AssetRow
                key={asset.id}
                asset={asset}
                thumbnail={thumbnails[asset.id]}
                selected={selectedAssetId === asset.id}
                onSelect={() => selectAsset(asset.id)}
                onAdd={() => addClip(asset.id)}
                onRemove={() => removeAsset(asset.id)}
              />
            ))}
          </ul>
        )}
      </div>

      {assets.length > 0 && (
        <div className="shrink-0 space-y-2 border-t border-white/[0.05] p-3">
          {/* Offered only when there is something to mine: the generator works
              from what is said, so a pool of images and music has no source. */}
          {assets.some((asset) => asset.kind === 'video' && !asset.missing) && (
            <Button
              variant="secondary"
              size="sm"
              block
              icon={<Sparkles size={13} strokeWidth={2} />}
              onClick={() => openViral(selectedVideoId ?? undefined)}
            >
              Générer des clips viraux
            </Button>
          )}
          {assets.some((asset) => asset.kind === 'video' && !asset.missing) && (
            <Button
              variant="secondary"
              size="sm"
              block
              icon={<GraduationCap size={13} strokeWidth={2} />}
              onClick={() => openTutorial(selectedVideoId ?? undefined)}
            >
              Monter un tutoriel
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            block
            icon={<Upload size={13} strokeWidth={2} />}
            onClick={() => void importFromDialog()}
          >
            Importer
          </Button>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        accept="video/*,audio/*,image/*,.svg"
        className="hidden"
        onChange={(event) => {
          handleFiles(event.target.files);
          event.target.value = '';
        }}
      />

      {/* Drop overlay */}
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-20 grid animate-fade-in place-items-center rounded-xl border-2 border-dashed border-accent-500/55 bg-accent-500/[0.07] backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-accent-300">
            <Upload size={20} strokeWidth={2} />
            <span className="text-[13px] font-medium">Déposez pour importer</span>
          </div>
        </div>
      )}
    </section>
  );
}

function AssetRow({
  asset,
  thumbnail,
  selected,
  onSelect,
  onAdd,
  onRemove,
}: {
  asset: MediaAsset;
  thumbnail?: string;
  selected: boolean;
  onSelect(): void;
  onAdd(): void;
  onRemove(): void;
}) {
  const Icon = KIND_ICON[asset.kind];
  const openMenu = useAssetMenu();

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onContextMenu={(event) => openMenu(event, asset)}
        draggable={!asset.missing}
        onDragStart={(event) => {
          event.dataTransfer.setData(ASSET_DND_TYPE, asset.id);
          event.dataTransfer.effectAllowed = 'copy';
        }}
        onClick={onSelect}
        onDoubleClick={onAdd}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onAdd();
        }}
        className={cn(
          'group flex cursor-grab items-center gap-2.5 rounded-xl border p-1.5 pr-2',
          'transition-all duration-200 ease-smooth active:cursor-grabbing',
          selected
            ? 'border-accent-500/35 bg-accent-500/[0.07]'
            : 'border-transparent hover:border-white/[0.08] hover:bg-white/[0.035]',
          asset.missing && 'opacity-55',
        )}
      >
        {/* Thumbnail */}
        <div className="relative h-11 w-[68px] shrink-0 overflow-hidden rounded-lg bg-ink-950 ring-1 ring-white/[0.06]">
          {thumbnail ? (
            <img src={thumbnail} alt="" className="h-full w-full object-cover drag-none" />
          ) : (
            <span className="grid h-full w-full place-items-center">
              {asset.missing ? (
                <FileWarning size={14} strokeWidth={1.8} className="text-red-400/70" />
              ) : (
                <Icon size={14} strokeWidth={1.8} className="text-white/22" />
              )}
            </span>
          )}
          {asset.kind !== 'image' && asset.duration > 0 && (
            <span className="num absolute bottom-0.5 right-0.5 rounded bg-ink-950/85 px-1 text-[9px] leading-[13px] text-white/60">
              {formatClock(asset.duration)}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-2xs font-medium text-white/85">{asset.name}</p>
          <p className="num mt-0.5 truncate text-[10px] text-white/30">
            {asset.missing
              ? 'Fichier introuvable'
              : [
                  asset.kind === 'video' ? 'Vidéo' : asset.kind === 'audio' ? 'Audio' : 'Image',
                  asset.width && asset.height ? `${asset.width}×${asset.height}` : null,
                  asset.size ? formatBytes(asset.size) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </p>
        </div>

        <div className="flex shrink-0 items-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          {!asset.missing && (
            <IconButton
              label="Ajouter à la timeline"
              className="h-7 w-7"
              onClick={(event) => {
                event.stopPropagation();
                onAdd();
              }}
            >
              <Plus size={13} strokeWidth={2.4} />
            </IconButton>
          )}
          <IconButton
            label="Retirer du projet"
            tone="danger"
            className="h-7 w-7"
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
          >
            <Trash2 size={12} strokeWidth={2} />
          </IconButton>
        </div>
      </div>
    </li>
  );
}

function DropHint({ onBrowse, onNative }: { onBrowse(): void; onNative(): void }) {
  return (
    <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-3 px-4 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl border border-dashed border-white/[0.12] bg-white/[0.02]">
        <Upload size={17} strokeWidth={1.8} className="text-white/30" />
      </span>
      <div>
        <p className="text-[13px] font-medium text-white/70">Glissez vos médias ici</p>
        <p className="mt-1 text-2xs leading-relaxed text-white/30">
          Vidéo, audio ou image — directement depuis votre bureau.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Button size="sm" onClick={onNative}>
          Parcourir…
        </Button>
        <button
          type="button"
          onClick={onBrowse}
          className="text-[10px] text-white/25 underline-offset-2 transition-colors hover:text-white/50 hover:underline"
        >
          Sélecteur du navigateur
        </button>
      </div>
    </div>
  );
}
