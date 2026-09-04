//! Project persistence: one pretty-printed JSON document per project, stored in
//! the OS application-data directory.

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::model::{Project, ProjectSummary};

/// Ids come from `crypto.randomUUID()`, but the value still crosses an IPC
/// boundary — reject anything that could escape the projects directory.
fn safe_id(id: &str) -> Result<&str> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if valid {
        Ok(id)
    } else {
        Err(Error::InvalidId)
    }
}

fn projects_root(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir()?.join("projects");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn project_path(app: &AppHandle, id: &str) -> Result<PathBuf> {
    Ok(projects_root(app)?.join(format!("{}.veglass.json", safe_id(id)?)))
}

#[tauri::command]
pub fn projects_dir(app: AppHandle) -> Result<String> {
    Ok(projects_root(&app)?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<ProjectSummary>> {
    let root = projects_root(&app)?;
    let mut summaries: Vec<ProjectSummary> = Vec::new();

    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        // A single corrupt file must not take the whole library down.
        let Ok(contents) = fs::read_to_string(&path) else {
            continue;
        };
        match serde_json::from_str::<Project>(&contents) {
            Ok(project) => summaries.push(ProjectSummary::from(&project)),
            Err(err) => eprintln!("veglass: skipping {}: {err}", path.display()),
        }
    }

    summaries.sort_by(|a, b| {
        b.updated_at
            .partial_cmp(&a.updated_at)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(summaries)
}

#[tauri::command]
pub fn load_project(app: AppHandle, id: String) -> Result<Option<Project>> {
    let path = project_path(&app, &id)?;
    if !path.exists() {
        return Ok(None);
    }
    let contents = fs::read_to_string(path)?;
    Ok(Some(serde_json::from_str::<Project>(&contents)?))
}

#[tauri::command]
pub fn save_project(app: AppHandle, project: Project) -> Result<()> {
    let path = project_path(&app, &project.id)?;
    let json = serde_json::to_string_pretty(&project)?;

    // Write beside the target then rename, so an interrupted save can never
    // leave a half-written project on disk.
    let temp = path.with_extension("tmp");
    fs::write(&temp, json)?;
    fs::rename(&temp, &path)?;
    Ok(())
}

#[tauri::command]
pub fn delete_project(app: AppHandle, id: String) -> Result<()> {
    let path = project_path(&app, &id)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}
