import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Check, Film, Loader2, Sparkles, TriangleAlert, X } from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatClock } from '@/lib/time';
import { Button } from '@/components/ui/Button';
import { Footer, Toggle, Warning } from '@/components/ui/Wizard';
import { Field, Input, OptionCard } from '@/components/ui/Field';
import { Slider } from '@/components/ui/Slider';
import { useAi } from '@/store/aiStore';
import { useEditor } from '@/store/editorStore';
import { STEP_ORDER, useViral, type WizardStep } from '@/store/viralStore';
import { reframe, keptWidth } from '@/lib/viral/frame';
import {
  FORMAT_OPTIONS,
  LENGTH_OPTIONS,
  MAX_BRIEF,
  MAX_CLIPS,
  MIN_CLIPS,
  STAGE_LABELS,
  TONE_OPTIONS,
  frameOf,
  isRunning,
} from '@/types/viral';
import { PACE_OPTIONS } from '@/lib/viral/gaps';
import { KitPicker } from './KitPicker';
import { ViralResults } from './ViralResults';

const STEP_LABELS: Record<WizardStep, string> = {
  source: 'Source',
  settings: 'Réglages',
  work: 'Analyse',
  results: 'Extraits',
};

/**
 * The viral-clip generator.
 *
 * Four steps, because the interesting decisions genuinely are sequential: what
 * to mine, what shape to want, then a wait that has to be legible, then a set
 * of proposals to accept or discard. Nothing is written to the document until
 * the last step, and each of those writes is a single undo step.
 */
