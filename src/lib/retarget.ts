/**
 * Changing the shape of a whole project.
 *
 * Turning a 16:9 master into a 9:16 one is the edit everybody needs and nobody
 * wants to do by hand: every picture has to be re-cropped, every title has to
 * move and shrink, every banner has to find a new corner — and a camera move
 * computed for a wide frame means nothing in a tall one.
 *
 * This is that edit, as one pure `Project → Project`. The caller commits it
 * inside a single `transact`, so a format shift across two hundred clips is one
 * entry in the history and one press of Ctrl+Z.
 *
 * # What is preserved, and why
 *
 * A framing is carried across as an **anchor** — which point of the source sits
 * at the centre of the frame — and a **vertical extent** — how much of the
 * source's height is on screen. See `lib/geometry`. Those two survive a change
 * of frame; `x = −180 px` does not.
 *
 * Vertical extent rather than horizontal because that is what an editor keeps:
 * going from landscape to portrait you hold the height of the shot and lose the
 * sides. Doing it the other way round would zoom into a stripe.
 *
 * # Animated channels
 *
 * A keyframed channel *replaces* the static field, so retargeting the static
 * one and leaving the curve alone would move nothing at all — the rule that has
 * already cost this codebase two bugs. Curves are therefore retargeted key by
 * key, through exactly the same geometry as the static case.
 *
 * The three transform channels are resampled onto the union of their key times.
 * They have to be: once `scale` changes over time, the clamp on `x` moves with
 * it, so the axes are coupled whether or not the author animated them
 * separately. A channel whose retargeted values turn out not to vary is written
 * back as a static field rather than as a flat curve.
 */

import { uid } from '@/lib/id';
import { bannerAnimation } from '@/lib/bannerLayer';
import { measureBanner, bannerOffset } from '@/lib/bannerPainter';
import {
  cameraOn,
  coverFactor,
  fittedSize,
  retargetCamera,
  type Camera,
} from '@/lib/geometry';
import { evaluateKeyframes, sortKeyframes, type AnimationMap, type Keyframe } from '@/types/animation';
import type { ScreenPoint } from '@/types/geometry';
import type { MediaAsset } from '@/types/media';
import type { Project, ProjectSettings } from '@/types/project';
import type { Clip } from '@/types/timeline';

/** The transform channels a reframe touches. Nothing else moves. */
const CHANNELS = ['scale', 'x', 'y'] as const;

export interface RetargetOptions {
  /**
   * Per-clip anchors, overriding what the clip is currently framed on.
   *
   * Where the crop tool's handle and the AI's Smart Pan both arrive. A clip
   * with no entry keeps whatever it is already looking at, which is the right
   * default: a shot someone has already framed by hand should survive a format
   * change untouched in intent.
   */
  anchors?: Record<string, ScreenPoint>;
  /**
   * Rescale type with the frame.
   *
   * On by default. A 96 px title in a 1080-tall frame is a different thing in a
   * 1920-tall one, and every generated style in this app already expresses
   * itself as a fraction of the frame height for exactly that reason.
   */
  scaleText?: boolean;
}

export interface RetargetOutcome {
  project: Project;
  /** Clips whose transform actually changed. */
  touched: number;
  /** Clips that could not be reframed because their source was never measured. */
  unmeasured: number;
}

/* ------------------------------------------------------------------ *
 * Curves
 * ------------------------------------------------------------------ */

/** Every instant any of the three transform channels has a key at. */
function keyTimes(animation: AnimationMap | undefined): number[] {
  const times = new Set<number>();
  for (const channel of CHANNELS) {
    for (const key of animation?.[channel] ?? []) times.add(key.time);
  }
  return [...times].sort((a, b) => a - b);
}

/**
 * The easing governing `channel` at `time`.
 *
 * A key exactly on the instant owns it; otherwise the segment does, which is
 * the key before it. Resampling onto a union of times would otherwise flatten
 * every eased segment into a linear one, and a camera push would lose its
 * character on the way to a different aspect ratio.
 */
function easingAt(keys: Keyframe[] | undefined, time: number): Keyframe['easing'] {
  if (!keys || keys.length === 0) return { kind: 'linear' };

  let governing = keys[0] as Keyframe;
  for (const key of keys) {
    if (key.time <= time + 1e-9) governing = key;
    else break;
  }
  return { ...governing.easing };
}

