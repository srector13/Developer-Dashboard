//! Portable settings, the user's `hub.config.json`, and the data directory.
//!
//! Two files live side by side in the portable data dir:
//!
//!   settings.json     app state — theme, shortcut, which providers are on
//!   hub.config.json   the user's *content* — projects, URLs, endpoints, todos
//!
//! They are deliberately separate so the config can be hand-edited (and kept in
//! a dotfiles repo) without dragging app state along with it. Both are merged
//! onto their defaults on read, so a partial file never silently loses keys —
//! `suite-config` owns that mechanism now, and every app in the suite gets the
//! same guarantee from it.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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

/// Everything about the quick launcher except its hotkey, which stays at the
/// top level because it predates this block and is read from several places.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LauncherSettings {
    /// Opacity of the launcher's glass panel, 0.5–1.0.
    ///
    /// The reference app used 0.72, which reads beautifully over a desktop and
    /// badly over a busy window — the text behind it competes with the text in
    /// it. The default here is higher, and it's adjustable because how
    /// transparent is too transparent depends on what you keep on screen.
    pub opacity: f64,
    /// The `Enter to open · Tab switches mode` row along the bottom. Worth
    /// having while the keyboard model is new, worth reclaiming afterwards.
    pub show_hints: bool,
    /// Which mode orbs appear, in order. An empty list means all of them —
    /// a launcher with no modes would have nothing to search.
    pub modes: Vec<String>,
    /// How many matches to list.
    pub max_results: u32,
    /// With an empty box, list the things you open most instead of nothing.
    pub show_recent_when_empty: bool,
}

impl Default for LauncherSettings {
    fn default() -> Self {
        Self {
            opacity: 0.88,
            show_hints: true,
            modes: LAUNCHER_MODES.iter().map(|m| m.to_string()).collect(),
            max_results: 40,
            show_recent_when_empty: true,
        }
    }
}

/// Every mode the launcher knows, in orb order. The renderer owns their labels
/// and icons; this is the list settings validates against.
pub const LAUNCHER_MODES: &[&str] = &["all", "projects", "launch", "todos", "health"];

/// A user's personal edits to one item, keyed by `Item::key()`.
///
/// Providers own what an item *is*; this owns what you want it called and how
/// you want it to look. Kept in settings.json rather than hub.config.json
/// because it is decoration rather than content — and because an item's key
/// only means anything alongside the provider that produced it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ItemOverride {
    /// Shown instead of the provider's title. Searched, too, so renaming an
    /// item to what you actually call it makes it findable by that name.
    #[serde(default)]
    pub nickname: Option<String>,
    /// A token from the renderer's fixed icon set.
    #[serde(default)]
    pub icon: Option<String>,
    /// `#rgb` or `#rrggbb`. Validated on the way in — it reaches a style
    /// attribute, so anything else is refused rather than sanitised.
    #[serde(default)]
    pub accent: Option<String>,
    /// Hidden from every surface until unhidden from Settings.
    #[serde(default)]
    pub hidden: bool,
}

impl ItemOverride {
    /// Is this override doing anything? An empty one is dropped rather than
    /// stored, so settings.json doesn't accumulate rows that say nothing.
    pub fn is_empty(&self) -> bool {
        !self.hidden
            && self.nickname.as_deref().unwrap_or("").trim().is_empty()
            && self.icon.is_none()
            && self.accent.is_none()
    }

    /// Drop anything malformed. The accent lands in a style attribute, so it is
    /// checked against a strict hex shape rather than trusted or escaped.
    pub fn sanitised(mut self) -> Self {
        self.nickname = self
            .nickname
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty());
        self.icon = self.icon.filter(|i| !i.trim().is_empty());
        self.accent = self.accent.filter(|a| is_hex_colour(a));
        self
    }
}

fn is_hex_colour(value: &str) -> bool {
    let body = match value.strip_prefix('#') {
        Some(body) => body,
        None => return false,
    };
    matches!(body.len(), 3 | 6) && body.chars().all(|c| c.is_ascii_hexdigit())
}

/// One card's size on the dashboard grid.
///
/// Presets rather than a pixel height. Freeform dragging produced overlapping,
/// misaligned cards because a grid cell's height is not the card's to decide —
/// its neighbours share the row. Three sizes, expressed as a column span and a
/// proportion of the window, keep every row aligned by construction.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardLayout {
    /// "small" | "medium" | "large". Unknown values fall back to medium.
    #[serde(default = "default_card_size")]
    pub size: String,
    /// "list" | "grid". A list reads better for paths; a grid fits more of a
    /// launch card on screen at once.
    #[serde(default = "default_card_view")]
    pub view: String,
}

