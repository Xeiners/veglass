import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  Clapperboard,
  Film,
  KeyRound,
  Link2,
  Music,
  Sparkles,
  TriangleAlert,
  X,
  Zap,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatClock } from '@/lib/time';
import { Button } from '@/components/ui/Button';
import { useAi } from '@/store/aiStore';
import { useAmv } from '@/store/amvStore';
import { useDirector } from '@/store/directorStore';
import {
  DIRECTOR_STAGE_LABELS,
  isWorking,
  referenceUrl,
  type DirectorTurn,
  type Strategy,
} from '@/types/director';

/**
 * The editing copilot.
 *
 * A conversation with one job: agree on how the montage should be cut, then cut
 * it. The panel writes nothing to the document itself — the button at the foot
 * hands the agreed strategy to the montage engine, which commits it in the same
 * single transaction the wizard uses.
 *
 * The link field is the feature's front door and is deliberately the first
 * thing in it: pointing at an edit you like says more in one paste than a
 * paragraph of adjectives, and everything below fills itself in from what that
 * reference turns out to do.
 */
export function DirectorPanel() {
  const turns = useDirector((state) => state.turns);
  const stage = useDirector((state) => state.stage);
  const error = useDirector((state) => state.error);
  const reference = useDirector((state) => state.reference);
  const profile = useDirector((state) => state.profile);
  const placed = useDirector((state) => state.placed);
  const ingest = useDirector((state) => state.ingest);
  const send = useDirector((state) => state.send);
  const tune = useDirector((state) => state.tune);
  const commit = useDirector((state) => state.commit);
  const clearReference = useDirector((state) => state.clearReference);
  const reset = useDirector((state) => state.reset);

  const brief = useDirector((state) => state.brief);

  const music = useAmv((state) => state.music);
  const sources = useAmv((state) => state.sources);
  const beats = useAmv((state) => state.beats);
  const structure = useAmv((state) => state.structure);
  const openWizard = useAmv((state) => state.openWizard);
  const configured = useAi((state) => state.keyStatus.configured);
  const openAiSettings = useAi((state) => state.openSettings);

  const [draft, setDraft] = useState('');
  const [link, setLink] = useState('');
  const scroller = useRef<HTMLDivElement | null>(null);

  const busy = isWorking(stage);
  const ready = music !== null && beats.length > 0 && structure !== null && sources.length > 0;

  // Composite, so it is built here rather than selected from the store — see
  // the note `amvStore` carries about what a zustand selector may return.
  const missing = useMemo(() => {
    const gaps: string[] = [];
    if (!music) gaps.push('une musique');
    if (sources.length === 0) gaps.push('des clips');
    if (music && beats.length === 0) gaps.push('l’analyse du rythme');
    return gaps;
  }, [beats.length, music, sources.length]);

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns.length, stage]);

  /*
   * The copilot opens the conversation itself.
   *
   * This is the wire that was missing, and its absence was the whole of "rien ne
   * se passe": everything downstream worked, and nothing ever asked the model to
   * speak. It fires from the panel rather than from a store subscription so the
   * request is made when someone is actually looking — a copilot that briefed
   * an empty room would be paying for turns nobody reads.
   *
   * `brief` guards itself against firing twice; the dependency list is only
   * what decides whether there is anything worth briefing on.
   */
  useEffect(() => {
    if (ready) void brief();
  }, [brief, ready]);

  const submitLink = () => {
    const url = referenceUrl(link);
    if (!url) return;
    setLink('');
    void ingest(url);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ---------------------------------------------------------- link */}
      <div className="shrink-0 space-y-2 border-b border-white/[0.06] px-3 pb-3 pt-3">
        {reference ? (
          <div className="flex items-center gap-2.5 rounded-xl border border-accent-500/30 bg-accent-500/[0.06] px-3 py-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-500/[0.14] text-accent-300">
              <Clapperboard size={14} strokeWidth={2} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium text-white/85">
                {reference.title}
              </span>
              {profile && (
                <span className="num mt-0.5 block truncate text-2xs text-white/40">
                  {profile.cuts} coupes · {formatClock(profile.duration)} ·{' '}
                  {profile.shot.drop.toFixed(2).replace('.', ',')} s au drop
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={clearReference}
              aria-label="Retirer la référence"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/80"
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>
        ) : (
          <div
            onDrop={(event) => {
              event.preventDefault();
              const dropped = referenceUrl(event.dataTransfer.getData('text/plain'));
              if (dropped) void ingest(dropped);
            }}
            onDragOver={(event) => event.preventDefault()}
            className="rounded-xl border border-dashed border-white/[0.1] bg-white/[0.015] p-2.5"
          >
            <div className="flex items-center gap-2">
              <Link2 size={13} strokeWidth={2} className="shrink-0 text-white/30" />
              <input
                value={link}
                onChange={(event) => setLink(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submitLink();
                }}
                placeholder="Colle un lien d’inspiration — YouTube, Shorts, TikTok…"
                disabled={busy}
                className={cn(
                  'min-w-0 flex-1 bg-transparent text-2xs text-white/85 placeholder:text-white/25',
                  'focus:outline-none disabled:opacity-50',
                )}
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || referenceUrl(link) === null}
                onClick={submitLink}
              >
                Analyser
              </Button>
            </div>
            <p className="mt-1.5 pl-[21px] text-[10px] leading-relaxed text-white/28">
              La vidéo est téléchargée puis mesurée — ses coupes et sa structure. Rien n’est
              deviné.
            </p>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------ the talk */}
      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {turns.length === 0 && <Opening onOpenWizard={() => openWizard()} />}
        {turns.map((turn, index) => (
          <Turn
            key={turn.id}
            turn={turn}
            /*
             * Only the newest proposal is actionable.
             *
             * A card on every past turn would offer to commit a strategy that
             * has since been argued out of, and the two buttons would disagree
             * with the panel's own footer about what "valider" means.
             */
            live={index === turns.length - 1 && turn.strategy !== undefined && !busy}
            ready={ready}
            onCommit={commit}
            onTune={(patch, label) => void tune(patch, label)}
          />
        ))}

        {busy && <Typing label={DIRECTOR_STAGE_LABELS[stage]} />}

        {!configured && (
          <button
            type="button"
            onClick={() => openAiSettings(true)}
            className="flex w-full items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2.5 text-left text-2xs leading-relaxed text-amber-100/85 transition-colors hover:bg-amber-500/[0.12]"
          >
            <KeyRound size={12} strokeWidth={2} className="shrink-0" />
            <span>
              Aucune clé Gemini enregistrée — le chef monteur ne peut pas répondre. Ouvrir les
              réglages IA.
            </span>
          </button>
        )}

        {error && (
          <p className="flex gap-1.5 rounded-xl border border-red-500/25 bg-red-500/[0.06] px-3 py-2.5 text-2xs leading-relaxed text-red-200/80">
            <TriangleAlert size={12} strokeWidth={2.2} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}
      </div>

      {/* ------------------------------------------------------ controls */}
      <div className="shrink-0 space-y-2.5 border-t border-white/[0.06] px-3 py-3">
        {missing.length > 0 && (
          <button
            type="button"
            onClick={() => openWizard()}
            className="flex w-full items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5 text-left text-2xs leading-relaxed text-amber-100/80 transition-colors hover:bg-amber-500/[0.1]"
          >
            {music ? <Film size={12} strokeWidth={2} /> : <Music size={12} strokeWidth={2} />}
            <span>Il me manque {missing.join(', ')} — ouvrir le montage rythmé</span>
          </button>
        )}

        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                const text = draft;
                setDraft('');
                void send(text);
              }
            }}
            rows={2}
            placeholder={
              configured
                ? 'Garde l’intro plus calme, coupe plus sec au drop…'
                : 'Sans clé d’API : utilise les réglages rapides ci-dessus'
            }
            className={cn(
              'min-h-[52px] flex-1 resize-none rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2',
              'text-2xs leading-relaxed text-white/85 placeholder:text-white/25',
              'transition-colors focus:border-accent-500/40 focus:bg-white/[0.04] focus:outline-none',
            )}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || draft.trim() === ''}
            icon={<ArrowUp size={13} strokeWidth={2.2} />}
            onClick={() => {
              const text = draft;
              setDraft('');
              void send(text);
            }}
          >
            {''}
          </Button>
        </div>

        {/*
          * No commit button down here.
          *
          * The only way to the timeline is the card on a message Gemini sent —
          * a permanent button in the footer would commit "the current strategy",
          * which is a thing the user never explicitly agreed to. `placed` is
          * reported rather than acted on.
          */}
        <div className="flex items-center gap-2">
          <p className="flex-1 text-[10px] leading-relaxed text-white/28">
            {placed
              ? 'Montage posé sur la timeline — un seul Ctrl+Z pour tout reprendre.'
              : 'Le montage s’écrit en validant une proposition dans la discussion.'}
          </p>
          {turns.length > 0 && (
            <Button variant="ghost" size="sm" onClick={reset}>
              Effacer
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The wait, made visible.
 *
 * Three dots rather than a spinner and a label alone, because the wait here is
 * a *round trip to a model* and that is what a reader needs to recognise. It
 * also names the stage: fetching a reference and waiting on Gemini take
 * comparable amounts of time and fail for entirely different reasons.
 */
function Typing({ label }: { label: string }) {
  return (
    <div className="flex max-w-[92%] items-center gap-2 rounded-xl rounded-bl-sm bg-white/[0.04] px-3 py-2.5">
      <span className="flex items-center gap-1" aria-hidden>
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/45"
            style={{ animationDelay: `${index * 160}ms`, animationDuration: '1s' }}
          />
        ))}
      </span>
      <span className="text-2xs text-white/40">{label}…</span>
    </div>
  );
}

