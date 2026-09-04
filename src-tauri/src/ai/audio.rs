//! Getting sound out of the timeline and into a shape the AI suite can use.
//!
//! Two very different consumers, one source:
//!
//! * [`excerpt`] produces a small, lossy, mono file to hand to a multimodal
//!   model. What matters is *size*: a request carries its audio inline, so an
//!   hour of speech has to fit in a few megabytes. 16 kHz mono at 24 kbit/s is
//!   past the point where transcription accuracy stops improving and well under
//!   the inline ceiling.
//! * [`envelope`] produces a loudness curve for silence detection. What matters
//!   is *determinism*: the same file must always yield the same cuts, so this
//!   decodes raw PCM and measures it rather than asking a model anything.
//!
//! Both go through the ffmpeg the editor already depends on for export, so a
//! machine that can render can also transcribe — no second toolchain.

use std::io::Read;
use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;

use super::error::{AiError, AiErrorKind, Result};
use crate::engine::ffmpeg::locate_binary;

/// Gemini takes up to 20 MB of inline payload for the whole request; this
/// leaves room for the prompt and the base64 expansion on top of it.
const MAX_EXCERPT_BYTES: u64 = 13 * 1024 * 1024;
/// Sample rate for the loudness pass. Speech energy is fully described well
/// below this, and it keeps a feature-length analysis to a few megabytes.
const ANALYSIS_RATE: u32 = 8_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioExcerpt {
    /// Ready for a Gemini `inlineData` part.
    pub data: String,
    pub mime_type: String,
    pub bytes: u64,
    /// Seconds actually written, which is what segment timings are relative to.
    pub duration: f64,
    /// Which rung of the codec ladder answered, for the log and the UI hint.
    pub codec: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    /// Root-mean-square level per bucket, 0 → 1. Perceived loudness.
    pub rms: Vec<f32>,
    /// Loudest sample per bucket, 0 → 1. Catches transients an RMS window hides.
    pub peak: Vec<f32>,
    pub buckets_per_second: f64,
    /// Seconds covered, from the samples actually decoded.
    pub duration: f64,
    /// Loudest sample in the whole excerpt, before any normalisation. A file
    /// that never reaches this is silent, and the caller says so rather than
    /// normalising noise up into speech.
    pub ceiling: f32,
}

fn ffmpeg() -> Result<PathBuf> {
    locate_binary("ffmpeg").ok_or_else(|| {
        AiError::ffmpeg(
            "ffmpeg est introuvable. Installez-le depuis la fenêtre d'export, puis réessayez.",
        )
    })
}

/// Clean, finite bounds — a NaN duration from a half-probed asset would
/// otherwise reach ffmpeg as the literal string `NaN`.
fn window(start: f64, duration: f64) -> (f64, f64) {
    let start = if start.is_finite() { start.max(0.0) } else { 0.0 };
    let duration = if duration.is_finite() { duration.max(0.0) } else { 0.0 };
    (start, duration)
}

/// ffmpeg's own words, trimmed to the line that actually explains the failure.
fn stderr_reason(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    text.lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("échec sans message")
        .trim()
        .to_string()
}

fn is_missing_audio(stderr: &str) -> bool {
    stderr.contains("does not contain any stream")
        || stderr.contains("Stream map '0:a:0' matches no streams")
        || stderr.contains("Output file does not contain any stream")
}

/* ------------------------------------------------------------------ *
 * Excerpt for the model
 * ------------------------------------------------------------------ */

/// Codec, muxer, extension, MIME type and bitrate — tried in this order.
///
/// Opus is the smallest for speech by a wide margin, but not every static
/// ffmpeg build ships libopus and none of them are labelled. Rather than probe
/// the encoder list, we try, and fall down the ladder on failure — MP3 and AAC
/// are present in every build that exists, and both are formats Gemini accepts.
const LADDER: [(&str, &str, &str, &str, &str); 3] = [
    ("libopus", "ogg", "ogg", "audio/ogg", "24k"),
    ("libmp3lame", "mp3", "mp3", "audio/mp3", "32k"),
    ("aac", "adts", "aac", "audio/aac", "32k"),
];

