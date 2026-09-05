//! FFmpeg-backed implementation of [`Encoder`](super::Encoder).
//!
//! The render plan already describes the timeline as ordered, positioned
//! segments with their filter chains and dissolve ramps. Turning that into a
//! filtergraph is therefore mechanical, and it is all this module does:
//!
//! * every video segment is trimmed at the input, conformed to the project
//!   frame, put through its effect chain, given alpha (clip opacity and any
//!   dissolve ramp), then delayed to its timeline position with `tpad`;
//! * the segments are stacked bottom-to-top over a black canvas with `overlay`,
//!   which makes a cross-dissolve fall out of the alpha ramps for free;
//! * dips through black or white are applied to the finished composite;
//! * audio is trimmed, gained, delayed and mixed.
//!
//! Building the argument list is a pure function, so it is unit-tested without
//! ffmpeg present. Running it is the only part that needs the binary.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;

use std::sync::{Arc, Mutex};

use serde::Deserialize;

use super::render::{RenderPlan, RenderSegment, ROLE_BACKDROP, ROLE_SHADOW};
use super::{EncodeProgress, Encoder};
use crate::model::Breakpoint;

/* ------------------------------------------------------------------ *
 * Output settings
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    /// `mp4-h264` | `mp4-h265` | `webm-vp9` | `mov-prores`
    pub format: String,
    /// `crf` | `bitrate`
    pub rate_mode: String,
    /// Rate factor, or the ProRes profile index.
    pub crf: f64,
    pub bitrate_kbps: u32,
    pub audio_bitrate_kbps: u32,
    pub preset: String,
    /// `source` or a target height as a string.
    pub resolution: String,
    /// `source` or a number.
    #[serde(default)]
    pub fps: serde_json::Value,
    /// `all` | `work`
    pub range: String,
    #[serde(default)]
    pub work_in: Option<f64>,
    #[serde(default)]
    pub work_out: Option<f64>,
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            format: "mp4-h264".into(),
            rate_mode: "crf".into(),
            crf: 18.0,
            bitrate_kbps: 12_000,
            audio_bitrate_kbps: 192,
            preset: "medium".into(),
            resolution: "source".into(),
            fps: serde_json::Value::String("source".into()),
            range: "all".into(),
            work_in: None,
            work_out: None,
        }
    }
}

impl ExportSettings {
    fn target_height(&self) -> Option<u32> {
        self.resolution.parse::<u32>().ok()
    }

    fn target_fps(&self) -> Option<f64> {
        self.fps.as_f64()
    }

    /// The slice of the timeline to write out, clamped to what exists.
    fn window(&self, duration: f64) -> (f64, f64) {
        if self.range != "work" {
            return (0.0, duration);
        }
        let start = self.work_in.unwrap_or(0.0).max(0.0).min(duration);
        let end = self.work_out.unwrap_or(duration).max(start).min(duration);
        if end - start < 1e-3 {
            (0.0, duration)
        } else {
            (start, end)
        }
    }
}

/// Codec, container and pixel format for one output choice.
struct Codec {
    video: &'static str,
    audio: &'static str,
    pixel_format: &'static str,
    supports_crf: bool,
}

fn codec_for(format: &str) -> Codec {
    match format {
        "mp4-h265" => Codec { video: "libx265", audio: "aac", pixel_format: "yuv420p", supports_crf: true },
        "webm-vp9" => Codec { video: "libvpx-vp9", audio: "libopus", pixel_format: "yuv420p", supports_crf: true },
        "mov-prores" => Codec {
            video: "prores_ks",
            audio: "pcm_s16le",
            // ProRes is a 10-bit 4:2:2 format; forcing 4:2:0 would throw away
            // exactly what it is chosen for.
            pixel_format: "yuv422p10le",
            supports_crf: false,
        },
        _ => Codec { video: "libx264", audio: "aac", pixel_format: "yuv420p", supports_crf: true },
    }
}

/** Linear amplitude for a level in dBFS. */
fn from_db(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

/// Beyond this, a piecewise expression gets unwieldy; the curve is decimated.
const MAX_BREAKPOINTS: usize = 96;

/*
 * The command line has a ceiling, and a montage can walk straight into it.
 *
 * `CreateProcess` refuses anything past 32 767 characters, and Windows reports
 * that refusal as `os error 206` — "the filename or extension is too long",
 * which names the wrong thing entirely and sends everyone looking at their
 * paths. What is actually too long is the whole argument list, and on a
 * rhythmic montage it is the *filtergraph*: two hundred shots, each with its
 * own sampled camera curve and a handful of gated impact filters, run to
 * several hundred thousand characters on their own.
 *
 * ffmpeg's answer is to read the graph from a file. The option used to be
 * `-filter_complex_script`; it was withdrawn in ffmpeg 7 in favour of the
 * generic `-/name file` form, which is what current builds accept and what this
 * uses.
 *
 * The spill is conditional rather than unconditional, and deliberately so:
 * every export that fits today keeps the exact command line it has always had,
 * and the new path is taken only where the old one could not run at all.
 */
const COMMAND_LIMIT: usize = 32_767;

/// Headroom kept under the ceiling.
///
/// Windows quotes any argument containing a space when it rebuilds the line, so
/// what it measures is longer than the sum of the parts — and the program path
/// itself is counted too. A couple of thousand characters of slack costs
/// nothing and removes a whole class of "worked on my machine".
const COMMAND_HEADROOM: usize = 2_767;

/// What the argument list may reach before the graph is moved out of it.
///
/// Derived from the ceiling rather than written beside it, so the two cannot
/// drift apart: the budget *is* the limit less the slack, and saying so is the
/// only way that stays true.
const COMMAND_BUDGET: usize = COMMAND_LIMIT - COMMAND_HEADROOM;

/// What Windows will actually measure, for `program` invoked with `args`.
///
/// Every argument is separated by a space and may be wrapped in quotes, so each
/// is counted with three characters of overhead rather than one.
pub fn command_length(program: &Path, args: &[String]) -> usize {
    program.as_os_str().len() + args.iter().map(|arg| arg.len() + 3).sum::<usize>()
}

/// Moves the filtergraph out of the argument list and into `file`.
///
/// Returns `false` when there was no graph to move, which is not a failure: an
/// audio-only render has none.
pub fn spill_graph(args: &mut [String], file: &Path) -> Result<bool, String> {
    let Some(index) = args.iter().position(|arg| arg == "-filter_complex") else {
        return Ok(false);
    };
    let Some(graph) = args.get(index + 1).cloned() else {
        return Ok(false);
    };

    std::fs::write(file, graph.as_bytes())
        .map_err(|error| format!("Impossible d'écrire le graphe de filtres : {error}"))?;

    args[index] = "-/filter_complex".to_string();
    args[index + 1] = file.to_string_lossy().to_string();
    Ok(true)
}

/// Deletes the spilled graph when the encode ends, however it ends.
///
/// A guard rather than a call at the bottom: an encode returns from a dozen
/// places — cancelled, failed, interrupted — and a temporary file left behind
/// by each of them turns a long session into a littered temp directory.
struct Spilled(PathBuf);

impl Drop for Spilled {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Which elementary streams a source file actually carries.
#[derive(Debug, Clone, Copy, Default)]
pub struct Streams {
    pub video: bool,
    pub audio: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderStatus {
    /// Whether this platform can fetch a build from inside the app.
    pub installable: bool,
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// Absent ffprobe only costs us the audio of video clips, so it is reported
    /// separately rather than as a hard failure.
    pub probe_available: bool,
}

pub fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Env override first, a binary shipped next to the app, the copy the app
/// installed for itself, then the PATH.
pub fn locate_binary(name: &str) -> Option<PathBuf> {
    let var = if name == "ffmpeg" { "VEGLASS_FFMPEG" } else { "VEGLASS_FFPROBE" };
    if let Ok(value) = std::env::var(var) {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
    }

    if let Ok(current) = std::env::current_exe() {
        if let Some(dir) = current.parent() {
            for candidate in [dir.join(exe(name)), dir.join("bin").join(exe(name))] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    // The build Veglass fetched for itself, which is on no PATH by design.
    if let Some(dir) = super::install::install_dir() {
        let candidate = dir.join(exe(name));
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    // On the PATH: ask the binary to identify itself rather than scanning.
    let probe = crate::proc::command(exe(name))
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match probe {
        Ok(status) if status.success() => Some(PathBuf::from(exe(name))),
        _ => None,
    }
}

fn version_of(program: &Path) -> Option<String> {
    let output = crate::proc::command(program).arg("-version").output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().next().map(|line| line.trim().to_string())
}

pub fn status() -> EncoderStatus {
    match locate_binary("ffmpeg") {
        Some(path) => EncoderStatus {
            installable: super::install::supported(),
            available: true,
            version: version_of(&path),
            path: Some(path.to_string_lossy().to_string()),
            probe_available: locate_binary("ffprobe").is_some(),
        },
        None => EncoderStatus {
            installable: super::install::supported(),
            available: false,
            path: None,
            version: None,
            probe_available: false,
        },
    }
}

/// Asks ffprobe which streams a file has, so we never reference `[n:a]` on a
/// silent clip — which would abort the whole render.
pub fn probe_streams(ffprobe: Option<&Path>, path: &str) -> Streams {
    let Some(program) = ffprobe else {
        return Streams { video: true, audio: false };
    };
    let output = crate::proc::command(program)
        .args([
            "-v", "error",
            "-show_entries", "stream=codec_type",
            "-of", "default=nw=1:nk=1",
        ])
        .arg(path)
        .output();

    let Ok(output) = output else {
        return Streams { video: true, audio: false };
    };
    let text = String::from_utf8_lossy(&output.stdout);
    Streams {
        video: text.lines().any(|line| line.trim() == "video"),
        audio: text.lines().any(|line| line.trim() == "audio"),
    }
}

/// Thins a sampled curve to a manageable number of points, keeping the ends.
fn decimate(points: &[Breakpoint]) -> Vec<Breakpoint> {
    if points.len() <= MAX_BREAKPOINTS {
        return points.to_vec();
    }
    let stride = (points.len() as f64 / MAX_BREAKPOINTS as f64).ceil() as usize;
    let mut out: Vec<Breakpoint> = points.iter().step_by(stride).copied().collect();
    if let Some(last) = points.last() {
        if out.last().map(|p| p.time) != Some(last.time) {
            out.push(*last);
        }
    }
    out
}

/**
 * A sampled curve as an ffmpeg expression over `time`, which must itself
 * evaluate to clip-relative seconds.
 *
 * The result is piecewise linear — ffmpeg's expression language has no bézier
 * solver, so the easing was already flattened by the front-end. Values are held
 * flat outside the animated span, matching the evaluator in the preview.
 *
 * The string is full of commas, which a filtergraph would read as filter
 * separators; every caller therefore wraps it in single quotes, which ffmpeg's
 * own parser understands.
 */
fn ramp_expression(points: &[Breakpoint], time: &str) -> Option<String> {
    let points = decimate(points);
    let first = points.first()?;

    if points.len() == 1 {
        return Some(format!("{:.4}", first.value));
    }

    let last = points.last()?;
    let mut expr = format!("{:.4}", last.value);

    for window in points.windows(2).rev() {
        let (a, b) = (window[0], window[1]);
        let span = (b.time - a.time).max(1e-6);
        let segment = format!(
            "({:.4}+({:.4})*({time}-{:.4})/{:.6})",
            a.value,
            b.value - a.value,
            a.time,
            span
        );
        expr = format!("if(lt({time},{:.4}),{segment},{expr})", b.time);
    }

    Some(format!("if(lt({time},{:.4}),{:.4},{expr})", first.time, first.value))
}

/// The curve's value at `time`, held flat outside its own span.
///
/// The same rule the preview's evaluator follows: an animation does not
/// extrapolate past its own ends. The points arrive piecewise linear — the
/// front-end flattened the easing before sending them — so this is a walk
/// rather than a solve.
fn value_at(points: &[Breakpoint], time: f64) -> f64 {
    let Some(first) = points.first() else {
        return 0.0;
    };
    if time <= first.time {
        return first.value;
    }
    let last = points[points.len() - 1];
    if time >= last.time {
        return last.value;
    }

    for window in points.windows(2) {
        let (a, b) = (window[0], window[1]);
        if time < a.time || time > b.time {
            continue;
        }
        let span = b.time - a.time;
        if span <= 1e-9 {
            return b.value;
        }
        return a.value + (b.value - a.value) * ((time - a.time) / span);
    }

    last.value
}

/// Ceiling on the gated copies one animated parameter may produce.
///
/// Reached only by an animation long enough for its *rounded* value to change
/// dozens of times; the few frames an impact lasts produce a handful. Past it
/// the parameter is held at its static value and the caller says so, which is a
/// far better outcome than a filtergraph with three hundred stages in it.
const MAX_STEPS: usize = 48;

/// Plays a curve through a filter that cannot read a clock.
///
/// Some filters take no expression at all: `rgbashift` reads plain integers and
/// `gblur` fixes its kernel when it is built, so the `ramp_expression` trick the
/// rest of the chain leans on is simply not available to them. Nearly every
/// filter honours `enable`, though — so a curve can be *played* by laying
/// several copies of the filter end to end, each holding one value across the
/// frames it owns.
///
/// The runs are found by **sampling at the frame rate and coalescing identical
/// filter strings**, not by quantising the parameter. That distinction is the
/// whole correctness argument: two amounts a pixel apart can build the same
/// `rgbashift`, and two that quantise alike can build different ones once an
/// angle moves as well. Comparing what would actually be emitted is exact for
/// any parameter, and for any number of them at once.
///
/// Windows are half-open — `gte(t,a)*lt(t,b)` rather than `between` — because
/// `between` is inclusive at both ends, and two neighbouring runs would both be
/// enabled on the frame they share. Two copies of a shift on one frame is
/// double the shift, once, in the middle of the ramp.
///
/// `None` when the curve would need more copies than [`MAX_STEPS`].
fn stepped_filters(
    amount: Option<&[Breakpoint]>,
    angle: Option<&[Breakpoint]>,
    static_amount: f64,
    static_angle: f64,
    fps: f64,
    time: &str,
    build: impl Fn(f64, f64) -> Option<String>,
) -> Option<Vec<String>> {
    let rate = fps.max(1.0);
    let span = |points: Option<&[Breakpoint]>| -> Option<(f64, f64)> {
        let points = points?;
        Some((points.first()?.time, points.last()?.time))
    };

    let (from, to) = match (span(amount), span(angle)) {
        (Some(a), Some(b)) => (a.0.min(b.0), a.1.max(b.1)),
        (Some(a), None) | (None, Some(a)) => a,
        (None, None) => return Some(build(static_amount, static_angle).into_iter().collect()),
    };

    // The grid is anchored at zero rather than at the curve, because that is
    // where the encoder's own frames are: the clip starts at clip-relative zero
    // and every frame after it lands on a multiple of the period. A boundary
    // placed anywhere else would cut a frame in half, and `enable` would decide
    // it on the wrong side.
    let first = (from * rate).floor() as i64;
    let last = (to * rate).ceil() as i64;

    let mut runs: Vec<(i64, Option<String>)> = Vec::new();
    for frame in first..=last {
        // Sampled mid-frame: the value a frame should carry is the one at its
        // middle, not the one on the boundary it shares with its neighbour.
        let at = (frame as f64 + 0.5) / rate;
        let current = build(
            amount.map(|points| value_at(points, at)).unwrap_or(static_amount),
            angle.map(|points| value_at(points, at)).unwrap_or(static_angle),
        );

        match runs.last() {
            Some((_, previous)) if *previous == current => {}
            _ => runs.push((frame, current)),
        }
    }

    if runs.iter().filter(|(_, filter)| filter.is_some()).count() > MAX_STEPS {
        return None;
    }

    let mut out = Vec::new();
    for (index, (frame, filter)) in runs.iter().enumerate() {
        let Some(filter) = filter else { continue };

        // The first run reaches back before the animation and the last reaches
        // past it, which is exactly how a held value behaves either side of a
        // curve. Only the boundaries between two runs are ever stated.
        let opens = index > 0;
        let closes = index + 1 < runs.len();
        let start = *frame as f64 / rate;
        let end = runs
            .get(index + 1)
            .map(|(next, _)| *next as f64 / rate)
            .unwrap_or(0.0);

        let gate = match (opens, closes) {
            (false, false) => None,
            (true, false) => Some(format!("gte({time},{start:.4})")),
            (false, true) => Some(format!("lt({time},{end:.4})")),
            (true, true) => Some(format!("gte({time},{start:.4})*lt({time},{end:.4})")),
        };

        out.push(match gate {
            // Quoted: the expression is full of commas, which a filtergraph
            // would otherwise read as the end of this filter.
            Some(gate) => format!("{filter}:enable='{gate}'"),
            None => filter.clone(),
        });
    }

    Some(out)
}

/// Filter chain for a segment whose effect parameters are animated.
///
/// `eq` and `hue` accept per-frame expressions; `gblur` does not, so an animated
/// blur is reported rather than silently flattened.
fn animated_effect_filters(
    segment: &RenderSegment,
    time: &str,
    fps: f64,
) -> (Vec<String>, Vec<String>) {
    let mut filters = Vec::new();
    let mut warnings = Vec::new();

    for effect in &segment.effects {
        if !effect.enabled {
            continue;
        }
        let points = |key: &str| -> Option<&[Breakpoint]> {
            segment
                .animated
                .get(&format!("fx:{}:{}", effect.id, key))
                .map(|values| values.as_slice())
        };
        let curve = |key: &str| -> Option<String> {
            points(key).and_then(|values| ramp_expression(values, time))
        };

        match effect.kind.as_str() {
            "brightness" => match curve("amount") {
                Some(expr) => filters.push(format!("eq=brightness='{expr}'")),
                None => {
                    let value = effect.param("amount", 0.0);
                    if value != 0.0 {
                        filters.push(format!("eq=brightness={value:.3}"));
                    }
                }
            },
            "contrast" => match curve("amount") {
                Some(expr) => filters.push(format!("eq=contrast='{expr}'")),
                None => {
                    let value = effect.param("amount", 1.0);
                    if value != 1.0 {
                        filters.push(format!("eq=contrast={value:.3}"));
                    }
                }
            },
            "saturation" => match curve("amount") {
                Some(expr) => filters.push(format!("eq=saturation='{expr}'")),
                None => {
                    let value = effect.param("amount", 1.0);
                    if value != 1.0 {
                        filters.push(format!("eq=saturation={value:.3}"));
                    }
                }
            },
            "hue" => match curve("angle") {
                Some(expr) => filters.push(format!("hue=h='{expr}'")),
                None => {
                    let value = effect.param("angle", 0.0);
                    if value != 0.0 {
                        filters.push(format!("hue=h={}", value.round() as i64));
                    }
                }
            },
            "grayscale" => match curve("amount") {
                Some(expr) => filters.push(format!("hue=s='1-({expr})'")),
                None => {
                    let value = effect.param("amount", 0.0);
                    if value > 0.0 {
                        filters.push(format!("hue=s={:.3}", 1.0 - value));
                    }
                }
            },
            "blur" => {
                if curve("radius").is_some() {
                    warnings.push(format!(
                        "Le flou animé de « {} » n'est pas rendu image par image — ffmpeg n'accepte pas d'expression pour gblur",
                        segment.source
                    ));
                }
                let value = effect.param("radius", 0.0);
                if value > 0.0 {
                    filters.push(format!("gblur=sigma={:.2}", value / 2.0));
                }
            }
            "invert" => {
                // Same limitation as the blur, for a different reason: `lutrgb`
                // builds its table once at init, so there is no `t` for a curve
                // to be a function of. A negative flash does not need one — it
                // is a couple of frames of a clip that is either inverted or is
                // not — but an animated dosage would silently freeze, and this
                // codebase says so instead.
                if curve("amount").is_some() {
                    warnings.push(format!(
                        "Le négatif animé de « {} » n'est pas rendu image par image — ffmpeg n'accepte pas d'expression pour lutrgb",
                        segment.source
                    ));
                }
                let value = effect.param("amount", 0.0);
                if value > 0.0 {
                    filters.push(crate::engine::effects::invert_filter(value));
                }
            }
            /*
             * The two impact effects, played through `enable` rather than
             * through an expression.
             *
             * Both take a length and an angle, both refuse expressions, and
             * both honour the timeline — so one branch serves them, differing
             * only in which mapping builds the string.
             */
            "rgbsplit" | "motionblur" => {
                let build: fn(f64, f64) -> Option<String> = if effect.kind == "rgbsplit" {
                    crate::engine::effects::rgb_split_filter
                } else {
                    crate::engine::effects::motion_blur_filter
                };
                let amount = effect.param("amount", 0.0);
                let angle = effect.param("angle", 0.0);

                match stepped_filters(
                    points("amount"),
                    points("angle"),
                    amount,
                    angle,
                    fps,
                    time,
                    build,
                ) {
                    Some(steps) => filters.extend(steps),
                    None => {
                        warnings.push(format!(
                            "L'animation de « {} » sur « {} » change trop souvent pour être rendue image par image — elle est figée à sa valeur de repos",
                            if effect.kind == "rgbsplit" { "l'aberration chromatique" } else { "le flou de mouvement" },
                            segment.source
                        ));
                        if let Some(filter) = build(amount, angle) {
                            filters.push(filter);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    (filters, warnings)
}

fn trim(value: f64) -> String {
    // Three decimals is a hair under a millisecond — finer than any frame rate
    // we support, and it keeps the graph readable.
    format!("{:.3}", value)
}

#[derive(Debug, Clone)]
pub struct FfmpegCommand {
    pub args: Vec<String>,
    pub total_frames: u64,
}

/// Builds the full argument list for one render. Pure — this is the tested part.
/// The alpha expression for a rounded rectangle, in `geq`'s vocabulary.
///
/// `W` and `H` are the plane's own dimensions, so the same string works
/// whatever size the layer has been conformed to. The distance is measured only
/// in the corner quadrants — `max(0, …)` collapses to zero along the flat edges
/// — and the half-pixel of slack antialiases the arc instead of leaving it
/// stepped, which is what a `border-radius` gives on the other side.
///
/// A radius of zero returns a solid mask rather than a degenerate circle: the
/// shadow needs the silhouette even when the corners are square.
fn rounded_alpha(radius: f64) -> String {
    if radius <= 0.5 {
        return "255".to_string();
    }
    let r = radius.max(0.0);
    format!(
        "255*min(1,max(0,{r:.2}+0.5-sqrt(pow(max(0,max({r:.2}-X,X-(W-1-{r:.2}))),2)+pow(max(0,max({r:.2}-Y,Y-(H-1-{r:.2}))),2))))"
    )
}

/// `#RRGGBB` as three 0-255 components, for a `geq` flood.
///
/// Anything unreadable is black, which is what a shadow is when nobody has said
/// otherwise — never an error, because a malformed colour must not stop an
/// export that is otherwise fine.
fn rgb_of(hex: &str) -> (u8, u8, u8) {
    let clean: String = hex.trim().trim_start_matches('#').chars().collect();
    let full: String = if clean.len() == 3 {
        clean.chars().flat_map(|digit| [digit, digit]).collect()
    } else {
        clean.chars().take(6).collect()
    };
    if full.len() != 6 || !full.chars().all(|c| c.is_ascii_hexdigit()) {
        return (0, 0, 0);
    }
    let value = u32::from_str_radix(&full, 16).unwrap_or(0);
    (
        ((value >> 16) & 0xFF) as u8,
        ((value >> 8) & 0xFF) as u8,
        (value & 0xFF) as u8,
    )
}

pub fn build_args(
    plan: &RenderPlan,
    streams: &HashMap<String, Streams>,
    output: &Path,
    settings: &ExportSettings,
) -> Result<FfmpegCommand, String> {
    let width = plan.width.max(2);
    let height = plan.height.max(2);
    let fps = if plan.fps > 0.0 { plan.fps } else { 30.0 };
    let duration = plan.duration;
    let codec = codec_for(&settings.format);
    let (window_in, window_out) = settings.window(duration);

    if duration <= 0.0 {
        return Err("La timeline est vide — rien à encoder.".to_string());
    }

    // Bottom-to-top: the plan lists layer 0 as the topmost track, and `overlay`
    // draws later inputs on top, so the stack is walked in reverse.
    let mut video: Vec<&RenderSegment> = plan
        .segments
        .iter()
        .filter(|segment| segment.kind == "video" && segment.source_path.is_some())
        .collect();
    video.sort_by_key(|segment| std::cmp::Reverse(segment.layer));

    let audio: Vec<&RenderSegment> = plan
        .segments
        .iter()
        .filter(|segment| {
            segment.source_path.is_some()
                // An animated gain may well start at silence, so the presence
                // of a curve is enough to keep the branch alive.
                && (segment.volume > 0.0 || segment.animated.contains_key("volume"))
                && streams
                    .get(segment.source_path.as_deref().unwrap_or_default())
                    .map(|value| value.audio)
                    .unwrap_or(segment.kind == "audio")
        })
        .collect();

    if video.is_empty() && audio.is_empty() {
        return Err("Aucun média exploitable dans la timeline.".to_string());
    }

    let mut warnings: Vec<String> = Vec::new();
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-y".into()];
    let mut chains: Vec<String> = Vec::new();
    let mut index = 0usize;

    // ---------------------------------------------------------------- video
    let mut video_labels: Vec<String> = Vec::new();
    #[allow(clippy::type_complexity)]
    let mut offsets: Vec<(f64, f64, Option<String>, Option<String>)> = Vec::new();

    for segment in &video {
        let path = segment.source_path.clone().unwrap_or_default();
        let span = (segment.render_out - segment.render_in).max(1.0 / fps);

        if segment.is_sequence {
            // A rasterised animation: one PNG per output frame, already in step.
            args.push("-framerate".into());
            args.push(fps.to_string());
            args.push("-start_number".into());
            args.push("1".into());
        } else if segment.is_still {
            // One frame held for the whole span; seeking into it is meaningless.
            args.push("-loop".into());
            args.push("1".into());
            args.push("-framerate".into());
            args.push(fps.to_string());
        } else {
            args.push("-ss".into());
            args.push(trim(segment.source_in));
        }
        args.push("-t".into());
        args.push(trim(span));
        args.push("-i".into());
        args.push(path);

        // Two clocks: filters before `tpad` see time from the segment's own
        // start, while `overlay` sees timeline time. Both are expressed as
        // clip-relative seconds so one sampled curve serves both.
        let head_shift = segment.render_in - segment.timeline_in;
        let clock = |var: &str| -> String {
            if head_shift.abs() < 1e-6 {
                var.to_string()
            } else {
                format!("({var}{head_shift:+.3})")
            }
        };
        let pre_time = clock("t");
        // `geq` runs per pixel and names its clock `T`. Lowercase `t` is simply
        // undefined there, and one undefined constant makes ffmpeg reject the
        // entire graph — so this filter gets its own spelling of the same time.
        let geq_time = clock("T");
        let overlay_time = format!("(t-{:.3})", segment.timeline_in);

        let ramp = |channel: &str, time: &str| -> Option<String> {
            segment
                .animated
                .get(channel)
                .and_then(|points| ramp_expression(points, time))
        };

        // The source pad is *not* part of the chain. Joining it in with the
        // filters puts a comma straight after it — `[0:v],fps=30` — and
        // libavfilter reads that gap as a filter with no name: "No such filter:
        // ''", surfaced as "Filter not found".
        let source = format!("[{index}:v]");
        let mut chain = vec![format!("fps={fps}")];

        let role = segment.role.as_str();
        let is_backdrop = role == ROLE_BACKDROP;
        let is_shadow = role == ROLE_SHADOW;

        /*
         * The glass.
         *
         * Covered rather than contained — it has to reach every edge before it
         * is blurred — magnified a little past the frame so the blur has bleed
         * to eat, blurred, then cropped back. Cropping *after* the blur is the
         * whole point of the overscan: crop first and the outermost pixels have
         * nothing to pull colour from and go pale.
         *
         * The transform, the effect chain and the animation are all skipped for
         * this pass; `plan_render` has already cleared them. A backdrop fills
         * the frame and is overlaid at 0,0, exactly as a generated background is.
         */
        if is_backdrop {
            if let Some(backdrop) = segment.backdrop.as_ref() {
                let zoom = backdrop.zoom.clamp(1.0, 3.0);
                let cover_w = ((width as f64) * zoom).round().max(2.0) as u32;
                let cover_h = ((height as f64) * zoom).round().max(2.0) as u32;

                chain.push(format!(
                    "scale={cover_w}:{cover_h}:force_original_aspect_ratio=increase"
                ));
                chain.push(format!("crop={cover_w}:{cover_h}"));
                if backdrop.blur > 0.0 {
                    chain.push(format!("gblur=sigma={:.2}:steps=2", backdrop.blur.max(0.0)));
                }
                chain.push(format!("crop={width}:{height}"));
                if backdrop.tint_opacity > 0.0 {
                    chain.push(format!(
                        "drawbox=x=0:y=0:w={width}:h={height}:color={}@{:.3}:t=fill",
                        crate::model::ffmpeg_color(&backdrop.tint),
                        backdrop.tint_opacity.clamp(0.0, 1.0)
                    ));
                }
            }
            chain.push("setsar=1".to_string());
            chain.push("format=yuva420p".to_string());
        } else {
            // A conformed layer is fitted to the frame (video backgrounds); an
            // overlay — still, logo, baked text — keeps its own pixel size.
            if segment.conform {
                chain.push(format!(
                    "scale={width}:{height}:force_original_aspect_ratio=decrease"
                ));
            }
            chain.push("setsar=1".to_string());
        }

        if !is_backdrop {
            // Effect chain: rebuilt with expressions when a parameter is
            // animated, otherwise taken verbatim from the plan.
            if segment
                .animated
                .keys()
                .any(|channel| channel.starts_with("fx:"))
            {
                let (filters, notes) = animated_effect_filters(segment, &pre_time, fps);
                chain.extend(filters);
                warnings.extend(notes);
            } else {
                for filter in &segment.filters {
                    chain.push(filter.clone());
                }
            }

            /*
             * Rounded corners, cut **before** the clip's own scale.
             *
             * The radius is stored in project pixels, and CSS applies a radius
             * to the element and *then* the transform — so a layer at 80 % has
             * corners at 80 % of the radius. Cutting here, on the conformed box,
             * and letting the scale filter shrink the result reproduces that
             * exactly. Cutting after the scale would give a radius that stayed
             * the same size while the picture changed, and the preview and the
             * file would round differently.
             *
             * The shadow takes the same cut and is then flooded with its colour
             * in the same pass, so the silhouette is the picture's shape rather
             * than a rectangle approximating it.
             */
            let radius = segment
                .backdrop
                .as_ref()
                .map(|backdrop| backdrop.radius)
                .unwrap_or(0.0);

            if is_shadow || radius > 0.5 {
                let mask = rounded_alpha(radius);
                chain.push("format=yuva420p".to_string());
                match segment.backdrop.as_ref().filter(|_| is_shadow) {
                    Some(backdrop) => {
                        let (r, g, b) = rgb_of(&backdrop.shadow.color);
                        chain.push(format!("geq=r='{r}':g='{g}':b='{b}':a='{mask}'"));
                    }
                    None => {
                        chain.push(format!(
                            "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='{mask}'"
                        ));
                    }
                }
            }

            // Clip zoom, relative to whatever the layer's own size is.
            // `eval=frame` is what makes a scale curve actually move; without it
            // the expression would be resolved once at configuration and frozen.
            match ramp("scale", &pre_time) {
                Some(expr) => chain.push(format!(
                    "scale=eval=frame:w='2*round(iw*({expr})/2)':h='2*round(ih*({expr})/2)'"
                )),
                None => {
                    if (segment.scale - 1.0).abs() > 1e-3 {
                        chain.push(format!(
                            "scale=iw*{0:.4}:ih*{0:.4}",
                            segment.scale.clamp(0.01, 20.0)
                        ));
                    }
                }
            }

            // Alpha work has to happen in a format that has an alpha plane.
            chain.push("format=yuva420p".to_string());

            // Rotation grows the box. `ow`/`oh` are resolved once at
            // configuration, so an animated angle is given the diagonal — the
            // only box guaranteed to hold every angle the curve passes through.
            match ramp("rotation", &pre_time) {
                Some(expr) => chain.push(format!(
                    "rotate=a='({expr})*PI/180':ow='sqrt(iw*iw+ih*ih)':oh='sqrt(iw*iw+ih*ih)':c=black@0"
                )),
                None => {
                    if segment.rotation.abs() > 1e-3 {
                        let radians = segment.rotation.to_radians();
                        chain.push(format!(
                            "rotate=a={radians:.6}:ow=rotw(a):oh=roth(a):c=black@0"
                        ));
                    }
                }
            }

            /*
             * And finally the softening, for the shadow alone.
             *
             * Padded first: a blur cannot spread past the edge of the frame it
             * is given, and a shadow that stops dead at the picture's own
             * boundary is not a shadow. Three standard deviations is where a
             * Gaussian has spent better than 99 % of its weight, so that is the
             * room it gets — no more, because every padded pixel is blurred.
             */
            if is_shadow {
                if let Some(backdrop) = segment.backdrop.as_ref() {
                    let sigma = backdrop.shadow.blur.max(0.0);
                    if sigma > 0.0 {
                        let room = (sigma * 3.0).ceil().max(1.0) as u32;
                        chain.push(format!(
                            "pad=iw+{0}:ih+{0}:{1}:{1}:color=black@0",
                            room * 2,
                            room
                        ));
                        chain.push(format!("gblur=sigma={sigma:.2}:steps=2"));
                    }
                    chain.push(format!(
                        "colorchannelmixer=aa={:.3}",
                        backdrop.shadow.opacity.clamp(0.0, 1.0)
                    ));
                }
            }
        }

        // Opacity: a constant is a cheap channel mix, a curve needs a per-pixel
        // pass because no alpha filter takes an expression.
        match ramp("opacity", &geq_time) {
            Some(expr) => chain.push(format!(
                "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*min(max({expr},0),1)'"
            )),
            None => {
                if segment.opacity < 0.999 {
                    chain.push(format!(
                        "colorchannelmixer=aa={:.3}",
                        segment.opacity.clamp(0.0, 1.0)
                    ));
                }
            }
        }
        if segment.fade_in > 0.0 {
            chain.push(format!(
                "fade=t=in:st={}:d={}:alpha=1",
                trim(segment.fade_in_start),
                trim(segment.fade_in)
            ));
        }
        if segment.fade_out > 0.0 {
            chain.push(format!(
                "fade=t=out:st={}:d={}:alpha=1",
                trim(segment.fade_out_start),
                trim(segment.fade_out)
            ));
        }

        // Position on the timeline: transparent padding ahead of the segment.
        if segment.render_in > 0.0 {
            chain.push(format!(
                "tpad=start_duration={}:start_mode=add:color=black@0",
                trim(segment.render_in)
            ));
        }

        // Position is applied at the overlay, so its curve uses timeline time.
        let position = (
            ramp("x", &overlay_time),
            ramp("y", &overlay_time),
        );

        let label = format!("v{index}");
        chains.push(format!("{source}{}[{label}]", chain.join(",")));
        video_labels.push(label);
        offsets.push((segment.x, segment.y, position.0, position.1));
        index += 1;
    }

    // ---------------------------------------------------------------- audio
    // Clips feed their track's bus; buses are then summed. Panning, filtering
    // and compression belong to the stem, not to an individual take.
    let mut clip_labels: HashMap<String, Vec<String>> = HashMap::new();
    for segment in &audio {
        let path = segment.source_path.clone().unwrap_or_default();
        let span = (segment.timeline_out - segment.timeline_in).max(0.01);

        args.push("-ss".into());
        args.push(trim(segment.source_in));
        args.push("-t".into());
        args.push(trim(span));
        args.push("-i".into());
        args.push(path);

        // Same rule as the video chain: the pad is a prefix, never a member.
        let source = format!("[{index}:a]");
        let mut chain = vec![
            "asetpts=PTS-STARTPTS".to_string(),
            "aresample=async=1".to_string(),
        ];

        // After `asetpts` the segment's clock starts at zero, which is also
        // where clip-relative keyframe times start — so the curve needs no
        // offset here. `eval=frame` is what makes the gain actually move.
        match segment
            .animated
            .get("volume")
            .and_then(|points| ramp_expression(points, "t"))
        {
            Some(expr) => chain.push(format!("volume=volume='min(max({expr},0),1)':eval=frame")),
            None => chain.push(format!("volume={:.3}", segment.volume.clamp(0.0, 1.0))),
        }
        let delay_ms = (segment.timeline_in * 1000.0).round().max(0.0) as i64;
        if delay_ms > 0 {
            chain.push(format!("adelay={delay_ms}:all=1"));
        }

        let label = format!("a{index}");
        chains.push(format!("{source}{}[{label}]", chain.join(",")));
        clip_labels.entry(segment.track_id.clone()).or_default().push(label);
        index += 1;
    }

    let mut audio_labels: Vec<String> = Vec::new();
    for (position, bus) in plan.tracks.iter().enumerate() {
        let Some(clips) = clip_labels.get(&bus.id) else { continue };
        if clips.is_empty() {
            continue;
        }

        let inputs: String = clips.iter().map(|label| format!("[{label}]")).collect();
        let summed = format!("s{position}");
        chains.push(format!(
            "{inputs}amix=inputs={}:duration=longest:normalize=0[{summed}]",
            clips.len()
        ));

        let mut bus_chain: Vec<String> = Vec::new();
        if (bus.volume - 1.0).abs() > 1e-3 {
            bus_chain.push(format!("volume={:.3}", bus.volume));
        }
        if bus.pan.abs() > 1e-3 {
            // Classic balance: attenuate the side you are panning away from.
            let left = if bus.pan <= 0.0 { 1.0 } else { 1.0 - bus.pan };
            let right = if bus.pan >= 0.0 { 1.0 } else { 1.0 + bus.pan };
            bus_chain.push(format!("pan=stereo|c0={left:.3}*c0|c1={right:.3}*c1"));
        }
        if bus.high_pass > 0.0 {
            bus_chain.push(format!("highpass=f={:.0}", bus.high_pass));
        }
        if bus.low_pass > 0.0 {
            bus_chain.push(format!("lowpass=f={:.0}", bus.low_pass));
        }
        if let Some(comp) = bus.compressor {
            // acompressor takes linear amplitudes, not decibels.
            bus_chain.push(format!(
                "acompressor=threshold={:.5}:ratio={:.2}:makeup={:.3}:attack=20:release=250",
                from_db(comp.threshold_db).clamp(0.000_977, 1.0),
                comp.ratio,
                from_db(comp.makeup_db).clamp(1.0, 64.0),
            ));
        }

        let label = format!("t{position}");
        if bus_chain.is_empty() {
            chains.push(format!("[{summed}]anull[{label}]"));
        } else {
            chains.push(format!("[{summed}]{}[{label}]", bus_chain.join(",")));
        }
        audio_labels.push(label);
    }

    // ------------------------------------------------------------- compose
    let mut last = "base".to_string();
    chains.push(format!(
        "color=c=black:s={width}x{height}:r={fps}:d={}[base]",
        trim(duration)
    ));

    for (position, label) in video_labels.iter().enumerate() {
        let next = format!("o{position}");
        let fallback = (0.0, 0.0, None, None);
        let (dx, dy, x_curve, y_curve) = offsets.get(position).cloned().unwrap_or(fallback);

        // Layers are centred, then displaced by the clip transform. W/H are the
        // canvas, w/h the layer, so this holds whatever the layer's own size is.
        let x = match x_curve {
            Some(expr) => format!("'(W-w)/2+({expr})'"),
            None => format!("(W-w)/2+{}", dx.round() as i64),
        };
        let y = match y_curve {
            Some(expr) => format!("'(H-h)/2+({expr})'"),
            None => format!("(H-h)/2+{}", dy.round() as i64),
        };

        // `repeatlast=0` matters: without it the final frame of a segment would
        // stay painted over the rest of the timeline.
        chains.push(format!(
            "[{last}][{label}]overlay=x={x}:y={y}:eof_action=pass:repeatlast=0:format=auto[{next}]"
        ));
        last = next;
    }

    // Dips are a property of the finished picture, not of any one segment.
    let dips: Vec<String> = plan
        .transitions
        .iter()
        .filter(|item| item.kind != "crossfade")
        .map(|item| item.ffmpeg.clone())
        .collect();

    let mut tail: Vec<String> = dips;

    /*
     * The progress bar, on top of everything — including the dips.
     *
     * Chrome rather than picture: a dip to black is a transition *in* the film,
     * and the bar is the frame around it. Drawing it after the dips is what
     * keeps it readable across one.
     *
     * The fill spans the exported window rather than the timeline. `-ss` is an
     * output option here, so the graph's `t` is still absolute timeline time —
     * which is exactly why the offset has to be subtracted rather than assumed
     * away. `exportWindow` in `src/types/export.ts` is the viewer's twin of the
     * same arithmetic.
     */
    if let Some(bar) = plan.progress.as_ref().filter(|bar| bar.draws()) {
        let (x, y, w, h) = bar.rect(width, height);
        let span = (window_out - window_in).max(1.0 / fps);

        if bar.track_opacity > 0.0 {
            tail.push(format!(
                "drawbox=x={x}:y={y}:w={w}:h={h}:color={}@{:.3}:t=fill",
                crate::model::ffmpeg_color(&bar.track_color),
                bar.track_opacity.clamp(0.0, 1.0)
            ));
        }
        if bar.opacity > 0.0 {
            // Quoted, and that is what protects the commas inside `min`/`max`:
            // unquoted they would end the filter and libavfilter would read the
            // rest as a filter with no name. The animated-opacity `geq` above
            // relies on exactly the same thing.
            tail.push(format!(
                "drawbox=x={x}:y={y}:w='{w}*min(1,max(0,(t-{:.3})/{:.3}))':h={h}:color={}@{:.3}:t=fill",
                window_in,
                span,
                crate::model::ffmpeg_color(&bar.color),
                bar.opacity.clamp(0.0, 1.0)
            ));
        }
    }

    if let Some(target) = settings.target_height() {
        if target != height {
            // `-2` keeps the aspect ratio and lands on an even width, which
            // every one of these codecs requires.
            tail.push(format!("scale=-2:{target}:flags=lanczos"));
        }
    }
    tail.push(format!("format={}", codec.pixel_format));
    chains.push(format!("[{last}]{}[vout]", tail.join(",")));

    if !audio_labels.is_empty() {
        let inputs: String = audio_labels.iter().map(|label| format!("[{label}]")).collect();
        chains.push(format!(
            "{inputs}amix=inputs={}:duration=longest:normalize=0[aout]",
            audio_labels.len()
        ));
    }

    args.push("-filter_complex".into());
    args.push(chains.join(";"));

    args.push("-map".into());
    args.push("[vout]".into());
    if !audio_labels.is_empty() {
        args.push("-map".into());
        args.push("[aout]".into());
    }

    args.push("-c:v".into());
    args.push(codec.video.into());

    if codec.supports_crf {
        if settings.rate_mode == "bitrate" && settings.bitrate_kbps > 0 {
            let rate = settings.bitrate_kbps;
            args.extend(["-b:v".into(), format!("{rate}k")]);
            // VP9 needs an explicit ceiling to leave constant-quality mode.
            if codec.video == "libvpx-vp9" {
                args.extend(["-maxrate".into(), format!("{}k", rate * 3 / 2)]);
            } else {
                args.extend([
                    "-maxrate".into(),
                    format!("{}k", rate * 3 / 2),
                    "-bufsize".into(),
                    format!("{}k", rate * 2),
                ]);
            }
        } else {
            args.extend(["-crf".into(), format!("{}", settings.crf.round() as i64)]);
            if codec.video == "libvpx-vp9" {
                // Constant quality in VP9 is CRF *plus* an unset bitrate.
                args.extend(["-b:v".into(), "0".into()]);
            }
        }
        if !settings.preset.is_empty() && codec.video != "libvpx-vp9" {
            args.extend(["-preset".into(), settings.preset.clone()]);
        }
    } else {
        // ProRes: the profile is the quality dial.
        args.extend([
            "-profile:v".into(),
            format!("{}", settings.crf.round().clamp(0.0, 3.0) as i64),
        ]);
    }

    args.extend(["-pix_fmt".into(), codec.pixel_format.into()]);
    if settings.format.starts_with("mp4") {
        args.extend(["-movflags".into(), "+faststart".into()]);
    }

    args.push("-r".into());
    args.push(settings.target_fps().unwrap_or(fps).to_string());

    if !audio_labels.is_empty() {
        args.extend(["-c:a".into(), codec.audio.into()]);
        if codec.audio != "pcm_s16le" {
            args.extend(["-b:a".into(), format!("{}k", settings.audio_bitrate_kbps)]);
        }
    }

    // Output-side trimming: the graph always describes the whole timeline, and
    // the range simply decides which part of it reaches the file.
    if window_in > 0.0 {
        args.extend(["-ss".into(), trim(window_in)]);
    }
    args.push("-t".into());
    args.push(trim(window_out - window_in));
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());
    args.push(output.to_string_lossy().to_string());

    for note in warnings {
        eprintln!("veglass: {note}");
    }

    let out_fps = settings.target_fps().unwrap_or(fps);
    Ok(FfmpegCommand {
        args,
        total_frames: ((window_out - window_in) * out_fps).round().max(1.0) as u64,
    })
}

/// Shared handle on the running job, so a cancel request can reach the child.
#[derive(Default)]
pub struct ExportControl {
    pub child: Mutex<Option<std::process::Child>>,
    pub cancelled: Mutex<bool>,
}

impl ExportControl {
    pub fn cancel(&self) -> bool {
        *self.cancelled.lock().unwrap() = true;
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.kill();
            return true;
        }
        false
    }

    fn arm(&self) {
        *self.cancelled.lock().unwrap() = false;
    }

    fn was_cancelled(&self) -> bool {
        *self.cancelled.lock().unwrap()
    }
}

pub struct FfmpegEncoder {
    program: PathBuf,
    probe: Option<PathBuf>,
    settings: ExportSettings,
    control: Arc<ExportControl>,
}

impl FfmpegEncoder {
    /// `None` when no ffmpeg can be found; the caller turns that into a message.
    pub fn discover(settings: ExportSettings, control: Arc<ExportControl>) -> Option<Self> {
        locate_binary("ffmpeg").map(|program| Self {
            program,
            probe: locate_binary("ffprobe"),
            settings,
            control,
        })
    }
}

impl Encoder for FfmpegEncoder {
    fn name(&self) -> &'static str {
        "ffmpeg"
    }

    fn encode(
        &self,
        plan: &RenderPlan,
        output: &Path,
        on_progress: &mut dyn FnMut(EncodeProgress),
    ) -> Result<(), String> {
        let mut streams: HashMap<String, Streams> = HashMap::new();
        for segment in &plan.segments {
            if let Some(path) = segment.source_path.as_ref() {
                streams
                    .entry(path.clone())
                    .or_insert_with(|| probe_streams(self.probe.as_deref(), path));
            }
        }

        let mut command = build_args(plan, &streams, output, &self.settings)?;
        let total = command.total_frames;

        /*
         * Spill the graph when the line would not fit.
         *
         * Kept alive for the whole encode: dropping the guard removes the file,
         * and ffmpeg reads it after it has started.
         */
        let _spilled = if command_length(&self.program, &command.args) > COMMAND_BUDGET {
            let file = std::env::temp_dir().join(format!(
                "veglass-graph-{}.txt",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|value| value.as_nanos())
                    .unwrap_or(0)
            ));
            spill_graph(&mut command.args, &file)?.then_some(Spilled(file))
        } else {
            None
        };
        let spilled = _spilled.is_some();

        self.control.arm();

        on_progress(EncodeProgress {
            frame: 0,
            total_frames: total,
            stage: "Préparation".to_string(),
            speed: 0.0,
        });

        let mut child = crate::proc::command(&self.program)
            .args(&command.args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Impossible de lancer ffmpeg : {error}"))?;

        // stderr is drained on its own thread: ffmpeg blocks once the pipe
        // fills, and its tail is what makes a failure diagnosable.
        let stderr = child.stderr.take();
        let stdout = child.stdout.take();
        let stderr_handle = std::thread::spawn(move || {
            let mut tail: Vec<String> = Vec::new();
            if let Some(stream) = stderr {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    tail.push(line);
                    if tail.len() > 40 {
                        tail.remove(0);
                    }
                }
            }
            tail
        });

        // Handing the child over lets a cancel request kill it mid-encode.
        *self.control.child.lock().unwrap() = Some(child);

        let mut speed = 1.0_f64;
        if let Some(stdout) = stdout {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Some((key, value)) = line.split_once('=') else {
                    continue;
                };
                match key.trim() {
                    "speed" => {
                        speed = value.trim().trim_end_matches('x').parse::<f64>().unwrap_or(speed);
                    }
                    "frame" => {
                        if let Ok(frame) = value.trim().parse::<u64>() {
                            on_progress(EncodeProgress {
                                frame: frame.min(total),
                                total_frames: total,
                                stage: "Encodage".to_string(),
                                speed,
                            });
                        }
                    }
                    "progress" if value.trim() == "end" => {
                        on_progress(EncodeProgress {
                            frame: total,
                            total_frames: total,
                            stage: "Finalisation".to_string(),
                            speed,
                        });
                    }
                    _ => {}
                }
            }
        }

        let status = {
            let mut slot = self.control.child.lock().unwrap();
            let child = slot.as_mut().ok_or("Le rendu a disparu")?;
            let status = child
                .wait()
                .map_err(|error| format!("ffmpeg s'est interrompu : {error}"))?;
            *slot = None;
            status
        };
        let tail = stderr_handle.join().unwrap_or_default();

        if self.control.was_cancelled() {
            let _ = std::fs::remove_file(output);
            return Err("Rendu annulé".to_string());
        }

        if status.success() {
            Ok(())
        } else {
            let detail = tail
                .iter()
                .rev()
                .find(|line| line.contains("Error") || line.contains("error") || line.contains("Invalid"))
                .cloned()
                .unwrap_or_else(|| tail.last().cloned().unwrap_or_default());
            /*
             * `-/filter_complex` is recent. A build old enough to refuse it
             * cannot render a montage this size at all — the graph does not fit
             * on a command line — and saying which of the two problems this is
             * saves someone a long hunt through their filters.
             */
            let hint = if spilled && detail.contains("Unrecognized option") {
                "\nCe montage a trop de plans pour tenir sur une ligne de commande, et cette version de ffmpeg ne sait pas lire un graphe depuis un fichier. Mettez ffmpeg à jour, ou raccourcissez le montage."
            } else {
                ""
            };
            Err(format!(
                "ffmpeg a échoué (code {}). {detail}{hint}",
                status.code().unwrap_or(-1)
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::render::{TrackBus, TransitionPlan, ROLE_CLIP};

    fn segment(kind: &str, layer: usize, path: &str) -> RenderSegment {
        RenderSegment {
            track_name: "V1".into(),
            kind: kind.into(),
            layer,
            source: "a.mp4".into(),
            source_path: Some(path.into()),
            timeline_in: 0.0,
            timeline_out: 4.0,
            source_in: 0.0,
            track_id: "tr1".into(),
            render_in: 0.0,
            render_out: 4.0,
            fade_in_start: 0.0,
            fade_in: 0.0,
            fade_out_start: 0.0,
            fade_out: 0.0,
            volume: 1.0,
            opacity: 1.0,
            scale: 1.0,
            x: 0.0,
            y: 0.0,
            rotation: 0.0,
            is_still: false,
            conform: true,
            needs_bake: false,
            is_sequence: false,
            animated: HashMap::new(),
            effects: vec![],
            filters: vec![],
            role: ROLE_CLIP.to_string(),
            backdrop: None,
        }
    }

    fn plan(segments: Vec<RenderSegment>, transitions: Vec<TransitionPlan>) -> RenderPlan {
        RenderPlan {
            project_name: "T".into(),
            width: 1920,
            height: 1080,
            fps: 30.0,
            duration: 8.0,
            frame_count: 240,
            segments,
            tracks: vec![TrackBus {
                id: "tr1".into(),
                name: "V1".into(),
                kind: "video".into(),
                muted: false,
                volume: 1.0,
                pan: 0.0,
                high_pass: 0.0,
                low_pass: 0.0,
                compressor: None,
            }],
            transitions,
            warnings: vec![],
            progress: None,
            engine: "rust".into(),
        }
    }

    fn settings() -> ExportSettings {
        ExportSettings::default()
    }

    fn graph(args: &[String]) -> String {
        let index = args.iter().position(|a| a == "-filter_complex").expect("graphe absent");
        args[index + 1].clone()
    }

    /// Grammar check on a whole graph.
    ///
    /// Every filter in a chain must have a name. The ways to lose one are all
    /// punctuation: a comma straight after a pad label, two commas in a row, or
    /// a chain that opens or closes on one. ffmpeg answers each of them with
    /// the same unhelpful "Filter not found", so the graph is checked here,
    /// where the mistake is still legible.
    fn assert_well_formed(graph: &str) {
        for chain in graph.split(';') {
            assert!(!chain.is_empty(), "chaîne vide dans {graph}");
            assert!(!chain.contains(",,"), "filtre vide (,,) dans {chain}");
            assert!(!chain.contains("],"), "virgule après un pad dans {chain}");
            assert!(!chain.contains(",["), "virgule avant un pad dans {chain}");
            assert!(!chain.starts_with(','), "chaîne ouverte sur une virgule : {chain}");
            assert!(!chain.ends_with(','), "chaîne fermée sur une virgule : {chain}");
        }
    }

    #[test]
    fn every_generated_graph_is_well_formed() {
        let mut streams = HashMap::new();
        streams.insert("/m/a.mp4".to_string(), Streams { video: true, audio: true });
        streams.insert("/m/b.mp4".to_string(), Streams { video: true, audio: false });
        streams.insert("/m/a.mp3".to_string(), Streams { video: false, audio: true });

        let mut animated = segment("video", 0, "/m/a.mp4");
        animated.animated.insert(
            "opacity".into(),
            vec![
                Breakpoint { time: 0.0, value: 0.0 },
                Breakpoint { time: 1.0, value: 1.0 },
            ],
        );

        let cases: Vec<(&str, RenderPlan)> = vec![
            ("un seul clip", plan(vec![segment("video", 0, "/m/a.mp4")], vec![])),
            (
                "deux calques",
                plan(
                    vec![segment("video", 1, "/m/a.mp4"), segment("video", 0, "/m/b.mp4")],
                    vec![],
                ),
            ),
            ("animation", plan(vec![animated], vec![])),
            ("audio et bus", audio_plan(bus("tr1"))),
        ];

        for (name, case) in cases {
            let built = build_args(&case, &streams, Path::new("o.mp4"), &settings()).unwrap();
            let g = graph(&built.args);
            assert!(!g.is_empty(), "{name} : graphe vide");
            assert_well_formed(&g);
        }
    }

    /// Each filter names its own clock. Getting this wrong costs the whole
    /// render, because ffmpeg refuses a graph with one undefined constant in it.
    #[test]
    fn geq_uses_its_own_uppercase_clock() {
        let mut animated = segment("video", 0, "/m/a.mp4");
        animated.animated.insert(
            "opacity".into(),
            vec![
                Breakpoint { time: 0.0, value: 0.0 },
                Breakpoint { time: 1.0, value: 1.0 },
            ],
        );
        let built = build_args(
            &plan(vec![animated], vec![]),
            &HashMap::new(),
            Path::new("o.mp4"),
            &settings(),
        )
        .unwrap();
        let g = graph(&built.args);

        // Splitting on commas would cut through `r(X,Y)`; the alpha argument is
        // read out by its own delimiters instead.
        let start = g.find("geq=").expect("passe geq attendue pour une opacité animée");
        let open = start + g[start..].find(":a='").expect("argument alpha attendu") + 4;
        let close = open + g[open..].find('\'').expect("guillemet fermant");
        let alpha = &g[open..close];

        // A bare variable, not the letter: `lt(` and `alpha(` both contain a
        // `t` that has nothing to do with the clock.
        let bare = |needle: u8, text: &str| -> bool {
            let bytes = text.as_bytes();
            (0..bytes.len()).any(|i| {
                bytes[i] == needle
                    && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric())
                    && (i + 1 == bytes.len() || !bytes[i + 1].is_ascii_alphanumeric())
            })
        };

        assert!(bare(b'T', alpha), "geq doit lire T : {alpha}");
        assert!(!bare(b't', alpha), "geq ne doit jamais lire t minuscule : {alpha}");
    }

    #[test]
    fn source_pads_are_never_followed_by_a_comma() {
        let built = build_args(
            &plan(vec![segment("video", 0, "/m/a.mp4")], vec![]),
            &HashMap::new(),
            Path::new("o.mp4"),
            &settings(),
        )
        .unwrap();
        let g = graph(&built.args);
        // The exact shape the encoder needs, and the one that regressed.
        assert!(g.contains("[0:v]fps="), "pad collé au premier filtre attendu, obtenu : {g}");
    }

    #[test]
    fn an_empty_timeline_is_refused_rather_than_encoded() {
        let mut empty = plan(vec![], vec![]);
        empty.duration = 0.0;
        assert!(build_args(&empty, &HashMap::new(), Path::new("out.mp4"), &settings()).is_err());
    }

    fn glass() -> crate::model::Backdrop {
        crate::model::Backdrop {
            blur: 40.0,
            zoom: 1.12,
            tint: "#0B0E13".into(),
            tint_opacity: 0.42,
            radius: 22.0,
            shadow: crate::model::BackdropShadow {
                blur: 26.0,
                y: 14.0,
                color: "#000000".into(),
                opacity: 0.55,
            },
        }
    }

    /// The three passes of a backdropped clip, as `plan_render` emits them.
    fn glass_plan() -> RenderPlan {
        let mut backdrop = segment("video", 0, "/m/a.mp4");
        backdrop.role = ROLE_BACKDROP.to_string();
        backdrop.backdrop = Some(glass());
        backdrop.scale = 1.0;

        let mut shadow = segment("video", 0, "/m/a.mp4");
        shadow.role = ROLE_SHADOW.to_string();
        shadow.backdrop = Some(glass());
        shadow.y = 14.0;

        let mut clip = segment("video", 0, "/m/a.mp4");
        clip.backdrop = Some(glass());

        plan(vec![backdrop, shadow, clip], vec![])
    }

    /// The property the whole look rests on.
    ///
    /// The three passes share one `layer`, and `build_args` sorts by layer. If
    /// that sort were ever unstable — or replaced by one that is — the glass
    /// could end up over the picture and the shadow over both. Rust's
    /// `sort_by_key` is stable and this asserts we are relying on it knowingly.
    #[test]
    fn the_glass_is_drawn_behind_the_picture_it_belongs_to() {
        let built =
            build_args(&glass_plan(), &HashMap::new(), Path::new("out.mp4"), &settings()).unwrap();
        let g = graph(&built.args);

        let glass_at = g.find("gblur=sigma=40.00").expect("le fond flouté est dans le graphe");
        let shadow_at = g.find("gblur=sigma=26.00").expect("l'ombre est dans le graphe");
        // The clip pass is the only one that keeps the source's own pixels.
        let clip_at = g
            .find("geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)'")
            .expect("la couche principale est dans le graphe");

        assert!(glass_at < shadow_at, "le fond doit précéder l'ombre");
        assert!(shadow_at < clip_at, "l'ombre doit précéder l'image");
    }

    #[test]
    fn the_glass_covers_and_overscans_before_it_blurs() {
        let built =
            build_args(&glass_plan(), &HashMap::new(), Path::new("out.mp4"), &settings()).unwrap();
        let g = graph(&built.args);

        // 1920×1080 magnified by 1.12, covered rather than contained.
        assert!(g.contains("scale=2150:1210:force_original_aspect_ratio=increase"));
        assert!(g.contains("crop=2150:1210"));
        // Cropped back to the frame *after* the blur: that is what the overscan
        // was for, and doing it in the other order pales the edges.
        let blur = g.find("gblur=sigma=40.00").unwrap();
        assert!(g[blur..].contains("crop=1920:1080"));
        assert!(g.contains("drawbox=x=0:y=0:w=1920:h=1080:color=0x0B0E13@0.420:t=fill"));
    }

    /// A backdrop fills the frame, so it must not be moved, scaled or turned —
    /// the same rule a generated background follows, and for the same reason.
    #[test]
    fn the_glass_is_never_transformed() {
        let mut backdrop = segment("video", 0, "/m/a.mp4");
        backdrop.role = ROLE_BACKDROP.to_string();
        backdrop.backdrop = Some(glass());
        backdrop.scale = 1.0;
        backdrop.rotation = 0.0;

        let built = build_args(
            &plan(vec![backdrop], vec![]),
            &HashMap::new(),
            Path::new("out.mp4"),
            &settings(),
        )
        .unwrap();
        let g = graph(&built.args);

        assert!(!g.contains("rotate="));
        assert!(!g.contains("force_original_aspect_ratio=decrease"));
        assert!(g.contains("overlay=x=(W-w)/2+0:y=(H-h)/2+0"));
    }

    #[test]
    fn a_shadow_is_flooded_padded_and_only_then_blurred() {
        let built =
            build_args(&glass_plan(), &HashMap::new(), Path::new("out.mp4"), &settings()).unwrap();
        let g = graph(&built.args);

        // Flooded with its own colour in the same pass that cuts the corners.
        let flood = g.find("geq=r='0':g='0':b='0'").expect("silhouette teintée");
        // Three standard deviations of room, on every side, before the blur.
        let pad = g[flood..].find("pad=iw+156:ih+156:78:78:color=black@0").expect("marge");
        let blur = g[flood..].find("gblur=sigma=26.00").expect("flou de l'ombre");
        assert!(pad < blur, "la marge doit précéder le flou");
        assert!(g.contains("colorchannelmixer=aa=0.550"));
    }

    #[test]
    fn corners_are_cut_before_the_layer_is_scaled() {
        let mut clip = segment("video", 0, "/m/a.mp4");
        clip.backdrop = Some(glass());
        clip.scale = 0.8;

        let built = build_args(
            &plan(vec![clip], vec![]),
            &HashMap::new(),
            Path::new("out.mp4"),
            &settings(),
        )
        .unwrap();
        let g = graph(&built.args);

        let cut = g.find("geq=r='r(X,Y)'").expect("masque d'angles");
        let scale = g.find("scale=iw*0.8000").expect("mise à l'échelle");
        // CSS rounds the element and *then* transforms it, so the radius has to
        // shrink with the layer. Cutting first is what reproduces that.
        assert!(cut < scale, "le masque doit précéder l'échelle");
    }

    #[test]
    fn a_clip_without_a_backdrop_is_untouched() {
        let p = plan(vec![segment("video", 0, "/m/a.mp4")], vec![]);
        let built = build_args(&p, &HashMap::new(), Path::new("out.mp4"), &settings()).unwrap();
        let g = graph(&built.args);

        assert!(!g.contains("gblur"));
        assert!(!g.contains("geq="));
        assert!(!g.contains("drawbox"));
    }

    #[test]
    fn a_square_cornered_silhouette_is_still_a_silhouette() {
        assert_eq!(rounded_alpha(0.0), "255");
        assert_eq!(rounded_alpha(0.4), "255");
        let mask = rounded_alpha(22.0);
        assert!(mask.contains("22.00"));
        // Measured against the plane's own size, so one string serves any layer.
        assert!(mask.contains('W') && mask.contains('H'));
    }

    #[test]
    fn a_colour_reaches_the_graph_in_the_two_spellings_it_needs() {
        assert_eq!(rgb_of("#0B0E13"), (11, 14, 19));
        assert_eq!(rgb_of("fff"), (255, 255, 255));
        // Never an error: a malformed colour must not stop an export.
        assert_eq!(rgb_of("nope"), (0, 0, 0));
        assert_eq!(rgb_of(""), (0, 0, 0));

        assert_eq!(crate::model::ffmpeg_color("#0B0E13"), "0x0B0E13");
        assert_eq!(crate::model::ffmpeg_color("fff"), "0xFFFFFF");
        assert_eq!(crate::model::ffmpeg_color("#zzz"), "0x000000");
    }

    fn bar() -> crate::model::ProgressBar {
        crate::model::ProgressBar {
            height: 6.0,
            color: "#31E1A6".into(),
            track_color: "#FFFFFF".into(),
            track_opacity: 0.18,
            position: "bottom".into(),
            margin: 28.0,
            inset: 0.0,
            opacity: 1.0,
        }
    }

    #[test]
    fn a_progress_bar_is_two_boxes_on_the_finished_composite() {
        let mut p = plan(vec![segment("video", 0, "/m/a.mp4")], vec![]);
        p.progress = Some(bar());
        let built = build_args(&p, &HashMap::new(), Path::new("out.mp4"), &settings()).unwrap();
        let g = graph(&built.args);

        // 1080 tall, 28 from the bottom, 6 high → the groove sits at y = 1046.
        assert!(g.contains("drawbox=x=0:y=1046:w=1920:h=6:color=0xFFFFFF@0.180:t=fill"));
        assert!(g.contains("drawbox=x=0:y=1046:w='1920*min(1,max(0,(t-0.000)/8.000))':h=6:color=0x31E1A6@1.000:t=fill"));
    }

    /// The bar is chrome: a dip to black is a transition *in* the film, and the
    /// frame around it stays readable.
    #[test]
    fn the_bar_is_drawn_after_the_dips() {
        let mut p = plan(
            vec![segment("video", 0, "/m/a.mp4")],
            vec![TransitionPlan {
                kind: "dip-black".into(),
                track_name: "V1".into(),
                start: 1.0,
                end: 2.0,
                duration: 1.0,
                from_source: None,
                to_source: None,
                ffmpeg: "fade=t=out:st=1:d=1".into(),
            }],
        );
        p.progress = Some(bar());
        let built = build_args(&p, &HashMap::new(), Path::new("out.mp4"), &settings()).unwrap();
        let g = graph(&built.args);

        assert!(g.find("fade=t=out:st=1:d=1").unwrap() < g.find("drawbox").unwrap());
    }

    /// `-ss` is an output option, so the graph's clock is still absolute
    /// timeline time — the offset has to be subtracted, not assumed away.
    #[test]
    fn the_fill_spans_the_exported_window_not_the_timeline() {
        let mut p = plan(vec![segment("video", 0, "/m/a.mp4")], vec![]);
        p.progress = Some(bar());

        let mut export = settings();
        export.range = "work".into();
        export.work_in = Some(2.0);
        export.work_out = Some(6.0);

        let built = build_args(&p, &HashMap::new(), Path::new("out.mp4"), &export).unwrap();
        let g = graph(&built.args);
        assert!(g.contains("(t-2.000)/4.000"), "{g}");
    }

    #[test]
    fn a_bar_nobody_asked_for_draws_nothing() {
        let p = plan(vec![segment("video", 0, "/m/a.mp4")], vec![]);
        let built = build_args(&p, &HashMap::new(), Path::new("out.mp4"), &settings()).unwrap();
        assert!(!graph(&built.args).contains("drawbox"));

        let mut hidden = plan(vec![segment("video", 0, "/m/a.mp4")], vec![]);
        hidden.progress = Some(crate::model::ProgressBar { opacity: 0.0, track_opacity: 0.0, ..bar() });
        let built = build_args(&hidden, &HashMap::new(), Path::new("out.mp4"), &settings()).unwrap();
        assert!(!graph(&built.args).contains("drawbox"));
    }

    /// The twin of `progressRect` in `src/types/progress.ts`. The two agreeing
    /// to the pixel is the difference between a bar on the safe line and one
    /// under the platform's own interface.
    #[test]
    fn the_bar_rectangle_matches_its_typescript_twin() {
        assert_eq!(bar().rect(1080, 1920), (0, 1886, 1080, 6));

        let top = crate::model::ProgressBar { position: "top".into(), margin: 24.0, inset: 24.0, ..bar() };
        assert_eq!(top.rect(1080, 1920), (24, 24, 1032, 6));

        // A margin taller than the frame cannot push the bar off it.
        let silly = crate::model::ProgressBar { margin: 9000.0, ..bar() };
        let (_, y, _, h) = silly.rect(1080, 1920);
        assert!(y >= 0 && y + h <= 1920);
    }

    #[test]
    fn a_single_clip_produces_a_conformed_overlay_over_black() {
        let p = plan(vec![segment("video", 0, "/m/a.mp4")], vec![]);
        let built = build_args(&p, &HashMap::new(), Path::new("out.mp4"), &settings()).unwrap();
        let g = graph(&built.args);

        assert!(g.contains("scale=1920:1080:force_original_aspect_ratio=decrease"));
        assert!(g.contains("color=c=black:s=1920x1080:r=30:d=8.000[base]"));
        assert!(g.contains("overlay=x=(W-w)/2+0:y=(H-h)/2+0:eof_action=pass:repeatlast=0:format=auto"));
        assert!(g.ends_with("format=yuv420p[vout]"));
        assert_eq!(built.total_frames, 240);
    }

    #[test]
    fn layers_are_overlaid_bottom_up() {
        // Layer 0 is the topmost track, so it must be drawn last.
        let mut top = segment("video", 0, "/m/top.mp4");
        top.source = "top.mp4".into();
        let mut bottom = segment("video", 1, "/m/bottom.mp4");
        bottom.source = "bottom.mp4".into();

        let built = build_args(&plan(vec![top, bottom], vec![]), &HashMap::new(), Path::new("o.mp4"), &settings()).unwrap();
        let inputs: Vec<&String> = built
            .args
            .iter()
            .enumerate()
            .filter(|(i, _)| *i > 0 && built.args[i - 1] == "-i")
            .map(|(_, value)| value)
            .collect();
        assert_eq!(inputs, vec!["/m/bottom.mp4", "/m/top.mp4"]);
    }

    #[test]
    fn a_dissolve_becomes_alpha_ramps_and_transparent_padding() {
        let mut outgoing = segment("video", 0, "/m/a.mp4");
        outgoing.fade_out_start = 3.6;
        outgoing.fade_out = 0.8;
        outgoing.render_out = 4.4;

        let mut incoming = segment("video", 0, "/m/b.mp4");
        incoming.render_in = 3.6;
        incoming.timeline_in = 4.0;
        incoming.timeline_out = 8.0;
        incoming.render_out = 8.0;
        incoming.fade_in_start = 0.0;
        incoming.fade_in = 0.8;

        let built = build_args(&plan(vec![outgoing, incoming], vec![]), &HashMap::new(), Path::new("o.mp4"), &settings()).unwrap();
        let g = graph(&built.args);

        assert!(g.contains("fade=t=out:st=3.600:d=0.800:alpha=1"));
        assert!(g.contains("fade=t=in:st=0.000:d=0.800:alpha=1"));
        assert!(g.contains("tpad=start_duration=3.600:start_mode=add:color=black@0"));
    }

    #[test]
    fn dips_land_on_the_composite_and_crossfades_do_not() {
        let transitions = vec![
            TransitionPlan {
                kind: "dip-black".into(),
                track_name: "V1".into(),
                start: 3.6,
                end: 4.4,
                duration: 0.8,
                from_source: None,
                to_source: None,
                ffmpeg: "fade=t=out:st=3.6:d=0.4:color=black".into(),
            },
            TransitionPlan {
                kind: "crossfade".into(),
                track_name: "V1".into(),
                start: 1.0,
                end: 2.0,
                duration: 1.0,
                from_source: None,
                to_source: None,
                ffmpeg: "xfade=transition=fade:duration=1:offset=1".into(),
            },
        ];
        let built = build_args(&plan(vec![segment("video", 0, "/m/a.mp4")], transitions), &HashMap::new(), Path::new("o.mp4"), &settings()).unwrap();
        let g = graph(&built.args);

        assert!(g.contains("fade=t=out:st=3.6:d=0.4:color=black"));
        // The dissolve is already expressed as alpha; an xfade would double it.
        assert!(!g.contains("xfade"));
    }

    #[test]
    fn a_silent_video_source_contributes_no_audio_branch() {
        let mut streams = HashMap::new();
        streams.insert("/m/a.mp4".to_string(), Streams { video: true, audio: false });

        let built = build_args(&plan(vec![segment("video", 0, "/m/a.mp4")], vec![]), &streams, Path::new("o.mp4"), &settings()).unwrap();
        assert!(!graph(&built.args).contains("amix"));
        assert!(!built.args.iter().any(|a| a == "[aout]"));
    }

    #[test]
    fn an_audible_source_is_delayed_gained_and_mixed() {
        let mut streams = HashMap::new();
        streams.insert("/m/a.mp4".to_string(), Streams { video: true, audio: true });

        let mut seg = segment("video", 0, "/m/a.mp4");
        seg.timeline_in = 2.0;
        seg.timeline_out = 6.0;
        seg.volume = 0.5;

        let built = build_args(&plan(vec![seg], vec![]), &streams, Path::new("o.mp4"), &settings()).unwrap();
        let g = graph(&built.args);
        assert!(g.contains("volume=0.500"));
        assert!(g.contains("adelay=2000:all=1"));
        assert!(g.contains("amix=inputs=1:duration=longest:normalize=0[aout]"));
    }

    fn audio_plan(bus: TrackBus) -> RenderPlan {
        let mut seg = segment("audio", 0, "/m/a.mp3");
        seg.track_id = bus.id.clone();
        let mut p = plan(vec![seg], vec![]);
        p.tracks = vec![bus];
        p
    }

    fn bus(id: &str) -> TrackBus {
        TrackBus {
            id: id.into(),
            name: "A1".into(),
            kind: "audio".into(),
            muted: false,
            volume: 1.0,
            pan: 0.0,
            high_pass: 0.0,
            low_pass: 0.0,
            compressor: None,
        }
    }

    #[test]
    fn clips_are_summed_into_their_track_before_the_master_mix() {
        let mut streams = HashMap::new();
        streams.insert("/m/a.mp3".to_string(), Streams { video: false, audio: true });

        let g = graph(&build_args(&audio_plan(bus("tr1")), &streams, Path::new("o.mp4"), &settings()).unwrap().args);
        // Clip → bus → master: three stages, not one flat mix.
        assert!(g.contains("[s0]"));
        assert!(g.contains("[t0]"));
        assert!(g.contains("[aout]"));
    }

    #[test]
    fn a_bus_carries_pan_filters_and_compression() {
        let mut streams = HashMap::new();
        streams.insert("/m/a.mp3".to_string(), Streams { video: false, audio: true });

        let mut b = bus("tr1");
        b.volume = 0.5;
        b.pan = 0.5;
        b.high_pass = 120.0;
        b.low_pass = 15000.0;
        b.compressor = Some(crate::engine::render::CompressorPlan {
            threshold_db: -18.0,
            ratio: 4.0,
            makeup_db: 6.0,
        });

        let g = graph(&build_args(&audio_plan(b), &streams, Path::new("o.mp4"), &settings()).unwrap().args);
        assert!(g.contains("volume=0.500"));
        // Panned right: the left channel is the one attenuated.
        assert!(g.contains("pan=stereo|c0=0.500*c0|c1=1.000*c1"));
        assert!(g.contains("highpass=f=120"));
        assert!(g.contains("lowpass=f=15000"));
        assert!(g.contains("acompressor=threshold=0.12589:ratio=4.00"));
    }

    #[test]
    fn output_settings_pick_the_codec_and_the_rate() {
        let mut hevc = settings();
        hevc.format = "mp4-h265".into();
        hevc.crf = 24.0;
        let built = build_args(&plan(vec![segment("video", 0, "/m/a.mp4")], vec![]), &HashMap::new(), Path::new("o.mp4"), &hevc).unwrap();
        assert!(built.args.windows(2).any(|w| w[0] == "-c:v" && w[1] == "libx265"));
        assert!(built.args.windows(2).any(|w| w[0] == "-crf" && w[1] == "24"));

        let mut vp9 = settings();
        vp9.format = "webm-vp9".into();
        let built = build_args(&plan(vec![segment("video", 0, "/m/a.mp4")], vec![]), &HashMap::new(), Path::new("o.webm"), &vp9).unwrap();
        // Constant quality in VP9 is CRF *plus* an unset bitrate.
        assert!(built.args.windows(2).any(|w| w[0] == "-b:v" && w[1] == "0"));
        assert!(!built.args.iter().any(|a| a == "-preset"));

        let mut prores = settings();
        prores.format = "mov-prores".into();
        prores.crf = 3.0;
        let built = build_args(&plan(vec![segment("video", 0, "/m/a.mp4")], vec![]), &HashMap::new(), Path::new("o.mov"), &prores).unwrap();
        assert!(built.args.windows(2).any(|w| w[0] == "-profile:v" && w[1] == "3"));
        assert!(built.args.windows(2).any(|w| w[0] == "-pix_fmt" && w[1] == "yuv422p10le"));
        assert!(!built.args.iter().any(|a| a == "-crf"));
    }

    #[test]
    fn a_bitrate_target_replaces_the_rate_factor() {
        let mut cbr = settings();
        cbr.rate_mode = "bitrate".into();
        cbr.bitrate_kbps = 8000;
        let built = build_args(&plan(vec![segment("video", 0, "/m/a.mp4")], vec![]), &HashMap::new(), Path::new("o.mp4"), &cbr).unwrap();

        assert!(built.args.windows(2).any(|w| w[0] == "-b:v" && w[1] == "8000k"));
        assert!(built.args.windows(2).any(|w| w[0] == "-bufsize" && w[1] == "16000k"));
        assert!(!built.args.iter().any(|a| a == "-crf"));
    }

    #[test]
    fn a_work_area_trims_the_output_and_the_frame_count() {
        let mut range = settings();
        range.range = "work".into();
        range.work_in = Some(2.0);
        range.work_out = Some(5.0);

        let built = build_args(&plan(vec![segment("video", 0, "/m/a.mp4")], vec![]), &HashMap::new(), Path::new("o.mp4"), &range).unwrap();
        assert!(built.args.windows(2).any(|w| w[0] == "-ss" && w[1] == "2.000"));
        assert!(built.args.windows(2).any(|w| w[0] == "-t" && w[1] == "3.000"));
        // The progress bar must count the frames actually written.
        assert_eq!(built.total_frames, 90);
    }

    #[test]
    fn a_resolution_override_rescales_the_finished_composite() {
        let mut small = settings();
        small.resolution = "720".into();
        let g = graph(&build_args(&plan(vec![segment("video", 0, "/m/a.mp4")], vec![]), &HashMap::new(), Path::new("o.mp4"), &small).unwrap().args);
        assert!(g.contains("scale=-2:720:flags=lanczos"));
    }

    /// Pulls the red horizontal shift back out of an emitted `rgbashift`.
    fn shift_of(filter: &str) -> i64 {
        filter
            .split("rh=")
            .nth(1)
            .and_then(|rest| rest.split(':').next())
            .and_then(|value| value.parse().ok())
            .unwrap_or_else(|| panic!("pas de rh= dans {filter}"))
    }

    /// Pulls a bound out of a gate: `gte(t,0.0333)` or `lt(t,0.0667)`.
    fn bound_of(filter: &str, function: &str) -> Option<f64> {
        filter
            .split(&format!("{function}(t,"))
            .nth(1)
            .and_then(|rest| rest.split(')').next())
            .and_then(|value| value.parse().ok())
    }

    #[test]
    fn an_unanimated_stepped_filter_is_emitted_once_and_ungated() {
        let out = stepped_filters(
            None,
            None,
            10.0,
            0.0,
            30.0,
            "t",
            crate::engine::effects::rgb_split_filter,
        )
        .expect("well under the cap");

        assert_eq!(out, ["rgbashift=rh=10:rv=0:bh=-10:bv=0:edge=smear"]);
        // Nothing to gate: a constant is on for the whole clip, and an `enable`
        // that is always true is a per-frame expression bought for nothing.
        assert!(!out[0].contains("enable"));
    }

    #[test]
    fn a_neutral_stepped_filter_costs_no_pass_at_all() {
        let out = stepped_filters(
            None,
            None,
            0.0,
            0.0,
            30.0,
            "t",
            crate::engine::effects::rgb_split_filter,
        )
        .expect("nothing to cap");
        assert!(out.is_empty());
    }

    /// The shape an impact actually produces: a short ramp, played as a handful
    /// of gated copies that hand over frame by frame.
    #[test]
    fn a_stepped_curve_becomes_gated_copies_that_never_overlap() {
        let points = vec![
            Breakpoint { time: 0.0, value: 12.0 },
            Breakpoint { time: 5.0 / 30.0, value: 0.0 },
        ];
        let out = stepped_filters(
            Some(&points),
            None,
            12.0,
            0.0,
            30.0,
            "t",
            crate::engine::effects::rgb_split_filter,
        )
        .expect("a five-frame ramp is well under the cap");

        assert!(out.len() >= 3, "a ramp is more than one step: {out:?}");

        // The fringe closes over the ramp rather than jumping about.
        let shifts: Vec<i64> = out.iter().map(|filter| shift_of(filter)).collect();
        assert!(
            shifts.windows(2).all(|pair| pair[0] > pair[1]),
            "shifts should fall away: {shifts:?}"
        );

        // The first copy reaches back before the curve, because a value held
        // flat before its first keyframe is what the preview shows too.
        assert!(bound_of(&out[0], "gte").is_none(), "{}", out[0]);

        // Half-open and butted together: every frame is covered by exactly one
        // copy. `between` would put two shifts on each shared frame.
        for pair in out.windows(2) {
            let closes = bound_of(&pair[0], "lt").expect("a run that has a successor closes");
            let opens = bound_of(&pair[1], "gte").expect("a run that has a predecessor opens");
            assert!(
                (closes - opens).abs() < 1e-6,
                "gap or overlap between {} and {}",
                pair[0],
                pair[1]
            );
        }

        // The tail of the ramp is neutral, so it is dropped rather than emitted
        // as a shift of zero.
        let last = out.last().expect("at least one");
        assert!(bound_of(last, "lt").is_some(), "the neutral tail is not emitted: {last}");
    }

    #[test]
    fn a_curve_that_changes_too_often_gives_up_rather_than_flooding_the_graph() {
        // Sixty pixels of travel over four seconds: one distinct rounded shift
        // per pixel, which is more copies than a graph should ever carry.
        let points = vec![
            Breakpoint { time: 0.0, value: 0.0 },
            Breakpoint { time: 4.0, value: 60.0 },
        ];
        assert!(stepped_filters(
            Some(&points),
            None,
            0.0,
            0.0,
            30.0,
            "t",
            crate::engine::effects::rgb_split_filter,
        )
        .is_none());
    }

    /// Both parameters at once, which is the case quantising the *amount*
    /// would have got wrong: the angle alone changes what is emitted.
    #[test]
    fn a_stepped_filter_follows_every_parameter_it_has() {
        let angle = vec![
            Breakpoint { time: 0.0, value: 0.0 },
            Breakpoint { time: 4.0 / 30.0, value: 90.0 },
        ];
        let out = stepped_filters(
            None,
            Some(&angle),
            10.0,
            0.0,
            30.0,
            "t",
            crate::engine::effects::rgb_split_filter,
        )
        .expect("under the cap");

        assert!(out.len() > 1, "a turning split is not one filter: {out:?}");

        // It starts sideways and ends vertical. Stated as which axis leads
        // rather than as exact offsets, because each copy is sampled at the
        // *middle* of the frame it covers — so the first one has already turned
        // a fraction of the way, which is the honest value for that frame.
        let vertical = |filter: &str| -> i64 {
            filter
                .split("rv=")
                .nth(1)
                .and_then(|rest| rest.split(':').next())
                .and_then(|value| value.parse().ok())
                .unwrap_or_else(|| panic!("pas de rv= dans {filter}"))
        };

        let first = out.first().expect("at least one");
        let last = out.last().expect("at least one");
        assert!(shift_of(first) > vertical(first), "should open sideways: {first}");
        assert!(vertical(last) > shift_of(last), "should close vertical: {last}");
    }

    /* -------------------------------------------------------------- *
     * The command line has a ceiling.
     *
     * A rhythmic montage is the first thing this codebase builds that can
     * exceed it. Windows reports the refusal as `os error 206` — "the filename
     * or extension is too long" — which names the wrong thing and sends
     * everyone looking at their paths, so these pin the real cause and the way
     * around it.
     * -------------------------------------------------------------- */

    /// A montage-sized plan: many short shots, each with its own camera curve
    /// and its own gated impact filters. This is what an AMV actually produces.
    fn montage(shots: usize) -> RenderPlan {
        let mut segments = Vec::with_capacity(shots);
        for index in 0..shots {
            let mut shot = segment("video", 0, "C:\\Users\\quelquun\\Videos\\rushes\\scene.mp4");
            let at = index as f64 * 0.3;
            shot.timeline_in = at;
            shot.timeline_out = at + 0.3;
            shot.render_in = at;
            shot.render_out = at + 0.3;

            // The punch: three keys, flattened to breakpoints by the front-end.
            let mut scale = Vec::new();
            for step in 0..24 {
                let progress = step as f64 / 23.0;
                scale.push(Breakpoint {
                    time: progress * 0.3,
                    value: 1.0 + 0.15 * (1.0 - (progress - 0.2).abs()),
                });
            }
            shot.animated.insert("scale".into(), scale);

            // A smear on every cut, and a split on the heavy ones.
            let mut effects = vec![crate::model::Effect {
                id: format!("fx{index}a"),
                kind: "motionblur".into(),
                enabled: true,
                params: HashMap::new(),
            }];
            let mut decay = Vec::new();
            for step in 0..8 {
                decay.push(Breakpoint {
                    time: step as f64 * 0.012,
                    value: 16.0 * (1.0 - step as f64 / 7.0),
                });
            }
            shot.animated.insert(format!("fx:fx{index}a:amount"), decay.clone());

            if index % 4 == 0 {
                effects.push(crate::model::Effect {
                    id: format!("fx{index}b"),
                    kind: "rgbsplit".into(),
                    enabled: true,
                    params: HashMap::new(),
                });
                shot.animated.insert(format!("fx:fx{index}b:amount"), decay);
            }
            shot.effects = effects;
            segments.push(shot);
        }

        let mut out = plan(segments, vec![]);
        out.duration = shots as f64 * 0.3;
        out.frame_count = (out.duration * 30.0) as u64;
        out
    }

    #[test]
    fn a_length_counts_the_program_and_every_argument() {
        let program = Path::new("C:\\ffmpeg.exe");
        let bare = command_length(program, &[]);
        assert_eq!(bare, program.as_os_str().len());
        // Three characters of overhead each: a separator and the quotes Windows
        // adds back when it rebuilds the line.
        assert_eq!(command_length(program, &["ab".to_string()]), bare + 5);
    }

    /// The failure this exists to fix, reproduced.
    #[test]
    fn a_two_hundred_shot_montage_will_not_fit_on_a_command_line() {
        let big = montage(200);
        let built = build_args(&big, &HashMap::new(), Path::new("out.mp4"), &ExportSettings::default())
            .expect("le graphe se construit");

        let length = command_length(Path::new("C:\\ffmpeg.exe"), &built.args);
        assert!(
            length > COMMAND_LIMIT,
            "attendu au-delà de la limite Windows, mesuré {length}"
        );
    }

    #[test]
    fn spilling_the_graph_brings_it_back_under_the_limit() {
        let big = montage(200);
        let mut built =
            build_args(&big, &HashMap::new(), Path::new("out.mp4"), &ExportSettings::default())
                .expect("le graphe se construit");

        let graph = {
            let index = built.args.iter().position(|a| a == "-filter_complex").unwrap();
            built.args[index + 1].clone()
        };

        let file = std::env::temp_dir().join("veglass-graph-test.txt");
        assert!(spill_graph(&mut built.args, &file).expect("écriture du graphe"));

        let length = command_length(Path::new("C:\\ffmpeg.exe"), &built.args);
        assert!(
            length < COMMAND_BUDGET,
            "toujours trop long après déport : {length}"
        );

        // The graph reaches the file byte for byte: ffmpeg reads exactly what
        // it would have been handed inline.
        assert_eq!(std::fs::read_to_string(&file).unwrap(), graph);
        assert!(built.args.iter().any(|a| a == "-/filter_complex"));
        assert!(!built.args.iter().any(|a| a == "-filter_complex"));

        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn an_ordinary_render_is_left_exactly_as_it_was() {
        // One clip: the command line is nowhere near the ceiling, and must keep
        // the inline graph every existing test and install already expects.
        let small = plan(vec![segment("video", 0, "/m/a.mp4")], vec![]);
        let built =
            build_args(&small, &HashMap::new(), Path::new("out.mp4"), &ExportSettings::default())
                .expect("le graphe se construit");

        assert!(command_length(Path::new("/usr/bin/ffmpeg"), &built.args) < COMMAND_BUDGET);
        assert!(built.args.iter().any(|a| a == "-filter_complex"));
    }

    #[test]
    fn a_render_with_no_graph_at_all_spills_nothing() {
        let mut args = vec!["-i".to_string(), "a.wav".to_string()];
        let file = std::env::temp_dir().join("veglass-graph-none.txt");
        assert!(!spill_graph(&mut args, &file).expect("rien à déporter"));
        assert_eq!(args, ["-i", "a.wav"]);
        assert!(!file.exists());
    }

    #[test]
    fn an_animated_gain_is_re_evaluated_every_frame() {
        let mut streams = HashMap::new();
        streams.insert("/m/a.mp4".to_string(), Streams { video: true, audio: true });

        let mut seg = segment("audio", 0, "/m/a.mp4");
        seg.volume = 0.0;
        seg.animated.insert(
            "volume".into(),
            vec![
                Breakpoint { time: 0.0, value: 0.0 },
                Breakpoint { time: 1.0, value: 1.0 },
            ],
        );

        let g = graph(&build_args(&plan(vec![seg], vec![]), &streams, Path::new("o.mp4"), &settings()).unwrap().args);
        assert!(g.contains("volume=volume='min(max(if(lt(t,"));
        assert!(g.contains(":eval=frame"));
        // A curve that starts at silence must not drop the audio branch.
        assert!(g.contains("amix=inputs=1"));
    }

    #[test]
    fn effects_are_spliced_in_before_the_alpha_work() {
        let mut seg = segment("video", 0, "/m/a.mp4");
        seg.filters = vec!["eq=saturation=1.350".into(), "gblur=sigma=3.00".into()];
        seg.opacity = 0.5;

        let built = build_args(&plan(vec![seg], vec![]), &HashMap::new(), Path::new("o.mp4"), &settings()).unwrap();
        let g = graph(&built.args);
        let sat = g.find("eq=saturation=1.350").unwrap();
        let blur = g.find("gblur=sigma=3.00").unwrap();
        let alpha = g.find("colorchannelmixer=aa=0.500").unwrap();
        assert!(sat < blur && blur < alpha);
    }

    #[test]
    fn clip_zoom_is_relative_to_the_layer_size() {
        let mut seg = segment("video", 0, "/m/a.mp4");
        seg.scale = 1.5;
        let built = build_args(&plan(vec![seg], vec![]), &HashMap::new(), Path::new("o.mp4"), &settings()).unwrap();
        assert!(graph(&built.args).contains("scale=iw*1.5000:ih*1.5000"));
    }

    #[test]
    fn a_still_is_looped_rather_than_seeked() {
        let mut seg = segment("video", 0, "/m/logo.png");
        seg.is_still = true;
        seg.conform = false;
        let built = build_args(&plan(vec![seg], vec![]), &HashMap::new(), Path::new("o.mp4"), &settings()).unwrap();

        assert!(built.args.iter().any(|a| a == "-loop"));
        assert!(!built.args.iter().any(|a| a == "-ss"));
        // An overlay keeps its own size: no conforming scale.
        assert!(!graph(&built.args).contains("force_original_aspect_ratio"));
    }

    #[test]
    fn a_transform_becomes_an_overlay_offset_and_a_rotation() {
        let mut seg = segment("video", 0, "/m/a.mp4");
        seg.x = 120.0;
        seg.y = -64.0;
        seg.rotation = 30.0;
        let built = build_args(&plan(vec![seg], vec![]), &HashMap::new(), Path::new("o.mp4"), &settings()).unwrap();
        let g = graph(&built.args);

        assert!(g.contains("overlay=x=(W-w)/2+120:y=(H-h)/2+-64"));
        assert!(g.contains("rotate=a=0.523599:ow=rotw(a):oh=roth(a):c=black@0"));
    }

    fn curve(points: &[(f64, f64)]) -> Vec<Breakpoint> {
        points.iter().map(|(time, value)| Breakpoint { time: *time, value: *value }).collect()
    }

    #[test]
    fn a_ramp_holds_flat_outside_its_own_span() {
        let expr = ramp_expression(&curve(&[(1.0, 10.0), (2.0, 20.0)]), "t").unwrap();
        // Held flat before the first key and after the last; linear between.
        assert_eq!(
            expr,
            "if(lt(t,1.0000),10.0000,if(lt(t,2.0000),(10.0000+(10.0000)*(t-1.0000)/1.000000),20.0000))"
        );
    }

    #[test]
    fn a_single_key_collapses_to_a_constant() {
        assert_eq!(ramp_expression(&curve(&[(0.0, 4.0)]), "t").unwrap(), "4.0000");
        assert!(ramp_expression(&[], "t").is_none());
    }

    #[test]
    fn a_long_curve_is_decimated_rather_than_refused() {
        let dense: Vec<Breakpoint> = (0..500)
            .map(|i| Breakpoint { time: i as f64 * 0.01, value: i as f64 })
            .collect();
        let expr = ramp_expression(&dense, "t").unwrap();
        // The last value must survive the thinning, or the animation would end early.
        assert!(expr.contains("499.0000"));
        assert!(expr.matches("if(").count() <= MAX_BREAKPOINTS + 1);
    }

    #[test]
    fn animated_position_becomes_a_quoted_overlay_expression() {
        let mut seg = segment("video", 0, "/m/a.mp4");
        seg.timeline_in = 2.0;
        seg.render_in = 2.0;
        seg.animated.insert("x".into(), curve(&[(0.0, 0.0), (1.0, 200.0)]));

        let built = build_args(&plan(vec![seg], vec![]), &HashMap::new(), Path::new("o.mp4"), &settings()).unwrap();
        let g = graph(&built.args);

        // Quoted, because the expression is full of commas a filtergraph would
        // otherwise read as filter separators.
        assert!(g.contains("overlay=x='(W-w)/2+(if(lt((t-2.000)"));
        // Position is read on timeline time, offset back to clip-relative.
        assert!(g.contains("(t-2.000)"));
    }

    #[test]
    fn an_animated_scale_reevaluates_every_frame() {
        let mut seg = segment("video", 0, "/m/a.mp4");
        seg.animated.insert("scale".into(), curve(&[(0.0, 1.0), (2.0, 2.0)]));
        let built = build_args(&plan(vec![seg], vec![]), &HashMap::new(), Path::new("o.mp4"), &settings()).unwrap();
        let g = graph(&built.args);

        // Without `eval=frame` the expression would be resolved once and frozen.
        assert!(g.contains("scale=eval=frame:w='2*round(iw*("));
        assert!(g.contains(")/2)'"));
    }

    #[test]
    fn an_animated_rotation_gets_a_box_big_enough_for_every_angle() {
        let mut seg = segment("video", 0, "/m/a.mp4");
        seg.animated.insert("rotation".into(), curve(&[(0.0, 0.0), (1.0, 90.0)]));
        let g = graph(&build_args(&plan(vec![seg], vec![]), &HashMap::new(), Path::new("o.mp4"), &settings()).unwrap().args);

        assert!(g.contains("rotate=a='("));
        // `ow`/`oh` are configured once, so the diagonal is the only safe size.
        assert!(g.contains("ow='sqrt(iw*iw+ih*ih)'"));
    }

    #[test]
    fn an_animated_opacity_falls_back_to_a_per_pixel_pass() {
        let mut seg = segment("video", 0, "/m/a.mp4");
        seg.animated.insert("opacity".into(), curve(&[(0.0, 0.0), (1.0, 1.0)]));
        let g = graph(&build_args(&plan(vec![seg], vec![]), &HashMap::new(), Path::new("o.mp4"), &settings()).unwrap().args);

        assert!(g.contains("geq=r='r(X,Y)'"));
        assert!(g.contains("alpha(X,Y)*min(max("));
        // The constant path must not also fire.
        assert!(!g.contains("colorchannelmixer"));
    }

    #[test]
    fn an_animated_filter_parameter_becomes_an_eq_expression() {
        use crate::model::Effect;
        let mut seg = segment("video", 0, "/m/a.mp4");
        seg.effects = vec![Effect {
            id: "fx1".into(),
            kind: "saturation".into(),
            enabled: true,
            params: HashMap::new(),
        }];
        seg.animated.insert("fx:fx1:amount".into(), curve(&[(0.0, 1.0), (1.0, 2.0)]));

        let g = graph(&build_args(&plan(vec![seg], vec![]), &HashMap::new(), Path::new("o.mp4"), &settings()).unwrap().args);
        assert!(g.contains("eq=saturation='if(lt(t,"));
    }

    #[test]
    fn a_baked_sequence_is_read_as_numbered_frames() {
        let mut seg = segment("video", 0, "/tmp/veglass/cl_1/%06d.png");
        seg.is_still = true;
        seg.is_sequence = true;
        seg.conform = false;
        seg.needs_bake = true;

        let built = build_args(&plan(vec![seg], vec![]), &HashMap::new(), Path::new("o.mp4"), &settings()).unwrap();
        assert!(built.args.iter().any(|a| a == "-start_number"));
        // A sequence is already in step with the timeline; looping one frame
        // would freeze it.
        assert!(!built.args.iter().any(|a| a == "-loop"));
    }

    #[test]
    fn a_baked_text_layer_is_overlaid_untouched() {
        let mut seg = segment("video", 0, "/tmp/veglass/text-1.png");
        seg.is_still = true;
        seg.conform = false;
        seg.needs_bake = true;
        seg.source = "Titre".into();
        let built = build_args(&plan(vec![seg], vec![]), &HashMap::new(), Path::new("o.mp4"), &settings()).unwrap();
        let g = graph(&built.args);

        // The bake already carries the transform and the project resolution.
        assert!(!g.contains("force_original_aspect_ratio"));
        assert!(g.contains("overlay=x=(W-w)/2+0:y=(H-h)/2+0"));
    }
}