function Opening({ onOpenWizard }: { onOpenWizard(): void }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.022] px-4 py-6 text-center">
      <div className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-accent-500/[0.12] text-accent-300">
        <Sparkles size={17} strokeWidth={2} />
      </div>
      <p className="mt-3 text-[13px] text-white/75">Montre-moi un montage que tu aimes</p>
      <p className="mx-auto mt-1.5 max-w-[38ch] text-2xs leading-relaxed text-white/35">
        Je mesure son rythme de coupe et sa structure, je l’applique à ta musique et à tes clips,
        et on en discute avant que quoi que ce soit ne touche la timeline.
      </p>
      <button
        type="button"
        onClick={onOpenWizard}
        className="mt-3 text-2xs text-accent-300 underline underline-offset-2 hover:text-accent-200"
      >
        Choisir la musique et les clips
      </button>
    </div>
  );
}

function Turn({
  turn,
  live = false,
  ready = false,
  onCommit,
  onTune,
}: {
  turn: DirectorTurn;
  live?: boolean;
  ready?: boolean;
  onCommit?(strategy: Strategy): void;
  onTune?(patch: Partial<Strategy>, label: string): void;
}) {
  if (turn.role === 'user') {
    return (
      <div className="ml-auto max-w-[88%] space-y-1.5">
        <div className="rounded-xl rounded-br-sm bg-accent-500/[0.14] px-3 py-2">
          <p className="whitespace-pre-wrap break-words text-2xs leading-relaxed text-white/85">
            {turn.text}
          </p>
        </div>
        {/* An adjustment made from the card is the user's turn, and it carries
            the proposal it produced — so the numbers on screen are always the
            ones the commit button would use. */}
        {turn.strategy && (
          <StrategyCard
            strategy={turn.strategy}
            live={live}
            ready={ready}
            /*
             * No commit on a turn the user caused.
             *
             * An adjustment shows its numbers so the change is visible, but the
             * montage is only ever written from something Gemini answered — so
             * the button is passed on down only where a model turn carries it.
             */
            onTune={onTune}
          />
        )}
      </div>
    );
  }

  return (
    <div className="max-w-[92%] space-y-1.5">
      <p
        className={cn(
          'whitespace-pre-wrap break-words rounded-xl rounded-bl-sm px-3 py-2 text-2xs leading-relaxed',
          turn.error
            ? 'border border-red-500/25 bg-red-500/[0.06] text-red-200/80'
            : 'bg-white/[0.04] text-white/75',
        )}
      >
        {turn.text}
      </p>
      {turn.error && <p className="pl-3 text-[10px] text-red-200/60">{turn.error}</p>}
      {/* Which model answered, and what it cost. Present on exactly the turns
          that came back over the wire — a turn with no line here did not. */}
      {turn.model && (
        <p className="num pl-3 text-[10px] text-white/25">
          {turn.model}
          {turn.tokens ? ` · ${turn.tokens.toLocaleString('fr-FR')} jetons` : ''}
        </p>
      )}
      {turn.strategy && (
        <StrategyCard
          strategy={turn.strategy}
          live={live}
          ready={ready}
          onCommit={onCommit}
          onTune={onTune}
        />
      )}
    </div>
  );
}

