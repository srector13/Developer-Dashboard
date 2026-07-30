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
    // The launcher reads its appearance once, when it opens. Tell the open one
    // to re-read so a slider in Settings moves something you can see.
    if before.launcher != after.launcher {
        desktop::refresh_launcher_context(&app);
    }
    after
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupSuggestions {
    pub tools: Vec<crate::detect::DetectedTool>,
    pub repo_roots: Vec<String>,
    /// The notebook Markdown Notebook last opened, if it left a pointer.
    pub notebook_root: String,
}

/// What first-run setup can offer without asking: the IDEs and terminals
/// actually installed, folders that look like they hold checkouts, and the
/// notebook the sibling app already knows about.
#[tauri::command]
pub fn setup_suggestions() -> SetupSuggestions {
    SetupSuggestions {
        tools: crate::detect::detect_tools(),
        repo_roots: crate::detect::detect_repo_roots(),
        notebook_root: settings::read_notebook_pointer(),
    }
}

#[tauri::command]
pub fn run_at_login() -> bool {
    crate::startup::is_enabled()
}

/// Toggle the Run key, then mirror the result into settings.
///
/// The registry is the source of truth, not settings.json — the entry can be
/// removed from Task Manager behind the app's back, and a checkbox that
/// disagreed with reality would be worse than not having one.
#[tauri::command]
pub fn set_run_at_login(state: State<AppState>, enabled: bool) -> Result<bool, String> {
    crate::startup::set_enabled(enabled)?;
    let actual = crate::startup::is_enabled();
    state.update_settings(serde_json::json!({ "runAtLogin": actual }));
    Ok(actual)
}

// ---------------------------------------------------------------------------
// The launcher hotkey
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn shortcut_status(state: State<AppState>) -> crate::state::ShortcutStatus {
    state.shortcut_status()
}

#[tauri::command]
pub fn shortcut_suggestions() -> Vec<&'static str> {
    desktop::FALLBACK_SHORTCUTS.to_vec()
}

/// Set the launcher hotkey and report whether the OS accepted it.
///
/// Returned rather than fire-and-forget: the settings screen shows the outcome
/// immediately, so a combination another app already owns is visible at the
/// moment you choose it instead of the next time you press it and nothing
/// happens.
#[tauri::command]
pub fn set_launcher_shortcut(
    app: AppHandle,
    state: State<AppState>,
    accelerator: String,
) -> crate::state::ShortcutStatus {
    let settings = state.update_settings(serde_json::json!({
        "launcherShortcut": accelerator.trim(),
    }));
    desktop::apply_shortcut(&app, &settings)
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

/// The parsed config, for the settings screen's structured editors.
#[tauri::command]
pub fn get_config_json(state: State<AppState>) -> HubConfig {
    state.config()
}

/// Write the config from the settings screen's structured form.
///
/// This normalises the file: it is re-serialised from the parsed shape, so
/// comments and any unrecognised keys in a hand-written config are dropped.
/// That is the trade for editing it in a UI — the Advanced tab keeps the raw
/// text editor for anyone who wants to keep comments.
#[tauri::command]
pub fn save_config_json(
    app: AppHandle,
    state: State<AppState>,
    config: serde_json::Value,
) -> Result<HubConfig, String> {
    let parsed = settings::migrate_config(config);
    let text = serde_json::to_string_pretty(&parsed).map_err(|e| e.to_string())?;
    std::fs::write(settings::config_file(), format!("{text}\n")).map_err(|e| {
        format!(
            "Could not write {}: {e}",
            util::display_path(&settings::config_file())
        )
    })?;
    state.set_config(parsed.clone());
    registry::restart(&app);
    Ok(parsed)
}

// ---------------------------------------------------------------------------
// File pickers
//
// Typing a Windows program path by hand is how `hub.config.json` entries end up
// subtly wrong, so the settings screen browses for them instead.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    // Blocking picker on a command's worker thread — never the UI thread.
    app.dialog()
        .file()
        .set_title("Choose a folder")
        .blocking_pick_folder()
        .map(|path| path.to_string())
}

