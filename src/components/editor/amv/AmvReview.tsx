import { useMemo } from 'react';
import { Layers2, Music, Sparkles, Waves, Zap } from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatClock } from '@/lib/time';
import { Button } from '@/components/ui/Button';
import { Footer, Warning } from '@/components/ui/Wizard';
import { Field } from '@/components/ui/Field';
import { Slider } from '@/components/ui/Slider';
import { plannedSpan, useAmv } from '@/store/amvStore';
import { PHASES, amvProfile, defaultRecipe, phaseSpec, type PhaseId } from '@/types/amv';
import { planShots } from '@/lib/amv/build';
import { phaseAt, type Structure } from '@/lib/amv/structure';
import type { Beat } from '@/lib/amv/beats';

/**
 * A colour per movement, cool to hot.
 *
 * The point of the strip is that the arc is *seen* before anything is written,
 * so the three read as a progression rather than as three arbitrary regions.
 */
const PHASE_TINT: Record<PhaseId, string> = {
  intro: '#38bdf8',
  build: '#a78bfa',
  drop: '#fb7185',
};

/**
 * What the analysis found, and the button that acts on it.
 *
 * The montage is committed from here while the copilot is switched off — see
 * `DIRECTOR_ENABLED`. It commits `defaultRecipe`, the profile's own movements,
 * which is exactly what this screen did before there was a copilot to hand over
 * to. Turning the copilot back on means turning this button back into a handoff:
 * two roads to the timeline is one more than the atomic commit can defend.
 *
 * The sensitivity dial belongs to the analysis rather than to the montage: it is
 * the one answer whose effect is invisible until you can see the beats it
 * produced. Dragging it re-picks them from the curve already in memory — no
 * decode, no wait — so the strip, the tempo and the shot count all move under
 * the thumb.
 */
