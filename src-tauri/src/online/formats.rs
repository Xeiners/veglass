//! What a video actually offers, before anything is fetched.
//!
//! `yt-dlp -F` prints forty rows, most of which are the same picture at the same
//! size in a different container. That is a diagnostic listing, not a choice —
//! nobody picks between `137` and `299` on purpose. So this aggregates: one
//! offer per **resolution**, one per audio codec, each already carrying the
//! numbers a decision needs — is it there, how big is it, does it come with
//! sound.
//!
//! The aggregation is where the robustness requirement lives. A video that tops
//! out at 720p simply has no 1080p offer, so the picker has nothing to grey out
//! and nothing to fall back from: the list *is* what exists.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::error::{OnlineError, OnlineErrorKind, Result};
use super::ytdlp;

const TIMEOUT: Duration = Duration::from_secs(45);

/// One resolution on offer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoOffer {
    pub height: u32,
    /// `1080p`, `2160p · 4K` — what the button says.
    pub label: String,
    pub fps: Option<f64>,
    /// `h264`, `vp9`, `av1` — the family, not the full codec string.
    pub codec: String,
    pub ext: String,
    /// Bytes, video plus the sound it will be merged with. `None` when the site
    /// declines to say, which is common on the largest renditions.
    pub size: Option<u64>,
    /// Whether this rendition already carries sound and needs no merge.
    pub muxed: bool,
}

/// One audio stream on offer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOffer {
    /// `opus`, `aac`, `mp4a` — the family.
    pub codec: String,
    /// kbit/s, when the site says.
    pub bitrate: Option<f64>,
    pub ext: String,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFormats {
    pub title: String,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
    pub uploader: Option<String>,
    /// Best first. Empty when the video offers no picture at all.
    pub video: Vec<VideoOffer>,
    /// Best first.
    pub audio: Vec<AudioOffer>,
    /// A stream in progress — it has no end, so it cannot be fetched.
    pub live: bool,
}

/// What the front-end asks to be downloaded.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Selection {
    /// Picture and sound. `None` means the best available.
    Video { #[serde(default)] height: Option<u32> },
    /// Sound only, converted to `format`.
    Audio { format: AudioTarget },
}

