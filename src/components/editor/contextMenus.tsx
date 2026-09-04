import { useCallback } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Blend,
  Captions,
  ChevronDown,
  ChevronRight,
  Clipboard,
  ClipboardPaste,
  Copy,
  Droplet,
  Eye,
  EyeOff,
  Film,
  GraduationCap,
  ListPlus,
  Lock,
  LockOpen,
  Maximize2,
  Move,
  RotateCw,
  Scissors,
  SeparatorHorizontal,
  Sparkles,
  Sunrise,
  Sunset,
  Trash2,
  Type,
  Volume2,
  VolumeX,
} from 'lucide-react';

import { useEditor } from '@/store/editorStore';
import { useViral } from '@/store/viralStore';
import { useTutorial } from '@/store/tutorialStore';
import type { ResolvedTransition } from '@/store/selectors';
import type { MenuItem } from '@/components/ui/ContextMenu';
import type { Keyframe } from '@/types/animation';
import type { MediaAsset } from '@/types/media';
import type { Project } from '@/types/project';
import { TRANSITIONS, transitionDescriptor } from '@/types/transitions';
import type { Clip, Track } from '@/types/timeline';
import { Diamond } from '@/components/editor/inspector/AnimatableRow';

/**
 * Menu builders, one per surface.
 *
 * Each is a hook so it can reach the store's actions directly; the component
 * that owns the surface only has to forward the pointer event. Keeping them
 * together makes the vocabulary consistent — the same verb means the same thing
 * whichever object it is invoked on.
 */

const ANIMATABLE: { channel: string; label: string; icon: JSX.Element }[] = [
  { channel: 'x', label: 'Position X', icon: <Move size={12} strokeWidth={2} /> },
  { channel: 'y', label: 'Position Y', icon: <Move size={12} strokeWidth={2} /> },
  { channel: 'scale', label: 'Échelle', icon: <Maximize2 size={12} strokeWidth={2} /> },
  { channel: 'rotation', label: 'Rotation', icon: <RotateCw size={12} strokeWidth={2} /> },
  { channel: 'opacity', label: 'Opacité', icon: <Droplet size={12} strokeWidth={2} /> },
];

/** Opens a menu at the event, suppressing any menu underneath it. */
function useOpener() {
  const open = useEditor((state) => state.openContextMenu);
  return useCallback(
    (event: React.MouseEvent, items: MenuItem[]) => {
      event.preventDefault();
      event.stopPropagation();
      open(event.clientX, event.clientY, items);
    },
    [open],
  );
}

/* ------------------------------------------------------------------ clip */

/** Whether a clip's source is something the viral generator can read. */
function isVideoAsset(project: Project | null, assetId: string): boolean {
  const asset = project?.assets.find((item) => item.id === assetId);
  return Boolean(asset && asset.kind === 'video' && !asset.missing);
}

