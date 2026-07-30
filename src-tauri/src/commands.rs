//! Every `#[tauri::command]`, and the action executor behind them.
//!
//! **Action execution is backend-only.** The renderer sends an item key and an
//! action index; it can never name a program to run. The action is resolved
//! against the current provider cache, so the only programs that can start are
//! ones a provider put there — which means ones the user's own config file
//! described.

use crate::model::{Action, Item, ProviderResult};
use crate::registry;
use crate::search;
use crate::settings::{self, AppSettings, HubConfig};
use crate::state::AppState;
use crate::{desktop, util};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

// ---------------------------------------------------------------------------
// Settings and app
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> AppSettings {
    state.settings()
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<AppState>,
    settings: serde_json::Value,
) -> AppSettings {
    let before = state.settings();
    let after = state.update_settings(settings);

    if before.launcher_shortcut != after.launcher_shortcut {
        desktop::apply_shortcut(&app, &after);
    }
    if before.providers != after.providers {
        registry::restart(&app);
    }
    after
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPayload {
    /// The file as it is on disk, comments and all — this is what the user
    /// edits, so it must round-trip exactly.
    pub text: String,
    pub path: String,
    pub error: Option<String>,
}

#[tauri::command]
pub fn get_config(state: State<AppState>) -> ConfigPayload {
    let path = settings::config_file();
    ConfigPayload {
        text: std::fs::read_to_string(&path).unwrap_or_default(),
        path: util::display_path(&path),
        error: state.config_error(),
    }
}

/// Write the config back. The text is validated before it touches the disk, so
/// a typo in the editor can't leave the app with an unreadable config.
#[tauri::command]
pub fn save_config(app: AppHandle, state: State<AppState>, text: String) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Not valid JSON: {e}"))?;
    let config: HubConfig = settings::migrate_config(value);

    std::fs::write(settings::config_file(), &text).map_err(|e| e.to_string())?;
    state.set_config(config);
    registry::restart(&app);
    Ok(())
}

/// Open `hub.config.json` in whatever the user's machine associates with .json.
pub fn open_config_file(app: &AppHandle) {
    let path = settings::config_file();
    if !path.exists() {
        let _ = std::fs::write(&path, settings::DEFAULT_CONFIG);
    }
    if let Err(err) = app
        .opener()
        .open_path(path.to_string_lossy().to_string(), None::<&str>)
    {
        eprintln!("Could not open the config file: {err}");
    }
}

#[tauri::command]
pub fn reveal_config_file(app: AppHandle) {
    open_config_file(&app);
}

// ---------------------------------------------------------------------------
// Providers and items
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub refresh_interval: u64,
    pub refreshed_at: i64,
    pub item_count: usize,
    pub error: Option<String>,
}

#[tauri::command]
pub fn list_providers(state: State<AppState>) -> Vec<ProviderInfo> {
    let settings = state.settings();
    let config = state.config();
    registry::build(&settings, &config)
        .into_iter()
        .map(|provider| {
            let cached = state.result(provider.id());
            ProviderInfo {
                id: provider.id().to_string(),
                name: provider.display_name().to_string(),
                enabled: true,
                refresh_interval: provider.refresh_interval(),
                refreshed_at: cached.as_ref().map(|r| r.refreshed_at).unwrap_or(0),
                item_count: cached.as_ref().map(|r| r.items.len()).unwrap_or(0),
                error: cached.and_then(|r| r.error),
            }
        })
        .collect()
}

/// The cached results, in the order the registry builds providers — which is
/// the order the cards appear on the dashboard.
#[tauri::command]
pub fn get_results(state: State<AppState>) -> Vec<ProviderResult> {
    let settings = state.settings();
    let config = state.config();
    registry::build(&settings, &config)
        .into_iter()
        .map(|provider| {
            state
                .result(provider.id())
                .unwrap_or_else(|| ProviderResult::pending(provider.id(), provider.display_name()))
        })
        .collect()
}

#[tauri::command]
pub fn get_items(state: State<AppState>, provider: Option<String>) -> Vec<Item> {
    state.items(provider.as_deref())
}

#[tauri::command]
pub async fn refresh_provider(app: AppHandle, provider: String) -> Result<ProviderResult, String> {
    registry::refresh_provider(&app, &provider).await
}

#[tauri::command]
pub async fn refresh_all(app: AppHandle) -> Vec<ProviderResult> {
    registry::refresh_all(&app).await
}

