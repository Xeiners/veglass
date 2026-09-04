//! Fetching one video, with progress the interface can draw.
//!
//! yt-dlp is chatty by design, which is a problem when a queue needs numbers
//! rather than prose. `--progress-template` fixes that: the tool is told to
//! print exactly the fields wanted, on their own marked lines, and everything
//! else on stdout is context we can ignore. The parser therefore never has to
//! guess at a human-readable line, and a change to yt-dlp's default output
//! cannot break the progress bar.
//!
//! Two stages matter to someone watching. **Downloading** has a percentage and
//! a speed. **Converting** — merging video with audio, or extracting a sound
//! track — has neither, takes real time on a long file, and looks like a freeze
//! unless it is named. So the post-processing lines are watched for, and the
//! queue says "Conversion" instead of sitting at 100 %.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::error::{OnlineError, OnlineErrorKind, Result};
use super::formats::Selection;
use super::ytdlp;

/// Event the download queue listens on.
pub const DOWNLOAD_PROGRESS: &str = "veglass://download-progress";

/// Markers we ask yt-dlp to print, chosen not to occur in a title or a path.
const PROGRESS_MARK: &str = "@@VG-P@@";
const FILE_MARK: &str = "@@VG-F@@";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub id: String,
    /// `download` · `convert` — the two the user can tell apart.
    pub stage: String,
    pub received: u64,
    /// 0 while the server has not said, which is common early on.
    pub total: u64,
    /// 0 → 1, pre-computed so the bar never divides by zero.
    pub ratio: f64,
    /// Bytes per second, 0 when unknown.
    pub speed: f64,
    /// Seconds remaining, 0 when unknown.
    pub eta: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadReport {
    pub id: String,
    /// Absolute path of the finished file.
    pub path: String,
    pub name: String,
    pub bytes: u64,
}

/// The downloads in flight, so any of them can be stopped by id.
///
/// Several can run at once — a queue that only allows one would make fetching
/// three clips a sequence of waits — so the handle is per download rather than
/// the single slot the exporter uses.
#[derive(Default)]
pub struct DownloadControl {
    running: Mutex<HashMap<String, Child>>,
}

impl DownloadControl {
    fn register(&self, id: &str, child: Child) {
        if let Ok(mut map) = self.running.lock() {
            map.insert(id.to_string(), child);
        }
    }

    fn take(&self, id: &str) -> Option<Child> {
        self.running.lock().ok().and_then(|mut map| map.remove(id))
    }

    /// Kills one download. Returns whether there was one to kill.
    pub fn cancel(&self, id: &str) -> bool {
        let Ok(mut map) = self.running.lock() else { return false };
        match map.remove(id) {
            Some(mut child) => {
                let _ = child.kill();
                let _ = child.wait();
                true
            }
            None => false,
        }
    }
}

