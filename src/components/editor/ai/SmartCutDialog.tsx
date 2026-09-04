import { useEffect, useMemo, useState } from 'react';
import { AudioLines, Info, Scissors, TriangleAlert, Wand2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatClock, formatTimecode } from '@/lib/time';
import { Button } from '@/components/ui/Button';
import { Field, Input, OptionCard } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Slider } from '@/components/ui/Slider';
import { useAi } from '@/store/aiStore';
import { JobRow } from './AssistantPanel';
import { useEditor } from '@/store/editorStore';
import { audioJobs } from '@/lib/ai/scope';
import { totalCut } from '@/lib/ai/silence';
import {
  DEFAULT_SMART_CUT_OPTIONS,
  type CutInterval,
  type SmartCutOptions,
  type SmartCutScope,
} from '@/types/ai';

const STORAGE_KEY = 'veglass:ai-smart-cut';

function readOptions(): SmartCutOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SMART_CUT_OPTIONS };
    return { ...DEFAULT_SMART_CUT_OPTIONS, ...(JSON.parse(raw) as Partial<SmartCutOptions>) };
  } catch {
    return { ...DEFAULT_SMART_CUT_OPTIONS };
  }
}

export function SmartCutDialog() {
  const open = useAi((state) => state.smartCutOpen);
  const setOpen = useAi((state) => state.openSmartCut);
  const report = useAi((state) => state.smartCut);
  const analyse = useAi((state) => state.analyseSmartCut);
  const apply = useAi((state) => state.applySmartCut);
  const clear = useAi((state) => state.clearSmartCut);
  const cancel = useAi((state) => state.cancel);
  const job = useAi((state) => state.job);
  const busy = job !== null;
  const configured = useAi((state) => state.keyStatus.configured);
  const openSettings = useAi((state) => state.openSettings);

  const project = useEditor((state) => state.project);
  const selectedClipId = useEditor((state) => state.selectedClipId);
  const workIn = useEditor((state) => state.workIn);
  const workOut = useEditor((state) => state.workOut);
  const setPlayhead = useEditor((state) => state.setPlayhead);

  const [options, setOptions] = useState<SmartCutOptions>(readOptions);
  /** Cuts the user has struck off the proposal, by index. */
  const [excluded, setExcluded] = useState<Set<number>>(new Set());

  // A fresh analysis starts with everything accepted.
  useEffect(() => {
    setExcluded(new Set());
  }, [report]);

  const patch = (next: Partial<SmartCutOptions>) => {
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

  const preview = useMemo(() => {
    if (!project) return { count: 0, seconds: 0 };
    const jobs = audioJobs(project, options.scope, { selectedClipId, workIn, workOut });
    return { count: jobs.length, seconds: jobs.reduce((total, job) => total + job.duration, 0) };
  }, [project, options.scope, selectedClipId, workIn, workOut]);

  const accepted = useMemo(
    () => (report?.cuts ?? []).filter((_, index) => !excluded.has(index)),
    [report, excluded],
  );

  const fps = project?.settings.fps ?? 30;
  const hasWorkArea = workIn !== null || workOut !== null;

  const SCOPES: { id: SmartCutScope; label: string; hint: string; disabled: boolean }[] = [
    { id: 'timeline', label: 'Tout le montage', hint: 'Chaque clip audible', disabled: false },
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

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Smart cut"
      description="Mesure la bande son, repère les blancs, et referme la timeline sur les intervalles retenus — toutes pistes ensemble, pour ne pas casser la synchro."
      width="lg"
      footer={
        report ? (
          <>
            <Button variant="ghost" onClick={clear}>
              Régler à nouveau
            </Button>
            <Button
              variant="primary"
              disabled={accepted.length === 0}
              icon={<Scissors size={13} strokeWidth={2.2} />}
              onClick={() => apply(accepted)}
            >
              Retirer {formatClock(totalCut(accepted))}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button
              variant="primary"
              disabled={busy || preview.count === 0}
              icon={<AudioLines size={13} strokeWidth={2.2} />}
              onClick={() => void analyse(options)}
            >
              Analyser
            </Button>
          </>
        )
      }
    >
      {report ? (
        <div className="space-y-4 pb-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-3">
            <Summary label="Intervalles" value={`${report.cuts.length}`} />
            <Summary label="Temps retirable" value={formatClock(report.saved)} />
            <Summary label="Clips écoutés" value={`${report.analysed}`} />
            <Summary label="Retenus" value={`${accepted.length}`} accent />
          </div>

          {report.warnings.length > 0 && (
            <ul className="space-y-1 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] px-3.5 py-2.5">
              {report.warnings.map((warning) => (
                <li key={warning} className="flex gap-2 text-2xs leading-relaxed text-amber-100/75">
                  <TriangleAlert size={11} strokeWidth={2.2} className="mt-0.5 shrink-0" />
                  <span className="min-w-0">{warning}</span>
                </li>
              ))}
            </ul>
          )}

          {report.cuts.length === 0 ? (
            <div className="space-y-3 py-6 text-center">
              <p className="text-2xs text-white/40">
                Aucun temps mort au-dessus de {options.threshold} dBFS.
              </p>
              {report.suggestedThreshold !== null &&
                report.suggestedThreshold !== options.threshold && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      patch({ threshold: report.suggestedThreshold as number });
                      clear();
                    }}
                  >
                    Essayer {report.suggestedThreshold} dBFS — mesuré sur ce matériau
                  </Button>
                )}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <h3 className="eyebrow">À retirer</h3>
                <button
                  type="button"
                  onClick={() =>
                    setExcluded(
                      excluded.size === 0
                        ? new Set(report.cuts.map((_, index) => index))
                        : new Set(),
                    )
                  }
                  className="text-2xs text-white/40 underline underline-offset-2 transition-colors hover:text-white/75"
                >
                  {excluded.size === 0 ? 'Tout décocher' : 'Tout cocher'}
                </button>
              </div>

              <ul className="max-h-[38vh] space-y-px overflow-y-auto rounded-xl border border-white/[0.06]">
                {report.cuts.map((cut, index) => (
                  <CutRow
                    key={`${cut.start}-${cut.end}`}
                    cut={cut}
                    fps={fps}
                    checked={!excluded.has(index)}
                    onToggle={() =>
                      setExcluded((previous) => {
                        const next = new Set(previous);
                        if (next.has(index)) next.delete(index);
                        else next.add(index);
                        return next;
                      })
                    }
                    onLocate={() => setPlayhead(cut.start)}
                  />
                ))}
              </ul>

              <p className="text-2xs leading-relaxed text-white/35">
                Les clips sont recoupés et décalés en bloc : l’image reste calée sur le son, les
                images clés sont recalculées, et l’opération s’annule en une seule fois.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-6 pb-2">
          {/* The same row the assistant panel uses, so a stalled analysis reads
              the same wherever it is being watched from. */}
          {job && <JobRow job={job} onCancel={cancel} />}

          <section className="space-y-2">
            <h3 className="eyebrow">Étendue</h3>
            <div className="grid gap-1.5 sm:grid-cols-3">
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
                ? 'Rien à analyser dans cette étendue'
                : `${preview.count} clip${preview.count > 1 ? 's' : ''} · ${formatClock(preview.seconds)} d’audio`}
            </p>
          </section>

          <section className="space-y-4 border-t border-white/[0.06] pt-5">
            <h3 className="eyebrow">Détection</h3>

            <Field
              label="Seuil de silence"
              hint={<span className="num">{options.threshold} dBFS</span>}
            >
              <Slider
                value={options.threshold}
                min={-70}
                max={-15}
                step={1}
                onChange={(value) => patch({ threshold: Math.round(value) })}
                aria-label="Seuil de silence en dBFS"
              />
              <p className="mt-2 text-2xs leading-relaxed text-white/35">
                Tout ce qui reste sous ce niveau compte comme du silence. Une voix bien enregistrée
                se coupe vers −45 dBFS ; une prise bruitée demande de remonter.
              </p>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Silence minimal" hint="secondes">
                <Input
                  type="number"
                  min={0.2}
                  max={10}
                  step={0.1}
                  value={options.minSilence}
                  onChange={(event) =>
                    patch({ minSilence: Math.max(0.2, Number(event.target.value) || 0.6) })
                  }
                  className="num"
                />
              </Field>
              <Field label="Marge conservée" hint="secondes de chaque côté">
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.02}
                  value={options.padding}
                  onChange={(event) =>
                    patch({ padding: Math.max(0, Number(event.target.value) || 0) })
                  }
                  className="num"
                />
              </Field>
            </div>

            <label
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors',
                options.detectFillers
                  ? 'border-accent-500/35 bg-accent-500/[0.07]'
                  : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.12]',
              )}
            >
              <input
                type="checkbox"
                checked={options.detectFillers}
                onChange={(event) => patch({ detectFillers: event.target.checked })}
                className="mt-0.5 h-4 w-4 shrink-0 accent-accent-500"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-white/85">
                  <Wand2 size={12} strokeWidth={2.2} className="text-accent-300/70" />
                  Repérer aussi les hésitations
                </span>
                <span className="mt-0.5 block text-2xs leading-relaxed text-white/40">
                  Gemini écoute l’extrait et signale les « euh », faux départs et répétitions. Un
                  envoi par clip, en plus de la mesure — plus lent, et facturé sur votre quota.
                </span>
              </span>
            </label>

            {options.detectFillers && !configured && (
              <button
                type="button"
                onClick={() => openSettings(true)}
                className="flex w-full items-center gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-3 text-left transition-colors hover:bg-amber-500/[0.1]"
              >
                <Info size={13} strokeWidth={2} className="shrink-0 text-amber-400" />
                <span className="text-2xs leading-relaxed text-amber-100/80">
                  Aucune clé API — la détection de silence fonctionnera, pas celle des hésitations.
                </span>
              </button>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

function Summary({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <p
        className={cn(
          'num mt-0.5 text-[15px] font-medium',
          accent ? 'text-accent-300' : 'text-white/85',
        )}
      >
        {value}
      </p>
    </div>
  );
}

function CutRow({
  cut,
  fps,
  checked,
  onToggle,
  onLocate,
}: {
  cut: CutInterval;
  fps: number;
  checked: boolean;
  onToggle(): void;
  onLocate(): void;
}) {
  return (
    <li
      className={cn(
        'flex items-center gap-3 bg-white/[0.018] px-3 py-2 transition-colors',
        !checked && 'opacity-45',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={`Retirer ${cut.label}`}
        className="h-3.5 w-3.5 shrink-0 accent-accent-500"
      />
      <button
        type="button"
        onClick={onLocate}
        title="Amener le curseur ici"
        className="num shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white"
      >
        {formatTimecode(cut.start, fps)}
      </button>
      <span className="min-w-0 flex-1 truncate text-2xs text-white/55">{cut.label}</span>
      <span
        className={cn(
          'shrink-0 rounded-md px-1.5 py-0.5 text-[10px]',
          cut.source === 'filler'
            ? 'bg-accent-500/[0.14] text-accent-200'
            : 'bg-white/[0.05] text-white/40',
        )}
      >
        {cut.source === 'filler' ? 'IA' : 'silence'}
      </span>
      <span className="num w-14 shrink-0 text-right text-[11px] text-white/45">
        −{(cut.end - cut.start).toFixed(1).replace('.', ',')} s
      </span>
    </li>
  );
}
