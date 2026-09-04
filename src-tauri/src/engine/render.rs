//! Timeline → render plan.
//!
//! This is the seam the encoder plugs into. Flattening the document into an
//! ordered segment list plus a transition schedule is the part that must agree
//! exactly with the editor's semantics, so it lives here in Rust; an ffmpeg or
//! Python backend then only has to consume `RenderPlan` and never has to reason
//! about tracks, trims, filter chains or layer order.

use std::collections::HashMap;

use serde::Serialize;

use super::effects::effect_filters;
use crate::model::{
    Backdrop, Breakpoint, Clip, Effect, ProgressBar, Project, SampledChannels, TrackAudio,
    Transition,
};

/// Two edges are the same junction when they sit within this many seconds.
const JUNCTION_EPSILON: f64 = 1e-3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSegment {
    pub track_name: String,
    /// `video` | `audio`
    pub kind: String,
    /// Compositing order — lower is nearer the viewer.
    pub layer: usize,
    pub source: String,
    pub source_path: Option<String>,
    pub timeline_in: f64,
    pub timeline_out: f64,
    pub source_in: f64,
    /// Which bus this segment feeds.
    pub track_id: String,
    /// Where the segment actually starts contributing, once a cross-dissolve has
    /// pulled it into its neighbour's handle. Equals `timeline_in` without one.
    pub render_in: f64,
    pub render_out: f64,
    /// Alpha ramps, in seconds relative to `render_in`. Zero means no ramp.
    pub fade_in_start: f64,
    pub fade_in: f64,
    pub fade_out_start: f64,
    pub fade_out: f64,
    pub volume: f64,
    pub opacity: f64,
    pub scale: f64,
    /// Offset from the frame centre and rotation, in project pixels / degrees.
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
    /// A single frame held for the clip's duration rather than a moving source.
    pub is_still: bool,
    /// Whether the layer is fitted to the frame (video) or kept at its natural
    /// size (stills, text, logos) — the difference between a background and an
    /// overlay.
    pub conform: bool,
    /// Text layers and SVG need rasterising by the front-end before ffmpeg can
    /// read them; `source_path` is then the baked PNG.
    pub needs_bake: bool,
    /// `source_path` is a numbered image sequence rather than a single file.
    pub is_sequence: bool,
    /// Sampled animation channels, clip-relative. Empty when nothing moves.
    pub animated: HashMap<String, Vec<Breakpoint>>,
    /// The clip's filter stack, echoed so the encoder can re-derive if needed.
    pub effects: Vec<Effect>,
    /// That stack already mapped to ffmpeg fragments, in order.
    pub filters: Vec<String>,
    /// Which of a backdropped clip's three passes this segment is.
    ///
    /// `clip` for an ordinary layer. A clip carrying a backdrop expands into
    /// three segments sharing one source and one layer — `backdrop`, `shadow`,
    /// `clip` — pushed in that order, which is the order they are drawn in.
    pub role: String,
    /// The backdrop's parameters, carried by all three of its segments.
    pub backdrop: Option<Backdrop>,
}

/// The three passes a floating layer is drawn in, bottom to top.
pub const ROLE_BACKDROP: &str = "backdrop";
pub const ROLE_SHADOW: &str = "shadow";
pub const ROLE_CLIP: &str = "clip";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionPlan {
    pub kind: String,
    pub track_name: String,
    /// Absolute window on the timeline.
    pub start: f64,
    pub end: f64,
    pub duration: f64,
    pub from_source: Option<String>,
    pub to_source: Option<String>,
    /// Filtergraph fragment the encoder splices in.
    pub ffmpeg: String,
}

