/**
 * From a model's answer to a document edit.
 *
 * This is the load-bearing half of the assistant, and the reason the whole
 * suite is shaped the way it is. Every action here is a pure
 * `Project → Project` function, so a plan of fourteen edits folds into **one**
 * write: one history entry, one undo press, one save. Going through the store's
 * public methods instead would have produced fourteen of each.
 *
 * It is also the trust boundary. Nothing that arrives from the model is assumed
 * to be well-formed, in range, or to refer to something that exists —
 * `normalizePlan` rebuilds each action from scratch, and every handler either
 * resolves its references or rejects, with a reason the panel shows. A plan is
 * allowed to be partially applied: eleven good edits are worth having, and the
 * three that were dropped are listed rather than swallowed.
 */

import { uid } from '@/lib/id';
import { clamp, snapToFrame } from '@/lib/time';
import { placeOnFreeLayer, resolveStart } from '@/store/editorStore';
import { transitionAnchors } from '@/store/selectors';
import { entranceAnimation } from './motion';
import { DEFAULT_SPLIT_OPTIONS, splitTextClips } from '@/lib/textSplit';
import { placeBackground } from '@/lib/backgroundLayer';
import {
  BACKGROUNDS,
  BACKGROUND_RANGES,
  backgroundDescriptor,
  type BackgroundKind,
  type BackgroundLayer,
} from '@/types/background';
import type { Project } from '@/types/project';
import {
  DEFAULT_TRACK_HEIGHT,
  MIN_CLIP_DURATION,
  defaultTrackAudio,
  type Clip,
  type Track,
  type TrackKind,
} from '@/types/timeline';
import { STILL_DEFAULT_DURATION, type MediaAsset } from '@/types/media';
import {
  DEFAULT_TEXT_DURATION,
  FONTS,
  defaultTextLayer,
  type TextAlign,
  type TextLayer,
} from '@/types/text';
import { EFFECTS, effectDescriptor, initialParams, type EffectKind } from '@/types/effects';
import {
  DEFAULT_TRANSITION_DURATION,
  MIN_TRANSITION_DURATION,
  TRANSITIONS,
  isJunction,
  transitionDescriptor,
  type Transition,
  type TransitionKind,
} from '@/types/transitions';
import {
  CLIP_CHANNELS,
  parseBackgroundChannel,
  sortKeyframes,
  type AnimationMap,
  type ClipChannel,
  type Easing,
  type EasingKind,
  type Keyframe,
} from '@/types/animation';
import type {
  AiAction,
  AiPlan,
  AnimatableChannel,
  PlanKeyframe,
  Reference,
  SubtitleAnimation,
  TextStyleSpec,
} from '@/types/ai';

const ANIMATIONS = new Set<SubtitleAnimation>(['none', 'fade', 'pop', 'rise', 'punch']);

const animationOf = (value: unknown): SubtitleAnimation | undefined => {
  const name = typeof value === 'string' ? value.trim() : '';
  return ANIMATIONS.has(name as SubtitleAnimation) ? (name as SubtitleAnimation) : undefined;
};

/* ------------------------------------------------------------------ *
 * Parsing what came back
 * ------------------------------------------------------------------ */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A finite number, or nothing — `NaN`, `Infinity` and `"12"` all fail. */
function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Models occasionally quote a number when the schema says NUMBER.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

const ACTION_KINDS = new Set<AiAction['kind']>([
  'addTrack',
  'addBackground',
  'setBackground',
  'addText',
  'addClip',
  'moveClip',
  'trimClip',
  'removeClip',
  'renameClip',
  'setClip',
  'updateText',
  'splitText',
  'setEntrance',
  'animate',
  'addEffect',
  'addTransition',
]);

const EASING_KINDS = new Set<EasingKind>([
  'linear',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'hold',
  'bezier',
]);

const ALIGNMENTS = new Set<TextAlign>(['left', 'center', 'right']);
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const BACKGROUND_KINDS = new Set<BackgroundKind>(BACKGROUNDS.map((item) => item.kind));

const backgroundKindOf = (value: unknown): BackgroundKind | undefined => {
  const name = typeof value === 'string' ? value.trim() : '';
  return BACKGROUND_KINDS.has(name as BackgroundKind) ? (name as BackgroundKind) : undefined;
};

const hexOf = (value: unknown): string | undefined => {
  const raw = str(value);
  return raw && HEX.test(raw) ? raw.toUpperCase() : undefined;
};

/**
 * The tuning shared by both background actions, read once.
 *
 * `kind` and `seed` are excluded from the type on purpose: a `BackgroundLayer`
 * has a `kind` of its own, and spreading this over an action would quietly
 * overwrite the action's own discriminant with a preset name.
 */
type BackgroundLook = Omit<Partial<BackgroundLayer>, 'kind' | 'seed'>;

/**
 * Holds a look to its ranges.
 *
 * The parser clamps too, and this is not redundant: every other handler in this
 * file guards its own inputs, and a caller that composes actions by hand —
 * `expandSelection`, a future macro — must not be able to slip a speed of 99
 * into the document.
 */
function boundedLook(look: BackgroundLook): BackgroundLook {
  const limit = (key: 'speed' | 'scale' | 'intensity') => {
    const value = look[key];
    if (value === undefined) return {};
    const range = BACKGROUND_RANGES[key];
    return { [key]: clamp(value, range.min, range.max) };
  };
  return {
    ...look,
    ...limit('speed'),
    ...limit('scale'),
    ...limit('intensity'),
    ...(look.colors ? { colors: look.colors.slice(0, 5) } : {}),
  };
}

