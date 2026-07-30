// A portable dev tool has no business flashing a console window on launch, so
// release builds detach from the console subsystem.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod desktop;
mod detect;
mod model;
mod providers;
mod registry;
mod search;
mod settings;
mod startup;
mod state;
mod util;

use state::AppState;
use std::sync::atomic::Ordering;
use tauri::{Manager, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

fn main() {
    tauri::Builder::default()
        // A second launch hands off to the running app instead of stacking
        // another process that fights over the global shortcut.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            desktop::reveal_main_window(app);
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        desktop::handle_shortcut(app, shortcut);
                    }
                })
                .build(),
        )
        .manage(AppState::load())
        .invoke_handler(tauri::generate_handler![
            // settings + app
            commands::get_settings,
            commands::save_settings,
            commands::app_version,
            // first-run setup
            commands::setup_suggestions,
            commands::run_at_login,
            commands::set_run_at_login,
            // launcher hotkey
            commands::shortcut_status,
            commands::shortcut_suggestions,
            commands::set_launcher_shortcut,
            // config
            commands::get_config,
            commands::get_config_json,
            commands::save_config,
            commands::save_config_json,
            commands::reveal_config_file,
            commands::pick_folder,
            commands::pick_program,
            // providers + items
            commands::list_providers,
            commands::get_results,
            commands::get_items,
            commands::refresh_provider,
            commands::refresh_all,
            commands::search_items,
            commands::run_action,
            commands::open_external,
            // launcher
            commands::launcher_context,
            commands::launcher_resize,
            commands::launcher_hide,
            commands::show_launcher,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = app.state::<AppState>().settings();

            desktop::build_tray(&handle)?;
            desktop::apply_shortcut(&handle, &settings);
            desktop::watch_config(&handle);

            // Seed the cache and start the refresh loops. Cards paint as
            // "pending" immediately; results replace them as they land.
            registry::restart(&handle);

            if let Some(main) = app.get_webview_window(desktop::MAIN) {
                // The window is created hidden and revealed here, so the first
                // frame is the app's own shell rather than a white flash.
                // A login start goes straight to the tray. Opening the
                // dashboard over the desktop every morning is how a helpful
                // tool becomes one you uninstall.
                let to_tray = settings.keep_in_tray
                    && (settings.start_minimized || startup::launched_at_login());
                if !to_tray {
                    let _ = main.show();
                }

                let state_handle = handle.clone();
                main.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let state = state_handle.state::<AppState>();
                        // Close-to-tray: hide instead of destroying, so the
                        // tray tools and the global shortcut stay live.
                        if state.keep_in_tray.load(Ordering::Relaxed)
                            && !state.quitting.load(Ordering::SeqCst)
                        {
                            api.prevent_close();
                            if let Some(window) = state_handle.get_webview_window(desktop::MAIN) {
                                let _ = window.hide();
                            }
                        } else {
                            state.save_usage();
                        }
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Dev Hub")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<AppState>();
                if state.keep_in_tray.load(Ordering::Relaxed)
                    && !state.quitting.load(Ordering::SeqCst)
                {
                    // Resident-in-tray mode: keep the process alive with no
                    // windows so the launcher stays available.
                    api.prevent_exit();
                } else {
                    state.save_usage();
                }
            }
        });
}
