//! Media engine.
//!
//! Everything below the render plan — decoding, compositing, encoding — plugs in
//! behind the [`Encoder`] trait. Keeping the trait here means an ffmpeg-backed
//! Rust implementation and an out-of-process Python worker are interchangeable
//! from the command layer's point of view.
//!
//! The two mappings the editor depends on today live in [`effects`] (filter
//! stack → filtergraph) and [`render`] (timeline → ordered segments and
//! transition schedule). Both are pure functions: the encoder consumes their
//! output and never reads the document itself.

pub mod effects;
pub mod ffmpeg;
pub mod install;
pub mod render;

use std::path::Path;

pub use effects::{describe, effect_filters, EffectChain};
pub use ffmpeg::{status as encoder_status, EncoderStatus, ExportControl, ExportSettings, FfmpegEncoder};
pub use install::{InstallProgress, INSTALL_PROGRESS};
pub use render::{build, RenderPlan, RenderSegment, TransitionPlan};

/// Progress report emitted while a job runs.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeProgress {
    pub frame: u64,
    pub total_frames: u64,
    pub stage: String,
    /// ffmpeg's own throughput, in times real-time. Feeds the ETA.
    pub speed: f64,
}

/// Contract for a concrete encoding backend.
///
/// [`FfmpegEncoder`] drives an ffmpeg binary; an in-process libav build or an
/// out-of-process Python worker would implement the same three methods, and the
/// command layer would not know the difference.
pub trait Encoder {
    /// Human-readable backend name, surfaced in the export dialog.
    fn name(&self) -> &'static str;

    /// Render `plan` to `output`, reporting progress through `on_progress`.
    fn encode(
        &self,
        plan: &RenderPlan,
        output: &Path,
        on_progress: &mut dyn FnMut(EncodeProgress),
    ) -> Result<(), String>;
}
