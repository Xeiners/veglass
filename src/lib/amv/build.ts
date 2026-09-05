/**
 * Turning a set of beats into an edit.
 *
 * A pure `Project → Project`, like every other generator in the suite. Here the
 * reason is at its sharpest yet: one run writes a music clip, sixty to four
 * hundred shot clips each carrying its own camera curve, a stack of flash
 * layers, a set of cross-dissolves and a ruler full of markers. That is one
 * operation as far as anyone using it is concerned, so it has to be one entry
 * in the history and one press of Ctrl+Z.
 *
 * Nothing here touches the network, the disk or a store. The caller has already
 * resolved every source into a real `MediaAsset` — with a path, a probed
 * duration and a `src` the preview can play — because that resolution is
 * asynchronous, and a function that has to await cannot be folded into a
 * transaction.
 *
 * # The arc
 *
 * Every decision below is taken **through a phase**. The structure read in
 * `lib/amv/structure` says which movement a moment belongs to, and the phase
 * spec in `types/amv` says what that movement does to the profile's numbers —
 * how long a shot runs, how firm a beat has to be to earn a cut, how far the
 * camera travels, whether the shock effects are allowed to fire at all.
 *
 * Without it this file cut every beat as hard as every other, which is a
 * texture rather than an edit: an opening that is already at full intensity has
 * nowhere to go, and by the time the actual drop arrives the viewer has been
 * looking at maximum for a minute. The dials are the same ones as before; what
 * changed is that they are now a function of *when*.
 *
 * # Parity
 *
 * Nothing in this file invents a way of drawing anything. A punch is keyframes
 * on `scale`, which the preview evaluates and the encoder samples into an
 * ffmpeg expression. A veil is a generated background, which the same painter
 * draws for the viewer and for the bake. A negative is the `invert` effect,
 * whose two mappings are pinned character for character by a test in Rust. The
 * chromatic split and the smear are keyframed effect parameters, drawn as SVG
 * filters in the viewer and as `rgbashift` and `gblur` in the encoder — the
 * same offsets and the same standard deviations, in the same pixels, with the
 * directions read off the binary rather than assumed. The resting framing comes
 * from `lib/geometry`. There is no fourth renderer here to fall out of step
 * with the other three.
 */

import { uid } from '@/lib/id';
import { coverFactor } from '@/lib/geometry';
import { snapToFrame } from '@/lib/time';
import { namedTrack, withTrack } from '@/lib/tracks';
import { backdropPreset } from '@/types/backdrop';
import { backgroundDescriptor } from '@/types/background';
import {
  effectChannel,
  presetEasing,
  type AnimationMap,
  type Easing,
  type Keyframe,
} from '@/types/animation';
import type { Effect } from '@/types/effects';
import type { Marker } from '@/types/marker';
import type { MediaAsset } from '@/types/media';
import type { Project } from '@/types/project';
import {
  MIN_TRANSITION_DURATION,
  type Transition,
} from '@/types/transitions';
import { MIN_CLIP_DURATION, clipEnd, type Clip } from '@/types/timeline';
import {
  AMV_LIMITS,
  AMV_MUSIC_TRACK_NAME,
  AMV_TRACK_NAME,
  BEAT_COLOR,
  FLASH_TRACK_NAME,
  FLOAT_SCALE,
  PHASE_MAP,
  amvProfile,
  flashThreshold,
  type PhaseSpec,
  type AmvOptions,
  type AmvProfile,
  type FlashSpec,
  type PhaseId,
  type PunchSpec,
  type SmearSpec,
  type SplitSpec,
} from '@/types/amv';
import { createPicker } from './sources';
import { phaseAt, type Structure } from './structure';
import type { Beat } from './beats';

/* ------------------------------------------------------------------ *
 * Shots
 * ------------------------------------------------------------------ */

