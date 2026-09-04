/**
 * Whether a newer Veglass exists, and what the user decided about it.
 *
 * Session state, like the download and viral stores: nothing here belongs to a
 * project, and nothing here goes through the undo history.
 *
 * The one piece that outlives the session is a dismissal. Someone who says "not
 * now" to 0.2.0 means it for 0.2.0, not for the next thirty launches — so the
 * declined version is remembered, and 0.2.1 asks again. Being asked the same
 * question every morning is how people learn to click past dialogs without
 * reading them.
 */

import { create } from 'zustand';

import { checkForUpdate, installUpdate, type Available } from '@/lib/updater';

const DISMISSED_KEY = 'veglass:update-dismissed';

/**
 * How long after launch the check runs.
 *
 * Long enough to be out of the way of the things the user actually opened the
 * app for — the project list, the last montage, an ffmpeg probe — and short
 * enough that they are still at the machine when it asks.
 */
const STARTUP_DELAY_MS = 6_000;

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(version: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    /* storage unavailable — they will simply be asked again next launch */
  }
}

export type UpdateStage = 'idle' | 'available' | 'installing' | 'failed';

interface UpdateState {
  stage: UpdateStage;
  update: Available | null;
  /** 0 → 1 during the download; stays 0 while the length is unknown. */
  progress: number;
  received: number;
  total: number;
  error: string | null;

  /** Runs the delayed startup check. Safe to call more than once. */
  boot(): void;
  /** Downloads, installs and relaunches. */
  install(): Promise<void>;
  /** "Not now" — remembered for this version only. */
  dismiss(): void;
}

export const useUpdates = create<UpdateState>((set, get) => {
  let booted = false;

  return {
    stage: 'idle',
    update: null,
    progress: 0,
    received: 0,
    total: 0,
    error: null,

    boot() {
      if (booted) return;
      booted = true;

      window.setTimeout(() => {
        void checkForUpdate().then((update) => {
          if (!update) return;
          // Asked once per version. A newer one is a new question.
          if (readDismissed() === update.version) return;
          set({ stage: 'available', update, error: null });
        });
      }, STARTUP_DELAY_MS);
    },

    async install() {
      const update = get().update;
      if (!update || get().stage === 'installing') return;

      set({ stage: 'installing', progress: 0, received: 0, total: 0, error: null });

      try {
        await installUpdate(update.handle, (received, total) => {
          set({
            received,
            total,
            progress: total > 0 ? Math.min(1, received / total) : 0,
          });
        });
        // Unreachable in practice: the relaunch replaces this process.
      } catch (error) {
        set({
          stage: 'failed',
          error:
            error instanceof Error
              ? error.message
              : "L'installation de la mise à jour a échoué.",
        });
      }
    },

    dismiss() {
      const update = get().update;
      if (update) writeDismissed(update.version);
      set({ stage: 'idle', update: null, error: null });
    },
  };
});
