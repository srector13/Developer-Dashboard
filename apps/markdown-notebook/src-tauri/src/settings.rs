//! Settings, the portable data directory and the per-user notebook pointer.
//!
//! The on-disk JSON shape is unchanged from the Electron build (camelCase
//! keys), so an existing `settings.json` — and the settings screen in the
//! renderer, which reads and writes these fields by name — keeps working.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const ORDER_FILE: &str = ".notebook-order";
pub const SECTION_META_FILE: &str = ".section.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfExportOptions {
    pub theme: String,
    pub page_size: String,
    pub open_after: bool,
    pub reveal: bool,
}

impl Default for PdfExportOptions {
    fn default() -> Self {
        Self {
            theme: "light".into(),
            page_size: "A4".into(),
            open_after: true,
            reveal: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    /// Master switch — every AI feature is a no-op while this is false.
    pub enabled: bool,
    pub provider: String,
    /// Server base URL; empty uses the provider's default localhost port.
    pub base_url: String,
    /// Model name/id as the local server knows it (e.g. "llama3.1:8b").
    pub model: String,
    /// Ghost-text completions while typing (needs `enabled` too).
    pub autocomplete: bool,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: "ollama".into(),
            base_url: String::new(),
            model: String::new(),
            autocomplete: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub notebook_root: String,
    pub default_page_width: String,
    pub default_mermaid_zoom: i64,
    /// Legacy pre-theme-system field; migrated into `theme` on read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_theme: Option<String>,
    pub theme: String,
    pub ignore_folders: Vec<String>,
    pub templates_folder: String,
    pub attachments_folder: String,
    pub author: String,
    pub scratchpad_file: String,
    pub auto_save_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pandoc_path: Option<String>,
    pub pdf_export: PdfExportOptions,
    /// Global (system-wide) quick-capture shortcut; empty string disables it.
    pub quick_capture_shortcut: String,
    /// Global shortcut that files the clipboard text with no window; empty disables.
    pub clipboard_capture_shortcut: String,
    /// Where windowless clipboard captures go: a note's relPath, or '' for today's daily note.
    pub clipboard_capture_target: String,
    /// Optional local AI (Ollama / LM Studio) integration.
    pub ai: AiSettings,
    /// Browser spell-check squiggles in the note editor.
    pub spellcheck_enabled: bool,
    /// Keep running in the tray (global shortcut + tools stay live) when the
    /// main window is closed, instead of quitting.
    pub keep_in_tray: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            notebook_root: String::new(),
            default_page_width: "standard".into(),
            default_mermaid_zoom: 100,
            preview_theme: None,
            theme: "system".into(),
            ignore_folders: [
                "_media",
                "attachments",
                "templates",
                "node_modules",
                ".git",
                ".vscode",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            templates_folder: "templates".into(),
            attachments_folder: "attachments".into(),
            author: String::new(),
            scratchpad_file: "scratchpad.md".into(),
            auto_save_enabled: false,
            pandoc_path: None,
            pdf_export: PdfExportOptions::default(),
            quick_capture_shortcut: "CommandOrControl+Shift+N".into(),
            clipboard_capture_shortcut: "CommandOrControl+Shift+G".into(),
            clipboard_capture_target: String::new(),
            ai: AiSettings::default(),
            spellcheck_enabled: true,
            keep_in_tray: true,
        }
    }
}

impl AppSettings {
    pub fn ignore_set(&self) -> std::collections::HashSet<String> {
        self.ignore_folders
            .iter()
            .map(|s| s.to_lowercase())
            .collect()
    }

    pub fn root(&self) -> PathBuf {
        PathBuf::from(&self.notebook_root)
    }

    pub fn templates_dir(&self) -> PathBuf {
        let folder = Path::new(&self.templates_folder);
        if folder.is_absolute() {
            folder.to_path_buf()
        } else {
            self.root().join(folder)
        }
    }

    pub fn attachments_dir(&self) -> PathBuf {
        let folder = Path::new(&self.attachments_folder);
        if folder.is_absolute() {
            folder.to_path_buf()
        } else {
            self.root().join(folder)
        }
    }
}

/// Merge a partial settings object read from disk (or sent by the renderer)
/// onto the defaults, applying the same migrations the Electron build did.
pub fn migrate(raw: serde_json::Value) -> AppSettings {
    let defaults = serde_json::to_value(AppSettings::default()).unwrap();
    let merged = merge_shallow(defaults, raw);
    let mut settings: AppSettings =
        serde_json::from_value(merged).unwrap_or_else(|_| AppSettings::default());

    // Pre-theme-system installs only had previewTheme.
    if settings.theme.is_empty() || settings.theme == "system" {
        if let Some(legacy) = settings.preview_theme.clone() {
            settings.theme = match legacy.as_str() {
                "github-dark" => "dark".into(),
                "off" => "light".into(),
                _ => "system".into(),
            };
        }
    }

    // The attachments folder must stay out of the notebook tree (same coupling
    // rule as the templates folder).
    if !settings.attachments_folder.is_empty()
        && !settings
            .ignore_folders
            .iter()
            .any(|f| f.eq_ignore_ascii_case(&settings.attachments_folder))
    {
        settings
            .ignore_folders
            .push(settings.attachments_folder.clone());
    }

    settings
}

/// Object merge one level deep, so `pdfExport` / `ai` sub-objects keep the
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
// Where state lives
// ---------------------------------------------------------------------------

/// Portable mode is the only mode this build ships in: all app state lives in
/// `MarkdownNotebookData` beside the executable, so the app travels with a USB
/// stick or a Downloads folder. If that folder can't be created (the exe was
/// dropped somewhere read-only, e.g. Program Files), fall back to the per-user
/// AppData location rather than failing to start.
pub fn user_data_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sidecar = dir.join("MarkdownNotebookData");
            if std::fs::create_dir_all(&sidecar).is_ok() && is_writable(&sidecar) {
                return sidecar;
            }
        }
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| dirs_home().map(|h| h.join("AppData").join("Roaming")))
        .unwrap_or_else(std::env::temp_dir);
    let fallback = base.join("Markdown Notebook");
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