#[tauri::command]
pub async fn pick_program(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let dialog = app.dialog().file().set_title("Choose a program");
    let dialog = if cfg!(windows) {
        dialog.add_filter("Programs", &["exe", "cmd", "bat", "com"])
    } else {
        dialog
    };
    dialog.blocking_pick_file().map(|path| path.to_string())
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
/// The program is resolved to a concrete executable first (see
/// `util::resolve_program`), so a name that isn't installed fails *here*, with
/// a message naming it, instead of appearing to launch. A resolved batch file
/// still has to go through the interpreter, but by then we know it exists.
fn build_command(spec: &RunSpec) -> Result<std::process::Command, String> {
    let resolved = util::resolve_program(&spec.program).ok_or_else(|| {
        format!(
            "{} is not installed, or not on the PATH this app inherited.",
            spec.program
        )
    })?;

    let mut command = if util::needs_command_interpreter(&resolved) {
        let mut command = std::process::Command::new("cmd");
        command.arg("/C").arg(&resolved).args(&spec.args);
        command
    } else {
        let mut command = std::process::Command::new(&resolved);
        command.args(&spec.args);
        command
    };

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Never flash a console — this app is summoned from a hotkey.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    if let Some(cwd) = spec.cwd.as_deref().filter(|c| !c.trim().is_empty()) {
        command.current_dir(cwd);
    }
    Ok(command)
}

fn run_program(spec: &RunSpec) -> ActionResult {
    if spec.program.trim().is_empty() {
        return ActionResult::failed("No program configured for that action.");
    }
    let mut command = match build_command(spec) {
        Ok(command) => command,
        Err(message) => return ActionResult::failed(message),
    };

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
    /// Appearance and behaviour, handed over at open time so the launcher never
    /// has to make a second round trip before it can draw itself.
    pub launcher: crate::settings::LauncherSettings,
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
        launcher: settings.launcher,
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

    /// A program that exists on every machine CI runs on. `echo` is a cmd
    /// *builtin* on Windows, not an executable, so it can't be the one.
    fn echo_spec(text: &str) -> RunSpec {
        if cfg!(windows) {
            RunSpec {
                program: "cmd".into(),
                args: vec!["/C".into(), "echo".into(), text.into()],
                cwd: None,
                capture: true,
            }
        } else {
            RunSpec {
                program: "echo".into(),
                args: vec![text.into()],
                cwd: None,
                capture: true,
            }
        }
    }

    #[test]
    fn a_captured_run_returns_the_programs_stdout() {
        let result = run_program(&echo_spec("hello"));
        assert!(result.success, "{:?}", result.message);
        assert_eq!(result.output.unwrap().trim(), "hello");
    }

    /// The regression this whole resolution path exists for: a fire-and-forget
    /// spawn of a program that isn't installed used to start `cmd` (which
    /// succeeds) and only then fail to find the program, so the launcher
    /// reported success, hid itself, and nothing happened.
    #[test]
    fn a_fire_and_forget_run_of_a_missing_program_still_fails() {
        let result = run_program(&RunSpec {
            program: "dev-hub-definitely-not-installed".into(),
            args: vec!["--flag".into()],
            cwd: None,
            capture: false,
        });
        assert!(!result.success);
    }

    #[test]
    fn a_resolved_batch_file_goes_through_the_interpreter() {
        assert!(util::needs_command_interpreter(std::path::Path::new(
            "C:\\bin\\code.cmd"
        )));
        assert!(util::needs_command_interpreter(std::path::Path::new(
            "C:\\bin\\build.BAT"
        )));
        // An exe is launched directly — no cmd in the middle to swallow errors.
        assert!(!util::needs_command_interpreter(std::path::Path::new(
            "C:\\bin\\idea64.exe"
        )));
    }

    #[cfg(windows)]
    #[test]
    fn a_bare_name_resolves_through_path_and_pathext() {
        // cmd.exe is on the PATH of every Windows machine, without its
        // extension being spelled out.
        let resolved = util::resolve_program("cmd").expect("cmd must resolve");
        assert!(resolved.is_file());
        assert_eq!(
            resolved
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase()),
            Some("exe".to_string())
        );
    }

    #[cfg(windows)]
    #[test]
    fn an_absolute_path_is_used_as_given_and_never_looked_up_on_path() {
        assert!(util::resolve_program("C:\\definitely\\not\\here.exe").is_none());
    }
}
