import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/cn';
import { useEditor } from '@/store/editorStore';

export interface MenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Shown with a check mark when true. */
  checked?: boolean;
  onSelect(): void;
}

export interface MenuSeparator {
  separator: true;
  /** Optional heading above the group. */
  label?: string;
}

export type MenuItem = MenuAction | MenuSeparator;

export const isSeparator = (item: MenuItem): item is MenuSeparator =>
  (item as MenuSeparator).separator === true;

const MARGIN = 8;

/**
 * The application's own right-click menu.
 *
 * One instance lives at the root and reads what to show from the store, so any
 * component can open a menu without mounting its own portal. The native menu is
 * suppressed everywhere except in editable fields, where the browser's own
 * copy/paste is genuinely more useful than anything we would write.
 */
export function ContextMenu() {
  const menu = useEditor((state) => state.contextMenu);
  const close = useEditor((state) => state.closeContextMenu);

  const panel = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  // Flip against the viewport edges *before* paint, or the menu would be seen
  // jumping into place.
  useLayoutEffect(() => {
    if (!menu) return;
    const node = panel.current;
    if (!node) return;

    const box = node.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - box.width - MARGIN);
    const y = Math.min(menu.y, window.innerHeight - box.height - MARGIN);
    setPosition({ x: Math.max(MARGIN, x), y: Math.max(MARGIN, y) });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) close();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', close);
    // A menu anchored to the page must not survive the page moving under it.
    window.addEventListener('resize', close);
    window.addEventListener('wheel', close, { passive: true });

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('wheel', close);
    };
  }, [menu, close]);

  if (!menu) return null;

  return createPortal(
    <div
      ref={panel}
      role="menu"
      style={{ left: position.x, top: position.y }}
      className={cn(
        'fixed z-[70] min-w-[204px] max-w-[280px] animate-scale-in overflow-hidden rounded-xl py-1',
        'border border-white/[0.09] bg-ink-800/95 shadow-lift backdrop-blur-2xl',
      )}
    >
      {menu.items.map((item, index) => {
        if (isSeparator(item)) {
          return (
            <div key={`sep-${index}`} className="py-1">
              {item.label ? (
                <span className="eyebrow block px-3 pb-1 pt-1">{item.label}</span>
              ) : (
                <span className="mx-2 block h-px bg-white/[0.07]" />
              )}
            </div>
          );
        }

        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              close();
              item.onSelect();
            }}
            className={cn(
              'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-2xs',
              'transition-colors duration-150',
              'disabled:pointer-events-none disabled:opacity-30',
              item.danger
                ? 'text-rose-200/85 hover:bg-rose-500/[0.14]'
                : 'text-white/75 hover:bg-white/[0.08] hover:text-white',
            )}
          >
            <span
              className={cn(
                'grid h-3.5 w-3.5 shrink-0 place-items-center',
                item.danger ? 'text-rose-300/70' : 'text-white/35',
              )}
            >
              {item.checked ? <Check /> : item.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.shortcut && (
              <span className="num shrink-0 text-[10px] text-white/25">{item.shortcut}</span>
            )}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

function Check() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 text-accent-300" aria-hidden>
      <path
        d="M2.5 6.4 4.8 8.7 9.5 3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
