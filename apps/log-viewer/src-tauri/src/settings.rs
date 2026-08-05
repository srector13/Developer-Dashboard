//! Portable settings and the user's `logs.config.json`.
//!
//! Split the same way Dev Hub splits its two files, and for the same reason:
//! `settings.json` is app state (theme, wrapping, poll interval),
//! `logs.config.json` is content (which files, which filters, which highlight
//! rules) and is worth keeping in a dotfiles repo. `suite-config` owns the
//! merge-onto-defaults behaviour, so a hand-trimmed file never loses a key.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::filter::{HighlightRule, SavedFilter};

const PORTABLE_DIR: &str = "LogViewerData";
const FALLBACK_DIR: &str = "LogViewer";

// ---------------------------------------------------------------------------
// settings.json
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerSettings {
    pub theme: String,
    /// Soft-wrap long lines. Off by default: a log line is a record, and
    /// wrapping makes the row count stop matching the line count, which is
    /// disorienting when you are counting occurrences.
    #[serde(default)]
    pub wrap: bool,
    #[serde(default = "default_true")]
    pub show_timestamps: bool,
    #[serde(default = "default_true")]
    pub show_source: bool,
    #[serde(default = "default_true")]
    pub show_level: bool,
    /// How often to check every source for new bytes.
    #[serde(default = "default_poll_ms")]
    pub poll_interval_ms: u64,
    /// Follow the tail as lines arrive. Turned off automatically when you
    /// scroll up — chasing the bottom while someone is reading is the single
    /// most annoying thing a log viewer can do — and back on when you return.
    #[serde(default = "default_true")]
    pub follow: bool,
    /// How many lines to hold in memory.
    #[serde(default = "default_capacity")]
    pub capacity: usize,
    /// How many lines to hand the renderer at once.
    #[serde(default = "default_window")]
    pub window: usize,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
}

fn default_true() -> bool {
    true
}

fn default_poll_ms() -> u64 {
    250
}

fn default_capacity() -> usize {
    crate::store::DEFAULT_CAPACITY
}

fn default_window() -> usize {
    2_000
}

fn default_font_size() -> u32 {
    12
}

impl Default for ViewerSettings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            wrap: false,
            show_timestamps: true,
            show_source: true,
            show_level: true,
            poll_interval_ms: default_poll_ms(),
            follow: true,
            capacity: default_capacity(),
            window: default_window(),
            font_size: default_font_size(),
        }
    }
}

/// Merge a partial settings object onto the defaults and clamp anything a
/// person could reasonably get wrong by hand.
pub fn migrate(raw: serde_json::Value) -> ViewerSettings {
    let mut settings: ViewerSettings = suite_config::merge_onto_defaults(raw);

    // A zero-millisecond poll is a spin loop; a one-minute poll is not a tail.
    settings.poll_interval_ms = settings.poll_interval_ms.clamp(50, 5_000);
    // Below a few thousand lines the scrollback is useless; above a few
    // million the process is the problem rather than the log.
    settings.capacity = settings.capacity.clamp(1_000, 5_000_000);
    settings.window = settings.window.clamp(100, 20_000);
    settings.font_size = settings.font_size.clamp(9, 24);
    settings
}

// ---------------------------------------------------------------------------
// logs.config.json — the user's content
// ---------------------------------------------------------------------------

/// One file being watched.
///
/// `Default` is written out rather than derived: `merge_onto_defaults` starts
/// from `Default::default()`, so a derived `enabled: false` would mean every
/// configured source arrived switched off. Any `#[serde(default = "…")]` in
/// this file has to be mirrored in the corresponding `Default` impl for the
/// same reason.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSource {
    /// Stable id, used as the key everywhere. Generated from the path when the
    /// config doesn't give one.
    #[serde(default)]
    pub id: String,
    /// What to call it in the source list — "api", not
    /// "C:\services\payments\logs\application.log".
    #[serde(default)]
    pub name: String,
    pub path: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// A token from the renderer's fixed palette, so each source's lines are
    /// identifiable in a merged view without reading the source column.
    #[serde(default)]
    pub colour: String,
}

impl Default for LogSource {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            path: String::new(),
            enabled: true,
            colour: String::new(),
        }
    }
}

impl LogSource {
    /// Fill in whatever the config left out. A source with a path is enough to
    /// be usable; everything else has a sensible derivation.
    pub fn completed(mut self, index: usize) -> Self {
        if self.name.trim().is_empty() {
            self.name = file_name(&self.path);
        }
        if self.id.trim().is_empty() {
            self.id = derive_id(&self.name, index);
        }
        if self.colour.trim().is_empty() {
            self.colour = SOURCE_COLOURS[index % SOURCE_COLOURS.len()].to_string();
        }
        self
    }
}

/// The palette the renderer knows. Kept here rather than in the renderer so a
/// source's colour survives into the config file as a name.
pub const SOURCE_COLOURS: &[&str] = &["blue", "teal", "violet", "amber", "green", "pink"];

