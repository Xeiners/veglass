//! Media relinking.
//!
//! An absolute path is a fragile thing: it breaks when a folder moves, when a
//! project travels to another machine, or when an external drive gets a
//! different letter. Rather than declaring a file missing, we look for it — by
//! name, in the places it is most likely to be — and only ask the user when
//! that search comes up empty.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// How deep to descend into each candidate directory.
const MAX_DEPTH: u32 = 3;
/// Hard ceiling on directory entries visited, so a search can never hang the UI.
const SCAN_BUDGET: u32 = 20_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRequest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaResolution {
    pub id: String,
    /// `ok` — found where recorded · `relocated` — found elsewhere · `missing`
    pub status: String,
    pub path: Option<String>,
}

/// Windows paths are case-insensitive; matching on the lowercased name keeps
/// relinking working when a file has been renamed only in case.
fn key(name: &str) -> String {
    name.to_lowercase()
}

fn file_name_of(path: &Path) -> Option<String> {
    path.file_name().map(|value| value.to_string_lossy().to_string())
}

/// Breadth-first scan of `root`, collecting the first hit for each wanted name.
fn scan(
    root: &Path,
    wanted: &HashSet<String>,
    found: &mut HashMap<String, PathBuf>,
    budget: &mut u32,
) {
    let mut queue: Vec<(PathBuf, u32)> = vec![(root.to_path_buf(), 0)];

    while let Some((dir, depth)) = queue.pop() {
        if *budget == 0 || found.len() == wanted.len() {
            return;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };

        for entry in entries.flatten() {
            if *budget == 0 {
                return;
            }
            *budget -= 1;

            let path = entry.path();
            let Ok(kind) = entry.file_type() else { continue };

            if kind.is_dir() {
                // Symlinks are skipped: following them risks cycles and network
                // round-trips for no practical gain.
                if depth < MAX_DEPTH && !kind.is_symlink() {
                    queue.push((path, depth + 1));
                }
                continue;
            }

            if let Some(name) = file_name_of(&path) {
                let name_key = key(&name);
                if wanted.contains(&name_key) {
                    found.entry(name_key).or_insert(path);
                }
            }
        }
    }
}

/// Directories worth searching, most promising first.
fn candidate_roots(requests: &[MediaRequest], hints: &[String]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();

    let push = |dir: PathBuf, roots: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>| {
        if dir.is_dir() && seen.insert(dir.clone()) {
            roots.push(dir);
        }
    };

    // 1. Folders the user pointed at explicitly.
    for hint in hints {
        push(PathBuf::from(hint), &mut roots, &mut seen);
    }

    // 2. Folders of files that *did* resolve — media usually travels together.
    for request in requests {
        if let Some(path) = request.path.as_ref().map(PathBuf::from) {
            if path.is_file() {
                if let Some(parent) = path.parent() {
                    push(parent.to_path_buf(), &mut roots, &mut seen);
                }
            }
        }
    }

    // 3. The recorded folder and its parent, for a project moved one level.
    for request in requests {
        let Some(path) = request.path.as_ref().map(PathBuf::from) else {
            continue;
        };
        if let Some(parent) = path.parent() {
            push(parent.to_path_buf(), &mut roots, &mut seen);
            if let Some(grandparent) = parent.parent() {
                push(grandparent.to_path_buf(), &mut roots, &mut seen);
            }
        }
    }

    roots
}

/// Resolves every asset path, relocating by filename whatever has moved.
#[tauri::command]
pub fn resolve_media(requests: Vec<MediaRequest>, hints: Vec<String>) -> Vec<MediaResolution> {
    let mut resolutions: Vec<MediaResolution> = Vec::with_capacity(requests.len());
    let mut wanted: HashSet<String> = HashSet::new();

    for request in &requests {
        let exists = request
            .path
            .as_ref()
            .map(|value| Path::new(value).is_file())
            .unwrap_or(false);

        if exists {
            resolutions.push(MediaResolution {
                id: request.id.clone(),
                status: "ok".to_string(),
                path: request.path.clone(),
            });
        } else {
            wanted.insert(key(&request.name));
            resolutions.push(MediaResolution {
                id: request.id.clone(),
                status: "missing".to_string(),
                path: None,
            });
        }
    }

    if wanted.is_empty() {
        return resolutions;
    }

    let mut found: HashMap<String, PathBuf> = HashMap::new();
    let mut budget = SCAN_BUDGET;
    for root in candidate_roots(&requests, &hints) {
        if found.len() == wanted.len() || budget == 0 {
            break;
        }
        scan(&root, &wanted, &mut found, &mut budget);
    }

    for (index, request) in requests.iter().enumerate() {
        let Some(resolution) = resolutions.get_mut(index) else {
            continue;
        };
        if resolution.status != "missing" {
            continue;
        }
        if let Some(path) = found.get(&key(&request.name)) {
            resolution.status = "relocated".to_string();
            resolution.path = Some(path.to_string_lossy().to_string());
        }
    }

    resolutions
}

