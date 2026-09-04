//! Where the API keys live.
//!
//! A key never reaches the webview. It is written once through [`store`], read
//! only inside [`super::gemini`] or [`super::eleven`] when a request is being
//! built, and everything the UI can ever see about it is a [`KeyStatus`] —
//! whether one exists, which backend holds it, and its last four characters.
//!
//! Two backends, in order of preference:
//!
//! * **`keychain`** — the operating system's own credential store (Windows
//!   Credential Manager, macOS Keychain). Encrypted at rest by the OS, bound to
//!   the user account, and readable by no other application. This is the path
//!   taken on desktop unless the store refuses.
//! * **`file`** — a fallback under the app data directory, XOR-ed against a
//!   SHA-256 keystream seeded by a per-install random salt. This is *not*
//!   encryption: whoever can read the file can read the salt beside it. It
//!   exists so the key is not a plain string sitting in a backup, a screen
//!   share or a `grep`, and the settings panel says exactly that.
//!
//! Which one is in use is reported rather than assumed, because "your key is
//! stored securely" is a claim that has to be true.
//!
//! # Two services, one mechanism
//!
//! The suite speaks to two providers now — Gemini for understanding, ElevenLabs
//! for speech — and both hand out a bearer credential. A [`Vault`] is no more
//! than the pair of names one of them is filed under, so the second key
//! inherits the keychain, the fallback and the honest reporting rather than
//! growing a parallel implementation that would be secure by coincidence. The
//! Gemini account name and filename are unchanged, so an install that already
//! holds a key finds it exactly where it left it.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use super::error::{AiError, AiErrorKind, Result};

const SERVICE: &str = "veglass";
const SALT_BYTES: usize = 32;

/// One credential, and where it is filed.
///
/// `account` is the entry name inside the OS credential store, `file` the name
/// of the fallback blob. Both are stable strings: changing either would strand
/// a key that is already stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Vault {
    account: &'static str,
    file: &'static str,
    /// The service, as a sentence would name it.
    pub label: &'static str,
}

pub const GEMINI: Vault = Vault {
    account: "gemini-api-key",
    file: "gemini.bin",
    label: "Gemini",
};

pub const ELEVENLABS: Vault = Vault {
    account: "elevenlabs-api-key",
    file: "elevenlabs.bin",
    label: "ElevenLabs",
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub configured: bool,
    /// `keychain` · `file` · `none`
    pub backend: &'static str,
    /// Last four characters, so the panel can show *which* key is stored.
    pub hint: Option<String>,
}

impl KeyStatus {
    fn empty() -> Self {
        Self { configured: false, backend: "none", hint: None }
    }
}

/// Enough to tell two keys apart, not enough to use one.
fn hint_of(key: &str) -> String {
    let mut tail: Vec<char> = key.chars().rev().take(4).collect();
    tail.reverse();
    format!("…{}", tail.into_iter().collect::<String>())
}

/* ------------------------------------------------------------------ *
 * OS credential store
 * ------------------------------------------------------------------ */

/// Linux is deliberately excluded: the secret-service backend drags in a D-Bus
/// dependency that has to be present at build *and* run time, and a headless
/// session has no keyring at all. The file fallback covers it.
#[cfg(any(windows, target_os = "macos"))]
mod keychain {
    use super::SERVICE;

    fn entry(account: &str) -> Option<keyring::Entry> {
        keyring::Entry::new(SERVICE, account).ok()
    }

    pub fn store(account: &str, key: &str) -> bool {
        entry(account).map(|item| item.set_password(key).is_ok()).unwrap_or(false)
    }

    pub fn load(account: &str) -> Option<String> {
        entry(account)?.get_password().ok()
    }

