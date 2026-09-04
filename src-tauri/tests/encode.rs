//! The graph, handed to a real ffmpeg.
//!
//! Every other test in this crate asserts on strings, which is how a filtergraph
//! that reads perfectly well and that ffmpeg refuses outright — `[0:v],fps=30`,
//! a comma the parser reads as a filter with no name — got all the way to a
//! user pressing "Rendre la vidéo". Only ffmpeg can settle whether a graph is
//! valid, so here it does.
//!
//! Skipped, loudly, when no encoder is installed: a machine without ffmpeg
//! should not fail the suite, but neither should it quietly claim to have
//! tested an encode it never ran.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use veglass_lib::engine::ffmpeg::{build_args, locate_binary, ExportSettings, Streams};
use veglass_lib::engine::install::remember_install_dir;
use veglass_lib::engine::render::{RenderPlan, RenderSegment, TrackBus, TransitionPlan};
use veglass_lib::model::{Breakpoint, Effect};

/// Finds the encoder the way the app would, plus the copy the app installed.
///
/// `locate_binary` reads the install directory out of a `OnceLock` that only
/// Tauri's startup fills, so a bare test run would find nothing and skip — which
/// is how a test that verifies encoding ends up verifying nothing at all. Here
/// the same directory is registered by hand first.
fn encoder() -> Option<PathBuf> {
    if let Some(found) = locate_binary("ffmpeg") {
        return Some(found);
    }
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join("Library/Application Support"))
    } else {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))
    }?;
    remember_install_dir(base.join("app.veglass.editor").join("bin"));
    locate_binary("ffmpeg")
}

/// Short clips: this test is about the graph, not about throughput.
const SECONDS: f64 = 1.0;

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join("veglass-encode-test");
    std::fs::create_dir_all(&dir).expect("dossier de travail");
    dir
}

/// Synthesises an input with ffmpeg's own generators, so the test carries no
/// media of its own.
fn make_source(ffmpeg: &Path, name: &str, spec: &[&str]) -> String {
    let target = scratch().join(name);
    let mut args: Vec<String> = vec!["-y".into(), "-hide_banner".into(), "-loglevel".into(), "error".into()];
    args.extend(spec.iter().map(|value| value.to_string()));
    args.push(target.to_string_lossy().to_string());

    let status = Command::new(ffmpeg).args(&args).status().expect("ffmpeg lancé");
    assert!(status.success(), "génération de {name} échouée");
    target.to_string_lossy().to_string()
}

fn segment(kind: &str, layer: usize, path: &str, track_id: &str) -> RenderSegment {
    RenderSegment {
        track_name: "V1".into(),
        kind: kind.into(),
        layer,
        source: path.rsplit(['/', '\\']).next().unwrap_or(path).into(),
        source_path: Some(path.into()),
        timeline_in: 0.0,
        timeline_out: SECONDS,
        source_in: 0.0,
        track_id: track_id.into(),
        render_in: 0.0,
        render_out: SECONDS,
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
        role: "clip".to_string(),
        backdrop: None,
    }
}

fn bus(id: &str, kind: &str) -> TrackBus {
    TrackBus {
        id: id.into(),
        name: id.into(),
        kind: kind.into(),
        muted: false,
        volume: 1.0,
        pan: 0.0,
        high_pass: 0.0,
        low_pass: 0.0,
        compressor: None,
    }
}

fn ramp(channel: &str, from: f64, to: f64) -> (String, Vec<Breakpoint>) {
    (
        channel.to_string(),
        vec![
            Breakpoint { time: 0.0, value: from },
            Breakpoint { time: SECONDS, value: to },
        ],
    )
}

fn effect(kind: &str, key: &str, value: f64) -> Effect {
    let mut params = HashMap::new();
    params.insert(key.to_string(), value);
    Effect { id: format!("fx-{kind}"), kind: kind.into(), enabled: true, params }
}

