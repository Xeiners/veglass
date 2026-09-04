//! Fetching ffmpeg when the machine hasn't got one.
//!
//! "Install ffmpeg and put it on your PATH" is a strange thing to ask of
//! someone who only wants to export a clip, and it is the one step between a
//! finished edit and a file. So the app fetches a static build itself, into its
//! own data directory, and [`super::ffmpeg::locate_binary`] looks there.
//!
//! Nothing is installed system-wide and nothing is put on the PATH: the copy
//! belongs to Veglass, and deleting the app's data directory removes it.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{Error, Result};

/// Event the setup dialog listens on.
pub const INSTALL_PROGRESS: &str = "veglass://ffmpeg-install";

/// Emitted often enough to animate, rarely enough not to flood the bridge.
const EMIT_INTERVAL: Duration = Duration::from_millis(120);

/// Where a build fetched by the app lives. Set once, at startup.
static INSTALL_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn remember_install_dir(dir: PathBuf) {
    let _ = INSTALL_DIR.set(dir);
}

pub fn install_dir() -> Option<&'static PathBuf> {
    INSTALL_DIR.get()
}

/// One archive to fetch, and the binaries wanted out of it.
struct Archive {
    url: &'static str,
    wanted: &'static [&'static str],
}

/// The build for this platform, or `None` where we won't guess.
///
/// Linux is deliberately absent: every distribution ships ffmpeg in its own
/// package manager, that copy is the one the system expects, and downloading a
/// second one behind the user's back would be the wrong answer.
fn archives() -> Option<&'static [Archive]> {
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        static WINDOWS: &[Archive] = &[Archive {
            url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
            wanted: &["ffmpeg.exe", "ffprobe.exe"],
        }];
        return Some(WINDOWS);
    }

    #[cfg(target_os = "macos")]
    {
        // evermeet.cx publishes each tool as its own zip holding one binary.
        static MACOS: &[Archive] = &[
            Archive {
                url: "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip",
                wanted: &["ffmpeg"],
            },
            Archive {
                url: "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip",
                wanted: &["ffprobe"],
            },
        ];
        return Some(MACOS);
    }

    #[allow(unreachable_code)]
    None
}

/// Whether this platform can install ffmpeg from inside the app.
pub fn supported() -> bool {
    archives().is_some()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    /// `download`, `extract` or `verify`.
    pub stage: String,
    pub received: u64,
    /// 0 when the server declines to say.
    pub total: u64,
    /// 0 → 1 across the whole install, not just the current file.
    pub ratio: f64,
    pub detail: String,
}

fn emit(app: &AppHandle, progress: InstallProgress) {
    let _ = app.emit(INSTALL_PROGRESS, progress);
}

/// Takes a copy of an ffmpeg the user already has.
///
/// The escape hatch for every network this application cannot get out of —
/// a proxy it cannot see, a DNS that intermittently fails, a machine with no
/// route at all. Downloading is the convenience; this is the guarantee.
///
/// The binary is *copied* into the app's own directory rather than merely
/// remembered, so it survives the source being moved or deleted, and so
/// `locate_binary` finds it by the same rule as a downloaded one. `ffprobe`
/// beside it comes along, because the engine needs both.
pub fn adopt(source: &Path) -> Result<()> {
    if !source.is_file() {
        return Err(Error::Install(format!(
            "{} n'est pas un fichier.",
            source.display()
        )));
    }

    // Run it before trusting it: a renamed archive, or a wrapper script, would
    // otherwise be copied in and fail later during an export.
    let works = crate::proc::command(source)
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map(|out| out.status.success() && out.stdout.starts_with(b"ffmpeg version"))
        .unwrap_or(false);
    if !works {
        return Err(Error::Install(
            "Ce fichier ne répond pas comme ffmpeg. Choisissez le binaire ffmpeg lui-même              (ffmpeg.exe sous Windows), pas une archive ni un raccourci."
                .into(),
        ));
    }

    let dir = install_dir()
        .cloned()
        .ok_or_else(|| Error::Install("dossier d'installation inconnu".into()))?;
    fs::create_dir_all(&dir)?;

    let target = dir.join(crate::engine::ffmpeg::exe("ffmpeg"));
    if source != target {
        fs::copy(source, &target)?;
    }

    // ffprobe is optional: the engine degrades without it rather than failing,
    // so a missing sibling is not worth refusing the ffmpeg the user chose.
    if let Some(parent) = source.parent() {
        let probe = parent.join(crate::engine::ffmpeg::exe("ffprobe"));
        if probe.is_file() {
            let _ = fs::copy(&probe, dir.join(crate::engine::ffmpeg::exe("ffprobe")));
        }
    }

    Ok(())
}

