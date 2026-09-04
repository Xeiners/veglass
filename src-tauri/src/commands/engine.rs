use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::engine::{
    self, EffectChain, Encoder, EncoderStatus, ExportControl, ExportSettings, FfmpegEncoder,
    RenderPlan,
};
use crate::model::{Effect, Project};

/// Event name the export dialog listens on.
pub const EXPORT_PROGRESS: &str = "veglass://export-progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub frame: u64,
    pub total_frames: u64,
    pub stage: String,
    /// 0 → 1, pre-computed so the UI never divides by zero.
    pub ratio: f64,
    /// ffmpeg's throughput in times real-time; the UI turns it into an ETA.
    pub speed: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub output: String,
    /// Size of the finished file. The dialog feeds it back to the estimator,
    /// which is how a prediction becomes a measurement over time.
    pub bytes: u64,
    pub duration: f64,
    pub frame_count: u64,
    pub segments: usize,
    pub transitions: usize,
    pub warnings: Vec<String>,
}

/// Flattens the timeline — clips, filter chains and transitions — into the
/// ordered plan an encoder consumes.
#[tauri::command]
pub fn process_timeline_segments(project: Project) -> RenderPlan {
    // Preview of the plan: nothing has been rasterised yet, so text and vector
    // layers report `needsBake` and carry no source path.
    engine::build(&project, &HashMap::new(), &HashMap::new())
}

/// Translates a single clip's filter stack into its ffmpeg fragments.
///
/// The inspector calls this on every parameter change so the chain shown to the
/// user is the one the engine would actually run, not a UI approximation.
#[tauri::command]
pub fn describe_effect_chain(effects: Vec<Effect>) -> EffectChain {
    engine::describe(&effects)
}

/// Whether an encoder is available, and which one.
#[tauri::command]
pub fn encoder_status() -> EncoderStatus {
    engine::encoder_status()
}

/// Adopts an ffmpeg the user already has, instead of downloading one.
///
/// Every network failure this application can hit has the same answer of last
/// resort: the user finds a build themselves. This makes that a supported
/// path rather than an undocumented folder trick.
#[tauri::command]
pub async fn adopt_ffmpeg(path: String) -> Result<EncoderStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        engine::install::adopt(std::path::Path::new(&path))
            .map(|()| engine::encoder_status())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "tâche interrompue".to_string())?
}

/// Fetches a static ffmpeg build into the app's own directory.
///
/// Downloading is long and blocking, so it runs on the blocking pool while
/// progress is pushed to the window; the awaited result is the new status.
#[tauri::command]
pub async fn install_ffmpeg(app: AppHandle) -> Result<EncoderStatus, String> {
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || engine::install::run(&handle, cancel))
        .await
        .map_err(|error| format!("installation interrompue : {error}"))?
        .map_err(|error| error.to_string())
}

/// Renders the project to `output`.
///
/// Encoding is long and blocking, so it runs on the blocking pool while
/// progress is pushed to the window as events; the awaited result is only the
/// final outcome.
#[tauri::command]
/// `baked` maps a clip id to the PNG the front-end rasterised for it — text
/// layers and SVG, which ffmpeg cannot draw itself.
pub async fn export_render(
    app: AppHandle,
    project: Project,
    output: String,
    baked: HashMap<String, String>,
    channels: crate::model::SampledChannels,
    settings: ExportSettings,
) -> Result<ExportReport, String> {
    let control = app.state::<Arc<ExportControl>>().inner().clone();

    let handle = tauri::async_runtime::spawn_blocking(move || {
        let encoder = FfmpegEncoder::discover(settings, control).ok_or_else(|| {
            "ffmpeg est introuvable. Installez-le, ou placez le binaire à côté de Veglass."
                .to_string()
        })?;

        let plan = engine::build(&project, &baked, &channels);
        let destination = PathBuf::from(&output);

        let mut emit = |progress: crate::engine::EncodeProgress| {
            let ratio = if progress.total_frames == 0 {
                0.0
            } else {
                (progress.frame as f64 / progress.total_frames as f64).clamp(0.0, 1.0)
            };
            // A dropped event only costs a progress tick, never the render.
            let _ = app.emit(
                EXPORT_PROGRESS,
                ExportProgress {
                    frame: progress.frame,
                    total_frames: progress.total_frames,
                    stage: progress.stage,
                    ratio,
                    speed: progress.speed,
                },
            );
        };

        encoder.encode(&plan, &destination, &mut emit)?;

        let bytes = std::fs::metadata(&output).map(|meta| meta.len()).unwrap_or(0);

        Ok::<ExportReport, String>(ExportReport {
            output,
            bytes,
            duration: plan.duration,
            frame_count: plan.frame_count,
            segments: plan.segments.len(),
            transitions: plan.transitions.len(),
            warnings: plan.warnings,
        })
    });

    handle
        .await
        .map_err(|error| format!("La tâche de rendu s'est interrompue : {error}"))?
}

/// Stops a running render and removes the half-written file.
#[tauri::command]
pub fn cancel_export(app: AppHandle) -> bool {
    app.state::<Arc<ExportControl>>().cancel()
}
