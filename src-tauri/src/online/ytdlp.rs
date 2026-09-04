//! Finding — and, when asked, fetching — yt-dlp.
//!
//! The same bargain as ffmpeg: "install yt-dlp and put it on your PATH" is a
//! strange thing to ask of someone who only wants a piece of reference footage,
//! so the app fetches its own copy into its own data directory. Nothing goes
//! system-wide and nothing joins the PATH; deleting the app's data removes it.
//!
//! Two things differ from the ffmpeg installer, both on purpose:
//!
//! * **Linux is included.** ffmpeg is packaged well by every distribution and
//!   the system copy is the one to use; yt-dlp is the opposite case — it breaks
//!   whenever a site changes and distribution packages lag by months, so the
//!   standalone build the project itself publishes is the right one to run.
//! * **There is no archive.** Each platform's build is a single executable, so
//!   the whole install is a download and a `chmod`.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::error::{OnlineError, OnlineErrorKind, Result};

/// Event the setup panel listens on while the binary is being fetched.
pub const INSTALL_PROGRESS: &str = "veglass://ytdlp-install";

/// Often enough to animate, rarely enough not to flood the bridge.
const EMIT_INTERVAL: Duration = Duration::from_millis(120);

/// Override for anyone who keeps their own copy.
const ENV_OVERRIDE: &str = "VEGLASS_YTDLP";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub available: bool,
    /// Whether this platform has a build the app is willing to fetch.
    pub installable: bool,
    pub path: Option<String>,
    /// yt-dlp's own version string — a date, which is the useful part: a build
    /// more than a few months old will have stopped working on some sites.
    pub version: Option<String>,
    /// Days since that date, when it can be read.
    pub age_days: Option<i64>,
    /// Whether the copy in use is the one Veglass installed.
    ///
    /// `locate` prefers an override, a sibling of the executable, or the PATH
    /// over the managed copy, and `install` only ever writes the managed one.
    /// Offering to update a binary we would not actually replace is worse than
    /// saying whose it is, so the panel needs to tell the two apart.
    pub managed: bool,
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Where the app keeps its own copy — the same `bin` directory as ffmpeg.
pub fn install_dir() -> Option<&'static PathBuf> {
    crate::engine::install::install_dir()
}

