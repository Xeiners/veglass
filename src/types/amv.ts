/**
 * The rhythmic-montage generator's vocabulary.
 *
 * A music track and a folder of clips go in; a cut-to-the-beat edit comes out.
 * Everything here describes that *proposal* — the wizard's answers, the beats
 * the analysis found — and none of it is part of the document. The proposal
 * becomes a project edit at one point only, when someone presses the button,
 * which is why none of these types appear in `Project`.
 *
 * # Why the look lives in a profile rather than in the builder
 *
 * "Fast & Aggressive" and "Smooth & Cinematic" are not two code paths. They are
 * two sets of numbers fed to one sequencer, and that is the whole reason a
 * third one — half-speed, or no flashes, or a different punch — costs an entry
 * here and nothing else. A profile that needed its own branch in the builder
 * would be a profile nobody adds.
 */

import { presetEasing, type Easing } from './animation';

export type AmvProfileId = 'aggressive' | 'cinematic';

/* ------------------------------------------------------------------ *
 * The three movements
 * ------------------------------------------------------------------ */

export type PhaseId = 'intro' | 'build' | 'drop';

/**
 * What a movement does to the profile.
 *
 * Not a second set of profiles: every dial here *modulates* the one the profile
 * already carries, so a phase describes an intention — "settle", "climb",
 * "release" — rather than a look. That separation is what keeps the two
 * orthogonal: adding a third profile does not mean writing three more phases,
 * and retuning the arc does not touch what "Rapide et nerveux" means.
 *
 * The alternative — a boolean on the sequencer for each effect, per phase —
 * was the obvious first draft and it is worse in the way that matters: it can
 * only turn things off. A build-up is not the drop with the flashes disabled,
 * it is the drop at sixty per cent, which needs a scale and not a switch.
 */
export interface PhaseSpec {
  id: PhaseId;
  label: string;
  hint: string;
  /** Multiplies the profile's shot bounds. Above 1, shots run longer. */
  pace: number;
  /** Multiplies `beatsPerCut`, so a cut waits for more of them. */
  thinning: number;
  /** Added to the profile's `cutStrength`, so only firmer beats carry a cut. */
  cutFloor: number;
  /** Scales the punch's *travel*. 0 leaves the camera still. */
  punch: number;
  /** Scales the smear. 0 cuts clean. */
  smear: number;
  /** Scales the veil, and raises what it takes to earn one. 0 never flashes. */
  flash: number;
  /** Whether the shock effects — the split and the negative — may fire at all. */
  shock: boolean;
}

/**
 * The arc, as three sets of numbers.
 *
 * Read alongside `lib/amv/structure`, which decides *where* the boundaries
 * fall; this decides what happens either side of them.
 */
export const PHASES: PhaseSpec[] = [
  {
    id: 'intro',
    label: 'Intro',
    hint: 'Plans longs et posés — l’image respire',
    // Two and a half times the profile's own bounds. On the fast profile that
    // turns a seven-frame minimum into most of a second, which is the shortest
    // a shot can be and still be looked at rather than registered.
    pace: 2.5,
    thinning: 2,
    /*
     * A high floor, and it is doing the work the brief asks for.
     *
     * Cutting "on the phrasing of the voice" is what an editor does by ear, and
     * no honest amount of arithmetic here detects a breath. What this does
     * instead is keep only the firmest onsets in the opening — which on a vocal
     * intro are the phrase accents, and on an instrumental one the downbeats.
     * That is not phrase detection; it is the nearest thing to it that the
     * measurement actually supports, and it lands in the same places often
     * enough to be worth doing.
     */
    cutFloor: 0.38,
    punch: 0,
    smear: 0,
    flash: 0,
    shock: false,
  },
  {
    id: 'build',
    label: 'Montée',
    hint: 'Le rythme se resserre, les effets s’installent',
    pace: 1.45,
    thinning: 1,
    cutFloor: 0.12,
    // Half the travel: present, and not yet the thing you are watching.
    punch: 0.5,
    smear: 0.55,
    // Rare and faint. The threshold is raised in proportion, so a build only
    // flashes on something that would have been near the top of the drop.
    flash: 0.35,
    shock: false,
  },
  {
    id: 'drop',
    label: 'Drop',
    hint: 'Coupes sur chaque frappe, flashs, aberration',
    pace: 1,
    thinning: 1,
    cutFloor: 0,
    punch: 1,
    smear: 1,
    flash: 1,
    shock: true,
  },
];

