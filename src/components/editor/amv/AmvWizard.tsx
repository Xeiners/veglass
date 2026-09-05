import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  AudioLines,
  Check,
  Film,
  FolderOpen,
  Loader2,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { isTauri } from '@/lib/env';
import { formatClock } from '@/lib/time';
import { usableSources } from '@/lib/amv/sources';
import { useEditor } from '@/store/editorStore';
import type { MediaAsset } from '@/types/media';
import { Button } from '@/components/ui/Button';
import { Footer, Toggle, Warning } from '@/components/ui/Wizard';
import { Field, OptionCard } from '@/components/ui/Field';
import { Slider } from '@/components/ui/Slider';
import { STEP_ORDER, useAmv, type WizardStep } from '@/store/amvStore';
import { AMV_PROFILES, AMV_STAGE_LABELS, AMV_LIMITS, isRunning } from '@/types/amv';
import { AmvReview } from './AmvReview';

const STEP_LABELS: Record<WizardStep, string> = {
  source: 'Sources',
  settings: 'Profil',
  work: 'Analyse',
  review: 'Rythme',
};

/**
 * The rhythmic-montage generator.
 *
 * Four steps, for the same reason the viral wizard has four: the decisions are
 * genuinely sequential. What to cut and what to cut it to, then how it should
 * feel, then a wait that has to be legible, then a rhythm to accept or to
 * adjust. Nothing is written to the document until the last step, and that
 * write is a single undo step.
 */
