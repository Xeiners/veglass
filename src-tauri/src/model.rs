//! The on-disk project document.
//!
//! These structs mirror `src/types/*.ts` one-for-one. `serde(rename_all =
//! "camelCase")` keeps the JSON identical on both sides, so a file written by
//! the frontend round-trips through Rust untouched.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub name: String,
    /// `video` | `audio` | `image`
    pub kind: String,
    /// Absolute path on disk. `None` for browser-imported blobs, which cannot
    /// be reopened in a later session.
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub added_at: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackCompressor {
    pub enabled: bool,
    /// dBFS.
    pub threshold: f64,
    pub ratio: f64,
    /// dB of make-up gain.
    pub makeup: f64,
}

/// The track's audio bus: settings that apply to the sum of its clips.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackAudio {
    pub volume: f64,
    /// -1 hard left, 0 centre, +1 hard right.
    pub pan: f64,
    /// Hz; 0 disables the filter.
    pub high_pass: f64,
    pub low_pass: f64,
    pub compressor: TrackCompressor,
}

impl Default for TrackAudio {
    fn default() -> Self {
        Self {
            volume: 1.0,
            pan: 0.0,
            high_pass: 0.0,
            low_pass: 0.0,
            compressor: TrackCompressor {
                enabled: false,
                threshold: -18.0,
                ratio: 3.0,
                makeup: 0.0,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    /// `video` | `audio`
    pub kind: String,
    pub name: String,
    pub height: f64,
    pub muted: bool,
    #[serde(default)]
    pub solo: bool,
    pub locked: bool,
    pub hidden: bool,
    #[serde(default)]
    pub audio: Option<TrackAudio>,
}

/// One entry of a clip's filter chain.
///
/// The parameter bag is intentionally untyped: the descriptor registry on the
/// TypeScript side owns the ranges and labels, and the engine only needs to
/// know how to translate each `kind` into ffmpeg. Adding a filter therefore
/// never changes the document format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub id: String,
    /// `brightness` | `contrast` | `saturation` | `blur` | `hue` | `grayscale`
    /// | `invert`
    pub kind: String,
    pub enabled: bool,
    #[serde(default)]
    pub params: HashMap<String, f64>,
}

impl Effect {
    /// Parameter lookup with the caller's fallback — a missing key simply means
    /// "left at its neutral value".
    pub fn param(&self, key: &str, fallback: f64) -> f64 {
        self.params.get(key).copied().unwrap_or(fallback)
    }
}

/// A transition anchored to a cut, or to the open head/tail of a track.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub id: String,
    /// `crossfade` | `dip-black` | `dip-white`
    pub kind: String,
    pub track_id: String,
    /// Outgoing clip; `None` means a fade-in at the head of `to_clip_id`.
    #[serde(default)]
    pub from_clip_id: Option<String>,
    /// Incoming clip; `None` means a fade-out at the tail of `from_clip_id`.
    #[serde(default)]
    pub to_clip_id: Option<String>,
    pub duration: f64,
}

fn default_clip_kind() -> String {
    "media".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    /// `media` | `text` — a text clip owns its content and has no asset.
    #[serde(default = "default_clip_kind")]
    pub kind: String,
    #[serde(default)]
    pub asset_id: Option<String>,
    pub track_id: String,
    pub start: f64,
    pub duration: f64,
    pub offset: f64,
    pub volume: f64,
    pub opacity: f64,
    pub scale: f64,
    /// Offset from the centre of the frame, in project pixels.
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    /// Degrees, clockwise, about the layer centre.
    #[serde(default)]
    pub rotation: f64,
    pub muted: bool,
    #[serde(default)]
    pub label: Option<String>,
    /// Filter chain, applied in order. Absent in schema v1 documents.
    #[serde(default)]
    pub effects: Vec<Effect>,
    /// Opaque to the engine: text is rasterised by the front-end before export,
    /// so Rust only has to carry it back and forth intact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<serde_json::Value>,
    /// Keyframe channels, likewise opaque. The engine never evaluates a bézier:
    /// the front-end samples every curve and hands over flat breakpoints, which
    /// is the only way the export and the preview can agree by construction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animation: Option<serde_json::Value>,
    /// The glass behind a floating layer. Absent on everything that has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backdrop: Option<Backdrop>,
}

/// The soft dark shape a floating layer casts onto its backdrop.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackdropShadow {
    /// Gaussian standard deviation, in project pixels. 0 casts nothing.
    pub blur: f64,
    /// Vertical offset, in project pixels.
    pub y: f64,
    pub color: String,
    pub opacity: f64,
}