/// Env override first, a binary shipped beside the app, the app's own copy,
/// then the PATH — the same order `engine::ffmpeg::locate_binary` uses.
pub fn locate() -> Option<PathBuf> {
    if let Ok(value) = std::env::var(ENV_OVERRIDE) {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
    }

    if let Ok(current) = std::env::current_exe() {
        if let Some(dir) = current.parent() {
            for candidate in [dir.join(exe("yt-dlp")), dir.join("bin").join(exe("yt-dlp"))] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    if let Some(dir) = install_dir() {
        let candidate = dir.join(exe("yt-dlp"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    // On the PATH: ask the binary to identify itself rather than scanning.
    let probe = crate::proc::command(exe("yt-dlp"))
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match probe {
        Ok(status) if status.success() => Some(PathBuf::from(exe("yt-dlp"))),
        _ => None,
    }
}

fn version_of(program: &Path) -> Option<String> {
    let output = crate::proc::command(program)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().next().map(|line| line.trim().to_string())
}

/// Days since 1970-01-01 for a civil date — Howard Hinnant's algorithm.
///
/// Spelled out rather than pulled in: one date subtraction does not justify a
/// calendar crate, and this is the one piece of date arithmetic the app does.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// How old a build is, from its own version string.
///
/// yt-dlp versions *are* dates — `2025.01.15`, sometimes with a build suffix.
/// That makes staleness a fact the app can check rather than a guess, and it
/// matters here more than for most tools: this one breaks when a site changes,
/// and "this video is not available" on a perfectly public video is far more
/// often an old binary than a closed video.
pub fn age_in_days(version: &str) -> Option<i64> {
    let mut parts = version.trim().split('.');
    let year = parts.next()?.parse::<i64>().ok()?;
    let month = parts.next()?.parse::<i64>().ok()?;
    let day = parts.next()?.parse::<i64>().ok()?;
    if !(2000..=2200).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let released = days_from_civil(year, month, day);
    let today = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64
        / 86_400;
    Some(today - released)
}

pub fn status() -> ToolStatus {
    match locate() {
        Some(path) => {
            let version = version_of(&path);
            let managed = install_dir().is_some_and(|dir| path == dir.join(exe("yt-dlp")));
            ToolStatus {
                available: true,
                installable: release_url().is_some(),
                age_days: version.as_deref().and_then(age_in_days),
                version,
                managed,
                path: Some(path.to_string_lossy().to_string()),
            }
        }
        None => ToolStatus {
            available: false,
            installable: release_url().is_some(),
            path: None,
            version: None,
            age_days: None,
            managed: false,
        },
    }
}

/// The asset published for this platform, from yt-dlp's own latest release.
///
/// `latest/download` always resolves to the newest release, which is what this
/// tool needs — a pinned version stops working the day a site changes.
fn release_url() -> Option<&'static str> {
    const BASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";

    #[cfg(windows)]
    {
        return Some(concat!(
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download",
            "/yt-dlp.exe"
        ));
    }

    #[cfg(target_os = "macos")]
    {
        return Some(concat!(
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download",
            "/yt-dlp_macos"
        ));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = BASE;
        return Some(concat!(
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download",
            "/yt-dlp_linux"
        ));
    }

    #[allow(unreachable_code)]
    {
        let _ = BASE;
        None
    }
}

pub fn supported() -> bool {
    release_url().is_some()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    /// `download` or `verify`.
    pub stage: String,
    pub received: u64,
    /// 0 when the server declines to say.
    pub total: u64,
    /// 0 → 1 across the whole install.
    pub ratio: f64,
}

fn emit(app: &AppHandle, progress: InstallProgress) {
    // A dropped event costs a progress tick, never the install.
    let _ = app.emit(INSTALL_PROGRESS, progress);
}

/// Marks the file executable. A no-op on Windows, essential everywhere else.
#[cfg(unix)]
fn make_runnable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    Ok(())
}

#[cfg(not(unix))]
fn make_runnable(_path: &Path) -> Result<()> {
    Ok(())
}

/// Fetches yt-dlp into the app's own directory.
///
/// Blocking end to end — the caller runs it off the UI thread.
/// Same reasoning as the ffmpeg installer's: a ceiling on silence, not on size.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

pub fn install(app: &AppHandle, cancel: Arc<AtomicBool>) -> Result<ToolStatus> {
    let url = release_url().ok_or_else(|| {
        OnlineError::new(
            OnlineErrorKind::Unsupported,
            "Aucun binaire yt-dlp publié pour cette plateforme — installez-le vous-même, \
             ou pointez la variable VEGLASS_YTDLP sur votre copie.",
        )
    })?;

    let dir = install_dir()
        .cloned()
        .ok_or_else(|| OnlineError::io("dossier d'installation inconnu"))?;
    fs::create_dir_all(&dir)?;

    let target = dir.join(exe("yt-dlp"));
    // Written beside the target and renamed, so an interrupted download can
    // never leave a half-written executable that looks installed.
    let temp = dir.join("yt-dlp.part");

    // Same shared agent as the ffmpeg installer — see `crate::net`.
    let response = crate::net::fetch(url, DOWNLOAD_TIMEOUT, || cancel.load(Ordering::Relaxed))
        .map_err(|error| {
            OnlineError::new(
                OnlineErrorKind::Network,
                crate::net::download_advice("yt-dlp", url, &error),
            )
        })?;

    let total = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);

    let mut reader = response.into_reader();
    let mut file = File::create(&temp)?;
    let mut buffer = vec![0u8; 256 * 1024];
    let mut received: u64 = 0;
    let mut last = Instant::now() - EMIT_INTERVAL;

    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = fs::remove_file(&temp);
            return Err(OnlineError::cancelled());
        }

        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])?;
        received += read as u64;

        if last.elapsed() >= EMIT_INTERVAL {
            last = Instant::now();
            emit(
                app,
                InstallProgress {
                    stage: "download".into(),
                    received,
                    total,
                    // Without a total, animate rather than pretend to a figure.
                    ratio: if total > 0 { (received as f64 / total as f64) * 0.95 } else { 0.0 },
                },
            );
        }
    }

    drop(file);
    fs::rename(&temp, &target)?;
    make_runnable(&target)?;

    emit(
        app,
        InstallProgress { stage: "verify".into(), received, total, ratio: 0.97 },
    );

    // The only proof that counts: it runs and answers.
    let status = status();
    if !status.available {
        let _ = fs::remove_file(&target);
        return Err(OnlineError::new(
            OnlineErrorKind::Tool,
            "yt-dlp a été téléchargé mais refuse de démarrer.",
        ));
    }

    emit(
        app,
        InstallProgress { stage: "verify".into(), received, total, ratio: 1.0 },
    );
    Ok(status)
}

