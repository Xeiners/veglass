//! IPC surface of the AI suite.
//!
//! Every one of these is `async` and defers to the blocking pool, because all
//! of them either wait on the network or drive an ffmpeg child process — doing
//! either on the main thread would freeze the editor mid-request, which is the
//! one thing the brief rules out.

use serde_json::Value;
use tauri::AppHandle;

use crate::ai::audio::{AudioExcerpt, Envelope};
use crate::ai::eleven::{Preview, SpeechOutcome, SpeechRequest, VoiceInfo};
use crate::ai::error::{AiError, Result};
use crate::ai::frame::Poster;
use crate::ai::gemini::{GenerateOutcome, ModelInfo};
use crate::ai::secrets::KeyStatus;
use crate::ai::{audio, eleven, frame, gemini, secrets};

/// Wraps a blocking job so a panicking or cancelled task reads as an error
/// rather than a silent hang in the UI.
async fn offload<T, F>(job: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|error| AiError::io(format!("tâche interrompue : {error}")))?
}

/* ---------------- Key ---------------- */

/// Whether a key is stored, and where — never the key itself.
#[tauri::command]
pub fn ai_key_status(app: AppHandle) -> KeyStatus {
    secrets::status(&app, secrets::GEMINI)
}

/// Saves a key after checking it against the live service.
///
/// Verifying before storing is what makes the settings panel trustworthy: a
/// typo is caught while the field is still on screen, rather than surfacing as
/// a cryptic failure the first time someone asks for subtitles. Listing models
/// costs no tokens, so the check is free.
#[tauri::command]
pub async fn ai_set_key(app: AppHandle, key: String) -> Result<KeyStatus> {
    offload(move || {
        let trimmed = key.trim().to_string();
        gemini::list_models(&app, Some(&trimmed))?;
        secrets::store(&app, secrets::GEMINI, &trimmed)
    })
    .await
}

/// Saves a key *without* contacting Google — for an offline machine, or a key
/// restricted in a way that forbids listing models.
#[tauri::command]
pub fn ai_set_key_unchecked(app: AppHandle, key: String) -> Result<KeyStatus> {
    secrets::store(&app, secrets::GEMINI, key.trim())
}

#[tauri::command]
pub fn ai_clear_key(app: AppHandle) -> KeyStatus {
    secrets::clear(&app, secrets::GEMINI)
}

/// Models the stored key may actually call. Also serves as a connection test.
#[tauri::command]
pub async fn ai_list_models(app: AppHandle) -> Result<Vec<ModelInfo>> {
    offload(move || gemini::list_models(&app, None)).await
}

/* ---------------- Generation ---------------- */

/// One `generateContent` round trip.
///
/// `body` is the request as the front-end composed it — contents, system
/// instruction, generation config, response schema. It is forwarded untouched,
/// so a new prompting technique never needs a Rust change.
///
/// `timeoutSecs` is how long the caller is willing to wait for one attempt;
/// a chat turn and an hour of transcribed audio need very different numbers.
#[tauri::command]
pub async fn ai_generate(
    app: AppHandle,
    model: String,
    body: Value,
    timeout_secs: Option<u64>,
) -> Result<GenerateOutcome> {
    offload(move || gemini::generate(&app, &model, body, timeout_secs)).await
}

/* ---------------- Audio ---------------- */

/// A compressed mono excerpt of a media file, ready for an `inlineData` part.
#[tauri::command]
pub async fn ai_audio_excerpt(path: String, start: f64, duration: f64) -> Result<AudioExcerpt> {
    offload(move || audio::excerpt(&path, start, duration)).await
}

/// A single frame, for previewing a cut before it exists on the timeline.
#[tauri::command]
pub async fn ai_poster(path: String, at: f64, width: u32) -> Result<Poster> {
    offload(move || frame::poster(&path, at, width)).await
}

/// The loudness curve silence detection reads.
#[tauri::command]
pub async fn ai_audio_envelope(
    path: String,
    start: f64,
    duration: f64,
    buckets_per_second: f64,
) -> Result<Envelope> {
    offload(move || audio::envelope(&path, start, duration, buckets_per_second)).await
}

/* ---------------- Voice ---------------- */

/// Whether an ElevenLabs key is stored, and where — never the key itself.
#[tauri::command]
pub fn voice_key_status(app: AppHandle) -> KeyStatus {
    secrets::status(&app, secrets::ELEVENLABS)
}

/// Saves the speech key after checking it against the live service.
///
/// Listing voices costs no characters, so the check is free — and it is the
/// same bargain `ai_set_key` strikes with Google: catch the typo while the
/// field is still on screen, not on the first sentence of a tutorial.
#[tauri::command]
pub async fn voice_set_key(app: AppHandle, key: String) -> Result<KeyStatus> {
    offload(move || {
        let trimmed = key.trim().to_string();
        eleven::voices(&app, Some(&trimmed))?;
        secrets::store(&app, secrets::ELEVENLABS, &trimmed)
    })
    .await
}

/// Saves it without contacting ElevenLabs — for an offline machine.
#[tauri::command]
pub fn voice_set_key_unchecked(app: AppHandle, key: String) -> Result<KeyStatus> {
    secrets::store(&app, secrets::ELEVENLABS, key.trim())
}

#[tauri::command]
pub fn voice_clear_key(app: AppHandle) -> KeyStatus {
    secrets::clear(&app, secrets::ELEVENLABS)
}

/// The voices this account can use. Also serves as a connection test.
#[tauri::command]
pub async fn voice_list(app: AppHandle) -> Result<Vec<VoiceInfo>> {
    offload(move || eleven::voices(&app, None)).await
}

/// Speaks one passage and writes it to disk, ready to be imported as an asset.
#[tauri::command]
pub async fn voice_speak(app: AppHandle, request: SpeechRequest) -> Result<SpeechOutcome> {
    offload(move || eleven::speak(&app, request)).await
}

/// The same, kept in memory — the settings panel's audition button.
#[tauri::command]
pub async fn voice_preview(app: AppHandle, request: SpeechRequest) -> Result<Preview> {
    offload(move || eleven::preview(&app, request)).await
}

/// Deletes a generated take.
///
/// Called when a run is abandoned: a wizard that was cancelled halfway has
/// already paid for and written several files that nothing will ever reference,
/// and leaving them behind turns the voice-over directory into a landfill.
#[tauri::command]
pub async fn voice_discard(app: AppHandle, keys: Vec<String>) -> Result<()> {
    offload(move || {
        for key in &keys {
            // One unremovable file must not strand the rest of the sweep.
            let _ = eleven::discard(&app, key);
        }
        Ok(())
    })
    .await
}