export function ViralWizard() {
  const open = useViral((state) => state.open);
  const step = useViral((state) => state.step);
  const close = useViral((state) => state.close);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, close]);

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
            <Sparkles size={16} strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tightest text-white">
              Clips viraux
            </h2>
            <p className="mt-0.5 truncate text-[10px] text-white/28">
              Découper une vidéo longue en extraits autonomes
            </p>
          </div>

          <Stepper current={step} />

          <button
            type="button"
            onClick={close}
            aria-label="Fermer"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/80"
          >
            <X size={15} strokeWidth={2} />
          </button>
        </header>

        {step === 'source' && <SourceStep />}
        {step === 'settings' && <SettingsStep />}
        {step === 'work' && <WorkStep />}
        {step === 'results' && <ViralResults />}
      </div>
    </div>,
    document.body,
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
              <span
                className={cn(
                  'num grid h-4 w-4 place-items-center rounded-full text-[9px]',
                  active && 'bg-accent-500 text-white',
                  done && 'bg-white/[0.12] text-white/60',
                  !active && !done && 'border border-white/[0.12]',
                )}
              >
                {done ? <Check size={9} strokeWidth={3} /> : position + 1}
              </span>
              {STEP_LABELS[step]}
            </span>
            {position < STEP_ORDER.length - 1 && (
              <span className="h-px w-3 bg-white/[0.09]" aria-hidden />
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
  const options = useViral((state) => state.options);
  const setOptions = useViral((state) => state.setOptions);
  const goTo = useViral((state) => state.goTo);
  const error = useViral((state) => state.error);

  // Only video worth mining: an image has nothing to say, and a clip under half
  // a minute cannot yield a thirty-second extract.
  const candidates = (project?.assets ?? []).filter(
    (asset) => asset.kind === 'video' && !asset.missing,
  );

  const chosen = candidates.find((asset) => asset.id === options.assetId) ?? null;

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <p className="mb-4 max-w-[68ch] text-2xs leading-relaxed text-white/40">
          Choisissez l’enregistrement à exploiter. Le générateur écoute ce qui est dit, repère les
          passages qui tiennent debout seuls, et vous les propose — rien n’est ajouté au projet
          avant que vous ne le demandiez.
        </p>

        {candidates.length === 0 ? (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.022] px-4 py-8 text-center">
            <div className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-white/[0.05] text-white/40">
              <Film size={17} strokeWidth={2} />
            </div>
            <p className="mt-3 text-[13px] text-white/70">Aucune vidéo dans ce projet</p>
            <p className="mx-auto mt-1.5 max-w-[42ch] text-2xs leading-relaxed text-white/35">
              Importez la vidéo longue dans les médias du projet, ou récupérez-la depuis le panneau
              Médias en ligne, puis revenez ici.
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
                    <Film size={15} strokeWidth={2} />
                  </span>
                }
              />
            ))}
          </div>
        )}

        {error && <Warning>{error}</Warning>}

        {chosen && chosen.duration > 0 && chosen.duration < 120 && (
          <Warning tone="soft">
            Cette vidéo dure {formatClock(chosen.duration)}. Il y aura peu à en tirer — le
            générateur donne son meilleur sur des enregistrements longs.
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
 * Step 2 — what to aim for
 * ------------------------------------------------------------------ */

function SettingsStep() {
  const project = useEditor((state) => state.project);
  const options = useViral((state) => state.options);
  const setOptions = useViral((state) => state.setOptions);
  const goTo = useViral((state) => state.goTo);
  const run = useViral((state) => state.run);
  const configured = useAi((state) => state.keyStatus.configured);
  const openSettings = useAi((state) => state.openSettings);

  const asset = (project?.assets ?? []).find((item) => item.id === options.assetId) ?? null;
  const target = frameOf(options.format, project?.settings.fps ?? 30);
  const framing = asset ? reframe(asset, target) : null;
  const kept = framing && framing.known ? keptWidth(framing, target) : null;

  return (
    <>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
        <Field label="Format de sortie" hint="Le cadrage des extraits">
          <div className="grid gap-2 sm:grid-cols-3">
            {FORMAT_OPTIONS.map((format) => (
              <OptionCard
                key={format.id}
                active={options.format === format.id}
                onSelect={() => setOptions({ format: format.id })}
                title={format.label}
                subtitle={format.hint}
                aside={
                  <span
                    className={cn(
                      'shrink-0 rounded border border-white/25 bg-white/[0.06]',
                      format.id === 'vertical' && 'h-8 w-[18px]',
                      format.id === 'square' && 'h-7 w-7',
                      format.id === 'horizontal' && 'h-[18px] w-8',
                    )}
                    aria-hidden
                  />
                }
              />
            ))}
          </div>
        </Field>

        {kept !== null && kept < 0.99 && (
          <Warning tone="soft">
            Passer de {asset?.width} × {asset?.height} à {target.width} × {target.height} conserve
            environ {Math.round(kept * 100)} % de la largeur d’origine. Le cadrage part du centre,
            et reste réglable extrait par extrait à l’étape suivante.
          </Warning>
        )}

        <Field label="Durée visée" hint="Une contrainte, pas une indication">
          <div className="grid gap-2 sm:grid-cols-3">
            {LENGTH_OPTIONS.map((length) => (
              <OptionCard
                key={length.id}
                active={options.length === length.id}
                onSelect={() => setOptions({ length: length.id })}
                title={length.label}
                subtitle={length.hint}
              />
            ))}
          </div>
        </Field>

        <Field label="Ce que vous cherchez">
          <div className="grid gap-2 sm:grid-cols-3">
            {TONE_OPTIONS.map((tone) => (
              <OptionCard
                key={tone.id}
                active={options.tone === tone.id}
                onSelect={() => setOptions({ tone: tone.id })}
                title={tone.label}
                subtitle={tone.hint}
              />
            ))}
          </div>
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Nombre d’extraits"
            hint={<span className="num">{options.count} au maximum</span>}
          >
            <Slider
              value={options.count}
              min={MIN_CLIPS}
              max={MAX_CLIPS}
              step={1}
              onChange={(count) => setOptions({ count: Math.round(count) })}
              aria-label="Nombre d’extraits"
            />
            <p className="mt-1.5 text-[10px] leading-relaxed text-white/28">
              S’il n’y a pas la matière, le modèle en rend moins. C’est voulu.
            </p>
          </Field>

          <Field label="Langue" hint="Vide = détection automatique">
            <Input
              value={options.language}
              onChange={(event) => setOptions({ language: event.target.value })}
              placeholder="français, anglais…"
            />
          </Field>
        </div>

        <Field
          label="Consignes"
          hint={
            <span className="num">
              {options.brief.length} / {MAX_BRIEF}
            </span>
          }
        >
          <textarea
            value={options.brief}
            onChange={(event) => setOptions({ brief: event.target.value.slice(0, MAX_BRIEF) })}
            rows={3}
            placeholder="Ex. : ne garde que ce qui parle de recrutement · évite le passage sur les tarifs · des accroches sous forme de question · garde le passage où il parle de son premier échec"
            className={cn(
              'w-full resize-y rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5',
              'text-2xs leading-relaxed text-white/85 placeholder:text-white/25',
              'transition-colors focus:border-accent-500/40 focus:bg-white/[0.04] focus:outline-none',
            )}
          />
          <p className="mt-1.5 text-[10px] leading-relaxed text-white/28">
            Écrivez ce que vous cherchez, dans vos mots. Ces consignes priment sur le registre
            choisi au-dessus. S’il n’y a rien qui y corresponde dans la vidéo, le modèle rendra
            moins d’extraits plutôt que d’en inventer.
          </p>
        </Field>

        <Field label="Sous-titres">
          <div className="space-y-2">
            <Toggle
              checked={options.subtitles}
              onChange={(subtitles) => setOptions({ subtitles })}
              title="Incruster les sous-titres"
              hint="Repris de la transcription déjà faite — aucune passe supplémentaire."
            />
            {options.subtitles && (
              <Toggle
                checked={options.wordByWord}
                onChange={(wordByWord) => setOptions({ wordByWord })}
                title="Mot à mot"
                hint="Un mot par clip, animé — le rendu des sous-titres de format court."
              />
            )}
            <Toggle
              checked={options.hooks}
              onChange={(hooks) => setOptions({ hooks })}
              title="Bandeau d’accroche sur les 3 premières secondes"
              hint="Une phrase de quatre ou cinq mots, écrite par le modèle, incrustée en gros."
            />
          </div>
        </Field>

        <Field label="Rythme">
          <div className="space-y-2">
            <Toggle
              checked={options.jumpCuts}
              onChange={(jumpCuts) => setOptions({ jumpCuts })}
              title="Supprimer les temps morts"
              hint="Les blancs entre les phrases sont retirés et les blocs rapprochés — sous-titres, accroche et images clés se recalent avec eux."
            />
            {options.jumpCuts && (
              <div className="grid gap-2 sm:grid-cols-3">
                {PACE_OPTIONS.map((pace) => (
                  <OptionCard
                    key={pace.id}
                    active={options.pace === pace.id}
                    onSelect={() => setOptions({ pace: pace.id })}
                    title={pace.label}
                    subtitle={pace.hint}
                  />
                ))}
              </div>
            )}
            <Toggle
              checked={options.progressBar}
              onChange={(progressBar) => setOptions({ progressBar })}
              title="Barre de progression"
              hint="Une fine ligne qui se remplit au fil du clip. Uniquement sur une séquence dédiée : elle appartient à la composition entière."
            />
          </div>
        </Field>

        <Field
          label="Brand kit"
          hint="La tenue graphique appliquée aux textes générés"
        >
          <KitPicker />
        </Field>

        {!configured && (
          <Warning>
            Aucune clé d’API n’est enregistrée. L’analyse a besoin de Gemini pour écouter la vidéo.{' '}
            <button
              type="button"
              onClick={() => openSettings(true)}
              className="underline underline-offset-2 hover:text-white"
            >
              Ouvrir les réglages
            </button>
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
            icon={<Sparkles size={14} strokeWidth={2} />}
            disabled={!configured || !asset}
            onClick={() => void run()}
          >
            Lancer l’analyse
          </Button>
        }
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Step 3 — the wait
 * ------------------------------------------------------------------ */

function WorkStep() {
  const stage = useViral((state) => state.stage);
  const progress = useViral((state) => state.progress);
  const detail = useViral((state) => state.detail);
  const error = useViral((state) => state.error);
  const cancel = useViral((state) => state.cancel);
  const goTo = useViral((state) => state.goTo);
  const run = useViral((state) => state.run);

  const running = isRunning(stage);

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-5 py-10 text-center">
        <div
          className={cn(
            'grid h-14 w-14 place-items-center rounded-2xl',
            stage === 'failed'
              ? 'bg-red-500/[0.12] text-red-300'
              : 'bg-accent-500/[0.12] text-accent-300',
          )}
        >
          {running ? (
            <Loader2 size={22} strokeWidth={2} className="animate-spin" />
          ) : stage === 'failed' ? (
            <TriangleAlert size={22} strokeWidth={2} />
          ) : (
            <Sparkles size={22} strokeWidth={2} />
          )}
        </div>

        <h3 className="mt-4 text-[15px] font-medium text-white/90">{STAGE_LABELS[stage]}</h3>
        {detail && <p className="mt-1.5 text-2xs text-white/40">{detail}</p>}

        {running && (
          <div className="mt-6 w-full max-w-sm">
            <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.07]">
              <div
                className="h-full rounded-full bg-accent-500 transition-[width] duration-500 ease-smooth"
                style={{ width: `${Math.round(Math.max(0.02, progress) * 100)}%` }}
              />
            </div>
            <p className="num mt-2 text-[10px] text-white/28">
              {Math.round(progress * 100)} %
            </p>
            <p className="mx-auto mt-4 max-w-[46ch] text-[11px] leading-relaxed text-white/30">
              Écouter une vidéo longue prend plusieurs minutes. Vous pouvez fermer cette fenêtre :
              l’analyse s’arrête, elle ne continue pas en arrière-plan.
            </p>
          </div>
        )}

        {error && (
          <p className="mx-auto mt-4 max-w-[52ch] text-2xs leading-relaxed text-red-200/80">
            {error}
          </p>
        )}
      </div>

      <Footer
        left={
          running ? (
            <Button variant="ghost" onClick={cancel}>
              Annuler
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
