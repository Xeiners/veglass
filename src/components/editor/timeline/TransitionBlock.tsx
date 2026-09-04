import { Blend, Sunrise, Sunset, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatClock } from '@/lib/time';
import type { ResolvedTransition } from '@/store/selectors';
import { transitionDescriptor, type TransitionKind } from '@/types/transitions';
import { useTransitionMenu } from '@/components/editor/contextMenus';

const ICON: Record<TransitionKind, LucideIcon> = {
  crossfade: Blend,
  'dip-black': Sunset,
  'dip-white': Sunrise,
};

/**
 * Sits astride the cut, overlapping both neighbours — the same read as an NLE:
 * the hatched band *is* the region where the two plans coexist.
 */
export function TransitionBlock({
  resolved,
  pixelsPerSecond,
  selected,
  onSelect,
  onResize,
}: {
  resolved: ResolvedTransition;
  pixelsPerSecond: number;
  selected: boolean;
  onSelect(): void;
  onResize(event: React.PointerEvent): void;
}) {
  const openMenu = useTransitionMenu();
  const descriptor = transitionDescriptor(resolved.transition.kind);
  const Icon = ICON[resolved.transition.kind];
  const width = Math.max((resolved.end - resolved.start) * pixelsPerSecond, 10);
  const compact = width < 46;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      title={`${descriptor.label} · ${formatClock(resolved.end - resolved.start)} — glissez pour ajuster`}
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect();
        if (event.button === 0) onResize(event);
      }}
      onContextMenu={(event) => openMenu(event, resolved)}
      style={{ left: resolved.start * pixelsPerSecond, width }}
      className={cn(
        'group/tx absolute inset-y-1 z-10 cursor-ew-resize overflow-hidden rounded-md',
        'ring-1 backdrop-blur-[1px] transition-shadow duration-150',
        selected
          ? 'ring-2 ring-accent-200 shadow-[0_0_0_1px_rgba(13,15,18,.9),0_6px_18px_-6px_rgba(124,58,237,.85)]'
          : 'ring-accent-200/35',
      )}
    >
      {/* Hatch: reads as "overlap" rather than as a clip. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          backgroundImage:
            'repeating-linear-gradient(115deg, rgba(221,214,254,.30) 0 3px, rgba(13,15,18,.55) 3px 8px)',
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{ backgroundImage: descriptor.swatch, opacity: 0.5 }}
      />

      <div className="relative flex h-full items-center justify-center gap-1 px-1">
        <Icon size={11} strokeWidth={2.4} className="shrink-0 text-white drop-shadow" />
        {!compact && (
          <span className="num truncate text-[9px] font-medium leading-none text-white/90 drop-shadow">
            {formatClock(resolved.end - resolved.start)}
          </span>
        )}
      </div>

      {/* Grab hints on both edges. */}
      <span className="absolute inset-y-1 left-0.5 w-0.5 rounded-full bg-white/70 opacity-0 transition-opacity group-hover/tx:opacity-100" />
      <span className="absolute inset-y-1 right-0.5 w-0.5 rounded-full bg-white/70 opacity-0 transition-opacity group-hover/tx:opacity-100" />
    </div>
  );
}
