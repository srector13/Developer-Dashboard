//! Announcing this app to the rest of the suite.
//!
//! Markdown Notebook, Dev Hub and Log Viewer are separate portable exes that
//! behave like one product. They find each other through a per-user file:
//!
//! ```text
//! %USERPROFILE%\.dev-suite\registry.json
//! ```
//!
//! Each app writes one entry — who it is, where its exe is, and what it can be
//! asked to do — and reads the others. An app asks for a *capability* rather
//! than for a named sibling, so Dev Hub offers "open this todo" against
//! whatever advertises `open-note-at-line` without being taught that this app
//! exists.
//!
//! # Why this is a module and not a dependency
//!
//! The suite's other apps share a `suite-registry` crate. This app does not use
//! it, deliberately:
//!
//!   * it is a portable app that should build from its own repository with no
//!     network dependency on another one;
//!   * the registry is an interchange *format*, and a second implementation of
//!     a format is normal — the older `last-notebook.json` pointer already
//!     works exactly this way;
//!   * the crate lives in a workspace that this app is expected to move into
//!     later. **When that happens, delete this module** and depend on
//!     `suite-registry` instead. Nothing here should outlive that move.
//!
//! Everything is read and written as `serde_json::Value` rather than through
//! typed structs, so keys written by a newer version of another app survive a
//! round trip through this one instead of being silently dropped.

use std::path::PathBuf;

/// This app's id in the registry. Must match `suite_registry::MARKDOWN_NOTEBOOK`.
const APP_ID: &str = "markdown-notebook";
const APP_NAME: &str = "Markdown Notebook";

/// What this app can be asked to do: accept `--line <n> --view edit <path>`
/// and open a note there. See `cli.rs` — the claim is only worth making
/// because that is genuinely supported.
const CAPABILITY_OPEN_NOTE_AT_LINE: &str = "open-note-at-line";

/// Bumped only if the shape changes incompatibly, which it is designed not to:
/// readers ignore keys they don't know.
const REGISTRY_VERSION: u64 = 1;

fn registry_file() -> Option<PathBuf> {
    crate::settings::dirs_home().map(|home| home.join(".dev-suite").join("registry.json"))
}

/// Read the registry, always as an object.
///
/// A missing, unreadable or malformed file yields an empty registry. On a fresh
/// machine that is the truth, and on a corrupted one it is better than refusing
/// to start — this is a discovery hint, not app state.
fn load() -> serde_json::Value {
    let empty = || serde_json::json!({ "version": REGISTRY_VERSION, "apps": {} });

    let Some(file) = registry_file() else {
        return empty();
    };
    let Ok(text) = std::fs::read_to_string(file) else {
        return empty();
    };
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(value) if value.is_object() => value,
        _ => empty(),
    }
}

/// Write the registry, replacing it in one step so a reader never sees a
/// half-written file.
///
/// Failure is silent by design: not being able to write a discovery hint is not
/// a reason to interrupt someone's morning.
fn store(registry: &serde_json::Value) {
    let Some(file) = registry_file() else { return };
    if let Some(dir) = file.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
    }
    let Ok(text) = serde_json::to_string_pretty(registry) else {
        return;
    };

    let temp = file.with_extension("json.tmp");
    if std::fs::write(&temp, text).is_err() {
        return;
    }
    // `fs::rename` is MoveFileEx with MOVEFILE_REPLACE_EXISTING on Windows, so
    // this replaces the live file atomically on both platforms.
    if std::fs::rename(&temp, &file).is_err() {
        let _ = std::fs::remove_file(&temp);
    }
}

/// Put this app's entry into a registry value, leaving every other app's entry
/// exactly as it was.
///
/// Split out from `register` so the merge — the part with the interesting
/// failure modes — is testable without a home directory.
fn upsert_self(mut registry: serde_json::Value, exe: String, now: i64) -> serde_json::Value {
    registry["version"] = serde_json::json!(REGISTRY_VERSION);
    if !registry["apps"].is_object() {
        registry["apps"] = serde_json::json!({});
    }
    registry["apps"][APP_ID] = serde_json::json!({
        "id": APP_ID,
        "name": APP_NAME,
        "exe": exe,
        "version": env!("CARGO_PKG_VERSION"),
        "capabilities": [CAPABILITY_OPEN_NOTE_AT_LINE],
        "registeredAt": now,
    });
    registry
}

/// Announce this app. Called once at startup, after the exe path is known.
pub fn register() {
    let exe = std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    store(&upsert_self(load(), exe, now_secs()));
}

/// Record which notebook is open, if it has changed.
///
/// Returns `None` when the registry already says this, so an unchanged value
/// does not churn the file — `save_to_disk` runs on every settings write, and
/// most of those have nothing to do with the notebook root.
fn with_notebook_root(registry: serde_json::Value, root: &str) -> Option<serde_json::Value> {
    if registry["notebookRoot"].as_str().unwrap_or_default() == root {
        return None;
    }
    let mut registry = registry;
    registry["notebookRoot"] = serde_json::json!(root);
    Some(registry)
}