/// A `Command` for yt-dlp with the arguments every call wants.
///
/// `--ignore-config` matters more than it looks: a user config file on the
/// machine could change the output template, the format or the destination
/// under us, and the app would then lose track of the file it just fetched.
pub fn command() -> Result<Command> {
    let program = locate().ok_or_else(OnlineError::missing_binary)?;
    let mut command = crate::proc::command(program);
    command
        .arg("--ignore-config")
        .arg("--no-warnings")
        .arg("--no-colors")
        .stdin(Stdio::null());

    // Hand it our own ffmpeg, so merging and audio extraction work on a machine
    // that has no system copy — the app already manages one.
    if let Some(ffmpeg) = crate::engine::ffmpeg::locate_binary("ffmpeg") {
        if let Some(dir) = ffmpeg.parent() {
            command.arg("--ffmpeg-location").arg(dir);
        }
    }

    // `--ignore-config` above is what makes this necessary: it stops yt-dlp
    // reading a user config, and on a proxied network the tool would otherwise
    // be the one part of the chain still connecting direct. Its own environment
    // handling is bypassed for the same reason — one source of truth.
    if let Some((_, raw)) = crate::net::proxy_for("youtube.com") {
        command.arg("--proxy").arg(raw);
    }

    Ok(command)
}

/// What a finished run produced.
pub struct Captured {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a command to completion, **draining both pipes as it goes**.
///
/// The obvious version of this — poll `try_wait`, read the output afterwards —
/// deadlocks, and does so only on large outputs, which is the worst way for a
/// bug like this to behave. A pipe holds about 64 KB; once it is full the child
/// blocks on `write` until somebody reads. `--dump-single-json` on a real video
/// is several hundred kilobytes, so yt-dlp would sit waiting for us while we sat
/// waiting for it, and the timeout would then kill a process that had done
/// nothing wrong. A short `--flat-playlist` search fits under the limit and
/// works, which is exactly how the fault hides.
///
/// Reading on threads is what breaks the cycle: the pipes empty continuously,
/// so `try_wait` sees the real exit and the deadline only ever fires on a run
/// that is genuinely stuck.
pub fn run_capturing(
    command: &mut Command,
    timeout: Duration,
    on_timeout: &str,
) -> Result<Captured> {
    use std::io::Read;

    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| OnlineError::io(format!("yt-dlp n'a pas pu être lancé : {error}")))?;

    let mut out_pipe = child
        .stdout
        .take()
        .ok_or_else(|| OnlineError::io("flux de sortie yt-dlp indisponible"))?;
    let mut err_pipe = child
        .stderr
        .take()
        .ok_or_else(|| OnlineError::io("flux d'erreur yt-dlp indisponible"))?;

    // Read as bytes, decoded loosely: a title can carry anything, and a stray
    // byte must not turn a working download into an encoding error.
    let drain = |pipe: &mut dyn Read| {
        let mut bytes = Vec::new();
        let _ = pipe.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    };

