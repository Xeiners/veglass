import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Captions,
  CircleSlash,
  Eraser,
  KeyRound,
  ListChecks,
  Loader2,
  MousePointerClick,
  Scissors,
  Settings2,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { useAi, type AiJob } from '@/store/aiStore';
import { useEditor } from '@/store/editorStore';
import { describeAction } from '@/lib/ai/plan';
import type { AiPlan, ChatMessage } from '@/types/ai';

/** Openers that show what the assistant is for without having to be told. */
const STARTERS: { icon: typeof Sparkles; label: string; prompt: string }[] = [
  {
    icon: ListChecks,
    label: 'Chapitrer',
    prompt:
      'Propose un chapitrage de ce montage à partir de ce qui est sur la timeline, et pose un calque de texte au début de chaque chapitre sur une piste « Chapitres ».',
  },
  {
    icon: Captions,
    label: 'Titres depuis un script',
    prompt:
      'Voici mon script. Découpe-le en titres et pose-les sur la timeline, un par idée, calés sur les plans existants :\n\n',
  },
  {
    icon: Sparkles,
    label: 'Animer le titre',
    prompt:
      'Anime le calque de texte sélectionné : une entrée nette et une sortie discrète, sans rebond.',
  },
];

export function AssistantPanel() {
  const messages = useAi((state) => state.messages);
  const job = useAi((state) => state.job);
  const status = useAi((state) => state.keyStatus);
  const model = useAi((state) => state.settings.model);
  const ask = useAi((state) => state.ask);
  const cancel = useAi((state) => state.cancel);
  const clearChat = useAi((state) => state.clearChat);
  const openSettings = useAi((state) => state.openSettings);
  const openSubtitles = useAi((state) => state.openSubtitles);
  const openSmartCut = useAi((state) => state.openSmartCut);

  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement | null>(null);
  const composer = useRef<HTMLTextAreaElement | null>(null);

  // Follow the conversation as it grows, including while a job reports progress.
  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, job]);

  const send = (text: string) => {
    if (!text.trim() || job) return;
    setDraft('');
    void ask(text);
  };

  const start = (prompt: string) => {
    if (prompt.endsWith('\n\n')) {
      // A prompt that expects material is loaded into the field rather than
      // sent: the user still has to paste their script into it.
      setDraft(prompt);
      composer.current?.focus();
      return;
    }
    send(prompt);
  };

  return (
    <aside className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 px-4 pb-2.5 pt-4">
        <Sparkles size={13} strokeWidth={2} className="text-accent-300/70" />
        <h2 className="eyebrow">Assistant</h2>
        <span className="num ml-1 truncate rounded-md border border-white/[0.07] bg-white/[0.025] px-1.5 py-0.5 text-[10px] text-white/35">
          {model}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={clearChat}
              title="Effacer la conversation"
              aria-label="Effacer la conversation"
              className="grid h-7 w-7 place-items-center rounded-lg text-white/30 transition-colors hover:bg-white/[0.07] hover:text-white/75"
            >
              <Eraser size={13} strokeWidth={2} />
            </button>
          )}
          <button
            type="button"
            onClick={() => openSettings(true)}
            title="Réglages de l’assistant"
            aria-label="Réglages de l’assistant"
            className="grid h-7 w-7 place-items-center rounded-lg text-white/30 transition-colors hover:bg-white/[0.07] hover:text-white/75"
          >
            <Settings2 size={13} strokeWidth={2} />
          </button>
        </div>
      </header>

      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-3">
        {!status.configured ? (
          <NoKey onOpen={() => openSettings(true)} />
        ) : messages.length === 0 ? (
          <Welcome
            onStart={start}
            onSubtitles={() => openSubtitles(true)}
            onSmartCut={() => openSmartCut(true)}
          />
        ) : (
          messages.map((message) => <Bubble key={message.id} message={message} />)
        )}

        {job && <JobRow job={job} onCancel={cancel} />}
      </div>

      <div className="shrink-0 border-t border-white/[0.055] p-3">
        <SelectionChip />
        <div
          className={cn(
            'rounded-xl border border-white/[0.08] bg-ink-900/60 transition-all duration-200',
            'focus-within:border-accent-500/45 focus-within:shadow-[0_0_0_3px_rgba(124,58,237,.15)]',
          )}
        >
          <textarea
            ref={composer}
            value={draft}
            rows={2}
            disabled={!status.configured}
            placeholder={
              status.configured
                ? 'Décrivez ce que vous voulez, ou collez un script…'
                : 'Enregistrez une clé API pour commencer'
            }
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line — the convention every
              // chat uses, and the reason a script pastes in cleanly.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send(draft);
              }
            }}
            className="selectable max-h-40 w-full resize-none bg-transparent px-3.5 py-2.5 text-[13px] leading-relaxed text-white placeholder:text-white/25 focus:outline-none disabled:opacity-50"
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <span className="pl-1.5 text-[10px] text-white/25">⇧ + Entrée — nouvelle ligne</span>
            {job ? (
              <button
                type="button"
                onClick={cancel}
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-white/[0.09] px-2.5 text-2xs text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white/90"
              >
                <CircleSlash size={11} strokeWidth={2.2} />
                Arrêter
              </button>
            ) : (
              <button
                type="button"
                disabled={!draft.trim() || !status.configured}
                onClick={() => send(draft)}
                aria-label="Envoyer"
                className={cn(
                  'grid h-7 w-7 place-items-center rounded-lg transition-all duration-200',
                  'bg-accent-500 text-white shadow-glow active:scale-95',
                  'disabled:pointer-events-none disabled:bg-white/[0.06] disabled:text-white/25 disabled:shadow-none',
                )}
              >
                <ArrowUp size={14} strokeWidth={2.6} />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */

/**
 * What the assistant is currently looking at.
 *
 * The capability is invisible otherwise: nothing about a chat field suggests
 * that selecting three clips first and then saying "agrandis-les" will work.
 * One line above the composer is enough to make it discoverable, and it doubles
 * as confirmation that the selection the panel sees is the one on screen.
 */
function SelectionChip() {
  const project = useEditor((state) => state.project);
  const selected = useEditor((state) => state.selectedClipIds);
  if (selected.length === 0) return null;

  const name = (id: string): string => {
    const clip = project?.clips.find((item) => item.id === id);
    if (!clip) return id;
    if (clip.text) return clip.text.content.replace(/\s+/g, ' ').slice(0, 22);
    if (clip.label) return clip.label;
    return project?.assets.find((item) => item.id === clip.assetId)?.name ?? 'clip';
  };

  return (
    <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px] text-white/40">
      <MousePointerClick size={11} strokeWidth={2.2} className="shrink-0 text-accent-300/70" />
      <span className="min-w-0 truncate">
        {selected.length === 1
          ? `« ${name(selected[0] as string)} » sélectionné`
          : `${selected.length} clips sélectionnés`}
        <span className="text-white/25"> — dites ce que vous voulez en faire</span>
      </span>
    </div>
  );
}

function NoKey({ onOpen }: { onOpen(): void }) {
  return (
    <div className="mt-6 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5 text-center">
      <div className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-accent-500/[0.12] text-accent-300">
        <KeyRound size={17} strokeWidth={2} />
      </div>
      <h3 className="mt-3 text-[14px] font-medium text-white/90">Assistant hors ligne</h3>
      <p className="mx-auto mt-1.5 max-w-[26ch] text-2xs leading-relaxed text-white/40">
        Veglass utilise votre propre clé Google AI Studio. Elle reste sur cette machine.
      </p>
      <Button size="sm" variant="primary" className="mt-4" onClick={onOpen}>
        Enregistrer une clé
      </Button>
    </div>
  );
}

function Welcome({
  onStart,
  onSubtitles,
  onSmartCut,
}: {
  onStart(prompt: string): void;
  onSubtitles(): void;
  onSmartCut(): void;
}) {
  return (
    <div className="space-y-4 pt-3">
      <p className="px-0.5 text-2xs leading-relaxed text-white/40">
        L’assistant voit votre timeline — pistes, clips, médias importés — et peut proposer des
        modifications. Rien n’est écrit sans votre accord.
      </p>

      <div className="grid gap-1.5">
        {STARTERS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              type="button"
              onClick={() => onStart(item.prompt)}
              className={cn(
                'flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5',
                'text-left transition-all duration-200 ease-smooth',
                'hover:border-white/[0.14] hover:bg-white/[0.045] active:scale-[0.99]',
              )}
            >
              <Icon size={13} strokeWidth={2} className="shrink-0 text-accent-300/70" />
              <span className="text-[13px] text-white/75">{item.label}</span>
            </button>
          );
        })}
      </div>

      <div className="space-y-1.5 border-t border-white/[0.06] pt-4">
        <p className="eyebrow px-0.5">Passes automatiques</p>
        <button
          type="button"
          onClick={onSubtitles}
          className="flex w-full items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-left transition-all duration-200 hover:border-white/[0.14] hover:bg-white/[0.045]"
        >
          <Captions size={13} strokeWidth={2} className="shrink-0 text-accent-300/70" />
          <span className="text-[13px] text-white/75">Générer les sous-titres</span>
        </button>
        <button
          type="button"
          onClick={onSmartCut}
          className="flex w-full items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-left transition-all duration-200 hover:border-white/[0.14] hover:bg-white/[0.045]"
        >
          <Scissors size={13} strokeWidth={2} className="shrink-0 text-accent-300/70" />
          <span className="text-[13px] text-white/75">Détecter les temps morts</span>
        </button>
      </div>
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="selectable max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent-500/[0.16] px-3.5 py-2.5 text-[13px] leading-relaxed text-white/90 shadow-[inset_0_0_0_1px_rgba(124,58,237,.22)]">
          {message.text}
        </p>
      </div>
    );
  }

  if (message.error) {
    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-red-500/25 bg-red-500/[0.07] px-3.5 py-3">
        <TriangleAlert size={13} strokeWidth={2} className="mt-0.5 shrink-0 text-red-400" />
        <p className="selectable min-w-0 text-2xs leading-relaxed text-red-200/90">
          {message.error.message}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="selectable whitespace-pre-wrap text-[13px] leading-relaxed text-white/75">
        {message.text}
      </p>
      {message.plan && <PlanCard messageId={message.id} plan={message.plan} />}
    </div>
  );
}