/// A binary archive is tens of megabytes on a link that may be slow; this is a
/// ceiling on silence, not on the transfer.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

/// Downloads `url` to `target`, reporting progress as a slice of the whole job.
fn download(
    app: &AppHandle,
    url: &str,
    target: &Path,
    cancel: &Arc<AtomicBool>,
    slice: (f64, f64),
) -> Result<()> {
    // Through the shared agent: system proxy honoured, IPv4 tried first. A bare
    // `ureq::get` here connected direct and failed on exactly the networks the
    // Gemini client had already been taught to handle.
    let response = crate::net::fetch(url, DOWNLOAD_TIMEOUT, || cancel.load(Ordering::Relaxed))
        .map_err(|error| Error::Install(crate::net::download_advice("ffmpeg", url, &error)))?;

    let total = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);

    let mut reader = response.into_reader();
    let mut file = File::create(target)?;
    let mut buffer = vec![0u8; 256 * 1024];
    let mut received: u64 = 0;
    let mut last = Instant::now() - EMIT_INTERVAL;

    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = fs::remove_file(target);
            return Err(Error::Install("installation annulée".into()));
        }

        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buffer[..read])?;
        received += read as u64;

        if last.elapsed() >= EMIT_INTERVAL {
            last = Instant::now();
            // Unknown length still animates: without a total, report the slice's
            // own start rather than pretending to a percentage.
            let within = if total > 0 {
                received as f64 / total as f64
            } else {
                0.0
            };
            emit(
                app,
                InstallProgress {
                    stage: "download".into(),
                    received,
                    total,
                    ratio: slice.0 + within * (slice.1 - slice.0),
                    detail: String::new(),
                },
            );
        }
    }

    Ok(())
}

/// Pulls the wanted binaries out of a zip, flattening whatever tree it uses.
fn extract(archive_path: &Path, wanted: &[&str], dir: &Path) -> Result<Vec<PathBuf>> {
    let file = File::open(archive_path)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|error| Error::Install(format!("archive illisible : {error}")))?;

    let mut written = Vec::new();
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|error| Error::Install(format!("archive illisible : {error}")))?;
        if entry.is_dir() {
            continue;
        }

        // Builds nest their binaries differently; the leaf name is what matters.
        let name = entry
            .name()
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default()
            .to_string();
        if !wanted.contains(&name.as_str()) {
            continue;
        }

        let target = dir.join(&name);
        let mut out = File::create(&target)?;
        std::io::copy(&mut entry, &mut out)?;
        drop(out);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&target, fs::Permissions::from_mode(0o755))?;
        }

        written.push(target);
    }

    Ok(written)
}