/// One mixing bus — the track, with everything that applies to its sum.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackBus {
    pub id: String,
    pub name: String,
    pub kind: String,
    /// Already resolved: a track silenced by someone else's solo is muted here.
    pub muted: bool,
    pub volume: f64,
    pub pan: f64,
    pub high_pass: f64,
    pub low_pass: f64,
    pub compressor: Option<CompressorPlan>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressorPlan {
    pub threshold_db: f64,
    pub ratio: f64,
    pub makeup_db: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPlan {
    pub project_name: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration: f64,
    pub frame_count: u64,
    pub segments: Vec<RenderSegment>,
    pub tracks: Vec<TrackBus>,
    pub transitions: Vec<TransitionPlan>,
    pub warnings: Vec<String>,
    /// The hairline over the finished composite, when the project has one.
    pub progress: Option<ProgressBar>,
    /// Lets the UI say which implementation produced the plan.
    pub engine: String,
}

fn round(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

/// Resolved window of a transition, or `None` if its junction no longer exists.
struct ResolvedWindow {
    start: f64,
    end: f64,
    center: f64,
    from: Option<Clip>,
    to: Option<Clip>,
}

fn resolve_window(project: &Project, transition: &Transition) -> Option<ResolvedWindow> {
    let find = |id: &Option<String>| -> Option<Clip> {
        id.as_ref()
            .and_then(|value| project.clips.iter().find(|clip| &clip.id == value))
            .cloned()
    };

    let from = find(&transition.from_clip_id);
    let to = find(&transition.to_clip_id);

    // A stored reference that no longer resolves means the clip was deleted.
    if transition.from_clip_id.is_some() && from.is_none() {
        return None;
    }
    if transition.to_clip_id.is_some() && to.is_none() {
        return None;
    }

    let duration = transition.duration.max(0.1);

    match (&from, &to) {
        (Some(a), Some(b)) => {
            if (a.end() - b.start).abs() > JUNCTION_EPSILON {
                return None;
            }
            let center = a.end();
            Some(ResolvedWindow {
                start: center - duration / 2.0,
                end: center + duration / 2.0,
                center,
                from: from.clone(),
                to: to.clone(),
            })
        }
        (None, Some(b)) => Some(ResolvedWindow {
            start: b.start,
            end: b.start + duration,
            center: b.start,
            from: None,
            to: to.clone(),
        }),
        (Some(a), None) => {
            let end = a.end();
            Some(ResolvedWindow {
                start: end - duration,
                end,
                center: end,
                from: from.clone(),
                to: None,
            })
        }
        (None, None) => None,
    }
}

/// Mirrored by `transitionFilter` in `src/lib/renderPlan.ts`.
pub fn transition_filter(
    kind: &str,
    start: f64,
    end: f64,
    center: f64,
    has_from: bool,
    has_to: bool,
) -> String {
    let duration = round(end - start);

    if kind == "crossfade" && has_from && has_to {
        return format!(
            "xfade=transition=fade:duration={duration}:offset={}",
            round(start)
        );
    }

    let color = if kind == "dip-white" { "white" } else { "black" };

    if has_from && has_to {
        // A dip through a cut is two fades meeting on the frame of the cut.
        let half = round((end - start) / 2.0);
        return format!(
            "fade=t=out:st={}:d={half}:color={color},fade=t=in:st={}:d={half}:color={color}",
            round(start),
            round(center)
        );
    }
    if has_to {
        return format!("fade=t=in:st={}:d={duration}:color={color}", round(start));
    }
    format!("fade=t=out:st={}:d={duration}:color={color}", round(start))
}

/// Alpha ramp and handle extension a cross-dissolve imposes on one of its
/// neighbours. Dips do not touch the segments — they are applied to the
/// finished composite instead.
#[derive(Default, Clone, Copy)]
struct Dissolve {
    /// Seconds of source consumed beyond the trim, on the relevant side.
    extension: f64,
    /// Window of the transition, absolute on the timeline.
    window_start: f64,
    window_end: f64,
    present: bool,
}

fn dissolve_for(project: &Project, clip_id: &str, incoming: bool) -> Dissolve {
    for transition in &project.transitions {
        if transition.kind != "crossfade" {
            continue;
        }
        let matches = if incoming {
            transition.to_clip_id.as_deref() == Some(clip_id)
        } else {
            transition.from_clip_id.as_deref() == Some(clip_id)
        };
        if !matches {
            continue;
        }
        let Some(window) = resolve_window(project, transition) else {
            continue;
        };
        // A dissolve only exists across a real junction.
        if window.from.is_none() || window.to.is_none() {
            continue;
        }
        return Dissolve {
            extension: (window.end - window.start) / 2.0,
            window_start: window.start,
            window_end: window.end,
            present: true,
        };
    }
    Dissolve::default()
}

fn compressor_plan(audio: &TrackAudio) -> Option<CompressorPlan> {
    if !audio.compressor.enabled {
        return None;
    }
    Some(CompressorPlan {
        threshold_db: audio.compressor.threshold.clamp(-60.0, 0.0),
        ratio: audio.compressor.ratio.clamp(1.0, 20.0),
        makeup_db: audio.compressor.makeup.clamp(0.0, 24.0),
    })
}

fn is_svg(name: &str) -> bool {
    name.rsplit('.').next().map(|ext| ext.eq_ignore_ascii_case("svg")).unwrap_or(false)
}

/// `baked` maps a clip id to the PNG the front-end rasterised for it.
/// `baked` maps a clip id to the PNG — or the `%06d.png` sequence — the
/// front-end rasterised for it; `channels` carries the sampled animation
/// curves, already flattened by the same evaluator the preview uses.
pub fn build(
    project: &Project,
    baked: &HashMap<String, String>,
    channels: &SampledChannels,
) -> RenderPlan {
    let mut segments = Vec::new();
    let mut warnings = Vec::new();

    // Solo is resolved once, here: everything downstream only ever asks
    // "is this bus muted?" and never has to know why.
    let any_solo = project
        .tracks
        .iter()
        .any(|track| track.kind == "audio" && track.solo && !track.muted);

    let buses: Vec<TrackBus> = project
        .tracks
        .iter()
        .map(|track| {
            let audio = track.audio.unwrap_or_default();
            let silenced = track.muted || (track.kind == "audio" && any_solo && !track.solo);
            TrackBus {
                id: track.id.clone(),
                name: track.name.clone(),
                kind: track.kind.clone(),
                muted: silenced,
                volume: audio.volume.clamp(0.0, 4.0),
                pan: audio.pan.clamp(-1.0, 1.0),
                high_pass: audio.high_pass.max(0.0),
                low_pass: audio.low_pass.max(0.0),
                compressor: compressor_plan(&audio),
            }
        })
        .collect();

    for (layer, track) in project.tracks.iter().enumerate() {
        if track.hidden && track.kind == "video" {
            warnings.push(format!("Piste {} masquée — ignorée au rendu", track.name));
            continue;
        }
        if track.kind == "audio" && buses.iter().any(|bus| bus.id == track.id && bus.muted) {
            warnings.push(format!(
                "Piste {} muette{} — ignorée au rendu",
                track.name,
                if any_solo && !track.solo { " (solo ailleurs)" } else { "" }
            ));
            continue;
        }

        let mut ordered: Vec<_> = project
            .clips
            .iter()
            .filter(|clip| clip.track_id == track.id)
            .collect();
        ordered.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));

        for clip in ordered {
            // A generated layer — a title, a background, a banner — has no
            // asset: the front-end bakes it to a PNG at the project's own
            // resolution, with the transform and effects already applied.
            let asset = clip
                .asset_id
                .as_ref()
                .and_then(|id| project.assets.iter().find(|item| &item.id == id));

            if !clip.is_generated() && asset.is_none() {
                warnings.push(format!(
                    "Clip « {} » sans média source",
                    clip.label.clone().unwrap_or_else(|| clip.id.clone())
                ));
                continue;
            }

            let baked_path = baked.get(&clip.id).cloned();
            let animated: HashMap<String, Vec<Breakpoint>> =
                channels.get(&clip.id).cloned().unwrap_or_default();
            let is_sequence = baked_path
                .as_deref()
                .map(|path| path.contains("%0"))
                .unwrap_or(false);
            let vector = asset.map(|item| is_svg(&item.name)).unwrap_or(false);
            let needs_bake = clip.is_generated() || vector;
            let is_still =
                clip.is_generated() || asset.map(|item| item.kind == "image").unwrap_or(false);

            let source_name = if clip.is_generated() {
                clip.generated_label()
            } else {
                asset.map(|item| item.name.clone()).unwrap_or_default()
            };

            let source_path = if needs_bake {
                baked_path
            } else {
                asset.and_then(|item| item.path.clone())
            };

            if !needs_bake && source_path.is_none() {
                warnings.push(format!(
                    "« {source_name} » n'a pas de chemin disque — réimportez-le pour le rendu"
                ));
            }

            // A cross-dissolve borrows material either side of the cut; the
            // handle available in the source is what actually limits it.
            let head = dissolve_for(project, &clip.id, true);
            let tail = dissolve_for(project, &clip.id, false);

            // A still (or a text layer) can be held indefinitely, so a
            // dissolve into one never runs out of handle.
            let source_duration = asset.map(|item| item.duration).unwrap_or(0.0);
            let head_handle = if is_still { f64::INFINITY } else { clip.offset.max(0.0) };
            let tail_handle = if is_still {
                f64::INFINITY
            } else if source_duration > 0.0 {
                (source_duration - (clip.offset + clip.duration)).max(0.0)
            } else {
                0.0
            };

            let requested_head = if head.present { head.extension.min(head_handle) } else { 0.0 };
            let requested_tail = if tail.present { tail.extension.min(tail_handle) } else { 0.0 };

            // A rasterised sequence covers exactly the clip: it holds no handle
            // to lend a dissolve, so its window is never extended.
            let (head_extension, tail_extension) =
                if is_sequence { (0.0, 0.0) } else { (requested_head, requested_tail) };

            let render_in = clip.start - head_extension;
            let render_out = clip.end() + tail_extension;

            // Ramps are expressed relative to the segment's own start, which is
            // what the encoder's `fade` filters expect after `setpts`.
            let (fade_in_start, fade_in) = if head.present {
                let start = (head.window_start - render_in).max(0.0);
                (start, (head.window_end - render_in - start).max(0.0))
            } else {
                (0.0, 0.0)
            };
            let (fade_out_start, fade_out) = if tail.present {
                let start = (tail.window_start - render_in).max(0.0);
                (start, (tail.window_end - render_in - start).max(0.0))
            } else {
                (0.0, 0.0)
            };

            if head.present && head_extension + 1e-6 < head.extension {
                warnings.push(format!(
                    "« {source_name} » n'a pas assez de marge avant son point d'entrée — le fondu figera l'image"
                ));
            }
            if tail.present && tail_extension + 1e-6 < tail.extension {
                warnings.push(format!(
                    "« {source_name} » n'a pas assez de marge après son point de sortie — le fondu figera l'image"
                ));
            }

            let base = RenderSegment {
                track_name: track.name.clone(),
                kind: track.kind.clone(),
                layer,
                source: source_name,
                source_path,
                timeline_in: clip.start,
                timeline_out: clip.end(),
                source_in: (clip.offset - head_extension).max(0.0),
                track_id: track.id.clone(),
                render_in,
                render_out,
                fade_in_start,
                fade_in,
                fade_out_start,
                fade_out,
                volume: if clip.muted || track.muted { 0.0 } else { clip.volume },
                opacity: clip.opacity,
                scale: clip.scale,
                x: clip.x,
                y: clip.y,
                rotation: clip.rotation,
                is_still,
                // A baked layer already carries its transform and sits at the
                // project's resolution, so it neither conforms nor re-transforms.
                conform: !is_still && !needs_bake,
                needs_bake,
                is_sequence,
                // A baked layer already has its animation drawn into the frames.
                animated: if needs_bake { HashMap::new() } else { animated },
                filters: if needs_bake { Vec::new() } else { effect_filters(&clip.effects) },
                effects: clip.effects.clone(),
                role: ROLE_CLIP.to_string(),
                backdrop: clip.backdrop.clone(),
            };

            /*
             * A backdrop turns one clip into three passes.
             *
             * Pushed bottom-first — blurred copy, then shadow, then the clip
             * itself — and all three keep the same `layer`. `build_args` sorts
             * by layer with a *stable* sort, so segments that share one keep the
             * order they were pushed in, and that is what puts the glass behind
             * the picture rather than over it. There is a test for exactly that
             * property in `engine::ffmpeg`, because the whole look depends on it.
             *
             * A baked layer never gets one: its pixels are already composed, and
             * a title has no picture to blur.
             */
            match clip.backdrop.as_ref() {
                Some(backdrop) if !needs_bake => {
                    segments.push(RenderSegment {
                        role: ROLE_BACKDROP.to_string(),
                        // The glass fills the frame: it is not moved, scaled or
                        // turned, for the same reason a generated background is
                        // not — any of those would expose the edge it covers.
                        scale: 1.0,
                        x: 0.0,
                        y: 0.0,
                        rotation: 0.0,
                        animated: HashMap::new(),
                        // The effect stack belongs to the picture, not to the
                        // surface behind it. Colour-grading the glass as well
                        // would double every correction the user applied.
                        filters: Vec::new(),
                        effects: Vec::new(),
                        ..base.clone()
                    });

                    if backdrop.shadow.casts() {
                        segments.push(RenderSegment {
                            role: ROLE_SHADOW.to_string(),
                            // The silhouette follows the picture exactly, one
                            // offset lower. Its own blur widens it afterwards.
                            y: base.y + backdrop.shadow.y,
                            filters: Vec::new(),
                            effects: Vec::new(),
                            ..base.clone()
                        });
                    }

                    segments.push(base);
                }
                _ => segments.push(base),
            }
        }
    }

    let mut transitions = Vec::new();
    for transition in &project.transitions {
        let Some(window) = resolve_window(project, transition) else {
            warnings.push(format!(
                "Transition {} orpheline — point de coupe disparu",
                transition.kind
            ));
            continue;
        };

        let track_name = project
            .tracks
            .iter()
            .find(|track| track.id == transition.track_id)
            .map(|track| track.name.clone())
            .unwrap_or_else(|| "?".to_string());

        let source_of = |clip: &Option<Clip>| -> Option<String> {
            clip.as_ref().and_then(|item| {
                if item.is_generated() {
                    return Some(item.generated_label());
                }
                let id = item.asset_id.as_ref()?;
                project
                    .assets
                    .iter()
                    .find(|asset| &asset.id == id)
                    .map(|asset| asset.name.clone())
            })
        };

        transitions.push(TransitionPlan {
            kind: transition.kind.clone(),
            track_name,
            start: round(window.start),
            end: round(window.end),
            duration: round(window.end - window.start),
            from_source: source_of(&window.from),
            to_source: source_of(&window.to),
            ffmpeg: transition_filter(
                &transition.kind,
                window.start,
                window.end,
                window.center,
                window.from.is_some(),
                window.to.is_some(),
            ),
        });
    }

    transitions.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));

    let duration = project.duration();

    RenderPlan {
        project_name: project.name.clone(),
        width: project.settings.width,
        height: project.settings.height,
        fps: project.settings.fps,
        duration,
        frame_count: (duration * project.settings.fps).round().max(0.0) as u64,
        segments,
        tracks: buses,
        transitions,
        warnings,
        // Carried through untouched: the bar is drawn on the composite, so
        // nothing about the segments has to know it exists.
        progress: project.progress.clone().filter(|bar| bar.draws()),
        engine: "rust".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirrored by `transitionFilter` in `src/lib/renderPlan.ts`.
    #[test]
    fn crossfade_maps_to_xfade() {
        assert_eq!(
            transition_filter("crossfade", 3.6, 4.4, 4.0, true, true),
            "xfade=transition=fade:duration=0.8:offset=3.6"
        );
    }

    #[test]
    fn a_dip_through_a_cut_is_two_meeting_fades() {
        assert_eq!(
            transition_filter("dip-black", 3.6, 4.4, 4.0, true, true),
            "fade=t=out:st=3.6:d=0.4:color=black,fade=t=in:st=4:d=0.4:color=black"
        );
    }

    #[test]
    fn open_edges_fade_one_way() {
        assert_eq!(
            transition_filter("dip-black", 0.0, 1.0, 0.0, false, true),
            "fade=t=in:st=0:d=1:color=black"
        );
        assert_eq!(
            transition_filter("dip-white", 9.0, 10.0, 10.0, true, false),
            "fade=t=out:st=9:d=1:color=white"
        );
    }

    /// A crossfade without material on both sides degrades to a dip rather
    /// than emitting an xfade the encoder could not satisfy.
    #[test]
    fn crossfade_without_a_neighbour_falls_back_to_a_dip() {
        assert!(transition_filter("crossfade", 0.0, 1.0, 0.0, false, true).starts_with("fade=t=in"));
    }
}
