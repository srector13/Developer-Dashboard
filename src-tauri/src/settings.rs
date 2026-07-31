//! Portable settings, the user's `hub.config.json`, and the data directory.
//!
//! Two files live side by side in the portable data dir:
//!
//!   settings.json     app state — theme, shortcut, which providers are on
//!   hub.config.json   the user's *content* — projects, URLs, endpoints, todos
//!
//! They are deliberately separate so the config can be hand-edited (and kept in
//! a dotfiles repo) without dragging app state along with it. Both are merged
//! onto their defaults on read, so a partial file never silently loses keys.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// settings.json
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderToggles {
    pub launch: bool,
    pub projects: bool,
    pub todos: bool,
    pub health: bool,
}

impl Default for ProviderToggles {
    fn default() -> Self {
        Self {
            launch: true,
            projects: true,
            todos: true,
            health: true,
        }
    }
}

impl ProviderToggles {
    pub fn enabled(&self, id: &str) -> bool {
        match id {
            "launch" => self.launch,
            "projects" => self.projects,
            "todos" => self.todos,
            "health" => self.health,
            // `command` providers are opt-in by existing in the config at all.
            _ => true,
        }
    }
}

/// Inert in v1. It exists so the AI panel can be added later without a settings
/// migration, and it has the same shape as `AiSettings` in Markdown Notebook.
/// Do not build UI against it yet.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub enabled: bool,
    pub provider: String,
    pub base_url: String,
    pub model: String,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: "openai-compatible".into(),
            base_url: String::new(),
            model: String::new(),
        }
    }
}

/// One card's size on the dashboard grid.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardLayout {
    /// Columns to span. Clamped against the grid width when it renders.
    #[serde(default = "one")]
    pub span: u32,
    /// Body height in pixels; `None` means size to content.
    #[serde(default)]
    pub height: Option<u32>,
}

fn one() -> u32 {
    1
}

impl Default for CardLayout {
    fn default() -> Self {
        Self {
            span: 1,
            height: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    /// System-wide launcher shortcut; an empty string switches it off.
    pub launcher_shortcut: String,
    /// Keep running in the tray when the dashboard window is closed, so the
    /// global shortcut stays live.
    pub keep_in_tray: bool,
    pub start_minimized: bool,
    pub dashboard_columns: u32,
    pub providers: ProviderToggles,
    /// Start with Windows. Mirrors the registry Run key rather than owning the
    /// truth — `startup::is_enabled` is authoritative, since the user can
    /// remove the entry from Task Manager behind our back.
    #[serde(default)]
    pub run_at_login: bool,
    /// Desktop notification when a watched service changes state. Off by
    /// default: an app that starts popping toasts unasked is one you mute.
    #[serde(default)]
    pub notify_on_failure: bool,
    /// False until first-run setup has been completed or dismissed.
    #[serde(default)]
    pub setup_complete: bool,
    /// Per-card layout from the dashboard's resize handles, keyed by provider.
    #[serde(default)]
    pub card_layout: std::collections::HashMap<String, CardLayout>,
    pub ai: AiSettings,
    /// Card collapse state, keyed by provider id. Written by the dashboard.
    #[serde(default)]
    pub collapsed: Vec<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            launcher_shortcut: "CommandOrControl+Shift+Space".into(),
            keep_in_tray: true,
            start_minimized: false,
            dashboard_columns: 2,
            providers: ProviderToggles::default(),
            run_at_login: false,
            notify_on_failure: false,
            setup_complete: false,
            card_layout: std::collections::HashMap::new(),
            ai: AiSettings::default(),
            collapsed: Vec::new(),
        }
    }
}

/// Merge a partial settings object read from disk (or sent by the renderer)
/// onto the defaults, so an old or hand-trimmed file keeps every key it did
/// not mention.
pub fn migrate(raw: serde_json::Value) -> AppSettings {
    let defaults = serde_json::to_value(AppSettings::default()).unwrap();
    let merged = merge_shallow(defaults, raw);
    let mut settings: AppSettings =
        serde_json::from_value(merged).unwrap_or_else(|_| AppSettings::default());

    // A zero-column grid renders nothing at all; clamp rather than trusting the
    // file, which a person edits by hand.
    settings.dashboard_columns = settings.dashboard_columns.clamp(1, 4);
    settings
}

