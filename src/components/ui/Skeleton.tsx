import { cn } from '@/lib/cn';

/**
 * Placeholders shown while something is being fetched.
 *
 * A skeleton earns its place over a spinner by being *structural*: it occupies
 * the shape the real content will take, so the layout does not jump when the
 * answer arrives and the eye already knows where to look. A spinner in the
 * middle of an empty panel says only "wait"; a grid of tile-shaped blocks says
 * "tiles are coming, about this many, about this size".
 *
 * The shimmer itself is a single definition here rather than a class repeated
 * at each call site — it was already written twice before this existed.
 */

/**
 * The travelling highlight. Absolutely positioned, so its parent needs
 * `relative overflow-hidden`.
 */
export function Shimmer() {
  return (
    <span
      aria-hidden
      className={cn(
        'absolute inset-0 -translate-x-full animate-shimmer',
        'bg-gradient-to-r from-transparent via-white/[0.045] to-transparent',
        // A moving gradient is exactly what someone who asked for less motion
        // asked to be spared; the block stays, the travel stops.
        'motion-reduce:animate-none',
      )}
    />
  );
}

/**
 * One shimmering block.
 *
 * `rounded` is left to the caller on purpose: a skeleton that does not share the
 * corner radius of the thing it stands in for announces itself as a placeholder,
 * which is the one job it does not have.
 */
export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'relative block overflow-hidden bg-white/[0.028]',
        className,
      )}
    >
      <Shimmer />
    </span>
  );
}

/**
 * A line of placeholder text.
 *
 * Sized in `em` against the surrounding type, so a skeleton line in a caption
 * is a caption's height without anyone having to say so twice.
 */
export function SkeletonLine({ className }: { className?: string }) {
  return <SkeletonBlock className={cn('h-[0.7em] rounded-[2px]', className)} />;
}
