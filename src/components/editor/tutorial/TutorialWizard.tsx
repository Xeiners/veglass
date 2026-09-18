import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  GraduationCap,
  Loader2,
  MonitorPlay,
  Settings2,
  TriangleAlert,
  X,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatClock } from '@/lib/time';
import { MAX_TOTAL_FRAMES, MIN_TOTAL_FRAMES, normalizeFrameCount, samplingPlan } from '@/lib/tutorial/frames';
import { Button } from '@/components/ui/Button';
import { Field, Input, OptionCard } from '@/components/ui/Field';
import { Footer, Toggle, Warning } from '@/components/ui/Wizard';
import { useAi } from '@/store/aiStore';
import { useEditor } from '@/store/editorStore';
import { canSpeak, useVoice } from '@/store/voiceStore';
import {
  STEP_ORDER,
  closingCost,
  scriptCost,
  useTutorial,
  type WizardStep,
} from '@/store/tutorialStore';
import {
  AUDIENCE_OPTIONS,
  MAX_BRIEF,
  STAGE_LABELS,
  ZOOM_PROFILES,
  isRunning,
} from '@/types/tutorial';
import { BANNER_PRESETS, bannerFromPreset } from '@/types/banner';
import { BACKDROP_PRESETS } from '@/types/backdrop';
import { BannerPreview } from '@/components/editor/banner/BannerPreview';
import { TutorialReview } from './TutorialReview';

const STEP_LABELS: Record<WizardStep, string> = {
  source: 'Source',
  settings: 'Réglages',
  work: 'Analyse',
  review: 'Étapes',
};

/**
 * The tutorial generator.
 *
 * Four steps, because the decisions genuinely are sequential: what to turn into
 * a tutorial, how it should be narrated and framed, a wait that has to be
 * legible because it costs real money at two services, and finally a script to
 * read before any of it touches the document.
 *
 * Nothing is written to the project until the last step, and that write is one
 * `transact` — see `store/tutorialStore`.
 */
