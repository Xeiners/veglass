import { isTauri } from './env';
import { SCHEMA_VERSION, type ProjectSummary, type SerializedProject } from '@/types/project';
import type { Clip } from '@/types/timeline';
import { clipEnd } from '@/types/timeline';

export interface ProjectStorage {
  readonly backend: 'tauri' | 'browser';
  list(): Promise<ProjectSummary[]>;
  load(id: string): Promise<SerializedProject | null>;
  save(project: SerializedProject): Promise<void>;
  remove(id: string): Promise<void>;
  /** Human-readable location, shown in the dashboard footer. */
  location(): Promise<string>;
}

export function summarize(project: SerializedProject): ProjectSummary {
  const duration = project.clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0);
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    settings: project.settings,
    clipCount: project.clips.length,
    assetCount: project.assets.length,
    duration,
  };
}

/* ------------------------------------------------------------------ *
 * Browser backend — used by `npm run dev` outside the desktop shell.
 * ------------------------------------------------------------------ */

const PREFIX = 'veglass:project:';

const browserStorage: ProjectStorage = {
  backend: 'browser',

  async list() {
    const out: ProjectSummary[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(key) ?? '') as SerializedProject;
        out.push(summarize(parsed));
      } catch {
        /* skip corrupt entries rather than blocking the dashboard */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async load(id) {
    const raw = localStorage.getItem(PREFIX + id);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SerializedProject;
    } catch {
      return null;
    }
  },

  async save(project) {
    localStorage.setItem(PREFIX + project.id, JSON.stringify(project));
  },

  async remove(id) {
    localStorage.removeItem(PREFIX + id);
  },

  async location() {
    return 'Stockage local du navigateur';
  },
};

/* ------------------------------------------------------------------ *
 * Tauri backend — JSON files in the OS app-data directory.
 * ------------------------------------------------------------------ */

const tauriStorage: ProjectStorage = {
  backend: 'tauri',

  async list() {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<ProjectSummary[]>('list_projects');
  },

  async load(id) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<SerializedProject | null>('load_project', { id });
  },

  async save(project) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('save_project', { project });
  },

  async remove(id) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('delete_project', { id });
  },

  async location() {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('projects_dir');
  },
};

export const storage: ProjectStorage = isTauri() ? tauriStorage : browserStorage;

export function emptyProject(
  id: string,
  name: string,
  settings: SerializedProject['settings'],
  tracks: SerializedProject['tracks'],
): SerializedProject {
  const now = Date.now();
  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    settings,
    assets: [],
    tracks,
    clips: [],
    transitions: [],
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * Brings a document read from disk up to the current schema.
 *
 * Every version so far has only *added* fields, so filling defaults is the
 * whole migration — an older file is never wrong, merely incomplete.
 */
export function normalizeProject(project: SerializedProject): SerializedProject {
  return {
    ...project,
    assets: project.assets ?? [],
    tracks: (project.tracks ?? []).map((track) => ({ ...track, solo: track.solo ?? false })),
    transitions: project.transitions ?? [],
    // `markers` needs no line of its own: it rides along in the spread above,
    // and a document saved before version 8 simply has none. `markersOf` reads
    // an absent field and an empty array identically, so there is nothing to
    // fill in — filling it would only grow a field on projects nobody has put
    // a marker on.
    clips: (project.clips ?? []).map(
      (clip): Clip => ({
        ...clip,
        effects: clip.effects ?? [],
        kind: clip.kind ?? 'media',
        assetId: clip.assetId ?? null,
        x: clip.x ?? 0,
        y: clip.y ?? 0,
        rotation: clip.rotation ?? 0,
      }),
    ),
    schemaVersion: SCHEMA_VERSION,
  };
}
