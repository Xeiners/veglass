//! Searching, and reading what a link points at.
//!
//! Both are the same yt-dlp call with a different subject: `ytsearch20:chats`
//! and `https://…/watch?v=…` both come back as a playlist envelope, so one
//! parser serves both and the panel does not care which the user typed.
//!
//! `--flat-playlist` is what makes this fast enough to feel like a search box.
//! Without it yt-dlp resolves every result in turn — twenty page loads for a
//! list the user is only going to glance at.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::error::{OnlineError, OnlineErrorKind, Result};
use super::filters::{self, SearchFilters};
use super::ytdlp;

/// Results per page. Enough to fill the grid twice over on a wide window.
pub const PAGE: usize = 24;
/// Ceiling on how deep the scroll may go. YouTube stops giving useful results
/// well before this, and an unbounded loop would let one search crawl for ever.
const MAX_DEPTH: usize = 300;
/// Longer than this and the panel is better off saying so than spinning.
const TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    /// A watch URL, ready to hand back to `download`.
    pub url: String,
    /// Seconds. `None` for a live stream, which has no length yet.
    pub duration: Option<f64>,
    pub uploader: Option<String>,
    pub thumbnail: Option<String>,
    pub views: Option<u64>,
    /// A stream in progress: it has no end, so downloading it is refused.
    pub live: bool,
}

/// Whether the box contains an address rather than words to search for.
///
/// Deliberately loose: yt-dlp accepts far more than YouTube, and deciding for
/// it which hosts are real would only get in the way. Anything that looks like
/// a URL is passed straight through, and yt-dlp says if it cannot read it.
pub fn looks_like_url(query: &str) -> bool {
    let trimmed = query.trim();
    trimmed.starts_with("http://") || trimmed.starts_with("https://") || trimmed.starts_with("www.")
}

/// The thumbnail worth showing in a grid.
///
/// yt-dlp lists every size a site publishes, smallest first. The widest one
/// under the ceiling is the sharpest that will not cost a megabyte per tile.
fn best_thumbnail(entry: &Value) -> Option<String> {
    const MAX_WIDTH: u64 = 800;

    if let Some(list) = entry.get("thumbnails").and_then(Value::as_array) {
        let mut best: Option<(u64, &str)> = None;
        for item in list {
            let Some(url) = item.get("url").and_then(Value::as_str) else { continue };
            let width = item.get("width").and_then(Value::as_u64).unwrap_or(0);
            if width > MAX_WIDTH {
                continue;
            }
            if best.map(|(current, _)| width >= current).unwrap_or(true) {
                best = Some((width, url));
            }
        }
        if let Some((_, url)) = best {
            return Some(url.to_string());
        }
        // Every candidate was oversized: take the first rather than nothing.
        if let Some(url) = list.first().and_then(|item| item.get("url")).and_then(Value::as_str) {
            return Some(url.to_string());
        }
    }

    entry.get("thumbnail").and_then(Value::as_str).map(str::to_string)
}

fn watch_url(entry: &Value) -> Option<String> {
    // A flat playlist gives `url` directly; a resolved video gives `webpage_url`.
    for key in ["webpage_url", "url", "original_url"] {
        if let Some(value) = entry.get(key).and_then(Value::as_str) {
            if value.starts_with("http") {
                return Some(value.to_string());
            }
        }
    }
    // Bare ids appear in some flat listings; YouTube's watch URL rebuilds them.
    entry
        .get("id")
        .and_then(Value::as_str)
        .map(|id| format!("https://www.youtube.com/watch?v={id}"))
}

fn read_entry(entry: &Value) -> Option<SearchResult> {
    let title = entry.get("title").and_then(Value::as_str)?.trim().to_string();
    if title.is_empty() || title == "[Private video]" || title == "[Deleted video]" {
        return None;
    }

    let live = matches!(
        entry.get("live_status").and_then(Value::as_str),
        Some("is_live") | Some("is_upcoming")
    );

    Some(SearchResult {
        id: entry
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or(&title)
            .to_string(),
        url: watch_url(entry)?,
        duration: entry
            .get("duration")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0),
        uploader: ["channel", "uploader", "playlist_uploader"]
            .iter()
            .find_map(|key| entry.get(*key).and_then(Value::as_str))
            .map(str::to_string),
        thumbnail: best_thumbnail(entry),
        views: entry.get("view_count").and_then(Value::as_u64),
        live,
        title,
    })
}

/// Reads the playlist envelope yt-dlp returns, whatever was asked of it.
pub fn parse(payload: &str) -> Vec<SearchResult> {
    let Ok(root) = serde_json::from_str::<Value>(payload) else {
        return Vec::new();
    };

    match root.get("entries").and_then(Value::as_array) {
        Some(entries) => entries.iter().filter_map(read_entry).collect(),
        // A single video comes back as the object itself, with no envelope.
        None => read_entry(&root).into_iter().collect(),
    }
}