#[tauri::command]
pub fn search_items(
    state: State<AppState>,
    query: String,
    provider: Option<String>,
    max_results: Option<usize>,
) -> Vec<Item> {
    let items = state.items(provider.as_deref());
    let usage = state.usage();
    search::search(
        items.iter(),
        &query,
        &usage,
        util::now_secs(),
        max_results.or(Some(50)),
    )
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub success: bool,
    pub message: Option<String>,
    /// Present only for `Run { capture: true }`.
    pub output: Option<String>,
}

impl ActionResult {
    fn ok() -> Self {
        Self {
            success: true,
            message: None,
            output: None,
        }
    }

    fn failed(message: impl Into<String>) -> Self {
        Self {
            success: false,
            message: Some(message.into()),
            output: None,
        }
    }
}

/// Run the action at `action_index` on the item with key `item_id`.
///
/// The item is looked up in the live cache; an index that doesn't exist, or a
/// key that isn't in the cache, is rejected. That is the whole security model
/// for execution, and it's why the renderer never sees a program name.
#[tauri::command]
pub async fn run_action(app: AppHandle, item_id: String, action_index: usize) -> ActionResult {
    let item = {
        let state = app.state::<AppState>();
        state.find_item(&item_id)
    };
    let Some(item) = item else {
        return ActionResult::failed(format!(
            "{item_id} is no longer in the cache — refresh and try again."
        ));
    };
    let Some(action) = item.actions.get(action_index).cloned() else {
        return ActionResult::failed(format!("{} has no action {action_index}.", item.title));
    };

    let mut result = execute(&app, &action).await;
    if result.success {
        app.state::<AppState>().record_usage(&item_id);
    } else if let Some(message) = result.message.take() {
        // Name the action that failed: "Could not run code: …" is a lot less
        // useful than "VS Code — could not run code: …" when an item has five.
        result.message = Some(format!("{} — {message}", action.label()));
    }
    result
}

async fn execute(app: &AppHandle, action: &Action) -> ActionResult {
    match action {
        Action::OpenUrl { url, .. } => match app.opener().open_url(url.clone(), None::<&str>) {
            Ok(_) => ActionResult::ok(),
            Err(err) => ActionResult::failed(format!("Could not open {url}: {err}")),
        },
        Action::OpenPath { path, .. } => match app.opener().open_path(path.clone(), None::<&str>) {
            Ok(_) => ActionResult::ok(),
            Err(err) => ActionResult::failed(format!("Could not open {path}: {err}")),
        },
        Action::CopyText { text, .. } => match app.clipboard().write_text(text.clone()) {
            Ok(_) => ActionResult {
                success: true,
                message: Some("Copied".into()),
                output: None,
            },
            Err(err) => ActionResult::failed(format!("Could not copy: {err}")),
        },
        Action::Reveal { path, .. } => reveal(path),
        Action::Run {
            program,
            args,
            cwd,
            capture,
            ..
        } => {
            let spec = RunSpec {
                program: program.clone(),
                args: args.clone(),
                cwd: cwd.clone(),
                capture: *capture,
            };
            tokio::task::spawn_blocking(move || run_program(&spec))
                .await
                .unwrap_or_else(|err| ActionResult::failed(format!("Could not start it: {err}")))
        }
    }
}

struct RunSpec {
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    capture: bool,
}

/// Build the command for a program name.
///
/// On Windows, `CreateProcess` only ever appends `.exe`, so a config entry of
/// `code` or `npm` — which are really `code.cmd` and `npm.cmd` — would fail to
/// launch with a bare "not found". Anything that isn't already an `.exe` goes
/// through `cmd /C`, which does consult PATHEXT.
fn build_command(spec: &RunSpec) -> std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let is_exe = std::path::Path::new(&spec.program)
            .extension()
            .map(|e| e.eq_ignore_ascii_case("exe"))
            .unwrap_or(false);

        let mut command = if is_exe {
            let mut command = std::process::Command::new(&spec.program);
            command.args(&spec.args);
            command
        } else {
            let mut command = std::process::Command::new("cmd");
            command.arg("/C").arg(&spec.program).args(&spec.args);
            command
        };
        // Never flash a console — this app is summoned from a hotkey.
        command.creation_flags(CREATE_NO_WINDOW);
        if let Some(cwd) = spec.cwd.as_deref().filter(|c| !c.trim().is_empty()) {
            command.current_dir(cwd);
        }
        command
    }
    #[cfg(not(windows))]
    {
        let mut command = std::process::Command::new(&spec.program);
        command.args(&spec.args);
        if let Some(cwd) = spec.cwd.as_deref().filter(|c| !c.trim().is_empty()) {
            command.current_dir(cwd);
        }
        command
    }
}