export const phaseSpec = (id: PhaseId): PhaseSpec =>
  PHASES.find((item) => item.id === id) ?? (PHASES[PHASES.length - 1] as PhaseSpec);

/**
 * The movements as a lookup, which is the shape a run actually works from.
 *
 * A run may be handed a *tuned* copy of this — the director derives one from a
 * reference edit — so the sequencer takes the map as a parameter and defaults
 * to these. Everything downstream reads whichever it was given, and neither
 * knows nor cares which it was.
 */
export const PHASE_MAP: Record<PhaseId, PhaseSpec> = {
  intro: phaseSpec('intro'),
  build: phaseSpec('build'),
  drop: phaseSpec('drop'),
};

/**
 * The resolved numbers one montage is built from.
 *
 * A profile says what the edit *looks* like and the movements say how it is
 * paced; a recipe is simply the pair, after anything that wanted to tune them
 * has had its say. The wizard uses the registry's own; the director replaces
 * the movements with ones measured off a reference. Passing the pair rather
 * than a stack of override flags keeps the sequencer honest — it reads numbers,
 * and never has to ask where they came from.
 */
export interface AmvRecipe {
  profile: AmvProfile;
  phases: Record<PhaseId, PhaseSpec>;
}

export const defaultRecipe = (id: AmvProfileId): AmvRecipe => ({
  profile: amvProfile(id),
  phases: PHASE_MAP,
});

/**
 * What a beat must reach to earn a veil in this movement.
 *
 * Interpolated towards 1 rather than scaled, because scaling a threshold down
 * makes a quiet phase flash *more*, which is the opposite of the intention. At
 * `flash = 1` it is the profile's own threshold; at 0.35 it sits two thirds of
 * the way to the top, so only the biggest moment of a build ever qualifies.
 */
export const flashThreshold = (base: number, phase: PhaseSpec): number =>
  1 - (1 - base) * phase.flash;

/* ------------------------------------------------------------------ *
 * The camera bump
 * ------------------------------------------------------------------ */

/**
 * A punch zoom, in the terms the keyframe engine already speaks.
 *
 * Deliberately expressed as *multipliers of the resting framing* rather than as
 * absolute scales. The resting framing is not 1: a 16:9 clip in a 9:16 project
 * rests at whatever covers the frame, and a floating clip rests inset inside
 * it. An absolute 1.15 would mean "punch in" in one project and "shrink to a
 * letterboxed strip" in the other.
 */
export interface PunchSpec {
  /** Peak scale as a multiple of rest. 1.15 is the classic 100 % → 115 %. */
  amount: number;
  /** Seconds from the cut to the peak. */
  attack: number;
  /** Seconds from the peak back to rest. */
  release: number;
  /** Curve of the way in. */
  attackEasing: Easing;
  /**
   * Curve of the way back.
   *
   * An overshooting curve is what makes the return *elastic*: interpolating
   * from the peak down to rest through a bézier whose output passes 1 carries
   * the scale a shade under rest before it settles, which is the small recoil a
   * hand-keyed camera bump has and a linear ramp does not.
   */
  releaseEasing: Easing;
  /** Beats weaker than this get no bump at all, 0 → 1. */
  threshold: number;
}

/* ------------------------------------------------------------------ *
 * The flash
 * ------------------------------------------------------------------ */

/**
 * The two kinds of impact marker, and when each fires.
 *
 * A veil is a flat colour laid over the montage for a few frames; a negative is
 * the montage itself, inverted, for fewer. They are graded by beat strength so
 * that the loudest moment in the track is not merely another white frame — the
 * inversion is held back for it, and stays rare enough to keep landing.
 */
