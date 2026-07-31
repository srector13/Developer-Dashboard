//! Shared backend state: settings, the user's config, the provider cache and
//! the usage counters behind recency ranking.
//!
//! Locks are always taken in a tight scope and never held across an `.await`,
//! so commands stay `Send` and a slow provider can't block a launcher keystroke.

use crate::model::{Item, ProviderResult};
use crate::search::{Usage, UsageMap};
use crate::settings::{self, AppSettings, HubConfig};
use crate::util;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};

/// The live state of the global launcher hotkey, as the settings screen and the
/// startup banner report it.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    pub accelerator: String,
    /// Defaults to false: until `apply_shortcut` has run and said otherwise,
    /// claiming a working hotkey is exactly the lie this type exists to stop.
    pub registered: bool,
    /// Present only when registration failed, phrased for a person to act on.
    pub error: Option<String>,
}

pub struct AppState {
    settings: RwLock<AppSettings>,
    config: RwLock<HubConfig>,
    /// Set when `hub.config.json` won't parse. The dashboard shows it as a
    /// banner rather than pretending the user has an empty config.
    config_error: RwLock<Option<String>>,
    /// The last `ProviderResult` per provider id. Both windows read this; the
    /// launcher never triggers a refresh, which is why it opens instantly.
    results: RwLock<HashMap<String, ProviderResult>>,
    usage: Mutex<UsageMap>,
    pub shortcut: Mutex<Option<tauri_plugin_global_shortcut::Shortcut>>,
    /// Whether the launcher hotkey actually registered with the OS.
    ///
    /// This is *stored*, not just emitted, because `apply_shortcut` runs in
    /// `setup()` — before the dashboard's webview exists, let alone before it
    /// has attached an event listener. An emit at that point goes nowhere, so a
    /// hotkey that failed to register looked identical to one that worked:
    /// press it, nothing happens, no explanation anywhere.
    shortcut_status: RwLock<ShortcutStatus>,
    /// Mirrored from settings so the synchronous window-close handler can read
    /// it without touching the settings lock.
    pub keep_in_tray: AtomicBool,
    pub quitting: AtomicBool,
    /// Bumped whenever the provider set is rebuilt. Refresh loops carry the
    /// generation they were spawned for and exit when it moves on, which is how
    /// a config hot-reload replaces the schedule without leaking timers.
    pub generation: AtomicU64,
}

impl AppState {
    pub fn load() -> Self {
        let settings = settings::load_settings();
        let keep = settings.keep_in_tray;
        let (config, config_error) = match settings::load_config() {
            Ok(config) => (config, None),
            Err(err) => (HubConfig::default(), Some(err)),
        };

        Self {
            settings: RwLock::new(settings),
            config: RwLock::new(config),
            config_error: RwLock::new(config_error),
            results: RwLock::new(HashMap::new()),
            usage: Mutex::new(load_usage()),
            shortcut: Mutex::new(None),
            shortcut_status: RwLock::new(ShortcutStatus::default()),
            keep_in_tray: AtomicBool::new(keep),
            quitting: AtomicBool::new(false),
            generation: AtomicU64::new(0),
        }
    }

    // --- settings ---------------------------------------------------------

    pub fn settings(&self) -> AppSettings {
        self.settings.read().unwrap().clone()
    }

    /// Merge a partial settings patch, persist it and return the result.
    pub fn update_settings(&self, patch: serde_json::Value) -> AppSettings {
        let merged = {
            let current = self.settings.read().unwrap().clone();
            let mut base = serde_json::to_value(&current).unwrap_or_default();
            if let (Some(base_map), Some(patch_map)) = (base.as_object_mut(), patch.as_object()) {
                for (key, value) in patch_map {
                    base_map.insert(key.clone(), value.clone());
                }
            }
            settings::migrate(base)
        };
        *self.settings.write().unwrap() = merged.clone();
        self.keep_in_tray
            .store(merged.keep_in_tray, Ordering::Relaxed);
        if let Err(err) = settings::save_settings(&merged) {
            eprintln!("Failed to write settings: {err}");
        }
        merged
    }

    // --- shortcut ---------------------------------------------------------

    pub fn shortcut_status(&self) -> ShortcutStatus {
        self.shortcut_status.read().unwrap().clone()
    }

    pub fn set_shortcut_status(&self, status: ShortcutStatus) {
        *self.shortcut_status.write().unwrap() = status;
    }

    // --- config -----------------------------------------------------------

    pub fn config(&self) -> HubConfig {
        self.config.read().unwrap().clone()
    }

    pub fn config_error(&self) -> Option<String> {
        self.config_error.read().unwrap().clone()
    }

