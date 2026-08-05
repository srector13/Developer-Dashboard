//! Where a portable app keeps its state, and how it reads a config file
//! without ever losing a key.
//!
//! Both halves were written twice before this crate existed — once in Dev Hub,
//! once in Markdown Notebook — and the second copy had already drifted. The
//! rules they encode are the same for every app in the suite:
//!
//!   * state lives in a folder beside the exe, so the app travels;
//!   * if that folder is not writable, fall back to per-user AppData rather
//!     than refusing to start;
//!   * every config file is merged onto its defaults on read, so a partial or
//!     hand-trimmed file never silently loses keys.
//!
//! What each app calls its folder and what shape its config takes is the app's
//! business. This crate owns the mechanism only.

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// The data directory for one app, resolved once and carried around.
///
/// `portable_name` is the folder beside the exe (`DevHubData`); `fallback_name`
/// is the folder under `%APPDATA%` used when the exe landed somewhere
/// read-only, e.g. Program Files.
#[derive(Debug, Clone)]
pub struct AppDirs {
    root: PathBuf,
}

impl AppDirs {
    pub fn resolve(portable_name: &str, fallback_name: &str) -> Self {
        Self {
            root: resolve_data_dir(portable_name, fallback_name),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn file(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
}

/// Portable mode is the only mode these builds ship in: all app state lives
/// beside the executable, so the app travels with a USB stick or a Downloads
/// folder. If that folder can't be created or written, fall back to the
/// per-user AppData location rather than failing to start.
pub fn resolve_data_dir(portable_name: &str, fallback_name: &str) -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sidecar = dir.join(portable_name);
            if std::fs::create_dir_all(&sidecar).is_ok() && is_writable(&sidecar) {
                return sidecar;
            }
        }
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".config")))
        .unwrap_or_else(std::env::temp_dir);
    let fallback = base.join(fallback_name);
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

/// `%USERPROFILE%` on Windows, `$HOME` elsewhere. This is where the suite
/// registry and the notebook pointer live — per user, not per app, because
/// their whole job is to be found by an app that didn't write them.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

// ---------------------------------------------------------------------------
// Merge on read
// ---------------------------------------------------------------------------

/// Object merge one level deep at a time, recursing into nested objects, so a
/// sub-object keeps the default for any key the caller omitted (matching the
/// JS spread the renderers use).
///
/// A `null` in the override is treated as "not mentioned" rather than as a
/// value: hand-editing a key to `null` should restore the default, not blank
/// the setting out.
pub fn merge_shallow(base: serde_json::Value, over: serde_json::Value) -> serde_json::Value {
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

/// Merge a raw JSON value onto `T::default()` and deserialize it.
///
/// A value that cannot be deserialized even after merging — a key holding
/// entirely the wrong type — falls back to the defaults rather than panicking.
/// A settings file is a thing people hand-edit; a typo in it must not be the
/// difference between an app that starts and one that doesn't.
///
/// # `Default` is the source of truth, not `#[serde(default = "…")]`
///
/// This function reads defaults from `T::default()`, so a `#[serde(default =
/// "default_true")]` on a field whose `Default` impl is *derived* is a bug:
/// the derived value (`false`) wins and the serde attribute never runs,
/// because after merging there is no missing key for it to fill in.
///
/// Any type used here that has a non-trivial default must write `Default` out
/// by hand, mirroring every `serde(default = …)` on it. Three separate
/// versions of this went wrong the first time the suite's config types were
/// written — a source list that arrived switched off, a registry that called
/// itself version 0, a set of highlight rules that silently vanished.
pub fn merge_onto_defaults<T>(raw: serde_json::Value) -> T
where
    T: Default + Serialize + DeserializeOwned,
{
    let defaults = match serde_json::to_value(T::default()) {
        Ok(value) => value,
        Err(_) => return T::default(),
    };
    serde_json::from_value(merge_shallow(defaults, raw)).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

/// Read a JSON file and merge it onto `T::default()`. A missing or unreadable
/// file is not an error — it is a first run.
pub fn load_or_default<T>(path: &Path) -> T
where
    T: Default + Serialize + DeserializeOwned,
{
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(value) => merge_onto_defaults(value),
            Err(_) => T::default(),
        },
        Err(_) => T::default(),
    }
}

/// Write a value as pretty JSON, creating the parent directory if needed.
pub fn save_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(value)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Nested {
        alpha: bool,
        beta: u32,
    }

    impl Default for Nested {
        fn default() -> Self {
            Self {
                alpha: true,
                beta: 7,
            }
        }
    }

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Sample {
        theme: String,
        nested: Nested,
    }

    impl Default for Sample {
        fn default() -> Self {
            Self {
                theme: "system".into(),
                nested: Nested::default(),
            }
        }
    }

    #[test]
    fn a_partial_file_keeps_every_key_it_did_not_mention() {
        let merged: Sample = merge_onto_defaults(serde_json::json!({ "theme": "dark" }));
        assert_eq!(merged.theme, "dark");
        assert_eq!(merged.nested, Nested::default());
    }

    #[test]
    fn a_partial_sub_object_keeps_its_siblings() {
        let merged: Sample = merge_onto_defaults(serde_json::json!({ "nested": { "beta": 1 } }));
        assert_eq!(merged.nested.beta, 1);
        assert!(merged.nested.alpha, "alpha was not mentioned, so it stands");
    }

    #[test]
    fn a_null_restores_the_default_rather_than_blanking_the_key() {
        let merged: Sample = merge_onto_defaults(serde_json::json!({ "theme": null }));
        assert_eq!(merged.theme, "system");
    }

    #[test]
    fn a_key_of_entirely_the_wrong_type_falls_back_instead_of_panicking() {
        let merged: Sample = merge_onto_defaults(serde_json::json!({ "nested": 7 }));
        assert_eq!(merged, Sample::default());
    }

    #[test]
    fn a_missing_file_is_a_first_run_not_a_failure() {
        let missing = std::env::temp_dir().join("suite-config-does-not-exist.json");
        let _ = std::fs::remove_file(&missing);
        let loaded: Sample = load_or_default(&missing);
        assert_eq!(loaded, Sample::default());
    }

    #[test]
    fn saving_then_loading_round_trips_through_the_merge() {
        let dir = std::env::temp_dir().join("suite-config-roundtrip");
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join("nested").join("settings.json");

        let written = Sample {
            theme: "dark".into(),
            nested: Nested {
                alpha: false,
                beta: 3,
            },
        };
        save_json(&file, &written).expect("save creates the parent directory");
        assert_eq!(load_or_default::<Sample>(&file), written);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_data_dir_is_created_and_writable() {
        let dirs = AppDirs::resolve("SuiteConfigTestData", "SuiteConfigTest");
        assert!(dirs.root().is_dir());
        assert_eq!(dirs.file("a.json").file_name().unwrap(), "a.json");
    }
}
