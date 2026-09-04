import { useMemo, useState } from 'react';
import { AlignLeft, Captions, Info, Mic } from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatClock } from '@/lib/time';
import { Button } from '@/components/ui/Button';
import { Field, Input, OptionCard } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { useAi } from '@/store/aiStore';
import { useEditor } from '@/store/editorStore';
import { audioJobs } from '@/lib/ai/scope';
import {
  DEFAULT_SUBTITLE_OPTIONS,
  SUBTITLE_ANIMATIONS,
  SUBTITLE_PRESETS,
  SUBTITLE_TRACK_NAME,
  type SubtitleMode,
  type SubtitleOptions,
  type SubtitleScope,
} from '@/types/ai';

const STORAGE_KEY = 'veglass:ai-subtitles';

function readOptions(): SubtitleOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SUBTITLE_OPTIONS };
    return { ...DEFAULT_SUBTITLE_OPTIONS, ...(JSON.parse(raw) as Partial<SubtitleOptions>) };
  } catch {
    return { ...DEFAULT_SUBTITLE_OPTIONS };
  }
}

export function SubtitleDialog() {
  const open = useAi((state) => state.subtitlesOpen);
  const setOpen = useAi((state) => state.openSubtitles);
  const run = useAi((state) => state.generateSubtitles);
  const busy = useAi((state) => state.job !== null);
  const configured = useAi((state) => state.keyStatus.configured);
  const openSettings = useAi((state) => state.openSettings);

  const project = useEditor((state) => state.project);
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const workIn = useEditor((state) => state.workIn);
  const workOut = useEditor((state) => state.workOut);

  const [options, setOptions] = useState<SubtitleOptions>(readOptions);

  const patch = (next: Partial<SubtitleOptions>) => {
    setOptions((previous) => {
      const merged = { ...previous, ...next };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      } catch {
        /* storage unavailable — the choice stays session-local */
      }
      return merged;
    });
  };

  // What the chosen scope actually covers, shown before anything is sent: an
  // hour of audio is a real cost, and the number is the only honest warning.
  const preview = useMemo(() => {
    if (!project) return { count: 0, seconds: 0 };
    const jobs = audioJobs(project, options.scope, { selectedClipId, workIn, workOut });
    return {
      count: jobs.length,
      seconds: jobs.reduce((total, job) => total + job.duration, 0),
    };
  }, [project, options.scope, selectedClipId, workIn, workOut]);

  const hasWorkArea = workIn !== null || workOut !== null;

  const SCOPES: { id: SubtitleScope; label: string; hint: string; disabled: boolean }[] = [
    {
      id: 'timeline',
      label: 'Tout le montage',
      hint: 'Chaque clip audible, piste par piste',
      disabled: false,
    },
    {
      id: 'work',
      label: 'Zone de travail',
      hint: hasWorkArea
        ? `${formatClock(workIn ?? 0)} → ${formatClock(workOut ?? 0)}`
        : 'Posez un point d’entrée / de sortie (I et O)',
      disabled: !hasWorkArea,
    },
    {
      id: 'clip',
      label: 'Clip sélectionné',
      hint: selectedClipId ? 'Seulement ce plan' : 'Aucun clip sélectionné',
      disabled: !selectedClipId,
    },
  ];

  const hasScript = options.mode !== 'align' || options.script.trim().length > 0;

  const MODES: { id: SubtitleMode; label: string; hint: string; icon: typeof Mic }[] = [
    {
      id: 'transcribe',
      label: 'Transcrire l’audio',
      hint: 'Gemini écoute et écrit ce qu’il entend',
      icon: Mic,
    },
    {
      id: 'align',
      label: 'Caler un texte existant',
      hint: 'Vous fournissez les mots, Gemini ne donne que le minutage',
      icon: AlignLeft,
    },
  ];

  const subtitleTrack = project?.tracks.find(
    (track) => track.kind === 'video' && track.name === SUBTITLE_TRACK_NAME,
  );

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Générer les sous-titres"
      description="Les paroles sont posées en calques de texte sur une piste dédiée, avec leurs timecodes. Transcrites depuis l’audio, ou calées à partir d’un texte que vous fournissez."
      width="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Annuler
          </Button>
          <Button
            variant="primary"
            disabled={busy || preview.count === 0 || !configured || !hasScript}
            icon={<Captions size={13} strokeWidth={2.2} />}
            onClick={() => void run(options)}
          >
            {options.mode === 'align'
              ? 'Caler le texte'
              : `Transcrire ${preview.count > 0 ? `${preview.count} clip${preview.count > 1 ? 's' : ''}` : ''}`}
          </Button>
        </>
      }
    >
      <div className="space-y-6 pb-2">
        {!configured && (
          <button
            type="button"
            onClick={() => openSettings(true)}
            className="flex w-full items-center gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-3 text-left transition-colors hover:bg-amber-500/[0.1]"
          >
            <Info size={13} strokeWidth={2} className="shrink-0 text-amber-400" />
            <span className="text-2xs leading-relaxed text-amber-100/80">
              Aucune clé API Gemini enregistrée — cliquez pour l’ajouter.
            </span>
          </button>
        )}

        <section className="space-y-2">
          <h3 className="eyebrow">Source du texte</h3>
          <div className="grid gap-1.5">
            {MODES.map((mode) => (
              <OptionCard
                key={mode.id}
                active={options.mode === mode.id}
                onSelect={() => patch({ mode: mode.id })}
                title={mode.label}
                subtitle={mode.hint}
              />
            ))}
          </div>

          {options.mode === 'align' && (
            <div className="space-y-2 pt-1">
              <textarea
                value={options.script}
                rows={7}
                spellCheck={false}
                placeholder={[
                  'Une ligne par sous-titre.',
                  '',
                  'Collez ici le texte que vous voulez poser :',
                  'paroles, script, traduction…',
                ].join('\n')}
                onChange={(event) => patch({ script: event.target.value })}
                className="selectable w-full resize-y rounded-xl border border-white/[0.08] bg-ink-900/60 px-3.5 py-3 text-[13px] leading-relaxed text-white placeholder:text-white/25 transition-colors hover:border-white/[0.13] focus:border-accent-500/50 focus:outline-none focus:shadow-[0_0_0_3px_rgba(124,58,237,.18)]"
              />
              <p className="text-2xs leading-relaxed text-white/35">
                Le texte est repris <strong className="font-medium text-white/55">mot pour mot</strong> :
                le modèle ne fait que trouver à quel instant chaque ligne est prononcée. C’est nettement
                plus fiable que de lui demander de retrouver un texte de mémoire — et les lignes qu’il
                n’entend pas dans l’étendue choisie sont simplement omises.
              </p>
            </div>
          )}
        </section>

        <section className="space-y-2 border-t border-white/[0.06] pt-5">
          <h3 className="eyebrow">Étendue</h3>
          <div className="grid gap-1.5">
            {SCOPES.map((scope) => (
              <OptionCard
                key={scope.id}
                active={options.scope === scope.id}
                onSelect={() => !scope.disabled && patch({ scope: scope.id })}
                title={scope.label}
                subtitle={scope.hint}
              />
            ))}
          </div>
          <p className="num pt-1 text-2xs text-white/35">
            {preview.count === 0
              ? 'Rien à transcrire dans cette étendue'
              : `${preview.count} clip${preview.count > 1 ? 's' : ''} · ${formatClock(preview.seconds)} d’audio`}
          </p>
        </section>

        <section className="space-y-2 border-t border-white/[0.06] pt-5">
          <h3 className="eyebrow">Style</h3>
          <div className="grid gap-1.5">
            {SUBTITLE_PRESETS.map((preset) => (
              <OptionCard
                key={preset.id}
                active={options.preset === preset.id}
                onSelect={() => patch({ preset: preset.id })}
                title={preset.label}
                subtitle={preset.hint}
              />
            ))}
          </div>
        </section>

        <section className="space-y-2 border-t border-white/[0.06] pt-5">
          <h3 className="eyebrow">Apparition</h3>
          <div className="flex gap-1.5">
            {SUBTITLE_ANIMATIONS.map((animation) => (
              <button
                key={animation.id}
                type="button"
                onClick={() => patch({ animation: animation.id })}
                title={animation.hint}
                aria-pressed={options.animation === animation.id}
                className={cn(
                  'flex-1 rounded-lg border px-2 py-2 text-2xs transition-all duration-200 ease-smooth',
                  options.animation === animation.id
                    ? 'border-accent-500/45 bg-accent-500/[0.1] text-white'
                    : 'border-white/[0.07] bg-white/[0.02] text-white/50 hover:border-white/[0.14] hover:text-white/80',
                )}
              >
                {animation.label}
              </button>
            ))}
          </div>
          <p className="text-2xs leading-relaxed text-white/35">
            Les images clés posées sont éditables comme les vôtres — courbes comprises.
          </p>
        </section>

        <section className="grid grid-cols-2 gap-3 border-t border-white/[0.06] pt-5">
          {options.mode === 'transcribe' && (
            <Field label="Langue" hint="Vide = détection">
              <Input
                value={options.language}
                placeholder="français"
                onChange={(event) => patch({ language: event.target.value })}
              />
            </Field>
          )}
          <Field label="Caractères par ligne">
            <Input
              type="number"
              min={20}
              max={80}
              value={options.maxCharsPerLine}
              onChange={(event) =>
                patch({ maxCharsPerLine: Math.round(Number(event.target.value) || 42) })
              }
              className="num"
            />
          </Field>
          <Field label="Durée maximale" hint="secondes">
            <Input
              type="number"
              min={1}
              max={15}
              step={0.5}
              value={options.maxDuration}
              onChange={(event) => patch({ maxDuration: Number(event.target.value) || 6 })}
              className="num"
            />
          </Field>
          <Field label="Piste de destination">
            <select
              value={options.trackId ?? ''}
              onChange={(event) => patch({ trackId: event.target.value || null })}
              className="h-11 w-full rounded-xl border border-white/[0.08] bg-ink-900/60 px-3 text-[13px] text-white transition-colors hover:border-white/[0.13] focus:border-accent-500/50 focus:outline-none"
            >
              <option value="">
                {subtitleTrack ? `${SUBTITLE_TRACK_NAME} (existante)` : `Créer « ${SUBTITLE_TRACK_NAME} »`}
              </option>
              {project?.tracks
                .filter((track) => track.kind === 'video')
                .map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.name}
                  </option>
                ))}
            </select>
          </Field>
        </section>
      </div>
    </Modal>
  );
}