export interface FlashSpec {
  /** Beats at or above this strength get a veil, 0 → 1. */
  threshold: number;
  /** Hex, `#rrggbb`. */
  color: string;
  /** Peak opacity of the veil, 0 → 1. */
  opacity: number;
  /** Seconds the veil takes to fall away. */
  duration: number;
  /** Beats at or above this get a negative instead. `null` never inverts. */
  invertThreshold: number | null;
  /** Seconds the negative holds. */
  invertDuration: number;
  /**
   * Shortest gap between two negatives, in seconds.
   *
   * Much longer than the veil's, and it has to be its own number rather than
   * the same one. A drop is a run of beats that are *all* near the top of the
   * track, so any threshold worth setting is cleared by a great many of them —
   * and the spacing is what actually decides how often the accent fires. A veil
   * every second or two is punctuation; an inverted frame every second or two
   * is a strobe.
   */
  invertSpacing: number;
  /**
   * Shortest gap between two flashes, in seconds.
   *
   * Without it a dense fill on the snare produces a strobe, which is both
   * unwatchable and, for some viewers, genuinely unsafe.
   */
  spacing: number;
}

/* ------------------------------------------------------------------ *
 * The impact effects
 * ------------------------------------------------------------------ */

/**
 * The chromatic split fired on a heavy beat.
 *
 * Red one way, blue the other, for a handful of frames. It is the cheapest
 * thing in the whole montage that reads as *force* — the picture is not just
 * changing, it is being hit hard enough to knock the lens out of alignment.
 *
 * Held back behind a threshold on purpose. A split on every cut stops being an
 * accent within about four seconds and becomes the look of the footage.
 */
export interface SplitSpec {
  /** Beats at or above this strength split, 0 → 1. */
  threshold: number;
  /** Peak separation between the red and blue fringes, in project pixels. */
  amount: number;
  /** Degrees; 0 lays the fringes left and right. */
  angle: number;
  /** Seconds from the peak back to a clean frame. */
  decay: number;
  /**
   * Shortest gap between two splits, in seconds.
   *
   * The threshold alone is not enough to keep this rare. A drop is a run of
   * beats that are *all* near the top, so a bar of them all clear any strength
   * bar worth setting — and an aberration on every beat is not an accent, it is
   * the grade. This is what turns "the loudest beats" into "a few of them".
   */
  spacing: number;
}

/**
 * The directional smear laid on a cut.
 *
 * A hard cut between two unrelated frames is the one thing in a fast montage
 * that reads as *digital* — the eye gets no motion to follow across the join,
 * so the picture appears to teleport. A frame or two of smear on the incoming
 * shot gives it something to arrive out of, and it lands on the same instant as
 * the punch's steepest acceleration, which is the other moment a camera would
 * genuinely blur.
 */
export interface SmearSpec {
  /** Peak standard deviation at the cut, in project pixels. */
  amount: number;
  /** Degrees; 0 smears sideways, which is what a whip pan does. */
  angle: number;
  /** Seconds from the cut back to a clean frame. */
  decay: number;
}

/* ------------------------------------------------------------------ *
 * The profiles
 * ------------------------------------------------------------------ */

export interface AmvProfile {
  id: AmvProfileId;
  label: string;
  hint: string;
  /** How many detected beats one shot spans. 1 cuts on every beat. */
  beatsPerCut: number;
  /** Beats weaker than this never carry a cut of their own, 0 → 1. */
  cutStrength: number;
  /** Shortest shot, in seconds. A beat arriving sooner is passed over. */
  minShot: number;
  /** Longest shot. A quiet passage is cut anyway rather than held. */
  maxShot: number;
  /**
   * How the picture sits in the frame.
   *
   * `cover` fills it, losing whatever falls outside — the right answer when the
   * cut is the effect. `float` contains the whole picture, inset, over a
   * blurred copy of itself; the glass is the look, and it needs the room.
   */
  frame: 'cover' | 'float';
  punch: PunchSpec;
  /** `null` on a profile that never flashes. */
  flash: FlashSpec | null;
  /** `null` on a profile that never splits its channels. */
  split: SplitSpec | null;
  /** `null` on a profile that cuts clean. */
  smear: SmearSpec | null;
  /** Seconds of cross-dissolve at each junction. 0 means hard cuts. */
  dissolve: number;
}

/**
 * How far inside the frame a floating shot sits.
 *
 * `scale = 1` is the picture *contained*, so this is a straight inset — and the
 * margin it opens is exactly what the backdrop fills. Small enough that the
 * picture is still the subject, large enough that the glass is visibly there
 * rather than a suspicion along the edges.
 */