export function useClipMenu() {
  const openAt = useOpener();
  const store = useEditor;

  return useCallback(
    (event: React.MouseEvent, clip: Clip, track: Track) => {
      const store0 = store.getState();
      // Right-clicking inside an existing multi-selection acts on the whole
      // group; right-clicking outside it starts a fresh, single selection.
      if (!store0.selectedClipIds.includes(clip.id)) store0.selectClip(clip.id);

      const state = store.getState();
      const targets = state.selectedClipIds;
      const many = targets.length > 1;
      const suffix = many ? ` (${targets.length})` : '';

      const isText = clip.kind === 'text';
      const expanded = state.expandedClipId === clip.id;
      const animated = Object.keys(clip.animation ?? {}).length > 0;

      const items: MenuItem[] = [
        {
          id: 'key-all',
          label: 'Poser une image clé',
          shortcut: 'K',
          disabled: !animated,
          icon: <Diamond filled />,
          onSelect: () => state.keyAllChannels(clip.id),
        },
        {
          id: 'ask',
          label: many ? `Demander une modification (${targets.length})` : 'Demander une modification',
          icon: <Sparkles size={12} strokeWidth={2} />,
          // The selection is already set above; the assistant reads it from the
          // store, so bringing the panel forward is the whole handoff.
          onSelect: () => state.setRightTab('assistant'),
        },
        // The generator mines a whole recording, not a cut of one: it opens on
        // the clip's *source*, which is why this reads "de ce média".
        ...(!many && clip.kind === 'media' && clip.assetId
          ? ([
              {
                id: 'viral',
                label: 'Générer des clips viraux de ce média…',
                icon: <Sparkles size={12} strokeWidth={2} />,
                disabled: !isVideoAsset(state.project, clip.assetId),
                onSelect: () => useViral.getState().openWizard(clip.assetId ?? undefined),
              },
              {
                id: 'tutorial',
                label: 'Monter un tutoriel de ce média…',
                icon: <GraduationCap size={12} strokeWidth={2} />,
                disabled: !isVideoAsset(state.project, clip.assetId),
                onSelect: () => useTutorial.getState().openWizard(clip.assetId ?? undefined),
              },
            ] as MenuItem[])
          : []),
        // Editing `entrance` or `travel` deliberately leaves existing keyframes
        // alone, so this is the explicit way to ask for them to be redone.
        ...(!many && clip.kind === 'banner'
          ? ([
              {
                id: 'restage',
                label: 'Recomposer l’arrivée',
                icon: <Captions size={12} strokeWidth={2} />,
                onSelect: () => state.restageBanner(clip.id),
              },
            ] as MenuItem[])
          : []),
        { separator: true },
        {
          id: 'copy',
          label: `Copier${suffix}`,
          shortcut: 'Ctrl + C',
          icon: <Clipboard size={12} strokeWidth={2} />,
          onSelect: () => state.copyClips(targets),
        },
        {
          id: 'paste',
          label: 'Coller au curseur',
          shortcut: 'Ctrl + V',
          disabled: !state.clipClipboard,
          icon: <ClipboardPaste size={12} strokeWidth={2} />,
          onSelect: () => state.pasteClips(),
        },
        { separator: true },
        {
          id: 'split',
          label: `Couper au curseur${suffix}`,
          shortcut: 'S',
          icon: <Scissors size={12} strokeWidth={2} />,
          onSelect: () => state.splitAtPlayhead(),
        },
        {
          id: 'duplicate',
          label: `Dupliquer${suffix}`,
          shortcut: 'Ctrl + D',
          icon: <Copy size={12} strokeWidth={2} />,
          onSelect: () => state.duplicateClips(targets),
        },
        {
          id: 'delete',
          label: `Supprimer${suffix}`,
          shortcut: 'Suppr',
          danger: true,
          icon: <Trash2 size={12} strokeWidth={2} />,
          onSelect: () => state.removeSelectedClips(),
        },
      ];

      if (animated && !many) {
        items.push({ separator: true });
        items.push({
          id: 'expand',
          label: expanded ? 'Replier les propriétés' : 'Déplier les propriétés',
          icon: expanded ? (
            <ChevronDown size={12} strokeWidth={2} />
          ) : (
            <ChevronRight size={12} strokeWidth={2} />
          ),
          onSelect: () => state.toggleClipExpansion(clip.id),
        });
      }

      if (track.kind === 'video' && !many) {
        items.push({ separator: true, label: 'Animer' });
        for (const entry of ANIMATABLE) {
          items.push({
            id: `anim-${entry.channel}`,
            label: entry.label,
            icon: entry.icon,
            checked: (clip.animation?.[entry.channel]?.length ?? 0) > 0,
            onSelect: () => state.toggleChannel(clip.id, entry.channel),
          });
        }
      }

      if (isText) {
        items.push({ separator: true });
        items.push({
          id: 'split-words',
          label: many ? `Découper en mots (${targets.length})` : 'Découper en mots',
          icon: <SeparatorHorizontal size={12} strokeWidth={2} />,
          onSelect: () => state.splitTextIntoWords(targets),
        });
      }

      if (isText && !many) {
        items.push({ separator: true });
        items.push({
          id: 'edit-text',
          label: 'Modifier le texte',
          icon: <Type size={12} strokeWidth={2} />,
          onSelect: () => state.selectClip(clip.id),
        });
      }

      openAt(event, items);
    },
    [openAt, store],
  );
}

