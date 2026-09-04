import { useEffect, useState } from 'react';
import {
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Square,
  Trash2,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { openExternal } from '@/lib/env';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Slider } from '@/components/ui/Slider';
import { useEditor } from '@/store/editorStore';
import { SAMPLE_LINE, useVoice } from '@/store/voiceStore';
import type { KeyBackend } from '@/types/ai';
import { VOICE_MODELS } from '@/types/voice';

const CONSOLE_URL = 'https://elevenlabs.io/app/settings/api-keys';

/**
 * Where the key ends up, said plainly — the same three sentences the Gemini
 * half uses, because the storage is literally the same vault with another name
 * and claiming more for one than the other would be misleading.
 */
const BACKENDS: Record<KeyBackend, { label: string; detail: string; safe: boolean }> = {
  keychain: {
    label: 'Trousseau du système',
    detail:
      'Chiffrée par le système d’exploitation et liée à votre session — aucune autre application n’y accède.',
    safe: true,
  },
  file: {
    label: 'Fichier local masqué',
    detail:
      'Le trousseau système est indisponible sur cette machine. La clé est brouillée dans le dossier de l’application : elle n’apparaît pas en clair dans une sauvegarde, mais qui lit le fichier peut la reconstituer.',
    safe: false,
  },
  browser: {
    label: 'Stockage du navigateur',
    detail: 'La voix off n’est pas disponible hors de l’application desktop.',
    safe: false,
  },
  none: { label: 'Aucune clé', detail: '', safe: false },
};

/**
 * The speech half of the settings.
 *
 * Deliberately shaped like the Gemini panel next to it — key, then what the key
 * reaches, then how it behaves — because they are the same three decisions and
 * someone who has made them once should not have to learn a second layout.
 *
 * The audition button is the one thing here that has no counterpart. A voice is
 * not a setting anyone can evaluate by reading its name, and a tutorial is
 * twelve minutes of listening to whichever one was picked.
 */