fn scratch(extension: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("veglass-ai-{stamp}.{extension}"))
}

/// A compressed mono excerpt of `path`, base64-encoded and ready to post.
///
/// `duration` of zero means "to the end of the file".
pub fn excerpt(path: &str, start: f64, duration: f64) -> Result<AudioExcerpt> {
    let program = ffmpeg()?;
    let (start, duration) = window(start, duration);

    let mut last = String::new();
    for (codec, format, extension, mime, bitrate) in LADDER {
        let output = scratch(extension);
        let mut command = crate::proc::command(&program);
        command.args(["-hide_banner", "-v", "error", "-nostdin", "-y"]);
        // Seeking before the input is the fast path, and audio has no keyframes
        // to be inaccurate about.
        if start > 0.0 {
            command.args(["-ss", &format!("{start:.3}")]);
        }
        command.arg("-i").arg(path);
        if duration > 0.0 {
            command.args(["-t", &format!("{duration:.3}")]);
        }
        command.args([
            "-vn",
            "-map", "0:a:0",
            "-ac", "1",
            "-ar", "16000",
            "-c:a", codec,
            "-b:a", bitrate,
            "-f", format,
        ]);
        command.arg(&output);

        let result = command.stdin(Stdio::null()).output();
        let Ok(result) = result else {
            let _ = std::fs::remove_file(&output);
            return Err(AiError::ffmpeg("ffmpeg n'a pas pu être lancé."));
        };

        if !result.status.success() {
            let _ = std::fs::remove_file(&output);
            last = stderr_reason(&result.stderr);
            if is_missing_audio(&last) {
                // Falling down the ladder cannot conjure a stream that is not
                // there; say so once rather than three times.
                return Err(AiError::new(
                    AiErrorKind::Ffmpeg,
                    "Ce média ne contient pas de piste audio.",
                ));
            }
            continue;
        }

        let bytes = std::fs::metadata(&output).map(|meta| meta.len()).unwrap_or(0);
        if bytes == 0 {
            let _ = std::fs::remove_file(&output);
            last = "l'extraction n'a produit aucune donnée".into();
            continue;
        }
        if bytes > MAX_EXCERPT_BYTES {
            let _ = std::fs::remove_file(&output);
            return Err(AiError::new(
                AiErrorKind::Ffmpeg,
                format!(
                    "Extrait trop long pour un envoi en une fois ({} Mo). Découpez le clip, ou lancez la transcription clip par clip.",
                    bytes / 1_000_000
                ),
            ));
        }

        let raw = std::fs::read(&output)?;
        let _ = std::fs::remove_file(&output);

        use base64::Engine as _;
        return Ok(AudioExcerpt {
            data: base64::engine::general_purpose::STANDARD.encode(&raw),
            mime_type: mime.to_string(),
            bytes,
            duration,
            codec: codec.to_string(),
        });
    }

    Err(AiError::ffmpeg(format!(
        "Aucun encodeur audio utilisable dans cette installation de ffmpeg ({last})."
    )))
}

/* ------------------------------------------------------------------ *
 * Loudness envelope for silence detection
 * ------------------------------------------------------------------ */