/// One page of results.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub results: Vec<SearchResult>,
    /// Where the next page starts.
    pub next_offset: usize,
    /// Whether asking again could return anything more.
    pub more: bool,
}

/// Searches YouTube, or reads the video a link points at.
///
/// `offset` is how many results have already been shown, which is what turns a
/// grid into a scroll. yt-dlp is asked for the slice rather than the whole run:
/// it still crawls from the top, but only the new rows cross the bridge, and
/// the front-end never has to reconcile a list it already had.
pub fn run(query: &str, filters: &SearchFilters, offset: usize) -> Result<SearchPage> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(SearchPage { results: Vec::new(), next_offset: 0, more: false });
    }

    let wanted = (offset + PAGE).min(MAX_DEPTH);
    if offset >= MAX_DEPTH {
        return Ok(SearchPage { results: Vec::new(), next_offset: offset, more: false });
    }

    let subject = if looks_like_url(query) {
        // A pasted link is one video; filters and paging have nothing to do.
        query.to_string()
    } else if filters.is_default() {
        // `ytsearch` is yt-dlp's own pseudo-URL: no API key, no quota.
        format!("ytsearch{wanted}:{query}")
    } else {
        // Filters live in the `sp` parameter of an ordinary results page, and
        // yt-dlp reads that page as a playlist — so the call is the same shape.
        filters::search_url(query, filters)
    };

    let mut command = ytdlp::command()?;
    command
        .arg("--dump-single-json")
        .arg("--flat-playlist")
        .arg("--socket-timeout")
        .arg("15");

    if !looks_like_url(query) {
        // 1-based and inclusive, which is why the start is `offset + 1`.
        command
            .arg("--playlist-items")
            .arg(format!("{}-{}", offset + 1, wanted));
    }

    command.arg(&subject);

    // Both pipes are drained while we wait — see `ytdlp::run_capturing` for why
    // the obvious version of this deadlocks on a large answer.
    let captured = ytdlp::run_capturing(
        &mut command,
        TIMEOUT,
        "La recherche n'a pas répondu. Vérifiez la connexion, puis réessayez.",
    )?;

    if !captured.success {
        return Err(OnlineError::from_tool(&captured.stderr));
    }

    let payload = captured.stdout;
    let results = parse(&payload);

    if results.is_empty() && !payload.trim().is_empty() && offset == 0 {
        return Err(OnlineError::new(
            OnlineErrorKind::Format,
            "Réponse de yt-dlp illisible.",
        ));
    }

    // A short page is the end of the road; a full one probably is not.
    let next_offset = offset + results.len();
    Ok(SearchPage {
        more: results.len() >= PAGE && next_offset < MAX_DEPTH && !looks_like_url(query),
        next_offset,
        results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_and_addresses_are_told_apart() {
        assert!(looks_like_url("https://www.youtube.com/watch?v=abc"));
        assert!(looks_like_url("  www.youtube.com/watch?v=abc "));
        assert!(!looks_like_url("musique libre de droits"));
        assert!(!looks_like_url("comment faire un fondu"));
    }

    #[test]
    fn a_search_envelope_becomes_results() {
        let payload = r#"{"entries":[
            {"id":"aaa","title":"Premier","url":"https://youtu.be/aaa","duration":93.5,
             "channel":"Studio","view_count":1200,
             "thumbnails":[{"url":"s.jpg","width":120},{"url":"m.jpg","width":640},{"url":"xl.jpg","width":1920}]},
            {"id":"bbb","title":"Second","duration":null,"live_status":"is_live"}
        ]}"#;
        let results = parse(payload);
        assert_eq!(results.len(), 2);

        let first = &results[0];
        assert_eq!(first.title, "Premier");
        assert_eq!(first.duration, Some(93.5));
        assert_eq!(first.uploader.as_deref(), Some("Studio"));
        // The widest under the ceiling, not the widest published.
        assert_eq!(first.thumbnail.as_deref(), Some("m.jpg"));
        assert!(!first.live);

        let second = &results[1];
        assert!(second.live);
        assert_eq!(second.duration, None);
        // No URL in the entry: rebuilt from the id.
        assert!(second.url.contains("bbb"));
    }

    #[test]
    fn a_single_video_needs_no_envelope() {
        let payload = r#"{"id":"zzz","title":"Seule","webpage_url":"https://youtu.be/zzz"}"#;
        let results = parse(payload);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://youtu.be/zzz");
    }

    #[test]
    fn unusable_entries_are_dropped_rather_than_shown() {
        let payload = r#"{"entries":[
            {"id":"a","title":"[Private video]"},
            {"id":"b"},
            {"id":"c","title":"Bonne"}
        ]}"#;
        let results = parse(payload);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Bonne");
    }

    #[test]
    fn nonsense_yields_nothing_rather_than_panicking() {
        assert!(parse("not json").is_empty());
        assert!(parse("{}").is_empty());
    }
}
