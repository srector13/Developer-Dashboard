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
        let results = self.results.read().unwrap();
        match provider {
            Some(id) => results.get(id).map(|r| r.items.clone()).unwrap_or_default(),
            None => results.values().flat_map(|r| r.items.clone()).collect(),
        }
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
