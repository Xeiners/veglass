import { useMemo } from 'react';
import { Clapperboard, Crop, ImageOff, Plus, RotateCcw, Zap } from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatClock } from '@/lib/time';
import { Button } from '@/components/ui/Button';
import { Slider } from '@/components/ui/Slider';
import { SkeletonBlock } from '@/components/ui/Skeleton';
import { useEditor } from '@/store/editorStore';
import { useViral } from '@/store/viralStore';
import { framingAxis, keptWidth, reframe } from '@/lib/viral/frame';
import { clipLength, frameOf, scoreBand, type ViralClip } from '@/types/viral';
import { Footer, Warning } from '@/components/ui/Wizard';

/**
 * Step 4 — the proposals.
 *
 * A dashboard rather than a list, because the decision being made is a
 * comparison: which of these six is worth the export. So the score, the
 * duration and the frame are all readable at a glance, and the reasoning sits
 * underneath for the ones that look close.
 *
 * Nothing here has touched the document yet. Each card offers the two things
 * that actually differ — dropping the cut into the montage that is open, or
 * spinning it out as its own vertical sequence — and says which is which.
 */
export function ViralResults() {
  const clips = useViral((state) => state.clips);
  const options = useViral((state) => state.options);
  const importAll = useViral((state) => state.importAll);
  const reset = useViral((state) => state.reset);
  const failedWindows = useViral((state) => state.failedWindows);

  const project = useEditor((state) => state.project);
  const asset = (project?.assets ?? []).find((item) => item.id === options.assetId) ?? null;

  const target = frameOf(options.format, project?.settings.fps ?? 30);

  // The destination's shape, not the wizard's answer, is what "Ajouter au
  // projet" will actually produce — so the panel says so rather than letting
  // someone discover it after six imports.
  const mismatch = useMemo(() => {
    if (!project) return false;
    const wanted = target.width / target.height;
    const open = project.settings.width / project.settings.height;
    return Math.abs(wanted - open) > 0.01;
  }, [project, target]);

  const pending = clips.filter((clip) => !clip.placed).length;

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-[14px] font-medium text-white/90">
            {clips.length} extrait{clips.length > 1 ? 's' : ''} proposé
            {clips.length > 1 ? 's' : ''}
          </h3>
          <p className="text-2xs text-white/32">
            Classés par estimation. Rien n’est ajouté au projet tant que vous ne le demandez pas.
          </p>
        </div>

        {failedWindows > 0 && (
          <Warning tone="soft">
            {failedWindows} partie{failedWindows > 1 ? 's' : ''} de la vidéo n’
            {failedWindows > 1 ? 'ont' : 'a'} pas pu être transcrite
            {failedWindows > 1 ? 's' : ''} : l’analyse ne porte pas dessus.
          </Warning>
        )}

        {mismatch && (
          <Warning tone="soft">
            Le projet ouvert est en {project?.settings.width} × {project?.settings.height}, pas en{' '}
            {target.width} × {target.height}. « Ajouter au projet » cadre l’extrait pour le projet
            ouvert ; « Séquence dédiée » crée un projet au format choisi — c’est celui-là qui donne
            le rendu vertical.
          </Warning>
        )}

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {clips.map((clip, index) => (
            <ClipCard key={clip.id} clip={clip} rank={index + 1} />
          ))}
        </div>

        {asset && (
          <p className="mt-5 text-[10px] leading-relaxed text-white/25">
            Les extraits pointent sur « {asset.name} » par un point d’entrée : rien n’est copié ni
            réencodé tant que vous n’exportez pas.
          </p>
        )}
      </div>

      <Footer
        left={
          <Button variant="ghost" icon={<RotateCcw size={14} strokeWidth={2} />} onClick={reset}>
            Recommencer
          </Button>
        }
        right={
          <Button
            variant="primary"
            icon={<Plus size={14} strokeWidth={2} />}
            disabled={pending === 0}
            onClick={importAll}
          >
            {pending === 0
              ? 'Tout est placé'
              : `Ajouter les ${pending} extrait${pending > 1 ? 's' : ''}`}
          </Button>
        }
      />
    </>
  );
}

const BAND_STYLES = {
  high: 'border-emerald-500/30 bg-emerald-500/[0.12] text-emerald-200',
  mid: 'border-amber-500/25 bg-amber-500/[0.1] text-amber-200',
  low: 'border-white/[0.1] bg-white/[0.05] text-white/50',
} as const;

