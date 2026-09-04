//! Spawning child processes without a console window.
//!
//! Veglass drives three console programs — ffmpeg, ffprobe and yt-dlp — and on
//! Windows every one of them is a console-subsystem executable. Spawned from a
//! GUI application with `Command::new`, Windows gives each one a console of its
//! own: a black window that flashes open and shut on every probe, every
//! thumbnail, every search. On a timeline that probes clips as they are added,
//! that is a window per click.
//!
//! `CREATE_NO_WINDOW` suppresses it. The flag has to be set at *every* spawn
//! site, which is exactly the kind of thing that gets remembered at nineteen
//! sites and forgotten at two — so no site calls `Command::new` directly any
//! more; they all come through here.
//!
//! On every other platform this is `Command::new` with a different name, which
//! is the point: one call shape, correct everywhere.

use std::ffi::OsStr;
use std::process::Command;

/// Detach from any console. Windows only; ignored elsewhere.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A child process that will not flash a console window.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_is_still_the_program_that_was_asked_for() {
        let command = command("ffmpeg");
        assert_eq!(command.get_program(), OsStr::new("ffmpeg"));
    }

    /// The flag is only observable through a spawn, so this at least proves the
    /// helper produces a runnable command on the platform it is built for.
    #[test]
    fn a_hidden_command_still_runs() {
        let program = if cfg!(windows) { "cmd" } else { "sh" };
        let args: &[&str] = if cfg!(windows) {
            &["/C", "exit 0"]
        } else {
            &["-c", "exit 0"]
        };

        let status = command(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();

        assert!(status.map(|code| code.success()).unwrap_or(false));
    }
}
