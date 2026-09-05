//! Getting sound out of the timeline and into a shape the AI suite can use.
//!
//! Three very different consumers, one source:
//!
//! * [`excerpt`] produces a small, lossy, mono file to hand to a multimodal
//!   model. What matters is *size*: a request carries its audio inline, so an
//!   hour of speech has to fit in a few megabytes. 16 kHz mono at 24 kbit/s is
//!   past the point where transcription accuracy stops improving and well under
//!   the inline ceiling.
//! * [`envelope`] produces a loudness curve for silence detection. What matters
//!   is *determinism*: the same file must always yield the same cuts, so this
//!   decodes raw PCM and measures it rather than asking a model anything.
//! * [`onsets`] produces a per-band transient curve for beat detection. Same
//!   bargain as the envelope and for a sharper reason: a montage cut on a beat
//!   the analysis found by chance could never be reproduced, and a rhythmic
//!   edit that shifts between two runs of the same track is not an edit.
//!
//! Only the first asks a model anything; the other two are measurement. All
//! three go through the ffmpeg the editor already depends on for export, so a
//! machine that can render can also analyse — no second toolchain.

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

/// Shared with [`super::scenes`], which measures a reference the same way.
pub(super) fn ffmpeg() -> Result<PathBuf> {
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
 * Decoding
 * ------------------------------------------------------------------ */

/// What one decode produced, and what it ran into.
struct Decoded {
    /// Samples actually handed to the consumer.
    samples: u64,
    /// ffmpeg's own words when it exited non-zero — `None` on a clean run.
    ///
    /// Reported rather than raised, because a truncated decode is usually still
    /// worth measuring: a file whose last packet is damaged still has minutes of
    /// good audio in front of it, and failing the whole pass over the tail would
    /// throw that away. Each caller decides what a partial answer is worth.
    failure: Option<String>,
}

/// Decodes `path` to mono PCM at `rate`, handing every sample to `consume`.
///
/// Both measurement passes want the same thing — a deterministic, bounded-memory
/// stream of samples — and differ only in what they do with each one. So the
/// ffmpeg invocation, the chunked read, and the sample that straddles two chunks
/// are solved here once instead of twice.
fn decode_mono(
    path: &str,
    start: f64,
    duration: f64,
    rate: u32,
    mut consume: impl FnMut(f32),
) -> Result<Decoded> {
    let program = ffmpeg()?;
    let (start, duration) = window(start, duration);

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
        "-ar", &rate.to_string(),
        "-f", "s16le",
        "-",
    ]);

    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| AiError::ffmpeg(format!("ffmpeg n'a pas pu être lancé : {error}")))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| AiError::ffmpeg("flux de sortie ffmpeg indisponible"))?;

    let mut buffer = vec![0u8; 64 * 1024];
    // Kept across reads: a chunk boundary can land between the two bytes of a
    // sample, and splitting one would put a click in the middle of the curve.
    let mut spare: Option<u8> = None;
    let mut samples: u64 = 0;

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

            consume(i16::from_le_bytes([low, high]) as f32 / 32_768.0);
            samples += 1;
        }
    }

    let status = child
        .wait()
        .map_err(|error| AiError::ffmpeg(format!("ffmpeg s'est interrompu : {error}")))?;

    let failure = if status.success() {
        None
    } else {
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        Some(stderr)
    };

    Ok(Decoded { samples, failure })
}

/// The error a failed decode deserves, once the caller has found it has nothing.
fn decode_failure(stderr: &str) -> AiError {
    if is_missing_audio(stderr) {
        AiError::new(AiErrorKind::Ffmpeg, "Ce média ne contient pas de piste audio.")
    } else {
        AiError::ffmpeg(format!("Analyse audio impossible : {}", stderr.trim()))
    }
}

/* ------------------------------------------------------------------ *
 * Loudness envelope for silence detection
 * ------------------------------------------------------------------ */

/// Per-bucket loudness of `path` over `[start, start + duration)`.
///
/// Decoded straight to signed 16-bit mono and measured as it streams, so a long
/// clip costs a bounded amount of memory however long it is.
pub fn envelope(path: &str, start: f64, duration: f64, buckets_per_second: f64) -> Result<Envelope> {
    let buckets_per_second = buckets_per_second.clamp(4.0, 200.0);
    let per_bucket = ((ANALYSIS_RATE as f64) / buckets_per_second).round().max(1.0) as usize;

    let mut rms: Vec<f32> = Vec::new();
    let mut peak: Vec<f32> = Vec::new();
    let mut energy = 0f64;
    let mut loudest = 0f32;
    let mut counted = 0usize;
    let mut ceiling = 0f32;

    let decoded = decode_mono(path, start, duration, ANALYSIS_RATE, |sample| {
        let magnitude = sample.abs();
        energy += (sample as f64) * (sample as f64);
        if magnitude > loudest {
            loudest = magnitude;
        }
        if magnitude > ceiling {
            ceiling = magnitude;
        }
        counted += 1;

        if counted == per_bucket {
            rms.push((energy / counted as f64).sqrt() as f32);
            peak.push(loudest);
            energy = 0.0;
            loudest = 0.0;
            counted = 0;
        }
    })?;

    // Whatever is left over is a real, if short, bucket.
    if counted > 0 {
        rms.push((energy / counted as f64).sqrt() as f32);
        peak.push(loudest);
    }

    if let Some(stderr) = decoded.failure {
        if rms.is_empty() {
            return Err(decode_failure(&stderr));
        }
    }

    Ok(Envelope {
        rms,
        peak,
        buckets_per_second: ANALYSIS_RATE as f64 / per_bucket as f64,
        duration: decoded.samples as f64 / ANALYSIS_RATE as f64,
        ceiling,
    })
}

