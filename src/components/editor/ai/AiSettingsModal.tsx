import { useEffect, useState } from 'react';
import {
  Check,
  Eye,
  EyeOff,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  Trash2,
  Wifi,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { openExternal } from '@/lib/env';
import { Button } from '@/components/ui/Button';
import { Field, Input, OptionCard } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Slider } from '@/components/ui/Slider';
import { useAi } from '@/store/aiStore';
import { useEditor } from '@/store/editorStore';
import { useVoice } from '@/store/voiceStore';
import { SUGGESTED_MODELS, type KeyBackend } from '@/types/ai';
import { VoicePanel } from './VoicePanel';

/**
 * Two providers, two halves of one panel.
 *
 * They are kept in the same dialog because they are the same errand — "give
 * Veglass the keys it needs" — and split into tabs because they are
 * independently optional: understanding a montage and speaking over one are
 * bought separately, and someone who wants only the first should never have to
 * scroll past the second to reach the model list.
 */
type SettingsTab = 'model' | 'voice';

const CONSOLE_URL = 'https://aistudio.google.com/apikey';

/**
 * Where the key ends up, said plainly.
 *
 * The file backend is obfuscation, not encryption, and claiming otherwise would
 * be the kind of reassurance that costs someone their key. Each line is written
 * so a reader knows exactly what protection they have.
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
    detail:
      'Mode développement : la clé reste dans le localStorage de cette page. Utilisez l’application desktop pour un stockage protégé.',
    safe: false,
  },
  none: { label: 'Aucune clé', detail: '', safe: false },
};

export function AiSettingsModal() {
  const open = useAi((state) => state.settingsOpen);
  const setOpen = useAi((state) => state.openSettings);
  const status = useAi((state) => state.keyStatus);
  const settings = useAi((state) => state.settings);
  const models = useAi((state) => state.models);
  const modelsLoading = useAi((state) => state.modelsLoading);

  const saveKey = useAi((state) => state.saveKey);
  const removeKey = useAi((state) => state.removeKey);
  const loadModels = useAi((state) => state.loadModels);
  const patch = useAi((state) => state.patchSettings);

  const voiceConfigured = useVoice((state) => state.keyStatus.configured);
  const voiceName = useVoice(
    (state) =>
      state.voices.find((voice) => voice.id === state.preferences.voiceId)?.name ?? null,
  );

  const [tab, setTab] = useState<SettingsTab>('model');
  const [draft, setDraft] = useState('');
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);

  // The field starts empty every time: it is a *write* channel, never a place
  // the stored key is echoed back.
  useEffect(() => {
    if (!open) return;
    setDraft('');
    setReveal(false);
    // Ask Google what this key can actually reach. Model ids age out — one was
    // retired under this app's feet — and a list fetched on open is the only
    // version of this panel that cannot go stale.
    if (status.configured) void loadModels();
  }, [open, status.configured, loadModels]);

  const backend = BACKENDS[status.backend];

  const submit = async (verify: boolean) => {
    if (!draft.trim() || saving) return;
    setSaving(true);
    const ok = await saveKey(draft, verify);
    setSaving(false);
    if (ok) setDraft('');
  };

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Assistant IA"
      description="Veglass parle à ces services avec vos propres clés. Elles ne quittent jamais cette machine, sauf pour joindre le service concerné."
      width="md"
      footer={
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Fermer
        </Button>
      }
    >
      <div className="mb-5 flex gap-0.5 rounded-xl border border-white/[0.06] bg-ink-900/50 p-0.5">
        {(
          [
            { id: 'model', label: 'Modèle', hint: status.configured ? 'Gemini' : 'Aucune clé' },
            {
              id: 'voice',
              label: 'Voix',
              hint: voiceConfigured ? (voiceName ?? 'ElevenLabs') : 'Aucune clé',
            },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            aria-pressed={tab === item.id}
            className={cn(
              'flex flex-1 flex-col items-center rounded-[10px] px-3 py-2 transition-all duration-200 ease-smooth',
              tab === item.id
                ? 'bg-white/[0.07] text-white shadow-[inset_0_1px_0_rgba(255,255,255,.07)]'
                : 'text-white/40 hover:text-white/70',
            )}
          >
            <span className="text-2xs font-medium">{item.label}</span>
            <span className="mt-0.5 max-w-full truncate text-[10px] text-white/30">
              {item.hint}
            </span>
          </button>
        ))}
      </div>

      {tab === 'voice' && <VoicePanel />}

      <div className={cn('space-y-6 pb-2', tab !== 'model' && 'hidden')}>
        {/* ---------------- Key ---------------- */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="eyebrow">Clé API Gemini</h3>
            <a
              href={CONSOLE_URL}
              // A webview has no new tab to open, so the anchor's default does
              // nothing at all under Tauri; the OS is asked instead. The href
              // stays for the browser host, and for copy-link.
              onClick={(event) => {
                event.preventDefault();
                void openExternal(CONSOLE_URL).catch(() =>
                  useEditor
                    .getState()
                    .notify(`Ouvrez ${CONSOLE_URL} dans votre navigateur`, 'error'),
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
                    <span className="num ml-2 text-2xs font-normal text-white/40">
                      {status.hint}
                    </span>
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
                  placeholder="AIza…"
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
                  <Loader2 size={13} strokeWidth={2.4} className="animate-spin" />
                ) : (
                  <Check size={13} strokeWidth={2.4} />
                )
              }
              onClick={() => void submit(true)}
            >
              Vérifier et enregistrer
            </Button>
          </div>

          {/* Both destructive-ish controls sit *after* the field on purpose: the
              dialog focuses its first control on open, and that should be where
              a pasted key goes — not a delete button. */}
          <p className="text-2xs leading-relaxed text-white/35">
            La clé est testée auprès de Google avant d’être enregistrée — la vérification ne
            consomme aucun quota.{' '}
            <button
              type="button"
              disabled={!draft.trim() || saving}
              onClick={() => void submit(false)}
              className="text-white/50 underline underline-offset-2 transition-colors hover:text-white/80 disabled:opacity-40"
            >
              Enregistrer sans vérifier
            </button>{' '}
            si cette machine est hors ligne.
          </p>

          {status.configured && (
            <button
              type="button"
              onClick={() => void loadModels(true)}
              disabled={modelsLoading}
              className="mr-3 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 -ml-2 text-2xs text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white/85 disabled:opacity-40"
            >
              {modelsLoading ? (
                <Loader2 size={11} strokeWidth={2.4} className="animate-spin" />
              ) : (
                <Wifi size={11} strokeWidth={2.2} />
              )}
              Tester la connexion
            </button>
          )}

          {status.configured && (
            <button
              type="button"
              onClick={() => void removeKey()}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 -ml-2 text-2xs text-white/40 transition-colors hover:bg-red-500/10 hover:text-red-300"
            >
              <Trash2 size={11} strokeWidth={2.2} />
              Supprimer la clé enregistrée
            </button>
          )}
        </section>

        {/* ---------------- Model ---------------- */}
        <section className="space-y-3 border-t border-white/[0.06] pt-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="eyebrow">Modèle</h3>
            <button
              type="button"
              disabled={!status.configured || modelsLoading}
              onClick={() => void loadModels()}
              className="inline-flex items-center gap-1.5 text-2xs text-white/40 transition-colors hover:text-white/75 disabled:opacity-35"
            >
              {modelsLoading ? (
                <Loader2 size={10} strokeWidth={2.4} className="animate-spin" />
              ) : (
                <RefreshCw size={10} strokeWidth={2.4} />
              )}
              {models.length > 0 ? `${models.length} disponibles` : 'Lister les modèles'}
            </button>
          </div>

          <div className="grid gap-1.5">
            {SUGGESTED_MODELS.map((model) => (
              <OptionCard
                key={model.id}
                active={settings.model === model.id}
                onSelect={() => patch({ model: model.id, transcriptionModel: model.id })}
                title={model.label}
                subtitle={
                  models.length > 0 && !models.some((item) => item.id === model.id)
                    ? 'Indisponible pour cette clé'
                    : model.hint
                }
              />
            ))}
          </div>

          {models.length > 0 && (
            <Field label="Autre modèle" hint={`${models.length} accessibles avec cette clé`}>
              <select
                value={models.some((item) => item.id === settings.model) ? settings.model : ''}
                onChange={(event) =>
                  event.target.value &&
                  patch({ model: event.target.value, transcriptionModel: event.target.value })
                }
                className="h-11 w-full rounded-xl border border-white/[0.08] bg-ink-900/60 px-3 text-[13px] text-white transition-colors hover:border-white/[0.13] focus:border-accent-500/50 focus:outline-none"
              >
                <option value="">Choisir dans la liste…</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field
            label="Identifiant exact"
            hint="Un modèle plus récent que cette version de Veglass"
          >
            <Input
              value={settings.model}
              spellCheck={false}
              onChange={(event) => patch({ model: event.target.value.trim() })}
              className="font-mono text-[13px]"
              list="veglass-ai-models"
            />
          </Field>
          <datalist id="veglass-ai-models">
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </datalist>

          <Field
            label="Modèle de transcription"
            hint="Doit accepter l’audio en entrée"
          >
            <Input
              value={settings.transcriptionModel}
              spellCheck={false}
              onChange={(event) => patch({ transcriptionModel: event.target.value.trim() })}
              className="font-mono text-[13px]"
              list="veglass-ai-models"
            />
          </Field>
        </section>

        {/* ---------------- Behaviour ---------------- */}
        <section className="space-y-4 border-t border-white/[0.06] pt-5">
          <h3 className="eyebrow">Comportement</h3>

          <Field
            label="Liberté de rédaction"
            hint={<span className="num">{settings.temperature.toFixed(2)}</span>}
          >
            <Slider
              value={settings.temperature}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => patch({ temperature: value })}
              aria-label="Température du modèle"
            />
            <p className="mt-2 text-2xs leading-relaxed text-white/35">
              Bas, les réponses sont littérales et reproductibles. Haut, l’assistant propose
              davantage — au risque de s’écarter de la demande.
            </p>
          </Field>

          <Field label="Langue de travail" hint="Utilisée pour les réponses et les titres">
            <Input
              value={settings.language}
              onChange={(event) => patch({ language: event.target.value })}
            />
          </Field>

          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-3 transition-colors hover:border-white/[0.12]">
            <input
              type="checkbox"
              checked={settings.autoFallback}
              onChange={(event) => patch({ autoFallback: event.target.checked })}
              className="mt-0.5 h-4 w-4 shrink-0 accent-accent-500"
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-white/85">
                Changer de modèle quand le quota est épuisé
              </span>
              <span className="mt-0.5 block text-2xs leading-relaxed text-white/40">
                Les quotas Gemini sont comptés <strong className="font-medium text-white/55">par
                modèle</strong> : quand celui choisi est à court, le suivant repart d’un compteur
                neuf, sans attente. Le basculement est annoncé, et n’a lieu que pour un quota — une
                clé refusée ou un réseau coupé échoueraient de la même façon sur tous.
              </span>
            </span>
          </label>

          {settings.autoFallback && (
            <Field label="Modèles de secours" hint="Dans l’ordre, séparés par une virgule">
              <Input
                value={settings.fallbackModels.join(', ')}
                spellCheck={false}
                onChange={(event) =>
                  patch({
                    fallbackModels: event.target.value
                      .split(',')
                      .map((id) => id.trim())
                      .filter((id) => id !== ''),
                  })
                }
                className="font-mono text-[13px]"
              />
            </Field>
          )}

          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-3 transition-colors hover:border-white/[0.12]">
            <input
              type="checkbox"
              checked={settings.autoApply}
              onChange={(event) => patch({ autoApply: event.target.checked })}
              className="mt-0.5 h-4 w-4 shrink-0 accent-accent-500"
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-white/85">
                Appliquer les plans sans confirmation
              </span>
              <span className="mt-0.5 block text-2xs leading-relaxed text-white/40">
                Par défaut l’assistant propose et vous validez. Activé, chaque plan est écrit
                immédiatement — annulable en une fois avec Ctrl + Z.
              </span>
            </span>
          </label>
        </section>
      </div>
    </Modal>
  );
}
