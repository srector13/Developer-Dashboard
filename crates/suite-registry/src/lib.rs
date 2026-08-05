//! How the apps find each other.
//!
//! The suite used to cohere through exactly one file: Markdown Notebook wrote
//! `%USERPROFILE%\.markdown-notebook\last-notebook.json` and Dev Hub read it.
//! That works for one fact flowing one way between two apps, and stops working
//! the moment there are three.
//!
//! This generalises it. Every app writes one entry into
//! `%USERPROFILE%\.dev-suite\registry.json` on startup — who it is, where its
//! exe is, what it can do — and reads the others. A new tool gets cross-launch
//! and a Dev Hub card without either app being taught about it specifically.
//!
//! Three properties the design leans on:
//!
//!   * **Writes are last-one-wins, per entry.** An app rewrites its own key and
//!     copies everyone else's through untouched, so two apps starting at once
//!     can at worst lose one registration until the next launch.
//!   * **Nothing is ever pruned.** An exe on a USB stick that isn't plugged in
//!     is missing, not gone; `find_exe` skips entries whose file isn't there
//!     rather than deleting them.
//!   * **A missing registry is normal.** Every read returns an empty registry
//!     rather than an error, because on a fresh box that is exactly the truth.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Well-known app ids. An app is free to invent its own, but the ones the suite
/// ships are named here so a typo in one app can't silently fail to find
/// another.
pub const DEV_HUB: &str = "dev-hub";
pub const LOG_VIEWER: &str = "log-viewer";
pub const MARKDOWN_NOTEBOOK: &str = "markdown-notebook";

/// Capability tokens. These describe what an app can be *asked to do*, which is
/// what a sibling needs to know before offering an action for it.
pub mod capability {
    /// Accepts `--file <path>` and tails it.
    pub const TAIL_FILE: &str = "tail-file";
    /// Accepts `--line <n> --view edit <path>` and opens a note there.
    pub const OPEN_NOTE_AT_LINE: &str = "open-note-at-line";
    /// Has a global quick launcher.
    pub const LAUNCHER: &str = "launcher";
    /// Aggregates provider cards.
    pub const DASHBOARD: &str = "dashboard";
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    pub id: String,
    /// Display name, for a menu item that names the app it will open.
    pub name: String,
    /// Absolute path to the executable, as the app itself saw it.
    pub exe: String,
    pub version: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Unix seconds of the last registration, so a stale entry is visible as
    /// stale rather than merely wrong.
    #[serde(default)]
    pub registered_at: i64,
}

impl AppEntry {
    pub fn can(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|c| c == capability)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    /// Bumped only if the shape changes incompatibly, which it is designed not
    /// to: readers ignore keys they don't know.
    #[serde(default = "default_version")]
    pub version: u32,
    /// Keyed by app id. A map rather than a list so registering is an upsert
    /// and can never produce a duplicate.
    #[serde(default)]
    pub apps: BTreeMap<String, AppEntry>,
    /// The notebook most recently opened, by whichever app opened it. This is
    /// the one piece of shared *content* state, and it earns its place because
    /// it is the thing three apps all need and none of them owns.
    #[serde(default)]
    pub notebook_root: String,
}

fn default_version() -> u32 {
    1
}

/// Written by hand rather than derived, because a derived `Default` would give
/// `version: 0` while serde's `default` attribute gives 1 — and the two are not
/// interchangeable. `merge_onto_defaults` starts from `Default::default()`, so
/// the derived version would put `"version": 0` in every file the suite writes.
impl Default for Registry {
    fn default() -> Self {
        Self {
            version: default_version(),
            apps: BTreeMap::new(),
            notebook_root: String::new(),
        }
    }
}

impl Registry {
    pub fn get(&self, id: &str) -> Option<&AppEntry> {
        self.apps.get(id)
    }

    /// Every registered app that advertises a capability, most recently
    /// registered first — so if two apps can tail a file, the one you actually
    /// ran last is offered.
    pub fn providers_of(&self, capability: &str) -> Vec<&AppEntry> {
        let mut found: Vec<&AppEntry> = self
            .apps
            .values()
            .filter(|entry| entry.can(capability))
            .collect();
        found.sort_by(|a, b| b.registered_at.cmp(&a.registered_at));
        found
    }
}

/// `%USERPROFILE%\.dev-suite`. Per user rather than per app: the whole point is
/// that an app which did not write this file can still find it.
pub fn registry_dir() -> Option<PathBuf> {
    suite_config::home_dir().map(|home| home.join(".dev-suite"))
}