function ClipCard({ clip, rank }: { clip: ViralClip; rank: number }) {
  const options = useViral((state) => state.options);
  const setFocus = useViral((state) => state.setFocus);
  const importClip = useViral((state) => state.importClip);
  const makeSequence = useViral((state) => state.makeSequence);

  const project = useEditor((state) => state.project);
  const asset = (project?.assets ?? []).find((item) => item.id === options.assetId) ?? null;

  const target = frameOf(options.format, project?.settings.fps ?? 30);
  const framing = asset ? reframe(asset, target, clip.focus) : null;
  const axis = framing ? framingAxis(framing) : null;
  const kept = framing?.known ? keptWidth(framing, target) : null;

  const band = scoreBand(clip.score);

  return (
    <article
      className={cn(
        'flex flex-col overflow-hidden rounded-xl border transition-colors',
        clip.placed
          ? 'border-accent-500/30 bg-accent-500/[0.045]'
          : 'border-white/[0.07] bg-white/[0.022]',
      )}
    >
      <div className="flex gap-3.5 p-3.5">
        <Thumbnail clip={clip} focus={clip.focus} />

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span className="num mt-0.5 shrink-0 text-[10px] text-white/25">{rank}</span>
            <h4 className="min-w-0 flex-1 text-[13px] font-medium leading-snug text-white/90">
              {clip.title}
            </h4>
            <span
              className={cn(
                'num shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
                BAND_STYLES[band],
              )}
              title="Estimation du modèle, de 0 à 100"
            >
              {clip.score}
            </span>
          </div>

          <p className="num mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] text-white/32">
            <span>{formatClock(clip.start)} → {formatClock(clip.end)}</span>
            <span className="text-white/45">{Math.round(clipLength(clip))} s</span>
            {clip.segments.length > 0 && (
              <span>
                {clip.segments.length} réplique{clip.segments.length > 1 ? 's' : ''}
              </span>
            )}
          </p>

          {/* What will actually be burnt into the opening seconds — worth seeing
              before it is, since it is the line that does the work. */}
          {options.hooks && clip.hook && (
            <p className="mt-2 flex items-center gap-1.5">
              <Zap size={10} strokeWidth={2.4} className="shrink-0 text-accent-300/70" />
              <span className="min-w-0 truncate text-2xs font-medium text-accent-100/85">
                {clip.hook}
              </span>
            </p>
          )}

          {clip.reason && (
            <p className="mt-2 line-clamp-3 text-2xs leading-relaxed text-white/42">
              {clip.reason}
            </p>
          )}

          {clip.keywords.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {clip.keywords.map((word) => (
                <span
                  key={word}
                  className="rounded border border-white/[0.07] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-white/35"
                >
                  {word}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {axis && (
        <div className="flex items-center gap-3 border-t border-white/[0.05] px-3.5 py-2.5">
          <Crop size={12} strokeWidth={2} className="shrink-0 text-white/28" />
          <Slider
            value={clip.focus}
            min={0}
            max={1}
            step={0.01}
            onChange={(focus) => setFocus(clip.id, focus)}
            aria-label="Cadrage"
            className="flex-1"
          />
          <span className="num w-[7.5ch] shrink-0 text-right text-[10px] text-white/28">
            {kept !== null ? `${Math.round(kept * 100)} %` : '—'}
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-white/[0.05] px-3.5 py-2.5">
        <Button
          size="sm"
          variant={clip.placed ? 'ghost' : 'secondary'}
          icon={<Plus size={12} strokeWidth={2} />}
          onClick={() => importClip(clip.id)}
        >
          {clip.placed ? 'Ajouter à nouveau' : 'Ajouter au projet'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<Clapperboard size={12} strokeWidth={2} />}
          onClick={() => void makeSequence(clip.id)}
        >
          Séquence dédiée
        </Button>
      </div>
    </article>
  );
}

/**
 * The still, framed the way the export will frame it.
 *
 * The thumbnail is a whole frame of the source, so the crop is shown by
 * scaling and shifting it inside a window of the target's shape — the same
 * arithmetic as `reframe`, expressed in percentages because the picture's
 * pixel size here is whatever the card gives it.
 */
function Thumbnail({ clip, focus }: { clip: ViralClip; focus: number }) {
  const options = useViral((state) => state.options);
  const format = options.format;

  const aspect = format === 'vertical' ? 9 / 16 : format === 'square' ? 1 : 16 / 9;
  const width = format === 'vertical' ? 62 : format === 'square' ? 88 : 108;

  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-lg bg-ink-950"
      style={{ width, height: Math.round(width / aspect) }}
    >
      {clip.posterState === 'ready' && clip.poster ? (
        <img
          src={clip.poster}
          alt=""
          className="absolute left-1/2 top-1/2 h-full w-auto max-w-none"
          style={{
            // `h-full w-auto` covers a wide still inside a tall window; the
            // translation then pans it to the chosen focus.
            transform: `translate(calc(-50% + ${(0.5 - focus) * 100}%), -50%)`,
          }}
        />
      ) : clip.posterState === 'failed' ? (
        <span className="absolute inset-0 grid place-items-center text-white/18">
          <ImageOff size={16} strokeWidth={2} />
        </span>
      ) : (
        <SkeletonBlock className="h-full w-full rounded-none" />
      )}
    </div>
  );
}
