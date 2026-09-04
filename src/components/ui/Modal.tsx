import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import { cn } from '@/lib/cn';

export interface ModalProps {
  open: boolean;
  onClose(): void;
  title: string;
  description?: string;
  footer?: ReactNode;
  children: ReactNode;
  width?: 'sm' | 'md' | 'lg';
}

const WIDTHS = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' } as const;

export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  children,
  width = 'md',
}: ModalProps) {
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);

    // Move focus into the dialog so the first field is immediately typable.
    const first = panel.current?.querySelector<HTMLElement>(
      'input, select, textarea, button:not([data-close])',
    );
    first?.focus();

    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = overflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div
        className="absolute inset-0 animate-fade-in bg-ink-950/70 backdrop-blur-md"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'relative w-full animate-scale-in overflow-hidden rounded-2xl',
          'border border-white/[0.08] bg-ink-850/95 shadow-lift backdrop-blur-2xl',
          WIDTHS[width],
        )}
      >
        {/* Top light: a single hairline gradient that reads as a lit edge. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />

        <header className="flex items-start justify-between gap-6 px-7 pb-5 pt-6">
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold tracking-tightest text-white">{title}</h2>
            {description && (
              <p className="mt-1.5 text-[13px] leading-relaxed text-white/45">{description}</p>
            )}
          </div>
          <button
            type="button"
            data-close
            onClick={onClose}
            aria-label="Fermer"
            className="-mr-1.5 -mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/80"
          >
            <X size={15} strokeWidth={2} />
          </button>
        </header>

        <div className="max-h-[62vh] overflow-y-auto px-7 pb-2">{children}</div>

        {footer && (
          <footer className="mt-5 flex items-center justify-end gap-2.5 border-t border-white/[0.06] bg-white/[0.015] px-7 py-4">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
