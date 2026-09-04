import { useEffect, useMemo, useRef } from 'react';

import { audioEngine } from '@/lib/audioEngine';
import { useEditor } from '@/store/editorStore';
import { audioClips, resolveClipAt } from '@/store/selectors';
import { clipContains, isAudible, sourceTimeAt, trackAudioOf } from '@/types/timeline';

/** Beyond this drift (seconds) we hard-seek instead of letting playback catch up. */
const DRIFT_TOLERANCE = 0.22;

/**
 * Headless mixer for the audio tracks.
 *
 * One `<audio>` element per clip is mounted up-front so seeking never waits on a
 * network/disk fetch. Each element chases the transport clock: outside its clip
 * it stays paused, inside it plays from the matching source offset.
 */
export function AudioMixer() {
  const project = useEditor((state) => state.project);
  const playhead = useEditor((state) => state.playhead);
  const isPlaying = useEditor((state) => state.isPlaying);
  const masterVolume = useEditor((state) => state.masterVolume);
  const masterMuted = useEditor((state) => state.masterMuted);

  const elements = useRef(new Map<string, HTMLAudioElement>());
  const tracks = project?.tracks ?? [];
  const anySolo = tracks.some(
    (track) => track.kind === 'audio' && track.solo && !track.muted,
  );

  // Bus settings are pushed to the graph whenever they change, and only then —
  // the per-frame work below stays about transport, not about mixing.
  useEffect(() => {
    for (const track of tracks) {
      if (track.kind !== 'audio') continue;
      audioEngine.configure(
        track.id,
        trackAudioOf(track),
        isAudible(track, anySolo),
        masterMuted ? 0 : masterVolume,
      );
    }
  }, [tracks, anySolo, masterMuted, masterVolume]);

  useEffect(() => {
    if (isPlaying) audioEngine.resume();
  }, [isPlaying]);
  // Recomputed only when the document changes — this component re-renders on
  // every transport tick, and resolving clips is O(clips x assets).
  const entries = useMemo(() => audioClips(project), [project]);

  useEffect(() => {
    for (const { clip: source, asset } of entries) {
      const element = elements.current.get(source.id);
      if (!element || !asset.src) continue;

      const inside = clipContains(source, playhead);
      const track = tracks.find((item) => item.id === source.trackId);
      const audible = Boolean(track && isAudible(track, anySolo)) && !source.muted;

      // Volume is animatable, so the gain is read at the playhead like any
      // other channel rather than taken from the stored scalar.
      const clip = resolveClipAt(source, playhead);

      // When the element is routed through the mixing graph, the bus owns track
      // level, pan and master. When routing was refused — cross-origin media
      // that Web Audio would silence — the element has to carry all of it
      // itself, or the clip would simply not be heard.
      const routed = audioEngine.isRouted(element);
      const busGain = routed
        ? 1
        : (track ? trackAudioOf(track).volume : 1) * (masterMuted ? 0 : masterVolume);

      element.volume = Math.max(0, Math.min(1, clip.volume * busGain));
      element.muted = !inside || (!routed && !audible);

      if (!inside) {
        if (!element.paused) element.pause();
        continue;
      }

      const target = sourceTimeAt(clip, playhead);
      if (Number.isFinite(target) && Math.abs(element.currentTime - target) > DRIFT_TOLERANCE) {
        try {
          element.currentTime = target;
        } catch {
          /* element not ready yet — the next tick retries */
        }
      }

      if (isPlaying && element.paused) {
        void element.play().catch(() => undefined);
      } else if (!isPlaying && !element.paused) {
        element.pause();
      }
    }
  }, [entries, playhead, isPlaying, masterVolume, masterMuted]);

  return (
    <div aria-hidden className="hidden">
      {entries.map(({ clip, asset }) => (
        <audio
          key={clip.id}
          ref={(node) => {
            if (node) elements.current.set(clip.id, node);
            else elements.current.delete(clip.id);
          }}
          // CORS mode is what lets Web Audio read the samples at all: without
          // it, media served from `asset://` is opaque and the graph would
          // output silence.
          crossOrigin="anonymous"
          src={asset.src}
          preload="auto"
          onCanPlay={(event) => audioEngine.attach(event.currentTarget, clip.trackId)}
          onError={(event) => {
            // The CORS fetch failed. Drop the attribute, reload, and never
            // route this element — plain playback beats a silent meter.
            const node = event.currentTarget;
            if (!node.crossOrigin) return;
            audioEngine.refuse(node);
            node.removeAttribute('crossorigin');
            node.load();
          }}
        />
      ))}
    </div>
  );
}