/** The clip's framing at one instant, animated channels included. */
function cameraAt(clip: Clip, time: number): Camera {
  return {
    scale: evaluateKeyframes(clip.animation?.scale, time, clip.scale),
    x: evaluateKeyframes(clip.animation?.x, time, clip.x),
    y: evaluateKeyframes(clip.animation?.y, time, clip.y),
  };
}

const varies = (values: number[]): boolean =>
  values.some((value) => Math.abs(value - (values[0] as number)) > 1e-6);

/* ------------------------------------------------------------------ *
 * Per kind
 * ------------------------------------------------------------------ */

/**
 * A media layer: re-crop it, curve and all.
 *
 * The anchor is either the caller's — the crop handle, or the AI's reading of
 * where the action is — or the one the clip is already framed on.
 */
function retargetMedia(
  clip: Clip,
  asset: Pick<MediaAsset, 'width' | 'height'>,
  from: ProjectSettings,
  to: ProjectSettings,
  anchor: ScreenPoint | undefined,
): Clip {
  const fitTo = fittedSize(asset, to);
  if (!fitTo) return clip;

  /** One instant, carried across. */
  const carry = (camera: Camera): Camera => {
    const moved = retargetCamera(camera, asset, from, to);
    if (!anchor) return moved;
    // An explicit anchor overrides where the clip was pointing, but never the
    // zoom it was carried across with — a crop handle chooses a subject, not a
    // focal length.
    return cameraOn(anchor, Math.max(moved.scale, coverFactor(asset, to)), fitTo, to);
  };

  const times = keyTimes(clip.animation);
  const still = carry(cameraAt(clip, 0));

  if (times.length === 0) {
    return { ...clip, scale: still.scale, x: still.x, y: still.y };
  }

  const cameras = times.map((time) => carry(cameraAt(clip, time)));
  const animation: AnimationMap = { ...(clip.animation ?? {}) };

  for (const channel of CHANNELS) {
    const values = cameras.map((camera) => camera[channel]);
    if (!varies(values)) {
      // Flat after the shift — a curve here would only sit in front of the
      // static field for no reason. Same rule the camera generator applies.
      delete animation[channel];
      continue;
    }
    animation[channel] = sortKeyframes(
      times.map((time, index) => ({
        id: uid('kf'),
        time,
        value: values[index] as number,
        easing: easingAt(clip.animation?.[channel], time),
      })),
    );
  }

  const next: Clip = {
    ...clip,
    // The static fields are the fallback the moment a curve is removed, so they
    // are written whether or not the channel ended up animated.
    scale: still.scale,
    x: still.x,
    y: still.y,
  };

  if (Object.keys(animation).length > 0) return { ...next, animation };
  const { animation: _dropped, ...rest } = next;
  return rest as Clip;
}

/**
 * A title: same place in the frame, same size relative to it.
 *
 * Text is not cropped — it is composed — so it moves proportionally rather than
 * through the anchor geometry. A caption three tenths of the way down a
 * landscape frame belongs three tenths of the way down a portrait one.
 */
function retargetText(clip: Clip, ratio: { x: number; y: number }, scaleText: boolean): Clip {
  const scaled = (keys: Keyframe[] | undefined, factor: number): Keyframe[] | undefined =>
    keys && keys.length > 0
      ? keys.map((key) => ({ ...key, id: uid('kf'), value: key.value * factor }))
      : undefined;

  const animation: AnimationMap = { ...(clip.animation ?? {}) };
  const x = scaled(clip.animation?.x, ratio.x);
  const y = scaled(clip.animation?.y, ratio.y);
  if (x) animation.x = x;
  if (y) animation.y = y;

  const next: Clip = {
    ...clip,
    x: Math.round(clip.x * ratio.x),
    y: Math.round(clip.y * ratio.y),
    ...(clip.text && scaleText
      ? {
          text: {
            ...clip.text,
            // Height, not width: every generated style in this app sizes type
            // against the frame height, and a title that tracked the *width*
            // would shrink going to portrait exactly when it needs to grow.
            fontSize: Math.max(8, Math.round(clip.text.fontSize * ratio.y)),
          },
        }
      : {}),
  };

  return Object.keys(animation).length > 0 ? { ...next, animation } : next;
}