pub fn registry_file() -> Option<PathBuf> {
    registry_dir().map(|dir| dir.join("registry.json"))
}

/// Read the registry. A missing, unreadable or malformed file yields an empty
/// registry — on a fresh machine that is the truth, and on a corrupted one it
/// is better than refusing to start.
pub fn load() -> Registry {
    let Some(file) = registry_file() else {
        return Registry::default();
    };
    suite_config::load_or_default(&file)
}

/// Write the registry, replacing it atomically so a reader never sees a
/// half-written file. Failure is silent by design: not being able to write a
/// discovery hint is not a reason to interrupt someone's morning.
pub fn store(registry: &Registry) -> std::io::Result<()> {
    let Some(file) = registry_file() else {
        return Ok(());
    };
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temp = file.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_string_pretty(registry)?)?;
    // `fs::rename` is MoveFileEx with MOVEFILE_REPLACE_EXISTING on Windows, so
    // this replaces the live file in one step on both platforms.
    std::fs::rename(&temp, &file)
}

/// Announce this app. Called once at startup, after the exe path is known.
///
/// Everyone else's entries are read and written back untouched, so this is an
/// upsert of one key rather than a rewrite of the file.
pub fn register(id: &str, name: &str, version: &str, capabilities: &[&str]) -> Registry {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    let mut registry = load();
    registry.version = default_version();
    registry.apps.insert(
        id.to_string(),
        AppEntry {
            id: id.to_string(),
            name: name.to_string(),
            exe,
            version: version.to_string(),
            capabilities: capabilities.iter().map(|c| c.to_string()).collect(),
            registered_at: now_secs(),
        },
    );
    let _ = store(&registry);
    registry
}

/// Record the notebook the user has open, so the other apps follow it.
///
/// Only an app that actually opens notebooks should call this. Dev Hub reads
/// the value and never writes it — an aggregator has no business deciding what
/// "the current notebook" is.
pub fn set_notebook_root(root: &str) {
    let mut registry = load();
    if registry.notebook_root == root {
        return; // nothing to write, so don't churn the file
    }
    registry.notebook_root = root.to_string();
    let _ = store(&registry);
}

/// Where the notebook lives, preferring the suite registry and falling back to
/// the pointer file Markdown Notebook wrote before the registry existed.
///
/// The fallback is what lets an un-migrated Markdown Notebook keep working: it
/// writes only the old file, and Dev Hub still finds the notebook. Once the
/// notebook app registers properly the old path stops being consulted.
pub fn notebook_root() -> String {
    let root = load().notebook_root;
    if !root.trim().is_empty() {
        return root;
    }
    legacy_notebook_pointer()
}