export interface Shot {
  /** Seconds from the start of the montage. */
  at: number;
  duration: number;
  /**
   * The beat this shot opens on, or `null` when nothing did.
   *
   * `null` on the opening shot — a track rarely strikes on its first sample —
   * and on a shot the length cap forced out of a quiet passage. Both are real
   * cuts and neither is an impact, so neither gets a bump or a flash.
   */
  beat: Beat | null;
  /** The movement it falls in, carried so the placement need not look it up. */
  phase: PhaseId;
}

/**
 * Where the cuts fall.
 *
 * Beats come in; a contiguous run of shots covering `[0, span)` comes out. Four
 * rules, and every one of them exists because the naive version — a cut on
 * every beat — produces something unwatchable on real music:
 *
 * * A beat too weak to matter carries no cut. `cutStrength` is the profile's
 *   own floor, over and above the detector's.
 * * `beatsPerCut` thins the rest. A cinematic profile cutting on every hi-hat
 *   would not be cinematic.
 * * A cut closer than `minShot` to the last one is passed over, not honoured.
 *   Two frames of picture is a glitch, and a drum fill is full of them.
 * * A passage with no beat at all is cut anyway once `maxShot` is up, because a
 *   twelve-second held shot in the middle of a montage reads as a stall.
 *
 * Pure, and separated from the placement below so the review step can count the
 * shots the current answers would give before anything is written.
 */
export function planShots(
  beats: Beat[],
  profile: AmvProfile,
  span: number,
  structure: Structure,
  phases: Record<PhaseId, PhaseSpec> = PHASE_MAP,
): Shot[] {
  if (span <= 0) return [];

  const shots: Shot[] = [];
  let cursor = 0;
  let opening: Beat | null = null;

  const specAt = (time: number) => phases[phaseAt(structure, time)];

  const emit = (until: number, next: Beat | null) => {
    // The cap belongs to the movement the shot *starts* in, and is re-read on
    // every split: a held passage that runs from the opening into the build
    // should tighten as it crosses, not keep the opening's patience throughout.
    let spec = specAt(cursor);
    let cap = profile.maxShot * spec.pace;

    while (until - cursor > cap + 1e-6) {
      shots.push({ at: cursor, duration: cap, beat: opening, phase: spec.id });
      cursor += cap;
      // A shot the cap produced opens on nothing: there was no beat there.
      opening = null;
      spec = specAt(cursor);
      cap = profile.maxShot * spec.pace;
    }

    shots.push({ at: cursor, duration: until - cursor, beat: opening, phase: spec.id });
    cursor = until;
    opening = next;
  };

  let sinceCut = 0;
  for (const beat of beats) {
    if (beat.at <= 0 || beat.at >= span) continue;

    const spec = specAt(beat.at);
    // The profile's floor plus the movement's own. An opening keeps only what
    // is unmistakably an accent; a drop keeps whatever survived detection.
    if (beat.strength < profile.cutStrength + spec.cutFloor) continue;

    sinceCut += 1;
    if (sinceCut < Math.max(1, Math.round(profile.beatsPerCut * spec.thinning))) continue;
    // Deliberately no reset here: a beat passed over for being too soon leaves
    // the counter armed, so the *next* one cuts rather than waiting out another
    // full group. Resetting would turn one skipped beat into a double-length
    // shot every time a fill goes past.
    if (beat.at - cursor < profile.minShot * spec.pace) continue;
    sinceCut = 0;
    emit(beat.at, beat);
  }

  const tail = span - cursor;
  if (tail > 1e-3) {
    const last = shots[shots.length - 1];
    // A tail too short to stand on its own is given to the shot before it.
    // Leaving it would put a two-frame flicker at the end of every montage.
    if (last && tail < profile.minShot * specAt(cursor).pace) last.duration += tail;
    else emit(span, null);
  }

  return shots;
}

/* ------------------------------------------------------------------ *
 * The camera bump
 * ------------------------------------------------------------------ */

/**
 * A copy of an easing, so the document never shares one with a profile.
 *
 * The profiles are module-level constants. Handing their easing objects
 * straight to a keyframe would mean a curve dragged in the graph editor
 * silently rewriting the profile — and every montage built afterwards, in every
 * project, for the rest of the session.
 */