/**
 * A proposed plan, with what it would do and what it could not.
 *
 * Rejected actions are listed rather than hidden: an assistant that quietly
 * drops a third of what it promised is worse than one that says which third.
 */
function PlanCard({ messageId, plan }: { messageId: string; plan: AiPlan }) {
  const project = useEditor((state) => state.project);
  const commit = useAi((state) => state.commitPlan);
  const applied = plan.appliedAt !== null;

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border transition-colors duration-200',
        applied
          ? 'border-accent-500/25 bg-accent-500/[0.05]'
          : 'border-white/[0.09] bg-white/[0.022]',
      )}
    >
      <div className="flex items-center gap-2 px-3 pb-2 pt-2.5">
        <ListChecks size={12} strokeWidth={2.2} className="shrink-0 text-accent-300/70" />
        <p className="min-w-0 flex-1 truncate text-2xs font-medium text-white/80">{plan.title}</p>
        <span className="num shrink-0 text-[10px] text-white/30">
          {plan.actions.length} action{plan.actions.length > 1 ? 's' : ''}
        </span>
      </div>

      <ul className="space-y-px px-3 pb-2">
        {plan.actions.map((action, index) => (
          <li
            key={`${plan.id}-${index}`}
            className="flex gap-2 py-1 text-[12px] leading-snug text-white/55"
          >
            <span className="num shrink-0 text-white/20">{index + 1}</span>
            <span className="min-w-0">{describeAction(action, project)}</span>
          </li>
        ))}
      </ul>

      {plan.rejected.length > 0 && (
        <ul className="space-y-px border-t border-white/[0.06] px-3 py-2">
          {plan.rejected.map((entry, index) => (
            <li
              key={`${plan.id}-rejected-${index}`}
              className="flex gap-2 py-0.5 text-[11px] leading-snug text-amber-300/70"
            >
              <TriangleAlert size={11} strokeWidth={2.2} className="mt-0.5 shrink-0" />
              <span className="min-w-0">
                {describeAction(entry.action, project)} — {entry.reason}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] bg-white/[0.015] px-3 py-2">
        {applied ? (
          <span className="text-2xs text-accent-300/80">
            Appliqué — annulable avec Ctrl + Z
          </span>
        ) : (
          <Button size="sm" variant="primary" onClick={() => commit(messageId)}>
            Appliquer
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * What the assistant is doing, and for how long.
 *
 * The elapsed counter is the point. A spinner alone cannot tell a request that
 * is working from one that has stalled, and a silent minute is indistinguishable
 * from a broken feature — which is exactly how it felt before this existed.
 */
export function JobRow({ job, onCancel }: { job: AiJob; onCancel(): void }) {
  const elapsed = useElapsed(job.startedAt);

  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Loader2 size={12} strokeWidth={2.4} className="shrink-0 animate-spin text-accent-300" />
        <p className="min-w-0 flex-1 truncate text-2xs text-white/60">{job.label}</p>
        <span className="num shrink-0 text-[10px] text-white/30">{elapsed} s</span>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 text-[10px] text-white/35 underline underline-offset-2 transition-colors hover:text-white/70"
        >
          Arrêter
        </button>
      </div>
      {job.progress !== null && (
        <div className="mt-2 h-0.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
          <div
            className="h-full rounded-full bg-accent-500 transition-[width] duration-300 ease-smooth"
            style={{ width: `${Math.round(Math.max(0.04, job.progress) * 100)}%` }}
          />
        </div>
      )}
      {job.detail && (
        <p className="mt-2 flex gap-1.5 text-[11px] leading-snug text-amber-300/75">
          <TriangleAlert size={11} strokeWidth={2.2} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{job.detail}</span>
        </p>
      )}
    </div>
  );
}

/** Whole seconds since `since`, ticking once a second. */
export function useElapsed(since: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return Math.max(0, Math.round((now - since) / 1000));
}