/* -------------------------------------------------------------- keyframe */

export function useKeyframeMenu() {
  const openAt = useOpener();
  const store = useEditor;

  return useCallback(
    (event: React.MouseEvent, clip: Clip, channel: string, keyframe: Keyframe) => {
      const state = store.getState();
      const ref = { clipId: clip.id, channel, id: keyframe.id };
      // Right-clicking an unselected keyframe acts on it, not on the old set.
      if (!state.selectedKeyframes.some((item) => item.id === keyframe.id)) {
        state.selectKeyframes([ref]);
      }
      const targets = store.getState().selectedKeyframes;

      const items: MenuItem[] = [
        { separator: true, label: 'Courbe' },
        {
          id: 'linear',
          label: 'Linéaire',
          checked: keyframe.easing.kind === 'linear',
          onSelect: () => state.setKeyframeEasing(targets, { kind: 'linear' }),
        },
        {
          id: 'smooth',
          label: 'Doux des deux côtés',
          checked: keyframe.easing.kind === 'ease-in-out',
          onSelect: () => state.setKeyframeEasing(targets, { kind: 'ease-in-out' }),
        },
        {
          id: 'hold',
          label: 'Palier',
          checked: keyframe.easing.kind === 'hold',
          onSelect: () => state.setKeyframeEasing(targets, { kind: 'hold' }),
        },
        { separator: true },
        {
          id: 'goto',
          label: 'Placer le curseur ici',
          onSelect: () => state.setPlayhead(clip.start + keyframe.time),
        },
        {
          id: 'copy',
          label: `Copier${targets.length > 1 ? ` (${targets.length})` : ''}`,
          shortcut: 'Ctrl + C',
          icon: <Clipboard size={12} strokeWidth={2} />,
          onSelect: () => state.copyKeyframes(),
        },
        {
          id: 'paste',
          label: 'Coller au curseur',
          shortcut: 'Ctrl + V',
          disabled: !state.keyframeClipboard,
          icon: <ClipboardPaste size={12} strokeWidth={2} />,
          onSelect: () => state.pasteKeyframes(clip.id),
        },
        {
          id: 'delete',
          label: `Supprimer${targets.length > 1 ? ` (${targets.length})` : ''}`,
          shortcut: 'Suppr',
          danger: true,
          icon: <Trash2 size={12} strokeWidth={2} />,
          onSelect: () => state.removeKeyframes(targets),
        },
      ];

      openAt(event, items);
    },
    [openAt, store],
  );
}

/* ----------------------------------------------------------------- track */