/// Object merge one level deep, so `providers` / `ai` sub-objects keep the
/// default for any key the caller omitted (matching the JS spread).
fn merge_shallow(base: serde_json::Value, over: serde_json::Value) -> serde_json::Value {
    let (mut base_map, over_map) = match (base, over) {
        (serde_json::Value::Object(b), serde_json::Value::Object(o)) => (b, o),
        (b, _) => return b,
    };
    for (key, value) in over_map {
        if value.is_null() {
            continue;
        }
        match (base_map.get(&key), &value) {
            (Some(serde_json::Value::Object(_)), serde_json::Value::Object(_)) => {
                let existing = base_map.get(&key).cloned().unwrap();
                base_map.insert(key, merge_shallow(existing, value));
            }
            _ => {
                base_map.insert(key, value);
            }
        }
    }
    serde_json::Value::Object(base_map)
}

// ---------------------------------------------------------------------------
// hub.config.json — the user's content
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunSpec {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchEntry {
    pub title: String,
    #[serde(default)]
    pub subtitle: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub run: Option<RunSpec>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenWith {
    pub label: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsConfig {
    pub roots: Vec<String>,
    pub max_depth: usize,
    pub open_with: Vec<OpenWith>,
}

impl Default for ProjectsConfig {
    fn default() -> Self {
        Self {
            roots: Vec::new(),
            max_depth: 3,
            open_with: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TodoOpener {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TodosConfig {
    /// Empty → auto-discover from the Markdown Notebook pointer file.
    #[serde(default)]
    pub roots: Vec<String>,
    /// Empty → every todo, whatever its tags.
    #[serde(default)]
    pub include_tags: Vec<String>,
    #[serde(default)]
    pub open_with: Option<TodoOpener>,
    /// File names to skip entirely, matched case-insensitively against the file
    /// name with or without its extension.
    ///
    /// Defaults cover the generated directory indexes a notebook app writes:
    /// those list every todo in the folder, so scanning them reports each one a
    /// second time.
    #[serde(default = "default_todo_excludes")]
    pub exclude_files: Vec<String>,
    /// Collapse todos whose text is identical, keeping the one in the most
    /// specific file. This is the belt to `exclude_files`' braces — it catches
    /// a generated index whatever it happens to be called.
    #[serde(default = "default_true")]
    pub deduplicate: bool,
}

fn default_todo_excludes() -> Vec<String> {
    ["index", "toc", "_toc", "contents", "_index", "readme"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

fn default_true() -> bool {
    true
}

impl Default for TodosConfig {
    fn default() -> Self {
        Self {
            roots: Vec::new(),
            include_tags: Vec::new(),
            open_with: None,
            exclude_files: default_todo_excludes(),
            deduplicate: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HealthEndpoint {
    pub name: String,
    pub url: String,
    #[serde(default = "default_expect")]
    pub expect: u16,
}

fn default_expect() -> u16 {
    200
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HealthConfig {
    pub interval_seconds: u64,
    pub timeout_ms: u64,
    /// Answering, but slowly enough to be a problem. A service that responds in
    /// four seconds instead of forty milliseconds is broken in the way that
    /// actually costs you an afternoon, and "200 OK" hides it completely.
    #[serde(default = "default_slow_ms")]
    pub slow_ms: u64,
    #[serde(default)]
    pub endpoints: Vec<HealthEndpoint>,
}

fn default_slow_ms() -> u64 {
    1500
}

impl Default for HealthConfig {
    fn default() -> Self {
        Self {
            interval_seconds: 60,
            timeout_ms: 4000,
            slow_ms: default_slow_ms(),
            endpoints: Vec::new(),
        }
    }
}

/// The escape hatch: run a command on an interval and read its stdout as a JSON
/// array of `Item`s. This is what makes the app extensible without a plugin ABI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandProviderConfig {
    /// Provider id; must not collide with a built-in.
    pub id: String,
    pub name: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default = "default_command_interval")]
    pub interval_seconds: u64,
    #[serde(default = "default_command_timeout")]
    pub timeout_ms: u64,
}

fn default_command_interval() -> u64 {
    300
}

fn default_command_timeout() -> u64 {
    10_000
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubConfig {
    #[serde(default)]
    pub launch: Vec<LaunchEntry>,
    #[serde(default)]
    pub projects: ProjectsConfig,
    #[serde(default)]
    pub todos: TodosConfig,
    #[serde(default)]
    pub health: HealthConfig,
    #[serde(default)]
    pub command: Vec<CommandProviderConfig>,
}

/// Merge a config read from disk onto the defaults, exactly as `migrate` does
/// for settings — a config missing the whole `health` block still gets sane
/// interval and timeout values.
pub fn migrate_config(raw: serde_json::Value) -> HubConfig {
    let defaults = serde_json::to_value(HubConfig::default()).unwrap();
    let merged = merge_shallow(defaults, raw);
    serde_json::from_value(merged).unwrap_or_default()
}

/// The config shipped on first run. Deliberately full of examples with real
/// shapes — including the `command` escape hatch — because this file is the
/// documentation most people will actually read.
pub const DEFAULT_CONFIG: &str = r#"{
  "//": "Dev Hub content config. Edit and save — the app hot-reloads it, no restart.",

  "launch": [
    { "title": "IntelliJ IDEA", "icon": "app",
      "run": { "program": "C:\\Program Files\\JetBrains\\IntelliJ IDEA\\bin\\idea64.exe" } },
    { "title": "Confluence — Team Space", "icon": "web",
      "url": "https://example.atlassian.net/wiki/spaces/TEAM" },
    { "title": "Jenkins", "icon": "web", "url": "https://jenkins.example.com",
      "keywords": ["ci", "build"] }
  ],

  "projects": {
    "roots": ["C:\\dev"],
    "maxDepth": 3,
    "openWith": [
      { "label": "IntelliJ", "program": "C:\\Program Files\\JetBrains\\IntelliJ IDEA\\bin\\idea64.exe", "args": ["{path}"] },
      { "label": "VS Code",  "program": "code",   "args": ["{path}"] },
      { "label": "Terminal", "program": "wt.exe", "args": ["-d", "{path}"] }
    ]
  },

  "todos": {
    "roots": [],
    "includeTags": [],
    "openWith": { "program": "code", "args": ["-g", "{path}:{line}"] }
  },

  "health": {
    "intervalSeconds": 60,
    "timeoutMs": 4000,
    "endpoints": [
      { "name": "API — local", "url": "http://localhost:8080/actuator/health", "expect": 200 }
    ]
  },

  "//command": [
    "The escape hatch. Each entry runs `program args...` every intervalSeconds and",
    "parses stdout as a JSON array of items. Rename the key below to \"command\" to",
    "switch the example on. Item shape:",
    "  { \"id\": \"...\", \"title\": \"...\", \"subtitle\": \"...\", \"status\": \"ok|warn|error|neutral\",",
    "    \"badges\": [\"...\"], \"actions\": [{ \"kind\": \"openUrl\", \"label\": \"Open\", \"url\": \"...\" }] }"
  ],
  "//commandExample": [
    { "id": "prs", "name": "My pull requests",
      "program": "gh",
      "args": ["pr", "list", "--author", "@me", "--json", "title,url",
               "--template", "[{{range .}}{\"id\":\"{{.url}}\",\"title\":\"{{.title}}\",\"actions\":[{\"kind\":\"openUrl\",\"label\":\"Open\",\"url\":\"{{.url}}\"}]},{{end}}]"],
      "intervalSeconds": 300 }
  ],

  "command": []
}
"#;

// ---------------------------------------------------------------------------
// Where state lives
// ---------------------------------------------------------------------------

/// Portable mode is the only mode this build ships in: all app state lives in
/// `DevHubData` beside the executable, so the app travels with a USB stick or a
/// Downloads folder. If that folder can't be created (the exe was dropped
/// somewhere read-only, e.g. Program Files), fall back to the per-user AppData
/// location rather than failing to start.
pub fn user_data_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sidecar = dir.join("DevHubData");
            if std::fs::create_dir_all(&sidecar).is_ok() && is_writable(&sidecar) {
                return sidecar;
            }
        }
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| dirs_home().map(|h| h.join(".config")))
        .unwrap_or_else(std::env::temp_dir);
    let fallback = base.join("DevHub");
    let _ = std::fs::create_dir_all(&fallback);
    fallback
}

fn is_writable(dir: &Path) -> bool {
    let probe = dir.join(".write-probe");
    match std::fs::write(&probe, b"") {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

pub fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

pub fn settings_file() -> PathBuf {
    user_data_dir().join("settings.json")
}

pub fn config_file() -> PathBuf {
    user_data_dir().join("hub.config.json")
}

pub fn usage_file() -> PathBuf {
    user_data_dir().join("usage.json")
}

// ---------------------------------------------------------------------------
// Markdown Notebook discovery
// ---------------------------------------------------------------------------

/// Markdown Notebook writes a per-user pointer at
/// `%USERPROFILE%\.markdown-notebook\last-notebook.json` recording where the
/// notebook lives. Reading it is how the two apps find each other with zero
/// configuration — Dev Hub never writes this file, it only follows it.
pub fn read_notebook_pointer() -> String {
    let Some(home) = dirs_home() else {
        return String::new();
    };
    let file = home.join(".markdown-notebook").join("last-notebook.json");
    let Ok(text) = std::fs::read_to_string(file) else {
        return String::new();
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("notebookRoot")?.as_str().map(|s| s.to_string()))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

pub fn load_settings() -> AppSettings {
    match std::fs::read_to_string(settings_file()) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(value) => migrate(value),
            Err(_) => AppSettings::default(),
        },
        Err(_) => AppSettings::default(),
    }
}

pub fn save_settings(settings: &AppSettings) -> std::io::Result<()> {
    let file = settings_file();
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&file, serde_json::to_string_pretty(settings)?)
}

/// Read `hub.config.json`, writing the shipped default on first run so there is
/// always a file to open from the tray. A malformed file is reported rather
/// than overwritten — losing a hand-written config to a stray comma would be
/// unforgivable.
pub fn load_config() -> Result<HubConfig, String> {
    let file = config_file();
    if !file.exists() {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&file, DEFAULT_CONFIG);
    }
    let text = std::fs::read_to_string(&file)
        .map_err(|e| format!("Could not read {}: {e}", file.display()))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("{} is not valid JSON: {e}", file.display()))?;
    Ok(migrate_config(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_serialize_with_camel_case_keys() {
        let json = serde_json::to_value(AppSettings::default()).unwrap();
        assert!(json.get("launcherShortcut").is_some());
        assert!(json.get("keepInTray").is_some());
        assert!(json.get("dashboardColumns").is_some());
        assert!(json.get("providers").unwrap().get("projects").is_some());
        assert_eq!(json.get("ai").unwrap().get("enabled").unwrap(), false);
    }

    #[test]
    fn migration_fills_missing_keys_from_defaults() {
        let settings = migrate(serde_json::json!({ "theme": "dark" }));
        assert_eq!(settings.theme, "dark");
        assert_eq!(settings.launcher_shortcut, "CommandOrControl+Shift+Space");
        assert!(settings.keep_in_tray);
        assert_eq!(settings.dashboard_columns, 2);
    }

    #[test]
    fn migration_keeps_partial_sub_objects() {
        let settings = migrate(serde_json::json!({ "providers": { "todos": false } }));
        assert!(!settings.providers.todos);
        // The keys the file didn't mention keep their defaults.
        assert!(settings.providers.projects);
        assert!(settings.providers.health);
    }

    #[test]
    fn a_hand_edited_column_count_is_clamped_rather_than_trusted() {
        assert_eq!(
            migrate(serde_json::json!({ "dashboardColumns": 0 })).dashboard_columns,
            1
        );
        assert_eq!(
            migrate(serde_json::json!({ "dashboardColumns": 99 })).dashboard_columns,
            4
        );
    }

    #[test]
    fn a_garbage_settings_file_falls_back_to_defaults_instead_of_panicking() {
        // `providers` is the wrong type entirely — deserialization fails and
        // the whole object reverts, rather than the app refusing to start.
        let settings = migrate(serde_json::json!({ "providers": 7 }));
        assert_eq!(settings, AppSettings::default());
    }

    #[test]
    fn the_shipped_default_config_parses_and_yields_working_defaults() {
        let value: serde_json::Value = serde_json::from_str(DEFAULT_CONFIG)
            .expect("the shipped hub.config.json must be valid JSON");
        let config = migrate_config(value);
        assert!(!config.launch.is_empty());
        assert_eq!(config.projects.max_depth, 3);
        assert_eq!(config.health.timeout_ms, 4000);
        // The commented-out example must not register as a live provider.
        assert!(config.command.is_empty());
    }

    #[test]
    fn a_config_missing_whole_blocks_still_gets_interval_defaults() {
        let config = migrate_config(serde_json::json!({ "launch": [] }));
        assert_eq!(config.health.interval_seconds, 60);
        assert_eq!(config.health.timeout_ms, 4000);
        assert_eq!(config.projects.max_depth, 3);
    }

    #[test]
    fn an_endpoint_without_an_expect_defaults_to_200() {
        let config = migrate_config(serde_json::json!({
            "health": { "endpoints": [{ "name": "API", "url": "http://localhost:8080/health" }] }
        }));
        assert_eq!(config.health.endpoints[0].expect, 200);
    }

    #[test]
    fn provider_toggles_default_unknown_ids_to_enabled_so_command_providers_run() {
        let toggles = ProviderToggles::default();
        assert!(toggles.enabled("projects"));
        assert!(toggles.enabled("prs"));
        let off = ProviderToggles {
            projects: false,
            ..Default::default()
        };
        assert!(!off.enabled("projects"));
    }
}
