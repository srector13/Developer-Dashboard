// Bridge between the renderer and the Rust backend.
//
// This file replaces the five Electron preload scripts. It exposes exactly the
// same globals the renderer already expects — window.api, captureApi,
// launcherApi, scratchApi, regionApi — so renderer/app.js and the helper
// windows are unchanged by the port. Every method maps to a #[tauri::command]
// of the same name in snake_case; see src-tauri/src/commands.rs.
//
// Loaded before app.js, and synchronous: app.js reads window.api.platform at
// the top level.
(function () {
  'use strict';

  const T = window.__TAURI__;
  if (!T) {
    // A plain browser (renderer smoke tests) — leave the globals alone so the
    // tests can install their own stubs.
    return;
  }

  const invoke = T.core.invoke;
  const listen = T.event.listen;

  // Electron's ipcRenderer.on/removeListener is synchronous; Tauri's listen()
  // resolves the unsubscribe function asynchronously. Callers only ever call
  // the returned function, so hand back a thunk that awaits it.
  function on(event, handler) {
    const pending = listen(event, handler);
    return () => { pending.then((unlisten) => unlisten()); };
  }

  // Attachment bytes travel as base64: Tauri's JSON IPC would otherwise
  // serialise a Uint8Array element-by-element, which is unusably slow for a
  // pasted screenshot.
  function toBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const CHUNK = 0x8000; // avoid blowing the argument limit on apply()
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function dirname(p) {
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return idx <= 0 ? p : p.slice(0, idx);
  }

  // ==========================================================================
  // Main window
  // ==========================================================================

  window.api = {
    // The Rust shell is Windows-only, so the renderer's Mac/Windows keybinding
    // switch always resolves to the Windows side.
    platform: 'win32',

    // Config / App control
    selectFolder: () => invoke('select_folder'),
    getSettings: () => invoke('get_settings'),
    saveSettings: (settings) => invoke('save_settings', { settings }),

    // Note / Notebook structure
    getNotebookTree: (rootPath, filterTag) => invoke('get_notebook_tree', { rootPath, filterTag: filterTag || null }),
    readNote: (filePath) => invoke('read_note', { filePath }),
    writeNote: (filePath, content) => invoke('write_note', { filePath, content }),
    createPage: (dirPath, title, templateName, meta, customVars) =>
      invoke('create_page', {
        dirPath,
        title,
        templateName: templateName || null,
        meta: meta || null,
        customVars: customVars || null,
      }),
    getTemplateVariables: (templateName) => invoke('get_template_variables', { templateName }),
    createSection: (dirPath, name, description) => invoke('create_section', { dirPath, name, description: description || null }),
    setSectionMeta: (dirPath, description) => invoke('set_section_meta', { dirPath, description }),
    deleteNode: (filePath) => invoke('delete_node', { filePath }),
    renameNode: (filePath, newName) => invoke('rename_node', { filePath, newName }),
    updateNoteMeta: (filePath, meta) => invoke('update_note_meta', { filePath, meta }),
    relocateNode: (srcPath, destDir) => invoke('relocate_node', { srcPath, destDir }),
    moveNode: (dirPath, fileName, direction) => invoke('move_node', { dirPath, fileName, direction }),
    setNodeOrder: (dirPath, orderedNames) => invoke('set_node_order', { dirPath, orderedNames }),

    // Quick Scratchpad
    readScratchpad: () => invoke('read_scratchpad'),
    appendScratchpad: (text) => invoke('append_scratchpad', { text }),

    // Templates
    listTemplates: () => invoke('list_templates'),
    createTemplate: (name) => invoke('create_template', { name }),

    // Imports / Exports
    importClipboard: (destDir, meta) => invoke('import_clipboard', { destDir, meta: meta || null }),
    importDocument: (destDir) => invoke('import_document', { destDir }),
    exportToPdf: (filePath, htmlContent, options) => invoke('export_to_pdf', { filePath, htmlContent, options: options || null }),
    exportToHtml: (filePath, htmlContent, options) => invoke('export_to_html', { filePath, htmlContent, options: options || null }),
    exportToDocx: (filePath) => invoke('export_to_docx', { filePath }),
    copyRichText: (htmlContent, plainText) => invoke('copy_rich_text', { htmlContent, plainText: plainText || '' }),

    // Backlinks (computed in the backend in one pass)
    getBacklinks: (filePath) => invoke('get_backlinks', { filePath }),

    // Full-text search over note contents
    searchNotes: (query, opts) => invoke('search_notes', { query, maxResults: (opts && opts.maxResults) || null }),

    // Attachments
    saveAttachment: (payload) => invoke('save_attachment', {
      baseName: payload.baseName,
      bytesB64: toBase64(payload.bytes),
      notePath: payload.notePath,
    }),
    importAttachmentFile: (payload) => invoke('import_attachment_file', {
      sourcePath: payload.sourcePath,
      notePath: payload.notePath,
    }),
    // WebView2 exposes no filesystem path for a dropped File (Electron used
    // the non-standard webUtils.getPathForFile). Returning '' makes app.js
    // take its existing byte-copy path, which produces the same attachment.
    getPathForFile: () => '',

    // Trash
    listTrash: () => invoke('list_trash'),
    restoreTrashItem: (trashName) => invoke('restore_trash_item', { trashName }),
    deleteTrashItem: (trashName) => invoke('delete_trash_item', { trashName }),
    emptyTrash: () => invoke('empty_trash'),

    // Note history
    listNoteHistory: (filePath) => invoke('list_note_history', { filePath }),
    readNoteHistory: (filePath, id) => invoke('read_note_history', { filePath, id }),
    restoreNoteHistory: (filePath, id) => invoke('restore_note_history', { filePath, id }),

    // Utility events
    onFilesChanged: (callback) => on('files-changed', () => callback()),
    onCaptureShortcutFailed: (callback) => on('capture-shortcut-failed', (e) => callback(e.payload)),
    onOpenNote: (callback) => on('open-note', (e) => callback(e.payload)),
    onOpenNoteExport: (callback) => on('open-note-export', (e) => callback(e.payload)),

    checkForUpdates: () => invoke('check_for_updates'),
    getAppVersion: () => invoke('app_version'),

    // Local AI (Ollama / LM Studio) — optional, disabled by default
    aiListModels: () => invoke('ai_list_models'),
    aiTransform: (mode, text) => invoke('ai_transform', { mode, text }),
    aiComplete: (context) => invoke('ai_complete', { context }),

    // Inline actions in renderer
    toggleTaskAtLine: (filePath, line) => invoke('toggle_task_at_line', { filePath, lineIndex: line }),
    toggleMermaidOrientation: (line) => { invoke('toggle_mermaid_orientation', { lineIndex: line }); },
    openExternal: (url) => invoke('open_external', { url }),
    resolveRelativePath: (basePath, relPath) => window.NotebookMarkdown.resolvePath(dirname(basePath), relPath),

    // Local Markdown rendering (renderer/markdown.js)
    renderMarkdown: (text, opts) => window.NotebookMarkdown.render(text, opts),
  };

  listen('perform-mermaid-toggle', (e) => {
    window.dispatchEvent(new CustomEvent('perform-mermaid-toggle', { detail: e.payload }));
  });

  // ==========================================================================
  // Helper windows. Each keeps the same deliberately tiny surface its Electron
  // preload had; the extra globals are harmless in windows that ignore them.
  // ==========================================================================

  window.captureApi = {
    appendQuickCapture: (text, targetFsPath) => invoke('append_quick_capture', { text, targetFsPath: targetFsPath || null }),
    listCaptureTargets: () => invoke('list_capture_targets'),
    hideCaptureWindow: () => { invoke('hide_capture_window'); },
  };

  window.launcherApi = {
    context: () => invoke('launcher_context'),
    search: (query) => invoke('launcher_search', { query }),
    openNote: (fsPath) => { invoke('launcher_open_note', { fsPath }); },
    exportNote: (fsPath) => { invoke('launcher_export_note', { fsPath }); },
    openDaily: () => invoke('launcher_open_daily'),
    openCapture: () => invoke('launcher_open_capture'),
    captureTask: (text) => invoke('launcher_append_task', { text }),
    screenshot: () => invoke('launcher_screenshot'),
    openScratchpad: () => invoke('launcher_open_scratchpad'),
    resize: (height) => { invoke('launcher_resize', { height: Math.round(height) }); },
    hide: () => { invoke('launcher_hide'); },
    onReset: (cb) => on('launcher-reset', () => cb()),
  };

  window.scratchApi = {
    read: () => invoke('read_scratchpad'),
    write: (text) => invoke('write_scratchpad', { text }),
    context: () => invoke('launcher_context'),
    setPin: (pinned) => { invoke('scratchpad_pin', { pinned: !!pinned }); },
    hide: () => { invoke('scratchpad_hide'); },
  };

  window.regionApi = {
    getShot: () => invoke('region_get_shot'),
    commit: (rect) => invoke('region_commit', { rect }),
    cancel: () => { invoke('region_cancel'); },
  };
})();
