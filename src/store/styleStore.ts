/**
 * Brand kits, kept across sessions.
 *
 * Application-wide rather than per-project: a kit is someone's channel look,
 * and having to rebuild it in every new project is exactly the friction the
 * feature exists to remove. That also keeps it out of the document, and so out
 * of the undo history — editing a kit is not a montage edit, and undoing a cut
 * must not silently repaint the captions.
 *
 * The built-ins are not stored. They are merged in at read time, so a later
 * version of the app can improve them, and a stored copy of one from an old
 * version can never shadow the improvement.
 */

import { create } from 'zustand';

import { uid } from '@/lib/id';
import {
  BUILT_IN_KITS,
  DEFAULT_KIT_ID,
  cloneKit,
  findKit,
  type StyleKit,
} from '@/types/styleKit';

const STORAGE_KEY = 'veglass:style-kits';
const VERSION = 1;

interface Stored {
  version: number;
  /** Only the user's own kits — see the module note. */
  custom: StyleKit[];
  selectedId: string;
}

function read(): { custom: StyleKit[]; selectedId: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { custom: [], selectedId: DEFAULT_KIT_ID };

    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (parsed.version !== VERSION) return { custom: [], selectedId: DEFAULT_KIT_ID };

    // A stored kit claiming to be built-in would become uneditable and
    // undeletable; the flag is ours to set, not the file's.
    const custom = Array.isArray(parsed.custom)
      ? parsed.custom
          .filter((kit): kit is StyleKit => Boolean(kit && typeof kit.id === 'string'))
          .map((kit) => ({ ...kit, builtIn: false }))
      : [];

    return {
      custom,
      selectedId: typeof parsed.selectedId === 'string' ? parsed.selectedId : DEFAULT_KIT_ID,
    };
  } catch {
    return { custom: [], selectedId: DEFAULT_KIT_ID };
  }
}

function write(custom: StyleKit[], selectedId: string): void {
  try {
    const payload: Stored = { version: VERSION, custom, selectedId };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* storage unavailable — the kits stay for this session only */
  }
}

interface StyleState {
  /** Built-ins first, then the user's own. */
  kits: StyleKit[];
  selectedId: string;

  selected(): StyleKit;
  select(id: string): void;
  /** Copies a kit — the only way to get an editable one from a built-in. */
  duplicate(id: string): string;
  update(id: string, patch: (kit: StyleKit) => StyleKit): void;
  rename(id: string, name: string): void;
  remove(id: string): void;
}

/** Ensures a copy's name reads as one rather than colliding. */
function copyName(name: string, taken: string[]): string {
  const base = `${name} (copie)`;
  if (!taken.includes(base)) return base;
  for (let index = 2; index < 200; index += 1) {
    const candidate = `${name} (copie ${index})`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

export const useStyleKits = create<StyleState>((set, get) => {
  const initial = read();

  const persist = (kits: StyleKit[], selectedId: string) => {
    write(
      kits.filter((kit) => !kit.builtIn),
      selectedId,
    );
  };

  return {
    kits: [...BUILT_IN_KITS, ...initial.custom],
    selectedId: initial.selectedId,

    selected() {
      return findKit(get().kits, get().selectedId);
    },

    select(id) {
      set({ selectedId: id });
      persist(get().kits, id);
    },

    duplicate(id) {
      const source = findKit(get().kits, id);
      const copy = cloneKit(
        source,
        uid('kit'),
        copyName(source.name, get().kits.map((kit) => kit.name)),
      );

      const kits = [...get().kits, copy];
      set({ kits, selectedId: copy.id });
      persist(kits, copy.id);
      return copy.id;
    },

    update(id, patch) {
      const kits = get().kits.map((kit) => {
        // A built-in is the reference the copies come from; editing one in
        // place would leave no way back to it.
        if (kit.id !== id || kit.builtIn) return kit;
        return { ...patch(kit), id: kit.id, builtIn: false };
      });
      set({ kits });
      persist(kits, get().selectedId);
    },

    rename(id, name) {
      get().update(id, (kit) => ({ ...kit, name: name.trim() || kit.name }));
    },

    remove(id) {
      const target = get().kits.find((kit) => kit.id === id);
      if (!target || target.builtIn) return;

      const kits = get().kits.filter((kit) => kit.id !== id);
      const selectedId = get().selectedId === id ? DEFAULT_KIT_ID : get().selectedId;
      set({ kits, selectedId });
      persist(kits, selectedId);
    },
  };
});
