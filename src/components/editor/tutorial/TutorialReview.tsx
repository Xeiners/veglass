import { useRef, useState } from 'react';
import {
  Captions,
  Check,
  Crosshair,
  Keyboard,
  Loader2,
  MicVocal,
  Pause,
  Play,
  RefreshCw,
  Volume2,
  VolumeX,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatClock } from '@/lib/time';
import { Button } from '@/components/ui/Button';
import { Footer, Warning } from '@/components/ui/Wizard';
import { useEditor } from '@/store/editorStore';
import { plannedShots, useTutorial } from '@/store/tutorialStore';
import { canSpeak, useVoice } from '@/store/voiceStore';
import {
  ACTION_LABELS,
  ZOOM_CONFIDENCE_FLOOR,
  isPointed,
  zoomProfileOf,
  type TutorialStep,
} from '@/types/tutorial';

/**
 * The script, before it becomes a montage.
 *
 * This step exists because everything after it is expensive to undo by hand. A
 * wrong sentence is one edit here and forty seconds of re-recording later; a
 * step in the wrong place is a tick box here and a hunt through a timeline
 * later. So the whole answer is shown as text, editable, with the two things
 * that are hard to judge from a list — where the camera will look, and what the
 * voice actually says — available on the card itself.
 */
export function TutorialReview() {
  const steps = useTutorial((state) => state.steps);
  const options = useTutorial((state) => state.options);
  const placed = useTutorial((state) => state.placed);
  const failedTakes = useTutorial((state) => state.failedTakes);
  const stills = useTutorial((state) => state.stills);
  const importAll = useTutorial((state) => state.importAll);
  const close = useTutorial((state) => state.close);
  const goTo = useTutorial((state) => state.goTo);

  // Subscribing to the whole store here is deliberate: the shot count depends
  // on the steps, the options *and* the project's own frame, so there is no
  // narrower selector that would stay correct.
  const shots = useTutorial(plannedShots);

  const kept = steps.filter((step) => step.enabled);
  const spoken = kept.filter((step) => step.take !== null).length;
  const dressings =
    kept.filter((step) => step.banner !== null).length +
    kept.filter((step) => step.shortcut !== null).length;
  const profile = zoomProfileOf(options.zoom);

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mb-4 flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <p className="text-[13px] text-white/70">
            <span className="num font-medium text-white">{kept.length}</span> étape
            {kept.length > 1 ? 's' : ''} retenue{kept.length > 1 ? 's' : ''}
          </p>
          {profile.factor > 1 && (
            <p className="text-2xs text-white/40">
              <span className="num">{shots}</span> mouvement{shots > 1 ? 's' : ''} de caméra
            </p>
          )}
          {options.voiceover && (
            <p className="text-2xs text-white/40">
              <span className="num">{spoken}</span> phrase{spoken > 1 ? 's' : ''} enregistrée
              {spoken > 1 ? 's' : ''}
            </p>
          )}
          {options.banners && dressings > 0 && (
            <p className="text-2xs text-white/40">
              <span className="num">{dressings}</span> habillage{dressings > 1 ? 's' : ''}
            </p>
          )}
          {stills > 0 && (
            <p className="text-2xs text-white/25">
              <span className="num">{stills}</span> images lues
            </p>
          )}
        </div>

        <div className="space-y-2">
          {steps.map((step, index) => (
            <StepCard key={step.id} step={step} index={index} zoomFactor={profile.factor} />
          ))}
        </div>

        {failedTakes > 0 && (
          <Warning>
            {failedTakes} phrase{failedTakes > 1 ? 's' : ''} n’{failedTakes > 1 ? 'ont' : 'a'} pas
            pu être enregistrée{failedTakes > 1 ? 's' : ''}. Ces étapes seront montées sans voix —
            vous pouvez les réenregistrer une par une avec le bouton de chaque carte.
          </Warning>
        )}

        {kept.length === 0 && (
          <Warning>Toutes les étapes sont décochées : il n’y a rien à monter.</Warning>
        )}
      </div>

      <Footer
        left={
          <Button variant="ghost" onClick={() => goTo('settings')}>
            Retour aux réglages
          </Button>
        }
        right={
          placed ? (
            <Button variant="secondary" icon={<Check size={13} strokeWidth={2.4} />} onClick={close}>
              Fermer
            </Button>
          ) : (
            <Button variant="primary" disabled={kept.length === 0} onClick={importAll}>
              Monter le tutoriel
            </Button>
          )
        }
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * One step
 * ------------------------------------------------------------------ */

function StepCard({
  step,
  index,
  zoomFactor,
}: {
  step: TutorialStep;
  index: number;
  zoomFactor: number;
}) {
  const toggle = useTutorial((state) => state.toggleStep);
  const edit = useTutorial((state) => state.editStep);
  const revoice = useTutorial((state) => state.revoice);
  const voice = useVoice((state) => state);
  const notify = useEditor((state) => state.notify);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(step.say);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const player = useRef<HTMLAudioElement | null>(null);

  const moves = zoomFactor > 1 && step.point !== null && step.confidence >= ZOOM_CONFIDENCE_FLOOR;
  const vague = step.point !== null && step.confidence < ZOOM_CONFIDENCE_FLOOR;

  /**
   * Plays the take from disk.
   *
   * The file lives under the app data directory, which a webview cannot open
   * by path — it goes through the asset protocol, the same route every imported
   * media takes. Resolved here rather than held in state so nothing has to keep
   * a URL alive for a card that may never be played.
   */
  const hear = () => {
    const take = step.take;
    if (!take) return;

    if (playing) {
      player.current?.pause();
      setPlaying(false);
      return;
    }

    void (async () => {
      try {
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        const audio = new Audio(convertFileSrc(take.path));
        player.current = audio;
        audio.addEventListener('ended', () => setPlaying(false));
        await audio.play();
        setPlaying(true);
      } catch {
        notify('Lecture de la voix off impossible', 'error');
      }
    })();
  };

  const commit = () => {
    setEditing(false);
    if (draft.trim() !== step.say.trim()) edit(step.id, { say: draft.trim() });
  };

  return (
    <div
      className={cn(
        'rounded-xl border px-3.5 py-3 transition-all duration-200',
        step.enabled
          ? 'border-white/[0.08] bg-white/[0.025]'
          : 'border-white/[0.05] bg-white/[0.01] opacity-50',
      )}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={step.enabled}
          onChange={() => toggle(step.id)}
          aria-label={`Garder l’étape ${index + 1}`}
          className="mt-1 h-4 w-4 shrink-0 accent-accent-500"
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="num text-2xs text-white/30">{formatClock(step.at)}</span>
            <span className="text-[13px] font-medium text-white/90">{step.title}</span>
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-white/45">
              {ACTION_LABELS[step.action]}
            </span>
            {moves && (
              <span className="inline-flex items-center gap-1 text-[10px] text-accent-300/80">
                <Crosshair size={9} strokeWidth={2.4} />
                zoom
              </span>
            )}
            {vague && (
              <span
                className="text-[10px] text-white/30"
                title="Le modèle n’est pas sûr de la position à l’écran : la caméra ne bougera pas pour cette étape."
              >
                position incertaine
              </span>
            )}
            {!isPointed(step.action) && (
              <span className="text-[10px] text-white/25">plan large</span>
            )}
            {step.banner && (
              <span
                className="inline-flex items-center gap-1 rounded bg-emerald-400/[0.14] px-1.5 py-0.5 text-[10px] text-emerald-200"
                title={`Bande titre : ${step.banner.title}${
                  step.banner.subtitle ? ` — ${step.banner.subtitle}` : ''
                }`}
              >
                <Captions size={9} strokeWidth={2.4} />
                {step.banner.title}
              </span>
            )}
            {step.shortcut && (
              <span
                className="inline-flex items-center gap-1 rounded bg-white/[0.08] px-1.5 py-0.5 text-[10px] text-white/70"
                title="Incrusté en touches de clavier"
              >
                <Keyboard size={9} strokeWidth={2.4} />
                {step.shortcut}
              </span>
            )}
          </div>

          {editing ? (
            <textarea
              value={draft}
              autoFocus
              rows={3}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setDraft(step.say);
                  setEditing(false);
                }
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) commit();
              }}
              className="mt-2 w-full resize-none rounded-lg border border-accent-500/40 bg-ink-900/80 px-3 py-2 text-[13px] leading-relaxed text-white outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraft(step.say);
                setEditing(true);
              }}
              className="mt-1.5 block w-full text-left text-[13px] leading-relaxed text-white/55 transition-colors hover:text-white/80"
            >
              {step.say || <span className="italic text-white/25">Aucun commentaire</span>}
            </button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {step.take ? (
            <>
              <span className="num mr-1 text-[10px] text-white/25">
                {step.take.duration.toFixed(1)} s
              </span>
              <button
                type="button"
                onClick={hear}
                aria-label={playing ? 'Arrêter' : 'Écouter cette phrase'}
                className="grid h-7 w-7 place-items-center rounded-md text-white/35 transition-colors hover:bg-white/[0.07] hover:text-white/80"
              >
                {playing ? <Pause size={12} strokeWidth={2.4} /> : <Play size={12} strokeWidth={2.4} />}
              </button>
            </>
          ) : (
            <span
              className="grid h-7 w-7 place-items-center text-white/20"
              title="Aucune voix off pour cette étape"
            >
              {step.say ? <VolumeX size={12} strokeWidth={2} /> : <Volume2 size={12} strokeWidth={2} />}
            </span>
          )}

          {canSpeak(voice) && step.say.trim().length > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void revoice(step.id).finally(() => setBusy(false));
              }}
              aria-label="Réenregistrer cette phrase"
              title={step.take ? 'Réenregistrer cette phrase' : 'Enregistrer cette phrase'}
              className="grid h-7 w-7 place-items-center rounded-md text-white/35 transition-colors hover:bg-white/[0.07] hover:text-white/80 disabled:opacity-40"
            >
              {busy ? (
                <Loader2 size={12} strokeWidth={2.4} className="animate-spin" />
              ) : step.take ? (
                <RefreshCw size={12} strokeWidth={2.4} />
              ) : (
                <MicVocal size={12} strokeWidth={2.4} />
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