fn plan(segments: Vec<RenderSegment>, tracks: Vec<TrackBus>) -> RenderPlan {
    RenderPlan {
        project_name: "encode-test".into(),
        width: 320,
        height: 240,
        fps: 30.0,
        duration: SECONDS,
        frame_count: 30,
        segments,
        tracks,
        transitions: vec![],
        warnings: vec![],
        progress: None,
        engine: "rust".into(),
    }
}

/// Reads a produced file's real duration back, in seconds.
///
/// Exit code zero is a weak claim: a graph can be accepted, run, and still emit
/// a fraction of the timeline — a `-t` on the wrong input, a source that ends
/// early, an overlay that drops the frames after it. The only answer that
/// settles it is the one measured off the finished file.
fn measured_duration(output: &Path) -> f64 {
    let Some(ffprobe) = locate_binary("ffprobe") else {
        return f64::NAN;
    };
    let result = Command::new(ffprobe)
        .args([
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(output)
        .output()
        .expect("ffprobe lancé");
    String::from_utf8_lossy(&result.stdout).trim().parse().unwrap_or(f64::NAN)
}

/// Builds the command the app would run, runs it, and returns ffmpeg's own words.
fn encode(ffmpeg: &Path, plan: &RenderPlan, streams: &HashMap<String, Streams>, name: &str) {
    let output = scratch().join(name);
    let _ = std::fs::remove_file(&output);

    let built = build_args(plan, streams, &output, &ExportSettings::default())
        .expect("arguments construits");

    let result = Command::new(ffmpeg)
        .args(&built.args)
        .output()
        .expect("ffmpeg lancé");

    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(
        result.status.success(),
        "ffmpeg a refusé le graphe pour {name}.\n\
         --- graphe ---\n{}\n--- ffmpeg ---\n{}",
        built
            .args
            .iter()
            .position(|a| a == "-filter_complex")
            .and_then(|i| built.args.get(i + 1))
            .cloned()
            .unwrap_or_default(),
        stderr.trim(),
    );

    let written = std::fs::metadata(&output).map(|meta| meta.len()).unwrap_or(0);
    assert!(written > 0, "{name} : fichier vide malgré un code de sortie nul");

    let measured = measured_duration(&output);
    if measured.is_finite() {
        // One frame of slack: container timestamps do not land on the exact
        // millisecond, and that is not what this is looking for.
        let slack = 1.0 / plan.fps + 0.05;
        assert!(
            (measured - plan.duration).abs() <= slack,
            "{name} : durée {measured:.3}s pour {:.3}s attendues",
            plan.duration,
        );
    }
}

#[test]
fn the_generated_graph_is_one_ffmpeg_accepts() {
    let Some(ffmpeg) = encoder() else {
        eprintln!("ffmpeg absent — test d'encodage ignoré (aucun encodage n'a été vérifié)");
        return;
    };
    eprintln!("encodage réel avec {}", ffmpeg.display());

    let video = make_source(
        &ffmpeg,
        "source-a.mp4",
        &["-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=1", "-pix_fmt", "yuv420p"],
    );
    let other = make_source(
        &ffmpeg,
        "source-b.mp4",
        &["-f", "lavfi", "-i", "smptebars=size=320x240:rate=30:duration=1", "-pix_fmt", "yuv420p"],
    );
    let sound = make_source(
        &ffmpeg,
        "source.m4a",
        &["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac"],
    );

    let mut streams = HashMap::new();
    streams.insert(video.clone(), Streams { video: true, audio: false });
    streams.insert(other.clone(), Streams { video: true, audio: false });
    streams.insert(sound.clone(), Streams { video: false, audio: true });

    // One clip: the simplest graph there is, and the one that was broken.
    encode(
        &ffmpeg,
        &plan(
            vec![segment("video", 0, &video, "tr1")],
            vec![bus("tr1", "video")],
        ),
        &streams,
        "single.mp4",
    );

    // Two layers: an overlay composited over the one beneath it.
    encode(
        &ffmpeg,
        &plan(
            vec![
                segment("video", 1, &video, "tr1"),
                segment("video", 0, &other, "tr1"),
            ],
            vec![bus("tr1", "video")],
        ),
        &streams,
        "layered.mp4",
    );

    // Sound alongside picture: the audio bus graph, amix and all.
    encode(
        &ffmpeg,
        &plan(
            vec![
                segment("video", 0, &video, "tr1"),
                segment("audio", 0, &sound, "tr2"),
            ],
            vec![bus("tr1", "video"), bus("tr2", "audio")],
        ),
        &streams,
        "with-audio.mp4",
    );

    // Animated channels, one at a time: each one takes a different route
    // through the graph — `geq` for alpha, `rotate`, `scale=eval=frame` — and a
    // wrong clock in any of them is rejected the same unhelpful way.
    for (channel, from, to) in [
        ("opacity", 0.0, 1.0),
        ("rotation", 0.0, 45.0),
        ("scale", 1.0, 1.4),
        ("x", -40.0, 40.0),
        ("y", 0.0, 25.0),
    ] {
        let mut animated = segment("video", 0, &video, "tr1");
        let (name, points) = ramp(channel, from, to);
        animated.animated.insert(name, points);
        encode(
            &ffmpeg,
            &plan(vec![animated], vec![bus("tr1", "video")]),
            &streams,
            &format!("animated-{channel}.mp4"),
        );
    }

    // Every effect the inspector can apply, stacked in one pass.
    let mut filtered = segment("video", 0, &video, "tr1");
    filtered.effects = vec![
        effect("brightness", "amount", 0.12),
        effect("contrast", "amount", 1.3),
        effect("saturation", "amount", 0.7),
        effect("blur", "radius", 4.0),
        effect("hue", "angle", 40.0),
    ];
    filtered.filters = veglass_lib::engine::effect_filters(&filtered.effects);
    encode(
        &ffmpeg,
        &plan(vec![filtered], vec![bus("tr1", "video")]),
        &streams,
        "effects.mp4",
    );

    // An animated effect parameter, which swaps the constant for an expression.
    let mut animated_effect = segment("video", 0, &video, "tr1");
    animated_effect.effects = vec![effect("brightness", "amount", 0.0)];
    let (name, points) = ramp("effect:brightness:amount", -0.3, 0.3);
    animated_effect.animated.insert(name, points);
    encode(
        &ffmpeg,
        &plan(vec![animated_effect], vec![bus("tr1", "video")]),
        &streams,
        "animated-effect.mp4",
    );

    // A cross-dissolve: two clips overlapping, each carrying an alpha ramp.
    let mut outgoing = segment("video", 0, &video, "tr1");
    outgoing.timeline_out = SECONDS;
    outgoing.render_out = SECONDS;
    outgoing.fade_out_start = SECONDS * 0.6;
    outgoing.fade_out = SECONDS * 0.4;

    let mut incoming = segment("video", 0, &other, "tr1");
    incoming.timeline_in = SECONDS * 0.6;
    incoming.render_in = SECONDS * 0.6;
    incoming.timeline_out = SECONDS * 1.6;
    incoming.render_out = SECONDS * 1.6;
    incoming.fade_in_start = 0.0;
    incoming.fade_in = SECONDS * 0.4;

    let mut dissolve = plan(vec![outgoing, incoming], vec![bus("tr1", "video")]);
    dissolve.duration = SECONDS * 1.6;
    dissolve.frame_count = 48;
    dissolve.transitions = vec![TransitionPlan {
        kind: "crossfade".into(),
        track_name: "V1".into(),
        start: SECONDS * 0.6,
        end: SECONDS,
        duration: SECONDS * 0.4,
        from_source: Some(video.clone()),
        to_source: Some(other.clone()),
        ffmpeg: String::new(),
    }];
    encode(&ffmpeg, &dissolve, &streams, "dissolve.mp4");

    let _ = std::fs::remove_dir_all(scratch());
}
