type ClassValue = string | false | null | undefined;

/** Tiny classnames joiner — no dependency, no clsx/tailwind-merge overhead. */
export const cn = (...values: ClassValue[]): string =>
  values.filter(Boolean).join(' ');
