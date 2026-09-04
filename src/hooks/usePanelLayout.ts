import { useCallback, useEffect, useState } from 'react';

import { clamp } from '@/lib/time';

export type PanelKey = 'left' | 'right' | 'animation' | 'timeline';

export interface PanelLayout {
  left: number;
  right: number;
  animation: number;
  timeline: number;
}

const STORAGE_KEY = 'veglass:layout';

export const DEFAULT_LAYOUT: PanelLayout = {
  left: 276,
  right: 284,
  animation: 296,
  timeline: 272,
};

export const PANEL_BOUNDS: Record<PanelKey, { min: number; max: number }> = {
  left: { min: 224, max: 480 },
  right: { min: 240, max: 500 },
  animation: { min: 248, max: 460 },
  timeline: { min: 180, max: 640 },
};

/** The viewer never gives up more than this, whatever the panels ask for. */
export const MIN_VIEWER = 340;

export const clampPanel = (key: PanelKey, value: number): number =>
  clamp(value, PANEL_BOUNDS[key].min, PANEL_BOUNDS[key].max);

function read(): PanelLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<PanelLayout>;
    return {
      left: clampPanel('left', parsed.left ?? DEFAULT_LAYOUT.left),
      right: clampPanel('right', parsed.right ?? DEFAULT_LAYOUT.right),
      animation: clampPanel('animation', parsed.animation ?? DEFAULT_LAYOUT.animation),
      timeline: clampPanel('timeline', parsed.timeline ?? DEFAULT_LAYOUT.timeline),
    };
  } catch {
    // A private window or cleared storage simply starts from the defaults.
    return DEFAULT_LAYOUT;
  }
}

/**
 * Panel sizes, remembered per machine.
 *
 * This is a workspace preference rather than project data, so it lives in
 * browser storage next to the app instead of inside the project file — moving a
 * `.veglass.json` between machines must not carry someone else's layout.
 */
export function usePanelLayout() {
  const [layout, setLayout] = useState<PanelLayout>(read);

  const setPanel = useCallback((key: PanelKey, value: number) => {
    setLayout((prev) => {
      const next = clampPanel(key, value);
      return prev[key] === next ? prev : { ...prev, [key]: next };
    });
  }, []);

  const resetPanel = useCallback((key: PanelKey) => {
    setLayout((prev) => ({ ...prev, [key]: DEFAULT_LAYOUT[key] }));
  }, []);

  // Debounced so a drag writes once, not sixty times a second.
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
      } catch {
        /* storage unavailable — the layout simply stays session-local */
      }
    }, 250);
    return () => clearTimeout(id);
  }, [layout]);

  return { layout, setPanel, resetPanel };
}
