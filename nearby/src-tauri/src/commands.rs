use crate::{preferences::Preferences, AppState};
use cd_nearby_discovery::Peer;
use cd_nearby_engine::{Offer, Share, Transfer};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    device_name: String,
    transfers: Vec<Transfer>,
    peers: Vec<Peer>,
    discovery_error: Option<String>,
    settings: Preferences,
}

#[tauri::command]
pub fn snapshot(state: State<'_, AppState>) -> Result<Snapshot, String> {
    let settings = state.preferences.lock().map_err(|e| e.to_string())?.clone();
    Ok(Snapshot {
        device_name: settings.device_name.clone(),
        settings,
        transfers: state.engine.snapshot().transfers,
        peers: state
            .discovery
            .as_ref()
            .map(|d| d.peers())
            .unwrap_or_default(),
        discovery_error: state
            .discovery
            .as_ref()
            .and_then(|discovery| discovery.last_error())
            .map(|error| format!("Nearby discovery encountered an error: {error}. You can still use a private invite."))
            .or_else(|| state.discovery_error.clone()),
    })
}

#[tauri::command]
pub async fn select_paths(app: AppHandle, folder: bool) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file().set_title("Choose something to share");
        let selected = if folder {
            dialog.blocking_pick_folder().map(|p| vec![p])
        } else {
            dialog.blocking_pick_files()
        };
        selected
            .unwrap_or_default()
            .into_iter()
            .map(|p| {
                p.into_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|e| e.to_string())
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn select_destination(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Where should this handoff land?")
            .blocking_pick_folder()
            .map(|p| {
                p.into_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|e| e.to_string())
            })
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn share(state: State<'_, AppState>, paths: Vec<String>) -> Result<Share, String> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        engine
            .share(paths.into_iter().map(PathBuf::from).collect())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn inspect_invite(state: State<'_, AppState>, invite: String) -> Result<Offer, String> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        engine.inspect_invite(&invite).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn receive(
    state: State<'_, AppState>,
    invite: String,
    destination: String,
) -> Result<String, String> {
    let engine = state.engine.clone();
    if !PathBuf::from(&destination).is_absolute() {
        return Err("Choose a receive folder first.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        engine
            .receive(invite, PathBuf::from(destination))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn pause(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.engine.pause(&id).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn resume(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.engine.resume(&id).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn revoke(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.engine.revoke(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let path = state
        .engine
        .snapshot()
        .transfers
        .into_iter()
        .find(|t| t.id == id && t.status == "completed")
        .and_then(|t| t.output_path)
        .ok_or("This handoff has no completed download to show.")?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, mut settings: Preferences) -> Result<(), String> {
    settings.device_name = settings.device_name.trim().to_string();
    settings.validate()?;
    let mut current = state.preferences.lock().map_err(|e| e.to_string())?;
    settings.save(&state.preference_path)?;
    state
        .engine
        .set_device_name(settings.device_name.clone())
        .map_err(|e| e.to_string())?;
    if let Some(discovery) = &state.discovery {
        discovery
            .set_name(settings.device_name.clone())
            .map_err(|e| e.to_string())?;
    }
    *current = settings;
    Ok(())
}