/* ------------------------------------------------------------------ *
 * Onset curve for beat detection
 * ------------------------------------------------------------------ */

/// Sample rate for the transient pass.
///
/// Half of CD rate. The pass is looking for *when* energy arrives rather than
/// what it sounds like, and a cymbal's attack is fully described below 11 kHz —
/// so the extra octave a higher rate would buy is spent on nothing.
const ONSET_RATE: u32 = 22_050;

/// Where the three bands are split, in hertz.
///
/// 150 Hz keeps a kick drum's body on one side and nearly everything else on
/// the other. 2 kHz puts a snare's crack and a hi-hat above it, and leaves the
/// vocal and instrument range in the middle — which is the band whose onsets are
/// the least trustworthy, and the one the front-end deliberately discounts.
const BAND_LOW_HZ: f32 = 150.0;
const BAND_HIGH_HZ: f32 = 2_000.0;

/// Cutoff of the envelope followers riding each band, in hertz.
///
/// This is the one number that has to be right. An analysis frame is around five
/// milliseconds, which is *shorter than one cycle* of a 60 Hz kick — so measuring
/// a band's energy frame by frame would track the waveform itself and report a
/// burst of onsets on every downstroke. Rectifying and smoothing at 30 Hz gives a
/// time constant of roughly six milliseconds: slow enough to sit still through
/// the carrier, fast enough to keep the attack it exists to find.
const ENVELOPE_HZ: f32 = 30.0;

/// Keeps the logarithm of a silent frame finite.
///
/// And, more usefully, it sets the level below which a *relative* rise stops
/// counting: without it, dither creeping up out of digital silence would read as
/// an enormous onset, and the quiet bar before a drop would come back full of
/// beats nobody can hear.
const ONSET_FLOOR: f32 = 1e-4;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnsetCurve {
    /// Onset strength per frame, low band — the kick.
    pub low: Vec<f32>,
    /// Mid band: voices and sustained instruments.
    pub mid: Vec<f32>,
    /// High band — snare, hats, and anything else with a crack to it.
    pub high: Vec<f32>,
    pub frames_per_second: f64,
    /// Seconds covered, from the samples actually decoded.
    pub duration: f64,
    /// Strongest onset anywhere in the three bands, so the caller can normalise
    /// against the track's own dynamics rather than against an absolute number.
    pub peak: f32,
}

/// One-pole low-pass coefficient for `cutoff`, at the analysis rate.
fn one_pole(cutoff: f32) -> f32 {
    1.0 - (-2.0 * std::f32::consts::PI * cutoff / ONSET_RATE as f32).exp()
}

/// Half-wave-rectified rise of a band's envelope, frame to frame.
///
/// Differenced in the *log* domain, not the linear one, and that is what makes
/// one threshold work across a whole library: a doubling of energy is the same
/// number whether it starts from quiet or from loud, so a sensitivity chosen on
/// a well-mastered track still means something on a bedroom recording.
///
/// Rectified because only a rise is a transient. Energy falling away is the tail
/// of the note that already hit.
fn rise(envelope: &[f32]) -> Vec<f32> {
    let mut out = Vec::with_capacity(envelope.len());
    // The first frame has nothing before it to have risen from, so it reports no
    // onset rather than the whole of its own level.
    let mut previous = (envelope.first().copied().unwrap_or(0.0) + ONSET_FLOOR).ln();

    for value in envelope {
        let current = (value + ONSET_FLOOR).ln();
        out.push((current - previous).max(0.0));
        previous = current;
    }

    out
}

