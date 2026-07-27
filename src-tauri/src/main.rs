// A portable note-taking app has no business flashing a console window on
// launch, so release builds detach from the console subsystem.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod attachments;
mod capture;
mod commands;
mod desktop;
mod exports;
mod mhtml;
mod notebook;
mod onenote;
mod notes;
mod pandoc;
mod platform;
mod search;
mod settings;
mod state;
mod templates;
mod util;

use state::AppState;
use std::sync::atomic::Ordering;
use tauri::{Manager, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

fn main() {
    tauri::Builder::default()
        // A second launch (or a leftover process trying to start again) hands
        // off to the running app instead of stacking another process that
        // fights over the global shortcuts.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            desktop::reveal_main_window(app, None);
        }))
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
            commands::select_folder,
            commands::app_version,
            commands::check_for_updates,
            // notebook
            commands::get_notebook_tree,
            commands::read_note,
            commands::write_note,
            commands::list_note_history,
            commands::read_note_history,
            commands::restore_note_history,
            commands::toggle_task_at_line,
            commands::toggle_mermaid_orientation,
            commands::open_external,
            // pages + sections
            commands::get_template_variables,
            commands::create_page,
            commands::create_section,
            commands::set_section_meta,
            commands::delete_node,
            commands::rename_node,
            commands::update_note_meta,
            commands::relocate_node,
            commands::move_node,
            commands::set_node_order,
            // trash
            commands::list_trash,
            commands::restore_trash_item,
            commands::delete_trash_item,
            commands::empty_trash,
            // search
            commands::search_notes,
            commands::get_backlinks,
            // templates + scratchpad
            commands::list_templates,
            commands::create_template,
            commands::read_scratchpad,
            commands::append_scratchpad,
            commands::write_scratchpad,
            // attachments
            commands::save_attachment,
            commands::import_attachment_file,
            // local AI
            commands::ai_transform,
            commands::ai_complete,
            commands::ai_list_models,
            // imports + exports
            commands::import_clipboard,
            commands::import_document,
            // OneNote
            commands::onenote_probe,
            commands::onenote_notebooks,
            commands::onenote_import,
            commands::export_to_pdf,
            commands::export_to_html,
            commands::export_to_docx,
            commands::copy_rich_text,
            // quick capture
            commands::list_capture_targets,
            commands::append_quick_capture,
            commands::hide_capture_window,
            // launcher
            commands::launcher_context,
            commands::launcher_search,
            commands::launcher_open_note,
            commands::launcher_export_note,
            commands::launcher_open_capture,
            commands::launcher_open_daily,
            commands::launcher_append_task,
            commands::launcher_open_scratchpad,
            commands::launcher_screenshot,
            commands::launcher_resize,
            commands::launcher_hide,
            // scratchpad window
            commands::scratchpad_hide,
            commands::scratchpad_pin,
            // screenshot overlay
            commands::region_get_shot,
            commands::region_cancel,
            commands::region_commit,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = app.state::<AppState>().settings();

            // Seed the per-user pointer for installs that predate it.
            settings::write_notebook_pointer(&settings.notebook_root);

            desktop::build_tray(&handle)?;
            desktop::update_watcher(&handle, &settings);
            desktop::apply_shortcuts(&handle, &settings);

            if let Some(main) = app.get_webview_window(desktop::MAIN) {
                // The window is created hidden and revealed here, so the first
                // frame the user sees is the app's own loading screen rather
                // than a white flash. It deliberately does NOT wait for the
                // notebook scan — that happens behind the loading overlay.
                let _ = main.show();

                let state_handle = handle.clone();
                main.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let state = state_handle.state::<AppState>();
                        // Close-to-tray: hide instead of destroying, so the
                        // tray tools and global shortcuts stay live.
                        if state.keep_in_tray.load(Ordering::Relaxed)
                            && !state.quitting.load(Ordering::SeqCst)
                        {
                            api.prevent_close();
                            if let Some(window) = state_handle.get_webview_window(desktop::MAIN) {
                                let _ = window.hide();
                            }
                        } else {
                            state.save_meta_cache();
                        }
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Markdown Notebook")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<AppState>();
                if state.keep_in_tray.load(Ordering::Relaxed)
                    && !state.quitting.load(Ordering::SeqCst)
                {
                    // Resident-in-tray mode: keep the process alive with no
                    // windows so the launcher and tray tools stay available.
                    api.prevent_exit();
                } else {
                    // Don't lose a pending write of the startup meta cache.
                    state.save_meta_cache();
                }
            }
        });
}