/// Where a project's fetched media lives.
///
/// Beside the projects rather than inside one file: a project is a single JSON
/// document, and the media it references have always been ordinary files on
/// disk addressed by absolute path. Giving each project its own folder keeps a
/// library tidy and makes the relinker's job easy when one moves.
fn media_dir(app: &AppHandle, project_id: &str) -> Result<PathBuf> {
    let safe = project_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>();
    if safe.is_empty() {
        return Err(OnlineError::io("identifiant de projet invalide"));
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| OnlineError::io(format!("dossier applicatif indisponible : {error}")))?
        .join("media")
        .join(safe);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// One `@@VG-P@@` line, as numbers.
///
/// yt-dlp writes `NA` for anything it does not know yet, which is most fields
/// on the first few lines; those become zero rather than an error.
fn parse_progress(line: &str) -> Option<(u64, u64, f64, f64)> {
    let payload = line.trim().strip_prefix(PROGRESS_MARK)?;
    let mut parts = payload.split('|');

    let number = |value: Option<&str>| -> f64 {
        value
            .map(str::trim)
            .filter(|text| *text != "NA" && !text.is_empty())
            .and_then(|text| text.parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value >= 0.0)
            .unwrap_or(0.0)
    };

    let received = number(parts.next()) as u64;
    let total = number(parts.next()) as u64;
    let speed = number(parts.next());
    let eta = number(parts.next());
    Some((received, total, speed, eta))
}

/// Whether a line means yt-dlp has stopped downloading and started converting.
fn is_conversion(line: &str) -> bool {
    const STAGES: [&str; 5] = [
        "[Merger]",
        "[ExtractAudio]",
        "[VideoConvertor]",
        "[FixupM3u8]",
        "[Metadata]",
    ];
    STAGES.iter().any(|stage| line.contains(stage))
}

/// The most recently written file in `dir`, ignoring anything older than the run.
///
/// The last resort when yt-dlp has not said where it put things. Leftovers from
/// an interrupted attempt are skipped by extension rather than by age: a `.part`
/// written a second ago is newer than the file we want and is not the file we
/// want.
fn newest_file_since(dir: &std::path::Path, since: SystemTime) -> Option<PathBuf> {
    // A second of slack: file timestamps have coarser resolution than the clock
    // on some filesystems, and a file written immediately can read as older.
    let floor = since
        .checked_sub(std::time::Duration::from_secs(1))
        .unwrap_or(since);

    let mut best: Option<(SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
            continue;
        }
        let extension = path
            .extension()
            .map(|value| value.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if matches!(extension.as_str(), "part" | "ytdl" | "temp") {
            continue;
        }

        let Ok(modified) = entry.metadata().and_then(|meta| meta.modified()) else {
            continue;
        };
        if modified < floor {
            continue;
        }
        if best.as_ref().map(|(seen, _)| modified >= *seen).unwrap_or(true) {
            best = Some((modified, path));
        }
    }
    best.map(|(_, path)| path)
}

pub struct Request {
    pub id: String,
    pub url: String,
    pub project_id: String,
    /// The title as shown in the browser, used only to name the finished file.
    pub title: String,
    /// What the picker settled on: a resolution ceiling, or an audio target.
    pub selection: Selection,
}

/// Windows refuses a path over 260 characters, and the API Python uses does
/// not opt into the long-path support Windows 10 added. Everything below
/// budgets against this rather than against a filename length alone, because a
/// short name in a deep folder fails just as a long one does.
const MAX_PATH: usize = 250;

/// A name short enough for the shortest limit, with nothing a filesystem hates.
const MIN_BUDGET: usize = 8;

/// Characters Windows refuses outright, plus the ones that make a shell wince.
fn sanitise(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if (c as u32) < 0x20 => ' ',
            c => c,
        })
        .collect();

    // Collapse the runs the substitution above just created, and drop the
    // trailing dots and spaces Windows silently strips (and then cannot find).
    cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|c: char| c == '.' || c.is_whitespace())
        .to_string()
}

/// The file name to move `path` to, or `None` to leave it alone.
///
/// Separated from the move itself so the budgeting is testable without a disk.
fn titled_name(path: &Path, title: &str) -> Option<String> {
    let parent = path.parent()?;
    let extension = path.extension().map(|e| e.to_string_lossy().to_string())?;

    let clean = sanitise(title);
    if clean.is_empty() {
        return None;
    }

    // The whole path has to fit, so the directory is charged first: a name that
    // fits in a shallow folder is what made this fail in a deep one.
    let spent = parent.to_string_lossy().chars().count() + 1 + 1 + extension.chars().count();
    let budget = MAX_PATH.saturating_sub(spent);
    if budget < MIN_BUDGET {
        return None;
    }

    // Truncated by characters, never by bytes: cutting a multi-byte character
    // in half is how a title with an accent becomes an invalid name.
    let stem: String = clean.chars().take(budget).collect();
    let stem = stem.trim_end().trim_end_matches('.').to_string();
    if stem.is_empty() {
        return None;
    }

    Some(format!("{stem}.{extension}"))
}

/// Renames a finished download to something readable, if that can be done.
///
/// Every failure here returns the original path. The file is already downloaded
/// and already usable; refusing it because a rename did not work would throw
/// away the whole transfer over cosmetics.
fn rename_to_title(path: &str, title: &str) -> String {
    let source = Path::new(path);
    let Some(name) = titled_name(source, title) else {
        return path.to_string();
    };

    let Some(parent) = source.parent() else {
        return path.to_string();
    };
    let target = parent.join(&name);

    if target == source {
        return path.to_string();
    }
    // Never clobber: a second download of the same video keeps both files
    // rather than silently replacing one the user may already have used.
    if target.exists() {
        return path.to_string();
    }

    match std::fs::rename(source, &target) {
        Ok(()) => target.to_string_lossy().to_string(),
        Err(_) => path.to_string(),
    }
}