export function useTrackMenu() {
  const openAt = useOpener();
  const store = useEditor;

  return useCallback(
    (event: React.MouseEvent, track: Track) => {
      const state = store.getState();
      const tracks = state.project?.tracks ?? [];
      const index = tracks.findIndex((item) => item.id === track.id);
      const kin = tracks.filter((item) => item.kind === track.kind);
      const first = tracks.indexOf(kin[0] as Track);
      const last = tracks.indexOf(kin[kin.length - 1] as Track);

      const items: MenuItem[] = [
        {
          id: 'up',
          label: 'Monter le calque',
          disabled: index <= first,
          icon: <ArrowUp size={12} strokeWidth={2} />,
          onSelect: () => state.moveTrack(track.id, index - 1),
        },
        {
          id: 'down',
          label: 'Descendre le calque',
          disabled: index >= last,
          icon: <ArrowDown size={12} strokeWidth={2} />,
          onSelect: () => state.moveTrack(track.id, index + 1),
        },
        { separator: true },
        {
          id: 'mute',
          label: track.muted ? 'Réactiver le son' : 'Couper le son',
          checked: track.muted,
          icon: track.muted ? (
            <VolumeX size={12} strokeWidth={2} />
          ) : (
            <Volume2 size={12} strokeWidth={2} />
          ),
          onSelect: () => state.patchTrack(track.id, { muted: !track.muted }),
        },
      ];

      if (track.kind === 'video') {
        items.push({
          id: 'hide',
          label: track.hidden ? 'Afficher la piste' : 'Masquer la piste',
          checked: track.hidden,
          icon: track.hidden ? (
            <EyeOff size={12} strokeWidth={2} />
          ) : (
            <Eye size={12} strokeWidth={2} />
          ),
          onSelect: () => state.patchTrack(track.id, { hidden: !track.hidden }),
        });
      }

      items.push(
        {
          id: 'lock',
          label: track.locked ? 'Déverrouiller' : 'Verrouiller',
          checked: track.locked,
          icon: track.locked ? (
            <Lock size={12} strokeWidth={2} />
          ) : (
            <LockOpen size={12} strokeWidth={2} />
          ),
          onSelect: () => state.patchTrack(track.id, { locked: !track.locked }),
        },
        { separator: true },
        {
          id: 'add-video',
          label: 'Nouvelle piste vidéo',
          icon: <Film size={12} strokeWidth={2} />,
          onSelect: () => state.addTrack('video'),
        },
        {
          id: 'add-audio',
          label: 'Nouvelle piste audio',
          icon: <ListPlus size={12} strokeWidth={2} />,
          onSelect: () => state.addTrack('audio'),
        },
        {
          id: 'remove',
          label: 'Supprimer la piste',
          danger: true,
          icon: <Trash2 size={12} strokeWidth={2} />,
          onSelect: () => state.removeTrack(track.id),
        },
      );

      openAt(event, items);
    },
    [openAt, store],
  );
}

/* ----------------------------------------------------------------- asset */

export function useAssetMenu() {
  const openAt = useOpener();
  const store = useEditor;

  return useCallback(
    (event: React.MouseEvent, asset: MediaAsset) => {
      const state = store.getState();
      state.selectAsset(asset.id);

      openAt(event, [
        {
          id: 'add',
          label: 'Ajouter à la timeline',
          disabled: Boolean(asset.missing),
          icon: <ListPlus size={12} strokeWidth={2} />,
          onSelect: () => state.addClip(asset.id),
        },
        ...(asset.missing
          ? ([
              {
                id: 'relink',
                label: 'Localiser le fichier…',
                onSelect: () => state.openRelink(),
              },
            ] as MenuItem[])
          : []),
        ...(asset.kind === 'video' && !asset.missing
          ? ([
              { separator: true },
              {
                id: 'viral',
                label: 'Générer des clips viraux…',
                icon: <Sparkles size={12} strokeWidth={2} />,
                onSelect: () => useViral.getState().openWizard(asset.id),
              },
              {
                id: 'tutorial',
                label: 'Monter un tutoriel…',
                icon: <GraduationCap size={12} strokeWidth={2} />,
                onSelect: () => useTutorial.getState().openWizard(asset.id),
              },
            ] as MenuItem[])
          : []),
        { separator: true },
        {
          id: 'remove',
          label: 'Retirer du projet',
          danger: true,
          icon: <Trash2 size={12} strokeWidth={2} />,
          onSelect: () => state.removeAsset(asset.id),
        },
      ]);
    },
    [openAt, store],
  );
}

/* ------------------------------------------------------------------ lane */