/// `%USERPROFILE%\.markdown-notebook\last-notebook.json`, the pre-registry
/// pointer. Read-only, and only as a fallback.
pub fn legacy_notebook_pointer() -> String {
    let Some(home) = suite_config::home_dir() else {
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

/// The executable for a registered app, if it is registered *and* still on
/// disk.
///
/// A registered path that no longer resolves is skipped rather than removed —
/// an exe on a drive that isn't mounted is missing, not gone, and deleting the
/// entry would mean re-discovering it by hand later.
pub fn find_exe(id: &str) -> Option<PathBuf> {
    let entry = load().apps.remove(id)?;
    let path = PathBuf::from(entry.exe);
    path.is_file().then_some(path)
}

/// The executable for whichever registered app advertises `capability`.
pub fn find_exe_for(capability: &str) -> Option<PathBuf> {
    load()
        .providers_of(capability)
        .into_iter()
        .map(|entry| PathBuf::from(&entry.exe))
        .find(|path| path.is_file())
}

/// Look beside this executable for a sibling app, for the case where the
/// registry has nothing — a fresh box where the sibling has never been run.
///
/// The suite ships as portable exes dropped in one folder, so "next to me" is
/// the single most likely place, and checking it costs a few `stat` calls.
pub fn find_sibling_exe(file_names: &[&str]) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;

    let mut roots: Vec<PathBuf> = vec![dir.to_path_buf()];
    // One level up and back down covers the `tools\dev-hub\` /
    // `tools\log-viewer\` layout that a folder-per-app install produces.
    if let Some(parent) = dir.parent() {
        roots.push(parent.to_path_buf());
        for name in file_names {
            if let Some(stem) = Path::new(name).file_stem() {
                roots.push(parent.join(stem));
            }
        }
    }

    roots.iter().find_map(|root| {
        file_names
            .iter()
            .map(|name| root.join(name))
            .find(|candidate| candidate.is_file())
    })
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, registered_at: i64, capabilities: &[&str]) -> AppEntry {
        AppEntry {
            id: id.into(),
            name: id.into(),
            exe: format!("C:\\tools\\{id}.exe"),
            version: "0.2.0".into(),
            capabilities: capabilities.iter().map(|c| c.to_string()).collect(),
            registered_at,
        }
    }

    fn registry_with(entries: Vec<AppEntry>) -> Registry {
        Registry {
            version: 1,
            apps: entries.into_iter().map(|e| (e.id.clone(), e)).collect(),
            notebook_root: String::new(),
        }
    }

    #[test]
    fn an_entry_reports_only_the_capabilities_it_declared() {
        let dev_hub = entry(DEV_HUB, 0, &[capability::LAUNCHER, capability::DASHBOARD]);
        assert!(dev_hub.can(capability::LAUNCHER));
        assert!(!dev_hub.can(capability::TAIL_FILE));
    }

    #[test]
    fn capability_lookup_prefers_the_app_registered_most_recently() {
        // Two apps that can both tail: the one you ran last is the one you meant.
        let registry = registry_with(vec![
            entry("old-tailer", 100, &[capability::TAIL_FILE]),
            entry(LOG_VIEWER, 900, &[capability::TAIL_FILE]),
            entry(DEV_HUB, 950, &[capability::DASHBOARD]),
        ]);
        let found = registry.providers_of(capability::TAIL_FILE);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].id, LOG_VIEWER);
    }

    #[test]
    fn a_capability_nobody_offers_yields_nothing_rather_than_a_wrong_app() {
        let registry = registry_with(vec![entry(DEV_HUB, 0, &[capability::DASHBOARD])]);
        assert!(registry.providers_of(capability::TAIL_FILE).is_empty());
    }

    #[test]
    fn registering_the_same_app_twice_updates_rather_than_duplicates() {
        let mut registry = registry_with(vec![entry(LOG_VIEWER, 100, &[])]);
        registry
            .apps
            .insert(LOG_VIEWER.into(), entry(LOG_VIEWER, 200, &[]));
        assert_eq!(registry.apps.len(), 1);
        assert_eq!(registry.get(LOG_VIEWER).unwrap().registered_at, 200);
    }

    #[test]
    fn a_registry_missing_every_optional_key_still_parses() {
        // What an older app, or a hand-written file, would leave behind.
        let raw = serde_json::json!({ "apps": { "dev-hub": { "id": "dev-hub", "name": "Dev Hub", "exe": "", "version": "" } } });
        let registry: Registry = suite_config::merge_onto_defaults(raw);
        assert_eq!(registry.version, 1);
        assert!(registry.notebook_root.is_empty());
        assert!(registry.get(DEV_HUB).unwrap().capabilities.is_empty());
    }

    #[test]
    fn an_unreadable_registry_reads_as_empty_rather_than_failing() {
        let registry: Registry = suite_config::merge_onto_defaults(serde_json::json!("nonsense"));
        assert_eq!(registry, Registry::default());
    }

    #[test]
    fn the_default_registry_serializes_with_camel_case_keys() {
        let json = serde_json::to_value(Registry::default()).unwrap();
        assert!(json.get("notebookRoot").is_some());
        assert!(json.get("apps").is_some());
    }

    #[test]
    fn entries_serialize_with_camel_case_keys() {
        let json = serde_json::to_value(entry(LOG_VIEWER, 5, &[capability::TAIL_FILE])).unwrap();
        assert_eq!(json["registeredAt"], 5);
        assert_eq!(json["capabilities"][0], capability::TAIL_FILE);
    }

    #[test]
    fn a_sibling_lookup_finds_the_test_binary_beside_itself() {
        // The running test executable is the one file guaranteed to be where we
        // are about to look.
        let exe = std::env::current_exe().unwrap();
        let name = exe.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(find_sibling_exe(&[&name]), Some(exe));
    }

    #[test]
    fn a_sibling_that_is_not_there_is_none_rather_than_a_guess() {
        assert_eq!(find_sibling_exe(&["suite-registry-no-such-app.exe"]), None);
    }
}
