//! Shared backend state.
//!
//! The Electron main process kept all of this in module-level `let` bindings.
//! Here it lives in one struct behind `tauri::State`. Locks are always taken in
//! a tight scope and never held across an `.await`, so commands stay `Send`.

use crate::notebook::{PersistedMeta, ScanCacheEntry, SearchDoc, SCAN_CACHE_MAX};
use crate::settings::{self, AppSettings};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock};

/// A screenshot waiting for the region overlay to crop it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingShot {
    pub data_url: String,
    pub scale_factor: f64,
    pub width: u32,
    pub height: u32,
    #[serde(skip)]
    pub png: Vec<u8>,
}

/// The parsed shortcuts currently registered with the OS. Stored as
/// `Shortcut` rather than the accelerator text so the global-shortcut handler
/// can match by value — its `Display` format ("shift+control+KeyN") does not
/// round-trip to the accelerator strings settings.json holds.
#[derive(Default)]
pub struct RegisteredShortcuts {
    pub quick_capture: Option<tauri_plugin_global_shortcut::Shortcut>,
    pub clipboard_capture: Option<tauri_plugin_global_shortcut::Shortcut>,
}

pub struct AppState {
    settings: RwLock<AppSettings>,
    scan_cache: Mutex<HashMap<String, ScanCacheEntry>>,
    persisted_meta: Mutex<HashMap<String, PersistedMeta>>,
    search_index: RwLock<HashMap<String, SearchDoc>>,
    /// Held by the background search-doc builder for the duration of a build.
    /// Searches acquire it first so results are never silently partial.
    pub index_gate: tokio::sync::Mutex<()>,
    pub pending_shot: Mutex<Option<PendingShot>>,
    pub shortcuts: Mutex<RegisteredShortcuts>,
    /// Mirrored from settings so the synchronous window close handler can read
    /// it without touching the settings lock.
    pub keep_in_tray: AtomicBool,
    pub quitting: AtomicBool,
}

impl AppState {
    pub fn load() -> Self {
        let settings = settings::load_from_disk();
        let keep = settings.keep_in_tray;
        Self {
            settings: RwLock::new(settings),
            scan_cache: Mutex::new(HashMap::new()),
            persisted_meta: Mutex::new(load_persisted_meta()),
            search_index: RwLock::new(HashMap::new()),
            index_gate: tokio::sync::Mutex::new(()),
            pending_shot: Mutex::new(None),
            shortcuts: Mutex::new(RegisteredShortcuts::default()),
            keep_in_tray: AtomicBool::new(keep),
            quitting: AtomicBool::new(false),
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
                for (k, v) in patch_map {
                    base_map.insert(k.clone(), v.clone());
                }
            }
            settings::migrate(base)
        };
        *self.settings.write().unwrap() = merged.clone();
        self.keep_in_tray
            .store(merged.keep_in_tray, Ordering::Relaxed);
        if let Err(err) = settings::save_to_disk(&merged) {
            eprintln!("Failed to write settings: {err}");
        }
        merged
    }

    // --- caches -----------------------------------------------------------

    pub fn with_caches<R>(
        &self,
        f: impl FnOnce(&mut HashMap<String, ScanCacheEntry>, &mut HashMap<String, PersistedMeta>) -> R,
    ) -> R {
        let mut cache = self.scan_cache.lock().unwrap();
        let mut persisted = self.persisted_meta.lock().unwrap();
        f(&mut cache, &mut persisted)
    }

    /// Drop cache entries for files that no longer exist, and bound the size.
    pub fn prune_caches(&self, seen: &std::collections::HashSet<String>) {
        let mut cache = self.scan_cache.lock().unwrap();
        cache.retain(|k, _| seen.contains(k));
        if cache.len() > SCAN_CACHE_MAX {
            cache.clear(); // belt-and-braces bound; the next scan rebuilds
        }
        drop(cache);
        let mut persisted = self.persisted_meta.lock().unwrap();
        persisted.retain(|k, _| seen.contains(k));
    }

    pub fn record_scanned(&self, path: String, entry: ScanCacheEntry) {
        let persisted = PersistedMeta {
            mtime_ms: entry.mtime_ms,
            size: entry.size,
            meta: entry.meta.clone(),
        };
        self.scan_cache.lock().unwrap().insert(path.clone(), entry);
        self.persisted_meta.lock().unwrap().insert(path, persisted);
    }

    pub fn save_meta_cache(&self) {
        let snapshot = self.persisted_meta.lock().unwrap().clone();
        if let Ok(text) = serde_json::to_string(&snapshot) {
            let _ = std::fs::write(settings::scan_meta_cache_file(), text);
        }
    }

    // --- search index -----------------------------------------------------

    /// Atomic swap: notes deleted since the last scan vanish from search.
    pub fn replace_index(&self, docs: HashMap<String, SearchDoc>) {
        *self.search_index.write().unwrap() = docs;
    }

    pub fn index_insert(&self, path: String, doc: SearchDoc) {
        self.search_index.write().unwrap().insert(path, doc);
    }

    pub fn index_docs(&self) -> Vec<SearchDoc> {
        self.search_index.read().unwrap().values().cloned().collect()
    }
}

fn load_persisted_meta() -> HashMap<String, PersistedMeta> {
    std::fs::read_to_string(settings::scan_meta_cache_file())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}