/// Tell the suite which notebook is open.
///
/// This app is the one that opens notebooks, so it owns this value; Dev Hub
/// only ever reads it. The older `last-notebook.json` pointer is still written
/// alongside, so a build of Dev Hub that predates the registry keeps working.
pub fn set_notebook_root(root: &str) {
    if root.is_empty() {
        return;
    }
    if let Some(updated) = with_notebook_root(load(), root) {
        store(&updated);
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A registry as another app would have left it.
    fn existing() -> serde_json::Value {
        serde_json::json!({
            "version": 1,
            "apps": {
                "dev-hub": {
                    "id": "dev-hub",
                    "name": "Dev Hub",
                    "exe": "C:\\tools\\Dev-Hub.exe",
                    "version": "0.2.0-beta.1",
                    "capabilities": ["launcher", "dashboard"],
                    "registeredAt": 1772899200
                }
            },
            "notebookRoot": "C:\\notes"
        })
    }

    #[test]
    fn registering_adds_this_app_without_touching_the_others() {
        let after = upsert_self(existing(), "C:\\tools\\Markdown-Notebook.exe".into(), 42);

        assert_eq!(
            after["apps"]["markdown-notebook"]["name"],
            "Markdown Notebook"
        );
        assert_eq!(
            after["apps"]["markdown-notebook"]["exe"],
            "C:\\tools\\Markdown-Notebook.exe"
        );
        assert_eq!(after["apps"]["markdown-notebook"]["registeredAt"], 42);
        // Dev Hub's entry survives verbatim — a registration is an upsert of
        // one key, not a rewrite of the file.
        assert_eq!(after["apps"]["dev-hub"], existing()["apps"]["dev-hub"]);
    }

    #[test]
    fn the_declared_capability_is_the_one_the_cli_actually_supports() {
        let after = upsert_self(existing(), "x.exe".into(), 0);
        assert_eq!(
            after["apps"]["markdown-notebook"]["capabilities"],
            serde_json::json!(["open-note-at-line"])
        );
    }

    #[test]
    fn registering_twice_updates_rather_than_duplicating() {
        let once = upsert_self(existing(), "old.exe".into(), 1);
        let twice = upsert_self(once, "new.exe".into(), 2);

        assert_eq!(twice["apps"]["markdown-notebook"]["exe"], "new.exe");
        assert_eq!(twice["apps"]["markdown-notebook"]["registeredAt"], 2);
        assert_eq!(twice["apps"].as_object().unwrap().len(), 2);
    }

    #[test]
    fn keys_written_by_a_newer_sibling_survive_a_round_trip() {
        // The whole reason this works on Values rather than typed structs: a
        // field this build has never heard of must not be dropped just because
        // Markdown Notebook happened to write the file last.
        let mut registry = existing();
        registry["apps"]["dev-hub"]["somethingNew"] = serde_json::json!("keep me");
        registry["topLevelNovelty"] = serde_json::json!(7);

        let after = upsert_self(registry, "x.exe".into(), 0);
        assert_eq!(after["apps"]["dev-hub"]["somethingNew"], "keep me");
        assert_eq!(after["topLevelNovelty"], 7);
    }

    #[test]
    fn an_empty_registry_gains_an_apps_object() {
        let after = upsert_self(serde_json::json!({}), "x.exe".into(), 0);
        assert_eq!(after["version"], 1);
        assert!(after["apps"]["markdown-notebook"].is_object());
    }

    #[test]
    fn an_apps_key_of_the_wrong_type_is_replaced_rather_than_panicking() {
        // A hand-edited file is a thing that happens.
        let after = upsert_self(serde_json::json!({ "apps": "nonsense" }), "x.exe".into(), 0);
        assert!(after["apps"]["markdown-notebook"].is_object());
    }

    #[test]
    fn the_notebook_root_is_recorded_when_it_changes() {
        let after = with_notebook_root(existing(), "D:\\other-notes").expect("it changed");
        assert_eq!(after["notebookRoot"], "D:\\other-notes");
        // And nothing else moved.
        assert_eq!(after["apps"]["dev-hub"], existing()["apps"]["dev-hub"]);
    }

    #[test]
    fn an_unchanged_notebook_root_writes_nothing() {
        // save_to_disk runs on every settings write; most have nothing to do
        // with the notebook, and rewriting the file each time would churn it.
        assert!(with_notebook_root(existing(), "C:\\notes").is_none());
    }

    #[test]
    fn a_registry_with_no_notebook_root_yet_accepts_one() {
        let bare = serde_json::json!({ "version": 1, "apps": {} });
        let after = with_notebook_root(bare, "C:\\notes").expect("absent counts as changed");
        assert_eq!(after["notebookRoot"], "C:\\notes");
    }

    #[test]
    fn the_entry_serializes_with_the_camel_case_keys_the_other_apps_read() {
        let after = upsert_self(serde_json::json!({}), "x.exe".into(), 5);
        let entry = &after["apps"]["markdown-notebook"];
        for key in [
            "id",
            "name",
            "exe",
            "version",
            "capabilities",
            "registeredAt",
        ] {
            assert!(entry.get(key).is_some(), "missing {key}");
        }
    }
}

