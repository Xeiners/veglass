//! Handing a URL to the operating system.
//!
//! A webview is not a browser: `target="_blank"` has nowhere to go, and an
//! anchor pointing outside the application silently does nothing. Opening a
//! link therefore has to leave the webview and ask the OS, which is what this
//! does — the one place in the app that needs it is the "obtenir une clé" link
//! in the assistant's settings.
//!
//! No shell is involved on any platform. `cmd /C start` would re-parse its
//! arguments after Rust has escaped them, which is the whole `BatBadBut` class
//! of bug; `rundll32` takes the URL as a plain argument and hands it to the
//! registered protocol handler directly.

use std::process::Stdio;

/// Shows the folder Veglass keeps its own binaries in.
///
/// Takes no argument on purpose. A `reveal(path)` command would let the webview
/// name any directory on the machine, and the only caller wants exactly one —
/// so the path is resolved natively and nothing crosses the boundary. No shell
/// here either, for the same reason as `open_external`.
#[tauri::command]
pub fn open_binaries_dir() -> Result<(), String> {
    let dir = crate::engine::install::install_dir()
        .cloned()
        .ok_or_else(|| "dossier d'installation inconnu".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("dossier illisible : {error}"))?;

    #[cfg(windows)]
    let mut command = crate::proc::command("explorer");
    #[cfg(target_os = "macos")]
    let mut command = crate::proc::command("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = crate::proc::command("xdg-open");

    command.arg(&dir);
    // `explorer` returns a non-zero code even when it succeeds, so the spawn is
    // what is checked, not the exit status.
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("ouverture impossible : {error}"))
}

/// Only a plain `https://` URL is ever opened.
///
/// The caller is our own settings panel, but the value still crosses the IPC
/// boundary, so it is validated here rather than trusted: no other scheme
/// (`file:`, `javascript:`), nothing that is not printable ASCII, and a length
/// no handler could choke on.
fn acceptable(url: &str) -> bool {
    url.len() <= 2048
        && url.starts_with("https://")
        && url.len() > "https://".len()
        && url.chars().all(|c| c.is_ascii_graphic())
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !acceptable(&url) {
        return Err("Lien refusé : seules les adresses https simples sont ouvertes.".into());
    }

    #[cfg(windows)]
    let mut command = {
        let mut command = crate::proc::command("rundll32");
        command.arg("url.dll,FileProtocolHandler").arg(&url);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = crate::proc::command("open");
        command.arg(&url);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = crate::proc::command("xdg-open");
        command.arg(&url);
        command
    };

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Spawned and forgotten: the browser outlives us, and waiting on it
        // would block the command for as long as the window stays open.
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Ouverture du lien impossible : {error}"))
}

#[cfg(test)]
mod tests {
    use super::acceptable;

    #[test]
    fn plain_https_passes() {
        assert!(acceptable("https://aistudio.google.com/apikey"));
    }

    #[test]
    fn other_schemes_are_refused() {
        assert!(!acceptable("http://example.com"));
        assert!(!acceptable("file:///etc/passwd"));
        assert!(!acceptable("javascript:alert(1)"));
        assert!(!acceptable("https://"));
    }

    #[test]
    fn whitespace_and_control_characters_are_refused() {
        assert!(!acceptable("https://example.com/a b"));
        assert!(!acceptable("https://example.com/\na"));
        assert!(!acceptable("https://exemple.com/é"));
    }

    #[test]
    fn absurd_lengths_are_refused() {
        assert!(!acceptable(&format!("https://{}", "a".repeat(4096))));
    }
}