export function VoicePanel() {
  const available = useVoice((state) => state.available);
  const status = useVoice((state) => state.keyStatus);
  const voices = useVoice((state) => state.voices);
  const loading = useVoice((state) => state.voicesLoading);
  const preferences = useVoice((state) => state.preferences);
  const auditioning = useVoice((state) => state.auditioning);

  const saveKey = useVoice((state) => state.saveKey);
  const removeKey = useVoice((state) => state.removeKey);
  const loadVoices = useVoice((state) => state.loadVoices);
  const patch = useVoice((state) => state.patch);
  const patchSettings = useVoice((state) => state.patchSettings);
  const audition = useVoice((state) => state.audition);
  const stopAudition = useVoice((state) => state.stopAudition);

  const [draft, setDraft] = useState('');
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [line, setLine] = useState('');

  // The field is a *write* channel, never a place the stored key is echoed back.
  useEffect(() => {
    setDraft('');
    setReveal(false);
  }, []);

  const backend = BACKENDS[status.backend];

  const submit = async (verify: boolean) => {
    if (!draft.trim() || saving) return;
    setSaving(true);
    const ok = await saveKey(draft, verify);
    setSaving(false);
    if (ok) setDraft('');
  };

  if (!available) {
    return (
      <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3.5">
        <p className="text-[13px] font-medium text-white/85">Indisponible dans le navigateur</p>
        <p className="mt-1.5 text-2xs leading-relaxed text-white/45">
          Une voix off doit être écrite sur le disque pour rejoindre le montage et pour être lue à
          l’export. Ouvrez Veglass en application de bureau pour l’activer — le générateur de
          tutoriels fonctionne sans elle, avec les zooms et les chapitres.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-2">
      {/* ---------------- Key ---------------- */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="eyebrow">Clé API ElevenLabs</h3>
          <a
            href={CONSOLE_URL}
            onClick={(event) => {
              event.preventDefault();
              void openExternal(CONSOLE_URL).catch(() =>
                useEditor.getState().notify(`Ouvrez ${CONSOLE_URL} dans votre navigateur`, 'error'),
              );
            }}
            className="inline-flex items-center gap-1 text-2xs text-accent-300/80 transition-colors hover:text-accent-200"
          >
            Obtenir une clé
            <ExternalLink size={10} strokeWidth={2.2} />
          </a>
        </div>

        {status.configured && (
          <div
            className={cn(
              'flex items-start gap-2.5 rounded-xl border px-3.5 py-3',
              backend.safe
                ? 'border-accent-500/25 bg-accent-500/[0.07]'
                : 'border-amber-500/25 bg-amber-500/[0.06]',
            )}
          >
            {backend.safe ? (
              <ShieldCheck size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-accent-300" />
            ) : (
              <ShieldAlert size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-amber-400" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-white/90">
                {backend.label}
                {status.hint && (
                  <span className="num ml-2 text-2xs font-normal text-white/40">{status.hint}</span>
                )}
              </p>
              <p className="mt-1 text-2xs leading-relaxed text-white/45">{backend.detail}</p>
            </div>
          </div>
        )}

        <div className="flex items-end gap-2">
          <Field
            label={status.configured ? 'Remplacer la clé' : 'Coller la clé'}
            className="min-w-0 flex-1"
          >
            <div className="relative">
              <KeyRound
                size={13}
                strokeWidth={2}
                className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25"
              />
              <Input
                type={reveal ? 'text' : 'password'}
                value={draft}
                spellCheck={false}
                autoComplete="off"
                placeholder="sk_…"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit(true);
                }}
                className="pl-9 pr-10 font-mono text-[13px]"
              />
              <button
                type="button"
                onClick={() => setReveal((value) => !value)}
                aria-label={reveal ? 'Masquer la clé' : 'Afficher la clé'}
                className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-white/30 transition-colors hover:bg-white/[0.07] hover:text-white/70"
              >
                {reveal ? <EyeOff size={13} strokeWidth={2} /> : <Eye size={13} strokeWidth={2} />}
              </button>
            </div>
          </Field>

          <Button
            variant="primary"
            disabled={!draft.trim() || saving}
            icon={
              saving ? (
                <Loader2 size={13} strokeWidth={2.2} className="animate-spin" />
              ) : (
                <Check size={13} strokeWidth={2.2} />
              )
            }
            onClick={() => void submit(true)}
          >
            Vérifier
          </Button>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={!draft.trim() || saving}
            onClick={() => void submit(false)}
            className="text-2xs text-white/35 underline-offset-2 transition-colors hover:text-white/60 hover:underline disabled:opacity-40"
          >
            Enregistrer sans vérifier
          </button>

          {status.configured && (
            <button
              type="button"
              onClick={() => void removeKey()}
              className="ml-auto inline-flex items-center gap-1.5 text-2xs text-red-300/70 transition-colors hover:text-red-300"
            >
              <Trash2 size={11} strokeWidth={2.2} />
              Supprimer la clé
            </button>
          )}
        </div>
      </section>

      {/* ---------------- Voice ---------------- */}
      {status.configured && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="eyebrow">Voix</h3>
            <button
              type="button"
              onClick={() => void loadVoices()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 text-2xs text-white/35 transition-colors hover:text-white/70 disabled:opacity-40"
            >
              {loading ? (
                <Loader2 size={11} strokeWidth={2.2} className="animate-spin" />
              ) : (
                <RefreshCw size={11} strokeWidth={2.2} />
              )}
              Rafraîchir
            </button>
          </div>

          {voices.length === 0 ? (
            <p className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-3 text-2xs leading-relaxed text-white/40">
              {loading
                ? 'Lecture de votre bibliothèque de voix…'
                : 'Aucune voix récupérée. Rafraîchissez, ou vérifiez que la clé a bien accès à votre bibliothèque.'}
            </p>
          ) : (
            <Field label="Voix de la narration" hint={`${voices.length} disponibles`}>
              <select
                value={preferences.voiceId}
                onChange={(event) => patch({ voiceId: event.target.value })}
                className="h-11 w-full rounded-xl border border-white/[0.08] bg-ink-900/60 px-3 text-[14px] text-white transition-colors hover:border-white/[0.13] focus:border-accent-500/50 focus:outline-none"
              >
                <option value="">— Choisir une voix —</option>
                {voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name}
                    {voice.labels.length > 0 ? ` · ${voice.labels.join(', ')}` : ''}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field
            label="Écouter"
            hint={<span className="num">{(line || SAMPLE_LINE).trim().length} caractères</span>}
          >
            <div className="flex items-end gap-2">
              <Input
                value={line}
                placeholder={SAMPLE_LINE}
                onChange={(event) => setLine(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void audition(line);
                }}
                className="min-w-0 flex-1"
              />
              <Button
                variant="secondary"
                disabled={!preferences.voiceId}
                icon={
                  auditioning ? (
                    <Square size={12} strokeWidth={2.4} />
                  ) : (
                    <Play size={12} strokeWidth={2.4} />
                  )
                }
                onClick={() => (auditioning ? stopAudition() : void audition(line))}
              >
                {auditioning ? 'Arrêter' : 'Écouter'}
              </Button>
            </div>
          </Field>
          <p className="text-2xs leading-relaxed text-white/30">
            Une écoute est facturée comme une phrase du tutoriel : elle est synthétisée pour de
            vrai, avec les réglages ci-dessous.
          </p>
        </section>
      )}

      {/* ---------------- Delivery ---------------- */}
      {status.configured && (
        <section className="space-y-4">
          <h3 className="eyebrow">Interprétation</h3>

          <Field label="Modèle" hint={preferences.modelId}>
            <div className="grid gap-2">
              {VOICE_MODELS.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => patch({ modelId: model.id })}
                  aria-pressed={preferences.modelId === model.id}
                  className={cn(
                    'rounded-xl border px-3.5 py-2.5 text-left transition-all duration-200',
                    preferences.modelId === model.id
                      ? 'border-accent-500/45 bg-accent-500/[0.09]'
                      : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.14]',
                  )}
                >
                  <span className="block text-[13px] font-medium text-white/85">{model.label}</span>
                  <span className="mt-0.5 block text-2xs text-white/40">{model.hint}</span>
                </button>
              ))}
            </div>
          </Field>

          <Field
            label="Stabilité"
            hint={<span className="num">{preferences.settings.stability.toFixed(2)}</span>}
          >
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={preferences.settings.stability}
              onChange={(value) => patchSettings({ stability: value })}
            />
          </Field>
          <p className="-mt-2 text-2xs leading-relaxed text-white/30">
            Basse, la voix varie et s’anime ; haute, elle reste égale d’une phrase à l’autre. Pour
            un tutoriel, l’égalité vaut mieux que l’expression.
          </p>

          <Field
            label="Débit"
            hint={<span className="num">×{preferences.settings.speed.toFixed(2)}</span>}
          >
            <Slider
              min={0.7}
              max={1.2}
              step={0.02}
              value={preferences.settings.speed}
              onChange={(value) => patchSettings({ speed: value })}
            />
          </Field>

          <Field
            label="Expressivité"
            hint={<span className="num">{preferences.settings.style.toFixed(2)}</span>}
          >
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={preferences.settings.style}
              onChange={(value) => patchSettings({ style: value })}
            />
          </Field>
          <p className="-mt-2 text-2xs leading-relaxed text-white/30">
            Au-delà d’un tiers, la voix commence à interpréter le texte plutôt qu’à le lire — et la
            synthèse devient plus lente.
          </p>
        </section>
      )}
    </div>
  );
}