function backgroundLook(raw: Record<string, unknown>): BackgroundLook {
  const colors = Array.isArray(raw.colors)
    ? raw.colors.map(hexOf).filter((color): color is string => color !== undefined)
    : [];
  const bounded = (key: 'speed' | 'scale' | 'intensity') => {
    const value = num(raw[key]);
    if (value === undefined) return {};
    const range = BACKGROUND_RANGES[key];
    return { [key]: clamp(value, range.min, range.max) };
  };

  return {
    ...(hexOf(raw.base) ? { base: hexOf(raw.base) as string } : {}),
    ...(colors.length >= 2 ? { colors: colors.slice(0, 5) } : {}),
    ...bounded('speed'),
    ...bounded('scale'),
    ...bounded('intensity'),
  };
}

function styleSpec(value: unknown): TextStyleSpec | undefined {
  if (!isRecord(value)) return undefined;
  const family = str(value.fontFamily);
  const align = str(value.align);
  const color = str(value.color);

  const spec: TextStyleSpec = {
    ...(family && FONTS.some((font) => font.id === family) ? { fontFamily: family } : {}),
    ...(num(value.fontSize) !== undefined ? { fontSize: num(value.fontSize) } : {}),
    ...(num(value.fontWeight) !== undefined ? { fontWeight: num(value.fontWeight) } : {}),
    ...(color && HEX.test(color) ? { color } : {}),
    ...(align && ALIGNMENTS.has(align as TextAlign) ? { align: align as TextAlign } : {}),
    ...(bool(value.italic) !== undefined ? { italic: bool(value.italic) } : {}),
    ...(num(value.x) !== undefined ? { x: num(value.x) } : {}),
    ...(num(value.y) !== undefined ? { y: num(value.y) } : {}),
  };
  return Object.keys(spec).length > 0 ? spec : undefined;
}

function keyframeSpecs(value: unknown): PlanKeyframe[] {
  if (!Array.isArray(value)) return [];
  const out: PlanKeyframe[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const time = num(entry.time);
    const magnitude = num(entry.value);
    if (time === undefined || magnitude === undefined) continue;
    const easing = str(entry.easing);
    out.push({
      time,
      value: magnitude,
      ...(easing && EASING_KINDS.has(easing as EasingKind)
        ? { easing: easing as EasingKind }
        : {}),
    });
  }
  return out;
}

/**
 * Rebuilds one action from untyped JSON.
 *
 * Fields are read per kind rather than spread wholesale, so a stray property
 * cannot reach the document and a missing one is caught here instead of
 * surfacing as `undefined` three layers down.
 */
