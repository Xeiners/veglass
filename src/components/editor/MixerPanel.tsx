import { Activity, Headphones, RotateCcw, Volume2, VolumeX } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Slider } from '@/components/ui/Slider';
import { IconButton } from '@/components/ui/Button';
import { useEditor } from '@/store/editorStore';
import { defaultTrackAudio, isAudible, trackAudioOf, type Track } from '@/types/timeline';
import { TrackMeter } from './TrackMeter';

/**
 * The mixing desk.
 *
 * One strip per audio track — level, pan, mute/solo, filters and a limiter.
 * These are bus settings: they apply to the sum of the clips on the track, and
 * the export builds the same chain in ffmpeg so what is heard here is what is
 * written out.
 */
export function MixerPanel() {
  const project = useEditor((state) => state.project);
  const tracks = (project?.tracks ?? []).filter((track) => track.kind === 'audio');
  const anySolo = tracks.some((track) => track.solo && !track.muted);

  if (tracks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="text-[11px] leading-relaxed text-white/30">
          Aucune piste audio. Ajoutez-en une depuis la barre d’outils de la timeline.
        </p>
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 px-4 pb-2.5 pt-4">
        <Activity size={13} strokeWidth={2} className="text-wave-400" />
        <h2 className="eyebrow min-w-0 flex-1 truncate">Table de mixage</h2>
        <span className="num text-2xs text-white/22">{tracks.length}</span>
      </header>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-4">
        {tracks.map((track) => (
          <Strip key={track.id} track={track} anySolo={anySolo} />
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function Strip({ track, anySolo }: { track: Track; anySolo: boolean }) {
  const patchTrack = useEditor((state) => state.patchTrack);
  const patchTrackAudio = useEditor((state) => state.patchTrackAudio);
  const toggleTrackSolo = useEditor((state) => state.toggleTrackSolo);

  const audio = trackAudioOf(track);
  const audible = isAudible(track, anySolo);
  const dimmed = !audible;

  return (
    <div
      className={cn(
        'rounded-xl border transition-colors duration-200',
        dimmed
          ? 'border-white/[0.05] bg-white/[0.012] opacity-55'
          : 'border-white/[0.07] bg-white/[0.022]',
      )}
    >
      <div className="flex items-center gap-2 px-2.5 pb-1.5 pt-2">
        <span className="num min-w-0 flex-1 truncate text-2xs font-semibold text-white/75">
          {track.name}
        </span>

        <IconButton
          label={track.muted ? 'Réactiver' : 'Muet'}
          className="h-6 w-6"
          active={track.muted}
          onClick={() => patchTrack(track.id, { muted: !track.muted })}
        >
          {track.muted ? <VolumeX size={11} strokeWidth={2} /> : <Volume2 size={11} strokeWidth={2} />}
        </IconButton>
        <button
          type="button"
          onClick={() => toggleTrackSolo(track.id)}
          title="Solo — les autres pistes se taisent"
          className={cn(
            'grid h-6 w-6 place-items-center rounded-lg text-[10px] font-semibold transition-all duration-200',
            track.solo
              ? 'bg-wave-500/25 text-wave-300 shadow-[inset_0_0_0_1px_rgba(251,191,36,.35)]'
              : 'text-white/35 hover:bg-white/[0.07] hover:text-white/80',
          )}
        >
          <Headphones size={11} strokeWidth={2.2} />
        </button>
      </div>

      <div className="px-2.5 pb-2">
        <TrackMeter trackId={track.id} className="mb-2" />

        <Row
          label="Niveau"
          value={`${Math.round(audio.volume * 100)} %`}
          slider={
            <Slider
              aria-label={`Niveau ${track.name}`}
              value={audio.volume}
              min={0}
              max={2}
              step={0.01}
              onChange={(volume) => patchTrackAudio(track.id, { volume })}
            />
          }
        />

        <Row
          label="Panoramique"
          value={
            audio.pan === 0
              ? 'Centre'
              : `${audio.pan < 0 ? 'G' : 'D'} ${Math.round(Math.abs(audio.pan) * 100)}`
          }
          slider={
            <Slider
              aria-label={`Panoramique ${track.name}`}
              value={audio.pan}
              min={-1}
              max={1}
              step={0.01}
              onChange={(pan) => patchTrackAudio(track.id, { pan })}
            />
          }
        />
      </div>

      <details className="group/fx border-t border-white/[0.05]">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-[10px] text-white/35 transition-colors hover:text-white/70">
          <span className="flex-1">Filtres & dynamique</span>
          {(audio.highPass > 0 || audio.lowPass > 0 || audio.compressor.enabled) && (
            <span className="h-1.5 w-1.5 rounded-full bg-wave-400" />
          )}
          <RotateCcw
            size={10}
            strokeWidth={2}
            role="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              patchTrackAudio(track.id, defaultTrackAudio(), { label: 'réinitialiser la piste' });
            }}
            className="text-white/25 transition-colors hover:text-white/70"
          />
        </summary>

        <div className="px-2.5 pb-2.5">
          <Row
            label="Passe-haut"
            value={audio.highPass > 0 ? `${Math.round(audio.highPass)} Hz` : 'Off'}
            slider={
              <Slider
                aria-label="Passe-haut"
                value={audio.highPass}
                min={0}
                max={400}
                step={5}
                onChange={(highPass) => patchTrackAudio(track.id, { highPass })}
              />
            }
          />
          <Row
            label="Passe-bas"
            value={audio.lowPass > 0 ? `${Math.round(audio.lowPass / 100) / 10} kHz` : 'Off'}
            slider={
              <Slider
                aria-label="Passe-bas"
                value={audio.lowPass}
                min={0}
                max={20000}
                step={250}
                onChange={(lowPass) => patchTrackAudio(track.id, { lowPass })}
              />
            }
          />

          <button
            type="button"
            onClick={() =>
              patchTrackAudio(
                track.id,
                { compressor: { ...audio.compressor, enabled: !audio.compressor.enabled } },
                { label: 'compresseur' },
              )
            }
            className={cn(
              'mt-1.5 flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-[10px]',
              'transition-all duration-200',
              audio.compressor.enabled
                ? 'border-wave-500/40 bg-wave-500/[0.1] text-wave-200'
                : 'border-white/[0.07] bg-white/[0.02] text-white/45 hover:text-white/80',
            )}
          >
            <Activity size={11} strokeWidth={2.2} />
            Compresseur / limiteur
          </button>

          {audio.compressor.enabled && (
            <>
              <Row
                label="Seuil"
                value={`${Math.round(audio.compressor.threshold)} dB`}
                slider={
                  <Slider
                    aria-label="Seuil"
                    value={audio.compressor.threshold}
                    min={-48}
                    max={0}
                    step={1}
                    onChange={(threshold) =>
                      patchTrackAudio(track.id, {
                        compressor: { ...audio.compressor, threshold },
                      })
                    }
                  />
                }
              />
              <Row
                label="Ratio"
                value={`${audio.compressor.ratio.toFixed(1)} : 1`}
                slider={
                  <Slider
                    aria-label="Ratio"
                    value={audio.compressor.ratio}
                    min={1}
                    max={20}
                    step={0.5}
                    onChange={(ratio) =>
                      patchTrackAudio(track.id, { compressor: { ...audio.compressor, ratio } })
                    }
                  />
                }
              />
              <Row
                label="Rattrapage"
                value={`+${Math.round(audio.compressor.makeup)} dB`}
                slider={
                  <Slider
                    aria-label="Rattrapage"
                    value={audio.compressor.makeup}
                    min={0}
                    max={24}
                    step={1}
                    onChange={(makeup) =>
                      patchTrackAudio(track.id, { compressor: { ...audio.compressor, makeup } })
                    }
                  />
                }
              />
            </>
          )}
        </div>
      </details>
    </div>
  );
}

function Row({
  label,
  value,
  slider,
}: {
  label: string;
  value: string;
  slider: React.ReactNode;
}) {
  return (
    <div className="py-1">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] text-white/38">{label}</span>
        <span className="num text-[10px] text-white/60">{value}</span>
      </div>
      {slider}
    </div>
  );
}
