#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod preferences;

use cd_nearby_discovery::Discovery;
use cd_nearby_engine::Engine;
use preferences::Preferences;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager,
};

struct AppState {
    engine: Engine,
    discovery: Option<Discovery>,
    discovery_error: Option<String>,
    preferences: Mutex<Preferences>,
    preference_path: std::path::PathBuf,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&state_dir)?;
            let preference_path = state_dir.join("preferences.json");
            let default_download = app.path().download_dir().or_else(|_| app.path().home_dir())?;
            let preferences = Preferences::load(&preference_path, default_download)?;
            let engine = Engine::new(preferences.device_name.clone(), state_dir.join("transfers"))?;
            let (discovery, discovery_error) = match Discovery::start(preferences.device_name.clone()) {
                Ok(d) => (Some(d), None),
                Err(e) => (None, Some(format!("Nearby discovery could not start: {e}. You can still use a private invite."))),
            };
            app.manage(AppState { engine, discovery, discovery_error, preferences: Mutex::new(preferences), preference_path });
            let open = MenuItem::with_id(app, "open", "Open Nearby", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Nearby", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let icon = tray_icon();
            if let Some(window) = app.get_webview_window("main") { window.set_icon(icon.clone())?; }
            TrayIconBuilder::new().icon(icon).tooltip("CD Nearby — private file handoffs")
                .menu(&menu).show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app), "quit" => app.exit(0), _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event { show(tray.app_handle()); }
                }).build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.hide().is_ok() { api.prevent_close(); }
            }
        })
        .invoke_handler(tauri::generate_handler![commands::snapshot, commands::select_paths,
            commands::select_destination, commands::share, commands::inspect_invite,
            commands::receive, commands::pause, commands::resume, commands::revoke,
            commands::copy_text, commands::reveal, commands::save_settings])
        .run(tauri::generate_context!())
        .expect("CD Nearby could not start");
}

fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn tray_icon() -> tauri::image::Image<'static> {
    let mut pixels = vec![0u8; 32 * 32 * 4];
    for y in 0..32usize {
        for x in 0..32usize {
            let i = (y * 32 + x) * 4;
            let arrow = (y >= 9 && y <= 11 && x >= 7 && x <= 24)
                || (y >= 20 && y <= 22 && x >= 7 && x <= 24)
                || (x >= 20 && x <= 25 && (y as isize - 10).abs() == (25 - x) as isize)
                || (x >= 6 && x <= 11 && (y as isize - 21).abs() == (x - 6) as isize);
            pixels[i..i + 4].copy_from_slice(if arrow {
                &[255, 250, 244, 255]
            } else {
                &[230, 92, 53, 255]
            });
        }
    }
    tauri::image::Image::new_owned(pixels, 32, 32)
}