const copyEasing = (easing: Easing): Easing =>
  easing.bezier ? { kind: easing.kind, bezier: [...easing.bezier] } : { kind: easing.kind };

/**
 * The scale curve for one shot: out to the peak, then back with a recoil.
 *
 * Three keyframes, and the shape is the whole effect. The middle one carries
 * the release easing because a keyframe governs the segment that *starts* at
 * it, so an overshooting curve there is what takes the scale a shade under rest
 * before it settles — the small elastic kick a hand-keyed bump has.
 *
 * The bump is squeezed to fit rather than clipped. On a short shot the honest
 * failure mode of clipping would be a camera parked at 115 % when the cut
 * arrives, so both halves shrink in proportion and the gesture survives at
 * whatever size there is room for. Under two frames there is no room at all,
 * and the shot simply does not bump.
 *
 * The squeeze is worked in **whole frames**. Two halves rounded independently
 * can each round up and overflow a shot they jointly fitted in — and on the
 * fastest profile that is not an edge case but every shot, because there the
 * gesture is already longer than the shot it has to happen inside. Splitting an
 * integer budget cannot overflow, so the fast profile keeps its punch.
 */
export function punchCurve(
  rest: number,
  duration: number,
  spec: PunchSpec,
  fps: number,
): Keyframe[] | null {
  const rate = Math.max(1, fps);
  const room = Math.floor(duration * rate + 1e-6);
  const wanted = spec.attack + spec.release;
  // One frame out and one back is the shortest thing that is still a movement.
  if (room < 2 || wanted <= 0) return null;

  const budget = Math.min(room, Math.max(2, Math.round(wanted * rate)));
  // At least a frame each way, and never the whole budget for one half.
  const attack = Math.max(1, Math.min(budget - 1, Math.round((budget * spec.attack) / wanted)));

  return [
    { id: uid('kf'), time: 0, value: rest, easing: copyEasing(spec.attackEasing) },
    {
      id: uid('kf'),
      time: attack / rate,
      value: rest * spec.amount,
      easing: copyEasing(spec.releaseEasing),
    },
    { id: uid('kf'), time: budget / rate, value: rest, easing: { kind: 'linear' } },
  ];
}

/** Fresh ids for a curve copied onto another clip — two clips, two sets. */
const cloneAnimation = (animation: AnimationMap): AnimationMap =>
  Object.fromEntries(
    Object.entries(animation).map(([channel, keyframes]) => [
      channel,
      keyframes.map((keyframe) => ({
        ...keyframe,
        id: uid('kf'),
        easing: copyEasing(keyframe.easing),
      })),
    ]),
  );

/* ------------------------------------------------------------------ *
 * The impact effects
 * ------------------------------------------------------------------ */

/**
 * How an impact falls away.
 *
 * Chosen by measuring it rather than by ear, because the whole gesture is three
 * or four frames long and the curve decides whether any of them past the first
 * are visible at all. Over three frames from a peak of 16, the candidates give:
 *
 * ```
 * linear     16.0  10.7   5.3   0
 * sine-out   16.0   8.1   2.2   0
 * expo-out   16.0   1.6   0.1   0
 * ```
 *
 * `expo-out` — the obvious choice for something that should snap away, and what
 * this was first written as — spends 90 % of the travel inside the first frame,
 * which makes the effect a single-frame flicker with two frames of nothing
 * after it. `linear` is still half on at the last frame and reads as softness
 * rather than as impact. `sine-out` is the one that is unmistakable on the cut,
 * clearly present on the frame after, and gone by the third.
 */
const IMPACT_DECAY = 'sine-out';

/**
 * A parameter that lands at full on the cut and falls back to nothing.
 *
 * The shape both impact effects share, and the reason they are keyframes rather
 * than a constant on a short clip: the encoder plays them by laying gated
 * copies of the filter end to end (see `stepped_filters` in `engine::ffmpeg`),
 * so a curve costs one segment instead of four, and the viewer reads the same
 * curve through `resolveClipAt`. One description, two renderers.
 *
 * Worked in whole frames, like the punch, and for the same reason — two halves
 * rounded apart can overflow a shot they jointly fitted in.
 *
 * Cleared inside the shot rather than at its edge: a smear still on screen when
 * the picture changes does not read as a smear, it reads as a soft image.
 */
