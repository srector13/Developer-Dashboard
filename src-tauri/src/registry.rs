//! The provider registry: which providers exist, when they refresh, and where
//! their results are cached.
//!
//! One background task per provider, each on its own interval. Results land in
//! `AppState` and a `provider-updated` event goes to both windows. The launcher
//! reads that cache and never triggers a refresh itself, which is what makes it
//! open instantly.

use crate::model::ProviderResult;
use crate::providers::{command, health, launch, projects, todos, Provider};
use crate::settings::{AppSettings, HubConfig};
use crate::state::AppState;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

/// Ids that a `command` provider may not claim, so a config typo can't shadow
/// a built-in card.
const RESERVED_IDS: &[&str] = &[launch::ID, projects::ID, todos::ID, health::ID];

/// Build the live provider set from the settings toggles and the user's config.
/// Adding a provider means adding one line here.
pub fn build(settings: &AppSettings, config: &HubConfig) -> Vec<Arc<dyn Provider>> {
    let mut providers: Vec<Arc<dyn Provider>> = Vec::new();

    if settings.providers.launch {
        providers.push(Arc::new(launch::LaunchProvider));
    }
    if settings.providers.projects {
        providers.push(Arc::new(projects::ProjectsProvider));
    }
    if settings.providers.todos {
        providers.push(Arc::new(todos::TodosProvider));
    }
    if settings.providers.health {
        providers.push(Arc::new(health::HealthProvider {
            interval: config.health.interval_seconds,
        }));
    }

    for entry in &config.command {
        let id = entry.id.trim();
        if id.is_empty() || RESERVED_IDS.contains(&id) {
            eprintln!("Ignoring a command provider with an empty or reserved id: {id:?}");
            continue;
        }
        if !settings.providers.enabled(id) {
            continue;
        }
        providers.push(Arc::new(command::CommandProvider::new(entry.clone())));
    }

    providers
}

/// Send a result to both windows with the user's per-item edits applied.
///
/// The cache holds what the provider produced; every way *out* of it applies
/// overrides. Emitting the raw result was the bug behind "my nicknames vanish
/// when a card refreshes" — `get_results` applied them, this didn't, so the
/// renderer's copy was replaced with un-customised items on every refresh and
/// anything re-rendering from that copy (the view toggle, say) showed them too.
fn emit_result(app: &AppHandle, result: &ProviderResult) {
    let state = app.state::<AppState>();
    let mut display = result.clone();
    display.items = state.apply_overrides(display.items);
    let _ = app.emit("provider-updated", &display);
}

/// Refresh one provider now and cache the result. Returns the result so
/// `refresh_provider` can hand it straight back to the caller.
pub async fn refresh_one(
    app: &AppHandle,
    provider: Arc<dyn Provider>,
    config: &HubConfig,
) -> ProviderResult {
    let result = provider.items(config).await;
    let state = app.state::<AppState>();
    let previous = state.result(provider.id());
    // Raw into the cache, so an override can be changed or removed later
    // without re-running the provider.
    state.set_result(result.clone());
    notify_new_failures(app, previous.as_ref(), &result);
    emit_result(app, &result);

    // What the caller gets back is what it will display.
    let mut display = result;
    display.items = state.apply_overrides(display.items);
    display
}

/// Tell the user when something that was fine has broken.
///
/// Only the transition is worth a notification — a service that has been down
/// all afternoon should not toast every refresh interval, which is the fastest
/// way to teach someone to ignore the app. Off unless they asked for it.
fn notify_new_failures(
    app: &AppHandle,
    previous: Option<&ProviderResult>,
    current: &ProviderResult,
) {
    use tauri_plugin_notification::NotificationExt;

    let state = app.state::<AppState>();
    if !state.settings().notify_on_failure {
        return;
    }
    // Nothing to compare against on the first load: everything would look new,
    // and announcing a service that was already down at launch is noise.
    let Some(previous) = previous else { return };
    if previous.refreshed_at == 0 {
        return;
    }

    let was_failing: std::collections::HashSet<&str> = previous
        .items
        .iter()
        .filter(|item| item.status == crate::model::Status::Error)
        .map(|item| item.id.as_str())
        .collect();

    for item in current
        .items
        .iter()
        .filter(|item| item.status == crate::model::Status::Error)
    {
        if was_failing.contains(item.id.as_str()) {
            continue; // already known to be down
        }
        let body = item
            .subtitle
            .clone()
            .unwrap_or_else(|| "Not responding".into());
        let _ = app
            .notification()
            .builder()
            .title(format!("{} is failing", item.title))
            .body(body)
            .show();
    }
}