export const FLOAT_SCALE = 0.9;

export const AMV_PROFILES: AmvProfile[] = [
  {
    id: 'aggressive',
    label: 'Rapide et nerveux',
    hint: 'Coupe sec sur chaque frappe, flashs blancs, zooms secs',
    beatsPerCut: 1,
    // Low, because on this profile the beat detector's own threshold is doing
    // the filtering: a beat that survived detection is a beat worth cutting on.
    cutStrength: 0.12,
    // Four frames at 30 fps. Below that the eye reads a glitch, not a cut.
    minShot: 0.13,
    maxShot: 1.4,
    frame: 'cover',
    punch: {
      amount: 1.15,
      // Two frames in, seven back out: the bump has to be over before the next
      // beat lands, or the shots blur into one continuous drift.
      attack: 0.06,
      release: 0.22,
      // Fast off the mark and decelerating — the way a whip pan starts.
      attackEasing: presetEasing('expo-out'),
      releaseEasing: presetEasing('back-out'),
      threshold: 0.3,
    },
    flash: {
      /*
       * Raised hard, along with the spacing below.
       *
       * At 0.66 with a quarter-second gap this fired several times a second
       * through a chorus, and an accent that happens constantly is not one —
       * the eye stops seeing it inside two bars. The pair of numbers is what
       * makes a flash mean something arrived.
       */
      threshold: 0.8,
      color: '#FFFFFF',
      // Not 1: a veil at full opacity is a white frame, and a white frame reads
      // as a dropped one. Just under, the picture stays faintly legible through
      // it, which is what makes it a flash rather than a gap.
      opacity: 0.88,
      duration: 0.1,
      // Reserved for the heaviest moment in the track, and gated to the drop
      // besides. Two or three in a ninety-second edit is the intent.
      invertThreshold: 0.94,
      // Two frames at 30 fps. A negative held longer stops being an accent and
      // starts looking like a colour-management fault.
      invertDuration: 0.07,
      // Roughly one every four bars at 120 BPM, at the very most — half a dozen
      // across a long release, which is what "reserved for the heaviest moment"
      // has to mean in practice.
      invertSpacing: 8,
      spacing: 1.1,
    },
    split: {
      // Just under the flash, so the two alternate rather than always landing
      // together — but nowhere near low enough to fire on an ordinary beat.
      threshold: 0.76,
      // Fourteen pixels on a 1920-wide frame — a fringe you read as a fringe,
      // not one you have to be told is there.
      amount: 14,
      angle: 0,
      // Four frames at 30 fps. Long enough to be seen falling away, short
      // enough to be gone before the next beat lands.
      decay: 0.13,
      // One every three seconds at the very most. The split is the subtler of
      // the two shock effects, so it may be commoner than the negative — but a
      // fringe on every other shot is a look, not an accent.
      spacing: 3,
    },
    smear: {
      amount: 16,
      angle: 0,
      // Three frames at 30 fps, which the decay curve turns into 16 px, 8 px,
      // 2 px, gone. A cut smear is a join, not a look: any longer and the
      // montage reads as out of focus rather than as fast.
      decay: 0.1,
    },
    dissolve: 0,
  },
  {
    id: 'cinematic',
    label: 'Doux et cinématique',
    hint: 'Transitions fondues, fond flouté, zooms lents',
    // Every other beat: at 120 BPM that is a shot per bar-half, which is about
    // as fast as a dissolve can be and still read as a dissolve.
    beatsPerCut: 2,
    cutStrength: 0.35,
    minShot: 0.8,
    maxShot: 4,
    frame: 'float',
    punch: {
      // A push, not a bump. Six per cent over a second and a half is a move the
      // viewer feels without being able to point at it.
      amount: 1.06,
      attack: 0.9,
      release: 1.6,
      attackEasing: presetEasing('sine-in-out'),
      // No overshoot here: a recoil is a percussive gesture, and this profile
      // has none.
      releaseEasing: presetEasing('sine-in-out'),
      threshold: 0,
    },
    flash: {
      threshold: 0.82,
      // Warm rather than white, and faint. On this profile a flash is a lift in
      // the light, not a hit.
      color: '#FFF4E0',
      opacity: 0.3,
      duration: 0.42,
      invertThreshold: null,
      invertDuration: 0,
      invertSpacing: 0,
      spacing: 1.6,
    },
    split: {
      // Rare and small. On this profile the split is a texture on the biggest
      // moment of the track, not a punctuation mark.
      threshold: 0.9,
      amount: 5,
      angle: 0,
      decay: 0.5,
      spacing: 6,
    },
    smear: {
      amount: 9,
      angle: 0,
      // Longer, because here it is not covering a hard cut — the dissolve does
      // that — but riding the front of a slow push.
      decay: 0.3,
    },
    dissolve: 0.32,
  },
];