export function useLaneMenu() {
  const openAt = useOpener();
  const store = useEditor;

  return useCallback(
    (event: React.MouseEvent, track: Track, time: number) => {
      const state = store.getState();

      const items: MenuItem[] = [];

      if (track.kind === 'video') {
        items.push({
          id: 'text',
          label: 'Calque de texte ici',
          shortcut: 'Ctrl + ⇧ + T',
          icon: <Type size={12} strokeWidth={2} />,
          onSelect: () => state.addTextClip({ trackId: track.id, at: time }),
        });
        // No `trackId`: a banner always goes on the banner track, wherever the
        // menu was opened. See `lib/bannerLayer` for why that rule is absolute.
        items.push({
          id: 'banner',
          label: 'Bande titre ici…',
          icon: <Captions size={12} strokeWidth={2} />,
          onSelect: () => state.openBannerPicker(true),
        });
      }

      items.push(
        {
          id: 'paste-clips',
          label: 'Coller ici',
          shortcut: 'Ctrl + V',
          disabled: !state.clipClipboard,
          icon: <ClipboardPaste size={12} strokeWidth={2} />,
          onSelect: () => state.pasteClips(time),
        },
        {
          id: 'paste-kf',
          label: 'Coller les images clés',
          disabled: !state.keyframeClipboard,
          icon: <ClipboardPaste size={12} strokeWidth={2} />,
          onSelect: () => state.pasteKeyframes(),
        },
        { separator: true },
        {
          id: 'add-video',
          label: 'Nouvelle piste vidéo',
          icon: <Film size={12} strokeWidth={2} />,
          onSelect: () => state.addTrack('video'),
        },
        {
          id: 'add-audio',
          label: 'Nouvelle piste audio',
          icon: <ListPlus size={12} strokeWidth={2} />,
          onSelect: () => state.addTrack('audio'),
        },
      );

      openAt(event, items);
    },
    [openAt, store],
  );
}

/* ---------------------------------------------------------- channel lane */

export function useChannelLaneMenu() {
  const openAt = useOpener();
  const store = useEditor;

  return useCallback(
    (event: React.MouseEvent, clip: Clip, channel: string, time: number) => {
      const state = store.getState();

      openAt(event, [
        {
          id: 'add',
          label: 'Ajouter une image clé ici',
          icon: <ListPlus size={12} strokeWidth={2} />,
          onSelect: () => state.addKeyframeAt(clip.id, channel, time),
        },
        {
          id: 'add-playhead',
          label: 'Ajouter au curseur',
          shortcut: 'K',
          onSelect: () => state.addKeyframeAt(clip.id, channel),
        },
        {
          id: 'paste',
          label: 'Coller les images clés',
          shortcut: 'Ctrl + V',
          disabled: !state.keyframeClipboard,
          icon: <ClipboardPaste size={12} strokeWidth={2} />,
          onSelect: () => state.pasteKeyframes(clip.id),
        },
        { separator: true },
        {
          id: 'stop',
          label: 'Arrêter d’animer cette propriété',
          danger: true,
          icon: <Trash2 size={12} strokeWidth={2} />,
          onSelect: () => state.toggleChannel(clip.id, channel),
        },
      ]);
    },
    [openAt, store],
  );
}

/* ------------------------------------------------------------ transition */

export function useTransitionMenu() {
  const openAt = useOpener();
  const store = useEditor;

  return useCallback(
    (event: React.MouseEvent, resolved: ResolvedTransition) => {
      const state = store.getState();
      state.selectTransition(resolved.transition.id);

      const junction = resolved.from !== null && resolved.to !== null;
      const icon = (kind: string) =>
        kind === 'crossfade' ? (
          <Blend size={12} strokeWidth={2} />
        ) : kind === 'dip-white' ? (
          <Sunrise size={12} strokeWidth={2} />
        ) : (
          <Sunset size={12} strokeWidth={2} />
        );

      openAt(event, [
        { separator: true, label: transitionDescriptor(resolved.transition.kind).label },
        ...TRANSITIONS.map(
          (preset): MenuItem => ({
            id: preset.kind,
            label: preset.label,
            icon: icon(preset.kind),
            checked: preset.kind === resolved.transition.kind,
            disabled: preset.requiresJunction && !junction,
            onSelect: () => state.setTransitionKind(resolved.transition.id, preset.kind),
          }),
        ),
        { separator: true },
        {
          id: 'remove',
          label: 'Supprimer la transition',
          shortcut: 'Suppr',
          danger: true,
          icon: <Trash2 size={12} strokeWidth={2} />,
          onSelect: () => state.removeTransition(resolved.transition.id),
        },
      ]);
    },
    [openAt, store],
  );
}
