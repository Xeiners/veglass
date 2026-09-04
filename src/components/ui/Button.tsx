import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-accent-500 text-white shadow-glow hover:bg-accent-400 active:bg-accent-600 font-semibold',
  secondary:
    'border border-white/[0.08] bg-white/[0.04] text-white/85 hover:bg-white/[0.075] hover:border-white/[0.13] active:bg-white/[0.05]',
  ghost: 'text-white/55 hover:text-white hover:bg-white/[0.06] active:bg-white/[0.03]',
  danger:
    'border border-red-500/25 bg-red-500/10 text-red-300 hover:bg-red-500/[0.18] hover:border-red-500/40',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 gap-1.5 rounded-lg px-3 text-2xs',
  md: 'h-10 gap-2 rounded-xl px-4 text-[13px]',
  lg: 'h-11 gap-2 rounded-xl px-5 text-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  trailing?: ReactNode;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, trailing, block, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap font-medium',
        'transition-all duration-200 ease-smooth',
        'disabled:pointer-events-none disabled:opacity-40',
        'active:scale-[0.985]',
        VARIANTS[variant],
        SIZES[size],
        block && 'w-full',
        className,
      )}
      {...props}
    >
      {icon}
      {children}
      {trailing}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  tone?: 'default' | 'danger';
}

/** Square, icon-only control used across the toolbars and track heads. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, tone = 'default', className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
        'transition-all duration-200 ease-smooth active:scale-95',
        active
          ? 'bg-accent-500/[0.14] text-accent-300 shadow-[inset_0_0_0_1px_rgba(124,58,237,.32)]'
          : tone === 'danger'
            ? 'text-white/45 hover:bg-red-500/12 hover:text-red-300'
            : 'text-white/45 hover:bg-white/[0.07] hover:text-white/90',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});
