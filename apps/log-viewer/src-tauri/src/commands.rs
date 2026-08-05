//! Everything the renderer can ask for.
//!
//! The same rule Dev Hub follows applies here: the renderer never names a
//! program to run or a path to read outside what it was handed. Opening a
//! source in an editor goes through the source id, not a path the window
//! supplied.

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::filter::{FilterSpec, Highlighter, Matcher};
use crate::settings::{self, LogSource, LogsConfig, ViewerSettings};
use crate::state::AppState;
use crate::store::View;

/// What the window needs on first paint, in one round trip.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub settings: ViewerSettings,
    pub config: LogsConfig,
    pub sources: Vec<LogSource>,
    pub filter: FilterSpec,
    pub version: String,
    /// A config file that failed to parse, so the UI can say so rather than
    /// showing an empty source list.
    pub config_error: Option<String>,
    /// The suite siblings that are installed, for the "open in…" menu.
    pub siblings: Vec<Sibling>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sibling {
    pub id: String,
    pub name: String,
}

#[tauri::command]
pub fn context(state: State<AppState>) -> Context {
    Context {
        settings: state.settings(),
        config: state.config(),
        sources: state.sources(),
        filter: state.filter(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        config_error: state.config_error(),
        siblings: suite_registry::load()
            .apps
            .into_values()
            .filter(|entry| entry.id != suite_registry::LOG_VIEWER)
            .map(|entry| Sibling {
                id: entry.id,
                name: entry.name,
            })
            .collect(),
    }
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> ViewerSettings {
    state.settings()
}

#[tauri::command]
pub fn save_settings(
    state: State<AppState>,
    settings: serde_json::Value,
) -> Result<ViewerSettings, String> {
    let migrated = settings::migrate(settings);
    state.set_settings(migrated.clone());
    settings::save_settings(&migrated).map_err(|e| e.to_string())?;
    Ok(migrated)
}

#[tauri::command]
pub fn get_config(state: State<AppState>) -> LogsConfig {
    state.config()
}

#[tauri::command]
pub fn save_config(
    state: State<AppState>,
    config: serde_json::Value,
) -> Result<LogsConfig, String> {
    let migrated = settings::migrate_config(config);
    state.set_config(migrated.clone());
    settings::save_config(&migrated).map_err(|e| e.to_string())?;
    state.reconcile_tails();
    Ok(migrated)
}

#[tauri::command]
pub fn list_sources(state: State<AppState>) -> Vec<SourceStatus> {
    let counts = state.with_store(|store| store.counts());
    state
        .sources()
        .into_iter()
        .map(|source| SourceStatus {
            lines: counts.get(&source.id).copied().unwrap_or(0),
            // A configured source has an id the config knows; a session one
            // does not, which is what the pin button keys off.
            pinned: state.config().sources.iter().any(|s| s.id == source.id),
            source,
        })
        .collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    #[serde(flatten)]
    pub source: LogSource,
    pub lines: usize,
    pub pinned: bool,
}

#[tauri::command]
pub fn add_source(state: State<AppState>, path: String) -> Option<LogSource> {
    let added = state.add_session_source(&path);
    state.reconcile_tails();
    added
}

#[tauri::command]
pub fn remove_source(state: State<AppState>, id: String) {
    state.remove_source(&id);
    state.reconcile_tails();
}

#[tauri::command]
pub fn set_source_enabled(state: State<AppState>, id: String, enabled: bool) {
    state.set_source_enabled(&id, enabled);
    state.reconcile_tails();
}

#[tauri::command]
pub fn pin_source(state: State<AppState>, id: String) -> Result<Option<LogSource>, String> {
    let pinned = state.pin_source(&id);
    if pinned.is_some() {
        settings::save_config(&state.config()).map_err(|e| e.to_string())?;
    }
    Ok(pinned)
}

/// Re-read a source from the top of its file.
#[tauri::command]
pub fn reload_source(state: State<AppState>, id: String) {
    state.with_store(|store| store.clear_source(&id));
    state.with_tails(|tails| {
        if let Some(tail) = tails.get_mut(&id) {
            tail.rewind();
        }
    });
}

/// Apply a filter and return the view it produces.
///
/// An invalid regex comes back as an `Err` carrying one line of explanation,
/// which the filter bar shows inline. The previous view stays on screen — a
/// half-typed pattern should not blank the window.
#[tauri::command]
pub fn set_filter(state: State<AppState>, filter: FilterSpec) -> Result<View, String> {
    let matcher = Matcher::build(&filter)?;
    state.set_filter(filter);
    Ok(render(&state, &matcher))
}

/// Re-run the current filter. This is also the "sort it properly" path: unlike
/// the incremental appends of follow mode, it orders the whole view.
#[tauri::command]
pub fn refresh(state: State<AppState>) -> Result<View, String> {
    let matcher = Matcher::build(&state.filter())?;
    Ok(render(&state, &matcher))
}

#[tauri::command]
pub fn clear(state: State<AppState>) -> Result<View, String> {
    state.with_store(|store| store.clear());
    refresh(state)
}

fn render(state: &State<AppState>, matcher: &Matcher) -> View {
    let highlighter = Highlighter::build(&state.config().highlights);
    let window = state.settings().window;
    state.with_store(|store| store.query(matcher, &highlighter, window))
}

/// Everything currently shown, as text — for pasting into a ticket.
#[tauri::command]
pub fn copy_view(state: State<AppState>) -> Result<String, String> {
    let matcher = Matcher::build(&state.filter())?;
    let view = render(&state, &matcher);
    Ok(view
        .lines
        .iter()
        .map(|line| line.line.text.as_str())
        .collect::<Vec<_>>()
        .join("\n"))
}

/// Show a source's file in Explorer. Takes an id rather than a path, so the
/// renderer can only reveal something it is already watching.
#[tauri::command]
pub fn reveal_source(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let source = state
        .sources()
        .into_iter()
        .find(|s| s.id == id)
        .ok_or("No such source")?;
    reveal(&app, &source.path)
}

fn reveal(app: &AppHandle, path: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

/// Ask the user for files to open.
#[tauri::command]
pub async fn pick_files(app: AppHandle) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Logs", &["log", "txt", "out", "err"])
        .add_filter("All files", &["*"])
        .pick_files(move |paths| {
            let _ = tx.send(paths);
        });

    let chosen = tokio::task::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .ok()
        .flatten()
        .unwrap_or_default();

    let state = app.state::<AppState>();
    let paths: Vec<String> = chosen.into_iter().map(|p| p.to_string()).collect();
    for path in &paths {
        state.add_session_source(path);
    }
    state.reconcile_tails();
    paths
}

/// Open a sibling suite app — Dev Hub, the notebook — from the Log Viewer's
/// menu. The path comes from the registry, never from the renderer.
#[tauri::command]
pub fn open_sibling(id: String) -> Result<(), String> {
    let exe = suite_registry::find_exe(&id).ok_or("That app is not installed, or has moved")?;
    std::process::Command::new(&exe)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not start {}: {e}", exe.display()))
}

#[tauri::command]
pub fn reveal_config_file(app: AppHandle) -> Result<(), String> {
    reveal(&app, &settings::config_file().to_string_lossy())
}
