// Bridge between the renderer and the Rust backend.
//
// Two globals, one per window: `window.hubApi` for the dashboard and
// `window.launcherApi` for the launcher. Every method is a thin wrapper over
// `invoke` with the same camelCase→snake_case convention Markdown Notebook
// uses; see src-tauri/src/commands.rs for the other side.
//
// Loaded before app.js and synchronous, so page code can call it at top level.
(function () {
  'use strict';

  const T = window.__TAURI__;
  if (!T) {
    // A plain browser (the renderer specs) — leave the globals alone so the
    // tests can install their own stubs.
    return;
  }

  const invoke = T.core.invoke;
  const listen = T.event.listen;

  // Tauri's listen() resolves the unsubscribe function asynchronously; callers
  // only ever call the returned function, so hand back a thunk that awaits it.
  function on(event, handler) {
    const pending = listen(event, handler);
    return () => { pending.then((unlisten) => unlisten()); };
  }

  // ==========================================================================
  // Dashboard
  // ==========================================================================

  window.hubApi = {
    getSettings: () => invoke('get_settings'),
    saveSettings: (settings) => invoke('save_settings', { settings }),
    getAppVersion: () => invoke('app_version'),

    // First-run setup
    setupSuggestions: () => invoke('setup_suggestions'),
    runAtLogin: () => invoke('run_at_login'),
    setRunAtLogin: (enabled) => invoke('set_run_at_login', { enabled }),

    // The hotkey, reported rather than assumed — see commands::shortcut_status.
    shortcutStatus: () => invoke('shortcut_status'),
    shortcutSuggestions: () => invoke('shortcut_suggestions'),
    setLauncherShortcut: (accelerator) => invoke('set_launcher_shortcut', { accelerator }),

    getConfig: () => invoke('get_config'),
    getConfigJson: () => invoke('get_config_json'),
    saveConfig: (text) => invoke('save_config', { text }),
    saveConfigJson: (config) => invoke('save_config_json', { config }),
    revealConfigFile: () => invoke('reveal_config_file'),
    pickFolder: () => invoke('pick_folder'),
    pickProgram: () => invoke('pick_program'),

    listProviders: () => invoke('list_providers'),
    getResults: () => invoke('get_results'),
    getItems: (provider) => invoke('get_items', { provider: provider || null }),
    refreshProvider: (provider) => invoke('refresh_provider', { provider }),
    refreshAll: () => invoke('refresh_all'),
    searchItems: (query, provider, maxResults) =>
      invoke('search_items', {
        query,
        provider: provider || null,
        maxResults: maxResults || null,
      }),

    // The renderer sends an item key and an action index — never a program.
    runAction: (itemId, actionIndex) => invoke('run_action', { itemId, actionIndex }),
    openExternal: (url) => invoke('open_external', { url }),
    showLauncher: () => { invoke('show_launcher'); },

    onProviderUpdated: (cb) => on('provider-updated', (e) => cb(e.payload)),
    onConfigChanged: (cb) => on('config-changed', (e) => cb(e.payload)),
    onShortcutStatus: (cb) => on('shortcut-status', (e) => cb(e.payload)),
  };

  // ==========================================================================
  // Launcher — deliberately tiny. It reads the cache and runs actions; it can
  // neither change settings nor edit the config.
  // ==========================================================================

  window.launcherApi = {
    context: () => invoke('launcher_context'),
    search: (query, provider, maxResults) =>
      invoke('search_items', {
        query,
        provider: provider || null,
        maxResults: maxResults || null,
      }),
    run: (itemId, actionIndex) => invoke('run_action', { itemId, actionIndex }),
    refresh: (provider) => invoke('refresh_provider', { provider }),
    resize: (height) => { invoke('launcher_resize', { height: Math.round(height) }); },
    hide: () => { invoke('launcher_hide'); },
    onReset: (cb) => on('launcher-reset', () => cb()),
  };
})();
