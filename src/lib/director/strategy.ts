/**
 * The proposal, and the two ways it can change.
 *
 * A strategy is derived from measurement — the reference's own pacing — and
 * then argued with in words. Both roads lead through {@link normalizeStrategy},
 * which is the trust boundary: nothing a model returns is assumed to be
 * well-formed, in range, or even to be a number. `lib/ai/plan` draws the same
 * line for the same reason, and this is the smaller, easier half of it, because
 * a strategy is six fields rather than an open-ended list of edits.
 *
 * Nothing here talks to a network. The prompt is built here, the answer is
 * cleaned here, and both can be exercised without a key — which is what makes
 * the interesting part testable at all.
 */

import { medianInterval } from './pacing';
import type { Beat } from '@/lib/amv/beats';
import type { Structure } from '@/lib/amv/structure';
import {
  PHASE_MAP,
  amvProfile,
  type AmvOptions,
  type AmvProfileId,
  type AmvRecipe,
  type PhaseId,
  type PhaseSpec,
} from '@/types/amv';
import {
  DEFAULT_SHOT,
  STRATEGY_LIMITS,
  type ClipRole,
  type DirectorContext,
  type ReferenceProfile,
  type Strategy,
} from '@/types/director';

const PHASE_IDS: PhaseId[] = ['intro', 'build', 'drop'];

/**
 * Longest a shot may be held when nothing cuts it, in seconds.
 *
 * `pace` scales the profile's floor *and* its cap together, so a slow opening
 * asked for in seconds would push the cap into the tens of them — and a passage
 * with no beat firm enough to cut on would sit there for a quarter of a minute.
 * The pace is clamped so the cap stays watchable; the target is not lost by it,
 * because where there are beats the pacing is set by `thinning` and the floor
 * is only ever a guard.
 */
const HOLD_CEILING = 6;

const clampShot = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(STRATEGY_LIMITS.maxShot, Math.max(STRATEGY_LIMITS.minShot, value));
};

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

/* ------------------------------------------------------------------ *
 * Where a strategy comes from
 * ------------------------------------------------------------------ */

/** The strategy a profile proposes on its own, with nothing to copy. */
export function defaultStrategy(profile: AmvProfileId): Strategy {
  return {
    profile,
    shot: { ...DEFAULT_SHOT[profile] },
    punch: true,
    flashes: true,
    split: true,
    smear: true,
    borrowArc: false,
    // Nobody has looked at the rushes yet, so nobody has an opinion about them.
    roles: {},
    opening: null,
  };
}

/**
 * The strategy a reference proposes.
 *
 * The profile is chosen by how hard the reference cuts at its own release,
 * because that is the one decision the pacing numbers cannot express: a
 * reference holding a shot for most of a second through its drop is a
 * cinematic edit however its numbers are applied, and giving it the aggressive
 * profile would put hard flashes over a montage that never asked for them.
 */
export function strategyFromReference(reference: ReferenceProfile): Strategy {
  const profile: AmvProfileId = reference.shot.drop <= 0.5 ? 'aggressive' : 'cinematic';

  return {
    profile,
    shot: { ...reference.shot },
    punch: true,
    flashes: true,
    // A reference that barely cuts is not asking for chromatic aberration.
    split: profile === 'aggressive',
    smear: true,
    // Only ever consulted when the user's own track states no arc of its own.
    borrowArc: reference.arcSource === 'measured',
    /*
     * The casting stays empty here, and that is the honest answer.
     *
     * A reference says how fast to cut; it says nothing whatever about which of
     * *these* clips belongs in an opening. Guessing from filenames would be an
     * editorial decision taken by a regular expression.
     */
    roles: {},
    opening: null,
  };
}

/* ------------------------------------------------------------------ *
 * What a strategy becomes
 * ------------------------------------------------------------------ */