    /// Re-read `hub.config.json`. A parse failure keeps the last good config in
    /// memory — a stray comma should not empty every card on screen.
    pub fn reload_config(&self) -> Result<HubConfig, String> {
        match settings::load_config() {
            Ok(config) => {
                *self.config.write().unwrap() = config.clone();
                *self.config_error.write().unwrap() = None;
                Ok(config)
            }
            Err(err) => {
                *self.config_error.write().unwrap() = Some(err.clone());
                Err(err)
            }
        }
    }

    pub fn set_config(&self, config: HubConfig) {
        *self.config.write().unwrap() = config;
        *self.config_error.write().unwrap() = None;
    }

    // --- provider cache ---------------------------------------------------

    pub fn set_result(&self, result: ProviderResult) {
        self.results
            .write()
            .unwrap()
            .insert(result.provider.clone(), result);
    }

    pub fn result(&self, provider: &str) -> Option<ProviderResult> {
        self.results.read().unwrap().get(provider).cloned()
    }

    pub fn results(&self) -> Vec<ProviderResult> {
        self.results.read().unwrap().values().cloned().collect()
    }

    /// Drop cached results for providers that no longer exist, so a card the
    /// user just disabled doesn't linger.
    pub fn retain_results(&self, live: &[String]) {
        self.results
            .write()
            .unwrap()
            .retain(|id, _| live.iter().any(|l| l == id));
    }

    pub fn items(&self, provider: Option<&str>) -> Vec<Item> {
        let raw: Vec<Item> = {
            let results = self.results.read().unwrap();
            match provider {
                Some(id) => results.get(id).map(|r| r.items.clone()).unwrap_or_default(),
                None => results.values().flat_map(|r| r.items.clone()).collect(),
            }
        };
        self.apply_overrides(raw)
    }

    /// Apply the user's per-item edits, and drop the ones they hid.
    ///
    /// Done here rather than in each provider so exactly one place decides what
    /// an item looks like — a nickname that showed on the dashboard but not in
    /// the launcher would be worse than no nickname at all.
    pub fn apply_overrides(&self, items: Vec<Item>) -> Vec<Item> {
        let overrides = self.settings.read().unwrap().item_overrides.clone();
        if overrides.is_empty() {
            return items;
        }
        items
            .into_iter()
            .filter_map(|mut item| {
                let Some(patch) = overrides.get(&item.key()) else {
                    return Some(item);
                };
                if patch.hidden {
                    return None;
                }
                if let Some(nickname) = patch.nickname.as_deref() {
                    item.title = nickname.to_string();
                    // A nickname is typed into a text field, not lifted out of
                    // a note, so it is never parsed as markdown.
                    item.rich_title = false;
                }
                if let Some(icon) = patch.icon.clone() {
                    item.icon = Some(icon);
                }
                if let Some(accent) = patch.accent.clone() {
                    item.accent = Some(accent);
                }
                if let Some(icon_data) = patch.icon_data.clone() {
                    item.icon_data = Some(icon_data);
                }
                // A priority set by hand beats one parsed out of the note.
                if let Some(priority) = patch.priority.clone() {
                    item.priority = Some(priority);
                }
                Some(item)
            })
            .collect()
    }

    /// Merge one item's override, dropping it entirely when it says nothing.
    pub fn set_item_override(&self, key: &str, patch: crate::settings::ItemOverride) {
        let patch = patch.sanitised();
        let snapshot = {
            let mut settings = self.settings.write().unwrap();
            if patch.is_empty() {
                settings.item_overrides.remove(key);
            } else {
                settings.item_overrides.insert(key.to_string(), patch);
            }
            settings.clone()
        };
        if let Err(err) = settings::save_settings(&snapshot) {
            eprintln!("Failed to write settings: {err}");
        }
    }

    /// The keys the user has hidden, so Settings can offer them back.
    pub fn hidden_items(&self) -> Vec<String> {
        let settings = self.settings.read().unwrap();
        let mut keys: Vec<String> = settings
            .item_overrides
            .iter()
            .filter(|(_, patch)| patch.hidden)
            .map(|(key, _)| key.clone())
            .collect();
        keys.sort();
        keys
    }

    /// Resolve an item by its namespaced key. This is the only way an action
    /// ever gets executed: the renderer sends a key and an index, never a
    /// program name.
    pub fn find_item(&self, key: &str) -> Option<Item> {
        self.results
            .read()
            .unwrap()
            .values()
            .flat_map(|r| r.items.iter())
            .find(|item| item.key() == key)
            .cloned()
    }

    // --- usage ------------------------------------------------------------

    pub fn usage(&self) -> UsageMap {
        self.usage.lock().unwrap().clone()
    }