function decayCurve(
  peak: number,
  duration: number,
  decay: number,
  fps: number,
): Keyframe[] | null {
  const rate = Math.max(1, fps);
  const room = Math.floor(duration * rate + 1e-6);
  if (peak <= 0 || decay <= 0 || room < 2) return null;

  const frames = Math.max(1, Math.min(Math.round(decay * rate), Math.floor(room * 0.6)));

  return [
    { id: uid('kf'), time: 0, value: peak, easing: presetEasing(IMPACT_DECAY) },
    { id: uid('kf'), time: frames / rate, value: 0, easing: { kind: 'linear' } },
  ];
}

/**
 * An impact effect, as a neutral instance plus the curve that drives it.
 *
 * The static parameter is left at **zero**, deliberately. It is what every path
 * that does not read the animation falls back to — the browser build's render
 * plan, a document whose curve was later deleted, the encoder's own fallback
 * when a curve changes too often to gate. A resting value of "full split" would
 * turn each of those into a montage stuck at maximum aberration from beginning
 * to end; a resting value of nothing degrades to a clean picture.
 */
function impactEffect(
  kind: 'rgbsplit' | 'motionblur',
  spec: { amount: number; angle: number; decay: number },
  duration: number,
  fps: number,
): { effect: Effect; channel: string; curve: Keyframe[] } | null {
  const curve = decayCurve(spec.amount, duration, spec.decay, fps);
  if (!curve) return null;

  const id = uid('fx');
  return {
    effect: { id, kind, enabled: true, params: { amount: 0, angle: spec.angle } },
    channel: effectChannel(id, 'amount'),
    curve,
  };
}

/* ------------------------------------------------------------------ *
 * The flashes
 * ------------------------------------------------------------------ */

/** The veil's decay. Fast off the mark, with a short tail — a flash, not a fade. */
const VEIL_DECAY = 'expo-out';

/**
 * A flat colour laid over the montage, fading out.
 *
 * A generated background rather than anything bespoke, so the veil inherits the
 * whole parity chain for nothing: the painter fills the frame for the viewer,
 * the bake calls the same painter once per output frame, and the encoder
 * overlays the PNGs it gets. See `types/background`, kind `solid`.
 */
function veilClip(trackId: string, at: number, spec: FlashSpec, fps: number): Clip {
  const duration = snapToFrame(Math.max(MIN_CLIP_DURATION, spec.duration), fps);

  return {
    id: uid('cl'),
    kind: 'background',
    assetId: null,
    trackId,
    start: at,
    duration,
    offset: 0,
    volume: 1,
    /*
     * Held at 1 while the curve does the work.
     *
     * The bake draws each frame at the opacity the curve resolves to, and the
     * encoder then applies the *static* field on top of the PNG it receives. A
     * static 0.88 here would be applied twice — once in the pixels, once in the
     * graph — and the flash would reach the file at three-quarters of the veil
     * it is in the viewer. Every generated layer in this codebase animates
     * opacity the same way; see `lib/bannerLayer`.
     */
    opacity: 1,
    scale: 1,
    x: 0,
    y: 0,
    rotation: 0,
    muted: true,
    label: 'Flash',
    effects: [],
    background: {
      ...backgroundDescriptor('solid').preset,
      base: spec.color,
      // A flat colour has no layout to lay out, so the seed drives nothing. It
      // is a constant rather than the usual random number so that two runs of
      // the same montage produce identical documents.
      seed: 1,
    },
    animation: {
      opacity: [
        { id: uid('kf'), time: 0, value: spec.opacity, easing: presetEasing(VEIL_DECAY) },
        { id: uid('kf'), time: duration, value: 0, easing: { kind: 'linear' } },
      ],
    },
  };
}