/// Fetches ffmpeg (and ffprobe) into the app's own directory.
///
/// Blocking from end to end — the caller runs it off the UI thread.
pub fn run(app: &AppHandle, cancel: Arc<AtomicBool>) -> Result<super::EncoderStatus> {
    let sources = archives().ok_or_else(|| {
        Error::Install(
            "installation automatique indisponible sur cette plateforme — \
             utilisez le gestionnaire de paquets de votre distribution"
                .into(),
        )
    })?;

    let dir = install_dir()
        .cloned()
        .ok_or_else(|| Error::Install("dossier d'installation inconnu".into()))?;
    fs::create_dir_all(&dir)?;

    // Downloading dominates; extraction is the last tenth.
    let share = 0.9 / sources.len() as f64;

    for (index, source) in sources.iter().enumerate() {
        let slice = (index as f64 * share, (index as f64 + 1.0) * share);
        let temp = dir.join(format!("download-{index}.part"));

        download(app, source.url, &temp, &cancel, slice)?;

        emit(
            app,
            InstallProgress {
                stage: "extract".into(),
                received: 0,
                total: 0,
                ratio: slice.1,
                detail: source.wanted.join(", "),
            },
        );

        let written = extract(&temp, source.wanted, &dir)?;
        let _ = fs::remove_file(&temp);

        if written.len() < source.wanted.len() {
            return Err(Error::Install(format!(
                "binaire absent de l'archive ({} attendu(s), {} trouvé(s))",
                source.wanted.len(),
                written.len()
            )));
        }
    }

    emit(
        app,
        InstallProgress {
            stage: "verify".into(),
            received: 0,
            total: 0,
            ratio: 0.97,
            detail: String::new(),
        },
    );

    // The only proof that counts: the binary runs and answers.
    let status = super::encoder_status();
    if !status.available {
        return Err(Error::Install(
            "ffmpeg a été téléchargé mais refuse de démarrer".into(),
        ));
    }

    emit(
        app,
        InstallProgress {
            stage: "done".into(),
            received: 0,
            total: 0,
            ratio: 1.0,
            detail: status.version.clone().unwrap_or_default(),
        },
    );

    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_archive_asks_for_something() {
        if let Some(list) = archives() {
            assert!(!list.is_empty());
            for archive in list {
                assert!(archive.url.starts_with("https://"), "downloads must be TLS");
                assert!(!archive.wanted.is_empty());
            }
        }
    }

    #[test]
    fn windows_fetches_both_tools() {
        if cfg!(all(windows, target_arch = "x86_64")) {
            let wanted: Vec<&str> = archives()
                .unwrap()
                .iter()
                .flat_map(|archive| archive.wanted.iter().copied())
                .collect();
            assert!(wanted.contains(&"ffmpeg.exe"));
            // Duration probing is a separate concern from encoding, but the
            // export dialog reports on it, so it has to arrive too.
            assert!(wanted.contains(&"ffprobe.exe"));
        }
    }

    /// The published builds nest their binaries; matching on the leaf name is
    /// what makes the extractor independent of the layout each one chooses.
    #[test]
    fn extracts_wanted_binaries_from_any_nesting() {
        use std::io::Write as _;

        let dir = std::env::temp_dir().join("veglass-extract-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let archive_path = dir.join("build.zip");
        {
            let file = File::create(&archive_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();

            zip.add_directory("ffmpeg-build/bin/", options).unwrap();
            zip.start_file("ffmpeg-build/bin/ffmpeg.exe", options).unwrap();
            zip.write_all(b"binary").unwrap();
            zip.start_file("ffmpeg-build/bin/ffprobe.exe", options).unwrap();
            zip.write_all(b"binary").unwrap();
            // Everything else in the archive has to be ignored.
            zip.start_file("ffmpeg-build/README.txt", options).unwrap();
            zip.write_all(b"docs").unwrap();
            zip.finish().unwrap();
        }

        let written = extract(&archive_path, &["ffmpeg.exe", "ffprobe.exe"], &dir).unwrap();

        assert_eq!(written.len(), 2);
        assert!(dir.join("ffmpeg.exe").is_file());
        assert!(dir.join("ffprobe.exe").is_file());
        // Flattened out of its directory, not recreated under one.
        assert!(!dir.join("ffmpeg-build").exists());
        assert!(!dir.join("README.txt").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_dir_is_remembered_once() {
        remember_install_dir(PathBuf::from("/tmp/veglass-test-bin"));
        assert!(install_dir().is_some());
    }
}