function normalizeAction(raw: unknown): AiAction | null {
  if (!isRecord(raw)) return null;
  const kind = str(raw.kind) as AiAction['kind'] | undefined;
  if (!kind || !ACTION_KINDS.has(kind)) return null;

  const clip = str(raw.clip);
  const track = str(raw.track);
  const start = num(raw.start);
  const duration = num(raw.duration);

  switch (kind) {
    case 'addTrack': {
      const trackKind = str(raw.trackKind);
      return {
        kind,
        trackKind: trackKind === 'audio' ? 'audio' : 'video',
        ...(str(raw.name) ? { name: str(raw.name) as string } : {}),
      };
    }
    case 'addBackground': {
      const background = backgroundKindOf(raw.background);
      if (!background) return null;
      return {
        kind,
        background,
        ...(start !== undefined ? { start } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...backgroundLook(raw),
      };
    }
    case 'setBackground': {
      if (!clip) return null;
      const background = backgroundKindOf(raw.background);
      const look = backgroundLook(raw);
      if (!background && Object.keys(look).length === 0) return null;
      return { kind, clip, ...(background ? { background } : {}), ...look };
    }
    case 'addText': {
      const content = typeof raw.content === 'string' ? raw.content : undefined;
      if (!content?.trim()) return null;
      return {
        kind,
        content,
        start: start ?? 0,
        duration: duration ?? DEFAULT_TEXT_DURATION,
        ...(track ? { track } : {}),
        ...(styleSpec(raw.style) ? { style: styleSpec(raw.style) as TextStyleSpec } : {}),
        ...(bool(raw.animate) !== undefined ? { animate: bool(raw.animate) as boolean } : {}),
        ...(animationOf(raw.animation) ? { animation: animationOf(raw.animation) } : {}),
        ...(str(raw.label) ? { label: str(raw.label) as string } : {}),
      };
    }
    case 'addClip': {
      const asset = str(raw.asset);
      if (!asset || start === undefined) return null;
      return {
        kind,
        asset,
        start,
        ...(duration !== undefined ? { duration } : {}),
        ...(num(raw.offset) !== undefined ? { offset: num(raw.offset) as number } : {}),
        ...(track ? { track } : {}),
      };
    }
    case 'moveClip':
      if (!clip || start === undefined) return null;
      return { kind, clip, start, ...(track ? { track } : {}) };
    case 'trimClip':
      if (!clip) return null;
      return {
        kind,
        clip,
        ...(start !== undefined ? { start } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(num(raw.offset) !== undefined ? { offset: num(raw.offset) as number } : {}),
      };
    case 'removeClip':
      return clip ? { kind, clip } : null;
    case 'renameClip': {
      const label = str(raw.label);
      return clip && label ? { kind, clip, label } : null;
    }
    case 'setClip': {
      if (!clip) return null;
      const numeric = (['opacity', 'scale', 'x', 'y', 'rotation', 'volume'] as const).reduce<
        Record<string, number>
      >((acc, field) => {
        const value = num(raw[field]);
        if (value !== undefined) acc[field] = value;
        return acc;
      }, {});
      const muted = bool(raw.muted);
      if (Object.keys(numeric).length === 0 && muted === undefined) return null;
      return { kind, clip, ...numeric, ...(muted !== undefined ? { muted } : {}) };
    }
    case 'splitText': {
      if (!clip) return null;
      const unit = str(raw.unit);
      const animation = animationOf(raw.animation);
      return {
        kind,
        clip,
        ...(unit === 'line' || unit === 'word' ? { unit } : {}),
        ...(animation ? { animation } : {}),
      };
    }
    case 'updateText': {
      if (!clip) return null;
      const content = typeof raw.content === 'string' ? raw.content : undefined;
      const style = styleSpec(raw.style);
      if (content === undefined && !style) return null;
      return { kind, clip, ...(content !== undefined ? { content } : {}), ...(style ? { style } : {}) };
    }
    case 'setEntrance': {
      const animation = animationOf(raw.animation);
      if (!clip || !animation) return null;
      return {
        kind,
        clip,
        animation,
        ...(duration !== undefined ? { duration } : {}),
      };
    }
    case 'animate': {
      const channel = str(raw.channel);
      const known =
        channel !== undefined &&
        ((CLIP_CHANNELS as readonly string[]).includes(channel) ||
          parseBackgroundChannel(channel) !== null);
      if (!clip || !known) return null;
      return { kind, clip, channel: channel as AnimatableChannel, keyframes: keyframeSpecs(raw.keyframes) };
    }
    case 'addEffect': {
      const effect = str(raw.effect) as EffectKind | undefined;
      if (!clip || !effect || !EFFECTS.some((item) => item.kind === effect)) return null;
      const params = isRecord(raw.params)
        ? Object.entries(raw.params).reduce<Record<string, number>>((acc, [key, value]) => {
            const parsed = num(value);
            if (parsed !== undefined) acc[key] = parsed;
            return acc;
          }, {})
        : undefined;
      return { kind, clip, effect, ...(params && Object.keys(params).length > 0 ? { params } : {}) };
    }
    case 'addTransition': {
      const transition = str(raw.transition) as TransitionKind | undefined;
      if (!transition || !TRANSITIONS.some((item) => item.kind === transition)) return null;
      return {
        kind,
        fromClip: str(raw.fromClip) ?? '',
        toClip: str(raw.toClip) ?? '',
        transition,
        ...(duration !== undefined ? { duration } : {}),
      };
    }
    default:
      return null;
  }
}

export interface ParsedAnswer {
  reply: string;
  title: string;
  actions: AiAction[];
  /** Entries the model produced that could not be read at all. */
  malformed: number;
}

/** Reads one `PLAN_SCHEMA` answer. Never throws: a broken answer is an empty plan. */
export function normalizePlan(raw: string): ParsedAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The schema makes this rare, but a truncated answer is still valid text.
    return { reply: raw.trim(), title: '', actions: [], malformed: 0 };
  }
  if (!isRecord(parsed)) {
    return { reply: raw.trim(), title: '', actions: [], malformed: 0 };
  }

  const entries = Array.isArray(parsed.actions) ? parsed.actions : [];
  const actions: AiAction[] = [];
  let malformed = 0;
  for (const entry of entries) {
    const action = normalizeAction(entry);
    if (action) actions.push(action);
    else malformed += 1;
  }

  return {
    reply: str(parsed.reply) ?? '',
    title: str(parsed.title) ?? '',
    actions,
    malformed,
  };
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

/** Thrown by a handler that cannot proceed; caught per action. */
class Rejected extends Error {}

/**
 * The annotation is on the constant, not on the arrow: TypeScript only treats a
 * call as never-returning — and therefore narrows the code after it — when the
 * *declaration* carries the type. Without it, every `if (!clip) fail(...)` below
 * would need a cast.
 */
const fail: (reason: string) => never = (reason) => {
  throw new Rejected(reason);
};

const fold = (value: string): string => value.trim().toLowerCase();

/**
 * A clip, by id or by the name a human would use for it.
 *
 * The model is given ids and usually returns them, but "le titre d'ouverture"
 * is a reference too — and refusing it would make the assistant feel brittle
 * for no gain in safety, since a wrong match is still a match the user reviews.
 */
function findClip(project: Project, reference: string): Clip {
  const direct = project.clips.find((clip) => clip.id === reference);
  if (direct) return direct;

  const needle = fold(reference);
  const byLabel = project.clips.find((clip) => clip.label && fold(clip.label) === needle);
  if (byLabel) return byLabel;

  const byText = project.clips.find((clip) => clip.text && fold(clip.text.content) === needle);
  if (byText) return byText;

  const byAsset = project.clips.find((clip) => {
    const asset = project.assets.find((item) => item.id === clip.assetId);
    return asset ? fold(asset.name) === needle : false;
  });
  if (byAsset) return byAsset;

  return fail(`clip « ${reference} » introuvable`);
}

function findAsset(project: Project, reference: string): MediaAsset {
  const direct = project.assets.find((asset) => asset.id === reference);
  if (direct) return direct;

  const needle = fold(reference);
  const byName = project.assets.find((asset) => fold(asset.name) === needle);
  if (byName) return byName;

  // "intro" should find "intro.mp4" — the model rarely repeats an extension.
  const byStem = project.assets.find(
    (asset) => fold(asset.name.replace(/\.[^.]+$/, '')) === needle,
  );
  if (byStem) return byStem;

  return fail(`média « ${reference} » introuvable dans le chutier`);
}

/** Video layers stack on top, audio layers below — the compositing order. */
const withTrack = (tracks: Track[], created: Track | null): Track[] => {
  if (!created) return tracks;
  return created.kind === 'video' ? [created, ...tracks] : [...tracks, created];
};

function makeTrack(project: Project, kind: TrackKind, name?: string): Track {
  const count = project.tracks.filter((track) => track.kind === kind).length + 1;
  return {
    id: uid('tr'),
    kind,
    name: name?.trim() || `${kind === 'video' ? 'V' : 'A'}${count}`,
    height: kind === 'video' ? DEFAULT_TRACK_HEIGHT : 54,
    muted: false,
    solo: false,
    locked: false,
    hidden: false,
    ...(kind === 'audio' ? { audio: defaultTrackAudio() } : {}),
  };
}

/**
 * Turns a track reference into a track that exists, creating one if asked.
 *
 * Returns the project because creating a layer is a document change in itself:
 * the caller threads it forward rather than remembering to merge it later.
 */
function resolveTrack(
  project: Project,
  reference: string | undefined,
  kind: TrackKind,
): { project: Project; trackId: string | undefined } {
  if (!reference) return { project, trackId: undefined };

  const direct = project.tracks.find((track) => track.id === reference);
  if (direct) {
    if (direct.kind !== kind) fail(`la piste « ${direct.name} » n'accepte pas ce type de clip`);
    return { project, trackId: direct.id };
  }

  const needle = fold(reference);
  const byName = project.tracks.find((track) => fold(track.name) === needle);
  if (byName) {
    if (byName.kind !== kind) fail(`la piste « ${byName.name} » n'accepte pas ce type de clip`);
    return { project, trackId: byName.id };
  }

  // Anything unrecognised becomes a new layer named as asked. A plan that says
  // "Titres" means a track called Titres, whether or not one exists yet.
  const created = makeTrack(project, kind, needle === 'new' ? undefined : reference);
  return {
    project: { ...project, tracks: withTrack(project.tracks, created) },
    trackId: created.id,
  };
}

/* ------------------------------------------------------------------ *
 * The selection as a target
 * ------------------------------------------------------------------ */

/**
 * References that mean "whatever is selected right now".
 *
 * Naming each id in turn works, but it is exactly the sort of bookkeeping a
 * model gets wrong on the fourth clip — and "agrandis-les" is a request about a
 * group, not about four coincidentally similar edits. One action addressed to
 * the selection is expanded here into one action per clip, so what the plan
 * card lists is still the real, named clips.
 */
const SELECTION_WORDS = new Set(['selection', '@selection', 'la selection', 'les clips']);

/**
 * Combining marks removed, so `sélection` and `selection` are the same word.
 *
 * Filtered by code point rather than by a regular expression: the range is
 * U+0300 to U+036F, and spelling that as an escape inside a literal is one
 * more thing to get wrong for no gain in clarity.
 */
const deaccent = (value: string): string =>
  value
    .normalize('NFD')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code < 0x0300 || code > 0x036f;
    })
    .join('');