/**
 * The movements, retuned so shots land near the strategy's targets.
 *
 * Two dials do the work, and they are the two the sequencer already has.
 * `pace` moves the profile's own floor and cap to sit around the target, so a
 * passage with no beats in it is held for about the right time. `thinning`
 * decides how many beats a cut waits for, which is what actually sets the pace
 * where there *are* beats: at 120 BPM a target of half a second is every beat,
 * and two seconds is every fourth.
 *
 * Both are needed. `pace` alone would leave the montage cutting on every beat
 * and merely refusing the ones that came too soon; `thinning` alone would leave
 * a quiet passage held for the profile's cap rather than the target.
 *
 * The cut floor is left to the movement's own: how *firm* a beat has to be is
 * an intention about the opening, not a pace, and a reference cannot say
 * anything about it.
 */
export function resolveRecipe(
  strategy: Strategy,
  beats: Beat[],
  structure: Structure,
): AmvRecipe {
  const profile = amvProfile(strategy.profile);
  const fallback = medianInterval(beats);

  const phases = PHASE_IDS.reduce<Record<PhaseId, PhaseSpec>>(
    (out, id) => {
      const base = PHASE_MAP[id];
      const target = clampShot(strategy.shot[id], base.pace * profile.minShot);
      const window = structure.phases.find((phase) => phase.id === id);

      const inside = window
        ? beats.filter((beat) => beat.at >= window.from && beat.at < window.to)
        : [];
      const span = window ? window.to - window.from : 0;
      const wanted = span > 0 ? Math.max(1, Math.round(span / target)) : 0;

      out[id] = {
        ...base,
        pace: Math.max(
          0.25,
          Math.min(
            target / Math.max(0.01, profile.minShot),
            HOLD_CEILING / Math.max(0.1, profile.maxShot),
          ),
        ),
        cutFloor: strengthFloor(inside, wanted, profile.cutStrength),
        // The floor has already chosen how many beats may cut, so thinning must
        // not thin them a second time — the two together would land at a
        // fraction of the pace asked for.
        thinning: inside.length > 0 ? 1 : Math.max(1, Math.round(target / fallback)),
      };
      return out;
    },
    { ...PHASE_MAP },
  );

  return { profile, phases };
}

/**
 * The strength bar that lets through about `wanted` of these beats.
 *
 * This is where a copied pace and the movement's own intention are reconciled,
 * and the reconciliation is the interesting part of the whole feature.
 *
 * The movements carry a `cutFloor` so that an opening cuts on *accents* rather
 * than on whatever beat happens along — that is what makes it read as composed.
 * But a fixed floor and a target pace fight: asked for a cut every 1.6 seconds
 * over an opening whose beats are mostly soft, a high floor admits three of
 * them and the montage holds a shot for six seconds instead.
 *
 * Taking the bar from a *quantile of the beats actually present* satisfies both.
 * The pace comes out at the target because the right number of beats are
 * admitted; the intention survives because the ones admitted are the strongest
 * ones there — the accents — rather than an arbitrary subset.
 *
 * Returned as an offset on the profile's own floor, which is what `planShots`
 * adds it to.
 */
function strengthFloor(inside: Beat[], wanted: number, profileFloor: number): number {
  if (inside.length === 0 || wanted <= 0) return 0;
  // Every beat is needed, so nothing is barred: the pace is then whatever the
  // music can give, which is the honest answer to asking for more cuts than
  // there are beats.
  if (wanted >= inside.length) return 0;

  const strengths = inside.map((beat) => beat.strength).sort((a, b) => b - a);
  const bar = strengths[wanted - 1] ?? 0;
  return Math.max(0, bar - profileFloor);
}

/** The wizard options a strategy implies. The toggles map one to one. */
export const optionsFor = (strategy: Strategy, base: AmvOptions): AmvOptions => ({
  ...base,
  profile: strategy.profile,
  punch: strategy.punch,
  flashes: strategy.flashes,
  split: strategy.split,
  smear: strategy.smear,
  // The casting travels with the rest: the sequencer reads one options object.
  roles: strategy.roles,
  opening: strategy.opening,
});

/**
 * The casting, resolved from names to assets.
 *
 * The model answers with clip *names*, because that is what it was shown and
 * asking it to carry ids around is one more thing to get subtly wrong. A name
 * that matches nothing is dropped rather than guessed at: a montage that opened
 * on a clip nobody has is a worse failure than one that opens on the shuffle.
 *
 * Matching is case-insensitive and tolerates a missing extension, which is the
 * one liberty models reliably take with a filename. It is not fuzzy beyond
 * that — "the fight one" resolves to nothing, and should.
 */