pub fn scan_meta_cache_file() -> PathBuf {
    user_data_dir().join("scan-meta-cache-v1.json")
}

/// Notebook pointer: a tiny per-user file OUTSIDE the app's own state that
/// remembers where the notebook lives. Settings travel with the .exe — the
/// pointer stays in the user's home folder, so a fresh unzip, a moved portable
/// exe, or a wiped data folder still reopens the same notebook.
fn pointer_file() -> Option<PathBuf> {
    dirs_home().map(|h| h.join(".markdown-notebook").join("last-notebook.json"))
}

pub fn read_notebook_pointer() -> String {
    let Some(file) = pointer_file() else {
        return String::new();
    };
    let Ok(text) = std::fs::read_to_string(file) else {
        return String::new();
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("notebookRoot")?.as_str().map(|s| s.to_string()))
        .unwrap_or_default()
}

/// Record where the notebook lives, in both places that care.
///
/// The suite registry is where the other apps look now. The older pointer file
/// is still written beside it, because a build of Dev Hub that predates the
/// registry reads only that — and an app that quietly stops working when its
/// sibling is a version behind is not a suite.
pub fn write_notebook_pointer(root: &str) {
    if root.is_empty() {
        return;
    }
    crate::suite::set_notebook_root(root);

    let Some(file) = pointer_file() else { return };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Best effort: a read-only home dir shouldn't break the app.
    let _ = std::fs::write(
        file,
        serde_json::to_string_pretty(&serde_json::json!({ "notebookRoot": root }))
            .unwrap_or_default(),
    );
}

/// Fall back to the pointer when settings have no usable notebook root. The
/// fallback is in memory only — nothing is written until the user actually
/// picks or confirms a folder.
pub fn resolve_notebook_root(mut settings: AppSettings) -> AppSettings {
    if !settings.notebook_root.is_empty() && Path::new(&settings.notebook_root).exists() {
        return settings;
    }
    let pointer = read_notebook_pointer();
    settings.notebook_root = if !pointer.is_empty() && Path::new(&pointer).exists() {
        pointer
    } else {
        String::new()
    };
    settings
}

pub fn load_from_disk() -> AppSettings {
    match std::fs::read_to_string(settings_file()) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(value) => resolve_notebook_root(migrate(value)),
            Err(_) => resolve_notebook_root(AppSettings::default()),
        },
        Err(_) => resolve_notebook_root(AppSettings::default()),
    }
}

pub fn save_to_disk(settings: &AppSettings) -> std::io::Result<()> {
    let file = settings_file();
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&file, serde_json::to_string_pretty(settings)?)?;
    write_notebook_pointer(&settings.notebook_root);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_serialize_with_camel_case_keys() {
        let json = serde_json::to_value(AppSettings::default()).unwrap();
        assert!(json.get("notebookRoot").is_some());
        assert!(json.get("defaultPageWidth").is_some());
        assert!(json.get("quickCaptureShortcut").is_some());
        assert!(json.get("pdfExport").unwrap().get("pageSize").is_some());
        // Unset optional fields stay out of the file entirely.
        assert!(json.get("previewTheme").is_none());
        assert!(json.get("pandocPath").is_none());
    }

    #[test]
    fn migration_fills_missing_keys_from_defaults() {
        let raw = serde_json::json!({ "notebookRoot": "C:\\notes", "author": "Sam" });
        let settings = migrate(raw);
        assert_eq!(settings.notebook_root, "C:\\notes");
        assert_eq!(settings.author, "Sam");
        assert_eq!(settings.theme, "system");
        assert_eq!(settings.pdf_export.page_size, "A4");
        assert!(settings.keep_in_tray);
    }

    #[test]
    fn migration_keeps_partial_sub_objects() {
        let raw = serde_json::json!({ "pdfExport": { "theme": "dark" } });
        let settings = migrate(raw);
        assert_eq!(settings.pdf_export.theme, "dark");
        // page_size was omitted, so the default survives
        assert_eq!(settings.pdf_export.page_size, "A4");
        assert!(settings.pdf_export.open_after);
    }

    #[test]
    fn legacy_preview_theme_becomes_theme() {
        let settings = migrate(serde_json::json!({ "previewTheme": "github-dark" }));
        assert_eq!(settings.theme, "dark");
        let settings = migrate(serde_json::json!({ "previewTheme": "off" }));
        assert_eq!(settings.theme, "light");
    }

    #[test]
    fn explicit_theme_beats_the_legacy_field() {
        let settings =
            migrate(serde_json::json!({ "previewTheme": "github-dark", "theme": "forest" }));
        assert_eq!(settings.theme, "forest");
    }

    #[test]
    fn attachments_folder_is_forced_into_the_ignore_list() {
        let settings = migrate(serde_json::json!({
            "attachmentsFolder": "files",
            "ignoreFolders": ["templates"]
        }));
        assert!(settings.ignore_folders.iter().any(|f| f == "files"));
    }
}
