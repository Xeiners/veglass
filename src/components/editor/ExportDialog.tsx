import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Cpu,
  Download,
  Gauge,
  Scissors,
  TriangleAlert,
  Wand2,
  X,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import {
  estimate as estimateRender,
  formatBytes,
  formatDuration,
  recordRender,
} from '@/lib/estimate';
import { formatClock, formatTimecode } from '@/lib/time';
import { buildRenderPlan, type RenderPlan } from '@/lib/renderPlan';
import {
  cancelExport,
  encoderStatus,
  estimateRemaining,
  exportRender,
  onExportProgress,
  pickExportTarget,
  type EncoderStatus,
  type ExportProgress,
  type ExportReport,
} from '@/lib/exporter';
import { FfmpegNotice } from './FfmpegSetup';
import {
  RESOLUTION_PRESETS,
  crfFromQuality,
  qualityFromCrf,
  qualityLabel,
} from '@/types/export';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Slider } from '@/components/ui/Slider';
import { projectDuration, useEditor } from '@/store/editorStore';
import {
  FORMATS,
  FPS_CHOICES,
  PRORES_PROFILES,
  RESOLUTION_CHOICES,
  formatOf,
  type ExportSettings,
} from '@/types/export';

type Phase = 'idle' | 'rendering' | 'done' | 'error';

