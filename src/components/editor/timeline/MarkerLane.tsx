import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/cn';
import { formatClock } from '@/lib/time';
import { useEditor } from '@/store/editorStore';
import { markersOf } from '@/types/marker';

/**
 * Chapter flags, drawn over the ruler.
 *
 * Its own component rather than more lines inside `Ruler` for one reason: the
 * ruler re-renders on every zoom and every scroll of a long timeline, and it
 * computes its ticks in a `useMemo` keyed on all of that. Markers change on
 * none of it, and folding them in would put a list lookup and an editable field
 * inside the hottest render in the editor.
 *
 * A click seeks. A double-click renames in place — auto-generated chapter names
 * are usually right and occasionally one word off, and opening a dialog to fix
 * one word is more ceremony than the fix deserves.
 */
export function MarkerLane({
  pixelsPerSecond,
  from,
  to,
}: {
  pixelsPerSecond: number;
  /** Visible window, in seconds — flags outside it are never mounted. */
  from: number;
  to: number;
}) {
  const markers = useEditor((state) => markersOf(state.project));
  const setPlayhead = useEditor((state) => state.setPlayhead);
  const rename = useEditor((state) => state.renameMarker);
  const remove = useEditor((state) => state.removeMarker);
  const clear = useEditor((state) => state.clearMarkers);
  const openMenu = useEditor((state) => state.openContextMenu);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const field = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);

  if (markers.length === 0) return null;

  const commit = () => {
    if (editing) rename(editing, draft);
    setEditing(null);
  };

  return (
    <>
      {markers
        .filter((marker) => marker.time >= from - 4 && marker.time <= to + 4)
        .map((marker) => {
          const left = Math.round(marker.time * pixelsPerSecond);

          return (
            <div
              key={marker.id}
              className="group absolute top-0 z-10 flex items-start"
              style={{ left }}
            >
              {/* The stem sits exactly on the instant; the label hangs to its right. */}
              <span
                aria-hidden
                className="absolute left-0 top-0 h-full w-px"
                style={{ background: marker.color, opacity: 0.55 }}
              />

              {editing === marker.id ? (
                <input
                  ref={field}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={commit}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') commit();
                    if (event.key === 'Escape') setEditing(null);
                  }}
                  className="ml-1 h-[15px] w-28 rounded-sm border border-white/25 bg-ink-950 px-1 text-[10px] text-white outline-none"
                />
              ) : (
                <button
                  type="button"
                  title={`${marker.label} — ${formatClock(marker.time)}${
                    marker.note ? `\n\n${marker.note}` : ''
                  }`}
                  onClick={() => setPlayhead(marker.time)}
                  onDoubleClick={() => {
                    setDraft(marker.label);
                    setEditing(marker.id);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openMenu(event.clientX, event.clientY, [
                      {
                        id: 'rename',
                        label: 'Renommer',
                        onSelect: () => {
                          setDraft(marker.label);
                          setEditing(marker.id);
                        },
                      },
                      {
                        id: 'seek',
                        label: 'Aller à ce repère',
                        onSelect: () => setPlayhead(marker.time),
                      },
                      { separator: true },
                      {
                        id: 'remove',
                        label: 'Supprimer ce repère',
                        danger: true,
                        onSelect: () => remove(marker.id),
                      },
                      {
                        id: 'clear',
                        label: 'Supprimer tous les repères',
                        danger: true,
                        onSelect: clear,
                      },
                    ]);
                  }}
                  className={cn(
                    'ml-px max-w-[140px] truncate rounded-r-sm py-px pl-1 pr-1.5',
                    'text-[10px] leading-[14px] text-ink-950 transition-opacity',
                    'opacity-80 hover:opacity-100',
                  )}
                  style={{ background: marker.color }}
                >
                  {marker.label}
                </button>
              )}
            </div>
          );
        })}
    </>
  );
}