/// The last component of a path, splitting on *both* separators.
///
/// `Path::file_name` only knows the host's separator, so a Windows path in a
/// config file read on Linux — which is exactly what CI does — comes back
/// whole. A config is a document that travels, so it is parsed the same way
/// wherever it is read.
fn file_name(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(path)
        .to_string()
}

/// A url-safe id from a display name, with the index as the tie-break so two
/// sources called "application.log" never collide.
fn derive_id(name: &str, index: usize) -> String {
    let slug: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        format!("source-{index}")
    } else {
        format!("{slug}-{index}")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsConfig {
    #[serde(default)]
    pub sources: Vec<LogSource>,
    #[serde(default)]
    pub filters: Vec<SavedFilter>,
    #[serde(default = "default_highlights")]
    pub highlights: Vec<HighlightRule>,
}

impl Default for LogsConfig {
    fn default() -> Self {
        Self {
            sources: Vec::new(),
            filters: Vec::new(),
            highlights: default_highlights(),
        }
    }
}

/// The rules that earn their place on day one. Someone opening a log for the
/// first time should not have to configure "make errors red" themselves.
fn default_highlights() -> Vec<HighlightRule> {
    vec![
        HighlightRule {
            id: "error".into(),
            name: "Errors".into(),
            pattern: r"\b(ERROR|FATAL|SEVERE|Exception|Caused by)\b".into(),
            regex: true,
            case_sensitive: true,
            colour: "red".into(),
            enabled: true,
        },
        HighlightRule {
            id: "warn".into(),
            name: "Warnings".into(),
            pattern: r"\b(WARN|WARNING)\b".into(),
            regex: true,
            case_sensitive: true,
            colour: "amber".into(),
            enabled: true,
        },
    ]
}

pub fn migrate_config(raw: serde_json::Value) -> LogsConfig {
    let mut config: LogsConfig = suite_config::merge_onto_defaults(raw);
    config.sources = config
        .sources
        .into_iter()
        .enumerate()
        .map(|(index, source)| source.completed(index))
        .filter(|source| !source.path.trim().is_empty())
        .collect();
    config
}

/// The config shipped on first run — an empty source list, because the app
/// cannot guess which files matter, and the two highlight rules everyone wants.
pub const DEFAULT_CONFIG: &str = r#"{
  "//": "Log Viewer content config. Edit and save — the app reloads it, no restart.",

  "//sources": [
    "Each entry is one file to tail. `name` is what the source list shows;",
    "leave it out and the file name is used. `colour` is one of:",
    "blue, teal, violet, amber, green, pink.",
    "Files opened with --file, or dropped on the window, are session-only:",
    "use Save to config to keep one."
  ],
  "sources": [],

  "//filters": [
    "Saved filters. `query` and `exclude` are substrings unless `regex` is true.",
    "`minLevel` is one of: unknown, trace, debug, info, warn, error, fatal.",
    "  { \"id\": \"errors\", \"name\": \"Errors only\", \"minLevel\": \"error\" },",
    "  { \"id\": \"quiet\", \"name\": \"No health checks\", \"exclude\": \"/health\" }"
  ],
  "filters": [],

  "//highlights": [
    "Colouring rules, applied in order — the first match wins. These never",
    "hide anything; they mark lines you want to spot while scrolling."
  ]
}
"#;

// ---------------------------------------------------------------------------
// Where state lives
// ---------------------------------------------------------------------------

pub fn user_data_dir() -> PathBuf {
    suite_config::resolve_data_dir(PORTABLE_DIR, FALLBACK_DIR)
}

pub fn settings_file() -> PathBuf {
    user_data_dir().join("settings.json")
}

pub fn config_file() -> PathBuf {
    user_data_dir().join("logs.config.json")
}

pub fn load_settings() -> ViewerSettings {
    match std::fs::read_to_string(settings_file()) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(value) => migrate(value),
            Err(_) => ViewerSettings::default(),
        },
        Err(_) => ViewerSettings::default(),
    }
}

pub fn save_settings(settings: &ViewerSettings) -> std::io::Result<()> {
    suite_config::save_json(&settings_file(), settings)
}