function castOf(
  patch: Record<string, unknown>,
  current: Strategy,
  clips: { id: string; name: string }[],
): Pick<Strategy, 'roles' | 'opening'> {
  if (clips.length === 0) return { roles: current.roles, opening: current.opening };

  const key = (name: string) => name.trim().toLowerCase().replace(/\.[a-z0-9]+$/, '');
  const byName = new Map(clips.map((clip) => [key(clip.name), clip.id]));
  const resolve = (value: unknown): string | null =>
    typeof value === 'string' ? (byName.get(key(value)) ?? null) : null;

  const roles: Record<string, ClipRole> = {};
  let cast = false;

  for (const [field, role] of [
    ['introClips', 'intro'],
    ['buildClips', 'build'],
    ['dropClips', 'drop'],
  ] as const) {
    const named = patch[field];
    if (!Array.isArray(named)) continue;
    cast = true;
    for (const entry of named) {
      const id = resolve(entry);
      // First casting wins: a clip named in two movements is an answer that
      // contradicts itself, and silently moving it to the later one would make
      // the montage depend on the order the fields happened to be read in.
      if (id !== null && !(id in roles)) roles[id] = role;
    }
  }

  const opening = resolve(patch.opening);

  return {
    roles: cast ? roles : current.roles,
    opening: opening ?? (patch.opening === undefined ? current.opening : null),
  };
}


/* ------------------------------------------------------------------ *
 * The trust boundary
 * ------------------------------------------------------------------ */

/**
 * A model's answer, rebuilt from scratch on top of the current strategy.
 *
 * Rebuilt, not merged: every field is read individually, checked, and clamped,
 * and anything missing or malformed keeps the value it already had. So the
 * worst a bad answer can do is change nothing — never produce a montage cutting
 * every twelve milliseconds because a number came back as a string, or lose the
 * whole strategy because one key was misspelt.
 *
 * The shot lengths arrive flat (`introShot`, not `shot.intro`) because a flat
 * object is what these schemas produce most reliably, and because a normaliser
 * that never has to walk into a nested value has fewer ways to be wrong.
 */
export function normalizeStrategy(
  raw: unknown,
  current: Strategy,
  /**
   * The clips that exist, so a casting can be resolved against them.
   *
   * Omitted when there is nothing to resolve against — a button on the card,
   * a test — and the casting then carries through untouched.
   */
  clips: { id: string; name: string }[] = [],
): Strategy {
  if (typeof raw !== 'object' || raw === null) return current;
  const patch = raw as Record<string, unknown>;

  const profile: AmvProfileId =
    patch.profile === 'aggressive' || patch.profile === 'cinematic'
      ? patch.profile
      : current.profile;

  const next: Strategy = {
    profile,
    shot: {
      intro: clampShot(patch.introShot, current.shot.intro),
      build: clampShot(patch.buildShot, current.shot.build),
      drop: clampShot(patch.dropShot, current.shot.drop),
    },
    punch: bool(patch.punch, current.punch),
    flashes: bool(patch.flashes, current.flashes),
    split: bool(patch.split, current.split),
    smear: bool(patch.smear, current.smear),
    borrowArc: bool(patch.borrowArc, current.borrowArc),
    ...castOf(patch, current, clips),
  };

  /*
   * The arc is enforced after the clamps, not asked for politely in the prompt.
   *
   * A montage that cuts faster in its opening than at its release is not a
   * montage with an unusual shape, it is one with no shape — the exact failure
   * the three movements exist to prevent. A model asked for "slower cuts" will
   * cheerfully raise only the drop, so the ordering is imposed here rather than
   * left to whether the answer happened to respect it.
   */
  next.shot.build = Math.min(next.shot.build, next.shot.intro);
  next.shot.drop = Math.min(next.shot.drop, next.shot.build);

  return next;
}

/** The clip identities a normalisation needs, taken from the prompt context. */
export const clipsOf = (context: DirectorContext): { id: string; name: string }[] =>
  context.clips.map((clip) => ({ id: clip.id, name: clip.name }));
