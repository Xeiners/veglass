//! Errors the AI suite can produce, in the shape the front-end can act on.
//!
//! Every other command in this app rejects with a plain string, which is all a
//! toast needs. The AI suite needs more: an invalid key must open the settings
//! panel, a quota error must not be retried, and a transport blip *must* be.
//! So this error crosses the bridge as an **object** — Tauri serialises any
//! `Serialize` error type — and the TypeScript side switches on `kind` rather
//! than pattern-matching French prose.

use serde::Serialize;

/// What went wrong, in the terms the UI reacts to.
///
/// The string values are the contract with `src/lib/ai/client.ts`; keep them in
/// step with the `AiErrorKind` union there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiErrorKind {
    /// No key has been stored yet.
    MissingKey,
    /// The key was rejected — wrong, revoked, or not enabled for this API.
    InvalidKey,
    /// Free-tier or project quota exhausted.
    Quota,
    /// Too many requests in the moment; worth retrying.
    RateLimit,
    /// DNS, TLS, timeout — the request never reached Google.
    Network,
    /// Google answered, but with a 5xx.
    Server,
    /// The model refused, or the answer was cut by a safety filter.
    Blocked,
    /// A well-formed HTTP answer that is not the shape we asked for.
    Format,
    /// The request itself was malformed (4xx that is none of the above).
    Request,
    /// ffmpeg is missing, or failed on this file.
    Ffmpeg,
    /// Disk, keychain, or process plumbing.
    Io,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiError {
    pub kind: AiErrorKind,
    /// Ready to show: written for the person using the editor, not for a log.
    pub message: String,
    /// HTTP status, when the failure came from one.
    pub status: Option<u16>,
    /// Whether calling again, unchanged, could plausibly succeed.
    pub retryable: bool,
}

impl AiError {
    pub fn new(kind: AiErrorKind, message: impl Into<String>) -> Self {
        let retryable = matches!(
            kind,
            AiErrorKind::RateLimit | AiErrorKind::Network | AiErrorKind::Server
        );
        Self { kind, message: message.into(), status: None, retryable }
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    pub fn missing_key() -> Self {
        Self::new(
            AiErrorKind::MissingKey,
            "Aucune clé API Gemini enregistrée. Ouvrez les réglages pour en saisir une.",
        )
    }

    /// The speech service has its own key, and its own empty state.
    ///
    /// Separate from [`Self::missing_key`] because the two send someone to
    /// different halves of the settings panel: a montage can be planned with no
    /// ElevenLabs key at all, and telling that user to enter a Gemini one would
    /// be advice for a problem they do not have.
    pub fn missing_voice_key() -> Self {
        Self::new(
            AiErrorKind::MissingKey,
            "Aucune clé API ElevenLabs enregistrée. Ouvrez les réglages, onglet Voix, pour en saisir une.",
        )
    }

    pub fn ffmpeg(message: impl Into<String>) -> Self {
        Self::new(AiErrorKind::Ffmpeg, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(AiErrorKind::Io, message)
    }
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AiError {}

impl From<std::io::Error> for AiError {
    fn from(error: std::io::Error) -> Self {
        Self::io(format!("accès disque : {error}"))
    }
}

pub type Result<T> = std::result::Result<T, AiError>;