/// Rebuild the provider set and restart its refresh loops.
///
/// Every loop carries the generation it was spawned for; bumping the counter is
/// what makes the previous set stand down, so a config reload replaces the
/// schedule instead of stacking a second one on top of it.
pub fn restart(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let config = state.config();
    let providers = build(&settings, &config);

    let live: Vec<String> = providers.iter().map(|p| p.id().to_string()).collect();
    state.retain_results(&live);

    // Seed a pending result for anything not yet cached, so the dashboard can
    // paint every card immediately instead of growing the grid as results land.
    for provider in &providers {
        if state.result(provider.id()).is_none() {
            let pending = ProviderResult::pending(provider.id(), provider.display_name());
            state.set_result(pending.clone());
            emit_result(app, &pending);
        }
    }

    // The notes watcher follows the config's todo roots, so it is re-armed
    // whenever the provider set is rebuilt.
    crate::desktop::watch_todo_roots(app);

    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    for provider in providers {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let (config, current) = {
                    let state = app.state::<AppState>();
                    (state.config(), state.generation.load(Ordering::SeqCst))
                };
                if current != generation {
                    return; // a newer registry took over
                }

                refresh_one(&app, provider.clone(), &config).await;

                let interval = provider.refresh_interval();
                if interval == 0 {
                    return; // on-demand only; the config watcher re-runs it
                }
                tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
            }
        });
    }
}

/// Force a refresh of one provider by id, bypassing its interval.
pub async fn refresh_provider(app: &AppHandle, id: &str) -> Result<ProviderResult, String> {
    let (settings, config) = {
        let state = app.state::<AppState>();
        (state.settings(), state.config())
    };
    let provider = build(&settings, &config)
        .into_iter()
        .find(|p| p.id() == id)
        .ok_or_else(|| format!("No provider named {id}"))?;
    Ok(refresh_one(app, provider, &config).await)
}

/// Force a refresh of everything, concurrently.
pub async fn refresh_all(app: &AppHandle) -> Vec<ProviderResult> {
    let (settings, config) = {
        let state = app.state::<AppState>();
        (state.settings(), state.config())
    };
    let providers = build(&settings, &config);

    let mut set = tokio::task::JoinSet::new();
    for provider in providers {
        let app = app.clone();
        let config = config.clone();
        set.spawn(async move { refresh_one(&app, provider, &config).await });
    }

    let mut results = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(result) = joined {
            results.push(result);
        }
    }
    results.sort_by(|a, b| a.provider.cmp(&b.provider));
    results
}

/// Re-read `hub.config.json` and rebuild everything. Called by the file watcher
/// and by the tray's reload item — adding a project root shows up without a
/// restart.
pub fn reload_config(app: &AppHandle) {
    let state = app.state::<AppState>();
    match state.reload_config() {
        Ok(_) => {
            let _ = app.emit("config-changed", serde_json::json!({ "ok": true }));
        }
        Err(err) => {
            let _ = app.emit(
                "config-changed",
                serde_json::json!({ "ok": false, "error": err }),
            );
        }
    }
    restart(app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{CommandProviderConfig, ProviderToggles};

    fn command_entry(id: &str) -> CommandProviderConfig {
        CommandProviderConfig {
            id: id.into(),
            name: id.into(),
            program: "echo".into(),
            args: vec!["[]".into()],
            cwd: None,
            interval_seconds: 300,
            timeout_ms: 5000,
        }
    }

    fn ids(providers: &[Arc<dyn Provider>]) -> Vec<String> {
        providers.iter().map(|p| p.id().to_string()).collect()
    }

    #[test]
    fn every_builtin_is_registered_by_default_in_config_order() {
        let providers = build(&AppSettings::default(), &HubConfig::default());
        assert_eq!(
            ids(&providers),
            vec!["launch", "projects", "todos", "health"]
        );
    }

    #[test]
    fn a_disabled_provider_is_not_built_at_all() {
        let settings = AppSettings {
            providers: ProviderToggles {
                todos: false,
                ..Default::default()
            },
            ..Default::default()
        };
        let providers = build(&settings, &HubConfig::default());
        assert!(!ids(&providers).contains(&"todos".to_string()));
    }

    #[test]
    fn command_providers_are_appended_in_config_order() {
        let config = HubConfig {
            command: vec![command_entry("prs"), command_entry("builds")],
            ..Default::default()
        };
        let providers = build(&AppSettings::default(), &config);
        assert_eq!(&ids(&providers)[4..], &["prs", "builds"]);
    }

    #[test]
    fn a_command_provider_cannot_shadow_a_builtin_id() {
        let config = HubConfig {
            command: vec![command_entry("projects"), command_entry("")],
            ..Default::default()
        };
        let providers = build(&AppSettings::default(), &config);
        assert_eq!(
            ids(&providers),
            vec!["launch", "projects", "todos", "health"]
        );
        // The surviving `projects` is the built-in, on its own 120s interval.
        assert_eq!(providers[1].refresh_interval(), 120);
    }

    #[test]
    fn the_health_interval_comes_from_the_users_config() {
        let config = HubConfig {
            health: crate::settings::HealthConfig {
                interval_seconds: 15,
                ..Default::default()
            },
            ..Default::default()
        };
        let providers = build(&AppSettings::default(), &config);
        let health = providers.iter().find(|p| p.id() == "health").unwrap();
        assert_eq!(health.refresh_interval(), 15);
    }

    #[test]
    fn the_launch_provider_is_config_driven_rather_than_polled() {
        let providers = build(&AppSettings::default(), &HubConfig::default());
        assert_eq!(providers[0].refresh_interval(), 0);
    }
}