export const amvProfile = (id: AmvProfileId): AmvProfile =>
  AMV_PROFILES.find((item) => item.id === id) ?? (AMV_PROFILES[0] as AmvProfile);

/* ------------------------------------------------------------------ *
 * What the wizard is asking for
 * ------------------------------------------------------------------ */

export interface AmvOptions {
  profile: AmvProfileId;
  /**
   * How readily a peak counts as a beat, 0 → 1.
   *
   * The one dial worth exposing. Detection is a threshold over an adaptive
   * baseline, and no single setting suits both a sparse piano piece and a wall
   * of distorted guitar — but re-detecting costs nothing, because the measured
   * curve is already in memory. Dragging this re-picks the beats without going
   * near the disk.
   */
  sensitivity: number;
  /** Camera bumps on the strong beats. */
  punch: boolean;
  /** Veils and negatives on the impacts. */
  flashes: boolean;
  /** Chromatic aberration on the heaviest beats. */
  split: boolean;
  /** Directional smear across each cut. */
  smear: boolean;
  /** A ruler flag on every cut, so the montage can be reworked by hand. */
  markers: boolean;
  /** Seconds of montage to build. 0 means the whole track. */
  limit: number;
  /**
   * Which movement each clip was cast into, keyed by asset id.
   *
   * Empty for the wizard, which has no opinion about the rushes. The director
   * fills it from what Gemini decided after looking at their frames — and it is
   * the difference between a montage that cuts on the beat and one that cuts to
   * something.
   */
  roles: Record<string, PhaseId | 'any'>;
  /** The asset the montage opens on. `null` leaves it to the shuffle. */
  opening: string | null;
  /**
   * Seed for the source shuffle.
   *
   * Present so that two runs over the same folder give the same montage, and so
   * that changing one number gives a genuinely different one. Without it, "try
   * another arrangement" would mean re-importing everything and hoping.
   */
  seed: number;
}

export const DEFAULT_AMV_OPTIONS: AmvOptions = {
  profile: 'aggressive',
  sensitivity: 0.5,
  punch: true,
  flashes: true,
  split: true,
  smear: true,
  markers: false,
  limit: 0,
  roles: {},
  opening: null,
  seed: 1,
};

/** Bounds the wizard and any generated plan are held to. */
export const AMV_LIMITS = {
  /** A montage under this has nothing to cut; over it, the bake gets silly. */
  minMusic: 4,
  maxMontage: 600,
  /** More than this and the ruler is a solid stripe. */
  maxMarkers: 400,
} as const;

/* ------------------------------------------------------------------ *
 * Progress
 * ------------------------------------------------------------------ */

export type AmvStage =
  | 'idle'
  | 'reading'
  | 'listening'
  | 'ready'
  | 'failed'
  | 'cancelled';

export const AMV_STAGE_LABELS: Record<AmvStage, string> = {
  idle: 'Prêt',
  reading: 'Lecture des clips',
  listening: 'Analyse du rythme',
  ready: 'Montage proposé',
  failed: 'Analyse interrompue',
  cancelled: 'Analyse annulée',
};

export const isRunning = (stage: AmvStage): boolean =>
  stage === 'reading' || stage === 'listening';

/* ------------------------------------------------------------------ *
 * Names the document will carry
 * ------------------------------------------------------------------ */

export const AMV_TRACK_NAME = 'Montage AMV';
export const FLASH_TRACK_NAME = 'Flashs';
export const AMV_MUSIC_TRACK_NAME = 'Musique';

/** Beat markers from one run share a colour so they read as a set. */
export const BEAT_COLOR = '#fb7185';
