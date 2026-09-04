import { useRef } from 'react';
import { AudioLines, FileSearch, Film, Image as ImageIcon, Search } from 'lucide-react';

import { cn } from '@/lib/cn';
import { isTauri } from '@/lib/env';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useEditor } from '@/store/editorStore';
import { IMPORT_EXTENSIONS, extensionOf, type MediaKind } from '@/types/media';

const KIND_ICON: Record<MediaKind, typeof Film> = {
  video: Film,
  audio: AudioLines,
  image: ImageIcon,
};

/**
 * Shown when the automatic search could not find a file.
 *
 * Locating one file is usually enough: its folder becomes a hint and the rest
 * of the batch is resolved in the same pass, because media that moved together
 * almost always still sits together.
 */
export function RelinkDialog() {
  const open = useEditor((state) => state.relinkOpen);
  const project = useEditor((state) => state.project);
  const missingIds = useEditor((state) => state.missingAssetIds);
  const busy = useEditor((state) => state.busy);
  const closeRelink = useEditor((state) => state.closeRelink);
  const retryRelink = useEditor((state) => state.retryRelink);
  const relinkFromPath = useEditor((state) => state.relinkFromPath);
  const relinkFromFiles = useEditor((state) => state.relinkFromFiles);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const missing = (project?.assets ?? []).filter((asset) => missingIds.includes(asset.id));

  if (!open || missing.length === 0) return null;

  const locate = async (assetId: string, name: string) => {
    const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
    const extension = extensionOf(name);
    const picked = await openDialog({
      multiple: false,
      title: `Localiser « ${name} »`,
      filters: [
        { name: 'Média', extensions: extension ? [extension] : IMPORT_EXTENSIONS },
      ],
    });
    if (typeof picked === 'string') await relinkFromPath(assetId, picked);
  };

  const browseFolder = async () => {
    const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: 'Dossier à explorer',
    });
    if (typeof picked === 'string') await retryRelink([picked]);
  };

  return (
    <Modal
      open={open}
      onClose={closeRelink}
      width="md"
      title={`${missing.length} média${missing.length > 1 ? 's introuvables' : ' introuvable'}`}
      description="Veglass a cherché ces fichiers autour de leur emplacement d'origine sans les trouver. Indiquez-en un seul — les autres suivront s'ils sont dans le même dossier."
      footer={
        <>
          <Button variant="ghost" onClick={closeRelink}>
            Continuer sans
          </Button>
          {isTauri() ? (
            <Button
              variant="primary"
              disabled={busy}
              icon={<Search size={14} strokeWidth={2.2} />}
              onClick={() => void browseFolder()}
            >
              {busy ? 'Recherche…' : 'Explorer un dossier'}
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<Search size={14} strokeWidth={2.2} />}
              onClick={() => inputRef.current?.click()}
            >
              Sélectionner les fichiers
            </Button>
          )}
        </>
      }
    >
      <ul className="space-y-1.5 pb-2">
        {missing.map((asset) => {
          const Icon = KIND_ICON[asset.kind];
          return (
            <li
              key={asset.id}
              className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.022] p-2.5"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-red-500/12 text-red-300/80">
                <Icon size={13} strokeWidth={2} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-2xs font-medium text-white/85">
                  {asset.name}
                </span>
                <span className="num mt-0.5 block truncate text-[10px] text-white/28">
                  {asset.path ?? 'Aucun chemin enregistré'}
                </span>
              </span>
              {isTauri() && (
                <Button
                  size="sm"
                  className="shrink-0"
                  icon={<FileSearch size={12} strokeWidth={2} />}
                  onClick={() => void locate(asset.id, asset.name)}
                >
                  Localiser
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {!isTauri() && (
        <p
          className={cn(
            'mb-2 rounded-xl border border-white/[0.05] bg-white/[0.015] px-3 py-2.5',
            'text-[11px] leading-relaxed text-white/32',
          )}
        >
          En mode navigateur, les médias sont référencés par URL temporaire et ne survivent pas au
          rechargement. Re-sélectionnez les fichiers : ils seront rattachés par nom.
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        className="hidden"
        onChange={(event) => {
          const files = event.target.files;
          if (files) relinkFromFiles(Array.from(files));
          event.target.value = '';
        }}
      />
    </Modal>
  );
}
