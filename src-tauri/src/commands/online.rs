//! IPC surface of the online-media module.
//!
//! Every one of these drives a child process or waits on the network, so all of
//! them defer to the blocking pool — doing either on the main thread would
//! freeze the editor while a search runs.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::online::download::{self, DownloadControl, DownloadReport, Request};
use crate::online::error::{OnlineError, Result};
use crate::online::filters::SearchFilters;
use crate::online::formats::{self, MediaFormats, Selection};
use crate::online::search::{self, SearchPage};
use crate::online::ytdlp::{self, ToolStatus};

/// Wraps a blocking job so a panicking or cancelled task reads as an error
/// rather than a silent hang in the queue.
async fn offload<T, F>(job: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|error| OnlineError::io(format!("tâche interrompue : {error}")))?
}

/* ---------------- The tool ---------------- */

/// Whether yt-dlp is available, where, and which build.
#[tauri::command]
pub fn ytdlp_status() -> ToolStatus {
    ytdlp::status()
}

/// Fetches yt-dlp into the app's own directory, reporting progress as events.
#[tauri::command]
pub async fn install_ytdlp(app: AppHandle) -> Result<ToolStatus> {
    let cancel = Arc::new(AtomicBool::new(false));
    let handle = app.clone();
    offload(move || ytdlp::install(&handle, cancel)).await
}

/* ---------------- Browsing ---------------- */

/// Searches YouTube, or reads the video a pasted link points at.
///
/// One command for both because the panel has one field: deciding which the
/// user meant is `search`'s job, not the interface's.
///
/// `offset` is what makes the grid scroll: the caller says how much it already
/// has, and gets the next page rather than a longer version of the same list.
#[tauri::command]
pub async fn search_youtube(
    query: String,
    filters: Option<SearchFilters>,
    offset: Option<usize>,
) -> Result<SearchPage> {
    offload(move || {
        search::run(&query, &filters.unwrap_or_default(), offset.unwrap_or(0))
    })
    .await
}

/// What a video offers, so the picker shows the resolutions that exist.
#[tauri::command]
pub async fn get_media_formats(url: String) -> Result<MediaFormats> {
    offload(move || formats::inspect(&url)).await
}

/* ---------------- Fetching ---------------- */

/// Downloads one video into the project's media folder.
///
/// `id` is the caller's own handle on this download: progress events carry it,
/// and `cancel_download` takes it. The front-end therefore owns the queue and
/// this command owns one entry of it.
#[tauri::command]
pub async fn download_media(
    app: AppHandle,
    id: String,
    url: String,
    project_id: String,
    title: Option<String>,
    selection: Option<Selection>,
) -> Result<DownloadReport> {
    let control = app.state::<Arc<DownloadControl>>().inner().clone();
    let handle = app.clone();

    offload(move || {
        download::run(
            &handle,
            &control,
            Request {
                id,
                url,
                project_id,
                title: title.unwrap_or_default(),
                selection: selection.unwrap_or_default(),
            },
        )
    })
    .await
}

/// Stops one download. Returns whether there was one to stop.
#[tauri::command]
pub fn cancel_download(app: AppHandle, id: String) -> bool {
    app.state::<Arc<DownloadControl>>().cancel(&id)
}
