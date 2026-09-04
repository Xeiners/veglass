//! One frame of a video, as a JPEG.
//!
//! The viral-clip wizard shows a dashboard of proposed cuts, and a proposal
//! without a picture is a row of numbers: the thumbnail is what lets someone
//! recognise the moment the model is describing. The webview cannot get it
//! alone — seeking a `<video>` to an arbitrary instant and reading it back is
//! slow, and fails outright on codecs the platform will not decode in a tag.
//!
//! ffmpeg is already here for everything else, so this asks it for a single
//! frame on stdout. No temporary file: one frame at thumbnail size is tens of
//! kilobytes, which is cheaper to hand over as base64 than to write and clean
//! up afterwards.

use std::path::PathBuf;
use std::process::Stdio;

use base64::Engine as _;
use serde::Serialize;

use crate::ai::error::{AiError, AiErrorKind, Result};
use crate::engine::ffmpeg::locate_binary;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Poster {
    /// Base64 JPEG — the caller builds the `data:` URI.
    pub data: String,
    pub mime_type: String,
    /// The width actually asked of ffmpeg, after clamping.
    pub width: u32,
}

/// Thumbnails, not stills: past this the payload costs more than it shows.
const MIN_WIDTH: u32 = 48;
const MAX_WIDTH: u32 = 960;

/// Keeps a caller-supplied width inside what a thumbnail should be.
///
/// This value is interpolated straight into an ffmpeg filter string, so it is
/// also the place a nonsense width would otherwise become a nonsense command.
fn thumbnail_width(asked: u32) -> u32 {
    asked.clamp(MIN_WIDTH, MAX_WIDTH)
}

fn ffmpeg() -> Result<PathBuf> {
    locate_binary("ffmpeg").ok_or_else(|| {
        AiError::ffmpeg(
            "ffmpeg est introuvable. Installez-le depuis la fenêtre d'export, puis réessayez.",
        )
    })
}

/// Runs one extraction attempt, returning the JPEG bytes.
///
/// `seek` is separate from the rest because it is the part that can legitimately
/// come back empty: a timestamp past the end of the file, or inside a trailing
/// gap, produces no frame and no error.
fn capture(program: &PathBuf, path: &str, at: Option<f64>, width: u32) -> Result<Vec<u8>> {
    let mut command = crate::proc::command(program);
    command.args(["-hide_banner", "-v", "error", "-nostdin"]);

    // Seeking before the input jumps by keyframe, which is approximate but
    // orders of magnitude faster on a long file — and for a thumbnail, landing
    // on the nearest keyframe is indistinguishable from landing exactly.
    if let Some(seconds) = at {
        if seconds > 0.0 {
            command.args(["-ss", &format!("{seconds:.3}")]);
        }
    }

    command
        .arg("-i")
        .arg(path)
        .args(["-frames:v", "1"])
        .args(["-vf", &format!("scale={width}:-2:flags=bilinear")])
        .args(["-q:v", "5"])
        .args(["-f", "mjpeg", "-"]);

    let output = command
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|_| AiError::ffmpeg("ffmpeg n'a pas pu être lancé."))?;

    if !output.status.success() {
        return Err(AiError::ffmpeg(format!(
            "extraction de l'image : {}",
            reason(&output.stderr)
        )));
    }

    Ok(output.stdout)
}

/// A still from `path`, `at` seconds in.
pub fn poster(path: &str, at: f64, width: u32) -> Result<Poster> {
    let program = ffmpeg()?;
    let width = thumbnail_width(width);
    let at = if at.is_finite() { at.max(0.0) } else { 0.0 };

    let mut bytes = capture(&program, path, Some(at), width)?;

    // An empty result is not a failure: the timestamp simply had no frame after
    // it. The first frame of the file is a truthful fallback for a thumbnail,
    // and far better than an empty card.
    if bytes.is_empty() && at > 0.0 {
        bytes = capture(&program, path, None, width)?;
    }

    if bytes.is_empty() {
        return Err(AiError::new(
            AiErrorKind::Ffmpeg,
            "Aucune image n'a pu être extraite de ce média.",
        ));
    }

    Ok(Poster {
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime_type: "image/jpeg".into(),
        width,
    })
}

/// ffmpeg's last meaningful line — the rest is banner and stream layout.
fn reason(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr)
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("échec sans message")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_thumbnail_stays_a_thumbnail() {
        assert_eq!(thumbnail_width(320), 320);
        // Zero would make `scale=0:-2`, which ffmpeg reads as "keep the source
        // width" — a full-resolution frame base64'd across the bridge.
        assert_eq!(thumbnail_width(0), MIN_WIDTH);
        assert_eq!(thumbnail_width(u32::MAX), MAX_WIDTH);
    }

    #[test]
    fn the_last_line_is_the_one_that_explains() {
        let stderr = b"  \nStream mapping:\n  Stream #0:0 -> #0:0\nInvalid data found\n";
        assert_eq!(reason(stderr), "Invalid data found");
        assert_eq!(reason(b""), "échec sans message");
    }
}
