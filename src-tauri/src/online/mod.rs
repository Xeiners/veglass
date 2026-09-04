//! Online media: searching, and fetching a file to edit with.
//!
//! The webview cannot show a video site — the embeds refuse to run inside an
//! application frame — so the app does not try. It talks to `yt-dlp` instead
//! and renders the results itself, which is both faster to browse and the only
//! version of this that can hand the timeline a real file at the end.
//!
//! Three concerns, kept apart:
//!
//! * [`ytdlp`] finds the binary, and fetches one when the machine has none —
//!   the same bargain the app already makes for ffmpeg;
//! * [`search`] turns a query or a link into a list the grid can draw;
//! * [`download`] fetches one video, reports progress, and says where the file
//!   landed. Everything after that is the ordinary import path: a downloaded
//!   file is a file, and the editor has never known where its media came from.
//!
//! A word on what this module does *not* decide. Fetching from a video platform
//! is subject to that platform's terms, and to the rights on the material. The
//! app takes no position on a given download and keeps no catalogue; the panel
//! says as much, once, where it cannot be missed.

pub mod download;
pub mod error;
pub mod filters;
pub mod formats;
pub mod search;
pub mod ytdlp;

pub use download::{DownloadControl, DownloadProgress, DownloadReport};
pub use error::{OnlineError, OnlineErrorKind};
pub use filters::SearchFilters;
pub use formats::MediaFormats;
pub use search::{SearchPage, SearchResult};
pub use ytdlp::ToolStatus;
