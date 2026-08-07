//! Watching `logs.config.json` so an edit takes effect without a restart.
//!
//! This exists because of a bug report that read "I added a log and I can't see
//! the lines". Everything downstream was correct — the file was tailed, the
//! lines were parsed, the view was rendered — but the config was read once at
//! startup and never again, so a source added by editing the file was a source
//! the running app had never heard of. Nothing was broken and nothing worked.
//!
//! Dev Hub has watched its own config since its first version, for the same
//! reason. This is the same watcher, minus the provider machinery.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use crate::settings;
use crate::state::AppState;

/// Long enough to coalesce an editor's write-then-rename into one event, short
/// enough that saving the file feels like it took effect immediately.
const DEBOUNCE_MS: u64 = 300;

static WATCHER: Mutex<Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>> =
    Mutex::new(None);

/// Re-read the config from disk and adopt it.
///
/// A file that has been left mid-edit — a trailing comma, a half-typed path —
/// is reported and the previous config is kept. Replacing a working set of
/// sources with nothing because someone paused with the JSON invalid would be
/// the watcher actively making things worse.
pub fn reload_config(app: &AppHandle) {
    let state = app.state::<AppState>();
    match settings::load_config() {
        Ok(config) => {
            state.set_config(config);
            state.reconcile_tails();
        }
        Err(error) => state.set_config_error(error),
    }
    let _ = app.emit("config-changed", ());
}

/// Watch the folder holding `logs.config.json` and reload on any change to it.
///
/// The *directory* is watched rather than the file, because most editors save
/// by writing a temp file and renaming it over the original. That destroys the
/// handle a file watch is bound to, so a file watch sees the first save and
/// nothing after it — which is worse than no watcher at all, since it works
/// once and teaches you to trust it.
pub fn watch_config(app: &AppHandle) {
    use notify::RecursiveMode;
    use notify_debouncer_mini::{new_debouncer, DebounceEventResult};

    let mut slot = WATCHER.lock().unwrap();
    *slot = None; // drop the old watcher first, so the path is released

    let config_path = settings::config_file();
    let Some(dir) = config_path.parent().map(|p| p.to_path_buf()) else {
        return;
    };
    if !dir.exists() {
        return;
    }

    let app_handle = app.clone();
    let debouncer = new_debouncer(
        std::time::Duration::from_millis(DEBOUNCE_MS),
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            if events.iter().any(|event| event.path == config_path) {
                reload_config(&app_handle);
            }
        },
    );

    match debouncer {
        Ok(mut debouncer) => {
            if let Err(err) = debouncer.watcher().watch(&dir, RecursiveMode::NonRecursive) {
                eprintln!("Failed to watch the config folder: {err}");
                return;
            }
            *slot = Some(debouncer);
        }
        Err(err) => eprintln!("Failed to start the config watcher: {err}"),
    }
}