/// Downloads `request.url` into the project's media folder.
///
/// Blocking from end to end; the caller runs it off the UI thread.
pub fn run(app: &AppHandle, control: &DownloadControl, request: Request) -> Result<DownloadReport> {
    let dir = media_dir(app, &request.project_id)?;
    // The title is kept out of the download path entirely.
    //
    // Bounding it with `--trim-filenames` was not enough, and could not be:
    // the length that matters on Windows is the whole path, the merge step
    // adds `.f137` style suffixes to whatever name it is given, and a title is
    // also where every character the filesystem refuses comes from. A video id
    // is eleven ASCII characters and has none of those problems.
    //
    // The readable name is put back by `rename_to_title` once the file exists,
    // where failing is harmless — a download that landed is not lost because
    // its name could not be prettified.
    let template = dir.join("%(id)s.%(ext)s");
    // Noted before the child starts, so the fallback below can tell this run's
    // output from everything already in the folder.
    let began = SystemTime::now();

    let mut command = ytdlp::command()?;
    command
        .arg("--newline")
        .arg("--no-playlist")
        .arg("--no-part")
        // Belt and braces: the template above is already id-only, but a
        // format's own extension still passes through here.
        .arg("--windows-filenames")
        .arg("--socket-timeout")
        .arg("20")
        // Retries are yt-dlp's own business and it does them better than a
        // wrapper could; three is enough to ride out a blip.
        .arg("--retries")
        .arg("3")
        .arg("--progress-template")
        .arg(format!(
            "download:{PROGRESS_MARK}%(progress.downloaded_bytes)s|\
             %(progress.total_bytes,progress.total_bytes_estimate)s|\
             %(progress.speed)s|%(progress.eta)s"
        ))
        // `--print` implies `--quiet`, which would swallow the progress lines
        // asked for just above. This puts them back.
        .arg("--progress")
        // Where the file landed. Asked for at *two* moments on purpose:
        // `after_move` only fires when there is something to move, and a single
        // already-muxed rendition fetched with `--no-part` is written straight
        // to its final name — no merge, no rename, no move, and nothing printed.
        // `after_video` fires either way.
        .arg("--print")
        .arg(format!("after_move:{FILE_MARK}%(filepath)s"))
        .arg("--print")
        .arg(format!("after_video:{FILE_MARK}%(filepath)s"))
        .arg("-o")
        .arg(&template);

    // The format expression and any conversion, decided by the picker — see
    // `formats::Selection`, which is also where the fallbacks live.
    command.args(request.selection.arguments());

    command.arg(&request.url).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| OnlineError::io(format!("yt-dlp n'a pas pu être lancé : {error}")))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| OnlineError::io("flux de sortie yt-dlp indisponible"))?;
    // Drained on its own thread for the same reason the other calls are: stdout
    // is read line by line below, but a chatty failure can fill the *error*
    // pipe, and a full pipe blocks the child exactly as surely.
    let stderr_reader = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            String::from_utf8_lossy(&bytes).into_owned()
        })
    });

    control.register(&request.id, child);

    let mut produced: Option<String> = None;
    let mut stage = "download";

    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };

        if let Some(path) = line.trim().strip_prefix(FILE_MARK) {
            produced = Some(path.trim().to_string());
            continue;
        }

        if let Some((received, total, speed, eta)) = parse_progress(&line) {
            let _ = app.emit(
                DOWNLOAD_PROGRESS,
                DownloadProgress {
                    id: request.id.clone(),
                    stage: stage.to_string(),
                    received,
                    total,
                    ratio: if total > 0 {
                        (received as f64 / total as f64).clamp(0.0, 1.0)
                    } else {
                        0.0
                    },
                    speed,
                    eta,
                },
            );
            continue;
        }

        if stage == "download" && is_conversion(&line) {
            stage = "convert";
            // Announced once, with a full bar: the bytes are in, and what is
            // left has no percentage to report.
            let _ = app.emit(
                DOWNLOAD_PROGRESS,
                DownloadProgress {
                    id: request.id.clone(),
                    stage: stage.to_string(),
                    received: 0,
                    total: 0,
                    ratio: 1.0,
                    speed: 0.0,
                    eta: 0.0,
                },
            );
        }
    }

    // Taken back out before waiting: `cancel` needs the handle right up to the
    // last moment, and holding the lock across the wait would block it.
    let Some(mut child) = control.take(&request.id) else {
        // Absent from the registry means `cancel` already removed and killed it.
        return Err(OnlineError::cancelled());
    };

    let status = child
        .wait()
        .map_err(|error| OnlineError::io(format!("yt-dlp interrompu : {error}")))?;

    if !status.success() {
        let message = stderr_reader
            .and_then(|reader| reader.join().ok())
            .unwrap_or_default();
        return Err(OnlineError::from_tool(&message));
    }

    // Two prints and, failing both, the folder itself. yt-dlp's own report is
    // always preferred — it knows the name exactly — but a run that finished
    // successfully has produced a file, and refusing to look for it would throw
    // away a download that worked.
    let path = match produced {
        Some(path) if std::path::Path::new(&path).is_file() => path,
        _ => newest_file_since(&dir, began)
            .map(|found| found.to_string_lossy().to_string())
            .ok_or_else(|| {
                OnlineError::new(
                    OnlineErrorKind::Format,
                    "Le téléchargement s'est terminé mais le fichier reste introuvable.",
                )
            })?,
    };

    // Now that the bytes are safely on disk, give the file a name a human can
    // read. Best effort by design: see `rename_to_title`.
    let path = rename_to_title(&path, &request.title);

    let metadata = std::fs::metadata(&path)?;
    let name = PathBuf::from(&path)
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "média".to_string());

    Ok(DownloadReport { id: request.id, path, name, bytes: metadata.len() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_characters_windows_refuses_are_removed() {
        assert_eq!(sanitise("A / B : C"), "A B C");
        assert_eq!(sanitise("Quoi ? *vraiment*"), "Quoi vraiment");
        assert_eq!(sanitise("a<b>c|d"), "a b c d");
        // Trailing dots and spaces are stripped by Windows itself, which then
        // cannot find the file it just wrote.
        assert_eq!(sanitise("Fin du titre. . ."), "Fin du titre");
        assert_eq!(sanitise("   "), "");
    }

    #[test]
    fn accents_survive_but_control_characters_do_not() {
        assert_eq!(sanitise("Éléphant à Noël"), "Éléphant à Noël");
        assert_eq!(sanitise("ligne
suivante"), "ligne suivante");
    }

    #[test]
    fn a_name_is_budgeted_against_the_whole_path() {
        let shallow = Path::new("C:/m/dQw4w9WgXcQ.mp4");
        let long_title = "mot ".repeat(120);

        let name = titled_name(shallow, &long_title).expect("a name");
        assert!(name.ends_with(".mp4"), "{name}");
        assert!("C:/m/".chars().count() + name.chars().count() <= MAX_PATH, "{name}");

        // The same title in a deep folder gets less room, which is the bug that
        // `--trim-filenames` could not see: it only knew about the file name.
        let deep_dir = format!("C:/Users/x/AppData/Roaming/app.veglass.editor/media/{}", "p".repeat(80));
        let deep = PathBuf::from(format!("{deep_dir}/dQw4w9WgXcQ.mp4"));
        let deep_name = titled_name(&deep, &long_title).expect("a name");
        assert!(deep_name.chars().count() < name.chars().count(), "{deep_name}");
        assert!(deep_dir.chars().count() + 1 + deep_name.chars().count() <= MAX_PATH);
    }

    #[test]
    fn a_folder_with_no_room_left_keeps_the_id() {
        let hopeless = PathBuf::from(format!("C:/{}/dQw4w9WgXcQ.mp4", "d".repeat(MAX_PATH)));
        assert_eq!(titled_name(&hopeless, "Un titre"), None);
    }

    #[test]
    fn a_title_that_sanitises_to_nothing_keeps_the_id() {
        let path = Path::new("C:/m/dQw4w9WgXcQ.mp4");
        assert_eq!(titled_name(path, "///"), None);
        assert_eq!(titled_name(path, "   "), None);
    }

    #[test]
    fn truncation_never_splits_a_character() {
        let deep = PathBuf::from(format!("C:/{}/dQw4w9WgXcQ.mp4", "d".repeat(200)));
        // Every character is multi-byte, so a byte-wise cut would be invalid.
        if let Some(name) = titled_name(&deep, &"é".repeat(200)) {
            assert!(name.chars().all(|c| c == 'é' || c == '.' || c.is_ascii_alphanumeric()), "{name}");
        }
    }

    #[test]
    fn the_extension_is_kept() {
        let name = titled_name(Path::new("C:/m/abc.webm"), "Un titre").expect("a name");
        assert_eq!(name, "Un titre.webm");
    }

    #[test]
    fn a_file_with_no_extension_is_left_alone() {
        assert_eq!(titled_name(Path::new("C:/m/abc"), "Un titre"), None);
    }

    #[test]
    fn a_progress_line_becomes_numbers() {
        let line = format!("{PROGRESS_MARK}1048576|10485760|524288.5|18");
        assert_eq!(parse_progress(&line), Some((1_048_576, 10_485_760, 524_288.5, 18.0)));
    }

    #[test]
    fn unknown_fields_read_as_zero_rather_than_failing() {
        let line = format!("{PROGRESS_MARK}2048|NA|NA|NA");
        assert_eq!(parse_progress(&line), Some((2048, 0, 0.0, 0.0)));
    }

    #[test]
    fn anything_else_on_stdout_is_not_progress() {
        assert!(parse_progress("[youtube] Extracting URL").is_none());
        assert!(parse_progress("[download] 12.3% of 4.00MiB").is_none());
        assert!(parse_progress("").is_none());
    }

    #[test]
    fn the_conversion_stage_is_recognised() {
        assert!(is_conversion(r#"[Merger] Merging formats into "clip.mp4""#));
        assert!(is_conversion("[ExtractAudio] Destination: son.mp3"));
        assert!(!is_conversion("[download] Destination: clip.f137.mp4"));
    }

    /// A scratch directory that removes itself with the test.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "veglass-dl-{name}-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|value| value.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(&dir).expect("scratch dir");
            Self(dir)
        }

        fn write(&self, name: &str, body: &str) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, body).expect("write");
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_fallback_finds_what_this_run_produced() {
        let scratch = Scratch::new("newest");
        scratch.write("ancien.mp4", "vieux");

        // Everything written from here counts as this run's output.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let began = SystemTime::now();
        std::thread::sleep(std::time::Duration::from_millis(50));
        let wanted = scratch.write("nouveau.mp4", "neuf");

        let found = newest_file_since(&scratch.0, began).expect("a file");
        assert_eq!(found, wanted);
    }

    #[test]
    fn the_fallback_ignores_leftovers_from_an_interrupted_attempt() {
        let scratch = Scratch::new("leftovers");
        let began = SystemTime::now();
        let wanted = scratch.write("bon.mp4", "neuf");
        // Written last, so newer — and still not the file anybody wants.
        std::thread::sleep(std::time::Duration::from_millis(20));
        scratch.write("bon.mp4.part", "moitié");
        scratch.write("bon.ytdl", "état");

        let found = newest_file_since(&scratch.0, began).expect("a file");
        assert_eq!(found, wanted);
    }

    #[test]
    fn the_fallback_finds_nothing_when_the_run_wrote_nothing() {
        let scratch = Scratch::new("empty");
        scratch.write("ancien.mp4", "vieux");
        std::thread::sleep(std::time::Duration::from_millis(1100));

        // Nothing written after this instant: the folder's contents predate it.
        assert!(newest_file_since(&scratch.0, SystemTime::now()).is_none());
    }

    #[test]
    fn a_title_containing_the_marker_is_still_not_progress() {
        // The markers are deliberately unlikely, but a line that merely
        // *contains* one must not be read as progress — only a line that
        // starts with it is.
        assert!(parse_progress(&format!("[download] {PROGRESS_MARK}1|2|3|4")).is_none());
    }
}
