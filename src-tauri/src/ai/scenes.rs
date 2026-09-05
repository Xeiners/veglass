//! Where a video cuts.
//!
//! One measurement, for one purpose: reading the *pacing* of a reference edit.
//! Someone points the director at a montage they like, and the only honest way
//! to learn how it is cut is to look at it — how often the picture changes, and
//! where the changes bunch up.
//!
//! ffmpeg's `select='gt(scene,…)'` scores each frame against the one before it
//! and keeps the ones that differ enough to be a cut; `metadata=print` then
//! writes the timestamp and the score of every survivor to stdout. That is a
//! deterministic measurement of the finished pictures, not an inference about
//! them — the same file always yields the same cuts.
//!
//! # What this deliberately does not do
//!
//! It does not know a hard cut from a fast dissolve, and it cannot tell either
//! from a whip pan. All three move a lot of pixels in a hurry, which is exactly
//! what the score measures. For reading *pace* that is fine — a reference full
//! of whip pans is a fast reference — and pretending otherwise would mean
//! claiming a precision the measurement does not have.

use std::io::Read;
use std::process::Stdio;

use serde::Serialize;

use super::audio::ffmpeg;
use super::error::{AiError, Result};

/// How different two frames must be to count as a cut, 0 → 1.
///
/// ffmpeg's own default for `scdet` is 10 (on a 0–100 scale). This is stricter
/// than that in the middle of its range and it is the right side to be strict
/// on: a missed cut lowers the measured pace a little, while a false one
/// invented by a camera flash or a pan would report a reference as far busier
/// than it is, and the montage built from it would be too.
const DEFAULT_THRESHOLD: f64 = 0.28;

/// Longest stretch of a reference worth looking at, in seconds.
///
/// A reference is consulted for its *shape*, and three minutes contains more
/// than enough of one. The cap matters because the analysis decodes every
/// frame: without it, someone pasting a link to an hour-long upload waits for
/// an hour-long decode to learn something the first verse already said.
const MAX_SECONDS: f64 = 180.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneCuts {
    /// Seconds from the start of the file, ascending.
    pub cuts: Vec<f64>,
    /// What each cut scored, in the same order. 1 is a complete change.
    pub scores: Vec<f32>,
    /// Seconds actually scanned, which is what a rate is measured against.
    pub duration: f64,
}

/// The timestamp on a `metadata=print` header line, if that is what it is.
///
/// The filter writes two lines per hit — `frame:… pts:… pts_time:12.345` and
/// then `lavfi.scene_score=0.65`. Parsing is split across the two so a malformed
/// pair is dropped whole rather than pairing one cut's time with another's
/// score.
fn parse_time(line: &str) -> Option<f64> {
    line.split("pts_time:")
        .nth(1)?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

fn parse_score(line: &str) -> Option<f32> {
    line.trim().strip_prefix("lavfi.scene_score=")?.parse().ok()
}

/// Cuts detected in `path`, over at most [`MAX_SECONDS`].
///
/// `threshold` of zero means the default; anything else is clamped into a range
/// where the answer is still a cut list rather than either a frame index or an
/// empty one.
pub fn scenes(path: &str, threshold: f64, seconds: f64) -> Result<SceneCuts> {
    let program = ffmpeg()?;
    let threshold = if threshold > 0.0 { threshold.clamp(0.05, 0.95) } else { DEFAULT_THRESHOLD };
    let window = if seconds.is_finite() && seconds > 0.0 {
        seconds.min(MAX_SECONDS)
    } else {
        MAX_SECONDS
    };

    let mut command = crate::proc::command(&program);
    command.args([
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-t",
        &format!("{window:.3}"),
    ]);
    command.arg("-i").arg(path);
    command.args([
        // No sound: the audio side of a reference is measured by the onset pass,
        // and decoding it here would cost time for nothing.
        "-an",
        "-vf",
        &format!("select='gt(scene,{threshold:.3})',metadata=print:file=-"),
        // The frames themselves are thrown away — only the metadata is wanted.
        "-f",
        "null",
        "-",
    ]);

    let output = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| AiError::ffmpeg(format!("ffmpeg n'a pas pu être lancé : {error}")))?;

    if !output.status.success() {
        let mut stderr = String::new();
        let _ = output.stderr.as_slice().read_to_string(&mut stderr);
        return Err(AiError::ffmpeg(format!(
            "Analyse des plans impossible : {}",
            stderr.trim()
        )));
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut cuts = Vec::new();
    let mut scores = Vec::new();
    let mut pending: Option<f64> = None;

    for line in text.lines() {
        if let Some(time) = parse_time(line) {
            // A header with no score after it never completes a pair, and is
            // replaced by the next one rather than left to pair with a later
            // score that belongs to a different frame.
            pending = Some(time);
            continue;
        }
        if let (Some(time), Some(score)) = (pending, parse_score(line)) {
            cuts.push(time);
            scores.push(score);
            pending = None;
        }
    }

    Ok(SceneCuts { cuts, scores, duration: window })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_header_line_gives_up_its_timestamp() {
        assert_eq!(parse_time("frame:12   pts:15360   pts_time:1.5"), Some(1.5));
        assert_eq!(parse_time("frame:0    pts:0   pts_time:0"), Some(0.0));
        assert_eq!(parse_time("lavfi.scene_score=0.65"), None);
        assert_eq!(parse_time("something else entirely"), None);
    }

    #[test]
    fn a_score_line_gives_up_its_score() {
        assert_eq!(parse_score("lavfi.scene_score=0.650000"), Some(0.65));
        assert_eq!(parse_score("  lavfi.scene_score=1.000000  "), Some(1.0));
        assert_eq!(parse_score("frame:0 pts_time:1"), None);
        // A key that merely starts the same way is not this one.
        assert_eq!(parse_score("lavfi.scene_score_extra=0.5"), None);
    }

    /// The two-line pairing, which is the only part of the parse that can go
    /// wrong quietly: a dropped score must not shift every later cut onto the
    /// wrong timestamp.
    #[test]
    fn an_unpaired_header_does_not_shift_the_ones_after_it() {
        let lines = [
            "frame:0 pts_time:1",
            "lavfi.scene_score=0.6",
            // A header whose score never arrives.
            "frame:1 pts_time:2",
            "frame:2 pts_time:3",
            "lavfi.scene_score=0.9",
        ];

        let mut cuts = Vec::new();
        let mut pending: Option<f64> = None;
        for line in lines {
            if let Some(time) = parse_time(line) {
                pending = Some(time);
                continue;
            }
            if let (Some(time), Some(score)) = (pending, parse_score(line)) {
                cuts.push((time, score));
                pending = None;
            }
        }

        assert_eq!(cuts, [(1.0, 0.6), (3.0, 0.9)]);
    }
}