export function TutorialWizard() {
  const open = useTutorial((state) => state.open);
  const step = useTutorial((state) => state.step);
  const close = useTutorial((state) => state.close);
  const cost = useTutorial(closingCost);

  const [confirming, setConfirming] = useState(false);

  /**
   * Closing is not always free, so it is not always immediate.
   *
   * `close` aborts the run *and* sweeps every voice-over take off the disk, so
   * a reflex click on the cross can throw away several minutes of analysis and
   * a page of synthesis that was paid for. When there is nothing at stake it
   * still closes on the first click — a confirmation nobody needs is a
   * confirmation everybody learns to dismiss without reading.
   */
  const requestClose = () => {
    if (cost === null) {
      close();
      return;
    }
    setConfirming(true);
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      // Escape backs out of the question before it backs out of the wizard.
      if (confirming) setConfirming(false);
      else requestClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, confirming, cost, close]);

  // A wizard reopened after being closed must not still be asking.
  useEffect(() => {
    if (!open) setConfirming(false);
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[70] flex animate-fade-in items-center justify-center bg-ink-950/75 p-4 backdrop-blur-sm sm:p-8">
      <div
        className={cn(
          'relative flex h-full w-full max-w-[1120px] animate-scale-in flex-col overflow-hidden',
          'rounded-2xl border border-white/[0.08] bg-ink-850/95 shadow-lift backdrop-blur-2xl',
        )}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />

        <header className="flex shrink-0 items-center gap-4 border-b border-white/[0.06] px-5 py-3.5">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent-500/[0.12] text-accent-300">
            <GraduationCap size={16} strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tightest text-white">
              Tutoriel automatique
            </h2>
            <p className="mt-0.5 truncate text-[10px] text-white/28">
              D’un enregistrement d’écran brut à un tutoriel monté, commenté et chapitré
            </p>
          </div>

          <Stepper current={step} />

          <button
            type="button"
            onClick={requestClose}
            aria-label="Fermer"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/80"
          >
            <X size={15} strokeWidth={2} />
          </button>
        </header>

        {step === 'source' && <SourceStep />}
        {step === 'settings' && <SettingsStep />}
        {step === 'work' && <WorkStep />}
        {step === 'review' && <TutorialReview />}

        {confirming && cost !== null && (
          <CloseGuard cost={cost} onCancel={() => setConfirming(false)} onConfirm={close} />
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The question asked before an expensive close.
 *
 * Drawn inside the wizard rather than through `Modal`: the wizard is its own
 * portal at a higher stacking level, so a `Modal` would open *behind* it — and
 * a confirmation nobody can see is worse than none at all.
 */
function CloseGuard({
  cost,
  onCancel,
  onConfirm,
}: {
  cost: 'running' | 'unplaced';
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <div className="absolute inset-0 z-10 grid animate-fade-in place-items-center bg-ink-950/70 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Fermer le générateur"
        className="w-full max-w-md animate-scale-in rounded-2xl border border-white/[0.08] bg-ink-850 p-6 shadow-lift"
      >
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-500/[0.14] text-amber-400">
            <TriangleAlert size={16} strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold tracking-tightest text-white">
              Fermer et tout annuler ?
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-white/50">
              {cost === 'running'
                ? "L’analyse en cours sera interrompue et perdue. Ce qui a déjà été demandé au modèle est facturé, et fermer maintenant ne le récupère pas — il faudra tout relancer depuis le début."
                : "Les étapes trouvées et la voix off déjà enregistrée seront perdues, et les fichiers audio effacés du disque. Rien n’a encore été ajouté au montage : pour les garder, fermez cette fenêtre après avoir cliqué sur « Monter le tutoriel »."}
            </p>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2.5">
          <Button variant="secondary" onClick={onCancel}>
            {cost === 'running' ? 'Laisser tourner' : 'Revenir aux étapes'}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            Fermer et tout perdre
          </Button>
        </div>
      </div>
    </div>
  );
}

function Stepper({ current }: { current: WizardStep }) {
  const index = STEP_ORDER.indexOf(current);

  return (
    <ol className="ml-auto hidden shrink-0 items-center gap-1 md:flex">
      {STEP_ORDER.map((step, position) => {
        const done = position < index;
        const active = position === index;
        return (
          <li key={step} className="flex items-center gap-1">
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-2xs transition-colors',
                active && 'bg-accent-500/[0.12] font-medium text-accent-200',
                done && 'text-white/45',
                !active && !done && 'text-white/25',
              )}
            >
              {done ? (
                <Check size={11} strokeWidth={2.6} />
              ) : (
                <span className="num text-[10px]">{position + 1}</span>
              )}
              {STEP_LABELS[step]}
            </span>
            {position < STEP_ORDER.length - 1 && (
              <span aria-hidden className="h-px w-3 bg-white/[0.09]" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ *
 * Step 1 — the recording
 * ------------------------------------------------------------------ */

function SourceStep() {
  const project = useEditor((state) => state.project);
  const options = useTutorial((state) => state.options);
  const setOptions = useTutorial((state) => state.setOptions);
  const goTo = useTutorial((state) => state.goTo);
  const error = useTutorial((state) => state.error);

  const candidates = (project?.assets ?? []).filter(
    (asset) => asset.kind === 'video' && !asset.missing,
  );
  const chosen = candidates.find((asset) => asset.id === options.assetId) ?? null;

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <p className="mb-4 max-w-[68ch] text-2xs leading-relaxed text-white/40">
          Choisissez l’enregistrement d’écran. Le générateur le regarde image par image, repère les
          actions et ce qu’elles servent, écrit le commentaire, l’enregistre et monte le tout —
          rien n’est ajouté au projet avant que vous ne le demandiez.
        </p>

        {candidates.length === 0 ? (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.022] px-4 py-8 text-center">
            <div className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-white/[0.05] text-white/40">
              <MonitorPlay size={17} strokeWidth={2} />
            </div>
            <p className="mt-3 text-[13px] text-white/70">Aucune vidéo dans ce projet</p>
            <p className="mx-auto mt-1.5 max-w-[46ch] text-2xs leading-relaxed text-white/35">
              Importez votre capture d’écran dans les médias du projet, puis revenez ici.
            </p>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {candidates.map((asset) => (
              <OptionCard
                key={asset.id}
                active={asset.id === options.assetId}
                onSelect={() => setOptions({ assetId: asset.id })}
                title={asset.name}
                subtitle={[
                  asset.duration > 0 ? formatClock(asset.duration) : 'durée inconnue',
                  asset.width && asset.height ? `${asset.width} × ${asset.height}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                aside={
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/[0.05] text-white/40">
                    <MonitorPlay size={15} strokeWidth={2} />
                  </span>
                }
              />
            ))}
          </div>
        )}

        {error && <Warning>{error}</Warning>}

        {chosen && !chosen.width && (
          <Warning tone="soft">
            Les dimensions de cet enregistrement ne sont pas encore connues. Sans elles la caméra ne
            peut pas viser un point de l’écran : les étapes et les chapitres seront là, les zooms
            non. Lisez la vidéo une fois dans l’aperçu pour que Veglass la mesure.
          </Warning>
        )}
      </div>

      <Footer
        right={
          <Button variant="primary" disabled={!chosen} onClick={() => goTo('settings')}>
            Continuer
          </Button>
        }
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Step 2 — how it should read
 * ------------------------------------------------------------------ */

function SettingsStep() {
  const project = useEditor((state) => state.project);
  const options = useTutorial((state) => state.options);
  const setOptions = useTutorial((state) => state.setOptions);
  const goTo = useTutorial((state) => state.goTo);
  const run = useTutorial((state) => state.run);
  const error = useTutorial((state) => state.error);

  const geminiReady = useAi((state) => state.keyStatus.configured);
  const openAiSettings = useAi((state) => state.openSettings);
  const voice = useVoice((state) => state);
  const voiceReady = canSpeak(voice);

  const asset = (project?.assets ?? []).find((item) => item.id === options.assetId) ?? null;
  const [frameDraft, setFrameDraft] = useState(String(options.frameCount ?? 120));
  const customFrames = options.frameCount != null;
  const parsedFrames = Number(frameDraft);
  const invalidFrames = customFrames && (!frameDraft.trim() || !Number.isInteger(parsedFrames) || parsedFrames < MIN_TOTAL_FRAMES || parsedFrames > MAX_TOTAL_FRAMES);
  const plan = samplingPlan(asset?.duration ?? 0, options.frameCount);
  const plannedFrames = plan.reduce((sum, span) => sum + span.times.length, 0);

  return (
    <>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
        <Field label="Images envoyées à l’IA" hint="Pour l’ensemble de cet enregistrement">
          <div className="flex flex-wrap items-center gap-3">
            <select
              aria-label="Mode de sélection des images"
              value={customFrames ? 'custom' : 'auto'}
              onChange={(event) => {
                const frameCount = event.target.value === 'auto' ? null : normalizeFrameCount(Number(frameDraft)) ?? 120;
                if (frameCount !== null) setFrameDraft(String(frameCount));
                setOptions({ frameCount });
              }}
              className="rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-2xs text-white/80"
            >
              <option value="auto">Automatique — réglage actuel</option>
              <option value="custom">Choisir le nombre total</option>
            </select>
            {customFrames && <Input
              aria-label="Nombre total d’images"
              aria-invalid={invalidFrames}
              aria-describedby="tutorial-frame-estimate"
              type="number"
              min={MIN_TOTAL_FRAMES}
              max={MAX_TOTAL_FRAMES}
              step={1}
              value={frameDraft}
              onChange={(event) => {
                const raw = event.target.value;
                setFrameDraft(raw);
                const count = Number(raw);
                if (raw.trim() && Number.isInteger(count) && count >= MIN_TOTAL_FRAMES && count <= MAX_TOTAL_FRAMES) setOptions({ frameCount: count });
              }}
              className="max-w-32"
            />}
          </div>
          <p id="tutorial-frame-estimate" className="mt-2 text-2xs leading-relaxed text-white/55">
            {invalidFrames
              ? `Saisissez un nombre entier entre ${MIN_TOTAL_FRAMES} et ${MAX_TOTAL_FRAMES}.`
              : `${plannedFrames} images prévues · ${plan.length} envoi${plan.length > 1 ? 's' : ''}${plannedFrames > 0 && asset ? ` · environ une image toutes les ${(asset.duration / plannedFrames).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s` : ''}.`}
          </p>
          <p className="mt-1.5 text-[10px] leading-relaxed text-white/35">
            Automatique : jusqu’à 40 images par tranche d’environ 6 minutes. En mode personnalisé,
            les images supplémentaires sont réparties en lots de 40 maximum, avec une limite de
            2 images par seconde sur les vidéos courtes. Plus d’images peut aider à repérer les
            actions rapides, mais augmente le temps d’analyse et le coût IA. Cela ne garantit pas
            une narration continue. Les images illisibles sont ignorées.
          </p>
        </Field>

        <Field label="À qui vous vous adressez" hint="Décide de la longueur du commentaire">
          <div className="grid gap-2 sm:grid-cols-3">
            {AUDIENCE_OPTIONS.map((audience) => (
              <OptionCard
                key={audience.id}
                active={options.audience === audience.id}
                onSelect={() => setOptions({ audience: audience.id })}
                title={audience.label}
                subtitle={audience.hint}
              />
            ))}
          </div>
        </Field>

        <Field label="Mouvement de caméra" hint="Les zooms sur l’action, image par image">
          <div className="grid gap-2 sm:grid-cols-4">
            {ZOOM_PROFILES.map((profile) => (
              <OptionCard
                key={profile.id}
                active={options.zoom === profile.id}
                onSelect={() => setOptions({ zoom: profile.id })}
                title={profile.label}
                subtitle={
                  profile.factor > 1 ? `${Math.round(profile.factor * 100)} %` : 'Aucun zoom'
                }
              />
            ))}
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-white/28">
            {ZOOM_PROFILES.find((profile) => profile.id === options.zoom)?.hint}
          </p>
        </Field>

        <div className="grid gap-2 sm:grid-cols-2">
          <Toggle
            checked={options.voiceover}
            onChange={(voiceover) => setOptions({ voiceover })}
            title="Voix off"
            hint="Le commentaire est écrit puis enregistré par ElevenLabs, phrase par phrase."
          />
          <Toggle
            checked={options.chapters}
            onChange={(chapters) => setOptions({ chapters })}
            title="Chapitres"
            hint="Un repère nommé sur la règle temporelle à chaque étape."
          />
          <Toggle
            checked={options.duckOriginal}
            onChange={(duckOriginal) => setOptions({ duckOriginal })}
            disabled={!options.voiceover}
            title="Atténuer le son d’origine"
            hint="Le bruit du clavier passe sous la voix sans disparaître."
          />
          <Toggle
            checked={options.banners}
            onChange={(banners) => setOptions({ banners })}
            title="Bandes titres"
            hint="Un habillage à chaque nouvelle partie, un badge à chaque raccourci clavier."
          />
          <Toggle
            checked={options.cursor}
            onChange={(cursor) => setOptions({ cursor })}
            title="Curseur lissé"
            hint="Un pointeur dessiné, sa trajectoire adoucie, et un halo à chaque clic."
          />
          <Toggle
            checked={options.backdrop !== null}
            onChange={(on) => setOptions({ backdrop: on ? BACKDROP_PRESETS[0]!.id : null })}
            title="Fond flouté"
            hint="Une copie floutée de l’image comble le vide autour d’elle."
          />
          <Toggle
            checked={options.captions}
            onChange={(captions) => setOptions({ captions })}
            disabled={!options.voiceover}
            title="Sous-titres"
            hint="Calés sur les mots réellement prononcés, pas sur le texte."
          />
        </div>

        {options.banners && (
          <Field label="Modèle d’habillage" hint="Les raccourcis gardent le leur">
            <div className="grid gap-2 sm:grid-cols-3">
              {BANNER_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setOptions({ bannerPreset: preset.id })}
                  aria-pressed={options.bannerPreset === preset.id}
                  className={cn(
                    'overflow-hidden rounded-xl border text-left transition-all duration-200',
                    options.bannerPreset === preset.id
                      ? 'border-accent-500/50 bg-accent-500/[0.08]'
                      : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.16]',
                  )}
                >
                  {/* Neutral grey stands in for footage — a banner judged
                      against the panel's own background looks wrong over video. */}
                  <span className="block bg-[#2A2F38] py-1.5">
                    <BannerPreview
                      layer={bannerFromPreset(preset.id)}
                      width={210}
                      height={70}
                      className="mx-auto block"
                    />
                  </span>
                  <span className="block px-2.5 py-2 text-2xs font-medium text-white/80">
                    {preset.label}
                  </span>
                </button>
              ))}
            </div>
          </Field>
        )}

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Langue" hint="Vide : la langue entendue">
            <Input
              value={options.language}
              placeholder="français"
              onChange={(event) => setOptions({ language: event.target.value })}
            />
          </Field>

          <Field
            label="Consignes"
            hint={
              <span className="num">
                {options.brief.length} / {MAX_BRIEF}
              </span>
            }
          >
            <Input
              value={options.brief}
              maxLength={MAX_BRIEF}
              placeholder="logiciel de caisse, vouvoyer, ne pas commenter la connexion…"
              onChange={(event) => setOptions({ brief: event.target.value })}
            />
          </Field>
        </div>

        {!geminiReady && (
          <Warning>
            Aucune clé Gemini enregistrée — c’est elle qui regarde l’écran et écrit le script.{' '}
            <button
              type="button"
              onClick={() => openAiSettings(true)}
              className="underline underline-offset-2 hover:text-amber-50"
            >
              Ouvrir les réglages
            </button>
          </Warning>
        )}

        {options.voiceover && !voiceReady && (
          <Warning>
            {voice.available
              ? 'La voix off demande une clé ElevenLabs et une voix choisie. '
              : "La voix off n'est disponible que dans l'application de bureau. "}
            {voice.available && (
              <button
                type="button"
                onClick={() => openAiSettings(true)}
                className="underline underline-offset-2 hover:text-amber-50"
              >
                Ouvrir les réglages, onglet Voix
              </button>
            )}
            {!voice.available &&
              'Décochez-la pour obtenir tout de même le montage, les zooms et les chapitres.'}
          </Warning>
        )}

        {options.cursor && (
          <Warning tone="soft">
            Le curseur dessiné se pose <em>par-dessus</em> l’enregistrement : celui du système reste
            dans l’image. Si votre capture le montre, vous en verrez deux — masquez-le à
            l’enregistrement, ou décochez cette option.
          </Warning>
        )}

        {error && <Warning>{error}</Warning>}

        {asset && asset.duration > 15 * 60 && (
          <Warning tone="soft">
            {formatClock(asset.duration)} d’enregistrement seront lus en plusieurs passes. Comptez
            plusieurs minutes d’extraction d’images avant la première étape proposée.
          </Warning>
        )}
      </div>

      <Footer
        left={
          <Button variant="ghost" onClick={() => goTo('source')}>
            Retour
          </Button>
        }
        right={
          <Button
            variant="primary"
            disabled={!geminiReady || invalidFrames}
            icon={<Settings2 size={13} strokeWidth={2.2} />}
            onClick={() => void run()}
          >
            Analyser l’enregistrement
          </Button>
        }
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Step 3 — the wait
 * ------------------------------------------------------------------ */

/**
 * Seconds since `startedAt`, ticking once a second.
 *
 * Its own hook so the interval is torn down the moment the run ends: a timer
 * left running behind a finished wizard is the classic way a dialog keeps
 * re-rendering an idle screen forever.
 */
function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return startedAt === null ? 0 : Math.max(0, (now - startedAt) / 1000);
}

function WorkStep() {
  const stage = useTutorial((state) => state.stage);
  const progress = useTutorial((state) => state.progress);
  const startedAt = useTutorial((state) => state.startedAt);
  const detail = useTutorial((state) => state.detail);
  const error = useTutorial((state) => state.error);
  const steps = useTutorial((state) => state.steps);
  const cancel = useTutorial((state) => state.cancel);
  const run = useTutorial((state) => state.run);
  const goTo = useTutorial((state) => state.goTo);

  const running = isRunning(stage);
  const cost = scriptCost(steps);
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  const elapsed = useElapsed(running ? startedAt : null);

  /*
   * The analysis is one Gemini call over a whole window of frames, so the bar
   * genuinely does not move while it runs — for a short recording that is a
   * single stretch of several minutes at one number. A frozen percentage and a
   * hung request look identical, so the elapsed clock is what separates them.
   */
  const stalled = running && stage === 'analysing';

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-5 py-10 text-center">
        <div
          className={cn(
            'grid h-14 w-14 place-items-center rounded-2xl',
            stage === 'failed'
              ? 'bg-amber-500/[0.12] text-amber-400'
              : 'bg-accent-500/[0.12] text-accent-300',
          )}
        >
          {running ? (
            <Loader2 size={22} strokeWidth={2} className="animate-spin" />
          ) : stage === 'failed' ? (
            <TriangleAlert size={22} strokeWidth={2} />
          ) : (
            <Check size={22} strokeWidth={2.4} />
          )}
        </div>

        <p className="mt-4 text-[15px] font-medium text-white/85">{STAGE_LABELS[stage]}</p>
        {detail && <p className="mt-1.5 max-w-[54ch] text-2xs text-white/40">{detail}</p>}

        {running && (
          <div className="mt-6 w-full max-w-sm">
            <div
              className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={STAGE_LABELS[stage]}
            >
              <div
                className="h-full rounded-full bg-accent-500 transition-[width] duration-500 ease-smooth"
                style={{ width: `${percent}%` }}
              />
            </div>

            <div className="mt-2 flex items-baseline justify-between">
              <span className="num text-[11px] font-medium text-white/70">{percent} %</span>
              <span className="num text-[10px] text-white/30">
                {formatClock(elapsed)}
                {stalled && ' · une seule requête, longue par nature'}
              </span>
            </div>
          </div>
        )}

        {stage === 'speaking' && cost > 0 && (
          <p className="num mt-3 text-[10px] text-white/25">
            {cost.toLocaleString('fr-FR')} caractères de synthèse
          </p>
        )}

        {error && (
          <p className="mt-5 max-w-[60ch] text-2xs leading-relaxed text-amber-100/75">{error}</p>
        )}
      </div>

      <Footer
        left={
          running ? (
            <Button variant="ghost" onClick={cancel}>
              Arrêter
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => goTo('settings')}>
              Retour aux réglages
            </Button>
          )
        }
        right={
          !running && (
            <Button variant="primary" onClick={() => void run()}>
              Réessayer
            </Button>
          )
        }
      />
    </>
  );
}
