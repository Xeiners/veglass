import { useEffect } from 'react';
import { Mic, Sparkles } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { useRangeNarration } from '@/store/rangeNarrationStore';
import { useEditor } from '@/store/editorStore';
import { useAi } from '@/store/aiStore';
import { canSpeak, useVoice } from '@/store/voiceStore';
import { MAX_NARRATION_CONTEXT, MAX_NARRATION_TEXT, narrationDuration } from '@/lib/tutorial/rangeNarration';

export function RangeNarrationDialog() {
  const state = useRangeNarration();
  const project = useEditor(s => s.project);
  const voiceReady = useVoice(canSpeak);
  const configured = useAi(s => s.keyStatus.configured);
  const openSettings = useAi(s => s.openSettings);
  useEffect(() => { if (state.open && project?.id !== state.projectId) state.close(); }, [state.open, state.projectId, project?.id, state.close]);
  const duration = state.range.end - state.range.start;
  const long = state.take && narrationDuration(state.take, project?.settings.fps ?? 30) > duration + 1e-6;
  const overlap = project?.clips.some(clip => clip.start < state.range.end && clip.start + clip.duration > state.range.start &&
    project.tracks.some(track => track.id === clip.trackId && track.kind === 'audio' && !track.muted) && !clip.muted);
  const textClass = 'mt-1 w-full rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-white/85 outline-none focus:border-accent-400';
  return <Modal open={state.open} onClose={state.close} width="lg" title="Voix off sur la sélection"
    description="Complétez un passage du tutoriel, sans refaire le montage."
    footer={<>
      {state.busy ? <Button onClick={state.cancel}>Annuler</Button> : <Button onClick={state.close}>Fermer</Button>}
      <Button variant="primary" disabled={!state.take || state.busy || state.placed || Boolean(long)} onClick={state.insert}>Ajouter la voix dans la plage</Button>
    </>}>
    <div className="space-y-4 pb-3">
      <p className="text-xs leading-relaxed text-white/50">Dans la timeline, placez le curseur au début puis appuyez sur I, et à la fin puis sur O. La plage est reprise à l’ouverture ; vous pouvez aussi ajuster les temps ici (2–180 s).</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Début dans la timeline (s)"><Input aria-label="Début de la narration" type="number" min={0} step={1 / (project?.settings.fps ?? 30)} disabled={state.busy} value={Number.isFinite(state.range.start) ? state.range.start : ''} onChange={e => state.configure({ range: { ...state.range, start: e.target.valueAsNumber } })} /></Field>
        <Field label="Fin dans la timeline (s)"><Input aria-label="Fin de la narration" type="number" min={0} step={1 / (project?.settings.fps ?? 30)} disabled={state.busy} value={Number.isFinite(state.range.end) ? state.range.end : ''} onChange={e => state.configure({ range: { ...state.range, end: e.target.valueAsNumber } })} /></Field>
      </div>
      <Field label="Contexte du tutoriel" hint="Mémorisé dans ce projet">
        <textarea aria-label="Contexte du tutoriel" rows={3} maxLength={MAX_NARRATION_CONTEXT} disabled={state.busy} value={state.context} onChange={e => state.configure({ context: e.target.value })} className={textClass} placeholder="Logiciel, objectif du tutoriel, vocabulaire, public, ton, étapes déjà expliquées…" />
      </Field>
      <Button size="sm" disabled={state.busy} onClick={state.saveContext}>Mémoriser le contexte</Button>
      <Field label="Consigne pour ce passage uniquement">
        <Input aria-label="Consigne du passage" disabled={state.busy} maxLength={2000} value={state.instruction} onChange={e => state.configure({ instruction: e.target.value })} placeholder="Explique pourquoi on valide cette option, sans répéter l’introduction…" />
      </Field>
      <Button icon={<Sparkles size={14} />} disabled={state.busy || !configured || !state.context.trim()} onClick={() => void state.generate()}>Proposer le texte pour cette plage</Button>
      <p className="text-[11px] leading-relaxed text-white/40">Le contexte est enregistré lors de la génération. Gemini reçoit jusqu’à 40 images sources des vidéos de la plage, sans le rendu des effets ni l’écoute du son. Le texte reste modifiable ; vous pouvez aussi l’écrire directement. Gemini et ElevenLabs utilisent vos clés existantes et facturent les générations.</p>
      {state.images !== null && <p className="text-xs text-white/50">{state.images} images lues{state.missing > 0 ? ` · ${state.missing} instants sans image lisible` : ''}</p>}
      <Field label="Texte à prononcer" hint={`${state.text.length} caractères`}>
        <textarea aria-label="Texte à prononcer" rows={5} maxLength={MAX_NARRATION_TEXT} disabled={state.busy} value={state.text} onChange={e => state.configure({ text: e.target.value })} className={textClass} />
      </Field>
      <Button icon={<Mic size={14} />} disabled={state.busy || !voiceReady || !state.text.trim()} onClick={() => void state.synthesize()}>Générer la voix</Button>
      {(!configured || !voiceReady) && <Button onClick={() => { state.close(); openSettings(true); }}>Configurer Gemini / ElevenLabs</Button>}
      {state.asset && state.take && <div className="space-y-2 rounded-lg bg-white/5 p-3">
        <audio controls src={state.asset.src} className="w-full" />
        <p className="text-xs text-white/60">Voix : {state.take.duration.toFixed(1)} s · plage : {duration.toFixed(1)} s</p>
        {long && <p role="alert" className="text-xs text-amber-300">La voix dépasse la plage. Raccourcissez le texte puis régénérez-la : elle ne sera pas coupée automatiquement.</p>}
      </div>}
      {overlap && !state.placed && <p className="text-xs text-amber-300">Une piste audio occupe déjà cette plage. La nouvelle voix sera superposée, sans remplacer ni atténuer le son existant. Vérifiez la plage avant l’ajout.</p>}
      {state.busy && <p role="status" className="text-xs text-accent-300">{state.detail}… La requête vocale déjà envoyée peut finir après l’annulation, mais elle ne sera pas insérée.</p>}
      {state.error && <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-xs text-red-200">{state.error}</p>}
      {state.placed && <p className="text-xs text-emerald-300">Voix ajoutée. Le reste du montage est inchangé.</p>}
      <p className="text-[11px] text-white/35">Fermer garde la proposition dans cette session. Le contexte, lui, reste dans le projet après réouverture. Les calques vidéo et leur cadrage ne sont jamais modifiés.</p>
    </div>
  </Modal>;
}
