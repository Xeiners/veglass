import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface Size {
  width: number;
  height: number;
}

/** Observed box of an element — the timeline needs it to lay out the ruler. */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  const measure = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setSize((prev) =>
      prev.width === rect.width && prev.height === rect.height
        ? prev
        : { width: rect.width, height: rect.height },
    );
  }, []);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  return { ref, size } as const;
}