/// A blurred, tinted copy of a clip, drawn behind it to fill the frame.
///
/// Unlike `text` and `animation` above, this one is **not** opaque to the
/// engine: there is no way to bake a blurred copy of a moving picture into a
/// PNG, so the encoder has to build the filter chain itself. Every number here
/// is therefore read on this side too — and every one of them is in project
/// pixels, with blurs expressed as standard deviations, which is the contract
/// `src/lib/backdrop.ts` documents and converts for the viewer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backdrop {
    pub blur: f64,
    pub zoom: f64,
    pub tint: String,
    pub tint_opacity: f64,
    /// Corner radius of the floating layer above, in project pixels.
    pub radius: f64,
    pub shadow: BackdropShadow,
}

impl BackdropShadow {
    pub fn casts(&self) -> bool {
        self.opacity > 0.0 && (self.blur > 0.0 || self.y.abs() > 1e-6)
    }
}

/// The hairline drawn over the finished composite.
///
/// A property of the composition rather than of any clip: it spans the whole
/// export, sits over everything including transitions, and there is exactly one
/// of it. Read on this side because the encoder draws it itself — there is
/// nothing to bake when the shape is two rectangles and a clock.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressBar {
    /// Thickness, in project pixels.
    pub height: f64,
    pub color: String,
    pub track_color: String,
    pub track_opacity: f64,
    /// `top` | `bottom`
    pub position: String,
    pub margin: f64,
    pub inset: f64,
    pub opacity: f64,
}

/// The bar's rectangle, in pixels from the top-left of the frame.
///
/// Twin of `progressRect` in `src/types/progress.ts`. The two must agree to the
/// pixel: a few pixels of drift is the difference between a bar on the safe
/// line and a bar under the platform's own interface.
impl ProgressBar {
    pub fn rect(&self, width: u32, height: u32) -> (i64, i64, i64, i64) {
        let frame_w = width as f64;
        let frame_h = height as f64;

        let inset = self.inset.max(0.0).min(frame_w / 2.0 - 1.0);
        let bar = self.height.max(1.0).round();
        let margin = self.margin.max(0.0).min(frame_h - bar);

        let y = if self.position == "top" {
            margin
        } else {
            frame_h - margin - bar
        };

        (
            inset.round() as i64,
            y.round() as i64,
            (frame_w - inset * 2.0).round().max(1.0) as i64,
            bar as i64,
        )
    }

    /// Whether it would put any pixels on screen.
    pub fn draws(&self) -> bool {
        self.height > 0.0 && (self.opacity > 0.0 || self.track_opacity > 0.0)
    }
}

/// `#RRGGBB` as ffmpeg spells a colour.
///
/// A leading `#` starts a comment in a filter script, so it can never reach the
/// graph. Twin of `hexForFfmpeg` in `src/lib/backdrop.ts`.
pub fn ffmpeg_color(hex: &str) -> String {
    let clean: String = hex.trim().trim_start_matches('#').to_string();
    let full = if clean.len() == 3 {
        clean.chars().flat_map(|digit| [digit, digit]).collect()
    } else {
        clean.chars().take(6).collect::<String>()
    };
    let cleaned: String = full.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if cleaned.len() == 6 {
        format!("0x{}", cleaned.to_uppercase())
    } else {
        "0x000000".to_string()
    }
}

/// One point of a sampled animation channel; time is clip-relative seconds.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Breakpoint {
    pub time: f64,
    pub value: f64,
}

/// clip id → channel → sampled curve.
pub type SampledChannels = HashMap<String, HashMap<String, Vec<Breakpoint>>>;

impl Clip {
    pub fn is_text(&self) -> bool {
        self.kind == "text"
    }

    /// Whether the clip's pixels come from the front-end rather than a file.
    ///
    /// Titles, generated backgrounds and banners all arrive as baked PNGs and
    /// all have no `assetId`, so every decision that used to read "is this
    /// text?" — whether to bake it, whether it is a still, where its name comes
    /// from — is really asking this instead.
    ///
    /// **This list is load-bearing.** A kind missing from it has no asset and
    /// no bake, so `plan_render` drops it: the layer appears in the preview and
    /// is silently absent from the exported file. Its twin lives in
    /// `src/types/timeline.ts` as `GENERATED_KINDS`, and the two must agree.
    pub fn is_generated(&self) -> bool {
        matches!(self.kind.as_str(), "text" | "background" | "banner")
    }