    pub fn clear(account: &str) {
        if let Some(item) = entry(account) {
            // `NoEntry` is the normal outcome when nothing was stored.
            let _ = item.delete_credential();
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod keychain {
    pub fn store(_account: &str, _key: &str) -> bool {
        false
    }
    pub fn load(_account: &str) -> Option<String> {
        None
    }
    pub fn clear(_account: &str) {}
}

/* ------------------------------------------------------------------ *
 * File fallback
 * ------------------------------------------------------------------ */

fn secrets_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AiError::io(format!("dossier applicatif indisponible : {error}")))?
        .join("secrets");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// The salt and a counter hashed repeatedly, giving as many bytes as needed.
fn keystream(salt: &[u8], length: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(length + 32);
    let mut counter: u64 = 0;
    while out.len() < length {
        let mut hasher = Sha256::new();
        hasher.update(salt);
        hasher.update(counter.to_le_bytes());
        out.extend_from_slice(&hasher.finalize());
        counter += 1;
    }
    out.truncate(length);
    out
}

fn file_path(app: &AppHandle, vault: Vault) -> Result<PathBuf> {
    Ok(secrets_dir(app)?.join(vault.file))
}

fn file_store(app: &AppHandle, vault: Vault, key: &str) -> Result<()> {
    let mut salt = [0u8; SALT_BYTES];
    getrandom::getrandom(&mut salt)
        .map_err(|error| AiError::io(format!("source d'aléa indisponible : {error}")))?;

    let plain = key.as_bytes();
    let mask = keystream(&salt, plain.len());
    let mut blob = Vec::with_capacity(SALT_BYTES + plain.len());
    blob.extend_from_slice(&salt);
    blob.extend(plain.iter().zip(mask).map(|(byte, mask)| byte ^ mask));

    let path = file_path(app, vault)?;
    fs::write(&path, &blob)?;
    restrict(&path);
    Ok(())
}

fn file_load(app: &AppHandle, vault: Vault) -> Option<String> {
    let blob = fs::read(file_path(app, vault).ok()?).ok()?;
    if blob.len() <= SALT_BYTES {
        return None;
    }
    let (salt, body) = blob.split_at(SALT_BYTES);
    let mask = keystream(salt, body.len());
    let plain: Vec<u8> = body.iter().zip(mask).map(|(byte, mask)| byte ^ mask).collect();
    String::from_utf8(plain).ok().filter(|value| !value.is_empty())
}

fn file_clear(app: &AppHandle, vault: Vault) {
    if let Ok(path) = file_path(app, vault) {
        let _ = fs::remove_file(path);
    }
}

/// Owner-only, where the platform has a notion of it.
#[cfg(unix)]
fn restrict(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &std::path::Path) {
    // Windows inherits the app-data ACL, which is already per-user.
}

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */

/// Saves `key`, preferring the OS credential store.
///
/// A key that lands in the keychain is also removed from the file fallback, so
/// a machine that gains a working keychain stops leaving a copy behind.
pub fn store(app: &AppHandle, vault: Vault, key: &str) -> Result<KeyStatus> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AiError::new(AiErrorKind::InvalidKey, "La clé est vide."));
    }
    // Neither provider documents its key format, but both issue a single ASCII
    // token — a pasted line carrying spaces or quotes is a mistake worth
    // catching here rather than as a 400 from the API a second later.
    if key.chars().any(char::is_whitespace) || !key.is_ascii() {
        return Err(AiError::new(
            AiErrorKind::InvalidKey,
            "Cette clé contient des espaces ou des caractères inattendus — collez-la sans guillemets.",
        ));
    }

    if keychain::store(vault.account, key) {
        file_clear(app, vault);
        return Ok(KeyStatus { configured: true, backend: "keychain", hint: Some(hint_of(key)) });
    }

    file_store(app, vault, key)?;
    Ok(KeyStatus { configured: true, backend: "file", hint: Some(hint_of(key)) })
}

/// The key itself. Only a provider client should ever call this.
pub fn load(app: &AppHandle, vault: Vault) -> Option<String> {
    keychain::load(vault.account).or_else(|| file_load(app, vault))
}

pub fn clear(app: &AppHandle, vault: Vault) -> KeyStatus {
    keychain::clear(vault.account);
    file_clear(app, vault);
    KeyStatus::empty()
}

pub fn status(app: &AppHandle, vault: Vault) -> KeyStatus {
    if let Some(key) = keychain::load(vault.account) {
        return KeyStatus { configured: true, backend: "keychain", hint: Some(hint_of(&key)) };
    }
    match file_load(app, vault) {
        Some(key) => KeyStatus { configured: true, backend: "file", hint: Some(hint_of(&key)) },
        None => KeyStatus::empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keystream_is_deterministic_and_long_enough() {
        let salt = [7u8; SALT_BYTES];
        assert_eq!(keystream(&salt, 100), keystream(&salt, 100));
        assert_eq!(keystream(&salt, 100).len(), 100);
    }

    #[test]
    fn keystream_diverges_with_the_salt() {
        assert_ne!(keystream(&[1u8; SALT_BYTES], 64), keystream(&[2u8; SALT_BYTES], 64));
    }

    #[test]
    fn masking_round_trips() {
        let salt = [3u8; SALT_BYTES];
        let secret = b"AIzaSyExampleKeyValue";
        let mask = keystream(&salt, secret.len());
        let hidden: Vec<u8> = secret.iter().zip(&mask).map(|(a, b)| a ^ b).collect();
        assert_ne!(hidden, secret.to_vec());
        let back: Vec<u8> = hidden.iter().zip(&mask).map(|(a, b)| a ^ b).collect();
        assert_eq!(back, secret.to_vec());
    }

    #[test]
    fn hint_keeps_only_the_tail() {
        assert_eq!(hint_of("AIzaSy0123456789abcd"), "…abcd");
        assert_eq!(hint_of("ab"), "…ab");
    }

    /// The two vaults must never collide, in either backend: one key silently
    /// overwriting the other is the failure this separation exists to prevent.
    #[test]
    fn the_vaults_are_filed_apart() {
        assert_ne!(GEMINI.account, ELEVENLABS.account);
        assert_ne!(GEMINI.file, ELEVENLABS.file);
    }

    /// The Gemini names are load-bearing: an install that already holds a key
    /// finds it again only if these two strings never move.
    #[test]
    fn the_gemini_vault_keeps_its_historical_names() {
        assert_eq!(GEMINI.account, "gemini-api-key");
        assert_eq!(GEMINI.file, "gemini.bin");
    }
}