    pub fn record_usage(&self, key: &str) {
        {
            let mut usage = self.usage.lock().unwrap();
            let entry = usage.entry(key.to_string()).or_default();
            entry.count = entry.count.saturating_add(1);
            entry.last = util::now_secs();
        }
        self.save_usage();
    }

    pub fn save_usage(&self) {
        let snapshot = self.usage.lock().unwrap().clone();
        if let Ok(text) = serde_json::to_string_pretty(&snapshot) {
            let _ = std::fs::write(settings::usage_file(), text);
        }
    }
}

fn load_usage() -> UsageMap {
    std::fs::read_to_string(settings::usage_file())
        .ok()
        .and_then(|text| serde_json::from_str::<HashMap<String, Usage>>(&text).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use crate::model::Item;
    use crate::settings::ItemOverride;
    use std::collections::HashMap;

    /// `apply_overrides` reads from `AppState`, which needs a real app to build.
    /// The logic under test is the mapping itself, so it is exercised directly
    /// against the same override map.
    fn apply(items: Vec<Item>, overrides: &HashMap<String, ItemOverride>) -> Vec<Item> {
        items
            .into_iter()
            .filter_map(|mut item| {
                let Some(patch) = overrides.get(&item.key()) else {
                    return Some(item);
                };
                if patch.hidden {
                    return None;
                }
                if let Some(nickname) = patch.nickname.as_deref() {
                    item.title = nickname.to_string();
                    item.rich_title = false;
                }
                if let Some(icon) = patch.icon.clone() {
                    item.icon = Some(icon);
                }
                if let Some(accent) = patch.accent.clone() {
                    item.accent = Some(accent);
                }
                if let Some(icon_data) = patch.icon_data.clone() {
                    item.icon_data = Some(icon_data);
                }
                if let Some(priority) = patch.priority.clone() {
                    item.priority = Some(priority);
                }
                Some(item)
            })
            .collect()
    }

    #[test]
    fn an_override_renames_recolours_and_reicons_its_item() {
        let mut overrides = HashMap::new();
        overrides.insert(
            "projects::repo".to_string(),
            ItemOverride {
                nickname: Some("Payments".into()),
                icon: Some("star".into()),
                accent: Some("#bc8cff".into()),
                priority: Some("high".into()),
                ..Default::default()
            },
        );

        let items = vec![
            Item::new("projects", "repo", "payments-api"),
            Item::new("projects", "other", "orders"),
        ];
        let out = apply(items, &overrides);

        assert_eq!(out[0].title, "Payments");
        assert_eq!(out[0].icon.as_deref(), Some("star"));
        assert_eq!(out[0].accent.as_deref(), Some("#bc8cff"));
        assert_eq!(out[0].priority.as_deref(), Some("high"));
        // Untouched items are exactly what the provider produced.
        assert_eq!(out[1].title, "orders");
        assert_eq!(out[1].accent, None);
    }

    #[test]
    fn a_nickname_is_never_reparsed_as_markdown() {
        let mut overrides = HashMap::new();
        overrides.insert(
            "todos::t1".to_string(),
            ItemOverride {
                nickname: Some("ship **it**".into()),
                ..Default::default()
            },
        );
        let mut item = Item::new("todos", "t1", "original");
        item.rich_title = true;

        let out = apply(vec![item], &overrides);
        assert_eq!(out[0].title, "ship **it**");
        assert!(
            !out[0].rich_title,
            "a nickname is typed into a field, not lifted from a note"
        );
    }

    #[test]
    fn a_hidden_item_is_dropped_entirely() {
        let mut overrides = HashMap::new();
        overrides.insert(
            "launch::jenkins".to_string(),
            ItemOverride {
                hidden: true,
                ..Default::default()
            },
        );
        let out = apply(
            vec![
                Item::new("launch", "jenkins", "Jenkins"),
                Item::new("launch", "docs", "Docs"),
            ],
            &overrides,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title, "Docs");
    }

    #[test]
    fn an_override_for_another_provider_does_not_leak_across() {
        // Ids are only unique within a provider, which is why the key is
        // namespaced — this guards that it stays that way.
        let mut overrides = HashMap::new();
        overrides.insert(
            "launch::shared".to_string(),
            ItemOverride {
                nickname: Some("Renamed".into()),
                ..Default::default()
            },
        );
        let out = apply(
            vec![
                Item::new("launch", "shared", "Launch one"),
                Item::new("projects", "shared", "Project one"),
            ],
            &overrides,
        );
        assert_eq!(out[0].title, "Renamed");
        assert_eq!(out[1].title, "Project one");
    }
}