/// Parent directory of a file — what the relink dialog hands back as a hint.
#[tauri::command]
pub fn parent_directory(path: String) -> Result<Option<String>> {
    Ok(Path::new(&path)
        .parent()
        .map(|value| value.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_case_insensitively() {
        assert_eq!(key("Clip A.MP4"), key("clip a.mp4"));
    }

    #[test]
    fn an_existing_path_is_reported_as_ok_without_searching() {
        // The manifest is guaranteed to exist next to the crate root.
        let manifest = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml").to_string();
        let out = resolve_media(
            vec![MediaRequest {
                id: "a".into(),
                name: "Cargo.toml".into(),
                path: Some(manifest.clone()),
            }],
            vec![],
        );
        assert_eq!(out[0].status, "ok");
        assert_eq!(out[0].path.as_deref(), Some(manifest.as_str()));
    }

    #[test]
    fn a_moved_file_is_relocated_from_a_hint_directory() {
        let root = env!("CARGO_MANIFEST_DIR").to_string();
        let out = resolve_media(
            vec![MediaRequest {
                id: "a".into(),
                name: "Cargo.toml".into(),
                path: Some("/nowhere/that/exists/Cargo.toml".into()),
            }],
            vec![root.clone()],
        );
        assert_eq!(out[0].status, "relocated");
        assert!(out[0].path.as_deref().unwrap().ends_with("Cargo.toml"));
    }

    #[test]
    fn a_genuinely_absent_file_stays_missing() {
        let out = resolve_media(
            vec![MediaRequest {
                id: "a".into(),
                name: "il-n-existe-pas-42.mov".into(),
                path: Some("/nowhere/il-n-existe-pas-42.mov".into()),
            }],
            vec![env!("CARGO_MANIFEST_DIR").to_string()],
        );
        assert_eq!(out[0].status, "missing");
        assert!(out[0].path.is_none());
    }
}

/* ------------------------------------------------------------------ *
 * Baked layers
 * ------------------------------------------------------------------ */

/// Writes a front-end rasterisation (text layer, SVG) into the app cache and
/// hands back its path.
///
/// Text is drawn by the webview, not by ffmpeg: that is the only way the export
/// can match the preview glyph for glyph, and it sidesteps `drawtext`'s font
/// files and escaping entirely.
#[tauri::command]
pub fn write_baked_layer(
    app: tauri::AppHandle,
    key: String,
    png_base64: String,
) -> Result<String> {
    use base64::Engine as _;
    use tauri::Manager;

    let safe = safe_key(&key)?;
    let dir = app.path().app_cache_dir()?.join("baked");
    std::fs::create_dir_all(&dir)?;

    let payload = png_base64
        .split_once(",")
        .map(|(_, rest)| rest)
        .unwrap_or(&png_base64);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|error| Error::Bake(error.to_string()))?;

    let path = dir.join(format!("{safe}.png"));
    std::fs::write(&path, bytes)?;
    Ok(path.to_string_lossy().to_string())
}

/// Clears rasterisations left by previous exports.
#[tauri::command]
pub fn clear_baked_layers(app: tauri::AppHandle) -> Result<()> {
    use tauri::Manager;
    let dir = app.path().app_cache_dir()?.join("baked");
    if dir.is_dir() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    Ok(())
}

fn safe_key(key: &str) -> Result<String> {
    let valid = !key.is_empty()
        && key.len() <= 80
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if valid {
        Ok(key.to_string())
    } else {
        Err(Error::InvalidId)
    }
}

/// Writes one frame of a rasterised animation.
///
/// Returns the ffmpeg input pattern for the whole sequence, so the caller can
/// hand it straight to the encoder without rebuilding the path itself.
#[tauri::command]
pub fn write_baked_frame(
    app: tauri::AppHandle,
    key: String,
    index: u32,
    png_base64: String,
) -> Result<String> {
    use base64::Engine as _;
    use tauri::Manager;

    let safe = safe_key(&key)?;
    let dir = app.path().app_cache_dir()?.join("baked").join(&safe);
    std::fs::create_dir_all(&dir)?;

    let payload = png_base64
        .split_once(",")
        .map(|(_, rest)| rest)
        .unwrap_or(&png_base64);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|error| Error::Bake(error.to_string()))?;

    std::fs::write(dir.join(format!("{index:06}.png")), bytes)?;
    Ok(dir.join("%06d.png").to_string_lossy().to_string())
}

/// Ceiling on a file read wholesale into the webview for analysis.
const MAX_ANALYSIS_BYTES: u64 = 400 * 1024 * 1024;

/// Hands a media file's bytes to the front-end for offline analysis.
///
/// Waveform extraction needs the whole file decoded, and `fetch` over the asset
/// protocol is not a dependable way to get it: the response is subject to the
/// webview's cross-origin rules, which vary by platform and fail silently. The
/// path is already known and already trusted — reading it directly removes a
/// whole class of "it works on my machine".
#[tauri::command]
pub fn read_media_bytes(path: String) -> Result<tauri::ipc::Response> {
    let file = std::path::Path::new(&path);
    if !file.is_file() {
        return Err(Error::Bake(format!("fichier introuvable : {path}")));
    }

    let size = std::fs::metadata(file)?.len();
    if size > MAX_ANALYSIS_BYTES {
        return Err(Error::Bake(format!(
            "fichier trop volumineux pour l'analyse ({} Mo)",
            size / (1024 * 1024)
        )));
    }

    Ok(tauri::ipc::Response::new(std::fs::read(file)?))
}