impl Default for Selection {
    fn default() -> Self {
        Self::Video { height: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioTarget {
    /// No re-encode at all: the stream as published, in a proper container.
    /// The highest quality possible, and the fastest.
    Original,
    Mp3,
    M4a,
    Wav,
}

impl Selection {
    /// The `-f` expression and any post-processing arguments.
    ///
    /// Height is expressed as a ceiling rather than an equality: a video whose
    /// tallest rendition is 720p still downloads when 1080p was asked for, which
    /// is the fallback the brief wants and costs one character to get right.
    pub fn arguments(&self) -> Vec<String> {
        let s = |value: &str| value.to_string();
        match self {
            Selection::Video { height } => {
                let format = match height {
                    Some(limit) => format!(
                        "bv*[height<={limit}][ext=mp4]+ba[ext=m4a]/bv*[height<={limit}]+ba/b[height<={limit}]/b"
                    ),
                    None => s("bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b"),
                };
                vec![s("-f"), format, s("--merge-output-format"), s("mp4")]
            }
            Selection::Audio { format } => {
                let mut args = vec![s("-f"), s("ba/b"), s("-x"), s("--audio-format")];
                match format {
                    // `best` is yt-dlp's word for "remux, do not re-encode".
                    AudioTarget::Original => args.push(s("best")),
                    AudioTarget::Mp3 => {
                        args.push(s("mp3"));
                        args.push(s("--audio-quality"));
                        args.push(s("0"));
                    }
                    AudioTarget::M4a => args.push(s("m4a")),
                    AudioTarget::Wav => args.push(s("wav")),
                }
                args
            }
        }
    }
}

/* ------------------------------------------------------------------ *
 * Reading the listing
 * ------------------------------------------------------------------ */

const NONE: &str = "none";

fn codec_family(codec: &str) -> String {
    let head = codec.split('.').next().unwrap_or(codec);
    match head {
        "avc1" | "h264" => "h264".to_string(),
        "vp09" | "vp9" => "vp9".to_string(),
        "av01" => "av1".to_string(),
        "mp4a" => "aac".to_string(),
        other => other.to_string(),
    }
}

fn size_of(entry: &Value) -> Option<u64> {
    ["filesize", "filesize_approx"]
        .iter()
        .find_map(|key| entry.get(*key).and_then(Value::as_u64))
        .filter(|value| *value > 0)
}

fn label_for(height: u32) -> String {
    match height {
        h if h >= 4320 => "4320p · 8K".to_string(),
        h if h >= 2160 => "2160p · 4K".to_string(),
        h if h >= 1440 => "1440p · 2K".to_string(),
        h => format!("{h}p"),
    }
}

/// Turns one `--dump-single-json` payload into the offers a picker can show.
pub fn parse(payload: &str) -> Result<MediaFormats> {
    let root: Value = serde_json::from_str(payload).map_err(|error| {
        OnlineError::new(OnlineErrorKind::Format, format!("réponse illisible : {error}"))
    })?;

    let formats = root
        .get("formats")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();

    // Best audio first, so a video offer can borrow its size for the estimate.
    let mut audio: Vec<AudioOffer> = Vec::new();
    for entry in formats {
        let vcodec = entry.get("vcodec").and_then(Value::as_str).unwrap_or(NONE);
        let acodec = entry.get("acodec").and_then(Value::as_str).unwrap_or(NONE);
        if vcodec != NONE || acodec == NONE {
            continue;
        }
        audio.push(AudioOffer {
            codec: codec_family(acodec),
            bitrate: entry
                .get("abr")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite() && *value > 0.0),
            ext: entry.get("ext").and_then(Value::as_str).unwrap_or("m4a").to_string(),
            size: size_of(entry),
        });
    }
    audio.sort_by(|a, b| {
        b.bitrate
            .unwrap_or(0.0)
            .partial_cmp(&a.bitrate.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    // One row per codec: three bitrates of the same Opus stream is a diagnostic
    // listing, not a choice. `dedup_by` would be wrong here — it only removes
    // *adjacent* duplicates, and after sorting by bitrate the two Opus streams
    // sit either side of the AAC one.
    let mut seen: Vec<String> = Vec::new();
    audio.retain(|offer| {
        if seen.contains(&offer.codec) {
            return false;
        }
        seen.push(offer.codec.clone());
        true
    });

    let companion = audio.first().and_then(|offer| offer.size);

    // One offer per height, keeping the richest stream at each.
    let mut video: Vec<VideoOffer> = Vec::new();
    for entry in formats {
        let vcodec = entry.get("vcodec").and_then(Value::as_str).unwrap_or(NONE);
        if vcodec == NONE {
            continue;
        }
        let Some(height) = entry.get("height").and_then(Value::as_u64).filter(|value| *value > 0)
        else {
            continue;
        };

        let acodec = entry.get("acodec").and_then(Value::as_str).unwrap_or(NONE);
        let muxed = acodec != NONE;
        let own = size_of(entry);
        let offer = VideoOffer {
            height: height as u32,
            label: label_for(height as u32),
            fps: entry
                .get("fps")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite() && *value > 0.0),
            codec: codec_family(vcodec),
            ext: entry.get("ext").and_then(Value::as_str).unwrap_or("mp4").to_string(),
            // A separate stream is merged with sound, so the honest figure is
            // both halves — showing only the picture would understate it by a
            // tenth on a long file.
            size: match (own, muxed) {
                (Some(bytes), false) => Some(bytes + companion.unwrap_or(0)),
                (Some(bytes), true) => Some(bytes),
                (None, _) => None,
            },
            muxed,
        };

        match video.iter_mut().find(|existing| existing.height == offer.height) {
            // Keep whichever tells us more: a known size beats an unknown one,
            // and a muxed stream needs no merge.
            Some(existing) => {
                if existing.size.is_none() && offer.size.is_some() {
                    *existing = offer;
                }
            }
            None => video.push(offer),
        }
    }
    video.sort_by_key(|offer| std::cmp::Reverse(offer.height));

    Ok(MediaFormats {
        title: root
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Sans titre")
            .to_string(),
        duration: root
            .get("duration")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0),
        thumbnail: root.get("thumbnail").and_then(Value::as_str).map(str::to_string),
        uploader: ["channel", "uploader"]
            .iter()
            .find_map(|key| root.get(*key).and_then(Value::as_str))
            .map(str::to_string),
        live: matches!(
            root.get("live_status").and_then(Value::as_str),
            Some("is_live") | Some("is_upcoming")
        ),
        video,
        audio,
    })
}

/// Asks yt-dlp what `url` offers.
pub fn inspect(url: &str) -> Result<MediaFormats> {
    let mut command = ytdlp::command()?;
    command
        .arg("--dump-single-json")
        .arg("--no-playlist")
        .arg("--socket-timeout")
        .arg("15")
        .arg(url);

    let captured = ytdlp::run_capturing(
        &mut command,
        TIMEOUT,
        "La lecture des formats n'a pas répondu.",
    )?;

    if !captured.success {
        return Err(OnlineError::from_tool(&captured.stderr));
    }

    parse(&captured.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LISTING: &str = r#"{
        "title": "Un plan", "duration": 212.0, "channel": "Studio",
        "thumbnail": "t.jpg",
        "formats": [
            {"vcodec":"none","acodec":"opus","abr":160.0,"ext":"webm","filesize":4000000},
            {"vcodec":"none","acodec":"mp4a.40.2","abr":128.0,"ext":"m4a","filesize":3000000},
            {"vcodec":"none","acodec":"opus","abr":70.0,"ext":"webm","filesize":1800000},
            {"vcodec":"avc1.640028","acodec":"none","height":1080,"fps":30,"ext":"mp4","filesize":40000000},
            {"vcodec":"vp09.00.40.08","acodec":"none","height":1080,"fps":30,"ext":"webm","filesize":35000000},
            {"vcodec":"avc1.4d401f","acodec":"none","height":720,"fps":30,"ext":"mp4","filesize":20000000},
            {"vcodec":"avc1.42001E","acodec":"mp4a.40.2","height":360,"fps":30,"ext":"mp4","filesize":9000000},
            {"vcodec":"av01.0.08M.08","acodec":"none","height":2160,"fps":60,"ext":"mp4"}
        ]
    }"#;

    #[test]
    fn one_offer_per_resolution_tallest_first() {
        let media = parse(LISTING).expect("parses");
        let heights: Vec<u32> = media.video.iter().map(|offer| offer.height).collect();
        assert_eq!(heights, vec![2160, 1080, 720, 360]);
        assert_eq!(media.title, "Un plan");
        assert_eq!(media.uploader.as_deref(), Some("Studio"));
    }

    #[test]
    fn a_separate_stream_is_sized_with_the_sound_it_needs() {
        let media = parse(LISTING).expect("parses");
        let hd = media.video.iter().find(|offer| offer.height == 1080).expect("1080");
        // 40 Mo of picture plus the best audio's 4 Mo — the file that lands.
        assert_eq!(hd.size, Some(44_000_000));
        assert!(!hd.muxed);

        let low = media.video.iter().find(|offer| offer.height == 360).expect("360");
        // Already carries sound: nothing to add, and nothing to merge.
        assert_eq!(low.size, Some(9_000_000));
        assert!(low.muxed);
    }

    #[test]
    fn a_rendition_without_a_size_still_appears() {
        let media = parse(LISTING).expect("parses");
        let uhd = media.video.iter().find(|offer| offer.height == 2160).expect("2160");
        assert_eq!(uhd.size, None);
        assert_eq!(uhd.codec, "av1");
        assert_eq!(uhd.fps, Some(60.0));
    }

    #[test]
    fn codecs_are_named_the_way_people_say_them() {
        let media = parse(LISTING).expect("parses");
        let hd = media.video.iter().find(|offer| offer.height == 1080).expect("1080");
        assert_eq!(hd.codec, "h264");
        assert_eq!(media.audio.first().map(|offer| offer.codec.as_str()), Some("opus"));
    }

    #[test]
    fn audio_is_one_row_per_codec_best_first() {
        let media = parse(LISTING).expect("parses");
        let codecs: Vec<&str> = media.audio.iter().map(|offer| offer.codec.as_str()).collect();
        // Two Opus streams collapse to one; the 160 kbit/s survives.
        assert_eq!(codecs, vec!["opus", "aac"]);
        assert_eq!(media.audio[0].bitrate, Some(160.0));
    }

    #[test]
    fn a_video_that_stops_at_720_offers_nothing_above_it() {
        let payload = r#"{"title":"Petit","formats":[
            {"vcodec":"avc1","acodec":"none","height":720,"ext":"mp4"},
            {"vcodec":"none","acodec":"mp4a","abr":128,"ext":"m4a"}
        ]}"#;
        let media = parse(payload).expect("parses");
        assert_eq!(media.video.len(), 1);
        assert_eq!(media.video[0].height, 720);
    }

    #[test]
    fn a_height_ceiling_falls_back_rather_than_failing() {
        let args = Selection::Video { height: Some(1080) }.arguments();
        let expression = args.join(" ");
        // `<=` throughout: a 720p-only video still downloads at 720p.
        assert!(expression.contains("height<=1080"));
        // And a last resort with no height at all, so nothing can come up empty.
        assert!(expression.ends_with("/b --merge-output-format mp4"));
    }

    #[test]
    fn each_audio_target_asks_for_what_it_says() {
        let args = |format| Selection::Audio { format }.arguments().join(" ");
        assert!(args(AudioTarget::Mp3).contains("--audio-format mp3 --audio-quality 0"));
        assert!(args(AudioTarget::Wav).contains("--audio-format wav"));
        assert!(args(AudioTarget::M4a).contains("--audio-format m4a"));
        // "best" is yt-dlp's word for remux-without-re-encoding.
        assert!(args(AudioTarget::Original).contains("--audio-format best"));
    }

    #[test]
    fn a_listing_with_no_formats_is_empty_rather_than_an_error() {
        let media = parse(r#"{"title":"Rien"}"#).expect("parses");
        assert!(media.video.is_empty() && media.audio.is_empty());
    }

    #[test]
    fn nonsense_is_an_error_not_a_panic() {
        assert!(parse("not json").is_err());
    }
}