export function ExportDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const project = useEditor((state) => state.project);
  const settings = useEditor((state) => state.exportSettings);
  const setSettings = useEditor((state) => state.setExportSettings);
  const workIn = useEditor((state) => state.workIn);
  const workOut = useEditor((state) => state.workOut);
  const notify = useEditor((state) => state.notify);

  const [plan, setPlan] = useState<RenderPlan | null>(null);
  const [encoder, setEncoder] = useState<EncoderStatus | null>(null);
  const [tab, setTab] = useState<'simple' | 'advanced'>('simple');
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [baking, setBaking] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<ExportReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const unlisten = useRef<(() => void) | null>(null);
  /** Wall clock of the render in flight, used to teach the estimator. */
  const startedAt = useRef(0);
  const format = formatOf(settings.format);
  const duration = projectDuration(project);

  /**
   * What this render should weigh and how long it should take.
   *
   * Recomputed on every change of settings, because the whole point of the
   * simple tab is watching the two numbers move as the dial does.
   */
  const projectFrame = useMemo(
    () => ({
      width: project?.settings.width ?? 1920,
      height: project?.settings.height ?? 1080,
      fps: project?.settings.fps ?? 30,
      duration: 0,
    }),
    [project],
  );

  const hasWorkArea = workIn !== null || workOut !== null;
  const rangeStart = settings.range === 'work' ? (workIn ?? 0) : 0;
  const rangeEnd = settings.range === 'work' ? (workOut ?? duration) : duration;
  const rangeLength = Math.max(rangeEnd - rangeStart, 0);

  const frame = { ...projectFrame, duration: rangeLength };
  const forecast = useMemo(
    () => estimateRender(settings, frame),
    // `frame` is rebuilt each render; its parts are what actually matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings, projectFrame, rangeLength],
  );
  const quality = qualityFromCrf(format, settings.crf);

  useEffect(() => {
    if (!open || !project) return;
    let cancelled = false;

    setPlan(null);
    setPhase('idle');
    setProgress(null);
    setBaking(null);
    setReport(null);
    setFailure(null);

    void buildRenderPlan(project).then((result) => {
      if (!cancelled) setPlan(result);
    });
    void encoderStatus().then((result) => {
      if (!cancelled) setEncoder(result);
    });

    return () => {
      cancelled = true;
    };
  }, [open, project]);

  // The channel is opened for the life of the dialog, not per render, so no
  // tick can arrive before the listener is attached.
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void onExportProgress((value) => setProgress(value)).then((dispose) => {
      if (disposed) dispose();
      else unlisten.current = dispose;
    });
    return () => {
      disposed = true;
      unlisten.current?.();
      unlisten.current = null;
    };
  }, [open]);

  const render = async () => {
    if (!project) return;
    const target = await pickExportTarget(project.name, settings);
    if (!target) return;

    setPhase('rendering');
    startedAt.current = performance.now();
    setProgress(null);
    setFailure(null);
    setBaking(null);
    try {
      const result = await exportRender(
        project,
        target,
        settings,
        { workIn, workOut },
        (done, total) => setBaking(done >= total ? null : { done, total }),
      );
      setReport(result);
      setPhase('done');
      // The estimate stops being a guess: this is what the machine really did.
      recordRender(settings, frame, {
        seconds: (performance.now() - startedAt.current) / 1000,
        bytes: result.bytes,
      });
      notify('Rendu terminé', 'success');
    } catch (error) {
      const message = String(error);
      setFailure(message);
      setPhase(message.includes('annulé') ? 'idle' : 'error');
    }
  };

  const busy = phase === 'rendering';
  const canRender = Boolean(encoder?.available && plan && plan.segments.length > 0);

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      width="lg"
      title="Exporter"
      description="Choisissez le format et la qualité ; la timeline est aplatie puis encodée."
      footer={
        busy ? (
          <>
            <Button
              variant="danger"
              icon={<X size={14} strokeWidth={2.2} />}
              onClick={() => void cancelExport()}
            >
              Annuler le rendu
            </Button>
            <Button variant="secondary" disabled>
              Rendu en cours…
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {phase === 'done' ? 'Fermer' : 'Annuler'}
            </Button>
            <Button
              variant="primary"
              onClick={() => void render()}
              disabled={!canRender}
              icon={<Download size={14} strokeWidth={2.2} />}
            >
              Rendre la vidéo
            </Button>
          </>
        )
      }
    >
      <div className="space-y-5 pb-2">
        {/* ------------------------------------------------------- tabs */}
        <div className="flex gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
          {(
            [
              ['simple', 'Simple'],
              ['advanced', 'Avancé'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              disabled={busy}
              onClick={() => setTab(id)}
              className={cn(
                'flex-1 rounded-lg px-3 py-1.5 text-[11px] transition-all duration-200',
                'disabled:pointer-events-none disabled:opacity-50',
                tab === id
                  ? 'bg-accent-500/[0.16] text-accent-100 shadow-[inset_0_0_0_1px_rgba(139,92,246,.35)]'
                  : 'text-white/45 hover:text-white/80',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'simple' && (
          <SimplePanel
            settings={settings}
            setSettings={setSettings}
            quality={quality}
            busy={busy}
          />
        )}

        {tab === 'simple' && <Forecast estimate={forecast} />}

        {tab === 'advanced' && (
        <>
        {/* ---------------------------------------------------- format */}
        <Section label="Format">
          <div className="grid grid-cols-2 gap-2">
            {FORMATS.map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={busy}
                onClick={() => setSettings({ format: item.id, crf: item.crf.default })}
                className={cn(
                  'rounded-xl border px-3 py-2.5 text-left transition-all duration-200',
                  'disabled:pointer-events-none disabled:opacity-50',
                  settings.format === item.id
                    ? 'border-accent-500/45 bg-accent-500/[0.09]'
                    : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.14]',
                )}
              >
                <span
                  className={cn(
                    'block text-2xs font-medium',
                    settings.format === item.id ? 'text-white' : 'text-white/75',
                  )}
                >
                  {item.label}
                </span>
                <span className="mt-0.5 block text-[10px] text-white/30">{item.hint}</span>
              </button>
            ))}
          </div>
        </Section>

        {/* --------------------------------------------------- quality */}
        <Section label="Qualité">
          {format.supportsCrf ? (
            <>
              <div className="mb-2 flex gap-1">
                {(
                  [
                    ['crf', 'Qualité constante'],
                    ['bitrate', 'Débit cible'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    disabled={busy}
                    onClick={() => setSettings({ rateMode: mode })}
                    className={cn(
                      'flex-1 rounded-lg border px-2 py-1.5 text-[10px] transition-all duration-200',
                      settings.rateMode === mode
                        ? 'border-accent-500/45 bg-accent-500/[0.12] text-accent-200'
                        : 'border-white/[0.07] bg-white/[0.02] text-white/45 hover:text-white/80',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {settings.rateMode === 'crf' ? (
                <Dial
                  label={`CRF ${Math.round(settings.crf)}`}
                  left={format.crfHint[0]}
                  right={format.crfHint[1]}
                  value={settings.crf}
                  min={format.crf.min}
                  max={format.crf.max}
                  step={1}
                  onChange={(crf) => setSettings({ crf })}
                />
              ) : (
                <Dial
                  label={`${settings.bitrateKbps} kb/s`}
                  left="Léger"
                  right="Fidèle"
                  value={settings.bitrateKbps}
                  min={1000}
                  max={60000}
                  step={500}
                  onChange={(bitrateKbps) => setSettings({ bitrateKbps })}
                />
              )}

              {format.presets.length > 0 && (
                <Choice
                  options={format.presets.map((preset) => ({ id: preset, label: preset }))}
                  value={settings.preset}
                  onSelect={(preset) => setSettings({ preset })}
                />
              )}
            </>
          ) : (
            <Choice
              options={PRORES_PROFILES.map((label, index) => ({ id: String(index), label }))}
              value={String(Math.round(settings.crf))}
              onSelect={(id) => setSettings({ crf: Number(id) })}
            />
          )}
        </Section>

        {/* -------------------------------------------------- image */}
        <div className="grid grid-cols-2 gap-4">
          <Section label="Résolution">
            <Choice
              options={RESOLUTION_CHOICES.map((item) => ({ id: item.id, label: item.label }))}
              value={settings.resolution}
              onSelect={(id) => setSettings({ resolution: id as ExportSettings['resolution'] })}
            />
          </Section>
          <Section label="Cadence">
            <Choice
              options={FPS_CHOICES.map((item) => ({ id: String(item.id), label: item.label }))}
              value={String(settings.fps)}
              onSelect={(id) =>
                setSettings({ fps: id === 'source' ? 'source' : (Number(id) as 24 | 25 | 30 | 60) })
              }
            />
          </Section>
        </div>

        <Forecast estimate={forecast} />
        </>
        )}

        <Section label="Plage">
          <div className="flex gap-1">
            {(
              [
                ['all', 'Toute la timeline'],
                ['work', 'Zone de travail'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                disabled={busy || (id === 'work' && !hasWorkArea)}
                onClick={() => setSettings({ range: id })}
                title={
                  id === 'work' && !hasWorkArea
                    ? 'Posez des points d’entrée et de sortie avec I et O'
                    : undefined
                }
                className={cn(
                  'flex-1 rounded-lg border px-2 py-1.5 text-[10px] transition-all duration-200',
                  'disabled:pointer-events-none disabled:opacity-35',
                  settings.range === id
                    ? 'border-accent-500/45 bg-accent-500/[0.12] text-accent-200'
                    : 'border-white/[0.07] bg-white/[0.02] text-white/45 hover:text-white/80',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="num mt-1.5 flex items-center gap-1.5 px-1 text-[10px] text-white/30">
            <Scissors size={10} strokeWidth={2} />
            {formatClock(rangeStart)} → {formatClock(rangeEnd)} · {formatClock(rangeLength)}
          </p>
        </Section>

        <EncoderRow
          status={encoder}
          engine={plan?.engine ?? 'typescript'}
          onInstalled={setEncoder}
        />

        {plan && plan.segments.some((segment) => segment.needsBake) && (
          <Note icon={<Wand2 size={13} strokeWidth={2} className="text-accent-300" />}>
            {plan.segments.filter((segment) => segment.needsBake).length} calque(s) texte ou
            vectoriel seront rasterisés à la résolution du projet avant l’encodage.
          </Note>
        )}

        {phase === 'rendering' && baking && (
          <Note icon={<Wand2 size={13} strokeWidth={2} className="text-accent-300" />}>
            Rasterisation des calques animés — {baking.done} / {baking.total}
          </Note>
        )}

        {phase === 'rendering' && !baking && (
          <ProgressBar progress={progress} fps={plan?.fps ?? 30} />
        )}

        {phase === 'done' && report && (
          <div className="flex items-start gap-2.5 rounded-xl border border-accent-500/30 bg-accent-500/[0.07] px-3 py-3">
            <CheckCircle2 size={14} strokeWidth={2.2} className="mt-px shrink-0 text-accent-300" />
            <div className="min-w-0">
              <p className="text-2xs font-medium text-white/85">Vidéo écrite</p>
              <p className="selectable mt-0.5 break-all font-mono text-[10px] text-white/45">
                {report.output}
              </p>
            </div>
          </div>
        )}

        {failure && phase !== 'rendering' && (
          <div
            className={cn(
              'flex items-start gap-2.5 rounded-xl px-3 py-3',
              phase === 'error'
                ? 'border border-rose-500/25 bg-rose-500/[0.07]'
                : 'border border-white/[0.07] bg-white/[0.02]',
            )}
          >
            <TriangleAlert
              size={14}
              strokeWidth={2.2}
              className={cn('mt-px shrink-0', phase === 'error' ? 'text-rose-300' : 'text-white/40')}
            />
            <p
              className={cn(
                'selectable min-w-0 break-words text-[11px] leading-relaxed',
                phase === 'error' ? 'text-rose-200/70' : 'text-white/45',
              )}
            >
              {failure}
            </p>
          </div>
        )}

        {plan && plan.warnings.length > 0 && (
          <ul className="space-y-1.5">
            {plan.warnings.map((warning) => (
              <li
                key={warning}
                className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-2.5 py-2 text-2xs text-amber-200/80"
              >
                <TriangleAlert size={12} strokeWidth={2} className="mt-px shrink-0" />
                {warning}
              </li>
            ))}
          </ul>
        )}

        {plan && (
          <div className="grid grid-cols-4 gap-2">
            <Stat label="Durée" value={formatTimecode(rangeLength, plan.fps)} />
            <Stat label="Segments" value={String(plan.segments.length)} />
            <Stat label="Pistes" value={String(plan.tracks.length)} />
            <Stat label="Transitions" value={String(plan.transitions.length)} />
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The whole export, as two decisions: how big the picture is, and how much
 * weight you are willing to spend on it.
 *
 * Everything else — codec, rate mode, preset, cadence — keeps whatever the
 * advanced tab left it at. Switching tabs is a change of view, never a silent
 * change of settings.
 */
function SimplePanel({
  settings,
  setSettings,
  quality,
  busy,
}: {
  settings: ExportSettings;
  setSettings(patch: Partial<ExportSettings>): void;
  quality: number;
  busy: boolean;
}) {
  const format = formatOf(settings.format);

  return (
    <>
      <Section label="Définition">
        <div className="grid grid-cols-3 gap-2">
          {RESOLUTION_PRESETS.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={busy}
              onClick={() => setSettings({ resolution: item.id })}
              className={cn(
                'rounded-xl border px-3 py-2.5 text-left transition-all duration-200',
                'disabled:pointer-events-none disabled:opacity-50',
                settings.resolution === item.id
                  ? 'border-accent-500/45 bg-accent-500/[0.09]'
                  : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.14]',
              )}
            >
              <span
                className={cn(
                  'num block text-2xs font-medium',
                  settings.resolution === item.id ? 'text-white' : 'text-white/75',
                )}
              >
                {item.label}
              </span>
              <span className="mt-0.5 block text-[10px] text-white/30">{item.hint}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section label="Qualité">
        {format.supportsCrf ? (
          <Dial
            label={qualityLabel(quality)}
            left="Fichier léger"
            right="Image fidèle"
            value={quality}
            min={0}
            max={100}
            step={1}
            onChange={(value) =>
              setSettings({ rateMode: 'crf', crf: crfFromQuality(format, value) })
            }
          />
        ) : (
          <Choice
            options={PRORES_PROFILES.map((label, index) => ({ id: String(index), label }))}
            value={String(Math.round(settings.crf))}
            onSelect={(id) => setSettings({ crf: Number(id) })}
          />
        )}
        <p className="mt-2 px-1 text-[10px] text-white/30">
          {format.label} · {settings.preset || 'sans preset'} — modifiable dans l’onglet Avancé.
        </p>
      </Section>
    </>
  );
}

/**
 * The two numbers people actually want before committing several minutes.
 *
 * Both are estimates and are labelled as such. The model starts from
 * measurements taken on this project's reference encoder, then follows what
 * this machine really does — see `lib/estimate.ts`.
 */
function Forecast({ estimate }: { estimate: ReturnType<typeof estimateRender> }) {
  if (estimate.bytes <= 0) return null;

  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
        <span className="eyebrow block">Poids estimé</span>
        <p className="num mt-1 text-sm text-white/85">≈ {formatBytes(estimate.bytes)}</p>
        <p className="num mt-0.5 text-[10px] text-white/30">
          {(estimate.bitrateKbps / 1000).toFixed(1)} Mb/s
        </p>
      </div>
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
        <span className="eyebrow block">Durée de rendu</span>
        <p className="num mt-1 text-sm text-white/85">≈ {formatDuration(estimate.seconds)}</p>
        <p className="mt-0.5 text-[10px] text-white/30">
          {estimate.calibrated ? 'ajusté sur vos rendus' : 'avant le premier rendu'}
        </p>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="eyebrow mb-2 block">{label}</span>
      {children}
    </div>
  );
}

function Choice({
  options,
  value,
  onSelect,
}: {
  options: { id: string; label: string }[];
  value: string;
  onSelect(id: string): void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onSelect(option.id)}
          className={cn(
            'num rounded-lg border px-2.5 py-1.5 text-[10px] transition-all duration-200',
            value === option.id
              ? 'border-accent-500/45 bg-accent-500/[0.12] text-accent-200'
              : 'border-white/[0.07] bg-white/[0.02] text-white/45 hover:border-white/[0.14] hover:text-white/80',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Dial({
  label,
  left,
  right,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  left: string;
  right: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(value: number): void;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] text-white/38">{left}</span>
        <span className="num text-2xs text-accent-200">{label}</span>
        <span className="text-[10px] text-white/38">{right}</span>
      </div>
      <Slider aria-label={label} value={value} min={min} max={max} step={step} onChange={onChange} />
    </div>
  );
}

function Note({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <span className="mt-px shrink-0">{icon}</span>
      <p className="text-2xs leading-relaxed text-white/55">{children}</p>
    </div>
  );
}

function EncoderRow({
  status,
  engine,
  onInstalled,
}: {
  status: EncoderStatus | null;
  engine: string;
  onInstalled(status: EncoderStatus): void;
}) {
  if (!status) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-2xs text-white/35">
        Détection de l’encodeur…
      </div>
    );
  }

  if (!status.available) {
    return <FfmpegNotice status={status} onInstalled={onInstalled} />;
  }

  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <Cpu size={13} strokeWidth={2} className="shrink-0 text-accent-300" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-2xs text-white/60">
          {status.version ?? 'ffmpeg'} · plan {engine === 'rust' ? 'natif' : 'TypeScript'}
        </p>
        {!status.probeAvailable && (
          <p className="mt-0.5 text-[10px] text-white/30">
            ffprobe absent — seules les pistes audio seront mixées.
          </p>
        )}
      </div>
    </div>
  );
}

function ProgressBar({ progress, fps }: { progress: ExportProgress | null; fps: number }) {
  const ratio = progress?.ratio ?? 0;
  const remaining = progress ? estimateRemaining(progress, fps) : null;

  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.022] px-3 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-2xs text-white/70">{progress?.stage ?? 'Démarrage'}</span>
        <span className="num flex items-center gap-2 text-2xs text-white/45">
          {progress && progress.speed > 0 && (
            <span className="flex items-center gap-1 text-white/28">
              <Gauge size={10} strokeWidth={2} />
              {progress.speed.toFixed(2)}×
            </span>
          )}
          {remaining !== null && <span>reste {formatClock(remaining)}</span>}
          <span>{Math.round(ratio * 100)} %</span>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
        <div
          className="h-full rounded-full bg-accent-500 transition-[width] duration-150 ease-smooth"
          style={{ width: `${Math.max(ratio * 100, 2)}%` }}
        />
      </div>
      {progress && (
        <p className="num mt-2 text-[10px] text-white/28">
          image {progress.frame} / {progress.totalFrames}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.022] px-3 py-2.5">
      <p className="eyebrow">{label}</p>
      <p className="num mt-1 text-[13px] font-medium text-white/85">{value}</p>
    </div>
  );
}
