import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

import { cn } from '@/lib/cn';

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-2 flex items-baseline justify-between gap-3">
        <span className="eyebrow">{label}</span>
        {hint && <span className="text-2xs text-white/30">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-11 w-full rounded-xl border border-white/[0.08] bg-ink-900/60 px-3.5',
          'text-[14px] text-white placeholder:text-white/25',
          'transition-all duration-200 ease-smooth',
          'hover:border-white/[0.13]',
          'focus:border-accent-500/50 focus:bg-ink-900/90 focus:outline-none focus:ring-0',
          'focus:shadow-[0_0_0_3px_rgba(124,58,237,.18)]',
          className,
        )}
        {...props}
      />
    );
  },
);

export interface OptionCardProps {
  active: boolean;
  onSelect(): void;
  title: string;
  subtitle?: string;
  aside?: ReactNode;
}

/** Selectable tile — used for resolution and framerate choices. */
export function OptionCard({ active, onSelect, title, subtitle, aside }: OptionCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'group relative flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left',
        'transition-all duration-200 ease-smooth active:scale-[0.99]',
        active
          ? 'border-accent-500/45 bg-accent-500/[0.09] shadow-[inset_0_0_0_1px_rgba(124,58,237,.22)]'
          : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.14] hover:bg-white/[0.045]',
      )}
    >
      {aside}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-[13px] font-medium transition-colors',
            active ? 'text-white' : 'text-white/80',
          )}
        >
          {title}
        </span>
        {subtitle && (
          <span className="mt-0.5 block truncate text-2xs num text-white/35">{subtitle}</span>
        )}
      </span>
      <span
        className={cn(
          'grid h-4 w-4 shrink-0 place-items-center rounded-full border transition-all duration-200',
          active ? 'border-accent-400 bg-accent-500' : 'border-white/15 group-hover:border-white/30',
        )}
      >
        {active && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
      </span>
    </button>
  );
}