fn run_program(spec: &RunSpec) -> ActionResult {
    if spec.program.trim().is_empty() {
        return ActionResult::failed("No program configured for that action.");
    }
    let mut command = build_command(spec);

    if spec.capture {
        return match command.output() {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                ActionResult {
                    success: output.status.success(),
                    message: (!output.status.success())
                        .then(|| format!("{} exited with {}", spec.program, output.status)),
                    output: Some(if stdout.is_empty() { stderr } else { stdout }),
                }
            }
            Err(err) => ActionResult::failed(format!("Could not run {}: {err}", spec.program)),
        };
    }

    // Fire and forget: an IDE takes seconds to appear and must not hold the
    // launcher open while it does.
    match command.spawn() {
        Ok(_) => ActionResult::ok(),
        Err(err) => ActionResult::failed(format!("Could not run {}: {err}", spec.program)),
    }
}

fn reveal(path: &str) -> ActionResult {
    #[cfg(windows)]
    let mut command = {
        // explorer takes the path as part of the /select, token, and returns a
        // non-zero exit code even on success — so it is spawned, not waited on.
        let mut command = std::process::Command::new("explorer");
        command.arg(format!("/select,{path}"));
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg("-R").arg(path);
        command
    };
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let mut command = {
        let parent = std::path::Path::new(path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from(path));
        let mut command = std::process::Command::new("xdg-open");
        command.arg(parent);
        command
    };

    match command.spawn() {
        Ok(_) => ActionResult::ok(),
        Err(err) => ActionResult::failed(format!("Could not reveal {path}: {err}")),
    }
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Launcher window
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherContext {
    pub theme: String,
    pub version: String,
    /// Provider ids that currently have items, so the launcher can grey out an
    /// orb for a provider the user hasn't configured yet.
    pub providers: Vec<String>,
}

#[tauri::command]
pub fn launcher_context(app: AppHandle, state: State<AppState>) -> LauncherContext {
    let settings = state.settings();
    LauncherContext {
        theme: settings.theme,
        version: app.package_info().version.to_string(),
        providers: state
            .results()
            .into_iter()
            .filter(|r| !r.items.is_empty())
            .map(|r| r.provider)
            .collect(),
    }
}

#[tauri::command]
pub fn launcher_resize(app: AppHandle, height: f64) {
    desktop::resize_launcher(&app, height);
}

#[tauri::command]
pub fn launcher_hide(app: AppHandle) {
    desktop::hide_launcher_window(&app);
}

#[tauri::command]
pub fn show_launcher(app: AppHandle) {
    desktop::show_launcher_window(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_program_is_refused_before_anything_is_spawned() {
        let result = run_program(&RunSpec {
            program: "   ".into(),
            args: vec![],
            cwd: None,
            capture: false,
        });
        assert!(!result.success);
        assert!(result.message.unwrap().contains("No program"));
    }

    #[test]
    fn a_missing_program_reports_which_one_failed() {
        let result = run_program(&RunSpec {
            program: "dev-hub-definitely-not-installed".into(),
            args: vec![],
            cwd: None,
            capture: false,
        });
        assert!(!result.success);
        assert!(result
            .message
            .unwrap()
            .contains("dev-hub-definitely-not-installed"));
    }

    #[test]
    fn a_captured_run_returns_the_programs_stdout() {
        // `cmd /C echo` on Windows, `echo` elsewhere — build_command picks.
        let result = run_program(&RunSpec {
            program: "echo".into(),
            args: vec!["hello".into()],
            cwd: None,
            capture: true,
        });
        assert!(result.success, "{:?}", result.message);
        assert_eq!(result.output.unwrap().trim(), "hello");
    }

    #[cfg(windows)]
    #[test]
    fn non_exe_programs_go_through_cmd_so_shims_like_code_cmd_resolve() {
        let spec = RunSpec {
            program: "code".into(),
            args: vec!["C:\\dev".into()],
            cwd: None,
            capture: false,
        };
        let command = build_command(&spec);
        assert_eq!(command.get_program(), "cmd");
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args[0], "/C");
        assert_eq!(args[1], "code");
    }

    #[cfg(windows)]
    #[test]
    fn an_explicit_exe_is_launched_directly() {
        let spec = RunSpec {
            program: "C:\\bin\\idea64.exe".into(),
            args: vec![],
            cwd: None,
            capture: false,
        };
        assert_eq!(build_command(&spec).get_program(), "C:\\bin\\idea64.exe");
    }
}