/**
 * A proposal, as something to act on rather than something to read.
 *
 * The three numbers are the whole strategy — everything else the copilot
 * decides is a switch — so showing them beside the buttons means "valider"
 * never means agreeing to something that was only described in prose two
 * messages ago.
 *
 * The adjustment buttons go through `tune`, which is the same normaliser the
 * model's answers pass through. So a button and a sentence cannot leave the
 * strategy in two different states, and the buttons keep working with no key.
 */
function StrategyCard({
  strategy,
  live,
  ready,
  onCommit,
  onTune,
}: {
  strategy: Strategy;
  live: boolean;
  ready: boolean;
  /** Absent on a card that has nothing Gemini said behind it. */
  onCommit?(strategy: Strategy): void;
  onTune?(patch: Partial<Strategy>, label: string): void;
}) {
  const shot = (value: number) => value.toFixed(2).replace('.', ',');
  const scale = (factor: number): Partial<Strategy> => ({
    shot: {
      intro: strategy.shot.intro * factor,
      build: strategy.shot.build * factor,
      drop: strategy.shot.drop * factor,
    },
  });

  return (
    <div
      className={cn(
        'rounded-xl border px-3 py-2.5',
        live ? 'border-accent-500/30 bg-accent-500/[0.05]' : 'border-white/[0.06] bg-white/[0.015]',
      )}
    >
      <div className="grid grid-cols-3 gap-2">
        {(['intro', 'build', 'drop'] as const).map((id) => (
          <div key={id}>
            <p className="eyebrow text-[9px]">
              {id === 'intro' ? 'Intro' : id === 'build' ? 'Montée' : 'Drop'}
            </p>
            <p className="num mt-0.5 text-[13px] font-medium text-white/85">
              {shot(strategy.shot[id])} s
            </p>
          </div>
        ))}
      </div>

      {live && (
        <>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Chip
              label="Intro plus calme"
              onClick={() =>
                onTune?.(
                  { shot: { ...strategy.shot, intro: strategy.shot.intro * 1.5 } },
                  'Intro plus calme',
                )
              }
            />
            <Chip
              label="Drop plus sec"
              onClick={() =>
                onTune?.(
                  { shot: { ...strategy.shot, drop: strategy.shot.drop * 0.7 } },
                  'Drop plus sec',
                )
              }
            />
            <Chip label="Tout accélérer" onClick={() => onTune?.(scale(0.75), 'Tout accélérer')} />
            <Chip
              label={strategy.split ? 'Sans aberration' : 'Avec aberration'}
              active={strategy.split}
              onClick={() =>
                onTune?.(
                  { split: !strategy.split },
                  strategy.split ? 'Retire l’aberration chromatique' : 'Ajoute l’aberration chromatique',
                )
              }
            />
          </div>
          {onCommit && (
            <Button
              variant="primary"
              size="sm"
              block
              className="mt-2.5"
              disabled={!ready}
              icon={<Check size={13} strokeWidth={2.4} />}
              onClick={() => onCommit(strategy)}
            >
              Valider cette stratégie
            </Button>
          )}
          {onCommit && !ready && (
            <p className="mt-1.5 flex items-center gap-1.5 text-[10px] text-white/32">
              <Zap size={10} strokeWidth={2} />
              Il me manque encore la musique, les clips ou l’analyse.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-lg border px-2.5 py-1 text-[11px] transition-colors',
        active
          ? 'border-accent-500/35 bg-accent-500/[0.08] text-accent-200'
          : 'border-white/[0.08] bg-white/[0.02] text-white/55 hover:border-white/[0.16] hover:text-white/80',
      )}
    >
      {label}
    </button>
  );
}