/**
 * A banner: recomputed, not scaled.
 *
 * The payoff of storing a banner as fractions of the frame height. Its type,
 * padding and accent bar all resize themselves; all that is needed is to ask
 * where it now hugs its corner, and to rewrite the entrance, whose travel is a
 * fraction of a width that has just changed.
 */
function retargetBanner(clip: Clip, to: ProjectSettings): Clip {
  if (!clip.banner) return clip;

  const metrics = measureBanner(clip.banner, to);
  const offset = bannerOffset(clip.banner, to, metrics);
  const moved: Clip = { ...clip, x: offset.x, y: offset.y };

  // Only rewrite the entrance if there was one: a banner someone has animated
  // by hand, or deliberately left still, keeps what it has.
  const animated = (clip.animation?.x ?? []).length > 0;
  if (!animated) {
    const { animation: _dropped, ...rest } = moved;
    return clip.animation ? (rest as Clip) : moved;
  }

  const animation = bannerAnimation(moved, clip.banner, metrics.width, to.fps);
  if (!animation) {
    const { animation: _dropped, ...rest } = moved;
    return rest as Clip;
  }
  return { ...moved, animation };
}

/* ------------------------------------------------------------------ *
 * The whole document
 * ------------------------------------------------------------------ */

/**
 * Re-frames every layer for `settings`, and moves the project to it.
 *
 * Pure, and total: a clip it cannot reframe — an unmeasured source, a generated
 * background that fills the frame by definition — is returned untouched and
 * counted, rather than moved to a position invented from nothing.
 */
export function retargetProject(
  project: Project,
  settings: ProjectSettings,
  options: RetargetOptions = {},
): RetargetOutcome {
  const from = project.settings;
  const to: ProjectSettings = {
    width: Math.max(2, Math.round(settings.width)),
    height: Math.max(2, Math.round(settings.height)),
    // Reframing is a spatial edit; changing the rate would resample every
    // keyframe time as well, which is a different operation with its own risks.
    fps: from.fps,
  };

  const ratio = { x: to.width / Math.max(1, from.width), y: to.height / Math.max(1, from.height) };
  const scaleText = options.scaleText ?? true;
  const anchors = options.anchors ?? {};

  let touched = 0;
  let unmeasured = 0;

  const clips = project.clips.map((clip) => {
    if (clip.kind === 'background') return clip;

    if (clip.kind === 'banner') {
      const next = retargetBanner(clip, to);
      if (next !== clip) touched += 1;
      return next;
    }

    if (clip.kind === 'text') {
      const next = retargetText(clip, ratio, scaleText);
      touched += 1;
      return next;
    }

    const asset = project.assets.find((item) => item.id === clip.assetId);
    if (!asset || !asset.width || !asset.height) {
      // Audio has no picture and nothing to reframe; a video whose dimensions
      // were never probed is a genuine gap, and the caller is told about it.
      if (asset && asset.kind !== 'audio') unmeasured += 1;
      return clip;
    }

    const next = retargetMedia(clip, asset, from, to, anchors[clip.id]);
    touched += 1;
    return next;
  });

  return {
    project: { ...project, settings: to, clips },
    touched,
    unmeasured,
  };
}

/**
 * The framing one clip would get, without committing anything.
 *
 * What the crop overlay draws while the handle is being dragged: the same
 * geometry the real edit will use, so the preview is not an approximation of
 * the result but the result itself.
 */
export function previewFraming(
  clip: Clip,
  asset: Pick<MediaAsset, 'width' | 'height'>,
  from: ProjectSettings,
  to: ProjectSettings,
  anchor?: ScreenPoint,
): Camera | null {
  const fitTo = fittedSize(asset, to);
  if (!fitTo) return null;

  const carried = retargetCamera(cameraAt(clip, 0), asset, from, to);
  if (!anchor) return carried;
  return cameraOn(anchor, Math.max(carried.scale, coverFactor(asset, to)), fitTo, to);
}
