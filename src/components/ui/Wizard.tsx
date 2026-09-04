import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';

import { cn } from '@/lib/cn';

/**
 * The furniture every wizard step shares.
 *
 * Lifted here when the tutorial generator arrived and needed the same three
 * pieces the viral one already had. Two copies of a toggle is how two features
 * that look alike start drifting apart — and these are pure presentation, with
 * no idea which wizard they are standing in.
 */

export function Footer({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <footer className="flex shrink-0 items-center gap-3 border-t border-white/[0.06] px-5 py-3.5">
      {left}
      <div className="ml-auto flex items-center gap-2">{right}</div>
    </footer>
  );
}

export function Warning({
  children,
  tone = 'warn',
}: {
  children: ReactNode;
  tone?: 'warn' | 'soft';
}) {
  return (
    <p
      className={cn(
        'mt-4 flex gap-1.5 rounded-xl border px-3.5 py-3 text-2xs leading-relaxed',
        tone === 'warn'
          ? 'border-amber-500/25 bg-amber-500/[0.06] text-amber-100/80'
          : 'border-white/[0.07] bg-white/[0.022] text-white/40',
      )}
    >
      <TriangleAlert size={12} strokeWidth={2.2} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function Toggle({
  checked,
  onChange,
  title,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange(value: boolean): void;
  title: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-all duration-200',
        disabled && 'cursor-not-allowed opacity-45',
        checked
          ? 'border-accent-500/45 bg-accent-500/[0.09]'
          : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.14]',
      )}
    >
      <span
        className={cn(
          'relative h-[18px] w-8 shrink-0 rounded-full transition-colors',
          checked ? 'bg-accent-500' : 'bg-white/[0.14]',
        )}
      >
        <span
          className={cn(
            'absolute top-[3px] h-3 w-3 rounded-full bg-white transition-[left] duration-200 ease-smooth',
            checked ? 'left-[17px]' : 'left-[3px]',
          )}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-white/85">{title}</span>
        <span className="mt-0.5 block text-2xs leading-relaxed text-white/35">{hint}</span>
      </span>
    </button>
  );
}