    /// What to call a generated layer that carries no label of its own.
    fn generated_noun(&self) -> &'static str {
        match self.kind.as_str() {
            "text" => "Texte",
            "banner" => "Habillage",
            _ => "Fond",
        }
    }

    /// The name a generated layer is reported under, in the render plan.
    pub fn generated_label(&self) -> String {
        self.label
            .clone()
            .unwrap_or_else(|| self.generated_noun().to_string())
    }
}

#[cfg(test)]
mod clip_tests {
    use super::*;

    fn clip(kind: &str, label: Option<&str>) -> Clip {
        let mut value: Clip = serde_json::from_str(
            r#"{"id":"c","kind":"media","assetId":null,"trackId":"t","start":0,
                "duration":1,"offset":0,"volume":1,"opacity":1,"scale":1,
                "x":0,"y":0,"rotation":0,"muted":false,"effects":[]}"#,
        )
        .expect("fixture");
        value.kind = kind.to_string();
        value.label = label.map(str::to_string);
        value
    }

    /// The regression this list exists to prevent: a banner that renders in the
    /// preview and is missing from the exported file.
    #[test]
    fn every_front_end_drawn_kind_is_generated() {
        for kind in ["text", "background", "banner"] {
            assert!(clip(kind, None).is_generated(), "{kind} must be baked");
        }
    }

    #[test]
    fn media_is_not_generated() {
        assert!(!clip("media", None).is_generated());
    }

    #[test]
    fn a_generated_layer_is_named_for_what_it_is() {
        assert_eq!(clip("text", None).generated_label(), "Texte");
        assert_eq!(clip("banner", None).generated_label(), "Habillage");
        assert_eq!(clip("background", None).generated_label(), "Fond");
    }

    #[test]
    fn its_own_label_always_wins() {
        assert_eq!(clip("banner", Some("Chapitre 2")).generated_label(), "Chapitre 2");
    }
}

impl Clip {
    pub fn end(&self) -> f64 {
        self.start + self.duration
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: f64,
    pub updated_at: f64,
    pub settings: ProjectSettings,
    #[serde(default)]
    pub assets: Vec<Asset>,
    #[serde(default)]
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub clips: Vec<Clip>,
    /// Absent in schema v1 documents.
    #[serde(default)]
    pub transitions: Vec<Transition>,
    /// The hairline over the whole composition. Absent before schema 11.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<ProgressBar>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tutorial_context: Option<String>,
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
}

fn default_schema_version() -> u32 {
    1
}

#[cfg(test)]
mod tutorial_context_tests {
    use super::Project;

    #[test]
    fn context_round_trips_without_becoming_required_on_old_projects() {
        let old = serde_json::json!({ "id": "test", "name": "test", "createdAt": 0,
            "updatedAt": 0, "settings": { "width": 1920, "height": 1080, "fps": 30 } });
        let mut project: Project = serde_json::from_value(old).unwrap();
        assert!(project.tutorial_context.is_none());
        assert!(serde_json::to_value(&project).unwrap().get("tutorialContext").is_none());
        project.tutorial_context = Some("Logiciel de caisse, vouvoyer, ne pas répéter l’introduction.".into());
        let saved = serde_json::to_value(&project).unwrap();
        assert_eq!(saved["tutorialContext"], project.tutorial_context.clone().unwrap());
        let loaded: Project = serde_json::from_value(saved).unwrap();
        assert_eq!(loaded.tutorial_context, project.tutorial_context);
    }
}

impl Project {
    /// Content length: the furthest clip end on any track.
    pub fn duration(&self) -> f64 {
        self.clips.iter().fold(0.0_f64, |max, clip| max.max(clip.end()))
    }
}

/// Row shape for the home dashboard listing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub created_at: f64,
    pub updated_at: f64,
    pub settings: ProjectSettings,
    pub clip_count: usize,
    pub asset_count: usize,
    pub duration: f64,
}

impl From<&Project> for ProjectSummary {
    fn from(project: &Project) -> Self {
        Self {
            id: project.id.clone(),
            name: project.name.clone(),
            created_at: project.created_at,
            updated_at: project.updated_at,
            settings: project.settings.clone(),
            clip_count: project.clips.len(),
            asset_count: project.assets.len(),
            duration: project.duration(),
        }
    }
}
