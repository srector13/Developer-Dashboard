// Bridge between the renderer and the Rust backend.
//
// One global, `window.logsApi`, following the same camelCase→snake_case
// convention Dev Hub and Markdown Notebook use; see src-tauri/src/commands.rs
// for the other side.
//
// Loaded before app.js and synchronous, so page code can call it at top level.
(function () {
  'use strict';

  const T = window.__TAURI__;
  if (!T) {
    // A plain browser (the renderer specs) — leave the global alone so the
    // tests can install their own stub.
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

  window.logsApi = {
    context: () => invoke('context'),

    getSettings: () => invoke('get_settings'),
    saveSettings: (settings) => invoke('save_settings', { settings }),

    getConfig: () => invoke('get_config'),
    saveConfig: (config) => invoke('save_config', { config }),
    revealConfigFile: () => invoke('reveal_config_file'),

    listSources: () => invoke('list_sources'),
    addSource: (path) => invoke('add_source', { path }),
    removeSource: (id) => invoke('remove_source', { id }),
    setSourceEnabled: (id, enabled) => invoke('set_source_enabled', { id, enabled }),
    pinSource: (id) => invoke('pin_source', { id }),
    reloadSource: (id) => invoke('reload_source', { id }),
    // An id, never a path — the window can only reveal what it already watches.
    revealSource: (id) => invoke('reveal_source', { id }),
    pickFiles: () => invoke('pick_files'),
    // Browse for a path without opening it — the settings pane editing a source.
    browseFile: () => invoke('browse_file'),

    setFilter: (filter) => invoke('set_filter', { filter }),
    // Resolves when the pattern compiles, rejects with the one-line reason when
    // it does not. The highlight editor calls this as you type.
    checkPattern: (pattern, regex, caseSensitive) =>
      invoke('check_pattern', { pattern, regex, caseSensitive }),
    refresh: () => invoke('refresh'),
    clear: () => invoke('clear'),
    copyView: () => invoke('copy_view'),

    openSibling: (id) => invoke('open_sibling', { id }),

    onLinesAppended: (cb) => on('lines-appended', (e) => cb(e.payload)),
    onSourcesChanged: (cb) => on('sources-changed', () => cb()),
    // logs.config.json changed on disk — someone edited it, or another window
    // saved it. See src-tauri/src/desktop.rs.
    onConfigChanged: (cb) => on('config-changed', () => cb()),

    // Dropping a file has to come from Tauri rather than the HTML5 drop event:
    // a webview hands JS a File object with no path on it, and a path is the
    // only thing the backend can tail.
    onFileDrop: (cb) => on('tauri://drag-drop', (e) => cb((e.payload && e.payload.paths) || [])),
    onFileDropHover: (cb) => on('tauri://drag-enter', () => cb(true)),
    onFileDropCancel: (cb) => on('tauri://drag-leave', () => cb(false)),

    writeClipboard: (text) => T.clipboardManager.writeText(text),
  };
})();