/// Per-band transient strength of `path` over `[start, start + duration)`.
///
/// Three bands rather than one, because a montage needs to know *what* hit and
/// not merely that something did: a kick and a hi-hat are both onsets in a
/// broadband curve, and cutting on them alike gives an edit with no downbeat.
///
/// The peak-picking deliberately does not happen here. This returns the
/// measurement; deciding which peaks are beats is a pure function of the curve,
/// and it lives in `src/lib/amv/beats.ts` where it can be re-run on a slider
/// drag without going near the disk again.
pub fn onsets(path: &str, start: f64, duration: f64, frames_per_second: f64) -> Result<OnsetCurve> {
    let frames_per_second = frames_per_second.clamp(50.0, 400.0);
    let hop = ((ONSET_RATE as f64) / frames_per_second).round().max(1.0) as usize;

    let low_coefficient = one_pole(BAND_LOW_HZ);
    let body_coefficient = one_pole(BAND_HIGH_HZ);
    let envelope_coefficient = one_pole(ENVELOPE_HZ);

    // Filter state, carried sample to sample.
    let mut low_pass = 0f32;
    let mut body_pass = 0f32;
    let mut followers = [0f32; 3];
    // Loudest each follower reached inside the frame being filled. A maximum
    // rather than a mean: an attack landing mid-frame is the whole point of the
    // measurement, and averaging it with the silence beside it hides it.
    let mut held = [0f32; 3];
    let mut counted = 0usize;
    let mut bands: [Vec<f32>; 3] = [Vec::new(), Vec::new(), Vec::new()];

    let decoded = decode_mono(path, start, duration, ONSET_RATE, |sample| {
        low_pass += low_coefficient * (sample - low_pass);
        body_pass += body_coefficient * (sample - body_pass);

        // Two running low-passes are enough for three bands: what is below the
        // upper cutoff and not below the lower one is the middle, and what the
        // upper one did not keep is the top.
        let split = [low_pass, body_pass - low_pass, sample - body_pass];

        for ((follower, hold), band) in followers.iter_mut().zip(held.iter_mut()).zip(split) {
            *follower += envelope_coefficient * (band.abs() - *follower);
            if *follower > *hold {
                *hold = *follower;
            }
        }

        counted += 1;
        if counted == hop {
            for (frames, hold) in bands.iter_mut().zip(held.iter_mut()) {
                frames.push(*hold);
                *hold = 0.0;
            }
            counted = 0;
        }
    })?;

    // A part-filled last frame is still a real one, if short.
    if counted > 0 {
        for (frames, hold) in bands.iter_mut().zip(held.iter()) {
            frames.push(*hold);
        }
    }

    if let Some(stderr) = decoded.failure {
        if bands[0].is_empty() {
            return Err(decode_failure(&stderr));
        }
    }

    let [low, mid, high] = bands.map(|band| rise(&band));
    let peak = [&low, &mid, &high]
        .into_iter()
        .flat_map(|band| band.iter().copied())
        .fold(0f32, f32::max);

    Ok(OnsetCurve {
        low,
        mid,
        high,
        frames_per_second: ONSET_RATE as f64 / hop as f64,
        duration: decoded.samples as f64 / ONSET_RATE as f64,
        peak,
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

    #[test]
    fn a_one_pole_coefficient_stays_inside_the_stable_range() {
        // Above zero or the filter never moves; at or above one it overshoots
        // its own input and rings. Both ends of the audible range must sit
        // strictly between the two, or the envelope followers are unusable.
        for cutoff in [ENVELOPE_HZ, BAND_LOW_HZ, BAND_HIGH_HZ] {
            let coefficient = one_pole(cutoff);
            assert!(coefficient > 0.0 && coefficient < 1.0, "{cutoff} Hz → {coefficient}");
        }
        // A higher cutoff must follow its input faster; the ordering is what
        // makes the band split a split rather than three copies of one signal.
        assert!(one_pole(BAND_LOW_HZ) < one_pole(BAND_HIGH_HZ));
    }

    #[test]
    fn a_rise_reports_only_growth_and_never_the_first_frame() {
        let out = rise(&[0.1, 0.4, 0.4, 0.05]);
        assert_eq!(out.len(), 4);
        // Nothing precedes the first frame, so it cannot have risen.
        assert_eq!(out[0], 0.0);
        assert!(out[1] > 0.0, "a fourfold jump is an onset");
        assert_eq!(out[2], 0.0, "a level held flat is not an onset");
        assert_eq!(out[3], 0.0, "energy falling away is the tail, not a hit");
    }

    #[test]
    fn a_rise_is_the_same_number_however_loud_the_master_is() {
        // The whole point of differencing in the log domain: one sensitivity
        // has to mean the same thing on a quiet track and a hot one.
        let quiet = rise(&[0.01, 0.02]);
        let loud = rise(&[0.4, 0.8]);
        assert!((quiet[1] - loud[1]).abs() < 0.02, "{quiet:?} vs {loud:?}");
    }

    #[test]
    fn digital_silence_produces_no_onsets() {
        assert!(rise(&[0.0; 8]).iter().all(|value| *value == 0.0));
        // And the floor keeps dither from reading as an enormous one.
        let dither = rise(&[0.0, 1e-6, 0.0, 1e-6]);
        assert!(dither.iter().all(|value| *value < 0.05), "{dither:?}");
    }
}
