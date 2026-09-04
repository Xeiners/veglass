//! Search filters, encoded the way YouTube expects them.
//!
//! A filtered search is an ordinary results URL carrying an `sp` parameter, and
//! that parameter is a **base64 protobuf** — not an opaque token to be looked up
//! in a table. Tables of pre-baked tokens are how most tools do this, and they
//! break the moment two filters have to be combined, because the table only ever
//! holds the combinations someone thought to paste into it.
//!
//! Building the message properly is forty lines and composes by construction:
//! duration, type, sort order and licence can be set together, in any mix, and
//! the encoder produces exactly the token YouTube's own interface would.
//!
//! The field numbers below are verified against the tokens YouTube itself emits;
//! the tests at the bottom pin each one to a URL anybody can check.

use base64::Engine as _;
use serde::{Deserialize, Serialize};

/// What kind of result to keep.
///
/// Deliberately short: these are the types YouTube's filter actually has. There
/// is **no music filter** in this API — sound is a property of what you download,
/// not of what you search — so the panel offers a licence filter instead, which
/// is the one that genuinely helps someone sourcing material.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResultKind {
    #[default]
    Any,
    Video,
    Playlist,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Duration {
    #[default]
    Any,
    /// Under four minutes.
    Short,
    /// Four to twenty minutes.
    Medium,
    /// Over twenty minutes.
    Long,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Sort {
    #[default]
    Relevance,
    /// Newest first.
    Date,
    Views,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilters {
    #[serde(default)]
    pub kind: ResultKind,
    #[serde(default)]
    pub duration: Duration,
    #[serde(default)]
    pub sort: Sort,
    /// Only material published under a Creative Commons licence.
    #[serde(default)]
    pub creative_commons: bool,
}

impl SearchFilters {
    pub fn is_default(&self) -> bool {
        self.kind == ResultKind::Any
            && self.duration == Duration::Any
            && self.sort == Sort::Relevance
            && !self.creative_commons
    }
}

/* ------------------------------------------------------------------ *
 * Protobuf, by hand
 * ------------------------------------------------------------------ */

fn varint(value: u64, out: &mut Vec<u8>) {
    let mut left = value;
    loop {
        let byte = (left & 0x7f) as u8;
        left >>= 7;
        if left == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// `(field number << 3) | wire type` — wire 0 is varint, 2 is length-delimited.
fn tag(number: u64, wire: u64, out: &mut Vec<u8>) {
    varint((number << 3) | wire, out);
}

fn put_varint_field(number: u64, value: u64, out: &mut Vec<u8>) {
    tag(number, 0, out);
    varint(value, out);
}

/// The `sp` token for these filters, or `None` when nothing is filtered.
///
/// Percent-encoded on the way out: base64 uses `+`, `/` and `=`, all of which
/// mean something else in a query string.
pub fn sp_token(filters: &SearchFilters) -> Option<String> {
    if filters.is_default() {
        return None;
    }

    let mut message = Vec::new();

    // Field 1 — sort order. Relevance is 0 and therefore never written: a
    // protobuf omits its defaults, and so does YouTube's own token.
    let sort = match filters.sort {
        Sort::Relevance => 0,
        // Not a typo, and not alphabetical: 1 is "rating", which the panel does
        // not offer. Date is 2 and view count is 3.
        Sort::Date => 2,
        Sort::Views => 3,
    };
    if sort != 0 {
        put_varint_field(1, sort, &mut message);
    }

    // Field 2 — the filter sub-message, itself length-delimited.
    let mut inner = Vec::new();

    match filters.kind {
        ResultKind::Any => {}
        ResultKind::Video => put_varint_field(2, 1, &mut inner),
        ResultKind::Playlist => put_varint_field(2, 3, &mut inner),
    }

    // Field 3 — duration. The values are *not* in length order: short is 1,
    // long is 2 and medium is 3, because medium was added after the other two.
    match filters.duration {
        Duration::Any => {}
        Duration::Short => put_varint_field(3, 1, &mut inner),
        Duration::Long => put_varint_field(3, 2, &mut inner),
        Duration::Medium => put_varint_field(3, 3, &mut inner),
    }

    // Field 6 — Creative Commons, one of the boolean "features".
    if filters.creative_commons {
        put_varint_field(6, 1, &mut inner);
    }

    if !inner.is_empty() {
        tag(2, 2, &mut message);
        varint(inner.len() as u64, &mut message);
        message.extend_from_slice(&inner);
    }

    if message.is_empty() {
        return None;
    }

    let token = base64::engine::general_purpose::STANDARD.encode(&message);
    Some(percent_encode(&token))
}

/// Enough of one to be safe in a query string; the alphabet is known and small.
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 8);
    for character in value.chars() {
        match character {
            '+' => out.push_str("%2B"),
            '/' => out.push_str("%2F"),
            '=' => out.push_str("%3D"),
            other => out.push(other),
        }
    }
    out
}

/// Percent-encodes a search phrase for the `search_query` parameter.
pub fn encode_query(query: &str) -> String {
    let mut out = String::with_capacity(query.len() * 2);
    for byte in query.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// The address a filtered search runs against.
///
/// yt-dlp reads a results page as a playlist, so a filtered search is the same
/// call as an unfiltered one with a different subject — which is what keeps
/// pagination, parsing and error handling identical for both.
pub fn search_url(query: &str, filters: &SearchFilters) -> String {
    let mut url = format!(
        "https://www.youtube.com/results?search_query={}",
        encode_query(query)
    );
    if let Some(token) = sp_token(filters) {
        url.push_str("&sp=");
        url.push_str(&token);
    }
    url
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each of these is a token YouTube's own interface produces; they are the
    /// reason to build the message rather than guess at it.
    fn token(filters: SearchFilters) -> Option<String> {
        sp_token(&filters)
    }

    #[test]
    fn no_filter_means_no_token() {
        assert_eq!(token(SearchFilters::default()), None);
    }

    #[test]
    fn each_duration_matches_youtubes_own_token() {
        let with = |duration| SearchFilters { duration, ..Default::default() };
        assert_eq!(token(with(Duration::Short)).as_deref(), Some("EgIYAQ%3D%3D"));
        assert_eq!(token(with(Duration::Long)).as_deref(), Some("EgIYAg%3D%3D"));
        assert_eq!(token(with(Duration::Medium)).as_deref(), Some("EgIYAw%3D%3D"));
    }

    #[test]
    fn type_and_licence_match_too() {
        let video = SearchFilters { kind: ResultKind::Video, ..Default::default() };
        assert_eq!(token(video).as_deref(), Some("EgIQAQ%3D%3D"));

        let cc = SearchFilters { creative_commons: true, ..Default::default() };
        assert_eq!(token(cc).as_deref(), Some("EgIwAQ%3D%3D"));
    }

    #[test]
    fn sort_orders_match() {
        let by = |sort| SearchFilters { sort, ..Default::default() };
        assert_eq!(token(by(Sort::Date)).as_deref(), Some("CAI%3D"));
        assert_eq!(token(by(Sort::Views)).as_deref(), Some("CAM%3D"));
        // Relevance is the default and writes nothing at all.
        assert_eq!(token(by(Sort::Relevance)), None);
    }

    #[test]
    fn filters_combine_where_a_token_table_could_not() {
        // Sort by views, videos only, over twenty minutes: three fields in one
        // message, which is the case a lookup table never has an entry for.
        let combined = SearchFilters {
            kind: ResultKind::Video,
            duration: Duration::Long,
            sort: Sort::Views,
            creative_commons: false,
        };
        let encoded = token(combined).expect("a token");
        let raw = base64::engine::general_purpose::STANDARD
            .decode(encoded.replace("%3D", "=").replace("%2B", "+").replace("%2F", "/"))
            .expect("valid base64");

        // 08 03 — sortBy = 3 (views); 12 04 — filters, four bytes;
        // 10 01 — type = video; 18 02 — duration = long.
        assert_eq!(raw, vec![0x08, 0x03, 0x12, 0x04, 0x10, 0x01, 0x18, 0x02]);
    }

    #[test]
    fn a_query_survives_the_url() {
        assert_eq!(encode_query("musique libre"), "musique+libre");
        assert_eq!(encode_query("café & thé"), "caf%C3%A9+%26+th%C3%A9");
    }

    #[test]
    fn the_url_carries_both_halves() {
        let url = search_url(
            "plan de coupe",
            &SearchFilters { duration: Duration::Short, ..Default::default() },
        );
        assert!(url.contains("search_query=plan+de+coupe"));
        assert!(url.ends_with("&sp=EgIYAQ%3D%3D"));

        let plain = search_url("plan", &SearchFilters::default());
        assert!(!plain.contains("&sp="));
    }
}