/**
 * The shot itself, inverted, for its own first frames.
 *
 * A second clip rather than an effect on the first, and the reason is in the
 * encoder: ffmpeg builds a `lutrgb` table once at initialisation and gives it
 * no `t` to be a function of, so an inversion that came and went *inside* one
 * clip would animate in the preview and stay on for the whole clip in the
 * render. Two clips, each at a constant dosage, are identical in both.
 *
 * It carries the shot's transform and its curve verbatim. Keyframes are
 * clip-relative and this starts exactly where the shot starts, so the same
 * numbers mean the same values and the negative punches in step with the
 * picture underneath instead of sitting still on top of a moving frame. That is
 * also why an inversion only ever fires on a beat that *opens* a shot.
 */
function negativeClip(shot: Clip, trackId: string, duration: number, fps: number): Clip {
  const { backdrop: _glass, ...bare } = shot;

  return {
    ...bare,
    id: uid('cl'),
    trackId,
    duration: Math.max(MIN_CLIP_DURATION, snapToFrame(duration, fps)),
    label: 'Négatif',
    /*
     * The shot's own stack, with the inversion on the end.
     *
     * Keeping it was not optional once the impact effects arrived. This clip
     * sits *over* the shot for the frames it lasts, so a bare inversion would
     * hide the smear and the split for exactly the two frames they are at full
     * strength — the impact effects would switch off on precisely the beats
     * that earned them, and come back at a tenth of their size afterwards.
     *
     * The effect objects are carried over by reference, so their ids still
     * match the channels `cloneAnimation` copies, and inverting last means the
     * fringes are inverted along with the picture that has them.
     */
    effects: [
      ...shot.effects,
      { id: uid('fx'), kind: 'invert', enabled: true, params: { amount: 1 } },
    ],
    // The glass is dropped with the rest of the backdrop: it is drawn behind the
    // picture, so an inverted copy laid over the top would cover the frame and
    // leave the surround untouched — a rectangle of negative rather than a
    // negative frame.
    ...(shot.animation ? { animation: cloneAnimation(shot.animation) } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * The assembly
 * ------------------------------------------------------------------ */

export interface AmvBuild {
  project: Project;
  /** Where the montage landed on the timeline, in seconds. */
  start: number;
  /** Seconds of montage written. */
  duration: number;
  shots: number;
  punches: number;
  flashes: number;
  inverts: number;
  splits: number;
  smears: number;
  dissolves: number;
  markers: number;
  /** Shots laid down in each movement, for the run summary. */
  byPhase: Record<PhaseId, number>;
  /** Shots whose source ran out before the beat did. */
  short: number;
}

const EMPTY_BUILD = {
  duration: 0,
  shots: 0,
  punches: 0,
  flashes: 0,
  inverts: 0,
  splits: 0,
  smears: 0,
  dissolves: 0,
  markers: 0,
  short: 0,
} as const;

const noPhases = (): Record<PhaseId, number> => ({ intro: 0, build: 0, drop: 0 });

/**
 * Places a whole rhythmic montage in the open project.
 *
 * The montage goes on its own track, after whatever is already there — the same
 * queuing rule the viral and tutorial passes use, and for the same reason:
 * overlapping would silently hide one behind the other.
 *
 * Cuts land on the frame nearest their beat. They cannot land closer: a cut
 * between two frames is not a thing an edit can express, and at 30 fps the
 * nearest frame is within seventeen milliseconds of the transient — comfortably
 * inside the window where a picture change reads as simultaneous with a sound.
 * The measurement is five times finer than that, so nothing is lost to the
 * analysis; the frame grid is the whole of the rounding.
 */
export function placeAmv(
  project: Project,
  music: MediaAsset,
  sources: MediaAsset[],
  beats: Beat[],
  options: AmvOptions,
  structure: Structure,
  /**
   * The movements this run works from.
   *
   * Defaults to the registry's own. The director passes a tuned copy, measured
   * off a reference edit — which is the whole of how "copy that video's pacing"
   * reaches the sequencer: not as a special mode, but as different numbers in
   * the same three slots.
   */
  phases: Record<PhaseId, PhaseSpec> = PHASE_MAP,
): AmvBuild {
  const { fps } = project.settings;
  const profile = amvProfile(options.profile);

  /* ---- 1. Where it goes ---- */

  const montage = namedTrack(project, AMV_TRACK_NAME, 'video');
  const at = snapToFrame(
    project.clips
      .filter((clip) => clip.trackId === montage.track.id)
      .reduce((furthest, clip) => Math.max(furthest, clipEnd(clip)), 0),
    fps,
  );

  const span = Math.min(
    music.duration > 0 ? music.duration : AMV_LIMITS.maxMontage,
    options.limit > 0 ? options.limit : AMV_LIMITS.maxMontage,
    AMV_LIMITS.maxMontage,
  );

  const shots = planShots(beats, profile, span, structure, phases);
  const pick = createPicker(sources, options.seed, options.roles, options.opening);
  if (shots.length === 0) {
    return { project, start: at, ...EMPTY_BUILD, byPhase: noPhases() };
  }

  /* ---- 2. The shots ---- */

  const clips: Clip[] = [];
  let punches = 0;
  let splits = 0;
  let smears = 0;
  let short = 0;

  const splitSpec: SplitSpec | null = options.split ? profile.split : null;
  const smearSpec: SmearSpec | null = options.smear ? profile.smear : null;
  const byPhase = noPhases();
  // The last split, so the spacing rule has something to measure against. A
  // drop is a run of beats that are all near the top; the threshold alone would
  // let every one of them through.
  let lastSplit = Number.NEGATIVE_INFINITY;

  for (const shot of shots) {
    // Boundaries are snapped, never durations. Snapping each length on its own
    // lets rounding accumulate, and by the fortieth cut the picture is a frame
    // adrift of the music; snapping the cuts themselves keeps every shot butted
    // against its neighbours and every one of them on its own beat. The ripple
    // delete makes the same choice, for the same reason.
    const from = snapToFrame(at + shot.at, fps);
    const to = snapToFrame(at + shot.at + shot.duration, fps);
    const wanted = Math.max(MIN_CLIP_DURATION, to - from);

    const source = pick(wanted, shot.phase);
    if (!source) break;

    if (source.available + 1e-6 < wanted) short += 1;
    const duration = Math.max(MIN_CLIP_DURATION, Math.min(wanted, source.available));

    /*
     * The resting framing, not the identity.
     *
     * `scale = 1` means *contained*, which is right only when the clip and the
     * project are the same shape. Drop a 16:9 source into a 9:16 montage and
     * containing it gives a strip of picture between two black bars — so a
     * covering profile rests at whatever fills the frame, which `lib/geometry`
     * already knows how to work out. A floating one rests inset on purpose:
     * the margin is what the glass behind it fills.
     */
    const rest =
      profile.frame === 'cover' ? coverFactor(source.asset, project.settings) : FLOAT_SCALE;

    const phase = phases[shot.phase];
    byPhase[shot.phase] += 1;

    /*
     * The movement scales the bump's *travel*, not its scale.
     *
     * `amount` is a multiple of the resting framing, so halving it would halve
     * the picture rather than the gesture. What a build wants is half the
     * distance travelled — 1.15 at 0.5 is 1.075 — which is the same number
     * measured from rest instead of from zero.
     */
    const bump: PunchSpec = {
      ...profile.punch,
      amount: 1 + (profile.punch.amount - 1) * phase.punch,
    };
    const punch =
      options.punch &&
      phase.punch > 0 &&
      shot.beat &&
      shot.beat.strength >= profile.punch.threshold
        ? punchCurve(rest, duration, bump, fps)
        : null;
    if (punch) punches += 1;

    /*
     * The impact stack, in the order it composes.
     *
     * Smear first, split second. Blurring a fringe softens the one thing that
     * makes the aberration legible, while splitting an already-smeared frame
     * leaves the fringes crisp against it — which is the way round that reads
     * as a lens under stress rather than as a soft image with a colour cast.
     *
     * Both hang on the shot clip itself rather than on a copy of it. The
     * negative flash needs its own clip because `lutrgb` builds its table once
     * and cannot be gated part-way through one; these two are gated by the
     * encoder frame by frame, so they cost no extra segment.
     */
    const effects: Effect[] = [];
    const animation: AnimationMap = { ...(punch ? { scale: punch } : {}) };

    const smear =
      smearSpec && phase.smear > 0
        ? impactEffect(
            'motionblur',
            { ...smearSpec, amount: smearSpec.amount * phase.smear },
            duration,
            fps,
          )
        : null;
    if (smear) {
      effects.push(smear.effect);
      animation[smear.channel] = smear.curve;
      smears += 1;
    }

    /*
     * Three conditions, and all three are the brief's "moins, c'est mieux".
     *
     * The movement has to allow shock at all — only the drop does. The beat has
     * to be near the top of the track. And enough time has to have passed since
     * the last one: a drop is a run of beats that are *all* near the top, so a
     * strength bar on its own lets the whole bar through and the aberration
     * stops being an event and becomes the grade.
     */
    const hitHard = shot.beat !== null && shot.beat.strength >= (splitSpec?.threshold ?? 1);
    const spaced = from - lastSplit >= (splitSpec?.spacing ?? 0);
    const split =
      splitSpec && phase.shock && hitHard && spaced
        ? impactEffect('rgbsplit', splitSpec, duration, fps)
        : null;
    if (split) {
      effects.push(split.effect);
      animation[split.channel] = split.curve;
      lastSplit = from;
      splits += 1;
    }

    clips.push({
      id: uid('cl'),
      kind: 'media',
      assetId: source.asset.id,
      trackId: montage.track.id,
      start: from,
      duration,
      offset: source.offset,
      volume: 1,
      opacity: 1,
      scale: rest,
      x: 0,
      y: 0,
      rotation: 0,
      // The music is the soundtrack. A hundred shots each bringing their own
      // dialogue and effects in for a fifth of a second is noise, not sound.
      muted: true,
      label: source.asset.name,
      effects,
      // `undefined` is the signal the rest of the editor tests for; an explicit
      // `animation: undefined` key would serialise as `null` and defeat it.
      ...(Object.keys(animation).length > 0 ? { animation } : {}),
      ...(profile.frame === 'float' ? { backdrop: backdropPreset('glass').backdrop } : {}),
    });
  }

  /* ---- 3. The flashes ---- */

  const flash = options.flashes ? profile.flash : null;
  const flashes: Clip[] = [];
  let inverts = 0;

  // Resolved before the loop so the clips can name their track directly.
  // Working it out costs nothing and writes nothing — whether the track ends up
  // in the document is decided further down, by whether anything went on it.
  const flashTrack = namedTrack(project, FLASH_TRACK_NAME, 'video');

  if (flash) {
    // Two budgets, because the two accents are not the same size. A negative
    // also spends the veil's, since it is the louder of the two events and two
    // flashes on neighbouring frames read as one botched one.
    let lastVeil = Number.NEGATIVE_INFINITY;
    let lastInvert = Number.NEGATIVE_INFINITY;

    for (const beat of beats) {
      if (beat.at >= span) continue;

      // Read at the beat rather than taken from a shot: on a profile that cuts
      // every other beat the impacts in between are still impacts, and a
      // montage that only ever flashes on a cut throws half of them away.
      const phase = phases[phaseAt(structure, beat.at)];
      if (phase.flash <= 0) continue;
      if (beat.strength < flashThreshold(flash.threshold, phase)) continue;

      const on = snapToFrame(at + beat.at, fps);

      /*
       * An inversion is a shock effect, so it belongs to the drop alone, it has
       * to clear the higher bar, and it has to have waited its own gap. It must
       * also sit on a clip that *starts* with it — see `negativeClip` — so a
       * beat falling mid-shot cannot have one.
       *
       * A beat that wanted a negative and could not have one falls through to
       * the veil below rather than being dropped: the moment is still worth
       * marking, just with the cheaper accent.
       */
      const wants =
        phase.shock &&
        flash.invertThreshold !== null &&
        beat.strength >= flash.invertThreshold &&
        on - lastInvert >= flash.invertSpacing;
      const opened = wants ? clips.find((clip) => Math.abs(clip.start - on) < 1e-6) : null;

      if (opened) {
        flashes.push(negativeClip(opened, flashTrack.track.id, flash.invertDuration, fps));
        lastInvert = on;
        lastVeil = on;
        inverts += 1;
      } else {
        if (on - lastVeil < flash.spacing) continue;
        lastVeil = on;
        flashes.push(
          veilClip(
            flashTrack.track.id,
            on,
            { ...flash, opacity: flash.opacity * phase.flash },
            fps,
          ),
        );
      }
    }
  }

  /* ---- 4. The music ---- */

  const musicTrack = namedTrack(project, AMV_MUSIC_TRACK_NAME, 'audio');
  const musicClip: Clip = {
    id: uid('cl'),
    kind: 'media',
    assetId: music.id,
    trackId: musicTrack.track.id,
    start: at,
    duration: Math.max(MIN_CLIP_DURATION, snapToFrame(span, fps)),
    offset: 0,
    volume: 1,
    opacity: 1,
    scale: 1,
    x: 0,
    y: 0,
    rotation: 0,
    muted: false,
    label: music.name,
    effects: [],
  };

  /* ---- 5. Everything lands ---- */

  let tracks = withTrack(project.tracks, montage.created ? montage.track : null);
  // Prepended *after* the montage track, so it lands above it — list order is
  // compositing order, and a veil under the picture it veils is no veil at all.
  // Only when something is actually on it: a profile with no flashes should not
  // leave an empty track behind.
  tracks = withTrack(
    tracks,
    flashTrack.created && flashes.length > 0 ? flashTrack.track : null,
  );
  tracks = withTrack(tracks, musicTrack.created ? musicTrack.track : null);

  /* ---- 6. Dissolves ---- */

  const transitions: Transition[] = [];
  if (profile.dissolve > 0) {
    for (let index = 0; index < clips.length - 1; index += 1) {
      const from = clips[index];
      const to = clips[index + 1];
      const source = sources.find((asset) => asset.id === from.assetId);

      /*
       * A dissolve borrows material either side of the cut, and the handle
       * available in the source is what actually limits it: the outgoing clip
       * has to keep playing past its out-point, and the incoming one has to
       * start before its in-point. Asking for more than either can give would
       * make the encoder freeze a frame and say so in a warning — so the window
       * is capped at what both can genuinely supply.
       */
      const tail = source ? Math.max(0, source.duration - (from.offset + from.duration)) : 0;
      const window = Math.min(
        profile.dissolve,
        from.duration / 2,
        to.duration / 2,
        to.offset,
        tail,
      );
      if (window < MIN_TRANSITION_DURATION) continue;

      transitions.push({
        id: uid('tx'),
        kind: 'crossfade',
        trackId: montage.track.id,
        fromClipId: from.id,
        toClipId: to.id,
        duration: snapToFrame(window, fps),
      });
    }
  }

  /* ---- 7. Markers ---- */

  const markers: Marker[] = options.markers
    ? clips.slice(0, AMV_LIMITS.maxMarkers).map((clip, index) => ({
        id: uid('mk'),
        time: clip.start,
        label: `Temps ${index + 1}`,
        color: BEAT_COLOR,
      }))
    : [];

  const last = clips[clips.length - 1];
  const next: Project = {
    ...project,
    tracks,
    clips: [...project.clips, ...clips, ...flashes, musicClip],
    transitions: [...project.transitions, ...transitions],
    ...(markers.length > 0 ? { markers: [...(project.markers ?? []), ...markers] } : {}),
  };

  return {
    project: next,
    start: at,
    duration: last ? clipEnd(last) - at : 0,
    shots: clips.length,
    punches,
    flashes: flashes.length - inverts,
    inverts,
    splits,
    smears,
    byPhase,
    dissolves: transitions.length,
    markers: markers.length,
    short,
  };
}
