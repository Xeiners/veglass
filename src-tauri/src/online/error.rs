//! Errors the online-media module produces.
//!
//! Same reasoning as `ai::error`: a plain string is enough for a toast, but not
//! enough for the interface to *act*. A missing binary must offer to install
//! one, a cancelled download must not look like a failure, and a video that is
//! private or geo-blocked deserves saying so rather than "échec". So this
//! crosses the bridge as an object and the front-end switches on `kind`.

use serde::Serialize;

/// Keep these strings in step with `OnlineErrorKind` in `src/types/online.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OnlineErrorKind {
    /// yt-dlp is not installed. The panel offers to fetch it.
    MissingBinary,
    /// The platform has no build we are willing to fetch automatically.
    Unsupported,
    /// DNS, TLS, timeout — the request never got out.
    Network,
    /// The address is not something yt-dlp can read.
    InvalidUrl,
    /// Private, removed, age-gated, region-locked — the video exists but is shut.
    Unavailable,
    /// yt-dlp ran and failed for a reason we did not classify.
    Tool,
    /// The tool answered, but not in the shape we asked for.
    Format,
    /// Disk, permissions, process plumbing.
    Io,
    /// Stopped on purpose.
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineError {
    pub kind: OnlineErrorKind,
    /// Written for the person editing, not for a log.
    pub message: String,
    /// Whether trying again, unchanged, could plausibly work.
    pub retryable: bool,
}

impl OnlineError {
    pub fn new(kind: OnlineErrorKind, message: impl Into<String>) -> Self {
        let retryable = matches!(kind, OnlineErrorKind::Network | OnlineErrorKind::Tool);
        Self { kind, message: message.into(), retryable }
    }

    pub fn missing_binary() -> Self {
        Self::new(
            OnlineErrorKind::MissingBinary,
            "yt-dlp n'est pas installé. Veglass peut le télécharger pour vous.",
        )
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(OnlineErrorKind::Io, message)
    }

    pub fn cancelled() -> Self {
        Self::new(OnlineErrorKind::Cancelled, "Téléchargement annulé.")
    }

    /// Reads yt-dlp's own complaint and gives it a kind.
    ///
    /// The tool is verbose and consistent: the phrases below are the ones it
    /// actually prints, and each maps to something the user can do — wait, fix
    /// the address, or accept that this particular video is closed.
    pub fn from_tool(stderr: &str) -> Self {
        let text = stderr.to_lowercase();

        // YouTube phrases the same refusal several ways, and the word order
        // differs between them — "video unavailable" and "this video is not
        // available" are the same event and only one of them used to match.
        let unavailable = [
            "private video",
            "video unavailable",
            "is not available",
            "isn't available",
            "no longer available",
            "sign in to confirm your age",
            "this video is available to this channel's members",
            "requested format is not available",
            "has been removed",
            "not available in your country",
            "blocked it in your country",
            "members-only",
        ];
        if unavailable.iter().any(|needle| text.contains(needle)) {
            return Self::new(
                OnlineErrorKind::Unavailable,
                format!("Cette vidéo n'est pas accessible : {}", last_line(stderr)),
            );
        }

        // Python's own words for a path the filesystem refused: a forbidden
        // character, or a name longer than the platform allows. Raw, it reads
        // as a defect in Veglass; named, it is something a shorter title fixes.
        if text.contains("errno 22")
            || text.contains("invalid argument")
            || text.contains("filename too long")
            || text.contains("errno 36")
        {
            return Self::new(
                OnlineErrorKind::Io,
                "Le nom de fichier a été refusé par le système : titre trop long, ou caractère \
                 interdit. Réessayez — Veglass raccourcit et assainit désormais le nom.",
            );
        }

        if text.contains("unsupported url") || text.contains("is not a valid url") {
            return Self::new(
                OnlineErrorKind::InvalidUrl,
                "Adresse non reconnue. Collez un lien de vidéo, ou tapez des mots-clés.",
            );
        }

        let network = [
            "unable to download",
            "connection reset",
            "timed out",
            "temporary failure in name resolution",
            "getaddrinfo",
            "network is unreachable",
        ];
        if network.iter().any(|needle| text.contains(needle)) {
            return Self::new(
                OnlineErrorKind::Network,
                format!("Réseau indisponible : {}", last_line(stderr)),
            );
        }

        Self::new(OnlineErrorKind::Tool, format!("yt-dlp : {}", last_line(stderr)))
    }
}

/// yt-dlp puts the useful sentence last; everything above it is context.
fn last_line(text: &str) -> String {
    text.lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("échec sans message")
        .trim_start_matches("ERROR:")
        .trim()
        .to_string()
}

impl std::fmt::Display for OnlineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for OnlineError {}

impl From<std::io::Error> for OnlineError {
    fn from(error: std::io::Error) -> Self {
        Self::io(format!("accès disque : {error}"))
    }
}

pub type Result<T> = std::result::Result<T, OnlineError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_closed_video_is_not_a_network_problem() {
        let error = OnlineError::from_tool("ERROR: [youtube] abc: Private video. Sign in...");
        assert_eq!(error.kind, OnlineErrorKind::Unavailable);
        assert!(!error.retryable);
    }

    #[test]
    fn the_same_refusal_matches_however_youtube_words_it() {
        for message in [
            "ERROR: [youtube] abc: Video unavailable",
            "ERROR: [youtube] abc: This video is not available",
            "ERROR: [youtube] abc: This content isn't available",
            "ERROR: [youtube] abc: This video is no longer available",
        ] {
            let error = OnlineError::from_tool(message);
            assert_eq!(error.kind, OnlineErrorKind::Unavailable, "for {message}");
            // And the raw tool prefix never reaches the panel.
            assert!(!error.message.starts_with("yt-dlp"), "for {message}");
        }
    }

    #[test]
    fn a_bad_address_says_so() {
        let error = OnlineError::from_tool("ERROR: Unsupported URL: htt://nope");
        assert_eq!(error.kind, OnlineErrorKind::InvalidUrl);
    }

    #[test]
    fn a_transport_failure_is_retryable() {
        let error = OnlineError::from_tool("ERROR: Unable to download webpage: timed out");
        assert_eq!(error.kind, OnlineErrorKind::Network);
        assert!(error.retryable);
    }

    #[test]
    fn a_refused_filename_is_not_reported_as_a_tool_fault() {
        let error = OnlineError::from_tool("ERROR: unable to open for writing: OSError: [Errno 22] Invalid argument");
        assert_eq!(error.kind, OnlineErrorKind::Io);
        assert!(error.message.contains("nom de fichier"));
    }

    #[test]
    fn anything_else_keeps_the_tools_own_words() {
        let error = OnlineError::from_tool("some context\nERROR: something odd happened");
        assert_eq!(error.kind, OnlineErrorKind::Tool);
        assert!(error.message.contains("something odd happened"));
        assert!(!error.message.contains("some context"));
    }
}