const isSelectionWord = (reference: string): boolean =>
  SELECTION_WORDS.has(deaccent(reference.trim().toLowerCase()));

/**
 * Kinds for which "apply to all of them" is meaningful.
 *
 * `moveClip` is deliberately absent: moving several clips to the same instant
 * would stack them into one another, which is never what the request meant.
 */
const EXPANDABLE = new Set<AiAction['kind']>([
  'setClip',
  'splitText',
  'setEntrance',
  'addEffect',
  'animate',
  'updateText',
  'renameClip',
  'removeClip',
  'trimClip',
]);

/**
 * Replaces selection references with the clips they stand for.
 *
 * Done when the plan is built rather than when it is applied, so the card the
 * user reads names real clips — and so applying it later cannot silently act on
 * a selection that has changed in the meantime.
 */
/** The action kinds that carry a `clip` reference at all. */
type ClipAction = Extract<AiAction, { clip: Reference }>;

const targetsAClip = (action: AiAction): action is ClipAction => 'clip' in action;

export function expandSelection(actions: AiAction[], selection: string[]): AiAction[] {
  if (selection.length === 0) return actions;
  const out: AiAction[] = [];

  for (const action of actions) {
    if (!targetsAClip(action) || !EXPANDABLE.has(action.kind) || !isSelectionWord(action.clip)) {
      out.push(action);
      continue;
    }
    // The spread only replaces one string with another, but TypeScript widens a
    // union under spread and loses the discriminant; the assertion says what the
    // guard above has already established.
    for (const clip of selection) out.push({ ...action, clip } as ClipAction);
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Runs of text
 * ------------------------------------------------------------------ */

/**
 * State threaded through one plan, so actions can agree with each other.
 *
 * Only text needs it today, and for one reason: a title is a *stack* — dropped
 * on a busy layer it moves up one, which is what layers are for — but a run of
 * lyrics, chapters or captions is a *sequence*. Placing those one at a time
 * scatters them across V1, V2, V3 and puts two lines on screen at once.
 */
interface PlanScope {
  /** Run key per action index; `null` when the action is not part of a run. */
  runOf: (string | null)[];
  /** Total span each run covers, so one layer can be found for all of it. */
  runSpans: Map<string, { from: number; to: number }>;
  /** Layer chosen for a run, reused by every later line of it. */
  runTracks: Map<string, string>;
}

/** Two texts belong to the same run when they were aimed at the same layer. */
const runKeyOf = (action: Extract<AiAction, { kind: 'addText' }>): string =>
  `text:${action.track ?? '@auto'}`;

/**
 * Turns overlapping text actions into a sequence.
 *
 * A model asked for lyrics at 11.2 s and 13.6 s will happily give both the
 * default four-second duration, and the second would then start inside the
 * first. Rather than reject that — the *timing* is right, only the length is
 * wrong — each line is shortened to end where the next begins, which is what a
 * subtitle track does and what the user meant.
 */
function prepare(actions: AiAction[]): { actions: AiAction[]; scope: PlanScope } {
  const runOf: (string | null)[] = actions.map(() => null);
  const groups = new Map<string, number[]>();

  actions.forEach((action, index) => {
    if (action.kind !== 'addText') return;
    const key = runKeyOf(action);
    const bucket = groups.get(key);
    if (bucket) bucket.push(index);
    else groups.set(key, [index]);
  });

  const next = [...actions];
  const runSpans = new Map<string, { from: number; to: number }>();

  for (const [key, indices] of groups) {
    // A single title is not a sequence: it keeps the stacking behaviour.
    if (indices.length < 2) continue;

    const ordered = [...indices].sort((a, b) => {
      const left = actions[a] as Extract<AiAction, { kind: 'addText' }>;
      const right = actions[b] as Extract<AiAction, { kind: 'addText' }>;
      return left.start - right.start;
    });

    let from = Infinity;
    let to = -Infinity;

    ordered.forEach((index, position) => {
      const action = next[index] as Extract<AiAction, { kind: 'addText' }>;
      const start = Math.max(0, action.start);
      const follower = ordered[position + 1];
      const ceiling =
        follower === undefined
          ? Infinity
          : Math.max(0, (actions[follower] as Extract<AiAction, { kind: 'addText' }>).start);

      const wanted = action.duration || DEFAULT_TEXT_DURATION;
      const duration = Math.max(MIN_CLIP_DURATION, Math.min(wanted, ceiling - start));

      next[index] = { ...action, start, duration };
      runOf[index] = key;
      from = Math.min(from, start);
      to = Math.max(to, start + duration);
    });

    runSpans.set(key, { from, to });
  }

  return { actions: next, scope: { runOf, runSpans, runTracks: new Map() } };
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

const replaceClip = (project: Project, next: Clip): Project => ({
  ...project,
  clips: project.clips.map((clip) => (clip.id === next.id ? next : clip)),
});

/**
 * Moves a channel to `value`, whether or not it is animated.
 *
 * Writing the static field alone is a silent no-op on an animated channel —
 * keyframes replace it, which is the rule stated at the top of this file. That
 * is how "mets les textes en bas" came back as texts that had not moved: the
 * field changed, the curve did not, and the curve is what renders.
 *
 * So an animated channel is *shifted* rather than pinned. The whole curve moves
 * by the delta needed to land its **last** keyframe on the requested value —
 * the last one because that is where an entrance settles, and settling is what
 * "put it here" means. The animation keeps its shape: a subtitle that rises
 * into place still rises, into its new place.
 *
 * The static field is written too. It costs nothing, and it is the value the
 * clip falls back to the moment the animation is removed.
 */
function setChannel(clip: Clip, channel: ClipChannel, value: number): Clip {
  const moved: Clip = { ...clip, [channel]: value };

  const curve = clip.animation?.[channel];
  if (!curve || curve.length === 0) return moved;

  const settled = curve[curve.length - 1] as Keyframe;
  const delta = value - settled.value;
  if (delta === 0) return moved;

  return {
    ...moved,
    animation: {
      ...clip.animation,
      [channel]: curve.map((frame) => ({ ...frame, value: frame.value + delta })),
    },
  };
}

/** The same, for a batch of channels, skipping the ones left alone. */
function setChannels(clip: Clip, values: Partial<Record<ClipChannel, number>>): Clip {
  return (Object.keys(values) as ClipChannel[]).reduce(
    (current, channel) => setChannel(current, channel, values[channel] as number),
    clip,
  );
}

function textLayerFrom(base: TextLayer, style: TextStyleSpec | undefined): TextLayer {
  if (!style) return base;
  return {
    ...base,
    ...(style.fontFamily ? { fontFamily: style.fontFamily } : {}),
    ...(style.fontSize !== undefined ? { fontSize: clamp(style.fontSize, 8, 480) } : {}),
    ...(style.fontWeight !== undefined
      ? { fontWeight: clamp(Math.round(style.fontWeight / 100) * 100, 100, 900) }
      : {}),
    ...(style.color ? { color: style.color } : {}),
    ...(style.align ? { align: style.align } : {}),
    ...(style.italic !== undefined ? { italic: style.italic } : {}),
  };
}

/** Keyframes the document will accept: inside the clip, on frames, sorted. */
function buildKeyframes(specs: PlanKeyframe[], clip: Clip, fps: number): Keyframe[] {
  const easingOf = (kind: EasingKind | undefined): Easing => ({ kind: kind ?? 'ease-in-out' });
  const seen = new Set<number>();
  const out: Keyframe[] = [];

  for (const spec of specs) {
    const time = snapToFrame(clamp(spec.time, 0, clip.duration), fps);
    // Two keys on the same frame are one key; the later value wins, as it does
    // when a user drops one on top of another.
    if (seen.has(time)) {
      const existing = out.find((item) => item.time === time);
      if (existing) existing.value = spec.value;
      continue;
    }
    seen.add(time);
    out.push({ id: uid('kf'), time, value: spec.value, easing: easingOf(spec.easing) });
  }

  return sortKeyframes(out);
}

/** Mirrors the store's own rule: an empty map is dropped, not left behind. */
function withChannel(clip: Clip, channel: string, keyframes: Keyframe[]): Clip {
  const animation: AnimationMap = { ...(clip.animation ?? {}) };
  if (keyframes.length === 0) delete animation[channel];
  else animation[channel] = sortKeyframes(keyframes);

  if (Object.keys(animation).length > 0) return { ...clip, animation };
  const { animation: _dropped, ...rest } = clip;
  return rest as Clip;
}

function applyAction(
  project: Project,
  action: AiAction,
  scope: PlanScope,
  index: number,
): Project {
  const fps = project.settings.fps;

  switch (action.kind) {
    case 'addTrack': {
      const created = makeTrack(project, action.trackKind, action.name);
      return { ...project, tracks: withTrack(project.tracks, created) };
    }

    case 'addBackground': {
      const { start: _ignored, duration: _also, kind: _kindIgnored, background, ...look } = action;
      return placeBackground(project, background, {
        at: Math.max(0, action.start ?? 0),
        ...(action.duration !== undefined ? { duration: action.duration } : {}),
        layer: boundedLook(look as BackgroundLook),
      }).project;
    }

    case 'setBackground': {
      const clip = findClip(project, action.clip);
      if (!clip.background) fail("ce clip n'est pas un fond généré");
      const { kind: _kindIgnored, clip: _clipIgnored, background, ...look } = action;
      return replaceClip(project, {
        ...clip,
        background: {
          ...clip.background,
          ...(background ? { kind: background } : {}),
          ...boundedLook(look as BackgroundLook),
        },
      });
    }

    case 'addText': {
      const duration = snapToFrame(
        clamp(action.duration || DEFAULT_TEXT_DURATION, MIN_CLIP_DURATION, 3600),
        fps,
      );
      const start = snapToFrame(Math.max(0, action.start), fps);

      const runKey = scope.runOf[index];
      let next = project;
      let trackId = runKey ? scope.runTracks.get(runKey) : undefined;

      if (!trackId) {
        const resolved = resolveTrack(next, action.track, 'video');
        next = resolved.project;

        // A run is placed as a whole. Looking for a layer that is free for this
        // one line would find V1 for the first and V2 for the second the moment
        // anything else is in the way — and two lyrics on screen at once is
        // exactly the breakage this avoids.
        const span = runKey ? scope.runSpans.get(runKey) : undefined;
        const placement = placeOnFreeLayer(
          next,
          'video',
          span ? span.from : start,
          span ? Math.max(span.to - span.from, duration) : duration,
          resolved.trackId,
        );
        next = { ...next, tracks: withTrack(next.tracks, placement.created) };
        trackId = placement.trackId;
        if (runKey) scope.runTracks.set(runKey, trackId);
      }

      const spec = action.style;
      const clip: Clip = {
        id: uid('cl'),
        kind: 'text',
        assetId: null,
        trackId,
        start,
        duration,
        offset: 0,
        volume: 1,
        opacity: 1,
        scale: 1,
        x: spec?.x ?? 0,
        y: spec?.y ?? 0,
        rotation: 0,
        muted: true,
        label: action.label ?? 'Texte',
        effects: [],
        text: textLayerFrom(defaultTextLayer(action.content), spec),
      };

      // A named style wins; `animate: true` is the older shorthand for `pop`.
      const style = action.animation ?? (action.animate ? 'pop' : 'none');
      const animation = entranceAnimation(clip, style, fps);

      return { ...next, clips: [...next.clips, animation ? { ...clip, animation } : clip] };
    }

    case 'addClip': {
      const asset = findAsset(project, action.asset);
      if (asset.missing) fail(`« ${asset.name} » est introuvable sur le disque`);

      const kind: TrackKind = asset.kind === 'audio' ? 'audio' : 'video';
      const resolved = resolveTrack(project, action.track, kind);
      const next = resolved.project;

      const source =
        asset.kind === 'image' ? STILL_DEFAULT_DURATION : Math.max(asset.duration, 0);
      const offset = clamp(action.offset ?? 0, 0, Math.max(source - MIN_CLIP_DURATION, 0));
      const available = source > 0 ? source - offset : (action.duration ?? STILL_DEFAULT_DURATION);
      const duration = snapToFrame(
        clamp(action.duration ?? available, MIN_CLIP_DURATION, Math.max(available, MIN_CLIP_DURATION)),
        fps,
      );
      const start = snapToFrame(Math.max(0, action.start), fps);
      const placement = placeOnFreeLayer(next, kind, start, duration, resolved.trackId);

      const clip: Clip = {
        id: uid('cl'),
        kind: 'media',
        assetId: asset.id,
        trackId: placement.trackId,
        start,
        duration,
        offset,
        volume: 1,
        opacity: 1,
        scale: 1,
        x: 0,
        y: 0,
        rotation: 0,
        muted: false,
        effects: [],
      };

      return {
        ...next,
        tracks: withTrack(next.tracks, placement.created),
        clips: [...next.clips, clip],
      };
    }

    case 'moveClip': {
      const clip = findClip(project, action.clip);
      const kind: TrackKind =
        project.assets.find((asset) => asset.id === clip.assetId)?.kind === 'audio'
          ? 'audio'
          : 'video';
      const resolved = resolveTrack(project, action.track, kind);
      const next = resolved.project;
      const trackId = resolved.trackId ?? clip.trackId;

      const track = next.tracks.find((item) => item.id === trackId);
      if (track?.locked) fail(`la piste « ${track.name} » est verrouillée`);

      const siblings = next.clips.filter(
        (item) => item.trackId === trackId && item.id !== clip.id,
      );
      const start = snapToFrame(
        resolveStart(siblings, Math.max(0, action.start), clip.duration),
        fps,
      );
      return replaceClip(next, { ...clip, start, trackId });
    }

    case 'trimClip': {
      const clip = findClip(project, action.clip);
      const asset = project.assets.find((item) => item.id === clip.assetId);
      const sourceDuration =
        asset && asset.kind !== 'image' && asset.duration > 0 ? asset.duration : Infinity;

      const offset = clamp(
        action.offset ?? clip.offset,
        0,
        sourceDuration === Infinity ? Number.MAX_SAFE_INTEGER : sourceDuration - MIN_CLIP_DURATION,
      );
      const ceiling =
        sourceDuration === Infinity ? 3600 : Math.max(sourceDuration - offset, MIN_CLIP_DURATION);
      const duration = snapToFrame(
        clamp(action.duration ?? clip.duration, MIN_CLIP_DURATION, ceiling),
        fps,
      );

      const siblings = project.clips.filter(
        (item) => item.trackId === clip.trackId && item.id !== clip.id,
      );
      const start = snapToFrame(
        resolveStart(siblings, Math.max(0, action.start ?? clip.start), duration),
        fps,
      );

      return replaceClip(project, { ...clip, start, duration, offset });
    }

    case 'removeClip': {
      const clip = findClip(project, action.clip);
      return { ...project, clips: project.clips.filter((item) => item.id !== clip.id) };
    }

    case 'renameClip': {
      const clip = findClip(project, action.clip);
      return replaceClip(project, { ...clip, label: action.label.slice(0, 80) });
    }

    case 'setClip': {
      const clip = findClip(project, action.clip);
      const moved = setChannels(clip, {
        ...(action.opacity !== undefined ? { opacity: clamp(action.opacity, 0, 1) } : {}),
        ...(action.volume !== undefined ? { volume: clamp(action.volume, 0, 1) } : {}),
        ...(action.scale !== undefined ? { scale: clamp(action.scale, 0.01, 20) } : {}),
        ...(action.x !== undefined ? { x: clamp(action.x, -20000, 20000) } : {}),
        ...(action.y !== undefined ? { y: clamp(action.y, -20000, 20000) } : {}),
        ...(action.rotation !== undefined
          ? { rotation: clamp(action.rotation, -3600, 3600) }
          : {}),
      });
      return replaceClip(project, {
        ...moved,
        ...(action.muted !== undefined ? { muted: action.muted } : {}),
      });
    }

    case 'updateText': {
      const clip = findClip(project, action.clip);
      if (!clip.text) fail('ce clip ne porte pas de texte');
      const base = clip.text;
      const restyled: Clip = {
        ...clip,
        text: textLayerFrom(
          action.content !== undefined ? { ...base, content: action.content } : base,
          action.style,
        ),
      };
      // Same trap as `setClip`: a repositioned caption whose y is keyframed
      // would otherwise keep its old place.
      return replaceClip(
        project,
        setChannels(restyled, {
          ...(action.style?.x !== undefined ? { x: action.style.x } : {}),
          ...(action.style?.y !== undefined ? { y: action.style.y } : {}),
        }),
      );
    }

    case 'splitText': {
      const clip = findClip(project, action.clip);
      const outcome = splitTextClips(project, [clip.id], {
        unit: action.unit ?? DEFAULT_SPLIT_OPTIONS.unit,
        animation: action.animation ?? DEFAULT_SPLIT_OPTIONS.animation,
      });
      if (outcome.pieces === 0) {
        fail(outcome.skipped[0]?.reason ?? 'ce calque ne peut pas être découpé');
      }
      return outcome.project;
    }

    case 'setEntrance': {
      const clip = findClip(project, action.clip);

      // `none` clears the channels an entrance owns and leaves anything else
      // the clip was animating alone — removing an arrival is not the same as
      // wiping a hand-made animation.
      const owned = ['opacity', 'scale', 'y'] as const;
      if (action.animation === 'none') {
        const animation: AnimationMap = { ...(clip.animation ?? {}) };
        for (const channel of owned) delete animation[channel];
        if (Object.keys(animation).length > 0) {
          return replaceClip(project, { ...clip, animation });
        }
        // Spreading a copy that lacks the key does not remove it from `...clip`
        // — the key has to be dropped by rebuilding the object, or the map the
        // action was asked to clear survives untouched.
        const { animation: _dropped, ...rest } = clip;
        return replaceClip(project, rest as Clip);
      }

      const preset = entranceAnimation(clip, action.animation, fps, action.duration);
      if (!preset) fail('ce clip est trop court pour une apparition');

      // Merged, not replaced: a clip animating `rotation` keeps it.
      return replaceClip(project, {
        ...clip,
        animation: { ...(clip.animation ?? {}), ...preset },
      });
    }

    case 'animate': {
      const clip = findClip(project, action.clip);
      const keyframes = buildKeyframes(action.keyframes, clip, fps);
      if (keyframes.length === 1) {
        fail('une animation demande au moins deux images clés');
      }
      return replaceClip(project, withChannel(clip, action.channel, keyframes));
    }

    case 'addEffect': {
      const clip = findClip(project, action.clip);
      const descriptor = effectDescriptor(action.effect);
      const params = { ...initialParams(action.effect) };
      for (const spec of descriptor.params) {
        const proposed = action.params?.[spec.key];
        if (proposed !== undefined) params[spec.key] = clamp(proposed, spec.min, spec.max);
      }
      return replaceClip(project, {
        ...clip,
        effects: [...clip.effects, { id: uid('fx'), kind: action.effect, enabled: true, params }],
      });
    }

    case 'addTransition': {
      const from = action.fromClip ? findClip(project, action.fromClip) : null;
      const to = action.toClip ? findClip(project, action.toClip) : null;
      if (!from && !to) fail('une transition demande au moins un clip');

      // Anchors are computed from the document, so a transition can only be
      // placed where the timeline actually has a junction or an open edge.
      const anchor = transitionAnchors(project).find(
        (item) => item.fromClipId === (from?.id ?? null) && item.toClipId === (to?.id ?? null),
      );
      if (!anchor) fail('ces deux clips ne se touchent pas sur la même piste');

      const descriptor = transitionDescriptor(action.transition);
      if (descriptor.requiresJunction && !isJunction(anchor)) {
        fail(`${descriptor.label} demande un plan de chaque côté`);
      }

      const span = anchor;
      const duration = Math.max(
        MIN_TRANSITION_DURATION,
        Math.min(
          action.duration ?? DEFAULT_TRANSITION_DURATION,
          Math.max(span.maxDuration, MIN_TRANSITION_DURATION),
        ),
      );

      const existing = project.transitions.find(
        (item) =>
          item.trackId === span.trackId &&
          item.fromClipId === span.fromClipId &&
          item.toClipId === span.toClipId,
      );
      const transition: Transition = {
        id: existing?.id ?? uid('tx'),
        kind: action.transition,
        trackId: span.trackId,
        fromClipId: span.fromClipId,
        toClipId: span.toClipId,
        duration,
      };

      return {
        ...project,
        transitions: existing
          ? project.transitions.map((item) => (item.id === existing.id ? transition : item))
          : [...project.transitions, transition],
      };
    }

    default:
      return project;
  }
}

/* ------------------------------------------------------------------ *
 * Application
 * ------------------------------------------------------------------ */

export interface PlanOutcome {
  project: Project;
  applied: AiAction[];
  rejected: { action: AiAction; reason: string }[];
}

/**
 * Folds a plan into one new document.
 *
 * Actions are applied in order and see each other's effects — `addTrack`
 * followed by `addText` on that track's name works, because the second action
 * resolves against the project the first produced.
 */
export function applyPlan(base: Project, actions: AiAction[]): PlanOutcome {
  // Text actions are reconciled with each other first: a run of lines has to
  // agree on one layer and on where each line ends, and neither can be decided
  // one action at a time.
  const { actions: prepared, scope } = prepare(actions);

  let project = base;
  const applied: AiAction[] = [];
  const rejected: { action: AiAction; reason: string }[] = [];

  prepared.forEach((action, index) => {
    try {
      project = applyAction(project, action, scope, index);
      applied.push(action);
    } catch (error) {
      rejected.push({
        action,
        reason: error instanceof Rejected ? error.message : 'action non applicable',
      });
    }
  });

  return { project, applied, rejected };
}

/** Human summary of one action, for the plan card. */
export function describeAction(action: AiAction, project: Project | null): string {
  const clipName = (reference: string): string => {
    const clip = project?.clips.find((item) => item.id === reference);
    if (!clip) return reference;
    if (clip.label) return clip.label;
    if (clip.text) return `« ${clip.text.content.slice(0, 24)} »`;
    const asset = project?.assets.find((item) => item.id === clip.assetId);
    return asset?.name ?? reference;
  };
  const at = (seconds: number) => `${seconds.toFixed(1).replace('.', ',')} s`;

  switch (action.kind) {
    case 'addTrack':
      return `Nouvelle piste ${action.trackKind === 'audio' ? 'audio' : 'vidéo'}${action.name ? ` « ${action.name} »` : ''}`;
    case 'addBackground':
      return `Fond « ${backgroundDescriptor(action.background).label} »${action.start ? ` à ${at(action.start)}` : ''}`;
    case 'setBackground':
      return `Régler le fond ${clipName(action.clip)}`;
    case 'addText':
      return `Texte « ${action.content.replace(/\n/g, ' ').slice(0, 40)} » à ${at(action.start)}`;
    case 'addClip':
      return `Poser « ${action.asset} » à ${at(action.start)}`;
    case 'moveClip':
      return `Déplacer ${clipName(action.clip)} à ${at(action.start)}`;
    case 'trimClip':
      return `Rogner ${clipName(action.clip)}`;
    case 'removeClip':
      return `Supprimer ${clipName(action.clip)}`;
    case 'renameClip':
      return `Renommer ${clipName(action.clip)} en « ${action.label} »`;
    case 'setClip':
      return `Régler ${clipName(action.clip)}`;
    case 'updateText':
      return `Modifier le texte de ${clipName(action.clip)}`;
    case 'splitText':
      return `Découper ${clipName(action.clip)} ${action.unit === 'line' ? 'ligne par ligne' : 'mot par mot'}`;
    case 'setEntrance':
      return action.animation === 'none'
        ? `Retirer l'apparition de ${clipName(action.clip)}`
        : `Apparition « ${action.animation} » sur ${clipName(action.clip)}${action.duration ? ` — ${at(action.duration)}` : ''}`;
    case 'animate':
      return `Animer ${action.channel} sur ${clipName(action.clip)} — ${action.keyframes.length} images clés`;
    case 'addEffect':
      return `${effectDescriptor(action.effect).label} sur ${clipName(action.clip)}`;
    case 'addTransition':
      return `${transitionDescriptor(action.transition).label} entre ${clipName(action.fromClip)} et ${clipName(action.toClip)}`;
    default:
      return 'Modification';
  }
}

/** A plan, ready to show. Validation happens at apply time, not here. */
export function buildPlan(title: string, actions: AiAction[]): AiPlan {
  return {
    id: uid('plan'),
    title: title.trim() || 'Modifications proposées',
    actions,
    rejected: [],
    appliedAt: null,
  };
}