fn default_card_view() -> String {
    "list".to_string()
}

fn default_card_size() -> String {
    "medium".to_string()
}

impl Default for CardLayout {
    fn default() -> Self {
        Self {
            size: default_card_size(),
            view: default_card_view(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    /// System-wide launcher shortcut; an empty string switches it off.
    pub launcher_shortcut: String,
    #[serde(default)]
    pub launcher: LauncherSettings,
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
    /// Per-card size and view, keyed by provider.
    #[serde(default)]
    pub card_layout: std::collections::HashMap<String, CardLayout>,
    /// Personal edits to individual items, keyed by `Item::key()`.
    #[serde(default)]
    pub item_overrides: std::collections::HashMap<String, ItemOverride>,
    /// Provider ids in the order the user dragged them into. Providers missing
    /// from this list keep their registry order and land at the end, so a new
    /// card appears rather than disappearing.
    #[serde(default)]
    pub card_order: Vec<String>,
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
            launcher: LauncherSettings::default(),
            keep_in_tray: true,
            start_minimized: false,
            dashboard_columns: 2,
            providers: ProviderToggles::default(),
            run_at_login: false,
            notify_on_failure: false,
            setup_complete: false,
            card_layout: std::collections::HashMap::new(),
            item_overrides: std::collections::HashMap::new(),
            card_order: Vec::new(),
            ai: AiSettings::default(),
            collapsed: Vec::new(),
        }
    }
}

/// Merge a partial settings object read from disk (or sent by the renderer)
/// onto the defaults, so an old or hand-trimmed file keeps every key it did
/// not mention.
pub fn migrate(raw: serde_json::Value) -> AppSettings {
    let mut settings: AppSettings = suite_config::merge_onto_defaults(raw);

    // A zero-column grid renders nothing at all; clamp rather than trusting the
    // file, which a person edits by hand.
    settings.dashboard_columns = settings.dashboard_columns.clamp(1, 4);

    // An invisible launcher is not a setting anyone wants, and a fully opaque
    // one is — so the floor is "still readable", not "still visible".
    settings.launcher.opacity = if settings.launcher.opacity.is_finite() {
        settings.launcher.opacity.clamp(0.5, 1.0)
    } else {
        LauncherSettings::default().opacity
    };
    settings.launcher.max_results = settings.launcher.max_results.clamp(5, 200);

    // Drop unknown modes and de-duplicate, then fall back to the full set: a
    // launcher with no modes has nothing to search.
    settings
        .launcher
        .modes
        .retain(|mode| LAUNCHER_MODES.contains(&mode.as_str()));
    settings.launcher.modes.dedup();
    if settings.launcher.modes.is_empty() {
        settings.launcher.modes = LauncherSettings::default().modes;
    }

    settings
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
    [
        // Aggregate notes: these collect tasks that live in other files, so
        // scanning them reports every todo a second time.
        ".toc.md",
        ".tasks.md",
        // Whole-name matches for the generated directory indexes.
        "index",
        "toc",
        "_toc",
        "contents",
        "_index",
        "readme",
    ]
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
    suite_config::merge_onto_defaults(raw)
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

  "//todos": [
    "Leave roots empty and Dev Hub follows whatever notebook Markdown Notebook",
    "last opened. Leave openWith out entirely and it finds Markdown Notebook on",
    "disk too — set it only to override that, e.g. to open todos in an editor:",
    "  \"openWith\": { \"program\": \"code\", \"args\": [\"-g\", \"{path}:{line}\"] }"
  ],
  "todos": {
    "roots": [],
    "includeTags": []
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

/// Dev Hub's folder names. Portable mode is the only mode this build ships in:
/// all app state lives in `DevHubData` beside the executable, so the app
/// travels with a USB stick or a Downloads folder. `suite-config` owns the
/// resolution — including the AppData fallback for an exe dropped somewhere
/// read-only — so every app in the suite behaves the same way here.
const PORTABLE_DIR: &str = "DevHubData";
const FALLBACK_DIR: &str = "DevHub";

pub fn user_data_dir() -> PathBuf {
    suite_config::resolve_data_dir(PORTABLE_DIR, FALLBACK_DIR)
}

pub fn dirs_home() -> Option<PathBuf> {
    suite_config::home_dir()
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
// Finding the rest of the suite
// ---------------------------------------------------------------------------

/// Write Dev Hub's entry into the suite registry.
///
/// This is the whole of Dev Hub's side of discovery: say who we are, where we
/// are, and what we can be asked to do. Everything else — the Log Viewer's
/// "tail this file", a future tool's card — falls out of other apps reading it.
pub fn register_with_suite() {
    suite_registry::register(
        suite_registry::DEV_HUB,
        "Dev Hub",
        env!("CARGO_PKG_VERSION"),
        &[
            suite_registry::capability::LAUNCHER,
            suite_registry::capability::DASHBOARD,
        ],
    );
}

/// Where the notebook lives, according to whichever app last opened one.
///
/// Dev Hub only ever reads this. An aggregator has no business deciding what
/// "the current notebook" is, and the pre-registry pointer file Markdown
/// Notebook writes is still honoured as a fallback — see
/// `suite_registry::notebook_root`.
pub fn read_notebook_pointer() -> String {
    suite_registry::notebook_root()
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
    suite_config::save_json(&settings_file(), settings)
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
    fn an_accent_that_is_not_a_hex_colour_is_refused() {
        // It ends up in a style attribute, so this is a validation boundary
        // rather than a formatting preference.
        for good in ["#fff", "#FFAA33", "#0d1117"] {
            let patch = ItemOverride {
                accent: Some(good.into()),
                ..Default::default()
            }
            .sanitised();
            assert_eq!(patch.accent.as_deref(), Some(good), "{good}");
        }
        for bad in [
            "red",
            "#12",
            "#1234",
            "#gggggg",
            "javascript:alert(1)",
            "#fff; background: url(x)",
            "",
        ] {
            let patch = ItemOverride {
                accent: Some(bad.into()),
                ..Default::default()
            }
            .sanitised();
            assert_eq!(patch.accent, None, "{bad} should have been refused");
        }
    }

    #[test]
    fn an_override_that_says_nothing_is_treated_as_empty() {
        assert!(ItemOverride::default().is_empty());
        assert!(ItemOverride {
            nickname: Some("   ".into()),
            ..Default::default()
        }
        .sanitised()
        .is_empty());

        assert!(!ItemOverride {
            hidden: true,
            ..Default::default()
        }
        .is_empty());
        assert!(!ItemOverride {
            nickname: Some("Payments".into()),
            ..Default::default()
        }
        .is_empty());
    }

    #[test]
    fn a_card_view_defaults_to_list_and_survives_a_partial_entry() {
        let settings = migrate(serde_json::json!({
            "cardLayout": { "projects": { "size": "large" } }
        }));
        let layout = &settings.card_layout["projects"];
        assert_eq!(layout.size, "large");
        assert_eq!(layout.view, "list");
    }

    #[test]
    fn launcher_opacity_is_clamped_to_something_readable() {
        assert_eq!(
            migrate(serde_json::json!({ "launcher": { "opacity": 0.0 } }))
                .launcher
                .opacity,
            0.5
        );
        assert_eq!(
            migrate(serde_json::json!({ "launcher": { "opacity": 9.0 } }))
                .launcher
                .opacity,
            1.0
        );
        assert_eq!(
            migrate(serde_json::json!({ "launcher": { "opacity": 0.8 } }))
                .launcher
                .opacity,
            0.8
        );
    }

    #[test]
    fn an_unusable_launcher_mode_list_falls_back_to_all_of_them() {
        // Every mode switched off would leave nothing to search.
        let settings = migrate(serde_json::json!({ "launcher": { "modes": [] } }));
        assert_eq!(settings.launcher.modes, LauncherSettings::default().modes);

        // Unknown names are dropped rather than rendered as empty orbs.
        let settings = migrate(serde_json::json!({
            "launcher": { "modes": ["projects", "nonsense", "health"] }
        }));
        assert_eq!(settings.launcher.modes, vec!["projects", "health"]);
    }

    #[test]
    fn launcher_settings_survive_a_partial_block() {
        // Only `showHints` mentioned: everything else keeps its default.
        let settings = migrate(serde_json::json!({ "launcher": { "showHints": false } }));
        assert!(!settings.launcher.show_hints);
        assert_eq!(
            settings.launcher.opacity,
            LauncherSettings::default().opacity
        );
        assert_eq!(settings.launcher.max_results, 40);
        assert!(settings.launcher.show_recent_when_empty);
    }

    #[test]
    fn a_settings_file_predating_the_launcher_block_gets_the_defaults() {
        let settings = migrate(serde_json::json!({ "theme": "dark" }));
        assert_eq!(settings.launcher, LauncherSettings::default());
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