/// Read `logs.config.json`, writing the shipped default on first run. A
/// malformed file is reported rather than overwritten — losing a hand-written
/// set of filters to a stray comma would be unforgivable.
pub fn load_config() -> Result<LogsConfig, String> {
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

pub fn save_config(config: &LogsConfig) -> std::io::Result<()> {
    suite_config::save_json(&config_file(), config)
}

/// Write the Log Viewer's entry into the suite registry, so Dev Hub can offer
/// "tail this" against it without being told where it lives.
pub fn register_with_suite() {
    suite_registry::register(
        suite_registry::LOG_VIEWER,
        "Log Viewer",
        env!("CARGO_PKG_VERSION"),
        &[suite_registry::capability::TAIL_FILE],
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::line::Level;

    #[test]
    fn defaults_serialize_with_camel_case_keys() {
        let json = serde_json::to_value(ViewerSettings::default()).unwrap();
        assert!(json.get("pollIntervalMs").is_some());
        assert!(json.get("showTimestamps").is_some());
        assert_eq!(json["follow"], true);
    }

    #[test]
    fn a_partial_settings_file_keeps_the_keys_it_did_not_mention() {
        let settings = migrate(serde_json::json!({ "theme": "dark" }));
        assert_eq!(settings.theme, "dark");
        assert_eq!(settings.poll_interval_ms, default_poll_ms());
        assert!(settings.follow);
    }

    #[test]
    fn a_hand_edited_poll_interval_is_clamped_rather_than_trusted() {
        assert_eq!(
            migrate(serde_json::json!({ "pollIntervalMs": 0 })).poll_interval_ms,
            50
        );
        assert_eq!(
            migrate(serde_json::json!({ "pollIntervalMs": 999_999 })).poll_interval_ms,
            5_000
        );
    }

    #[test]
    fn capacity_and_window_are_clamped_to_something_usable() {
        assert_eq!(
            migrate(serde_json::json!({ "capacity": 1 })).capacity,
            1_000
        );
        assert_eq!(migrate(serde_json::json!({ "window": 0 })).window, 100);
        assert_eq!(
            migrate(serde_json::json!({ "window": 1_000_000 })).window,
            20_000
        );
    }

    #[test]
    fn a_garbage_settings_file_falls_back_to_defaults_instead_of_panicking() {
        assert_eq!(
            migrate(serde_json::json!({ "capacity": "lots" })),
            ViewerSettings::default()
        );
    }

    #[test]
    fn a_source_with_only_a_path_gets_a_name_an_id_and_a_colour() {
        let source = LogSource {
            path: "C:\\services\\payments\\application.log".into(),
            ..Default::default()
        }
        .completed(0);

        assert_eq!(source.name, "application.log");
        assert_eq!(source.id, "application-log-0");
        assert_eq!(source.colour, "blue");
        assert!(source.enabled);
    }

    #[test]
    fn two_sources_with_the_same_file_name_get_different_ids() {
        let a = LogSource {
            path: "/a/application.log".into(),
            ..Default::default()
        }
        .completed(0);
        let b = LogSource {
            path: "/b/application.log".into(),
            ..Default::default()
        }
        .completed(1);
        assert_ne!(a.id, b.id);
        assert_ne!(
            a.colour, b.colour,
            "and different colours, so they read apart"
        );
    }

    #[test]
    fn an_explicit_id_and_colour_are_left_alone() {
        let source = LogSource {
            id: "api".into(),
            name: "API".into(),
            path: "/x.log".into(),
            colour: "violet".into(),
            enabled: true,
        }
        .completed(3);
        assert_eq!(source.id, "api");
        assert_eq!(source.colour, "violet");
    }

    #[test]
    fn a_name_with_nothing_alphanumeric_still_yields_an_id() {
        let source = LogSource {
            name: "***".into(),
            path: "/x.log".into(),
            ..Default::default()
        }
        .completed(2);
        assert_eq!(source.id, "source-2");
    }

    #[test]
    fn a_source_with_no_path_is_dropped_rather_than_watched() {
        let config = migrate_config(serde_json::json!({
            "sources": [{ "path": "" }, { "path": "/real.log" }]
        }));
        assert_eq!(config.sources.len(), 1);
        assert_eq!(config.sources[0].path, "/real.log");
    }

    #[test]
    fn the_shipped_default_config_parses_and_brings_the_highlight_rules() {
        let value: serde_json::Value =
            serde_json::from_str(DEFAULT_CONFIG).expect("the shipped config must be valid JSON");
        let config = migrate_config(value);
        assert!(
            config.sources.is_empty(),
            "it cannot guess which files matter"
        );
        assert_eq!(
            config.highlights.len(),
            2,
            "but errors and warnings are coloured"
        );
        assert!(config.highlights.iter().any(|h| h.id == "error"));
    }

    #[test]
    fn the_default_highlight_rules_compile() {
        // They ship enabled, so a typo in one of them would be a silent
        // regression for every user on first run.
        let highlighter = crate::filter::Highlighter::build(&default_highlights());
        assert_eq!(highlighter.rule_for("2024-05-01 ERROR boom"), Some("error"));
        assert_eq!(highlighter.rule_for("2024-05-01 WARN slow"), Some("warn"));
        assert_eq!(highlighter.rule_for("2024-05-01 INFO fine"), None);
        assert_eq!(
            highlighter.rule_for("Caused by: java.lang.NullPointerException"),
            Some("error")
        );
    }

    #[test]
    fn a_config_that_names_no_highlights_still_gets_the_defaults() {
        let config = migrate_config(serde_json::json!({ "sources": [] }));
        assert_eq!(config.highlights.len(), 2);
    }

    #[test]
    fn an_explicitly_empty_highlight_list_is_respected() {
        // Someone who deletes every rule means it.
        let config = migrate_config(serde_json::json!({ "highlights": [] }));
        assert!(config.highlights.is_empty());
    }

    #[test]
    fn saved_filters_round_trip_through_the_config() {
        let config = migrate_config(serde_json::json!({
            "filters": [{ "id": "errors", "name": "Errors only", "minLevel": "error" }]
        }));
        assert_eq!(config.filters[0].spec.min_level, Level::Error);
        assert_eq!(config.filters[0].name, "Errors only");
    }
}