export function AmvReview() {
  const beats = useAmv((state) => state.beats);
  const tempo = useAmv((state) => state.tempo);
  const options = useAmv((state) => state.options);
  const sources = useAmv((state) => state.sources);
  const setOptions = useAmv((state) => state.setOptions);
  const goTo = useAmv((state) => state.goTo);
  const importAll = useAmv((state) => state.importAll);
  const placed = useAmv((state) => state.placed);

  const span = useAmv(plannedSpan);
  const structure = useAmv((state) => state.structure);
  const profile = amvProfile(options.profile);

  /*
   * The plan, worked out once here rather than through a store selector.
   *
   * It has to be a `useMemo` and not a selector, and the reason is the bug this
   * replaces: zustand compares what a selector returns by identity, so one that
   * builds a fresh object every call reads to `useSyncExternalStore` as "the
   * store changed again" on every pass — an infinite render loop that takes the
   * whole tree down with it. `types/marker` documents the same trap for the
   * same reason. Anything derived and *composite* belongs in a memo; only a
   * primitive or a value the store itself holds is safe to select.
   *
   * Running `planShots` once also fixes the other half of what was here: the
   * count and the per-movement tally were two selectors, so the plan was built
   * twice on every store update.
   */
  const plan = useMemo(
    () => (structure ? planShots(beats, profile, span, structure) : []),
    [beats, profile, span, structure],
  );
  const shots = plan.length;

  const byPhase = useMemo(() => {
    const out: Record<PhaseId, number> = { intro: 0, build: 0, drop: 0 };
    for (const shot of plan) out[shot.phase] += 1;
    return out;
  }, [plan]);

  /*
   * Counted the way the builder counts, movement by movement.
   *
   * These are upper bounds — the spacing rules thin them further, and stating
   * that is more honest than a number that only holds when the beats happen to
   * be far apart. What matters here is that a phase that cannot fire an effect
   * contributes nothing to its tally, which is the change this screen exists to
   * show.
   */
  const counts = useMemo(() => {
    if (!structure) return { splits: 0, flashes: 0 };
    let splits = 0;
    let flashes = 0;

    for (const beat of beats) {
      if (beat.at >= span) continue;
      const phase = phaseSpec(phaseAt(structure, beat.at));

      if (options.split && profile.split && phase.shock) {
        if (beat.strength >= profile.split.threshold) splits += 1;
      }
      if (options.flashes && profile.flash && phase.flash > 0) {
        if (beat.strength >= 1 - (1 - profile.flash.threshold) * phase.flash) flashes += 1;
      }
    }
    return { splits, flashes };
  }, [beats, options.flashes, options.split, profile, span, structure]);

  const splits = counts.splits;
  const flashes = counts.flashes;

  return (
    <>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
        <div className="grid gap-2 sm:grid-cols-4">
          <Stat label="Temps détectés" value={String(beats.length)} />
          <Stat label="Tempo" value={tempo ? `${tempo} BPM` : '—'} />
          <Stat label="Plans" value={String(shots)} />
          <Stat label="Durée" value={formatClock(span)} />
        </div>

        <Field
          label="Structure du montage"
          hint={<span className="num">{profile.label}</span>}
        >
          <BeatStrip beats={beats} span={span} structure={structure} />
          {structure && (
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {PHASES.filter((phase) =>
                structure.phases.some((item) => item.id === phase.id),
              ).map((phase) => (
                <div
                  key={phase.id}
                  className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2"
                >
                  <p className="flex items-center gap-1.5 text-[11px] font-medium text-white/80">
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: PHASE_TINT[phase.id] }}
                      aria-hidden
                    />
                    {phase.label}
                    <span className="num ml-auto text-2xs text-white/35">
                      {byPhase[phase.id]} plans
                    </span>
                  </p>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-white/32">{phase.hint}</p>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-[10px] leading-relaxed text-white/28">
            Chaque trait est un temps détecté ; sa hauteur est sa force. Le montage se resserre d’un
            mouvement au suivant, et les effets de choc sont réservés au dernier.{' '}
            {structure?.source === 'proportional' && (
              <span className="text-amber-200/70">
                Ce morceau ne marque pas de rupture nette : les trois temps ont été placés aux
                proportions habituelles plutôt que mesurés.
              </span>
            )}
          </p>
        </Field>

        <Field
          label="Sensibilité"
          hint={<span className="num">{Math.round(options.sensitivity * 100)} %</span>}
        >
          <Slider
            value={options.sensitivity}
            min={0}
            max={1}
            step={0.01}
            onChange={(sensitivity) => setOptions({ sensitivity })}
            aria-label="Sensibilité de la détection"
          />
          <p className="mt-1.5 text-[10px] leading-relaxed text-white/28">
            Réglez jusqu’à ce que le nombre de temps ressemble à ce que vous entendez. La détection
            est refaite à chaque mouvement, sans réanalyser le morceau.
          </p>
        </Field>

        <div className="grid gap-2 sm:grid-cols-3">
          <Summary
            icon={<Zap size={13} strokeWidth={2} />}
            title={options.punch ? `${shots} zooms` : 'Zooms désactivés'}
            hint={`Échelle ${Math.round(profile.punch.amount * 100)} % au pic`}
            active={options.punch}
          />
          <Summary
            icon={<Layers2 size={13} strokeWidth={2} />}
            title={
              options.split && profile.split ? `${splits} aberrations` : 'Aberration désactivée'
            }
            hint={
              profile.split
                ? `${profile.split.amount} px, au drop seulement, une toutes les ${profile.split.spacing} s au plus`
                : 'Ce profil ne décale pas les canaux'
            }
            active={options.split && profile.split !== null}
          />
          <Summary
            icon={<Waves size={13} strokeWidth={2} />}
            title={
              options.smear && profile.smear
                ? `${shots - byPhase.intro} flous de coupe`
                : 'Flou désactivé'
            }
            hint={
              profile.smear
                ? `Traînée de ${profile.smear.amount} px, effacée en ${Math.round(
                    profile.smear.decay * 1000,
                  )} ms`
                : 'Ce profil coupe net'
            }
            active={options.smear && profile.smear !== null}
          />
          <Summary
            icon={<Sparkles size={13} strokeWidth={2} />}
            title={options.flashes && profile.flash ? `${flashes} flashs` : 'Flashs désactivés'}
            hint={
              profile.flash?.invertThreshold != null
                ? `Aplat de couleur ; négatif au drop, une fois toutes les ${profile.flash.invertSpacing} s au plus`
                : 'Aplat de couleur sur les impacts'
            }
            active={options.flashes && profile.flash !== null}
          />
          <Summary
            icon={<Music size={13} strokeWidth={2} />}
            title={`${sources.length} clips`}
            hint="Seuls ceux réellement montés rejoignent les médias"
            active
          />
        </div>

        {beats.length > 0 && shots === 0 && (
          <Warning>
            Aucun plan ne tient dans ces réglages : les temps détectés sont plus rapprochés que la
            durée minimale du profil. Baissez la sensibilité, ou passez sur un profil plus rapide.
          </Warning>
        )}

        {tempo === null && beats.length > 0 && (
          <Warning tone="soft">
            Le tempo n’a pas pu être déduit — les temps sont irréguliers. Le montage suivra quand
            même ce qui a été détecté ; c’est le cas normal sur un morceau à mesures changeantes.
          </Warning>
        )}
      </div>

      <Footer
        left={
          <Button variant="ghost" onClick={() => goTo('settings')}>
            Retour aux réglages
          </Button>
        }
        right={
          <Button
            variant="primary"
            icon={<Sparkles size={14} strokeWidth={2} />}
            disabled={shots === 0}
            onClick={() => importAll(defaultRecipe(options.profile))}
          >
            {placed ? 'Monter à nouveau' : 'Monter'}
          </Button>
        }
      />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.022] px-3.5 py-3">
      <p className="eyebrow">{label}</p>
      <p className="num mt-1 text-[17px] font-medium text-white/90">{value}</p>
    </div>
  );
}

function Summary({
  icon,
  title,
  hint,
  active,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  active: boolean;
}) {
  return (
    <div
      className={cn(
        'flex gap-2.5 rounded-xl border px-3.5 py-3',
        active
          ? 'border-accent-500/25 bg-accent-500/[0.05]'
          : 'border-white/[0.07] bg-white/[0.022] opacity-50',
      )}
    >
      <span
        className={cn(
          'mt-0.5 shrink-0',
          active ? 'text-accent-300' : 'text-white/35',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium text-white/85">{title}</span>
        <span className="mt-0.5 block text-2xs leading-relaxed text-white/35">{hint}</span>
      </span>
    </div>
  );
}

/**
 * The beats, drawn where they fall.
 *
 * One SVG line each rather than one element each: several hundred positioned
 * divs is a layout pass the sensitivity slider would pay for on every frame of
 * a drag, and this has to stay free enough to feel live.
 *
 * `preserveAspectRatio="none"` lets the viewBox be the track's own seconds, so
 * every line is placed in the units it is measured in and the strip stretches
 * to whatever width the panel has.
 */
function BeatStrip({
  beats,
  span,
  structure,
}: {
  beats: Beat[];
  span: number;
  structure: Structure | null;
}) {
  if (span <= 0 || beats.length === 0) {
    return (
      <div className="grid h-16 place-items-center rounded-xl border border-white/[0.07] bg-white/[0.022] text-2xs text-white/30">
        Aucun temps détecté
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-ink-900/60">
      <svg
        viewBox={`0 0 ${span} 1`}
        preserveAspectRatio="none"
        className="block h-16 w-full"
        role="img"
        aria-label={`${beats.length} temps détectés sur ${Math.round(span)} secondes`}
      >
        {/* The movements, behind the beats: the arc is the thing to read first. */}
        {structure?.phases.map((phase) => (
          <rect
            key={`${phase.id}-${phase.from}`}
            x={phase.from}
            y={0}
            width={Math.max(0, phase.to - phase.from)}
            height={1}
            fill={PHASE_TINT[phase.id]}
            opacity={0.1}
          />
        ))}
        {structure?.phases.slice(1).map((phase) => (
          <line
            key={`edge-${phase.from}`}
            x1={phase.from}
            x2={phase.from}
            y1={0}
            y2={1}
            stroke="#ffffff"
            strokeOpacity={0.25}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {beats
          .filter((beat) => beat.at < span)
          .map((beat, index) => (
            <line
              key={index}
              x1={beat.at}
              x2={beat.at}
              y1={1}
              // A floor under the shortest line: a weak beat is still a beat,
              // and one drawn a pixel tall reads as nothing at all.
              y2={1 - Math.max(0.12, beat.strength)}
              stroke={
                beat.band === 'kick' ? '#a78bfa' : beat.band === 'snare' ? '#38bdf8' : '#64748b'
              }
              strokeWidth={span / 900}
              vectorEffect="non-scaling-stroke"
            />
          ))}
      </svg>
    </div>
  );
}
