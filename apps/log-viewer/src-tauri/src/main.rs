// A portable dev tool has no business flashing a console window on launch, so
// release builds detach from the console subsystem.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;
mod commands;
mod desktop;
mod filter;
mod line;
mod parse;
mod settings;
mod state;
mod store;
mod tail;

use state::AppState;
use tauri::{Emitter, Manager};

fn main() {
    let args = cli::parse(std::env::args());

    tauri::Builder::default()
        // A second launch hands its files to the running window rather than
        // starting a second process. This is what makes Dev Hub's "tail this"
        // feel like one app: the first click opens the viewer, the second adds
        // a file to it.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let incoming = cli::parse(argv);
            let state = app.state::<AppState>();
            for path in &incoming.files {
                state.add_session_source(path);
            }
            state.reconcile_tails();
            let _ = app.emit("sources-changed", ());
            reveal_main_window(app);
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::load())
        .invoke_handler(tauri::generate_handler![
            commands::context,
            commands::get_settings,
            commands::save_settings,
            commands::get_config,
            commands::save_config,
            commands::list_sources,
            commands::add_source,
            commands::remove_source,
            commands::set_source_enabled,
            commands::pin_source,
            commands::reload_source,
            commands::set_filter,
            commands::check_pattern,
            commands::refresh,
            commands::clear,
            commands::copy_view,
            commands::reveal_source,
            commands::pick_files,
            commands::browse_file,
            commands::open_sibling,
            commands::reveal_config_file,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // Announce ourselves before anything else, so Dev Hub can offer
            // "tail this" the moment the viewer has been run once.
            settings::register_with_suite();

            let state = app.state::<AppState>();
            for path in &args.files {
                state.add_session_source(path);
            }
            if let Some(follow) = args.follow {
                let mut settings = state.settings();
                settings.follow = follow;
                state.set_settings(settings);
            }
            state.reconcile_tails();

            // Editing logs.config.json has to take effect while the app is
            // running. Without this a source added by hand is invisible until
            // the next launch, which reads as "the viewer doesn't work".
            desktop::watch_config(&handle);

            spawn_tail_loop(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building Log Viewer");
}

fn reveal_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// One loop for every source, rather than a task per file.
///
/// A task per file sounds tidier and is worse: with eight sources it produces
/// eight independent wake-ups per interval, and the batch each one emits can
/// only be ordered against itself. Polling them together means one wake-up and
/// one batch, which is the unit `store::query_since` can sort.
fn spawn_tail_loop(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let state = app.state::<AppState>();
            let interval = state.settings().poll_interval_ms;

            state.reconcile_tails();

            // Polling is blocking file I/O. Doing it on the async runtime's
            // worker would stall every other task on the same thread for as
            // long as a slow network share takes to answer.
            let polls = {
                let app = app.clone();
                tokio::task::spawn_blocking(move || {
                    let state = app.state::<AppState>();
                    state.with_tails(|tails| {
                        tails
                            .iter_mut()
                            .map(|(id, tail)| (id.clone(), tail.poll()))
                            .collect::<Vec<_>>()
                    })
                })
                .await
            };
            let Ok(polls) = polls else { break };

            let mark = state.with_store(|store| store.next_seq());
            let mut appended = false;
            let mut health_changed = false;

            for (id, poll) in polls {
                // Whether the file could be read is the answer to "I added a
                // log and see nothing", so it is recorded even when — especially
                // when — there are no lines to go with it.
                health_changed |= state.set_health(&id, poll.missing);

                if poll.rotated {
                    state.with_store(|store| store.mark_rotation(&id));
                    appended = true;
                }
                if !poll.lines.is_empty() {
                    state.with_store(|store| store.extend(&id, poll.lines));
                    appended = true;
                }
            }

            // Only when the answer changed: this loop runs four times a second,
            // and a window that redraws its sidebar that often is a battery
            // problem rather than a feature.
            if health_changed {
                let _ = app.emit("sources-changed", ());
            }

            if appended {
                let filter = state.filter();
                let anchor = state
                    .with_store(|store| store.newest_timestamp())
                    .unwrap_or_else(filter::now_millis);
                // A filter that no longer compiles — the user is mid-edit —
                // just means no incremental push this tick.
                if let Ok(matcher) = filter::Matcher::build_at(&filter, anchor) {
                    let highlighter = filter::Highlighter::build(&state.config().highlights);
                    let batch =
                        state.with_store(|store| store.query_since(mark, &matcher, &highlighter));
                    let (matched, total) = state.with_store(|store| {
                        let view = store.query(&matcher, &highlighter, 0);
                        (view.matched, view.total)
                    });
                    let _ = app.emit(
                        "lines-appended",
                        serde_json::json!({
                            "lines": batch,
                            "matched": matched,
                            "total": total,
                        }),
                    );
                }
            }

            tokio::time::sleep(std::time::Duration::from_millis(interval)).await;
        }
    });
}
