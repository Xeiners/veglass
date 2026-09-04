import { cn } from '@/lib/cn';

/**
 * The mark: a glass pane crossed by a cut line, with the play triangle carved
 * out of it. Drawn as SVG so it stays crisp at every size.
 */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn(
        'relative grid shrink-0 place-items-center rounded-[10px]',
        'bg-gradient-to-br from-accent-300 via-accent-500 to-accent-700',
        'shadow-[0_6px_20px_-6px_rgba(124,58,237,.6)]',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <span className="pointer-events-none absolute inset-0 rounded-[10px] bg-gradient-to-b from-white/30 to-transparent opacity-60" />
      <svg
        viewBox="0 0 24 24"
        width={size * 0.62}
        height={size * 0.62}
        fill="none"
        className="relative text-white"
        aria-hidden
      >
        <path
          d="M9.2 6.6 17.4 11.3a.8.8 0 0 1 0 1.4L9.2 17.4a.8.8 0 0 1-1.2-.7V7.3a.8.8 0 0 1 1.2-.7Z"
          fill="currentColor"
          opacity={0.92}
        />
        <path d="M3.6 4.2 20.4 19.8" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" opacity={0.35} />
      </svg>
    </span>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('text-[15px] font-semibold tracking-tightest text-white', className)}>
      Veglass
    </span>
  );
}