/// Per-bucket loudness of `path` over `[start, start + duration)`.
///
/// Decoded straight to signed 16-bit mono and measured as it streams, so a long
/// clip costs a bounded amount of memory however long it is.
pub fn envelope(path: &str, start: f64, duration: f64, buckets_per_second: f64) -> Result<Envelope> {
    let program = ffmpeg()?;
    let (start, duration) = window(start, duration);
    let buckets_per_second = buckets_per_second.clamp(4.0, 200.0);
    let per_bucket = ((ANALYSIS_RATE as f64) / buckets_per_second).round().max(1.0) as usize;

    let mut command = crate::proc::command(&program);
    command.args(["-hide_banner", "-v", "error", "-nostdin"]);
    if start > 0.0 {
        command.args(["-ss", &format!("{start:.3}")]);
    }
    command.arg("-i").arg(path);
    if duration > 0.0 {
        command.args(["-t", &format!("{duration:.3}")]);
    }
    command.args([
        "-vn",
        "-map", "0:a:0",
        "-ac", "1",
        "-ar", &ANALYSIS_RATE.to_string(),
        "-f", "s16le",
        "-",
    ]);

    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| AiError::ffmpeg(format!("ffmpeg n'a pas pu être lancé : {error}")))?;

    let mut stdout = child.stdout.take().ok_or_else(|| {
        AiError::ffmpeg("flux de sortie ffmpeg indisponible")
    })?;

    let mut rms: Vec<f32> = Vec::new();
    let mut peak: Vec<f32> = Vec::new();
    let mut buffer = vec![0u8; 64 * 1024];
    // Kept across reads: a chunk boundary can land between the two bytes of a
    // sample, and splitting one would put a click in the middle of the curve.
    let mut spare: Option<u8> = None;
    let mut energy = 0f64;
    let mut loudest = 0f32;
    let mut counted = 0usize;
    let mut samples: u64 = 0;
    let mut ceiling = 0f32;

    loop {
        let read = stdout.read(&mut buffer).map_err(|error| {
            AiError::ffmpeg(format!("lecture du flux audio interrompue : {error}"))
        })?;
        if read == 0 {
            break;
        }

        let mut index = 0usize;
        while index < read {
            let (low, high) = match spare.take() {
                Some(low) => {
                    let high = buffer[index];
                    index += 1;
                    (low, high)
                }
                None => {
                    if index + 1 >= read {
                        spare = Some(buffer[index]);
                        break;
                    }
                    let pair = (buffer[index], buffer[index + 1]);
                    index += 2;
                    pair
                }
            };

            let sample = i16::from_le_bytes([low, high]) as f32 / 32_768.0;
            let magnitude = sample.abs();
            energy += (sample as f64) * (sample as f64);
            if magnitude > loudest {
                loudest = magnitude;
            }
            if magnitude > ceiling {
                ceiling = magnitude;
            }
            counted += 1;
            samples += 1;

            if counted == per_bucket {
                rms.push((energy / counted as f64).sqrt() as f32);
                peak.push(loudest);
                energy = 0.0;
                loudest = 0.0;
                counted = 0;
            }
        }
    }

    // Whatever is left over is a real, if short, bucket.
    if counted > 0 {
        rms.push((energy / counted as f64).sqrt() as f32);
        peak.push(loudest);
    }

    let status = child
        .wait()
        .map_err(|error| AiError::ffmpeg(format!("ffmpeg s'est interrompu : {error}")))?;

    if !status.success() && rms.is_empty() {
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        return Err(if is_missing_audio(&stderr) {
            AiError::new(AiErrorKind::Ffmpeg, "Ce média ne contient pas de piste audio.")
        } else {
            AiError::ffmpeg(format!("Analyse audio impossible : {}", stderr.trim()))
        });
    }

    Ok(Envelope {
        rms,
        peak,
        buckets_per_second: ANALYSIS_RATE as f64 / per_bucket as f64,
        duration: samples as f64 / ANALYSIS_RATE as f64,
        ceiling,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_rejects_nonsense() {
        assert_eq!(window(-4.0, 2.0), (0.0, 2.0));
        assert_eq!(window(f64::NAN, f64::INFINITY), (0.0, 0.0));
        assert_eq!(window(1.5, 3.0), (1.5, 3.0));
    }

    #[test]
    fn stderr_reason_keeps_the_last_meaningful_line() {
        let raw = b"warming up\n\nStream map '0:a:0' matches no streams.\n\n";
        assert_eq!(stderr_reason(raw), "Stream map '0:a:0' matches no streams.");
        assert_eq!(stderr_reason(b""), "échec sans message");
    }

    #[test]
    fn missing_audio_is_recognised() {
        assert!(is_missing_audio("Stream map '0:a:0' matches no streams."));
        assert!(!is_missing_audio("Invalid data found when processing input"));
    }

    #[test]
    fn the_ladder_only_offers_formats_gemini_accepts() {
        for (_, _, _, mime, _) in LADDER {
            assert!(matches!(mime, "audio/ogg" | "audio/mp3" | "audio/aac"));
        }
    }
}