export function AmvWizard() {
  const open = useAmv((state) => state.open);
  const step = useAmv((state) => state.step);
  const close = useAmv((state) => state.close);

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
            <AudioLines size={16} strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tightest text-white">
              Montage rythmé
            </h2>
            <p className="mt-0.5 truncate text-[10px] text-white/28">
              Caler des clips sur les temps forts d’un morceau
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
        {step === 'review' && <AmvReview />}
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
 * Step 1 — the music and the bank
 * ------------------------------------------------------------------ */

function SourceStep() {
  const project = useEditor((state) => state.project);
  const music = useAmv((state) => state.music);
  const sources = useAmv((state) => state.sources);
  const folder = useAmv((state) => state.folder);
  const skipped = useAmv((state) => state.skipped);
  const detail = useAmv((state) => state.detail);
  const error = useAmv((state) => state.error);
  const pickMusic = useAmv((state) => state.pickMusic);
  const toggleSource = useAmv((state) => state.toggleSource);
  const selectAllSources = useAmv((state) => state.selectAllSources);
  const chooseMusic = useAmv((state) => state.chooseMusic);
  const chooseFolder = useAmv((state) => state.chooseFolder);
  const goTo = useAmv((state) => state.goTo);

  const assets = project?.assets ?? [];
  const tracks = assets.filter((asset) => asset.kind === 'audio' && !asset.missing);
  // The same filter the sequencer applies, so a clip listed here is a clip that
  // can actually be cut from — no row that would be silently dropped later.
  const clips = usableSources(assets);

  const chosen = new Set(sources.map((asset) => asset.id));
  const fromPool = clips.filter((asset) => chosen.has(asset.id)).length;
  // Anything in the bank that is not a row above it came from a folder.
  const fromDisk = sources.length - fromPool;
  const musicFromPool = music !== null && tracks.some((asset) => asset.id === music.id);

  const busy = detail !== '';
  const ready = music !== null && sources.length > 0;

  return (
    <>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
        <p className="max-w-[68ch] text-2xs leading-relaxed text-white/40">
          Choisissez un morceau et les clips à monter dessus — dans vos médias, ou sur le disque. Le
          générateur repère les temps forts de la musique et pose une coupe sur chacun. Rien n’est
          ajouté au projet avant que vous ne le demandiez, et seuls les clips réellement montés y
          entreront.
        </p>

        <Field
          label="Le morceau"
          hint={music ? <span className="num">{formatClock(music.duration)}</span> : 'mp3, wav, flac…'}
        >
          <div className="space-y-2">
            {tracks.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-2">
                {tracks.map((asset) => (
                  <OptionCard
                    key={asset.id}
                    active={music?.id === asset.id}
                    onSelect={() => pickMusic(asset.id)}
                    title={asset.name}
                    subtitle={
                      asset.duration > 0 ? formatClock(asset.duration) : 'durée en cours de lecture'
                    }
                    aside={<AssetIcon kind="audio" active={music?.id === asset.id} />}
                  />
                ))}
              </div>
            )}
            <Browse
              label={
                music && !musicFromPool
                  ? music.name
                  : tracks.length > 0
                    ? 'Ou choisir un fichier sur le disque'
                    : 'Choisir un morceau sur le disque'
              }
              hint={
                music && !musicFromPool
                  ? 'Depuis le disque · il rejoindra vos médias avec le montage'
                  : 'Il ne rejoindra vos médias que si vous montez'
              }
              action={music && !musicFromPool ? 'Changer' : 'Parcourir'}
              onPick={() => void chooseMusic()}
              disabled={busy}
              chosen={music !== null && !musicFromPool}
            />
          </div>
        </Field>

        <Field
          label="Les clips"
          hint={
            sources.length > 0 ? (
              <span className="num">{sources.length} dans la banque</span>
            ) : (
              'La banque dans laquelle le séquenceur va piocher'
            )
          }
        >
          <div className="space-y-2">
            {clips.length > 0 && (
              <>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => selectAllSources(true)}>
                    Tout cocher
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={fromPool === 0}
                    onClick={() => selectAllSources(false)}
                  >
                    Tout décocher
                  </Button>
                  <span className="num ml-auto text-2xs text-white/30">
                    {fromPool} / {clips.length}
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {clips.map((asset) => (
                    <OptionCard
                      key={asset.id}
                      active={chosen.has(asset.id)}
                      onSelect={() => toggleSource(asset.id)}
                      title={asset.name}
                      subtitle={[
                        formatClock(asset.duration),
                        asset.width && asset.height ? `${asset.width} × ${asset.height}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      aside={<AssetIcon kind="video" active={chosen.has(asset.id)} />}
                    />
                  ))}
                </div>
              </>
            )}
            <Browse
              label={folder ?? 'Ajouter un dossier de clips'}
              hint={
                fromDisk > 0
                  ? `${fromDisk} clip${fromDisk > 1 ? 's' : ''} depuis le disque · le dossier est lu à plat`
                  : 'Le dossier est lu à plat, sans descendre dans les sous-dossiers'
              }
              action={folder ? 'Changer de dossier' : 'Parcourir'}
              onPick={() => void chooseFolder()}
              disabled={busy}
              chosen={fromDisk > 0}
            />
          </div>
        </Field>

        {busy && (
          <p className="flex items-center gap-2 text-2xs text-white/40">
            <Loader2 size={12} strokeWidth={2} className="animate-spin" />
            {detail}
          </p>
        )}

        {error && <Warning>{error}</Warning>}

        {!isTauri() && (
          <Warning>
            Le montage rythmé n’est disponible que dans l’application de bureau : il décode la
            musique avec ffmpeg pour en tirer les temps, ce que le navigateur ne peut pas faire de
            façon reproductible.
          </Warning>
        )}

        {assets.length > 0 && tracks.length === 0 && clips.length === 0 && (
          <Warning tone="soft">
            Aucun média de ce projet ne convient : le générateur monte des vidéos sur une piste
            audio. Importez-les, ou pointez le sélecteur vers le disque.
          </Warning>
        )}

        {skipped > 0 && (
          <Warning tone="soft">
            {skipped} fichier{skipped > 1 ? 's ont' : ' a'} été écarté{skipped > 1 ? 's' : ''} :
            illisible{skipped > 1 ? 's' : ''}, trop court{skipped > 1 ? 's' : ''}, ou au-delà du
            nombre de clips lus dans un dossier. Le montage se fera avec le reste.
          </Warning>
        )}

        {sources.length > 0 && sources.length < 4 && (
          <Warning tone="soft">
            Avec {sources.length} clip{sources.length > 1 ? 's' : ''}, le montage tournera vite en
            boucle. Une dizaine donne déjà quelque chose qui ne se répète pas.
          </Warning>
        )}
      </div>

      <Footer
        right={
          <Button variant="primary" disabled={!ready || busy} onClick={() => goTo('settings')}>
            Continuer
          </Button>
        }
      />
    </>
  );
}

/** The square that stands in for a clip's thumbnail in the two lists above. */
function AssetIcon({ kind, active }: { kind: MediaAsset['kind']; active: boolean }) {
  return (
    <span
      className={cn(
        'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
        active ? 'bg-accent-500/[0.14] text-accent-300' : 'bg-white/[0.05] text-white/40',
      )}
    >
      {kind === 'audio' ? (
        <AudioLines size={15} strokeWidth={2} />
      ) : (
        <Film size={15} strokeWidth={2} />
      )}
    </span>
  );
}

/**
 * The row that reaches outside the project.
 *
 * Deliberately below the lists rather than beside them: the media already in
 * the project is the answer most of the time, and a file picker offered first
 * would send people to the disk for a clip that is sitting two lines down.
 */
function Browse({
  label,
  hint,
  action,
  onPick,
  disabled,
  chosen,
}: {
  label: string;
  hint: string;
  action: string;
  onPick(): void;
  disabled: boolean;
  chosen: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border border-dashed px-3.5 py-3 transition-colors',
        chosen
          ? 'border-accent-500/35 bg-accent-500/[0.06]'
          : 'border-white/[0.09] bg-white/[0.015]',
      )}
    >
      <span
        className={cn(
          'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
          chosen ? 'bg-accent-500/[0.14] text-accent-300' : 'bg-white/[0.05] text-white/40',
        )}
      >
        <FolderOpen size={15} strokeWidth={2} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-white/80">{label}</span>
        <span className="mt-0.5 block truncate text-2xs text-white/32">{hint}</span>
      </span>
      <Button variant="secondary" size="sm" disabled={disabled} onClick={onPick}>
        {action}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Step 2 — how it should feel
 * ------------------------------------------------------------------ */

function SettingsStep() {
  const options = useAmv((state) => state.options);
  const music = useAmv((state) => state.music);
  const setOptions = useAmv((state) => state.setOptions);
  const goTo = useAmv((state) => state.goTo);
  const run = useAmv((state) => state.run);

  const full = music?.duration ?? 0;
  const cap = Math.min(full > 0 ? full : AMV_LIMITS.maxMontage, AMV_LIMITS.maxMontage);

  return (
    <>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
        <Field label="Profil rythmique" hint="Le caractère du montage">
          <div className="grid gap-2 sm:grid-cols-2">
            {AMV_PROFILES.map((profile) => (
              <OptionCard
                key={profile.id}
                active={options.profile === profile.id}
                onSelect={() => setOptions({ profile: profile.id })}
                title={profile.label}
                subtitle={profile.hint}
                aside={
                  <span
                    className={cn(
                      'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
                      options.profile === profile.id
                        ? 'bg-accent-500/[0.14] text-accent-300'
                        : 'bg-white/[0.05] text-white/40',
                    )}
                  >
                    {profile.id === 'aggressive' ? (
                      <Sparkles size={15} strokeWidth={2} />
                    ) : (
                      <Film size={15} strokeWidth={2} />
                    )}
                  </span>
                }
              />
            ))}
          </div>
        </Field>

        <Field label="Effets d’edit">
          <div className="space-y-2">
            <Toggle
              checked={options.punch}
              onChange={(punch) => setOptions({ punch })}
              title="Punch zoom sur les frappes"
              hint="L’échelle part du cadrage de repos, monte au pic et revient en élastique — des images clés, donc identiques à l’aperçu et à l’export."
            />
            <Toggle
              checked={options.flashes}
              onChange={(flashes) => setOptions({ flashes })}
              title="Flashs et négatifs sur les impacts"
              hint="Un aplat de couleur de quelques images sur les temps les plus forts, et une inversion sur les plus forts encore."
            />
            <Toggle
              checked={options.split}
              onChange={(split) => setOptions({ split })}
              title="Aberration chromatique sur les gros temps"
              hint="Les canaux rouge et bleu se désalignent quelques images sur les frappes les plus fortes — l’écart d’objectif d’un impact."
            />
            <Toggle
              checked={options.smear}
              onChange={(smear) => setOptions({ smear })}
              title="Flou de mouvement sur les coupes"
              hint="Une traînée directionnelle d’une ou deux images à chaque changement de plan, pour que la coupe ne paraisse jamais sèche."
            />
            <Toggle
              checked={options.markers}
              onChange={(markers) => setOptions({ markers })}
              title="Repères sur chaque coupe"
              hint="Des drapeaux sur la règle, pour reprendre le montage à la main ensuite."
            />
          </div>
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Durée du montage"
            hint={
              <span className="num">
                {options.limit > 0 ? formatClock(options.limit) : 'tout le morceau'}
              </span>
            }
          >
            <Slider
              value={options.limit > 0 ? options.limit : cap}
              min={AMV_LIMITS.minMusic}
              max={cap}
              step={1}
              onChange={(limit) =>
                // Dragging to the far right means "the whole track", not "this
                // many seconds" — so the montage still covers the music if the
                // morceau is swapped for a longer one.
                setOptions({ limit: limit >= cap - 0.5 ? 0 : Math.round(limit) })
              }
              aria-label="Durée du montage"
            />
            <p className="mt-1.5 text-[10px] leading-relaxed text-white/28">
              À fond à droite, le montage suit le morceau jusqu’au bout.
            </p>
          </Field>

          <Field label="Tirage" hint={<span className="num">graine {options.seed}</span>}>
            <Slider
              value={options.seed}
              min={1}
              max={99}
              step={1}
              onChange={(seed) => setOptions({ seed: Math.round(seed) })}
              aria-label="Graine du tirage"
            />
            <p className="mt-1.5 text-[10px] leading-relaxed text-white/28">
              L’ordre dans lequel les clips sont piochés. Même graine, même montage ; changez-la
              pour un autre agencement des mêmes plans.
            </p>
          </Field>
        </div>
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
            disabled={!music}
            onClick={() => void run()}
          >
            Analyser le rythme
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
  const stage = useAmv((state) => state.stage);
  const progress = useAmv((state) => state.progress);
  const detail = useAmv((state) => state.detail);
  const error = useAmv((state) => state.error);
  const cancel = useAmv((state) => state.cancel);
  const goTo = useAmv((state) => state.goTo);
  const run = useAmv((state) => state.run);

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
            <AudioLines size={22} strokeWidth={2} />
          )}
        </div>

        <h3 className="mt-4 text-[15px] font-medium text-white/90">{AMV_STAGE_LABELS[stage]}</h3>
        {detail && <p className="mt-1.5 text-2xs text-white/40">{detail}</p>}

        {running && (
          <div className="mt-6 w-full max-w-sm">
            <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.07]">
              <div
                className="h-full rounded-full bg-accent-500 transition-[width] duration-500 ease-smooth"
                style={{ width: `${Math.round(Math.max(0.02, progress) * 100)}%` }}
              />
            </div>
            <p className="mx-auto mt-4 max-w-[46ch] text-[11px] leading-relaxed text-white/30">
              Le morceau est décodé entièrement pour en mesurer les transitoires. Comptez quelques
              secondes par minute de musique.
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