    let out_reader = std::thread::spawn(move || drain(&mut out_pipe));
    let err_reader = std::thread::spawn(move || drain(&mut err_pipe));

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(OnlineError::new(OnlineErrorKind::Network, on_timeout.to_string()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(error) => return Err(OnlineError::io(format!("yt-dlp interrompu : {error}"))),
        }
    };

    Ok(Captured {
        success: status.success(),
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_platform_binary_is_named_for_its_platform() {
        let url = release_url();
        if cfg!(windows) {
            assert_eq!(url.map(|value| value.ends_with("yt-dlp.exe")), Some(true));
        } else if cfg!(target_os = "macos") {
            assert_eq!(url.map(|value| value.ends_with("yt-dlp_macos")), Some(true));
        }
        // Every platform this builds on has a published build.
        assert!(url.is_some());
    }

    /// A shell command that prints well past a pipe's capacity.
    ///
    /// The size is the whole point: a pipe holds about 64 KB, and every version
    /// of this bug hides below that line.
    fn noisy_command() -> Command {
        let mut command = if cfg!(windows) {
            let mut command = crate::proc::command("cmd");
            command.args([
                "/C",
                "for /L %i in (1,1,4000) do @echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ]);
            command
        } else {
            let mut command = crate::proc::command("sh");
            command.args([
                "-c",
                "i=0; while [ $i -lt 4000 ]; do echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; i=$((i+1)); done",
            ]);
            command
        };
        command.stdin(Stdio::null());
        command
    }

    #[test]
    fn a_large_output_does_not_deadlock() {
        let captured = run_capturing(&mut noisy_command(), Duration::from_secs(30), "délai")
            .expect("the child should finish on its own");

        assert!(captured.success);
        // Comfortably past the pipe buffer: the version of this that read the
        // output only after waiting would still be waiting.
        assert!(
            captured.stdout.len() > 150_000,
            "expected a large capture, got {} bytes",
            captured.stdout.len()
        );
    }

    #[test]
    fn a_failing_command_reports_rather_than_hangs() {
        let mut command = if cfg!(windows) {
            let mut command = crate::proc::command("cmd");
            command.args(["/C", "exit 3"]);
            command
        } else {
            let mut command = crate::proc::command("sh");
            command.args(["-c", "exit 3"]);
            command
        };
        command.stdin(Stdio::null());

        let captured =
            run_capturing(&mut command, Duration::from_secs(10), "délai").expect("it runs");
        assert!(!captured.success);
    }

    #[test]
    fn a_version_is_a_date_and_reads_as_one() {
        // Both shapes yt-dlp publishes.
        assert!(age_in_days("2025.01.15").is_some());
        assert!(age_in_days("2025.01.15.232349").is_some());

        // A build from the future is not stale, and must not read as negative
        // nonsense the panel would show.
        let old = age_in_days("2020.01.01").expect("a date");
        let recent = age_in_days("2025.01.15").expect("a date");
        assert!(old > recent, "an older build must read as older");
        assert!(old > 1800, "five years is more than 1800 days, got {old}");
    }

    #[test]
    fn anything_that_is_not_a_date_reads_as_unknown() {
        assert_eq!(age_in_days("nightly"), None);
        assert_eq!(age_in_days(""), None);
        assert_eq!(age_in_days("2025.13.01"), None);
        assert_eq!(age_in_days("1999.01.01"), None);
    }

    #[test]
    fn the_epoch_is_where_the_calendar_says_it_is() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1970, 1, 2), 1);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
        // A leap year, which is where a hand-rolled calendar usually goes wrong.
        assert_eq!(days_from_civil(2000, 3, 1) - days_from_civil(2000, 2, 28), 2);
        assert_eq!(days_from_civil(2001, 3, 1) - days_from_civil(2001, 2, 28), 1);
    }

    #[test]
    fn the_executable_gains_an_extension_only_on_windows() {
        assert_eq!(exe("yt-dlp"), if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" });
    }
}
