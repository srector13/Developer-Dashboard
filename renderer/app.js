// Markdown Notebook Renderer App

// Platform detection (exposed by preload; navigator fallback for dev/harness).
// Drives which modifier keys the UI shows: ⌘ on macOS, Ctrl elsewhere.
const IS_MAC = (window.api && window.api.platform)
  ? window.api.platform === 'darwin'
  : navigator.platform.toUpperCase().indexOf('MAC') >= 0;

// Render a canonical shortcut ("Mod+Alt+L", "Tab", "Esc") for this platform.
// The lookahead split keeps literal '+' or '-' keys ("Mod+Alt+-") intact.
function shortcutLabel(shortcut) {
  return shortcut.split(/\+(?=.)/).map(part => {
    if (part === 'Mod') return IS_MAC ? '⌘' : 'Ctrl';
    if (part === 'Alt') return IS_MAC ? '⌥' : 'Alt';
    if (part === 'Shift') return IS_MAC ? '⇧' : 'Shift';
    return part;
  }).join(IS_MAC ? '' : '+');
}

// Rewrite shortcut hints written as "(Cmd+X / Ctrl+X)" or "(Cmd+Alt+X)"
// into the platform's own form.
function normalizeShortcutText(text) {
  if (!text || !text.includes('Cmd+')) return text;
  // "(Cmd+1 / Ctrl+1)" → single-platform form
  text = text.replace(/Cmd\+(\S+?)\s*\/\s*Ctrl\+\1/g, (m, key) => `Mod+${key}`);
  // Remaining "Cmd+..." (mac-only spellings) → canonical Mod form
  text = text.replace(/Cmd\+/g, 'Mod+');
  // Render canonical "Mod+Alt+X" style chunks for this platform
  return text.replace(/(Mod(?:\+[A-Za-z0-9\-\/\]\[]+)+)/g, (m) => shortcutLabel(m));
}

function normalizeShortcutTitles() {
  document.querySelectorAll('[title]').forEach(el => {
    const title = el.getAttribute('title');
    const normalized = normalizeShortcutText(title);
    if (normalized !== title) {
      el.setAttribute('title', normalized);
    }
  });
}

let notebookRoot = '';
let activeNote = '';
let noteContent = '';
let noteOriginalContent = '';
let appSettings = null;
let viewMode = 'preview'; // 'preview' | 'edit' | 'split'
let expandedSections = new Set(); // Stores relative paths of expanded folders
let activeTagFilter = '';
let searchQuery = '';
let treeData = null; // Store current tree root for search and tag scan
let tagSet = new Set(); // Store all tags in notebook
let activeNoteList = []; // Flattened list of notes in current view for reordering/navigation
let activeSection = null; // { relPath: string, fsPath: string }
let autoSaveEnabled = false;
let autoSaveTimeout = null;
let previewZoomLevel = 100;
let popoutZoomLevel = 100;
 
// Fade out and remove the startup loading overlay
function hideAppLoading() {
  const el = document.getElementById('app-loading');
  if (!el) return;
  el.classList.add('hiding');
  setTimeout(() => el.classList.add('gone'), 300);
}

// Initialize App
document.addEventListener('DOMContentLoaded', async () => {
  // Load settings
  appSettings = await window.api.getSettings();
  autoSaveEnabled = appSettings.autoSaveEnabled || false;
  document.getElementById('header-autosave').checked = autoSaveEnabled;

  // Set theme from settings (also initializes Mermaid with the right theme)
  applyTheme(appSettings.theme);
  applyEditorSpellcheck();

  // Platform-correct shortcut hints must be applied before anything renders
  // the tree (which binds tooltips and consumes the title attributes)
  normalizeShortcutTitles();
  const paletteHint = document.getElementById('palette-shortcut-hint');
  if (paletteHint) paletteHint.innerText = shortcutLabel('Mod+K');

  if (appSettings.notebookRoot) {
    notebookRoot = appSettings.notebookRoot;
    document.getElementById('onboarding').classList.remove('active');
    document.getElementById('settings-root-path').value = notebookRoot;
    try {
      await refreshNotebook();

      // Restore the previous session's open tabs and active note
      const restoredActive = restoreTabs();
      if (restoredActive && !activeNote) {
        await openNote(restoredActive);
      }
    } catch (err) {
      console.error('Initial notebook load failed:', err);
    }
  } else {
    document.getElementById('onboarding').classList.add('active');
  }

  // The initial notebook render is done — fade out the loading overlay. The
  // window itself was already shown (with this overlay) as soon as the shell
  // painted, so there's a taskbar entry and a branded screen throughout.
  hideAppLoading();

  // File watcher setup (auto refresh)
  window.api.onFilesChanged(async () => {
    await refreshNotebook(false); // refresh tree without resetting active note
  });

  // Quick-capture shortcut couldn't be registered (invalid or taken by
  // another app) — tell the user so the feature doesn't silently not work
  if (window.api.onCaptureShortcutFailed) {
    window.api.onCaptureShortcutFailed((shortcut) => {
      showToast(`Could not register quick capture shortcut "${shortcut}". Change it in Settings.`, 'error');
    });
  }

  // Split view: preview scrolls drive the editor (the editor side is wired
  // through the textarea's inline onscroll)
  document.getElementById('preview-pane').addEventListener('scroll', () => syncSplitScroll('preview'));

  // [[ note-link popup + AI ghost: dismiss on blur, re-evaluate on click
  const noteEditorEl = document.getElementById('note-editor');
  if (noteEditorEl) {
    noteEditorEl.addEventListener('blur', () => setTimeout(() => { hideWikiAutocomplete(); hideAiGhost(); }, 120));
    noteEditorEl.addEventListener('click', () => { updateWikiAutocomplete(); hideAiGhost(); });
  }

  // Tab context menu dismissal: any click or right-click elsewhere closes it
  // (opening it stops propagation, so these never fire for the menu itself)
  document.addEventListener('click', hideTabContextMenu);
  document.addEventListener('contextmenu', hideTabContextMenu);
  window.addEventListener('resize', hideTabContextMenu);

  // Restore the drawer's last-used view (outline vs search)
  setDrawerTab(drawerTab);

  // Set default page width label
  const labelMap = { 'standard': 'Standard', 'wide': 'Wide', 'full': 'Full' };
  document.getElementById('label-stretch-width').innerText = labelMap[appSettings.defaultPageWidth] || 'Standard';

  // Initialize table selector grid
  initTableGrid();

  // Initialize dynamic custom tooltips
  initCustomTooltips();

  // Initialize split pane drag resizer
  initPaneResizer();

  // Initialize sidebar / outline drawer resizing & collapse state
  initPanelLayout();

  // Initialize drag-to-pan inside the mermaid popout viewer
  initPopoutPan();

  // Paste-image and drag-drop attachment handling in the editor
  initAttachmentHandlers();

  // Setup outside click listener for editor dropdowns
  window.addEventListener('click', (event) => {
    const menus = document.querySelectorAll('.dropdown-menu');
    menus.forEach(menu => {
      const container = menu.closest('.editor-dropdown');
      if (container && !container.contains(event.target)) {
        menu.classList.remove('active');
        const toggle = container.querySelector('.dropdown-toggle');
        if (toggle) {
          const chev = toggle.querySelector('.chevron');
          if (chev) chev.style.transform = 'rotate(0deg)';
        }
      }
    });
  });
});

// Setup keyboard shortcuts inside document
document.addEventListener('keydown', (e) => {
  const isCmdOrCtrl = IS_MAC ? e.metaKey : e.ctrlKey;

  if (isCmdOrCtrl && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveActiveNote();
  } else if (isCmdOrCtrl && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    toggleCommandPalette();
  } else if (isCmdOrCtrl && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    if (notebookRoot) promptCreatePage(notebookRoot);
  } else if (isCmdOrCtrl && ['1', '2', '3'].includes(e.key)) {
    // View mode switching for power users: 1 Preview, 2 Edit, 3 Split
    if (activeNote) {
      e.preventDefault();
      setViewMode({ '1': 'preview', '2': 'edit', '3': 'split' }[e.key]);
    }
  } else if (isCmdOrCtrl && e.key === '/') {
    e.preventDefault();
    showShortcutsModal();
  } else if (isCmdOrCtrl && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
    // Find & replace in the open note; falls back to global search otherwise
    e.preventDefault();
    if (activeNote) showFindBar();
    else openDrawerView('search');
  } else if (e.key === 'Escape') {
    closeTopOverlay();
  }
});

// Close the currently open overlay (modal / popout / popover / palette) on Escape
function closeTopOverlay() {
  const palette = document.getElementById('command-palette-modal');
  if (palette && palette.style.display !== 'none') {
    hideCommandPalette();
    return;
  }
  const popout = document.getElementById('mermaid-popout-overlay');
  if (popout && popout.classList.contains('active')) {
    closeMermaidPopout();
    return;
  }
  const tagsPopover = document.getElementById('tags-popover');
  if (tagsPopover && tagsPopover.classList.contains('active')) {
    hideTagsPopover();
    return;
  }
  const activeModals = document.querySelectorAll('.modal-overlay.active');
  if (activeModals.length > 0) {
    activeModals[activeModals.length - 1].classList.remove('active');
    return;
  }
  if (findBarVisible()) hideFindBar();
}

// ==========================================
// THEME SYSTEM
// Each named theme builds on a light or dark base class; the theme-specific
// palette lives in a body[data-theme=...] CSS variable block in style.css.
// ==========================================
const THEMES = {
  light:    { base: 'light', mermaid: 'default', label: 'Light' },
  dark:     { base: 'dark',  mermaid: 'dark',    label: 'Dark' },
  midnight: { base: 'dark',  mermaid: 'dark',    label: 'Midnight' },
  forest:   { base: 'dark',  mermaid: 'dark',    label: 'Forest' },
  sepia:    { base: 'light', mermaid: 'neutral', label: 'Sepia' },
};

function resolveThemeName(name) {
  if (name === 'system' || !THEMES[name]) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return name;
}

// Apply theme helper. `theme` is a setting value: 'system' or a THEMES key.
function applyTheme(theme) {
  const resolved = resolveThemeName(theme);
  const entry = THEMES[resolved];
  const body = document.body;

  // classList, not className assignment: the body also carries state classes
  // like sidebar-collapsed that must survive theme switches.
  body.classList.remove('dark-theme', 'light-theme');
  body.classList.add(`${entry.base}-theme`);
  body.dataset.theme = resolved;

  // Swap the highlight.js stylesheet to match the base
  const hljsDark = document.getElementById('hljs-dark');
  const hljsLight = document.getElementById('hljs-light');
  if (hljsDark) hljsDark.disabled = entry.base !== 'dark';
  if (hljsLight) hljsLight.disabled = entry.base !== 'light';

  if (window.mermaid) {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: entry.mermaid,
      securityLevel: 'loose'
    });
    // Force re-render of note preview so Mermaid charts update colors
    if (activeNote && viewMode !== 'edit') {
      renderMarkdownPreview();
    }
  }
}

// Mermaid theme to use for each exportable document theme
const PDF_MERMAID_THEME = { light: 'default', minimal: 'default', dark: 'dark' };

function mermaidInit(theme) {
  window.mermaid.initialize({ startOnLoad: false, theme, securityLevel: 'loose' });
}

// Mermaid is 3+MB of JS. Loading it with a <script> tag blocked the app's
// first paint on EVERY launch, diagrams or not — the single biggest chunk of
// perceived startup time. It's now injected on first use only.
let mermaidLoadPromise = null;
function ensureMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!mermaidLoadPromise) {
    mermaidLoadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/mermaid.min.js';
      s.onload = () => {
        // Arrive already initialized to the current app theme
        try { mermaidInit(THEMES[resolveThemeName(appSettings.theme)].mermaid); } catch { /* theme applies on next switch */ }
        resolve(window.mermaid);
      };
      s.onerror = () => {
        mermaidLoadPromise = null; // allow a retry on the next diagram
        reject(new Error('Could not load the diagram renderer.'));
      };
      document.head.appendChild(s);
    });
  }
  return mermaidLoadPromise;
}

// Run `fn` with mermaid initialized to an export theme, restoring the app
// theme afterwards. mermaid.initialize is GLOBAL, so this must never
// interleave with an in-app preview render — chaining onto the serialized
// previewRenderQueue is what guarantees that.
function withMermaidTheme(exportTheme, fn) {
  previewRenderQueue = previewRenderQueue.then(async () => {
    try { await ensureMermaid(); } catch { return fn(); }
    mermaidInit(exportTheme);
    try {
      return await fn();
    } finally {
      mermaidInit(THEMES[resolveThemeName(appSettings.theme)].mermaid);
    }
  }).catch(err => {
    console.error('Themed mermaid render failed:', err);
  });
  return previewRenderQueue;
}

// Quick toggle flips between the light/dark base themes; the full palette
// list lives in Settings.
async function toggleGlobalTheme() {
  const isDark = document.body.classList.contains('dark-theme');
  const newTheme = isDark ? 'light' : 'dark';
  applyTheme(newTheme);

  if (appSettings) {
    appSettings.theme = newTheme;
    appSettings = await window.api.saveSettings(appSettings);
    const select = document.getElementById('settings-theme');
    if (select) select.value = newTheme;
  }
}

// Refresh Notebook data
async function refreshNotebook(resetActiveNote = false) {
  if (!notebookRoot) return;
  
  // Load tree
  treeData = await window.api.getNotebookTree(notebookRoot, activeTagFilter);
  
  // Build global tag list and search tags (rebuilt from scratch so removed tags disappear)
  tagSet.clear();
  scanGlobalTags(treeData);
  
  // Render sidebar tree
  renderSidebarTree();

  // Drop tabs whose files were deleted/renamed out from under them
  pruneTabs();

  // Refresh tags display
  renderTagsCloud();

  // Handle active note or landing page loading
  if (activeNote) {
    // Check if active note still exists in new tree.
    // Template files live outside the tree (their folder is ignored), so
    // they stay open even though findNodeByPath can't see them.
    const node = findNodeByPath(treeData, activeNote);
    if (node || isTemplatePath(activeNote)) {
      if (!resetActiveNote) {
        // Just refresh preview rendering in case file content changed
        const refreshedText = await window.api.readNote(activeNote);
        if (viewMode === 'preview' && refreshedText !== noteOriginalContent) {
          noteContent = refreshedText;
          noteOriginalContent = refreshedText;
          renderActiveNote();
        }
      }
    } else {
      // Note was deleted or filtered out
      closeNoteCanvas();
    }
  } else if (activeSection) {
    // Refresh landing page data
    if (activeSection.relPath === '') {
      renderRootLanding();
    } else {
      renderSectionLanding();
    }
  } else {
    closeNoteCanvas();
  }
}

// Open notebook directory selection
async function openNotebookFolder() {
  try {
    const pathChosen = await window.api.selectFolder();
    if (pathChosen) {
      notebookRoot = pathChosen;
      document.getElementById('onboarding').classList.remove('active');
      document.getElementById('settings-root-path').value = notebookRoot;
      
      // Hide settings modal if open
      hideSettingsModal();
      
      // Reset active notes
      activeNote = '';
      
      await refreshNotebook();
    }
  } catch (err) {
    alert("Error selecting notebook folder: " + err.message);
    console.error("selectFolder failed:", err);
  }
}

// Sidebar folder/sections expansion state toggle
function toggleFolderCollapse(relativePath, element) {
  if (expandedSections.has(relativePath)) {
    expandedSections.delete(relativePath);
  } else {
    expandedSections.add(relativePath);
  }
  renderSidebarTree();
}

// Recursive tag scanner. Also counts how many pages carry each tag for the
// search panel's Tags group.
let tagCounts = new Map(); // tag -> page count
function scanGlobalTags(node, counts = null) {
  const top = counts === null;
  if (top) counts = new Map();
  if (node && node.kind === 'section') {
    node.pages.forEach(p => p.tags.forEach(t => {
      tagSet.add(t);
      counts.set(t, (counts.get(t) || 0) + 1);
    }));
    node.sections.forEach(s => scanGlobalTags(s, counts));
  }
  if (top) tagCounts = counts;
}

// Sidebar notebook tree HTML generator
function renderSidebarTree() {
  const treeContainer = document.getElementById('notebook-tree');
  treeContainer.ondragover = handleDragOver;
  treeContainer.ondragleave = handleDragLeave;
  treeContainer.ondrop = (e) => handleDrop(e, notebookRoot);

  if (!treeData) {
    treeContainer.innerHTML = '<div class="empty-tree">No notebook open</div>';
    return;
  }

  activeNoteList = []; // Flatten notes in tree order
  const html = generateTreeHTML(treeData, 0);
  treeContainer.innerHTML = html || '<div class="empty-tree">No matching pages</div>';
  
  // Re-bind custom tooltips to dynamic tree nodes
  initCustomTooltips();
}

function generateTreeHTML(node, depth) {
  let html = '';
  if (node.kind === 'section') {
    const isRoot = node.relPath === '';
    
    if (!isRoot) {
      const isExpanded = expandedSections.has(node.relPath);
      const isActiveFolder = activeSection && activeSection.relPath === node.relPath && !activeNote;
      html += `
        <div class="tree-section">
          <div class="tree-node ${isActiveFolder ? 'active' : ''}" style="padding-left: ${depth * 12 + 12}px;"
               draggable="true"
               ondragstart="handleDragStart(event, ${jsArg(node.fsPath)})"
               ondragover="handleDragOver(event)"
               ondragleave="handleDragLeave(event)"
               ondrop="handleDrop(event, ${jsArg(node.fsPath)})">
            <span class="tree-node-chevron ${isExpanded ? '' : 'collapsed'}" onclick="event.stopPropagation(); toggleFolderCollapse(${jsArg(node.relPath)})">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </span>
            <div class="tree-node-content" onclick="openSection(${jsArg(node.relPath)}, ${jsArg(node.fsPath)})">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-teal);"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              <span class="tree-node-label" style="font-weight: 500;">${escapeHtml(node.name)}</span>
            </div>
            <div class="tree-node-actions">
              <button class="tree-node-btn" onclick="event.stopPropagation(); promptCreatePage(${jsArg(node.fsPath)})" title="New Page">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
              <button class="tree-node-btn" onclick="event.stopPropagation(); promptCreateSection(${jsArg(node.fsPath)})" title="New Subsection">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
              </button>
              <button class="tree-node-btn" onclick="event.stopPropagation(); promptRenameNode(${jsArg(node.fsPath)}, ${jsArg(node.name)})" title="Rename">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <button class="tree-node-btn" onclick="event.stopPropagation(); deleteNode(${jsArg(node.fsPath)})" title="Delete">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>
          </div>
          <div class="tree-section-children ${isExpanded ? '' : 'collapsed'}">
      `;
    }

    // Render pages of this section
    const childPages = node.pages.filter(p => {
      if (searchQuery) {
        return p.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
               p.name.toLowerCase().includes(searchQuery.toLowerCase());
      }
      return true;
    });

    childPages.forEach(page => {
      activeNoteList.push(page);
      const isActive = activeNote === page.fsPath;
      const isPinned = page.pinned;
      const isDaily = page.dailyKey;
      
      let badgeHtml = '';
      if (page.openTasks > 0 || page.completedTasks > 0) {
        const total = page.openTasks + page.completedTasks;
        const allDone = page.openTasks === 0;
        badgeHtml = `<span class="task-badge">${allDone ? '<span class="task-progress-dot"></span>' : ''} ${page.completedTasks}/${total}</span>`;
      }

      let iconHtml = '';
      if (isPinned) {
        iconHtml = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-blue); transform: rotate(45deg);"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>`;
      } else if (isDaily) {
        iconHtml = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-green);"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
      } else {
        iconHtml = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--text-secondary);"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
      }

      html += `
        <div class="tree-node ${isActive ? 'active' : ''}" style="padding-left: ${(isRoot ? 0 : depth + 1) * 12 + 12}px;"
             onclick="openNote(${jsArg(page.fsPath)})"
             draggable="true"
             ondragstart="handleDragStart(event, ${jsArg(page.fsPath)})"
             ondragover="handlePageDragOver(event)"
             ondragleave="handlePageDragLeave(event)"
             ondrop="handlePageDrop(event, ${jsArg(node.fsPath)}, ${jsArg(page.name)})">
          <div class="tree-node-content">
            ${iconHtml}
            <span class="tree-node-label">${escapeHtml(page.title)}</span>
            ${badgeHtml}
          </div>
          <div class="tree-node-actions">
            <button class="tree-node-btn" onclick="event.stopPropagation(); moveNode(${jsArg(node.fsPath)}, ${jsArg(page.name)}, 'up')" title="Move Up">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
            </button>
            <button class="tree-node-btn" onclick="event.stopPropagation(); moveNode(${jsArg(node.fsPath)}, ${jsArg(page.name)}, 'down')" title="Move Down">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <button class="tree-node-btn" onclick="event.stopPropagation(); showPageInfoModal(${jsArg(page.fsPath)})" title="Edit Page Info (title, date, tags)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="tree-node-btn" onclick="event.stopPropagation(); deleteNode(${jsArg(page.fsPath)})" title="Delete">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </div>
      `;
    });

    // Render sections recursively
    node.sections.forEach(sec => {
      html += generateTreeHTML(sec, isRoot ? 0 : depth + 1);
    });

    if (!isRoot) {
      html += `
          </div>
        </div>
      `;
    }
  }
  return html;
}

// Find Page Node in Tree structure
function findNodeByPath(node, filePath) {
  if (!node) return null;
  if (node.kind === 'page' && node.fsPath === filePath) {
    return node;
  }
  if (node.kind === 'section') {
    for (const p of node.pages) {
      if (p.fsPath === filePath) return p;
    }
    for (const s of node.sections) {
      const match = findNodeByPath(s, filePath);
      if (match) return match;
    }
  }
  return null;
}

// Search handler (debounced: the tree rebuild + tooltip rebinding is too
// heavy to run on every keystroke in large notebooks). The results panel
// shows three collapsible groups — Titles, Content, Tags — and a leading
// '#' switches the whole panel into tag-autocomplete mode.
let searchDebounceTimer = null;
let contentSearchToken = 0;

// Collapse state per group, persisted app-wide
let searchGroupCollapsed = { titles: false, content: false, tags: false };
try {
  const saved = JSON.parse(localStorage.getItem('mdnb-search-groups') || 'null');
  if (saved && typeof saved === 'object') {
    searchGroupCollapsed = { ...searchGroupCollapsed, ...saved };
  }
} catch {}

function handleSearch(val) {
  // In '#' tag mode the tree must not be title-filtered ('#foo' matches no
  // titles and would blank the tree); the panel does the work instead.
  const tagMode = val.startsWith('#');
  searchQuery = tagMode ? '' : val;
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    renderSidebarTree();
    // Results live in the right drawer: typing a query brings them up
    if (val.trim().length > 0) {
      setDrawerTab('search');
      openRightDrawer();
    }
    renderSearchGroups(val);
  }, 120);
}

function toggleSearchGroup(name) {
  searchGroupCollapsed[name] = !searchGroupCollapsed[name];
  try {
    localStorage.setItem('mdnb-search-groups', JSON.stringify(searchGroupCollapsed));
  } catch {}
  // Flip classes in place: a full re-render would drop the async Content fill
  const group = document.querySelector(`#content-search-results .search-group[data-group="${name}"]`);
  if (group) {
    const chevron = group.querySelector('.search-group-chevron');
    const body = group.querySelector('.search-group-body');
    if (chevron) chevron.classList.toggle('collapsed', searchGroupCollapsed[name]);
    if (body) body.classList.toggle('collapsed', searchGroupCollapsed[name]);
  }
}

function searchGroupHtml(name, label, count, bodyHtml) {
  const collapsed = !!searchGroupCollapsed[name];
  return `
    <div class="search-group" data-group="${name}">
      <div class="search-group-header" onclick="toggleSearchGroup('${name}')">
        <span class="search-group-chevron ${collapsed ? 'collapsed' : ''}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </span>
        <span class="search-group-label">${escapeHtml(label)}</span>
        <span class="search-group-count">${count}</span>
      </div>
      <div class="search-group-body ${collapsed ? 'collapsed' : ''}">${bodyHtml}</div>
    </div>
  `;
}

function tagRowsHtml(tags) {
  if (tags.length === 0) {
    return '<div class="content-search-empty">No matching tags</div>';
  }
  return tags.map(tag => `
    <div class="search-tag-row ${activeTagFilter === tag ? 'active' : ''}" onclick="selectSearchTag(${jsArg(tag)})">
      <span class="tag-pill">#${escapeHtml(tag)}</span>
      <span class="search-group-count">${tagCounts.get(tag) || 0}</span>
    </div>
  `).join('');
}

// Picking a tag shows the pages carrying it, right here in the search pane
// (it no longer filters the sidebar tree). Setting the box to '#tag' routes
// back through handleSearch, which renders the tagged-pages view.
function selectSearchTag(tag) {
  const input = document.getElementById('search-input');
  if (input) input.value = `#${tag}`;
  handleSearch(`#${tag}`);
}

// Pages carrying an exact tag, as clickable result rows
function taggedPagesHtml(tag) {
  const pages = (treeData ? gatherPagesRecursively(treeData) : [])
    .filter(p => (p.tags || []).some(t => t.toLowerCase() === tag.toLowerCase()))
    .sort((a, b) => a.title.localeCompare(b.title));
  if (!pages.length) return '<div class="content-search-empty">No pages with this tag</div>';
  return pages.map(p => `
    <div class="content-search-item" onclick="openNote(${jsArg(p.fsPath)})">
      <div class="content-search-title"><span>${escapeHtml(p.title)}</span></div>
      <div class="content-search-snippet">${escapeHtml(pathDirname(p.relPath) || 'Notebook root')}</div>
    </div>
  `).join('');
}

// Render the three-group results panel (or the tag-autocomplete panel)
function renderSearchGroups(rawQuery) {
  const container = document.getElementById('content-search-results');
  if (!container) return;

  const raw = rawQuery || '';
  const tagMode = raw.startsWith('#');
  const q = (tagMode ? raw.slice(1) : raw).trim().toLowerCase();

  // Any new render invalidates in-flight content responses
  const token = ++contentSearchToken;

  const emptyHint = document.getElementById('drawer-search-empty');
  if (!tagMode && raw.trim().length === 0) {
    container.style.display = 'none';
    container.innerHTML = '';
    if (emptyHint) emptyHint.style.display = 'block';
    return;
  }
  container.style.display = 'block';
  if (emptyHint) emptyHint.style.display = 'none';

  const allTags = Array.from(tagSet).sort((a, b) => a.localeCompare(b));

  if (tagMode) {
    // Exact tag match -> show its pages in the pane; otherwise the query is
    // still being typed (or clicked from), so list matching tags to pick.
    const exact = q ? allTags.find(t => t.toLowerCase() === q) : null;
    if (exact) {
      const count = (treeData ? gatherPagesRecursively(treeData) : [])
        .filter(p => (p.tags || []).some(t => t.toLowerCase() === exact.toLowerCase())).length;
      container.innerHTML = searchGroupHtml('tags', `Pages tagged #${exact}`, count, taggedPagesHtml(exact));
    } else {
      // '#' alone lists every registered tag; typing filters the list live
      const matches = q ? allTags.filter(t => t.toLowerCase().includes(q)) : allTags;
      container.innerHTML = searchGroupHtml('tags', 'Tags — pick one', matches.length, tagRowsHtml(matches));
    }
    return;
  }

  // --- Titles group (sync) ---
  const pages = treeData ? gatherPagesRecursively(treeData) : [];
  const titleMatches = pages.filter(p =>
    p.title.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  const shownTitles = titleMatches.slice(0, 20);
  const titlesBody = shownTitles.length === 0
    ? '<div class="content-search-empty">No matches</div>'
    : shownTitles.map(p => `
        <div class="content-search-item" onclick="openNote(${jsArg(p.fsPath)})">
          <div class="content-search-title">
            <span>${escapeHtml(p.title)}</span>
          </div>
          <div class="content-search-snippet">${escapeHtml(pathDirname(p.relPath) || 'Notebook root')}</div>
        </div>
      `).join('') + (titleMatches.length > 20
        ? `<div class="content-search-empty">+${titleMatches.length - 20} more</div>` : '');

  // --- Tags group (sync) ---
  const tagMatches = allTags.filter(t => t.toLowerCase().includes(q)).slice(0, 25);

  // --- Content group (async; placeholder now, filled when the IPC lands) ---
  const contentPlaceholder = q.length >= 2
    ? '<div class="content-search-empty">Searching…</div>'
    : '<div class="content-search-empty">Type at least 2 characters</div>';

  container.innerHTML =
    searchGroupHtml('titles', 'Titles', titleMatches.length, titlesBody) +
    searchGroupHtml('content', 'Content', 0, contentPlaceholder) +
    searchGroupHtml('tags', 'Tags', tagMatches.length, tagRowsHtml(tagMatches));

  if (q.length >= 2) {
    fillContentGroup(raw.trim(), token);
  }
}

async function fillContentGroup(query, token) {
  let results = [];
  try {
    results = await window.api.searchNotes(query);
  } catch (err) {
    console.error('Content search failed:', err);
    return;
  }
  if (token !== contentSearchToken) return; // stale response

  const group = document.querySelector('#content-search-results .search-group[data-group="content"]');
  if (!group) return;
  const body = group.querySelector('.search-group-body');
  const count = group.querySelector('.search-group-count');
  if (count) count.textContent = String(results.length);

  if (!results.length) {
    body.innerHTML = '<div class="content-search-empty">No matches</div>';
    return;
  }
  body.innerHTML = results.slice(0, 20).map(r => {
    const snippet = r.snippets && r.snippets[0];
    return `
      <div class="content-search-item" onclick="openNoteAtLine(${jsArg(r.fsPath)}, ${snippet ? snippet.line : 0})">
        <div class="content-search-title">
          <span>${escapeHtml(r.title)}</span>
          <span class="content-search-count">${r.matchCount}</span>
        </div>
        ${snippet ? `<div class="content-search-snippet">${highlightSnippet(snippet.text, snippet.ranges)}</div>` : ''}
      </div>
    `;
  }).join('');
}

// Build safe highlighted HTML from a snippet: each slice is escaped
// individually (the ranges refer to the raw text), matches wrapped in <mark>
function highlightSnippet(text, ranges) {
  let html = '';
  let cursor = 0;
  (ranges || []).forEach(([start, length]) => {
    html += escapeHtml(text.slice(cursor, start));
    html += `<mark>${escapeHtml(text.slice(start, start + length))}</mark>`;
    cursor = start + length;
  });
  html += escapeHtml(text.slice(cursor));
  return html;
}

// Open a note and reveal the given line (best effort: exact caret placement
// in edit/split; proportional scroll in preview, which has no line anchors)
async function openNoteAtLine(fsPath, line) {
  await openNote(fsPath);
  const lineIdx = Math.max(0, parseInt(line, 10) || 0);
  if (viewMode === 'edit' || viewMode === 'split') {
    const textarea = document.getElementById('note-editor');
    const lines = textarea.value.split('\n');
    let offset = 0;
    for (let i = 0; i < Math.min(lineIdx, lines.length - 1); i++) {
      offset += lines[i].length + 1;
    }
    textarea.focus();
    textarea.setSelectionRange(offset, offset);
    scrollEditorCaretIntoView(textarea);
  } else {
    const preview = document.getElementById('preview-pane');
    const totalLines = noteContent.split('\n').length || 1;
    // wait one tick for the render queue to finish laying out
    await renderMarkdownPreview();
    preview.scrollTop = Math.max(0, (lineIdx / totalLines) * preview.scrollHeight - preview.clientHeight / 3);
  }
}

// Global tags modal cloud
function renderTagsCloud() {
  const container = document.getElementById('tags-popover-list');
  if (!container) return;
  
  if (tagSet.size === 0) {
    container.innerHTML = '<div style="font-size:12px; color:var(--text-secondary);">No tags found in notes</div>';
    return;
  }

  let html = '';
  Array.from(tagSet).sort().forEach(tag => {
    const isSelected = activeTagFilter === tag;
    html += `<span class="tag-pill ${isSelected ? 'active' : ''}" style="margin: 2px; display:inline-block;" onclick="toggleTagFilter(${jsArg(tag)})">#${escapeHtml(tag)}</span>`;
  });
  container.innerHTML = html;
}

function showTagsPopover() {
  document.getElementById('tags-popover').classList.add('active');
}

function hideTagsPopover() {
  document.getElementById('tags-popover').classList.remove('active');
}

function toggleTagFilter(tag) {
  if (activeTagFilter === tag) {
    clearTagFilter();
  } else {
    activeTagFilter = tag;
    document.getElementById('active-tag-indicator').style.display = 'flex';
    document.getElementById('active-tag-label').innerText = '#' + tag;
    refreshNotebook();
  }
  hideTagsPopover();
}

function clearTagFilter() {
  activeTagFilter = '';
  document.getElementById('active-tag-indicator').style.display = 'none';
  refreshNotebook();
}



// Open Note Canvas & Render
async function openNote(filePath) {
  try {
    // Save current note first in case it's edited
    if (activeNote && noteContent !== noteOriginalContent) {
      await saveActiveNote();
    }

    activeNote = filePath;
    activeSection = null; // Clear section landing state
    noteContent = await window.api.readNote(filePath);
    noteOriginalContent = noteContent;
    
    // Auto-expand parent folders in sidebar tree
    expandFoldersToPath(filePath);

    // Expose Workspace note controls
    document.getElementById('empty-state-canvas').style.display = 'none';
    document.getElementById('landing-workspace').style.display = 'none';
    document.getElementById('note-workspace').style.display = 'flex';
    
    const modeToggles = document.querySelector('.mode-toggles');
    if (modeToggles) modeToggles.style.display = 'flex';

    // Track the note in the tab strip
    if (!openTabs.includes(filePath)) {
      openTabs.push(filePath);
    }
    renderTabStrip();
    persistTabs();
    recordRecentNote(filePath);

    // Reset view to default preview first, without rendering: renderActiveNote
    // below renders the preview once (previously this rendered twice per open)
    setViewMode('preview', { render: false });
    renderActiveNote();

    // Render sidebar active selection state
    renderSidebarTree();
  } catch (err) {
    console.error('Error opening note:', err);
  }
}

// Close Note Canvas
function closeNoteCanvas() {
  activeNote = '';
  activeSection = null;
  noteContent = '';
  noteOriginalContent = '';
  document.getElementById('note-workspace').style.display = 'none';
  document.getElementById('landing-workspace').style.display = 'none';
  document.getElementById('empty-state-canvas').style.display = 'flex';
  renderSidebarTree();
  renderTabStrip();
}

// Render active note Markdown + Editor text fields
function renderActiveNote() {
  if (!activeNote) return;

  const node = findNodeByPath(treeData, activeNote);
  const noteTitle = node ? node.title : pathBasename(activeNote, '.md');
  const createdDate = node ? node.created : '';
  const author = appSettings.author || '';
  const tags = node ? node.tags : [];

  // Update Header Title & Save Status
  document.getElementById('note-title').innerText = noteTitle;
  updateSaveStatus(false);

  // Update Date
  document.getElementById('note-meta-date').innerText = createdDate || 'No Date';

  // Update Author
  const authorContainer = document.getElementById('note-meta-author-container');
  if (author) {
    document.getElementById('note-meta-author').innerText = author;
    authorContainer.style.display = 'flex';
  } else {
    authorContainer.style.display = 'none';
  }

  // Update Tags Row
  const tagList = document.getElementById('note-meta-tags');
  tagList.innerHTML = '';
  tags.forEach(tag => {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.innerText = '#' + tag;
    pill.onclick = () => toggleTagFilter(tag);
    tagList.appendChild(pill);
  });

  // Render Editor Textarea
  const editor = document.getElementById('note-editor');
  editor.value = noteContent;
  updateLineNumbers();
  updateWordCount();

  // Render Markdown HTML preview
  renderMarkdownPreview();
  
  // Re-bind custom tooltips to dynamic note elements
  initCustomTooltips();

  // Update outline and backlinks if right drawer is open
  const drawer = document.getElementById('right-drawer');
  if (drawer && !drawer.classList.contains('collapsed')) {
    updateOutlineAndBacklinks();
  }
}

// Render HTML Preview and draw Mermaid.
// Renders are serialized: replacing the preview's innerHTML while a previous
// mermaid.run() is still in flight detaches its nodes mid-render and throws.
let previewRenderQueue = Promise.resolve();
function renderMarkdownPreview() {
  previewRenderQueue = previewRenderQueue
    .then(() => doRenderMarkdownPreview())
    .catch(err => console.error('Preview render error:', err));
  return previewRenderQueue;
}

async function doRenderMarkdownPreview() {
  const preview = document.getElementById('preview-pane');
  // resourceBase lets relative image links (attachments) resolve correctly
  const renderedHtml = window.api.renderMarkdown(noteContent, {
    resourceBase: activeNote ? pathDirname(activeNote) : '',
  });
  preview.innerHTML = renderedHtml;

  // Remember each diagram's source before Mermaid replaces it with an SVG,
  // so the popout viewer can re-render it at full quality later.
  preview.querySelectorAll('.notebook-mermaid').forEach(el => {
    el.dataset.mermaidSrc = el.textContent;
  });

  // Images open in the lightbox viewer
  wirePreviewImages(preview);

  // Intercept click event on checklists in preview mode
  preview.querySelectorAll('.task-checkbox-link').forEach(link => {
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      const lineIdx = parseInt(link.getAttribute('data-line'), 10);
      if (isNaN(lineIdx)) return;

      // Optimistic in-place toggle: no re-read, no full preview re-render
      // (which would re-run every mermaid diagram just to flip a checkbox).
      // The current state comes from the SOURCE line, not the DOM: when the
      // click lands on the <input> itself the browser has already toggled
      // it (and reverts it again after preventDefault), so checkbox.checked
      // is unreliable at this point.
      const checkbox = link.querySelector('.task-checkbox');
      const checkboxRe = /^([ \t]*([-*+]\s+|\d+\.\s+)?)\[([ xX])\]/;
      const lines = noteContent.split(/\r?\n/);
      const m = lines[lineIdx] !== undefined ? lines[lineIdx].match(checkboxRe) : null;
      const wasChecked = m ? m[3] !== ' ' : (checkbox ? checkbox.checked : false);
      if (checkbox) checkbox.checked = !wasChecked;

      const success = await window.api.toggleTaskAtLine(activeNote, lineIdx);
      if (!success) {
        if (checkbox) checkbox.checked = wasChecked;
        showToast('Could not toggle the task.', 'error');
        return;
      }
      // Re-assert in a NEW task: the canceled native click reverts the
      // input when dispatch completes — which runs after this handler's
      // microtask continuations, so only a macrotask reliably wins.
      if (checkbox) setTimeout(() => { checkbox.checked = !wasChecked; }, 0);

      // Patch local state to EXACTLY what main wrote. toggle-task-at-line
      // splits /\r?\n/ and joins with '\n' (normalizes CRLF) — replicate
      // that so the debounced files-changed refresh sees matching content
      // and skips the preview re-render.
      if (m) {
        lines[lineIdx] = lines[lineIdx].replace(checkboxRe, `$1[${m[3] === ' ' ? 'x' : ' '}]`);
        noteContent = lines.join('\n');
        noteOriginalContent = noteContent;
        document.getElementById('note-editor').value = noteContent;
        updateWordCount();
      } else {
        // Line didn't look like a checkbox (note changed underneath us):
        // fall back to the full re-read + re-render path
        noteContent = await window.api.readNote(activeNote);
        noteOriginalContent = noteContent;
        renderActiveNote();
      }
    });
  });

  // Intercept wiki-links click event
  preview.querySelectorAll('.wiki-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const targetPage = link.getAttribute('data-page');
      // Resolve path
      const rootDir = notebookRoot;
      const targetPath = findPagePathByFilename(treeData, targetPage);
      if (targetPath) {
        openNote(targetPath);
      } else {
        // Create new note with this name!
        promptCreatePageWithName(targetPage);
      }
    });
  });

  // Wrap and add copy utilities to code blocks
  preview.querySelectorAll('pre').forEach(preEl => {
    if (preEl.closest('.mermaid-block-container') || preEl.classList.contains('notebook-mermaid')) {
      return;
    }
    if (preEl.parentElement.classList.contains('code-block-wrapper')) {
      return;
    }
    
    const codeEl = preEl.querySelector('code');
    let lang = 'code';
    if (codeEl) {
      const langClass = Array.from(codeEl.classList).find(c => c.startsWith('language-'));
      if (langClass) {
        lang = langClass.replace('language-', '');
      }
    }
    
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';
    
    const header = document.createElement('div');
    header.className = 'code-block-header';
    header.innerHTML = `
      <span>${lang}</span>
      <button class="code-block-copy-btn" title="Copy to clipboard">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy
      </button>
    `;
    
    const copyBtn = header.querySelector('.code-block-copy-btn');
    copyBtn.addEventListener('click', () => {
      const codeText = codeEl ? codeEl.innerText : preEl.innerText;
      navigator.clipboard.writeText(codeText).then(() => {
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: var(--accent-green);"><polyline points="20 6 9 17 4 12"/></svg>
          Copied!
        `;
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy
          `;
        }, 2000);
      });
    });
    
    preEl.parentNode.insertBefore(wrapper, preEl);
    wrapper.appendChild(header);
    wrapper.appendChild(preEl);
  });

  // Render Mermaid diagrams. mermaid.run() is async — it must be awaited,
  // otherwise the SVG sizing below runs before the SVGs exist and diagrams
  // stay capped at Mermaid's inline max-width instead of filling the pane.
  // The library itself loads lazily, and only when the note has diagrams.
  if (preview.querySelector('.notebook-mermaid')) {
    try {
      await ensureMermaid();
      await window.mermaid.run({
        querySelector: '#preview-pane .notebook-mermaid',
      });
    } catch (err) {
      console.error('Mermaid render error:', err);
    }

    // Apply the configured default zoom to each rendered diagram
    preview.querySelectorAll('.mermaid-block-container').forEach(container => {
      const diagram = container.querySelector('.notebook-mermaid');
      const svg = diagram ? diagram.querySelector('svg') : null;
      if (diagram && svg) {
        const zoom = clampMermaidZoom(appSettings.defaultMermaidZoom || 100);
        diagram.dataset.zoomLevel = String(zoom);
        applyInlineMermaidZoom(diagram, svg, zoom);
      }
    });
  }
}

// Inline diagram zoom works by giving the SVG an explicit pixel width
// relative to the container (100% = container-filling, the default look).
// CSS `zoom` can't be used: the SVG is pinned to 100% container width, so
// scaling the box just re-fills the same space with no visible change.
function clampMermaidZoom(zoom) {
  return Math.max(40, Math.min(300, Math.round(zoom)));
}

// Portrait diagrams (taller than wide, e.g. long flowchart TD chains) must
// NOT fill the pane width — that balloons their height to several screens.
// Their 100%-zoom base width is instead derived from a height cap, so they
// read at a sensible size; landscape diagrams keep the pane-filling look.
function mermaidBaseWidth(pre, svg) {
  const paneWidth = pre.clientWidth || 600;
  const vb = svg.viewBox && svg.viewBox.baseVal;
  if (vb && vb.width && vb.height && vb.height > vb.width) {
    const heightCap = Math.max(300, Math.round(window.innerHeight * 0.6));
    return Math.min(Math.round(heightCap * vb.width / vb.height), paneWidth);
  }
  return paneWidth;
}

function applyInlineMermaidZoom(pre, svg, zoom) {
  const base = mermaidBaseWidth(pre, svg);
  const paneWidth = pre.clientWidth || 600;
  if (zoom === 100 && base === paneWidth) {
    svg.style.width = '100%';
    svg.style.maxWidth = '100%';
  } else {
    svg.style.width = `${Math.round(base * zoom / 100)}px`;
    svg.style.maxWidth = zoom === 100 ? '100%' : 'none';
  }
  svg.style.height = 'auto';
}

// Helper to look up file by name in tree nodes
function findPagePathByFilename(node, filename) {
  if (!node) return null;
  if (node.kind === 'page' && node.name.toLowerCase() === filename.toLowerCase()) {
    return node.fsPath;
  }
  if (node.kind === 'section') {
    for (const p of node.pages) {
      if (p.name.toLowerCase() === filename.toLowerCase()) return p.fsPath;
    }
    for (const s of node.sections) {
      const match = findPagePathByFilename(s, filename);
      if (match) return match;
    }
  }
  return null;
}

// Set view layout modes. options.render=false skips the preview re-render
// for callers that render themselves right after (avoids double mermaid runs).
function setViewMode(mode, options = {}) {
  const { render = true } = options;
  viewMode = mode;
  const container = document.getElementById('editor-preview-container');
  
  // Sync buttons styles
  document.querySelectorAll('.mode-toggles button').forEach(btn => btn.classList.remove('active'));
  document.getElementById(`btn-mode-${mode}`).classList.add('active');

  const formatTools = document.getElementById('editor-format-tools');

  if (mode === 'preview') {
    container.className = 'preview-mode';
    formatTools.style.display = 'none';
  } else if (mode === 'edit') {
    container.className = 'edit-mode';
    formatTools.style.display = 'flex';
    document.getElementById('note-editor').focus();
  } else {
    container.className = 'split-mode';
    formatTools.style.display = 'flex';
  }

  // Update page width style rules
  container.classList.remove('page-width-wide', 'page-width-full');
  if (appSettings.defaultPageWidth === 'wide') {
    container.classList.add('page-width-wide');
  } else if (appSettings.defaultPageWidth === 'full') {
    container.classList.add('page-width-full');
  }

  if (mode === 'preview' || mode === 'split') {
    if (render) {
      renderMarkdownPreview();
    }
    if (activeNote && noteContent !== noteOriginalContent) {
      saveActiveNote();
    }
  }

  // Entering split: bring the preview to where the editor already is
  // (best effort — diagrams may still be rendering and shift heights)
  if (mode === 'split') {
    requestAnimationFrame(() => syncSplitScroll('editor'));
  }
}

// Editor interaction handling
// ==========================================
// [[ NOTE-LINK AUTOCOMPLETE
// Typing "[[" opens a fuzzy title picker; choosing inserts a wiki-link
// (resolved by filename, displayed by title).
// ==========================================
let wikiAC = { open: false, items: [], index: 0, start: -1 };

// Subsequence fuzzy match: every query char appears in order in the text
function wikiFuzzy(query, text) {
  query = query.toLowerCase(); text = text.toLowerCase();
  if (!query) return true;
  let ti = 0;
  for (const ch of query) {
    ti = text.indexOf(ch, ti);
    if (ti === -1) return false;
    ti++;
  }
  return true;
}

// Is the caret sitting just after an unclosed "[[" on the same line?
function detectWikiContext(textarea) {
  if (textarea.selectionStart !== textarea.selectionEnd) return null;
  const pos = textarea.selectionStart;
  const before = textarea.value.slice(0, pos);
  const open = before.lastIndexOf('[[');
  if (open === -1) return null;
  const between = before.slice(open + 2);
  if (/[\]\n\[]/.test(between)) return null; // closed, newline, or nested
  return { start: open, query: between };
}

function updateWikiAutocomplete() {
  const textarea = document.getElementById('note-editor');
  if (!textarea) return;
  const ctx = detectWikiContext(textarea);
  if (!ctx) { hideWikiAutocomplete(); return; }
  const q = ctx.query.trim();
  const pages = treeData ? gatherPagesRecursively(treeData) : [];
  let items = pages.filter(p => wikiFuzzy(q, p.title) || wikiFuzzy(q, p.name));
  const ql = q.toLowerCase();
  items.sort((a, b) => {
    const as = a.title.toLowerCase().startsWith(ql) ? 0 : 1;
    const bs = b.title.toLowerCase().startsWith(ql) ? 0 : 1;
    return as - bs || a.title.localeCompare(b.title);
  });
  items = items.slice(0, 8);
  if (!items.length) { hideWikiAutocomplete(); return; }
  wikiAC = { open: true, items, index: 0, start: ctx.start };
  renderWikiAutocomplete(textarea);
}

function moveWikiSelection(dir) {
  if (!wikiAC.open) return;
  wikiAC.index = (wikiAC.index + dir + wikiAC.items.length) % wikiAC.items.length;
  const list = document.getElementById('wikilink-autocomplete');
  if (!list) return;
  Array.from(list.children).forEach((el, i) => {
    el.classList.toggle('active', i === wikiAC.index);
    if (i === wikiAC.index) el.scrollIntoView({ block: 'nearest' });
  });
}

function insertWikiLink(page) {
  if (!page) return;
  const textarea = document.getElementById('note-editor');
  const pos = textarea.selectionStart;
  const target = page.name.replace(/\.md$/i, '');
  const link = page.title && page.title !== target ? `[[${target}|${page.title}]]` : `[[${target}]]`;
  // Consume a matching "]]" immediately after the caret, if the user typed one
  let end = pos;
  if (textarea.value.slice(pos, pos + 2) === ']]') end = pos + 2;
  hideWikiAutocomplete();
  replaceEditorRange(textarea, wikiAC.start, end, link);
}

// Caret pixel position via a mirror div that reproduces the textarea's
// wrapping, then reading where the caret span lands.
function editorCaretRect(textarea, position) {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement('div');
  const props = ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily',
    'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing'];
  props.forEach(p => { mirror.style[p] = style[p]; });
  mirror.style.position = 'fixed';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.overflow = 'hidden';
  const rect = textarea.getBoundingClientRect();
  mirror.style.left = `${rect.left}px`;
  mirror.style.top = `${rect.top}px`;
  mirror.style.height = `${rect.height}px`;
  mirror.textContent = textarea.value.slice(0, position);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const mRect = marker.getBoundingClientRect();
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  const x = mRect.left;
  const y = mRect.top - textarea.scrollTop;
  document.body.removeChild(mirror);
  return { x, y, lineHeight };
}

function renderWikiAutocomplete(textarea) {
  let list = document.getElementById('wikilink-autocomplete');
  if (!list) {
    list = document.createElement('div');
    list.id = 'wikilink-autocomplete';
    document.body.appendChild(list);
  }
  list.innerHTML = wikiAC.items.map((p, i) => {
    const dir = pathDirname(p.relPath);
    return `<div class="wikilink-option ${i === wikiAC.index ? 'active' : ''}" data-idx="${i}">
      <span class="wikilink-title">${escapeHtml(p.title)}</span>
      ${dir ? `<span class="wikilink-path">${escapeHtml(dir)}</span>` : ''}
    </div>`;
  }).join('');
  list.querySelectorAll('.wikilink-option').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep editor focus
      insertWikiLink(wikiAC.items[parseInt(el.dataset.idx, 10)]);
    });
  });
  list.style.display = 'block';
  const caret = editorCaretRect(textarea, textarea.selectionStart);
  const maxLeft = window.innerWidth - 280;
  const belowTop = caret.y + caret.lineHeight + 2;
  // Flip above the caret if the popup would run off the bottom
  const flipUp = belowTop + list.offsetHeight > window.innerHeight - 8;
  list.style.left = `${Math.max(8, Math.min(caret.x, maxLeft))}px`;
  list.style.top = `${flipUp ? Math.max(8, caret.y - list.offsetHeight - 2) : belowTop}px`;
}

function hideWikiAutocomplete() {
  wikiAC.open = false;
  const list = document.getElementById('wikilink-autocomplete');
  if (list) list.style.display = 'none';
}

function handleEditorInput() {
  const textarea = document.getElementById('note-editor');
  noteContent = textarea.value;
  updateLineNumbers();
  updateWordCount();
  updateSaveStatus(true);
  updateWikiAutocomplete();
  scheduleAiGhost();
  if (findBarVisible()) updateFindMatches();

  if (viewMode === 'split') {
    renderMarkdownPreview();
  }

  // Debounced auto-save (1 second after the last keystroke)
  if (autoSaveTimeout) {
    clearTimeout(autoSaveTimeout);
    autoSaveTimeout = null;
  }
  if (autoSaveEnabled && activeNote) {
    autoSaveTimeout = setTimeout(() => {
      autoSaveTimeout = null;
      saveActiveNote();
    }, 1000);
  }
}

function updateSaveStatus(edited) {
  const status = document.getElementById('save-status-indicator');
  if (edited) {
    status.innerText = 'Unsaved Changes';
    status.style.color = 'var(--accent-red)';
  } else {
    status.innerText = 'Saved';
    status.style.color = 'var(--accent-green)';
  }
  // Dirty dot on the active tab (only the active note can be dirty under
  // the single-active-note model)
  const activeTab = document.querySelector('#tab-strip .note-tab.active');
  if (activeTab) activeTab.classList.toggle('dirty', !!edited);
}

// Line Numbers counter. Incremental: row i always reads "i", so only
// trailing rows ever need to be added or removed — no innerHTML rebuild.
function updateLineNumbers() {
  const textarea = document.getElementById('note-editor');
  const lineNumbers = document.getElementById('line-numbers');
  const lines = textarea.value.split('\n').length;
  const rendered = lineNumbers.childElementCount;

  if (lines === rendered) return;

  if (lines > rendered) {
    const fragment = document.createDocumentFragment();
    for (let i = rendered + 1; i <= lines; i++) {
      const div = document.createElement('div');
      div.textContent = String(i);
      fragment.appendChild(div);
    }
    lineNumbers.appendChild(fragment);
  } else {
    while (lineNumbers.childElementCount > lines) {
      lineNumbers.lastElementChild.remove();
    }
  }
  syncEditorScroll(); // line-count changes can shift the textarea's scroll
}

// Word count + estimated reading time shown in the note header meta row
function updateWordCount() {
  const label = document.getElementById('note-meta-words');
  if (!label) return;
  let body = noteContent || '';
  const fm = body.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  if (fm) body = body.slice(fm[0].length);
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const minutes = Math.max(1, Math.round(words / 200));
  label.innerText = words === 0 ? '0 words' : `${words.toLocaleString()} words · ~${minutes} min read`;
}

// Keep the line-number gutter aligned with the textarea's scroll position
function syncEditorScroll() {
  const textarea = document.getElementById('note-editor');
  const lineNumbers = document.getElementById('line-numbers');
  if (textarea && lineNumbers) {
    lineNumbers.scrollTop = textarea.scrollTop;
  }
}

// ==========================================
// SPLIT VIEW SCROLL SYNC (proportional, bidirectional)
// ==========================================
// Scrolling either pane in split mode scrolls the other to the same
// relative position. The panes hold different content heights (rendered
// diagrams/images vs. source lines), so the sync maps scroll FRACTIONS,
// not pixel offsets.
//
// Echo guard: setting the partner's scrollTop fires that pane's own scroll
// event. `scrollSyncEcho` names the pane whose next scroll event is such an
// echo, so it's ignored instead of bouncing the sync back and forth.
let scrollSyncEcho = null;

function scrollFraction(el) {
  const range = el.scrollHeight - el.clientHeight;
  return range > 0 ? el.scrollTop / range : 0;
}

function syncSplitScroll(sourceName) {
  if (viewMode !== 'split') return;
  if (scrollSyncEcho === sourceName) {
    scrollSyncEcho = null;
    return;
  }
  const editor = document.getElementById('note-editor');
  const preview = document.getElementById('preview-pane');
  if (!editor || !preview) return;
  const [source, target, targetName] = sourceName === 'editor'
    ? [editor, preview, 'preview']
    : [preview, editor, 'editor'];
  const desired = Math.round(scrollFraction(source) * Math.max(0, target.scrollHeight - target.clientHeight));
  // Skip no-op writes: they fire no scroll event, which would leave the
  // echo guard armed and swallow the user's next real scroll
  if (Math.abs(target.scrollTop - desired) < 2) return;
  scrollSyncEcho = targetName;
  target.scrollTop = desired;
  if (targetName === 'editor') syncEditorScroll();
}

// Auto save active note
async function saveActiveNote() {
  if (!activeNote || noteContent === noteOriginalContent) return;
  await window.api.writeNote(activeNote, noteContent);
  noteOriginalContent = noteContent;
  updateSaveStatus(false);
  // No explicit refresh: the write triggers the main process's debounced
  // files-changed notification, which refreshes the notebook exactly once.
}

// Handle special keys inside editor
function handleEditorKeys(e) {
  const isCmdOrCtrl = IS_MAC ? e.metaKey : e.ctrlKey;

  // AI ghost suggestion: Tab accepts, Escape dismisses (checked before the
  // wiki popup since the two are never open at once)
  if (aiGhost.open) {
    if (e.key === 'Tab' && !e.shiftKey && !isCmdOrCtrl) {
      e.preventDefault();
      acceptAiGhost();
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); hideAiGhost(); return; }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) hideAiGhost();
  }

  // The [[ note-link popup owns Up/Down/Enter/Tab/Escape while it's open
  if (wikiAC.open) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveWikiSelection(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveWikiSelection(-1); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertWikiLink(wikiAC.items[wikiAC.index]); return; }
    if (e.key === 'Escape') { e.preventDefault(); hideWikiAutocomplete(); return; }
    // Moving the caret sideways or away dismisses the popup (default action runs)
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) hideWikiAutocomplete();
  }

  // Line power keys (VS Code conventions). Alt+↑/↓ moves lines,
  // Shift+Alt+↑/↓ duplicates them — no Cmd/Ctrl involved.
  if (e.altKey && !isCmdOrCtrl && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    if (e.shiftKey) duplicateEditorLines(e.target);
    else moveEditorLines(e.target, e.key === 'ArrowUp' ? -1 : 1);
    return;
  }

  if (isCmdOrCtrl) {
    // Delete the current line(s): Cmd/Ctrl+Shift+K
    if (e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      deleteEditorLines(e.target);
      return;
    }
    // Alt/Option combos advertised in the toolbar tooltips
    if (e.altKey) {
      const code = e.code; // e.key is unreliable with Option on macOS
      if (code === 'KeyL') {
        e.preventDefault();
        insertFormatting('list-bullet');
      } else if (code === 'KeyC' || code === 'KeyX') {
        e.preventDefault();
        insertFormatting('list-check');
      } else if (code === 'Minus') {
        e.preventDefault();
        insertFormatting('separator');
      }
      return;
    }
    if (e.key.toLowerCase() === 'b') {
      e.preventDefault();
      insertFormatting('bold');
    } else if (e.key.toLowerCase() === 'i') {
      e.preventDefault();
      insertFormatting('italic');
    }
    return;
  }

  // Tab indents inside the note instead of moving keyboard focus away
  if (e.key === 'Tab') {
    e.preventDefault();
    handleEditorTab(e.target, e.shiftKey);
    return;
  }

  // Enter continues lists / keeps the current indentation level
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
    if (handleEditorEnter(e.target)) {
      e.preventDefault();
    }
  }
}

const EDITOR_INDENT = '  ';
// Matches a list line: indent, bullet or ordered marker, optional task checkbox
const LIST_LINE_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/;

// Replace [start, end) in the textarea with `text`. Uses execCommand so the
// browser treats it like typing: the caret is scrolled into view natively and
// the edit lands on the undo stack. Falls back to a manual splice.
function replaceEditorRange(textarea, start, end, text) {
  textarea.focus();
  textarea.setSelectionRange(start, end);
  let handled = false;
  try {
    handled = text
      ? document.execCommand('insertText', false, text)
      : document.execCommand('delete');
  } catch {
    handled = false;
  }
  if (!handled) {
    const value = textarea.value;
    textarea.value = value.slice(0, start) + text + value.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
    handleEditorInput();
  }
  // execCommand fires the textarea's input event, so handleEditorInput has
  // already run in the handled case. Chromium doesn't reliably reveal the
  // caret after programmatic edits, so always scroll it into view ourselves.
  scrollEditorCaretIntoView(textarea);
}

// ==========================================
// EDITOR POWER KEYS: move / duplicate / delete whole lines
// (textarea can't do true multi-cursor, but these cover the common ones)
// ==========================================

// The line block the current selection touches: [startOfFirstLine, endOfLastLine)
// where end is the index of the newline after the block, or the value length.
function editorLineBounds(textarea) {
  const val = textarea.value;
  const s = textarea.selectionStart, e = textarea.selectionEnd;
  const startLine = val.lastIndexOf('\n', s - 1) + 1;
  let endLine = val.indexOf('\n', e);
  if (endLine === -1) endLine = val.length;
  return { startLine, endLine };
}

function moveEditorLines(textarea, dir) {
  const val = textarea.value;
  const { startLine, endLine } = editorLineBounds(textarea);
  const block = val.slice(startLine, endLine);
  if (dir < 0) {
    if (startLine === 0) return; // already at the top
    const prevStart = val.lastIndexOf('\n', startLine - 2) + 1;
    const prevLine = val.slice(prevStart, startLine - 1);
    replaceEditorRange(textarea, prevStart, endLine, `${block}\n${prevLine}`);
    textarea.setSelectionRange(prevStart, prevStart + block.length);
  } else {
    if (endLine === val.length) return; // already at the bottom
    let nextEnd = val.indexOf('\n', endLine + 1);
    if (nextEnd === -1) nextEnd = val.length;
    const nextLine = val.slice(endLine + 1, nextEnd);
    replaceEditorRange(textarea, startLine, nextEnd, `${nextLine}\n${block}`);
    const newStart = startLine + nextLine.length + 1;
    textarea.setSelectionRange(newStart, newStart + block.length);
  }
  scrollEditorCaretIntoView(textarea);
}

function duplicateEditorLines(textarea) {
  const val = textarea.value;
  const { startLine, endLine } = editorLineBounds(textarea);
  const block = val.slice(startLine, endLine);
  replaceEditorRange(textarea, endLine, endLine, `\n${block}`);
  const dupStart = endLine + 1;
  textarea.setSelectionRange(dupStart, dupStart + block.length);
  scrollEditorCaretIntoView(textarea);
}

function deleteEditorLines(textarea) {
  const val = textarea.value;
  let { startLine, endLine } = editorLineBounds(textarea);
  if (endLine < val.length) endLine += 1;        // consume the trailing newline
  else if (startLine > 0) startLine -= 1;         // last line: consume the leading one
  replaceEditorRange(textarea, startLine, endLine, '');
  textarea.setSelectionRange(startLine, startLine);
  scrollEditorCaretIntoView(textarea);
}

// Scroll the caret line into view. The caret's Y offset is measured with a
// hidden mirror element so soft-wrapped lines are accounted for.
function scrollEditorCaretIntoView(textarea) {
  const style = window.getComputedStyle(textarea);
  const lineHeight = parseFloat(style.lineHeight) || 21;

  const mirror = document.createElement('div');
  ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
   'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
   'borderWidth', 'boxSizing'].forEach(prop => {
    mirror.style[prop] = style[prop];
  });
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.textContent = textarea.value.slice(0, textarea.selectionEnd);

  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const caretTop = marker.offsetTop;
  mirror.remove();

  const caretBottom = caretTop + lineHeight;
  if (caretTop < textarea.scrollTop) {
    textarea.scrollTop = caretTop;
  } else if (caretBottom > textarea.scrollTop + textarea.clientHeight) {
    textarea.scrollTop = caretBottom - textarea.clientHeight + lineHeight;
  }
  syncEditorScroll();
}

function handleEditorTab(textarea, outdent) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const currentLine = text.slice(lineStart, text.indexOf('\n', start) === -1 ? text.length : text.indexOf('\n', start));
  const multiline = text.slice(start, end).includes('\n');
  const onListLine = LIST_LINE_RE.test(currentLine);

  if (multiline || outdent || onListLine) {
    // Line-wise indent/outdent of every selected line
    const block = text.slice(lineStart, end);
    const lines = block.split('\n');
    let firstLineDelta = 0;
    let totalDelta = 0;
    const changed = lines.map((line, i) => {
      if (outdent) {
        let removed = 0;
        if (line.startsWith(EDITOR_INDENT)) removed = EDITOR_INDENT.length;
        else if (line.startsWith('\t') || line.startsWith(' ')) removed = 1;
        if (i === 0) firstLineDelta = -removed;
        totalDelta -= removed;
        return line.slice(removed);
      }
      if (i === 0) firstLineDelta = EDITOR_INDENT.length;
      totalDelta += EDITOR_INDENT.length;
      return EDITOR_INDENT + line;
    }).join('\n');

    if (changed !== block) {
      replaceEditorRange(textarea, lineStart, end, changed);
    }
    textarea.selectionStart = Math.max(lineStart, start + firstLineDelta);
    textarea.selectionEnd = Math.max(lineStart, end + totalDelta);
  } else {
    // Plain cursor: insert an indent step at the caret
    replaceEditorRange(textarea, start, end, EDITOR_INDENT);
  }
}

function handleEditorEnter(textarea) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  if (start !== end) return false;

  const text = textarea.value;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const beforeCursor = text.slice(lineStart, start);

  const m = beforeCursor.match(LIST_LINE_RE);
  if (!m) {
    // Not a list: still preserve plain leading indentation
    const indentMatch = beforeCursor.match(/^[ \t]+/);
    if (indentMatch && beforeCursor.trim().length > 0) {
      replaceEditorRange(textarea, start, end, '\n' + indentMatch[0]);
      return true;
    }
    return false;
  }

  const [, indent, marker, spacing, checkbox, content] = m;

  // Empty list item: pressing Enter ends the list (removes the marker)
  if (!content.trim()) {
    replaceEditorRange(textarea, lineStart, start, '');
    return true;
  }

  // Continue the list at the same indentation (incrementing ordered markers)
  let nextMarker = marker;
  const num = marker.match(/^(\d+)([.)])$/);
  if (num) {
    nextMarker = (parseInt(num[1], 10) + 1) + num[2];
  }
  replaceEditorRange(textarea, start, end, '\n' + indent + nextMarker + spacing + (checkbox ? '[ ] ' : ''));
  return true;
}

// Formatting inserts helper
function insertFormatting(type) {
  const textarea = document.getElementById('note-editor');
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  const selection = text.substring(start, end);
  
  let insertion = '';
  let cursorOffset = 0;

  switch (type) {
    case 'bold':
      insertion = `**${selection}**`;
      cursorOffset = selection ? insertion.length : 2;
      break;
    case 'italic':
      insertion = `*${selection}*`;
      cursorOffset = selection ? insertion.length : 1;
      break;
    case 'list-bullet':
      insertion = `\n- ${selection}`;
      cursorOffset = insertion.length;
      break;
    case 'list-number':
      insertion = `\n1. ${selection}`;
      cursorOffset = insertion.length;
      break;
    case 'list-check':
      insertion = `\n- [ ] ${selection}`;
      cursorOffset = insertion.length;
      break;
    case 'separator':
      insertion = `\n---\n`;
      cursorOffset = insertion.length;
      break;
    case 'blockquote':
      insertion = `\n> ${selection}`;
      cursorOffset = insertion.length;
      break;
    case 'tldr':
      insertion = `\n> **TL;DR:** ${selection}`;
      // Place caret right after "TL;DR: " when there's no selection
      cursorOffset = selection ? insertion.length : insertion.length;
      break;
  }

  textarea.value = text.substring(0, start) + insertion + text.substring(end);
  textarea.selectionStart = start + cursorOffset;
  textarea.selectionEnd = start + cursorOffset;
  textarea.focus();
  handleEditorInput();
}

function insertHeading(level) {
  const textarea = document.getElementById('note-editor');
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  const selection = text.substring(start, end);
  
  const prefix = '#'.repeat(parseInt(level, 10)) + ' ';
  const insertion = `\n${prefix}${selection}`;
  
  textarea.value = text.substring(0, start) + insertion + text.substring(end);
  textarea.selectionStart = start + insertion.length;
  textarea.selectionEnd = start + insertion.length;
  textarea.focus();
  handleEditorInput();

  // Hide heading dropdown menu immediately
  const headingMenu = document.getElementById('dropdown-heading');
  if (headingMenu) {
    headingMenu.classList.remove('active');
    const chev = headingMenu.closest('.editor-dropdown').querySelector('.chevron');
    if (chev) chev.style.transform = 'rotate(0deg)';
  }
}

// Custom dropdown controls
function toggleEditorDropdown(id, event) {
  event.stopPropagation();
  const targetMenu = document.getElementById(id);
  const isActive = targetMenu.classList.contains('active');
  
  // Close all other menus first
  const menus = document.querySelectorAll('.dropdown-menu');
  menus.forEach(menu => {
    menu.classList.remove('active');
    const toggle = menu.closest('.editor-dropdown').querySelector('.dropdown-toggle');
    if (toggle) {
      const chev = toggle.querySelector('.chevron');
      if (chev) chev.style.transform = 'rotate(0deg)';
    }
  });
  
  if (!isActive) {
    targetMenu.classList.add('active');
    const toggleBtn = event.currentTarget;
    const chev = toggleBtn.querySelector('.chevron');
    if (chev) chev.style.transform = 'rotate(180deg)';

    if (id === 'dropdown-date') {
      updateDateDropdownExamples();
    }
  }
}

function updateDateDropdownExamples() {
  const now = new Date();
  const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  
  const formats = {
    locale: now.toLocaleString(),
    iso: now.toISOString().split('.')[0],
    short: now.toISOString().split('T')[0],
    long: now.toLocaleDateString(undefined, options),
    time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };
  
  const menu = document.getElementById('dropdown-date');
  if (!menu) return;
  
  const items = menu.querySelectorAll('.dropdown-item');
  items.forEach(item => {
    const onclickAttr = item.getAttribute('onclick') || '';
    const match = onclickAttr.match(/insertTimestamp\('(.*?)'\)/);
    if (match) {
      const type = match[1];
      const val = formats[type] || '';
      item.innerHTML = val;
    }
  });
}

function initCustomTooltips() {
  // Remove existing tooltip element if present
  let tooltipEl = document.getElementById('custom-tooltip');
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'custom-tooltip';
    tooltipEl.className = 'custom-tooltip';
    document.body.appendChild(tooltipEl);
  }

  // Scan all toolbar buttons, icon-toggles, and dropdown elements with standard title hover cues
  const selectors = '.toolbar-btn, .icon-btn, .dropdown-toggle, .dropdown-item, .mode-toggles button, .sidebar-header button, .popout-actions button';
  document.querySelectorAll(selectors).forEach(el => {
    // Normalize at capture time too, so late-rendered elements are always
    // platform-correct regardless of init ordering
    const title = normalizeShortcutText(el.getAttribute('title'));
    if (title && !el.dataset.tooltipBound) {
      el.dataset.tooltip = title;
      el.dataset.tooltipBound = 'true'; // this runs after every render; bind each element once
      el.removeAttribute('title'); // hide default system tooltip

      el.addEventListener('mouseenter', () => {
        const text = el.dataset.tooltip;
        if (!text) return;
        
        let formattedText = text;
        const shortcutMatch = text.match(/\(([^)]+)\)/);
        if (shortcutMatch) {
          const shortcut = shortcutMatch[1];
          const cleanText = text.replace(/\([^)]+\)/, '').trim();
          formattedText = `${cleanText} <span class="shortcut">${shortcut}</span>`;
        }
        
        tooltipEl.innerHTML = formattedText;
        tooltipEl.classList.add('visible');
        
        // Position custom tooltip card
        const rect = el.getBoundingClientRect();
        tooltipEl.style.left = '0px';
        tooltipEl.style.top = '0px';
        
        const tooltipRect = tooltipEl.getBoundingClientRect();
        const left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
        const top = rect.bottom + 8;
        
        tooltipEl.style.left = `${Math.max(8, Math.min(window.innerWidth - tooltipRect.width - 8, left))}px`;
        tooltipEl.style.top = `${top}px`;
      });

      el.addEventListener('mouseleave', () => {
        tooltipEl.classList.remove('visible');
      });
      
      el.addEventListener('click', () => {
        tooltipEl.classList.remove('visible');
      });
    }
  });
}

// ==========================================
// PANEL LAYOUT: RESIZABLE SIDEBAR & OUTLINE DRAWER, SIDEBAR COLLAPSE
// ==========================================

const PANEL_MIN_WIDTH = 180;
const PANEL_MAX_WIDTH = 520;

function initPanelLayout() {
  const sidebar = document.getElementById('sidebar');
  const drawer = document.getElementById('right-drawer');

  // Restore persisted widths
  const savedSidebar = parseInt(localStorage.getItem('panelWidth:sidebar'), 10);
  if (savedSidebar >= PANEL_MIN_WIDTH && savedSidebar <= PANEL_MAX_WIDTH) {
    sidebar.style.width = `${savedSidebar}px`;
  }
  const savedDrawer = parseInt(localStorage.getItem('panelWidth:drawer'), 10);
  if (savedDrawer >= PANEL_MIN_WIDTH && savedDrawer <= PANEL_MAX_WIDTH) {
    drawer.style.width = `${savedDrawer}px`;
  }

  // Restore collapsed state
  if (localStorage.getItem('sidebarCollapsed') === '1') {
    setSidebarCollapsed(true);
  }

  initPanelResizer('sidebar-resizer', sidebar, 'left', 'panelWidth:sidebar');
  initPanelResizer('drawer-resizer', drawer, 'right', 'panelWidth:drawer');
}

// Generic horizontal drag-resize for a fixed-width flex panel.
// side: 'left' panels grow towards the right, 'right' panels towards the left.
function initPanelResizer(resizerId, panel, side, storageKey) {
  const resizer = document.getElementById(resizerId);
  if (!resizer || !panel) return;

  let dragging = false;

  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';

    // Full-screen overlay so iframes/textareas don't swallow mouse events
    const overlay = document.createElement('div');
    overlay.id = 'panel-resizer-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;cursor:col-resize;';
    document.body.appendChild(overlay);
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = panel.getBoundingClientRect();
    const width = side === 'left' ? (e.clientX - rect.left) : (rect.right - e.clientX);
    const clamped = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, width));
    panel.style.width = `${clamped}px`;
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    const overlay = document.getElementById('panel-resizer-overlay');
    if (overlay) overlay.remove();
    localStorage.setItem(storageKey, String(parseInt(panel.style.width, 10) || panel.getBoundingClientRect().width));
  });
}

function setSidebarCollapsed(collapsed) {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('collapsed', collapsed);
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
  syncPaneToggleIcons();
}

// Keep the three pane-toggle icons (notebook / search / outline) lit to match
// which panels are currently open, so the toolbar reads as a pane switcher.
function syncPaneToggleIcons() {
  const drawerOpen = !document.getElementById('right-drawer').classList.contains('collapsed');
  const set = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', on);
  };
  // The notebook (left sidebar) toggle lives on the left edge, not here; the
  // two drawer icons on the right light up for their open pane.
  set('btn-open-search', drawerOpen && drawerTab === 'search');
  set('btn-toggle-outline', drawerOpen && drawerTab === 'outline');
}

function toggleSidebarCollapsed() {
  const sidebar = document.getElementById('sidebar');
  setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
}

function initPaneResizer() {
  const container = document.getElementById('editor-preview-container');
  const resizer = document.getElementById('pane-resizer');
  const leftPane = document.getElementById('editor-pane');
  const rightPane = document.getElementById('preview-pane');
  
  if (!resizer || !container || !leftPane || !rightPane) return;
  
  let isDragging = false;
  
  resizer.addEventListener('mousedown', (e) => {
    isDragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    
    const overlay = document.createElement('div');
    overlay.id = 'resizer-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.zIndex = '99999';
    overlay.style.cursor = 'col-resize';
    document.body.appendChild(overlay);
    
    e.preventDefault();
  });
  
  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    
    const containerRect = container.getBoundingClientRect();
    const relativeX = e.clientX - containerRect.left;
    const percentage = (relativeX / containerRect.width) * 100;
    
    if (percentage >= 15 && percentage <= 85) {
      leftPane.style.flex = `0 0 ${percentage}%`;
      rightPane.style.flex = `0 0 ${100 - percentage}%`;
    }
  });
  
  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      const overlay = document.getElementById('resizer-overlay');
      if (overlay) overlay.remove();
    }
  });
}

function insertCodeBlock(language) {
  const textarea = document.getElementById('note-editor');
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  const selection = text.substring(start, end);

  const insertion = `\n\`\`\`${language}\n${selection}\n\`\`\`\n`;
  textarea.value = text.substring(0, start) + insertion + text.substring(end);
  
  // Set cursor inside code fence block
  const cursorOffset = `\n\`\`\`${language}\n`.length;
  textarea.selectionStart = start + cursorOffset;
  textarea.selectionEnd = start + cursorOffset + selection.length;
  textarea.focus();
  handleEditorInput();

  // Hide dropdown menu
  const menu = document.getElementById('dropdown-code');
  if (menu) {
    menu.classList.remove('active');
    const chev = menu.closest('.editor-dropdown').querySelector('.chevron');
    if (chev) chev.style.transform = 'rotate(0deg)';
  }
}

function insertTimestamp(format) {
  const textarea = document.getElementById('note-editor');
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  
  const now = new Date();
  let timeStr = '';
  switch (format) {
    case 'locale':
      timeStr = now.toLocaleString();
      break;
    case 'iso':
      timeStr = now.toISOString().split('.')[0];
      break;
    case 'short':
      timeStr = now.toISOString().split('T')[0];
      break;
    case 'long':
      const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
      timeStr = now.toLocaleDateString(undefined, options);
      break;
    case 'time':
      timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      break;
  }

  textarea.value = text.substring(0, start) + timeStr + text.substring(end);
  textarea.selectionStart = start + timeStr.length;
  textarea.selectionEnd = start + timeStr.length;
  textarea.focus();
  handleEditorInput();

  // Hide dropdown menu
  const menu = document.getElementById('dropdown-date');
  if (menu) {
    menu.classList.remove('active');
    const chev = menu.closest('.editor-dropdown').querySelector('.chevron');
    if (chev) chev.style.transform = 'rotate(0deg)';
  }
}

function initTableGrid() {
  const grid = document.getElementById('table-selection-grid');
  if (!grid) return;
  
  grid.innerHTML = '';
  for (let r = 1; r <= 8; r++) {
    for (let c = 1; c <= 8; c++) {
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      cell.dataset.row = r;
      cell.dataset.col = c;
      
      // Hover highlight
      cell.addEventListener('mouseover', () => highlightGrid(r, c));
      
      // Click execution
      cell.addEventListener('click', () => {
        insertTableGrid(r, c);
        const menu = document.getElementById('dropdown-table');
        if (menu) {
          menu.classList.remove('active');
          const chev = menu.closest('.editor-dropdown').querySelector('.chevron');
          if (chev) chev.style.transform = 'rotate(0deg)';
        }
      });
      
      grid.appendChild(cell);
    }
  }
}

function highlightGrid(rows, cols) {
  const cells = document.querySelectorAll('#table-selection-grid .grid-cell');
  cells.forEach(cell => {
    const r = parseInt(cell.dataset.row, 10);
    const c = parseInt(cell.dataset.col, 10);
    if (r <= rows && c <= cols) {
      cell.classList.add('highlighted');
    } else {
      cell.classList.remove('highlighted');
    }
  });
  document.getElementById('table-grid-label').innerText = `Select Grid (${cols} x ${rows})`;
}

function insertTableGrid(rows, cols) {
  const textarea = document.getElementById('note-editor');
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;

  // Header row
  let headerRow = '|';
  let dividerRow = '|';
  for (let c = 1; c <= cols; c++) {
    headerRow += ` Header ${c} |`;
    dividerRow += ' -------- |';
  }
  headerRow += '\n';
  dividerRow += '\n';

  // Data rows
  let dataRows = '';
  for (let r = 1; r <= rows; r++) {
    let row = '|';
    for (let c = 1; c <= cols; c++) {
      row += '        |';
    }
    dataRows += row + '\n';
  }

  const insertion = `\n${headerRow}${dividerRow}${dataRows}`;
  textarea.value = text.substring(0, start) + insertion + text.substring(end);
  
  // Put cursor and select "Header 1" so they can type immediately
  const cursorOffset = 3;
  textarea.selectionStart = start + cursorOffset;
  textarea.selectionEnd = start + cursorOffset + 8; // length of "Header 1"
  textarea.focus();
  handleEditorInput();
}

function insertMermaidChart(chartType) {
  const textarea = document.getElementById('note-editor');
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;

  let insertion = '';
  switch (chartType) {
    case 'flowchart':
      insertion = `\n\`\`\`mermaid\nflowchart TD\n    A[Start] --> B(Process)\n    B --> C{Decision}\n    C -->|Yes| D[Result 1]\n    C -->|No| E[Result 2]\n\`\`\`\n`;
      break;
    case 'sequence':
      insertion = `\n\`\`\`mermaid\nsequenceDiagram\n    Alice->>Bob: Hello Bob, how are you?\n    Bob-->>Alice: Great, thanks!\n    Alice-)Bob: Talk to you later!\n\`\`\`\n`;
      break;
    case 'gantt':
      insertion = `\n\`\`\`mermaid\ngantt\n    title A Gantt Diagram\n    dateFormat YYYY-MM-DD\n    section Section\n    A task :a1, 2026-07-07, 30d\n    Another task :after a1, 20d\n\`\`\`\n`;
      break;
    case 'class':
      insertion = `\n\`\`\`mermaid\nclassDiagram\n    Animal <|-- Duck\n    Animal <|-- Fish\n    Animal : +int age\n    Animal : +String gender\n    Animal: +isMammal()\n    class Duck{\n        +String beakColor\n        +swim()\n    }\n\`\`\`\n`;
      break;
    case 'state':
      insertion = `\n\`\`\`mermaid\nstateDiagram-v2\n    [*] --> Still\n    Still --> [*]\n    Still --> Moving\n    Moving --> Still\n    Moving --> Crash\n    Crash --> [*]\n\`\`\`\n`;
      break;
    case 'pie':
      insertion = `\n\`\`\`mermaid\npie title Key Elements\n    "Dogs" : 386\n    "Cats" : 85\n    "Birds" : 15\n\`\`\`\n`;
      break;
    case 'journey':
      insertion = `\n\`\`\`mermaid\njourney\n    title My working day\n    section Go to work\n      Make tea: 5: Me\n      Go upstairs: 3: Me\n      Do work: 1: Me, Cat\n    section Go home\n      Go downstairs: 5: Me\n\`\`\`\n`;
      break;
  }

  textarea.value = text.substring(0, start) + insertion + text.substring(end);
  const cursorOffset = insertion.length;
  textarea.selectionStart = start + cursorOffset;
  textarea.selectionEnd = start + cursorOffset;
  textarea.focus();
  handleEditorInput();

  // Hide dropdown menu
  const menu = document.getElementById('dropdown-mermaid');
  if (menu) {
    menu.classList.remove('active');
    const chev = menu.closest('.editor-dropdown').querySelector('.chevron');
    if (chev) chev.style.transform = 'rotate(0deg)';
  }
}

// Headings outline and Backlinks rendering
function toggleRightDrawer() {
  const drawer = document.getElementById('right-drawer');
  drawer.classList.toggle('collapsed');
  const isOpen = !drawer.classList.contains('collapsed');
  const resizer = document.getElementById('drawer-resizer');
  if (resizer) resizer.style.display = isOpen ? 'block' : 'none';
  if (isOpen && drawerTab === 'outline') {
    updateOutlineAndBacklinks();
  }
  syncPaneToggleIcons();
}

// The drawer hosts two views — the note outline and the search results —
// switched by the segmented control in its header.
let drawerTab = localStorage.getItem('mdnb-drawer-tab') === 'search' ? 'search' : 'outline';

function setDrawerTab(name) {
  drawerTab = name === 'search' ? 'search' : 'outline';
  try { localStorage.setItem('mdnb-drawer-tab', drawerTab); } catch {}
  document.getElementById('drawer-tab-outline').classList.toggle('active', drawerTab === 'outline');
  document.getElementById('drawer-tab-search').classList.toggle('active', drawerTab === 'search');
  document.getElementById('drawer-outline-view').style.display = drawerTab === 'outline' ? 'block' : 'none';
  document.getElementById('drawer-search-view').style.display = drawerTab === 'search' ? 'block' : 'none';
  if (drawerTab === 'outline') updateOutlineAndBacklinks();
  syncPaneToggleIcons();
}

function openRightDrawer() {
  const drawer = document.getElementById('right-drawer');
  if (drawer.classList.contains('collapsed')) toggleRightDrawer();
}

// Toolbar icons: open the drawer straight onto a view. Clicking the icon of
// the view that's already showing closes the drawer (toggle behavior).
function openDrawerView(name) {
  const drawer = document.getElementById('right-drawer');
  const isOpen = !drawer.classList.contains('collapsed');
  if (isOpen && drawerTab === name) {
    toggleRightDrawer();
    return;
  }
  setDrawerTab(name);
  openRightDrawer();
  if (name === 'search') {
    setTimeout(() => {
      const input = document.getElementById('search-input');
      if (input) input.focus();
    }, 50);
  }
}

function updateOutlineAndBacklinks() {
  if (!activeNote) return;

  // 1. Generate Outline headings
  const outlineList = document.getElementById('outline-list');
  if (outlineList) {
    outlineList.innerHTML = '';
    
    const headingMatches = noteContent.matchAll(/^(#{1,3})[ \t]+(.*)$/gm);
    let count = 0;
    for (const m of headingMatches) {
      const level = m[1].length;
      const label = m[2].trim();
      
      const li = document.createElement('li');
      li.className = `outline-item outline-h${level}`;
      li.innerText = label;
      li.onclick = () => scrollToHeading(label);
      outlineList.appendChild(li);
      count++;
    }
    if (count === 0) {
      outlineList.innerHTML = '<li style="font-size:11px;color:var(--text-secondary);">No headings found</li>';
    }
  }

  // 2. Generate Backlinks list in Note Header
  const backlinksContainer = document.getElementById('note-meta-backlinks-container');
  const backlinksList = document.getElementById('note-meta-backlinks');
  
  if (backlinksList && backlinksContainer) {
    backlinksList.innerHTML = '';
    backlinksContainer.style.display = 'none';

    // 2a. Parse and add outgoing back-navigation TOC links from the active note itself
    try {
      const tocMatches = noteContent.matchAll(/\[\s*([^\]]+)\]\(([^)]*\.toc\.md)\)/gi);
      for (const m of tocMatches) {
        const rawLabel = m[1].trim();
        const targetPath = m[2].trim();
        
        const label = rawLabel.replace(/[-_]/g, ' ').trim();
        const resolvedPath = window.api.resolveRelativePath(activeNote, targetPath);
        
        const pill = document.createElement('span');
        pill.className = 'backlink-pill';
        pill.innerHTML = `
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:2px;"><polyline points="15 18 9 12 15 6"/></svg>
          ${label}
        `;
        pill.title = `Go back to: ${label}`;
        pill.onclick = (e) => {
          e.stopPropagation();
          if (resolvedPath.endsWith('.toc.md')) {
            const dirFsPath = pathDirname(resolvedPath);
            let dirRelPath = '';
            if (dirFsPath.startsWith(notebookRoot)) {
              dirRelPath = dirFsPath.slice(notebookRoot.length).replace(/^[/\\]+/, '').replace(/\\/g, '/');
            }
            if (dirRelPath === '') {
              openRootLanding();
            } else {
              openSection(dirRelPath, dirFsPath);
            }
          } else {
            openNote(resolvedPath);
          }
        };
        backlinksList.appendChild(pill);
        backlinksContainer.style.display = 'flex';
      }
    } catch (err) {
      console.error("Error loading TOC link:", err);
    }

    // 2b. Notebook-wide incoming backlinks: one IPC call, computed in the
    // main process. The request token guards against a race where a slower
    // response for a previously-open note lands after switching notes.
    if (!treeData) return;
    const requestedNote = activeNote;
    const token = ++backlinksRequestToken;

    window.api.getBacklinks(requestedNote).then(paths => {
      if (token !== backlinksRequestToken || activeNote !== requestedNote) return;

      paths.forEach(fsPath => {
        const page = findNodeByPath(treeData, fsPath);
        const title = page ? page.title : pathBasename(fsPath, '.md');
        const pill = document.createElement('span');
        pill.className = 'backlink-pill';
        pill.innerHTML = `
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:2px;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          ${escapeHtml(title)}
        `;
        pill.title = `Go to: ${title}`;
        pill.onclick = (e) => {
          e.stopPropagation();
          openNote(fsPath);
        };
        backlinksList.appendChild(pill);
        backlinksContainer.style.display = 'flex';
      });
    }).catch(err => {
      console.error('Error loading backlinks:', err);
    });
  }
}

let backlinksRequestToken = 0;

function scrollToHeading(label) {
  const preview = document.getElementById('preview-pane');
  // Look for heading element in rendered HTML
  const headingElements = Array.from(preview.querySelectorAll('h1, h2, h3'));
  const match = headingElements.find(el => el.textContent.trim() === label);
  if (match) {
    match.scrollIntoView({ behavior: 'smooth' });
  }
}

// Helpers for paths
function pathBasename(filepath, ext = '') {
  const parts = filepath.split(/[\\/]/);
  const name = parts[parts.length - 1];
  if (ext && name.endsWith(ext)) {
    return name.slice(0, -ext.length);
  }
  return name;
}

function escapeRegex(string) {
  return string.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Encode a value as a safe JS string expression for inline onclick handlers,
// so paths/titles containing quotes or backslashes can't break the markup.
function jsArg(value) {
  return `decodeURIComponent('${encodeURIComponent(String(value))}')`;
}

function expandFoldersToPath(pagePath) {
  if (!treeData || !pagePath) return;
  const parents = [];
  
  const findPageAndParents = (node, pathList = []) => {
    if (!node) return false;
    if (node.kind === 'page' && node.fsPath === pagePath) {
      parents.push(...pathList);
      return true;
    }
    if (node.kind === 'section') {
      const isRoot = node.relPath === '';
      const nextPathList = isRoot ? pathList : [...pathList, node.relPath];
      for (const p of node.pages) {
        if (p.fsPath === pagePath) {
          parents.push(...nextPathList);
          return true;
        }
      }
      for (const s of node.sections) {
        if (findPageAndParents(s, nextPathList)) {
          return true;
        }
      }
    }
    return false;
  };
  
  findPageAndParents(treeData);
  parents.forEach(p => expandedSections.add(p));
}

// Daily Note helper: creates YYYY-MM-DD.md note
async function openDailyNote() {
  if (!notebookRoot) return;
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dailyName = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  
  // Search for note in root directory
  const dailyFilename = `${dailyName}.md`;
  const existingPath = findPagePathByFilename(treeData, dailyFilename);
  
  if (existingPath) {
    await openNote(existingPath);
  } else {
    // Create new daily note at root
    const dailyPath = await window.api.createPage(notebookRoot, dailyName);
    await refreshNotebook();
    await openNote(dailyPath);
  }
}

// Settings modal handles
function showSettingsModal() {
  const modal = document.getElementById('settings-modal');
  document.getElementById('settings-page-width').value = appSettings.defaultPageWidth;
  document.getElementById('settings-mermaid-zoom').value = appSettings.defaultMermaidZoom;
  document.getElementById('settings-theme').value = appSettings.theme || 'system';
  document.getElementById('settings-templates-folder').value = appSettings.templatesFolder;
  document.getElementById('settings-author').value = appSettings.author;
  document.getElementById('settings-pandoc-path').value = appSettings.pandocPath || '';
  document.getElementById('settings-capture-shortcut').value = appSettings.quickCaptureShortcut || '';
  document.getElementById('settings-clipboard-shortcut').value = appSettings.clipboardCaptureShortcut || '';
  document.getElementById('settings-ignore-folders').value = appSettings.ignoreFolders.join(', ');
  document.getElementById('settings-autosave').checked = autoSaveEnabled;

  // Local AI (optional)
  const ai = appSettings.ai || { enabled: false, provider: 'ollama', baseUrl: '', model: '', autocomplete: false };
  document.getElementById('settings-ai-enabled').checked = !!ai.enabled;
  document.getElementById('settings-ai-provider').value = ai.provider || 'ollama';
  document.getElementById('settings-ai-url').value = ai.baseUrl || '';
  document.getElementById('settings-ai-model').value = ai.model || '';
  document.getElementById('settings-ai-autocomplete').checked = !!ai.autocomplete;
  document.getElementById('settings-ai-status').textContent = 'Test checks the server and lists the models it has installed.';
  document.getElementById('settings-spellcheck').checked = appSettings.spellcheckEnabled !== false;
  toggleAiSettingsFields();
  updateAiProviderPlaceholder();

  // Populate the clipboard-capture target dropdown with every note (relPath)
  const targetSelect = document.getElementById('settings-clipboard-target');
  const pages = treeData ? gatherPagesRecursively(treeData) : [];
  targetSelect.innerHTML = '<option value="">Today\'s daily note</option>' +
    pages.slice().sort((a, b) => a.relPath.localeCompare(b.relPath))
      .map(p => `<option value="${escapeHtml(p.relPath)}">${escapeHtml(p.relPath.replace(/\.md$/i, ''))}</option>`).join('');
  targetSelect.value = appSettings.clipboardCaptureTarget || '';
  if (targetSelect.selectedIndex === -1) targetSelect.value = '';

  modal.classList.add('active');
}

function hideSettingsModal() {
  document.getElementById('settings-modal').classList.remove('active');
}

async function saveSettingsForm() {
  const width = document.getElementById('settings-page-width').value;
  const zoom = parseInt(document.getElementById('settings-mermaid-zoom').value, 10) || 100;
  const theme = document.getElementById('settings-theme').value;
  const templates = document.getElementById('settings-templates-folder').value.trim() || 'templates';
  const author = document.getElementById('settings-author').value.trim();
  const pandocPath = document.getElementById('settings-pandoc-path').value.trim();
  const captureShortcut = document.getElementById('settings-capture-shortcut').value.trim();
  const clipboardShortcut = document.getElementById('settings-clipboard-shortcut').value.trim();
  const clipboardTarget = document.getElementById('settings-clipboard-target').value;
  const ignore = document.getElementById('settings-ignore-folders').value.split(',').map(s => s.trim()).filter(s => s);
  const autosave = document.getElementById('settings-autosave').checked;
  const ai = {
    enabled: document.getElementById('settings-ai-enabled').checked,
    provider: document.getElementById('settings-ai-provider').value,
    baseUrl: document.getElementById('settings-ai-url').value.trim(),
    model: document.getElementById('settings-ai-model').value.trim(),
    autocomplete: document.getElementById('settings-ai-autocomplete').checked,
  };
  const spellcheck = document.getElementById('settings-spellcheck').checked;

  appSettings = await window.api.saveSettings({
    defaultPageWidth: width,
    defaultMermaidZoom: zoom,
    theme: theme,
    templatesFolder: templates,
    author: author,
    pandocPath: pandocPath,
    quickCaptureShortcut: captureShortcut,
    clipboardCaptureShortcut: clipboardShortcut,
    clipboardCaptureTarget: clipboardTarget,
    scratchpadFile: appSettings.scratchpadFile,
    ignoreFolders: ignore,
    autoSaveEnabled: autosave,
    ai: ai,
    spellcheckEnabled: spellcheck,
  });

  applyTheme(theme);
  toggleAutoSave(autosave);
  applyEditorSpellcheck();
  hideSettingsModal();
  
  // Reload view styling width
  setViewMode(viewMode);
  await refreshNotebook();
}

// Local date string (YYYY-MM-DD) — avoids the UTC off-by-one near midnight
function localToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Read the optional metadata fields (date + tags) from the create modal
function collectModalMeta() {
  const created = document.getElementById('create-modal-date').value || localToday();
  const tags = document.getElementById('create-modal-tags').value
    .split(',')
    .map(t => t.trim().replace(/^#/, ''))
    .filter(t => t);
  return { created, tags };
}

function populateDestinationDropdown(destDir) {
  const select = document.getElementById('create-modal-dest');
  select.innerHTML = '';
  
  const rootOpt = document.createElement('option');
  rootOpt.value = notebookRoot;
  rootOpt.innerText = 'Notebook Root';
  select.appendChild(rootOpt);

  const addFolders = (node, depth = 0) => {
    if (!node || !node.sections) return;
    node.sections.forEach(sec => {
      const opt = document.createElement('option');
      opt.value = sec.fsPath;
      opt.innerText = ' '.repeat((depth + 1) * 2) + '↳ ' + sec.name;
      select.appendChild(opt);
      addFolders(sec, depth + 1);
    });
  };

  if (treeData) addFolders(treeData);
  
  select.value = destDir || notebookRoot;
}

// New note popup creation
async function promptCreatePage(destDir) {
  document.getElementById('create-modal-title').innerText = 'New Page';
  document.getElementById('create-modal-name-label').innerText = 'Page Title';
  document.getElementById('create-modal-name').value = '';
  document.getElementById('create-modal-name').placeholder = 'e.g. Q3 Migration Plan';

  document.getElementById('create-modal-dest-group').style.display = 'block';
  populateDestinationDropdown(destDir);
  document.getElementById('create-modal-type').value = 'page';
  document.getElementById('create-modal-page-options').style.display = 'block';
  document.getElementById('create-modal-section-options').style.display = 'none';
  document.getElementById('create-modal-links-group').style.display = 'block';
  document.getElementById('create-modal-template-group').style.display = 'block';
  document.getElementById('create-modal-date').value = localToday();
  document.getElementById('create-modal-tags').value = '';
  modalLinkState.create = [];
  renderLinkChips('create');
  populateLinkSelect('create', null);

  // Load Templates Select. The templates folder is excluded from the sidebar
  // tree (it's in ignoreFolders), so ask the main process for the real list.
  const select = document.getElementById('create-modal-template');
  select.innerHTML = '<option value="">Blank Page (No Template)</option>';
  try {
    const templates = await window.api.listTemplates();
    templates.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.innerText = t.title;
      select.appendChild(opt);
    });
  } catch (err) {
    console.error('Failed to list templates:', err);
  }

  document.getElementById('create-modal').classList.add('active');
  setTimeout(() => document.getElementById('create-modal-name').focus(), 100);
}

function promptCreateSection(destDir) {
  document.getElementById('create-modal-title').innerText = 'New Section';
  document.getElementById('create-modal-name-label').innerText = 'Section Name';
  document.getElementById('create-modal-name').value = '';

  document.getElementById('create-modal-dest-group').style.display = 'block';
  populateDestinationDropdown(destDir);
  document.getElementById('create-modal-type').value = 'section';
  document.getElementById('create-modal-page-options').style.display = 'none';
  document.getElementById('create-modal-section-options').style.display = 'block';
  document.getElementById('create-modal-section-desc').value = '';

  document.getElementById('create-modal').classList.add('active');
  setTimeout(() => document.getElementById('create-modal-name').focus(), 100);
}

function hideCreateModal() {
  document.getElementById('create-modal').classList.remove('active');
}

function handleCreateModalEnter(e) {
  if (e.key === 'Enter') {
    submitCreateModal();
  }
}

// --- Insert Hyperlink Modal -------------------------------------------------
// Remembers where the caret was so we can insert the link back into the editor
let linkModalSelection = null;

function openLinkModal() {
  const textarea = document.getElementById('note-editor');
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  linkModalSelection = { start, end };
  const selected = textarea.value.substring(start, end);

  // Reset fields; prefill display text with any current selection
  document.querySelector('input[name="link-kind"][value="web"]').checked = true;
  document.getElementById('link-modal-target').value = '';
  document.getElementById('link-modal-title').value = selected || '';
  document.getElementById('link-modal-hover').checked = false;
  document.getElementById('link-modal-hovertext').value = '';
  document.getElementById('link-modal-hover-group').style.display = 'none';
  updateLinkModalHint();

  document.getElementById('link-modal').classList.add('active');
  setTimeout(() => document.getElementById('link-modal-target').focus(), 100);
}

function hideLinkModal() {
  document.getElementById('link-modal').classList.remove('active');
}

function updateLinkModalHint() {
  const kind = document.querySelector('input[name="link-kind"]:checked').value;
  const label = document.getElementById('link-modal-target-label');
  const input = document.getElementById('link-modal-target');
  if (kind === 'file') {
    label.textContent = 'File Path';
    input.placeholder = 'e.g. /Users/me/docs/spec.pdf or ./notes/spec.md';
  } else {
    label.textContent = 'URL';
    input.placeholder = 'https://example.com';
  }
}

function toggleLinkHoverField() {
  const on = document.getElementById('link-modal-hover').checked;
  document.getElementById('link-modal-hover-group').style.display = on ? 'block' : 'none';
  if (on) setTimeout(() => document.getElementById('link-modal-hovertext').focus(), 50);
}

function handleLinkModalEnter(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitLinkModal();
  }
}

function submitLinkModal() {
  const kind = document.querySelector('input[name="link-kind"]:checked').value;
  let target = document.getElementById('link-modal-target').value.trim();
  const title = document.getElementById('link-modal-title').value.trim();
  const wantHover = document.getElementById('link-modal-hover').checked;
  const hoverText = document.getElementById('link-modal-hovertext').value.trim();

  if (!target) {
    showToast('Enter a URL or file path first');
    document.getElementById('link-modal-target').focus();
    return;
  }

  // Normalize the target based on link type
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target) || target.startsWith('mailto:');
  if (kind === 'web') {
    if (!hasScheme) target = 'https://' + target;
  } else {
    // File link: absolute paths get a file:// scheme; relative paths pass through
    if (!hasScheme) {
      if (target.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(target)) {
        target = 'file://' + (target[0] === '/' ? '' : '/') + target.replace(/\\/g, '/');
      }
    }
  }

  const display = title || target;
  const tooltip = wantHover ? (hoverText || display) : '';
  const markdown = tooltip
    ? `[${display}](${target} "${tooltip.replace(/"/g, '\\"')}")`
    : `[${display}](${target})`;

  const textarea = document.getElementById('note-editor');
  const sel = linkModalSelection || { start: textarea.selectionStart, end: textarea.selectionEnd };
  const text = textarea.value;
  textarea.value = text.substring(0, sel.start) + markdown + text.substring(sel.end);
  const caret = sel.start + markdown.length;
  textarea.selectionStart = caret;
  textarea.selectionEnd = caret;

  hideLinkModal();
  textarea.focus();
  handleEditorInput();
}

// --- Local AI (Ollama / LM Studio) ------------------------------------------
// All optional and off by default; every entry point checks appSettings.ai.

function toggleAiSettingsFields() {
  const on = document.getElementById('settings-ai-enabled').checked;
  document.getElementById('settings-ai-fields').style.display = on ? 'block' : 'none';
}

function updateAiProviderPlaceholder() {
  const provider = document.getElementById('settings-ai-provider').value;
  const urlInput = document.getElementById('settings-ai-url');
  const modelInput = document.getElementById('settings-ai-model');
  if (provider === 'lmstudio') {
    urlInput.placeholder = 'http://localhost:1234';
    modelInput.placeholder = 'e.g. the model id shown by Test';
  } else {
    urlInput.placeholder = 'http://localhost:11434';
    modelInput.placeholder = 'e.g. llama3.1:8b';
  }
}

async function testAiConnection() {
  const status = document.getElementById('settings-ai-status');
  status.textContent = 'Checking…';
  // Persist the in-form AI values first so main tests what the user typed,
  // not what was last saved. Only the ai key is sent — nothing else changes.
  const ai = {
    enabled: document.getElementById('settings-ai-enabled').checked,
    provider: document.getElementById('settings-ai-provider').value,
    baseUrl: document.getElementById('settings-ai-url').value.trim(),
    model: document.getElementById('settings-ai-model').value.trim(),
  };
  try {
    appSettings = await window.api.saveSettings({ ai });
    const result = await window.api.aiListModels();
    if (!result.ok) {
      status.textContent = result.error;
      return;
    }
    if (!result.models.length) {
      status.textContent = 'Connected, but no models are installed on the server yet.';
      return;
    }
    status.textContent = `Connected ✓ — available models: ${result.models.join(', ')}`;
    // Convenience: fill an empty model box with the first available model
    const modelInput = document.getElementById('settings-ai-model');
    if (!modelInput.value.trim()) modelInput.value = result.models[0];
  } catch (err) {
    status.textContent = 'Connection test failed: ' + err;
  }
}

// Split the app's custom header off the raw note so the model NEVER receives
// it: YAML frontmatter, plus the H1 title line and its "**Related:**" line
// when they directly follow. Re-attached verbatim on apply.
function splitNoteHeader(content) {
  let header = '';
  let rest = content;
  const fm = rest.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  if (fm) {
    header += fm[0];
    rest = rest.slice(fm[0].length);
  }
  const h1 = rest.match(/^(\s*)(# [^\n]*\n?)/);
  if (h1) {
    header += h1[0];
    rest = rest.slice(h1[0].length);
    const related = rest.match(/^(\s*)(\*\*Related:\*\*[^\n]*\n?)/);
    if (related) {
      header += related[0];
      rest = rest.slice(related[0].length);
    }
  }
  return { header, body: rest };
}

// The four AI actions share one modal; `mode` picks the prompt (in main),
// the copy, and what Apply does with the result.
const AI_MODES = {
  polish: {
    title: 'Polish with Local AI',
    intro: 'will clean up this note\'s formatting: heading levels, list styles, spacing, tables, and code fences. Wording is only lightly touched — the content stays yours.',
    resultLabel: 'Polished note',
    runLabel: 'Polish Note',
  },
  summarize: {
    title: 'Summarize into TL;DR',
    intro: 'will write a 1-3 sentence TL;DR of this note. Applying inserts it as a "> **TL;DR:**" callout at the top of the note body.',
    resultLabel: 'Summary',
    runLabel: 'Summarize',
  },
  tasks: {
    title: 'Extract Action Items',
    intro: 'will read the note and list the action items it implies. Applying appends them under an "## Action Items" heading as unchecked tasks.',
    resultLabel: 'Found action items',
    runLabel: 'Extract',
  },
  tags: {
    title: 'Suggest Tags',
    intro: 'will suggest 3-6 topic tags for this note. Applying merges them into the note\'s tags (existing tags are kept).',
    resultLabel: 'Suggested tags (comma-separated, edit freely)',
    runLabel: 'Suggest',
  },
};

let aiModalMode = 'polish';
let aiPolishPending = null; // { header } while a result is showing

function openAiPolishModal(mode) {
  if (!appSettings.ai || !appSettings.ai.enabled) {
    showToast('Local AI is off — enable it in Settings first.');
    showSettingsModal();
    return;
  }
  if (!activeNote) {
    showToast('Open a note first.');
    return;
  }
  aiModalMode = AI_MODES[mode] ? mode : 'polish';
  const cfg = AI_MODES[aiModalMode];
  aiPolishPending = null;
  document.getElementById('ai-polish-title').textContent = cfg.title;
  document.getElementById('ai-polish-intro-text').textContent = cfg.intro;
  document.getElementById('ai-polish-run-btn').textContent = cfg.runLabel;
  document.getElementById('ai-polish-result-label').innerHTML =
    `${escapeHtml(cfg.resultLabel)} <span class="item-desc">(editable — tweak before applying)</span>`;
  document.getElementById('ai-polish-model-label').textContent =
    appSettings.ai.model || '(no model set)';
  document.getElementById('ai-polish-intro').style.display = 'block';
  document.getElementById('ai-polish-running').style.display = 'none';
  document.getElementById('ai-polish-result').style.display = 'none';
  document.getElementById('ai-polish-error').style.display = 'none';
  document.getElementById('ai-polish-run-btn').style.display = '';
  document.getElementById('ai-polish-apply-btn').style.display = 'none';
  document.getElementById('ai-polish-modal').classList.add('active');
}

function hideAiPolishModal() {
  document.getElementById('ai-polish-modal').classList.remove('active');
  aiPolishPending = null;
}

async function runAiPolish() {
  const editor = document.getElementById('note-editor');
  const { header, body } = splitNoteHeader(editor.value);
  if (!body.trim()) {
    document.getElementById('ai-polish-error').textContent = 'This note has no body text to work with yet.';
    document.getElementById('ai-polish-error').style.display = 'block';
    return;
  }

  document.getElementById('ai-polish-intro').style.display = 'none';
  document.getElementById('ai-polish-error').style.display = 'none';
  document.getElementById('ai-polish-run-btn').style.display = 'none';
  document.getElementById('ai-polish-running').style.display = 'block';
  document.getElementById('ai-polish-running-label').textContent =
    `Asking ${appSettings.ai.model || 'the model'}…`;

  let result;
  try {
    result = await window.api.aiTransform(aiModalMode, body);
  } catch (err) {
    result = { ok: false, error: String(err) };
  }

  document.getElementById('ai-polish-running').style.display = 'none';
  if (!result || !result.ok) {
    document.getElementById('ai-polish-intro').style.display = 'block';
    document.getElementById('ai-polish-run-btn').style.display = '';
    const errEl = document.getElementById('ai-polish-error');
    errEl.textContent = (result && result.error) || 'The AI request failed.';
    errEl.style.display = 'block';
    return;
  }

  let text = result.text;
  if (aiModalMode === 'tasks' && text.trim() === 'NONE') {
    document.getElementById('ai-polish-intro').style.display = 'block';
    document.getElementById('ai-polish-run-btn').style.display = '';
    const errEl = document.getElementById('ai-polish-error');
    errEl.textContent = 'The model found no new action items in this note.';
    errEl.style.display = 'block';
    return;
  }
  if (aiModalMode === 'tags') {
    // Normalize whatever came back into a clean comma-separated line
    text = text.split(/[,\n]/).map(t => t.trim().replace(/^#/, '').toLowerCase())
      .filter(t => t && /^[a-z0-9][a-z0-9-]*$/.test(t)).join(', ');
    if (!text) {
      document.getElementById('ai-polish-intro').style.display = 'block';
      document.getElementById('ai-polish-run-btn').style.display = '';
      const errEl = document.getElementById('ai-polish-error');
      errEl.textContent = 'The model returned no usable tags — try again.';
      errEl.style.display = 'block';
      return;
    }
  }

  aiPolishPending = { header };
  document.getElementById('ai-polish-output').value = text;
  document.getElementById('ai-polish-result').style.display = 'block';
  document.getElementById('ai-polish-apply-btn').style.display = '';
}

function applyAiPolish() {
  if (!aiPolishPending) return;
  const editor = document.getElementById('note-editor');
  const output = document.getElementById('ai-polish-output').value;
  const header = aiPolishPending.header;

  if (aiModalMode === 'summarize') {
    // TL;DR callout at the top of the body, header untouched
    const { header: h, body } = splitNoteHeader(editor.value);
    const tldr = `> **TL;DR:** ${output.trim().replace(/\n+/g, ' ')}\n\n`;
    editor.value = h + (h && !h.endsWith('\n') ? '\n' : '') + (h ? '\n' : '') + tldr + body.replace(/^\n+/, '');
  } else if (aiModalMode === 'tasks') {
    // Append as unchecked tasks under an Action Items heading
    const lines = output.split('\n').map(l => l.trim()).filter(l => l)
      .map(l => /^[-*+]\s*\[[ xX]\]/.test(l) ? l.replace(/^[*+]/, '-') : `- [ ] ${l.replace(/^[-*+]\s*/, '')}`);
    const hasHeading = /^##\s+Action Items\s*$/mi.test(editor.value);
    const block = (hasHeading ? '' : '\n## Action Items\n') + '\n' + lines.join('\n') + '\n';
    editor.value = editor.value.replace(/\s*$/, '\n') + block;
  } else if (aiModalMode === 'tags') {
    applyAiTags(editor, output);
  } else {
    // polish: replace the body, reattach the untouched header
    let glue = '';
    if (header) {
      if (!header.endsWith('\n')) glue += '\n';
      if (!output.startsWith('\n')) glue += '\n';
    }
    editor.value = header + glue + output;
  }

  hideAiPolishModal();
  editor.focus();
  handleEditorInput();
  showToast('Applied — review, then save.');
}

// Merge suggested tags into the frontmatter's tags line, editing only the
// editor buffer (nothing touches disk until the user saves).
function applyAiTags(editor, tagLine) {
  const suggested = tagLine.split(',').map(t => t.trim()).filter(t => t);
  if (!suggested.length) return;
  let value = editor.value;
  const fm = value.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const tagsRe = /^tags:\s*(?:\[([^\]]*)\]|(.*))\s*$/m;
    const m = fm[1].match(tagsRe);
    const existing = m ? (m[1] !== undefined ? m[1] : m[2] || '').split(',').map(t => t.trim()).filter(t => t) : [];
    const merged = [...existing];
    suggested.forEach(t => { if (!merged.some(e => e.toLowerCase() === t.toLowerCase())) merged.push(t); });
    const newLine = `tags: [${merged.join(', ')}]`;
    let newFm;
    if (m) {
      newFm = fm[1].replace(tagsRe, newLine);
    } else {
      newFm = fm[1] + (fm[1].endsWith('\n') || fm[1] === '' ? '' : '\n') + newLine;
    }
    value = value.slice(0, fm.index) + fm[0].replace(fm[1], newFm) + value.slice(fm.index + fm[0].length);
  } else {
    // No frontmatter yet: create a minimal one carrying the tags
    value = `---\ntags: [${suggested.join(', ')}]\n---\n\n` + value;
  }
  editor.value = value;
}

// --- AI smart autocomplete (ghost suggestion at the caret) ------------------
// Debounced: fires only after a pause, only at the end of a line, and only
// while both ai.enabled and ai.autocomplete are on. Tab accepts, Esc or any
// edit dismisses. Failures are silent — this must never interrupt typing.
let aiGhost = { open: false, text: '', pos: -1, timer: null, reqToken: 0 };

function aiGhostEnabled() {
  return !!(appSettings && appSettings.ai && appSettings.ai.enabled &&
    appSettings.ai.autocomplete && activeNote && (viewMode === 'edit' || viewMode === 'split'));
}

function scheduleAiGhost() {
  if (aiGhost.timer) { clearTimeout(aiGhost.timer); aiGhost.timer = null; }
  hideAiGhost();
  if (!aiGhostEnabled()) return;
  const delay = window.__aiGhostDebounce || 1200;
  aiGhost.timer = setTimeout(requestAiGhost, delay);
}

async function requestAiGhost() {
  const textarea = document.getElementById('note-editor');
  if (!textarea || document.activeElement !== textarea || wikiAC.open) return;
  const pos = textarea.selectionStart;
  if (pos !== textarea.selectionEnd) return;
  // Only complete at the end of a line — mid-word ghosts are noise
  const nextCh = textarea.value.charAt(pos);
  if (nextCh && nextCh !== '\n') return;
  const context = textarea.value.slice(Math.max(0, pos - 2000), pos);
  if (!context.trim()) return;

  const token = ++aiGhost.reqToken;
  let result;
  try {
    result = await window.api.aiComplete(context);
  } catch {
    return;
  }
  // Stale or superseded: the user typed while we waited
  if (token !== aiGhost.reqToken || !result || !result.ok) return;
  if (document.activeElement !== textarea || textarea.selectionStart !== pos) return;

  const suggestion = String(result.text || '').replace(/^\n+/, '');
  if (!suggestion.trim()) return;
  aiGhost.open = true;
  aiGhost.text = suggestion;
  aiGhost.pos = pos;
  renderAiGhost(textarea, suggestion);
}

function renderAiGhost(textarea, suggestion) {
  let ghost = document.getElementById('ai-ghost');
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.id = 'ai-ghost';
    document.body.appendChild(ghost);
  }
  const shown = suggestion.length > 160 ? suggestion.slice(0, 160) + '…' : suggestion;
  ghost.textContent = shown;
  const hint = document.createElement('span');
  hint.className = 'ai-ghost-hint';
  hint.textContent = 'Tab';
  ghost.appendChild(hint);
  ghost.style.display = 'block';
  const caret = editorCaretRect(textarea, textarea.selectionStart);
  const maxLeft = window.innerWidth - 440;
  const belowTop = caret.y + caret.lineHeight + 2;
  const flipUp = belowTop + ghost.offsetHeight > window.innerHeight - 8;
  ghost.style.left = `${Math.max(8, Math.min(caret.x, maxLeft))}px`;
  ghost.style.top = `${flipUp ? Math.max(8, caret.y - ghost.offsetHeight - 2) : belowTop}px`;
}

function hideAiGhost() {
  if (!aiGhost.open) return;
  aiGhost.open = false;
  aiGhost.text = '';
  const ghost = document.getElementById('ai-ghost');
  if (ghost) ghost.style.display = 'none';
}

function acceptAiGhost() {
  if (!aiGhost.open) return false;
  const textarea = document.getElementById('note-editor');
  if (!textarea || textarea.selectionStart !== aiGhost.pos) { hideAiGhost(); return false; }
  const text = aiGhost.text;
  hideAiGhost();
  replaceEditorRange(textarea, aiGhost.pos, aiGhost.pos, text);
  return true;
}

// Editor spell-check squiggles follow the settings toggle
function applyEditorSpellcheck() {
  const textarea = document.getElementById('note-editor');
  if (!textarea) return;
  const on = !appSettings || appSettings.spellcheckEnabled !== false;
  textarea.spellcheck = on;
  // Chromium only re-evaluates squiggles on focus/edit; nudge it
  if (document.activeElement === textarea) { textarea.blur(); textarea.focus(); }
}

// --- FIND & REPLACE (within the open note) -----------------------------------
let findMatches = [];
let findIndex = -1;

function findBarVisible() {
  const bar = document.getElementById('find-replace-bar');
  return !!bar && bar.style.display !== 'none';
}

function showFindBar() {
  if (!activeNote) return;
  if (viewMode === 'preview') setViewMode('edit'); // the bar lives on the editor pane
  document.getElementById('find-replace-bar').style.display = 'flex';
  const input = document.getElementById('find-input');
  const ta = document.getElementById('note-editor');
  const sel = ta.value.substring(ta.selectionStart, ta.selectionEnd);
  if (sel && !sel.includes('\n')) input.value = sel;
  input.focus();
  input.select();
  updateFindMatches();
}

function hideFindBar() {
  document.getElementById('find-replace-bar').style.display = 'none';
  findMatches = [];
  findIndex = -1;
  const ta = document.getElementById('note-editor');
  if (ta) ta.focus();
}

function updateFindMatches() {
  const q = document.getElementById('find-input').value;
  const caseSensitive = document.getElementById('find-case').checked;
  const ta = document.getElementById('note-editor');
  findMatches = [];
  findIndex = -1;
  if (q && ta) {
    const hay = caseSensitive ? ta.value : ta.value.toLowerCase();
    const needle = caseSensitive ? q : q.toLowerCase();
    let i = 0;
    while ((i = hay.indexOf(needle, i)) !== -1 && findMatches.length < 5000) {
      findMatches.push(i);
      i += needle.length || 1;
    }
  }
  updateFindCount();
}

function updateFindCount() {
  document.getElementById('find-count').textContent =
    findMatches.length ? `${findIndex + 1 > 0 ? findIndex + 1 : '–'}/${findMatches.length}` : '0/0';
}

function findNext(dir) {
  const q = document.getElementById('find-input').value;
  if (!q || !findMatches.length) return;
  const ta = document.getElementById('note-editor');
  let idx;
  if (dir > 0) {
    const from = ta.selectionEnd;
    idx = findMatches.findIndex(m => m >= from);
    if (idx === -1) idx = 0; // wrap to top
  } else {
    const from = ta.selectionStart;
    idx = -1;
    for (let i = findMatches.length - 1; i >= 0; i--) {
      if (findMatches[i] < from) { idx = i; break; }
    }
    if (idx === -1) idx = findMatches.length - 1; // wrap to bottom
  }
  findIndex = idx;
  const m = findMatches[idx];
  ta.setSelectionRange(m, m + q.length);
  scrollEditorCaretIntoView(ta);
  updateFindCount();
}

function replaceCurrent() {
  const q = document.getElementById('find-input').value;
  if (!q) return;
  const ta = document.getElementById('note-editor');
  const caseSensitive = document.getElementById('find-case').checked;
  const selected = ta.value.substring(ta.selectionStart, ta.selectionEnd);
  const onMatch = caseSensitive ? selected === q : selected.toLowerCase() === q.toLowerCase();
  if (!onMatch) { findNext(1); return; } // first press selects, second replaces
  const r = document.getElementById('replace-input').value;
  replaceEditorRange(ta, ta.selectionStart, ta.selectionEnd, r);
  updateFindMatches();
  findNext(1);
}

function replaceAllMatches() {
  const q = document.getElementById('find-input').value;
  if (!q) return;
  updateFindMatches();
  const n = findMatches.length;
  if (!n) { showToast('No matches to replace.'); return; }
  const r = document.getElementById('replace-input').value;
  const ta = document.getElementById('note-editor');
  const caseSensitive = document.getElementById('find-case').checked;
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc, caseSensitive ? 'g' : 'gi');
  ta.value = ta.value.replace(re, () => r);
  handleEditorInput();
  updateFindMatches();
  showToast(`Replaced ${n} occurrence${n === 1 ? '' : 's'}.`);
}

function handleFindInputKeys(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    findNext(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideFindBar();
  }
}

// --- TASK BOARD (kanban over every open checkbox in the notebook) -----------
function showTaskBoardModal() {
  buildTaskBoard();
  document.getElementById('taskboard-modal').classList.add('active');
}

function hideTaskBoardModal() {
  document.getElementById('taskboard-modal').classList.remove('active');
}

function buildTaskBoard() {
  const container = document.getElementById('taskboard-columns');
  if (!treeData) {
    container.innerHTML = '<div class="taskboard-empty">No notebook loaded yet.</div>';
    return;
  }
  // One column per top-level section (plus loose root pages), cards = open tasks
  const groups = [];
  if ((treeData.pages || []).length) groups.push({ name: 'Notebook Root', pages: treeData.pages });
  (treeData.sections || []).forEach(sec => groups.push({ name: sec.name, pages: gatherPagesRecursively(sec) }));

  let html = '';
  groups.forEach(g => {
    const cards = [];
    g.pages.forEach(p => (p.taskLines || []).forEach(t =>
      cards.push({ fsPath: p.fsPath, title: p.title, text: t.text, line: t.line })));
    if (!cards.length) return;
    html += `<div class="taskboard-column">
      <div class="taskboard-column-title">${escapeHtml(g.name)} <span class="taskboard-count">${cards.length}</span></div>` +
      cards.map(c => `
        <div class="taskboard-card-item" data-fspath="${escapeHtml(c.fsPath)}" data-line="${c.line}" onclick="taskBoardOpenNote(this)">
          <input type="checkbox" onclick="event.stopPropagation()" onchange="taskBoardToggle(this)">
          <div>
            <span class="taskboard-task-text">${escapeHtml(c.text)}</span>
            <span class="taskboard-task-note">${escapeHtml(c.title)}</span>
          </div>
        </div>`).join('') +
      '</div>';
  });
  container.innerHTML = html || '<div class="taskboard-empty">No open tasks anywhere — nice work! 🎉</div>';
}

async function taskBoardToggle(checkbox) {
  const card = checkbox.closest('.taskboard-card-item');
  const fsPath = card.dataset.fspath;
  const line = parseInt(card.dataset.line, 10);
  const ok = await window.api.toggleTaskAtLine(fsPath, line);
  if (!ok) {
    checkbox.checked = false;
    showToast('Could not toggle the task.', 'error');
    return;
  }
  card.classList.add('done');
  // Keep the open editor in sync if it shows the same note
  if (activeNote === fsPath) {
    const fresh = await window.api.readNote(fsPath);
    noteContent = fresh;
    noteOriginalContent = fresh;
    document.getElementById('note-editor').value = fresh;
    renderActiveNote();
  }
}

function taskBoardOpenNote(card) {
  hideTaskBoardModal();
  openNote(card.dataset.fspath);
}

// --- IMAGE LIGHTBOX ----------------------------------------------------------
function wirePreviewImages(preview) {
  preview.querySelectorAll('img').forEach(img => {
    if (img.closest('a')) return; // linked images keep their link behavior
    img.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showImageLightbox(img);
    });
  });
}

function showImageLightbox(img) {
  document.getElementById('image-lightbox-img').src = img.src;
  const fig = img.closest('figure');
  const figcap = fig ? fig.querySelector('figcaption') : null;
  document.getElementById('image-lightbox-caption').textContent =
    (figcap && figcap.textContent) || img.title || '';
  document.getElementById('image-lightbox').classList.add('active');
}

function hideImageLightbox() {
  document.getElementById('image-lightbox').classList.remove('active');
  document.getElementById('image-lightbox-img').src = '';
}

// Manual update check from the palette; auto-checks also run on launch.
async function checkForUpdates() {
  if (!window.api.checkForUpdates) return;
  showToast('Checking for updates…');
  let result;
  try { result = await window.api.checkForUpdates(); } catch { result = { status: 'error' }; }
  const messages = {
    dev: 'Update checks only run in the installed app.',
    portable: 'The portable version doesn\'t self-update — download the latest from the Releases page.',
    unavailable: 'Update service is unavailable right now.',
    current: 'You\'re on the latest version.',
    available: `Update to ${result && result.version} is downloading — you'll be prompted to restart when it's ready.`,
    error: (result && result.reason) || 'Could not check for updates.',
  };
  showToast(messages[result ? result.status : 'error'] || 'Update check finished.',
    result && result.status === 'error' ? 'error' : 'success');
}

// Prompt the user to fill a template's custom {{variables}}. Resolves to a
// { name: value } map, or null if cancelled. Prettifies field labels
// (project_lead -> "Project Lead").
let templateVarsResolver = null;
function promptTemplateVariables(varNames) {
  return new Promise((resolve) => {
    templateVarsResolver = resolve;
    const body = document.getElementById('template-vars-body');
    body.innerHTML = varNames.map((v, i) => {
      const label = v.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      return `<div class="form-group">
        <label>${escapeHtml(label)}</label>
        <input type="text" class="template-var-input" data-var="${escapeHtml(v)}"
          ${i === 0 ? '' : ''} placeholder="${escapeHtml('{{' + v + '}}')}"
          onkeydown="if (event.key === 'Enter') submitTemplateVars()">
      </div>`;
    }).join('');
    document.getElementById('template-vars-modal').classList.add('active');
    setTimeout(() => {
      const first = body.querySelector('.template-var-input');
      if (first) first.focus();
    }, 100);
  });
}

function submitTemplateVars() {
  const vars = {};
  document.querySelectorAll('#template-vars-body .template-var-input').forEach(inp => {
    vars[inp.dataset.var] = inp.value;
  });
  document.getElementById('template-vars-modal').classList.remove('active');
  const resolve = templateVarsResolver;
  templateVarsResolver = null;
  if (resolve) resolve(vars);
}

function cancelTemplateVars() {
  document.getElementById('template-vars-modal').classList.remove('active');
  const resolve = templateVarsResolver;
  templateVarsResolver = null;
  if (resolve) resolve(null);
}

async function submitCreateModal() {
  const type = document.getElementById('create-modal-type').value;
  const name = document.getElementById('create-modal-name').value.trim();
  const dest = type === 'rename' 
    ? document.getElementById('create-modal-rename-path').value 
    : document.getElementById('create-modal-dest').value;

  // The paste-import can auto-detect a title from content, so a blank name is allowed there
  if (!name && type !== 'import-clip') return;

  if (type === 'page') {
    const template = document.getElementById('create-modal-template').value;
    // If the template has custom {{fields}}, prompt for them first
    let customVars;
    if (template) {
      let vars = [];
      try { vars = await window.api.getTemplateVariables(template); } catch {}
      if (vars.length) {
        customVars = await promptTemplateVariables(vars);
        if (customVars === null) return; // user cancelled — keep the create modal open
      }
    }
    const newPath = await window.api.createPage(dest, name, template, collectModalMeta(), customVars);
    if (modalLinkState.create.length && newPath) {
      const content = await window.api.readNote(newPath);
      await window.api.writeNote(newPath, upsertRelatedLine(content, modalLinkState.create));
    }
    hideCreateModal();
    await refreshNotebook();
    await openNote(newPath);
  } else if (type === 'template') {
    const newPath = await window.api.createTemplate(name);
    hideCreateModal();
    if (newPath) {
      await openNote(newPath);
      setViewMode('edit');
    }
  } else if (type === 'import-clip') {
    const meta = collectModalMeta();
    hideCreateModal();
    const result = await window.api.importClipboard(dest, { title: name, ...meta });
    if (result.success) {
      await refreshNotebook();
      await openNote(result.filePath);
    } else {
      alert(result.reason || 'Clipboard import failed.');
    }
  } else if (type === 'rename') {
    // dest holds the fsPath of the node being renamed. For section folders,
    // save the description FIRST — .section.json lives inside the folder,
    // so it travels along with the rename.
    if (!dest.endsWith('.md')) {
      await window.api.setSectionMeta(dest, document.getElementById('create-modal-section-desc').value.trim());
    }
    const success = await window.api.renameNode(dest, name);
    hideCreateModal();
    if (success) {
      if (activeNote === dest) {
        // Path may have changed on disk; close so refresh doesn't point at a stale file
        closeNoteCanvas();
      }
      await refreshNotebook();
    }
  } else {
    // Section Folder create
    const reason = invalidFolderNameReason(name);
    if (reason) {
      alert(reason);
      return;
    }
    await window.api.createSection(dest, name, document.getElementById('create-modal-section-desc').value.trim());
    hideCreateModal();
    await refreshNotebook();
  }
}

// Rename nodes dialog (window.prompt is not supported in Electron,
// so this reuses the create modal in "rename" mode)
function findSectionByFsPath(node, fsPath) {
  if (!node) return null;
  if (node.kind === 'section' && node.fsPath === fsPath) return node;
  for (const s of (node.sections || [])) {
    const hit = findSectionByFsPath(s, fsPath);
    if (hit) return hit;
  }
  return null;
}

function promptRenameNode(fsPath, currentName) {
  const isSection = !fsPath.endsWith('.md');
  document.getElementById('create-modal-title').innerText = isSection ? 'Edit Section' : 'Rename';
  document.getElementById('create-modal-name-label').innerText = 'New Name';
  document.getElementById('create-modal-name').value = currentName || '';

  document.getElementById('create-modal-dest-group').style.display = 'none';
  document.getElementById('create-modal-rename-path').value = fsPath;

  document.getElementById('create-modal-type').value = 'rename';
  document.getElementById('create-modal-page-options').style.display = 'none';
  // Section folders also get their description edited here
  document.getElementById('create-modal-section-options').style.display = isSection ? 'block' : 'none';
  if (isSection) {
    const sectionNode = findSectionByFsPath(treeData, fsPath);
    document.getElementById('create-modal-section-desc').value = (sectionNode && sectionNode.description) || '';
  }

  document.getElementById('create-modal').classList.add('active');
  setTimeout(() => {
    const input = document.getElementById('create-modal-name');
    input.focus();
    input.select();
  }, 100);
}

async function promptRenameCurrent() {
  if (!activeNote) return;
  await showPageInfoModal(activeNote);
}

// ==========================================
// RELATED-PAGE LINKS (a managed "**Related:**" wiki-link line under the H1;
// linking page A -> B is what makes A appear in B's header backlinks)
// ==========================================

const modalLinkState = { create: [], 'page-info': [] };

function linkIdsFor(which) {
  const prefix = which === 'create' ? 'create-modal' : 'page-info';
  return { select: `${prefix}-links-select`, list: `${prefix}-links-list` };
}

// Wiki-links resolve by FILENAME (minus .md), so that's the stored value;
// the dropdown shows the human title with the path for disambiguation.
function populateLinkSelect(which, excludeFsPath) {
  const select = document.getElementById(linkIdsFor(which).select);
  if (!select || !treeData) return;
  const pages = gatherPagesRecursively(treeData)
    .filter(p => p.fsPath !== excludeFsPath)
    .sort((a, b) => a.title.localeCompare(b.title));
  select.innerHTML = pages.map(p => {
    const target = p.name.replace(/\.md$/i, '');
    const label = p.title === target ? p.title : `${p.title} (${target})`;
    return `<option value="${escapeHtml(target)}">${escapeHtml(label)}</option>`;
  }).join('');
}

function renderLinkChips(which) {
  const list = document.getElementById(linkIdsFor(which).list);
  if (!list) return;
  list.innerHTML = modalLinkState[which].map(name => `
    <span class="link-chip">[[${escapeHtml(name)}]]
      <button type="button" onclick="removeModalLink(${jsArg(which)}, ${jsArg(name)})" title="Remove link">&times;</button>
    </span>
  `).join('');
}

function addModalLink(which) {
  const select = document.getElementById(linkIdsFor(which).select);
  const name = select && select.value;
  if (!name) return;
  if (!modalLinkState[which].includes(name)) {
    modalLinkState[which].push(name);
    renderLinkChips(which);
  }
}

function removeModalLink(which, name) {
  modalLinkState[which] = modalLinkState[which].filter(n => n !== name);
  renderLinkChips(which);
}

// Read the targets out of an existing **Related:** line (aliases allowed)
function parseRelatedLinks(content) {
  const m = content.match(/^\*\*Related:\*\*(.*)$/m);
  if (!m) return [];
  const names = [];
  const re = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
  let link;
  while ((link = re.exec(m[1])) !== null) {
    names.push(link[1].trim().replace(/\.md$/i, ''));
  }
  return names;
}

// Rewrite (or insert after the H1 / frontmatter) the managed Related line.
// Only this one line is ever touched — wiki-links the user wrote elsewhere
// in the note are never modified.
function upsertRelatedLine(content, names) {
  const line = names.length ? `**Related:** ${names.map(n => `[[${n}]]`).join(' · ')}` : null;
  const lines = content.split('\n');
  const idx = lines.findIndex(l => /^\*\*Related:\*\*/.test(l));
  if (idx !== -1) {
    if (line) {
      lines[idx] = line;
    } else {
      lines.splice(idx, 1);
      if (lines[idx] !== undefined && lines[idx].trim() === '' && (lines[idx - 1] || '').trim() === '') {
        lines.splice(idx, 1); // collapse the doubled blank the removal left
      }
    }
    return lines.join('\n');
  }
  if (!line) return content;
  let insertAt = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end !== -1) insertAt = end + 1;
  }
  for (let i = insertAt; i < lines.length; i++) {
    if (/^#\s/.test(lines[i])) { insertAt = i + 1; break; }
  }
  lines.splice(insertAt, 0, '', line);
  return lines.join('\n');
}

// ==========================================
// PAGE INFO EDITOR (title + frontmatter)
// ==========================================

async function showPageInfoModal(fsPath) {
  // Templates are plain bodies without frontmatter; adding metadata to them
  // would leak into every page created from them, so just rename those.
  if (isTemplatePath(fsPath)) {
    const currentTitle = pathBasename(fsPath, '.md');
    promptRenameNode(fsPath, currentTitle);
    return;
  }

  // Flush pending edits so the metadata rewrite doesn't clobber them
  if (activeNote && noteContent !== noteOriginalContent) {
    await saveActiveNote();
  }

  const node = findNodeByPath(treeData, fsPath);
  document.getElementById('page-info-path').value = fsPath;
  document.getElementById('page-info-title').value = node ? node.title : pathBasename(fsPath, '.md');
  document.getElementById('page-info-date').value =
    node && /^\d{4}-\d{2}-\d{2}$/.test(node.created) ? node.created : '';
  document.getElementById('page-info-tags').value = node ? node.tags.join(', ') : '';
  document.getElementById('page-info-pinned').checked = !!(node && node.pinned);

  // Related links: prefill from the note's managed **Related:** line
  const content = await window.api.readNote(fsPath);
  modalLinkState['page-info'] = parseRelatedLinks(content);
  populateLinkSelect('page-info', fsPath);
  renderLinkChips('page-info');

  document.getElementById('page-info-modal').classList.add('active');
  setTimeout(() => document.getElementById('page-info-title').focus(), 100);
}

function hidePageInfoModal() {
  document.getElementById('page-info-modal').classList.remove('active');
}

async function savePageInfo() {
  const fsPath = document.getElementById('page-info-path').value;
  const title = document.getElementById('page-info-title').value.trim();
  const created = document.getElementById('page-info-date').value;
  const tags = document.getElementById('page-info-tags').value
    .split(',')
    .map(t => t.trim().replace(/^#/, ''))
    .filter(t => t);
  const pinned = document.getElementById('page-info-pinned').checked;

  if (!title) {
    alert('Title cannot be empty.');
    return;
  }

  const node = findNodeByPath(treeData, fsPath);
  const oldTitle = node ? node.title : '';
  hidePageInfoModal();

  await window.api.updateNoteMeta(fsPath, { created, tags, pinned });

  // Related links: rewrite the managed line BEFORE any rename (renaming can
  // change the file's path on disk)
  const currentContent = await window.api.readNote(fsPath);
  const withLinks = upsertRelatedLine(currentContent, modalLinkState['page-info']);
  if (withLinks !== currentContent) {
    await window.api.writeNote(fsPath, withLinks);
  }

  if (title !== oldTitle) {
    // renameNode also updates the H1, wiki-links, and possibly the filename
    await window.api.renameNode(fsPath, title);
    if (activeNote === fsPath) {
      // The path may have changed on disk; close so refresh doesn't point at a stale file
      closeNoteCanvas();
    }
  } else if (activeNote === fsPath) {
    noteContent = await window.api.readNote(fsPath);
    noteOriginalContent = noteContent;
  }

  await refreshNotebook();
  if (activeNote === fsPath) {
    renderActiveNote();
  }
}

// Delete note node dialog (soft delete: items go to the notebook trash)
async function deleteNode(fsPath) {
  const isDir = fsPath && !fsPath.endsWith('.md');
  const confirmMsg = isDir
    ? 'Move this section folder and everything inside it to the Trash?'
    : 'Move this note page to the Trash?';

  if (confirm(confirmMsg)) {
    const success = await window.api.deleteNode(fsPath);
    if (success) {
      if (activeNote === fsPath) {
        closeNoteCanvas();
      }
      await refreshNotebook();
      showToast('Moved to Trash — restore it any time from File Actions → Trash.');
    }
  }
}

// Reordering pages inside sections
async function moveNode(dirPath, fileName, direction) {
  const success = await window.api.moveNode(dirPath, fileName, direction);
  if (success) {
    await refreshNotebook();
  }
}

// Validate folder name (matches rules)
function invalidFolderNameReason(name) {
  const v = name.trim();
  if (!v) return 'Name is empty.';
  if (/[\\/:*?"<>|]/.test(v)) return 'Name contains invalid characters.';
  if (v === '.' || v === '..') return 'Name cannot be "." or "..".';
  if (/[. ]$/.test(v)) return 'Name cannot end with a dot or space.';
  return null;
}

// Imports: paste-import goes through the same new-note onboarding modal
// so the user can set title/date/tags before the note is created.
function importFromClipboard() {
  const dest = activeNote ? pathDirname(activeNote) : notebookRoot;

  document.getElementById('create-modal-title').innerText = 'Paste Note from Clipboard';
  document.getElementById('create-modal-name-label').innerText = 'Note Title (leave blank to auto-detect from content)';
  document.getElementById('create-modal-name').value = '';
  document.getElementById('create-modal-name').placeholder = 'Auto-detect from pasted content';
  
  document.getElementById('create-modal-dest-group').style.display = 'block';
  populateDestinationDropdown(dest);
  
  document.getElementById('create-modal-type').value = 'import-clip';
  document.getElementById('create-modal-page-options').style.display = 'block';
  document.getElementById('create-modal-section-options').style.display = 'none';
  document.getElementById('create-modal-links-group').style.display = 'none'; // links don't apply to imports
  document.getElementById('create-modal-template-group').style.display = 'none'; // templates don't apply to imports
  document.getElementById('create-modal-date').value = localToday();
  document.getElementById('create-modal-tags').value = 'imported';

  document.getElementById('create-modal').classList.add('active');
  setTimeout(() => document.getElementById('create-modal-name').focus(), 100);
}

async function importDocFile() {
  const dest = activeNote ? pathDirname(activeNote) : notebookRoot;
  const result = await window.api.importDocument(dest);
  if (result) {
    if (result.success) {
      await refreshNotebook();
      await openNote(result.filePath);
      alert('Document converted and imported successfully!');
    } else {
      alert(result.reason || 'Document import failed.');
    }
  }
}

function pathDirname(filepath) {
  const parts = filepath.split(/[\\/]/);
  return parts.slice(0, -1).join('/');
}

// True when a file lives inside the configured templates folder
function isTemplatePath(fsPath) {
  if (!fsPath || !notebookRoot || !appSettings) return false;
  const folder = appSettings.templatesFolder || 'templates';
  const normalize = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const templatesDir = /^([a-zA-Z]:)?\//.test(folder.replace(/\\/g, '/'))
    ? normalize(folder)
    : normalize(notebookRoot) + '/' + normalize(folder);
  return normalize(fsPath).toLowerCase().startsWith(templatesDir.toLowerCase() + '/');
}

// ==========================================
// PDF EXPORT (options dialog + sanitized snapshot)
// ==========================================

// Sanitize a copy of the rendered note for print: strip interactive UI and
// reset Mermaid SVG sizing. On screen the SVGs are stretched to 100% width,
// which in print blows tall diagrams up over multiple pages and produces
// blank pages around them; exporting at natural (viewBox) size fixes that.
// Shared export sanitizer: strips interactive UI chrome and clamps mermaid
// SVG sizing for print. Used by single-note PDF, batch PDF, HTML export and
// copy-as-rich-text so the strip list can never drift between them.
function sanitizeExportDom(root) {
  root.querySelectorAll('.mermaid-actions-bar, .code-block-copy-btn').forEach(el => el.remove());
  root.querySelectorAll('.notebook-mermaid').forEach(pre => {
    const svg = pre.querySelector('svg');
    if (svg) {
      const viewBox = svg.viewBox && svg.viewBox.baseVal;
      const naturalWidth = (viewBox && viewBox.width) ? viewBox.width : 0;
      // ~660px is the printable width of an A4 page at 96dpi with margins
      svg.style.maxWidth = naturalWidth ? `${Math.min(Math.round(naturalWidth), 660)}px` : '100%';
      svg.style.width = '100%';
      svg.style.height = 'auto';
      svg.removeAttribute('height');
    }
  });
  return root;
}

function getSanitizedPreviewClone() {
  const preview = document.getElementById('preview-pane');
  return sanitizeExportDom(preview.cloneNode(true));
}

function getSanitizedPreviewHtml() {
  return getSanitizedPreviewClone().innerHTML;
}

// Re-render every mermaid block inside `root` from its stored source using
// the CURRENT mermaid theme (callers wrap this in withMermaidTheme). A block
// that fails keeps whatever it already shows.
let exportRenderCounter = 0;
async function rethemeMermaidIn(root) {
  for (const pre of root.querySelectorAll('.notebook-mermaid')) {
    const source = (pre.dataset.mermaidSrc || '').trim();
    if (!source) continue;
    try {
      const { svg } = await window.mermaid.render(`mdnb-export-${++exportRenderCounter}`, source);
      pre.innerHTML = svg;
      const el = pre.querySelector('svg');
      if (el) {
        const viewBox = el.viewBox && el.viewBox.baseVal;
        const naturalWidth = (viewBox && viewBox.width) ? viewBox.width : 0;
        el.style.maxWidth = naturalWidth ? `${Math.min(Math.round(naturalWidth), 660)}px` : '100%';
        el.style.width = '100%';
        el.style.height = 'auto';
        el.removeAttribute('height');
      }
    } catch (err) {
      console.error('Export diagram render failed; keeping existing SVG:', err);
    }
  }
}

// Opens the export options dialog (prefilled with the last-used choices).
// scopePreset: 'note' | 'section' | 'notebook' selects the default scope.
function exportToPdf(scopePreset = 'note') {
  const opts = (appSettings && appSettings.pdfExport) || {};
  document.getElementById('pdf-theme').value = opts.theme || 'light';
  document.getElementById('pdf-page-size').value = opts.pageSize || 'A4';
  document.getElementById('pdf-open-after').checked = opts.openAfter !== false;
  document.getElementById('pdf-reveal').checked = !!opts.reveal;

  // Populate the scope select with live page counts
  const scopeSelect = document.getElementById('pdf-scope');
  const sectionNode = getExportSectionNode();
  const sectionCount = sectionNode ? gatherPagesRecursively(sectionNode).length : 0;
  const notebookCount = treeData ? gatherPagesRecursively(treeData).length : 0;
  scopeSelect.innerHTML = `
    <option value="note" ${activeNote ? '' : 'disabled'}>Current note</option>
    <option value="section" ${sectionNode ? '' : 'disabled'}>This section (${sectionCount} page${sectionCount === 1 ? '' : 's'})</option>
    <option value="notebook">Entire notebook (${notebookCount} page${notebookCount === 1 ? '' : 's'})</option>
  `;
  if (scopePreset === 'note' && !activeNote) scopePreset = sectionNode ? 'section' : 'notebook';
  if (scopePreset === 'section' && !sectionNode) scopePreset = 'notebook';
  scopeSelect.value = scopePreset;

  document.getElementById('pdf-export-modal').classList.add('active');
}

// The section an export would cover: the open section landing, or the
// active note's parent section.
function getExportSectionNode() {
  if (activeSection && activeSection.relPath) {
    return findSectionNode(treeData, activeSection.relPath);
  }
  if (activeNote && treeData) {
    const dir = pathDirname(activeNote);
    const normalize = p => String(p).replace(/\\/g, '/');
    if (normalize(dir) === normalize(notebookRoot)) return null; // root notes -> notebook scope
    const findByFsPath = (node) => {
      if (!node) return null;
      if (node.kind === 'section' && normalize(node.fsPath) === normalize(dir)) return node;
      for (const s of (node.sections || [])) {
        const hit = findByFsPath(s);
        if (hit) return hit;
      }
      return null;
    };
    return findByFsPath(treeData);
  }
  return null;
}

function exportSectionToPdf() {
  exportToPdf(activeSection && !activeSection.relPath ? 'notebook' : 'section');
}

function hidePdfExportModal() {
  document.getElementById('pdf-export-modal').classList.remove('active');
}

async function confirmPdfExport() {
  const options = {
    theme: document.getElementById('pdf-theme').value,
    pageSize: document.getElementById('pdf-page-size').value,
    openAfter: document.getElementById('pdf-open-after').checked,
    reveal: document.getElementById('pdf-reveal').checked,
  };
  const scope = document.getElementById('pdf-scope').value;
  hidePdfExportModal();

  if (scope === 'section' || scope === 'notebook') {
    const sectionNode = scope === 'section' ? getExportSectionNode() : treeData;
    if (!sectionNode) {
      showToast('Nothing to export for that scope.', 'error');
      return;
    }
    await confirmBatchPdfExport(sectionNode, scope, options);
    return;
  }

  if (!activeNote) return;

  // Single note: re-render diagrams to match the PDF theme (not the app
  // theme), inside the mermaid mutex
  const clone = getSanitizedPreviewClone();
  await withMermaidTheme(PDF_MERMAID_THEME[options.theme] || 'default', () => rethemeMermaidIn(clone));

  const result = await window.api.exportToPdf(activeNote, clone.innerHTML, options);
  if (result && result.success) {
    if (appSettings) appSettings.pdfExport = options; // main persisted it
    showToast(`PDF exported: ${pathBasename(result.pdfPath)}`);
  } else if (result && !result.canceled) {
    showToast(result.reason || 'PDF export failed.', 'error');
  }
}

// ==========================================
// SHARING (standalone HTML, Word via pandoc, rich-text clipboard)
// ==========================================

// Standalone .html file with the note's images inlined as data: URIs (done
// in main). Diagrams are re-rendered to match the export theme, same as PDF.
async function exportAsHtml() {
  if (!activeNote) { showToast('Open a note to export it.', 'error'); return; }
  const theme = (appSettings && appSettings.pdfExport && appSettings.pdfExport.theme) || 'light';
  const clone = getSanitizedPreviewClone();
  await withMermaidTheme(PDF_MERMAID_THEME[theme] || 'default', () => rethemeMermaidIn(clone));
  const result = await window.api.exportToHtml(activeNote, clone.innerHTML, { theme });
  if (result && result.success) {
    showToast(`HTML exported: ${pathBasename(result.htmlPath)}`);
  } else if (result && !result.canceled) {
    showToast(result.reason || 'HTML export failed.', 'error');
  }
}

// Word export runs pandoc over the markdown file itself (not the preview
// DOM), so it needs no open editor state beyond knowing which note.
async function exportAsDocx() {
  if (!activeNote) { showToast('Open a note to export it.', 'error'); return; }
  const result = await window.api.exportToDocx(activeNote);
  if (result && result.success) {
    showToast(`Word document exported: ${pathBasename(result.docxPath)}`);
  } else if (result && !result.canceled) {
    showToast(result.reason || 'Word export failed.', 'error');
  }
}

// Puts the rendered note on the clipboard as HTML + plain-markdown text, so
// pasting into Gmail/Word/Slack keeps formatting while plain-text targets
// get the raw markdown.
async function copyAsRichText() {
  if (!activeNote) { showToast('Open a note to copy it.', 'error'); return; }
  const result = await window.api.copyRichText(getSanitizedPreviewHtml(), noteContent || '');
  if (result && result.success) {
    showToast('Copied note as rich text.');
  } else {
    showToast((result && result.reason) || 'Copy failed.', 'error');
  }
}

// ==========================================
// BATCH PDF EXPORT (section / notebook -> one merged PDF with a TOC)
// ==========================================

async function confirmBatchPdfExport(sectionNode, scope, options) {
  const pages = gatherPagesRecursively(sectionNode);
  if (pages.length === 0) {
    showToast('No pages to export.', 'error');
    return;
  }
  if (pages.length > 150 &&
      !confirm(`This will export ${pages.length} pages into one PDF, which can take a while. Continue?`)) {
    return;
  }

  const docTitle = scope === 'notebook' ? 'Notebook' : (sectionNode.name || 'Section');
  let skipped = 0;

  const html = await withMermaidTheme(PDF_MERMAID_THEME[options.theme] || 'default', async () => {
    const sections = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      showToast(`Exporting ${i + 1}/${pages.length} — ${p.title}`, 'progress');
      await new Promise(r => setTimeout(r)); // let the toast paint
      let text;
      try {
        text = await window.api.readNote(p.fsPath);
      } catch {
        skipped++;
        continue;
      }
      // Render offscreen: never touches #preview-pane
      const div = document.createElement('div');
      div.innerHTML = window.api.renderMarkdown(text, { resourceBase: pathDirname(p.fsPath) });
      sanitizeExportDom(div);

      for (const pre of div.querySelectorAll('.notebook-mermaid')) {
        const source = (pre.dataset.mermaidSrc || pre.textContent || '').trim();
        try {
          const { svg } = await window.mermaid.render(`mdnb-batch-${++exportRenderCounter}`, source);
          pre.innerHTML = svg;
        } catch {
          const container = pre.closest('.mermaid-block-container') || pre;
          const fallback = document.createElement('pre');
          fallback.textContent = source + '\n\n(Diagram failed to render)';
          container.replaceWith(fallback);
        }
      }

      sections.push(`<section class="pdf-note" id="note-${i}"><h1 class="pdf-note-title">${escapeHtml(p.title)}</h1>${div.innerHTML}</section>`);
    }

    const toc = `
      <section class="pdf-toc">
        <h1>${escapeHtml(docTitle)}</h1>
        <ol>
          ${pages.map((p, i) => `<li><a href="#note-${i}">${escapeHtml(p.title)}</a><span class="pdf-toc-path">${escapeHtml(pathDirname(p.relPath) || '')}</span></li>`).join('')}
        </ol>
      </section>
    `;
    return toc + sections.join('');
  });

  if (!html) {
    showToast('Export failed while rendering notes.', 'error');
    return;
  }

  const suggestedPath = scope === 'notebook'
    ? `${notebookRoot}/notebook.pdf`
    : `${sectionNode.fsPath}.pdf`;
  const result = await window.api.exportToPdf(suggestedPath, html, options);
  if (result && result.success) {
    if (appSettings) appSettings.pdfExport = options;
    showToast(`PDF exported (${pages.length - skipped} pages${skipped ? `, ${skipped} skipped` : ''}): ${pathBasename(result.pdfPath)}`);
  } else if (result && !result.canceled) {
    showToast(result.reason || 'PDF export failed.', 'error');
  } else {
    hideToast();
  }
}

// ==========================================
// TOAST NOTIFICATIONS (non-blocking feedback)
// ==========================================
let toastTimer = null;
function showToast(message, type = 'success') {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    el.className = 'app-toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle('error', type === 'error');
  el.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  // 'progress' toasts stick until replaced by a final success/error toast
  if (type !== 'progress') {
    toastTimer = setTimeout(() => el.classList.remove('visible'), 3500);
  }
}

function hideToast() {
  const el = document.getElementById('app-toast');
  if (el) el.classList.remove('visible');
  if (toastTimer) clearTimeout(toastTimer);
}

// ==========================================
// KEYBOARD SHORTCUTS REFERENCE
// ==========================================
const SHORTCUT_SECTIONS = [
  {
    section: 'General',
    items: [
      { keys: 'Mod+K', desc: 'Open command palette' },
      { keys: 'Mod+N', desc: 'Create a new page' },
      { keys: 'Mod+S', desc: 'Save the current note' },
      { keys: 'Mod+/', desc: 'Show this shortcuts reference' },
      { keys: 'Esc', desc: 'Close dialogs, popups & the diagram viewer' },
    ],
  },
  {
    section: 'View',
    items: [
      { keys: 'Mod+1', desc: 'Rendered preview' },
      { keys: 'Mod+2', desc: 'Raw source editor' },
      { keys: 'Mod+3', desc: 'Side-by-side split view' },
    ],
  },
  {
    section: 'Editor — Formatting',
    items: [
      { keys: 'Mod+B', desc: 'Bold' },
      { keys: 'Mod+I', desc: 'Italic' },
      { keys: 'Mod+Alt+L', desc: 'Insert bullet list item' },
      { keys: 'Mod+Alt+C', desc: 'Insert task checklist item' },
      { keys: 'Mod+Alt+-', desc: 'Insert separator line' },
    ],
  },
  {
    section: 'Editor — Lists & Indentation',
    items: [
      { keys: 'Tab', desc: 'Indent line or list item' },
      { keys: 'Shift+Tab', desc: 'Outdent line or list item' },
      { keys: 'Enter', desc: 'Continue the list at the same indent' },
      { keys: 'Enter', desc: 'On an empty item: end the list', note: 'empty item' },
    ],
  },
];

function showShortcutsModal() {
  const container = document.getElementById('shortcuts-list');
  container.innerHTML = SHORTCUT_SECTIONS.map(group => `
    <div class="shortcuts-section">
      <h4>${escapeHtml(group.section)}</h4>
      ${group.items.map(item => `
        <div class="shortcut-row">
          <span class="shortcut-desc">${escapeHtml(item.desc)}</span>
          <span class="shortcut-keys"><kbd>${escapeHtml(shortcutLabel(item.keys))}</kbd></span>
        </div>
      `).join('')}
    </div>
  `).join('');
  document.getElementById('shortcuts-modal').classList.add('active');
}

function hideShortcutsModal() {
  document.getElementById('shortcuts-modal').classList.remove('active');
}

// Prompt Page Creation with custom Name (for broken Wiki-Links)
async function promptCreatePageWithName(pageFilename) {
  const title = pageFilename.replace(/\.md$/i, '');
  const dest = activeNote ? pathDirname(activeNote) : notebookRoot;
  
  if (confirm(`Note "${title}" does not exist. Would you like to create it?`)) {
    const newPath = await window.api.createPage(dest, title);
    await refreshNotebook();
    await openNote(newPath);
  }
}

// Setup custom Orientation trigger from Preload
window.addEventListener('perform-mermaid-toggle', async (event) => {
  const lineIdx = event.detail; // passes line index
  if (!activeNote) return;
  
  // We scan the file text, search for orientation line under mermaid code block, and replace it
  const lines = noteContent.split(/\r?\n/);
  if (lineIdx >= 0 && lineIdx < lines.length) {
    let foundMatch = false;
    for (let i = 0; i < 10 && lineIdx + i < lines.length; i++) {
      const idx = lineIdx + i;
      const text = lines[idx];
      if (i > 0 && text.trim() === '```') break; // reached end of mermaid block
      
      const regex = /^([ \t]*(?:graph|flowchart|direction)\s+)(TD|TB|LR|RL|BT)\b/im;
      const match = text.match(regex);
      if (match) {
        const orientationMap = {
          'TD': 'LR', 'TB': 'LR', 'LR': 'TD', 'RL': 'BT', 'BT': 'RL'
        };
        const newDir = orientationMap[match[2].toUpperCase()] || 'LR';
        lines[idx] = text.replace(regex, `$1${newDir}`);
        foundMatch = true;
        break;
      }
    }
    
    if (foundMatch) {
      noteContent = lines.join('\n');
      await window.api.writeNote(activeNote, noteContent);
      noteOriginalContent = noteContent;
      renderActiveNote();
    } else {
      alert("No mermaid orientation (e.g. 'graph TD', 'direction LR') found in the block.");
    }
  }
});

// ==========================================
// 1. DYNAMIC LANDING PAGES LOGIC
// ==========================================

async function openSection(relPath, fsPath) {
  if (activeNote && noteContent !== noteOriginalContent) {
    await saveActiveNote();
  }
  activeNote = '';
  activeSection = { relPath, fsPath };

  if (relPath && !expandedSections.has(relPath)) {
    expandedSections.add(relPath);
  }

  document.getElementById('empty-state-canvas').style.display = 'none';
  document.getElementById('note-workspace').style.display = 'none';
  document.getElementById('landing-workspace').style.display = 'flex';

  const modeToggles = document.querySelector('.mode-toggles');
  if (modeToggles) modeToggles.style.display = 'none';

  await renderSectionLanding();
  renderSidebarTree();
  renderTabStrip(); // clear the active-tab highlight (landings have no tab)
}

async function openRootLanding() {
  if (activeNote && noteContent !== noteOriginalContent) {
    await saveActiveNote();
  }
  activeNote = '';
  activeSection = { relPath: '', fsPath: notebookRoot };

  document.getElementById('empty-state-canvas').style.display = 'none';
  document.getElementById('note-workspace').style.display = 'none';
  document.getElementById('landing-workspace').style.display = 'flex';

  const modeToggles = document.querySelector('.mode-toggles');
  if (modeToggles) modeToggles.style.display = 'none';

  await renderRootLanding();
  renderSidebarTree();
  renderTabStrip(); // clear the active-tab highlight (landings have no tab)
}

function findSectionNode(node, relPath) {
  if (!node) return null;
  if (node.kind === 'section' && node.relPath === relPath) {
    return node;
  }
  if (node.sections) {
    for (const sub of node.sections) {
      const found = findSectionNode(sub, relPath);
      if (found) return found;
    }
  }
  return null;
}

function gatherPagesRecursively(node, list = []) {
  if (!node) return list;
  if (node.pages) {
    node.pages.forEach(p => list.push(p));
  }
  if (node.sections) {
    node.sections.forEach(s => gatherPagesRecursively(s, list));
  }
  return list;
}

// Open tasks now arrive on each PageNode from the tree scan (which already
// reads every file), so building this list requires no extra file reads.
function getPendingTasksForPages(pages) {
  const tasks = [];
  for (const page of pages) {
    (page.taskLines || []).forEach(t => {
      tasks.push({
        fsPath: page.fsPath,
        title: page.title,
        text: t.text,
        lineIndex: t.line,
      });
    });
  }
  return tasks;
}

async function toggleLandingTask(fsPath, lineIndex) {
  const success = await window.api.toggleTaskAtLine(fsPath, lineIndex);
  if (success) {
    await refreshNotebook();
  }
}

async function renderSectionLanding() {
  if (!activeSection || !treeData) return;
  const sectionNode = findSectionNode(treeData, activeSection.relPath);
  if (!sectionNode) return;

  document.getElementById('landing-title').innerText = sectionNode.name;
  document.getElementById('landing-subtitle').innerText =
    sectionNode.description || `Directory: ${sectionNode.relPath || 'Notebook Root'}`;
  document.getElementById('landing-header-icon').innerHTML = `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
  `;
  document.getElementById('landing-workspace').className = '';

  const pages = gatherPagesRecursively(sectionNode);
  let totalOpen = 0;
  let totalCompleted = 0;
  pages.forEach(p => {
    totalOpen += p.openTasks || 0;
    totalCompleted += p.completedTasks || 0;
  });

  document.getElementById('metric-pages').innerText = pages.length;
  document.getElementById('metric-completed').innerText = totalCompleted;
  document.getElementById('metric-pending').innerText = totalOpen;
  updateDashboardProgress(totalOpen, totalCompleted);

  const notesContainer = document.getElementById('landing-notes-list');
  if (pages.length === 0) {
    notesContainer.innerHTML = `<div class="empty-list-notice" style="font-size: 13px; color: var(--text-muted); text-align: center; padding: 24px;">No pages in this section.</div>`;
  } else {
    notesContainer.innerHTML = pages.map(p => {
      const taskTotal = (p.openTasks || 0) + (p.completedTasks || 0);
      const progressBadge = taskTotal > 0 ? `
        <span class="task-badge landing-badge">${p.completedTasks}/${taskTotal} Done</span>
      ` : '';
      return `
        <div class="landing-page-item" onclick="openNote(${jsArg(p.fsPath)})">
          <div class="landing-page-main">
            <span class="landing-page-title">${escapeHtml(p.title)}</span>
            <div class="landing-page-meta">
              <span>Created: ${escapeHtml(p.created || 'N/A')}</span>
              ${p.tags.map(t => `<span class="tag-pill" style="font-size: 9px; padding: 1px 4px;">#${escapeHtml(t)}</span>`).join(' ')}
            </div>
          </div>
          ${progressBadge}
        </div>
      `;
    }).join('\n');
  }

  const tasksContainer = document.getElementById('landing-tasks-list');
  tasksContainer.innerHTML = `<div class="empty-list-notice" style="font-size: 13px; color: var(--text-muted); text-align: center; padding: 24px;">Loading pending actions...</div>`;

  const pendingTasks = await getPendingTasksForPages(pages);
  if (pendingTasks.length === 0) {
    tasksContainer.innerHTML = `<div class="empty-list-notice" style="font-size: 13px; color: var(--text-muted); text-align: center; padding: 24px;">No pending actions in this section! 🎉</div>`;
  } else {
    tasksContainer.innerHTML = pendingTasks.map(t => {
      return `
        <div class="landing-task-item">
          <input type="checkbox" style="accent-color: var(--accent-blue); width: 15px; height: 15px; cursor: pointer;" onchange="toggleLandingTask(${jsArg(t.fsPath)}, ${t.lineIndex})">
          <span class="landing-task-text">${escapeHtml(t.text)}</span>
          <span class="landing-task-origin" onclick="openNote(${jsArg(t.fsPath)})">${escapeHtml(t.title)}</span>
        </div>
      `;
    }).join('\n');
  }
}

async function renderRootLanding() {
  if (!treeData) return;
  document.getElementById('landing-title').innerText = "Notebook Dashboard";
  document.getElementById('landing-subtitle').innerText = "Master overview and recent actions across the entire notebook.";
  document.getElementById('landing-header-icon').innerHTML = `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20M4 19.5V5A2.5 2.5 0 0 1 6.5 2.5H20v14H6.5a2.5 2.5 0 0 0-2.5 2.5z"/></svg>
  `;
  document.getElementById('landing-workspace').className = 'root-mode';

  const pages = gatherPagesRecursively(treeData);
  let totalOpen = 0;
  let totalCompleted = 0;
  pages.forEach(p => {
    totalOpen += p.openTasks || 0;
    totalCompleted += p.completedTasks || 0;
  });

  document.getElementById('metric-pages').innerText = pages.length;
  document.getElementById('metric-completed').innerText = totalCompleted;
  document.getElementById('metric-pending').innerText = totalOpen;
  updateDashboardProgress(totalOpen, totalCompleted);

  const sortedPages = [...pages].sort((a, b) => {
    const dateA = a.created ? new Date(a.created) : new Date(0);
    const dateB = b.created ? new Date(b.created) : new Date(0);
    return dateB - dateA;
  });

  const notesContainer = document.getElementById('landing-notes-list');
  if (sortedPages.length === 0) {
    notesContainer.innerHTML = `<div class="empty-list-notice" style="font-size: 13px; color: var(--text-muted); text-align: center; padding: 24px;">No pages in this notebook.</div>`;
  } else {
    notesContainer.innerHTML = `
      <div style="font-size: 10px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px; font-weight: 700; letter-spacing: 0.5px;">Recently Created</div>
      ` + sortedPages.slice(0, 10).map(p => {
      const taskTotal = (p.openTasks || 0) + (p.completedTasks || 0);
      const progressBadge = taskTotal > 0 ? `
        <span class="task-badge landing-badge">${p.completedTasks}/${taskTotal} Done</span>
      ` : '';
      return `
        <div class="landing-page-item" onclick="openNote(${jsArg(p.fsPath)})">
          <div class="landing-page-main">
            <span class="landing-page-title">${escapeHtml(p.title)}</span>
            <div class="landing-page-meta">
              <span>Created: ${escapeHtml(p.created || 'N/A')}</span>
              ${p.tags.map(t => `<span class="tag-pill" style="font-size: 9px; padding: 1px 4px;">#${escapeHtml(t)}</span>`).join(' ')}
            </div>
          </div>
          ${progressBadge}
        </div>
      `;
    }).join('\n');
  }

  const tasksContainer = document.getElementById('landing-tasks-list');
  tasksContainer.innerHTML = `<div class="empty-list-notice" style="font-size: 13px; color: var(--text-muted); text-align: center; padding: 24px;">Loading global pending actions...</div>`;

  const pendingTasks = await getPendingTasksForPages(pages);
  if (pendingTasks.length === 0) {
    tasksContainer.innerHTML = `<div class="empty-list-notice" style="font-size: 13px; color: var(--text-muted); text-align: center; padding: 24px;">No pending actions globally! 🎉</div>`;
  } else {
    tasksContainer.innerHTML = pendingTasks.slice(0, 25).map(t => {
      return `
        <div class="landing-task-item">
          <input type="checkbox" style="accent-color: var(--accent-blue); width: 15px; height: 15px; cursor: pointer;" onchange="toggleLandingTask(${jsArg(t.fsPath)}, ${t.lineIndex})">
          <span class="landing-task-text">${escapeHtml(t.text)}</span>
          <span class="landing-task-origin" onclick="openNote(${jsArg(t.fsPath)})">${escapeHtml(t.title)}</span>
        </div>
      `;
    }).join('\n');
  }
}

function updateDashboardProgress(totalOpen, totalCompleted) {
  const totalTasks = totalOpen + totalCompleted;
  const ratioLabel = document.getElementById('metric-tasks-ratio');
  const pctText = document.getElementById('dashboard-progress-text');
  const ring = document.getElementById('dashboard-progress-ring');
  
  if (ratioLabel) {
    ratioLabel.innerText = totalTasks > 0 ? `${totalCompleted} of ${totalTasks} tasks` : 'No checklists';
  }
  
  const percentage = totalTasks > 0 ? Math.round((totalCompleted / totalTasks) * 100) : 0;
  if (pctText) {
    pctText.innerText = `${percentage}%`;
  }
  
  if (ring) {
    const offset = 125.66 - (percentage / 100) * 125.66;
    ring.style.strokeDashoffset = offset;
  }
}

// ==========================================
// 2. SCALING PREVIEW & AUTO-SAVE TOGGLE
// ==========================================

function zoomPreview(amount) {
  previewZoomLevel = Math.max(70, Math.min(200, previewZoomLevel + amount));
  const pane = document.getElementById('preview-pane');
  pane.style.fontSize = `${previewZoomLevel}%`;
  const label = document.getElementById('label-preview-zoom');
  if (label) label.innerText = `${previewZoomLevel}%`;
}

async function cyclePageWidth() {
  let newWidth = 'standard';
  if (appSettings.defaultPageWidth === 'standard') {
    newWidth = 'wide';
  } else if (appSettings.defaultPageWidth === 'wide') {
    newWidth = 'full';
  } else {
    newWidth = 'standard';
  }
  
  appSettings.defaultPageWidth = newWidth;
  appSettings = await window.api.saveSettings(appSettings);
  
  setViewMode(viewMode);
  
  document.getElementById('settings-page-width').value = newWidth;
  
  const labelMap = { 'standard': 'Standard', 'wide': 'Wide', 'full': 'Full' };
  document.getElementById('label-stretch-width').innerText = labelMap[newWidth] || 'Standard';
}

function toggleAutoSave(value) {
  autoSaveEnabled = value;
  document.getElementById('header-autosave').checked = value;
  document.getElementById('settings-autosave').checked = value;
  
  if (appSettings) {
    appSettings.autoSaveEnabled = value;
    window.api.saveSettings(appSettings);
  }
}

// ==========================================
// 3. INLINE MERMAID SCALE & FULLSCREEN POPOUT
// ==========================================

function zoomMermaid(btn, amount) {
  const container = btn.closest('.mermaid-block-container');
  const pre = container ? container.querySelector('.notebook-mermaid') : null;
  const svg = pre ? pre.querySelector('svg') : null;
  if (!pre || !svg) return;

  const current = parseInt(pre.dataset.zoomLevel, 10) || 100;
  const next = clampMermaidZoom(current + amount);
  pre.dataset.zoomLevel = String(next);
  applyInlineMermaidZoom(pre, svg, next);
}

let popoutBaseWidth = 0; // natural diagram width in px, basis for pixel zooming

async function popoutMermaid(btn) {
  const container = btn.closest('.mermaid-block-container');
  const pre = container ? container.querySelector('.notebook-mermaid') : null;
  if (!pre) return;

  const popoutBody = document.getElementById('mermaid-popout-body');
  popoutBody.innerHTML = '';
  const canvas = document.createElement('div');
  canvas.className = 'popout-canvas';
  popoutBody.appendChild(canvas);

  document.getElementById('mermaid-popout-overlay').classList.add('active');

  let svgEl = null;
  const source = (pre.dataset.mermaidSrc || '').trim();
  try {
    if (source) {
      await ensureMermaid();
      // Re-render from source: a fresh SVG with its own unique id, so markers
      // and styles don't collide with the inline diagram's ids.
      const { svg } = await window.mermaid.render(`popout-diagram-${Date.now()}`, source);
      canvas.innerHTML = svg;
      svgEl = canvas.querySelector('svg');
    }
  } catch (err) {
    console.error('Popout mermaid render failed, falling back to clone:', err);
  }

  if (!svgEl) {
    // Fallback: clone the already-rendered inline SVG
    const originalSvg = container.querySelector('svg');
    if (!originalSvg) {
      canvas.innerHTML = '<div class="popout-error">This diagram could not be rendered.</div>';
      return;
    }
    svgEl = originalSvg.cloneNode(true);
    canvas.appendChild(svgEl);
  }

  // Zoom by explicit pixel width (keeps scrollbars honest, unlike transform)
  svgEl.style.transform = 'none';
  svgEl.style.zoom = '1';
  svgEl.style.maxWidth = 'none';
  svgEl.style.maxHeight = 'none';
  svgEl.style.height = 'auto';
  svgEl.removeAttribute('height');

  const viewBox = svgEl.viewBox && svgEl.viewBox.baseVal;
  popoutBaseWidth = (viewBox && viewBox.width) ? viewBox.width : (svgEl.getBoundingClientRect().width || 800);

  // Start fitted to the visible area — BOTH axes: fitting a portrait
  // diagram to the width alone makes it several screens tall.
  const availableW = popoutBody.clientWidth - 80;
  const fitW = (availableW / popoutBaseWidth) * 100;
  let fit = fitW;
  if (viewBox && viewBox.width && viewBox.height) {
    const naturalHeight = popoutBaseWidth * viewBox.height / viewBox.width;
    const availableH = popoutBody.clientHeight - 80;
    fit = Math.min(fitW, (availableH / naturalHeight) * 100);
  }
  popoutZoomLevel = Math.max(40, Math.min(150, Math.round(fit) || 100));
  applyPopoutZoom();
}

function applyPopoutZoom() {
  const svg = document.querySelector('#mermaid-popout-body svg');
  if (svg && popoutBaseWidth) {
    svg.style.width = `${Math.round(popoutBaseWidth * popoutZoomLevel / 100)}px`;
  }
  document.getElementById('label-popout-zoom').innerText = `${popoutZoomLevel}%`;
}

function zoomPopout(amount) {
  popoutZoomLevel = Math.max(40, Math.min(300, popoutZoomLevel + amount));
  applyPopoutZoom();
}

function closeMermaidPopout() {
  document.getElementById('mermaid-popout-overlay').classList.remove('active');
}

// Drag-to-pan inside the popout viewer
function initPopoutPan() {
  const body = document.getElementById('mermaid-popout-body');
  if (!body) return;
  let panning = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;

  body.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    panning = true;
    body.classList.add('panning');
    startX = e.clientX;
    startY = e.clientY;
    startLeft = body.scrollLeft;
    startTop = body.scrollTop;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    body.scrollLeft = startLeft - (e.clientX - startX);
    body.scrollTop = startTop - (e.clientY - startY);
  });

  window.addEventListener('mouseup', () => {
    if (panning) {
      panning = false;
      body.classList.remove('panning');
    }
  });
}

// ==========================================
// 3. FLOATING COMMAND PALETTE (OMNI-SEARCH)
// ==========================================
let paletteSelectedIndex = 0;
let paletteFilteredItems = [];

function toggleCommandPalette() {
  const modal = document.getElementById('command-palette-modal');
  if (modal) {
    if (modal.style.display === 'none') {
      showCommandPalette();
    } else {
      hideCommandPalette();
    }
  }
}

function showCommandPalette() {
  const modal = document.getElementById('command-palette-modal');
  const input = document.getElementById('palette-search-input');
  if (!modal || !input) return;

  modal.style.display = 'flex';
  input.value = '';
  paletteSelectedIndex = 0;
  
  if (!input.dataset.handlerBound) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        navigatePaletteSelection(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        navigatePaletteSelection(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        confirmPaletteSelection();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hideCommandPalette();
      }
    });
    input.dataset.handlerBound = 'true';
  }

  handlePaletteSearch();
  setTimeout(() => input.focus(), 50);
}

function hideCommandPalette() {
  const modal = document.getElementById('command-palette-modal');
  if (modal) {
    modal.style.display = 'none';
  }
}

function handlePaletteSearch() {
  const query = document.getElementById('palette-search-input').value.trim().toLowerCase();
  const listContainer = document.getElementById('palette-results-list');
  if (!listContainer) return;

  listContainer.innerHTML = '';
  paletteFilteredItems = [];

  const commands = [
    { label: 'Create New Page', subtitle: 'Action: /new', action: () => promptCreatePage(notebookRoot) },
    { label: 'Create New Section', subtitle: 'Action: /section', action: () => promptCreateSection(notebookRoot) },
    { label: 'Toggle Auto-Save Mode', subtitle: 'Action: /autosave', action: () => {
      const chk = document.getElementById('header-autosave');
      if (chk) {
        chk.checked = !chk.checked;
        toggleAutoSave(chk.checked);
      }
    }},
    { label: 'Cycle Page Width Layout (Standard / Wide / Full)', subtitle: 'Action: /wide', action: () => cyclePageWidth() },
    { label: 'Toggle Rendered Preview Pane', subtitle: 'Action: /preview', action: () => setViewMode('preview') },
    { label: 'Toggle Raw Source Editor', subtitle: 'Action: /edit', action: () => setViewMode('edit') },
    { label: 'Toggle Side-by-Side Split View', subtitle: 'Action: /split', action: () => setViewMode('split') },
    { label: 'Manage Note Templates', subtitle: 'Action: /templates', action: () => showTemplatesModal() },
    { label: 'Open Mermaid Diagram Builder', subtitle: 'Action: /diagram', action: () => showMermaidBuilder() },
    { label: 'Toggle Sidebar (Notes Directory)', subtitle: 'Action: /sidebar', action: () => toggleSidebarCollapsed() },
    { label: 'View Keyboard Shortcuts', subtitle: 'Action: /shortcuts', action: () => showShortcutsModal() },
    { label: 'Export Current Note to PDF', subtitle: 'Action: /pdf', action: () => exportToPdf() },
    { label: 'Export Section to PDF', subtitle: 'Action: /pdfsection', action: () => exportToPdf('section') },
    { label: 'Export Notebook to PDF', subtitle: 'Action: /pdfbook', action: () => exportToPdf('notebook') },
    { label: 'Export Current Note to HTML', subtitle: 'Action: /html', action: () => exportAsHtml() },
    { label: 'Export Current Note to Word (DOCX)', subtitle: 'Action: /docx', action: () => exportAsDocx() },
    { label: 'Copy Note as Rich Text', subtitle: 'Action: /copyrich', action: () => copyAsRichText() },
    { label: 'Open Trash', subtitle: 'Action: /trash', action: () => showTrashModal() },
    { label: 'Note History (Current Note)', subtitle: 'Action: /history', action: () => showHistoryModal() },
    { label: 'Open Table Editor', subtitle: 'Action: /table', action: () => openTableEditor('insert') },
    { label: 'Check for Updates', subtitle: 'Action: /update', action: () => checkForUpdates() },
  ];

  const matchingCommands = commands.filter(cmd => 
    cmd.label.toLowerCase().includes(query) || 
    cmd.subtitle.toLowerCase().includes(query)
  );

  let matchingPages = [];
  if (treeData) {
    const allPages = gatherPagesRecursively(treeData);
    matchingPages = allPages.filter(p => 
      p.title.toLowerCase().includes(query) || 
      p.name.toLowerCase().includes(query)
    ).map(p => ({
      label: p.title,
      subtitle: `Note Page: ${p.created || 'No date'}`,
      action: () => openNote(p.fsPath)
    }));
  }

  paletteFilteredItems = [...matchingCommands, ...matchingPages];

  // Empty query: lead with recently opened notes (lazy-pruned against the tree)
  if (query === '') {
    const recents = getRecentNotes()
      .filter(p => p !== activeNote && (findNodeByPath(treeData, p) || isTemplatePath(p)))
      .slice(0, 8)
      .map(p => {
        const node = findNodeByPath(treeData, p);
        return {
          label: node ? node.title : pathBasename(p, '.md'),
          subtitle: 'Recently opened',
          group: 'Recent',
          action: () => openNote(p),
        };
      });
    if (recents.length) {
      paletteFilteredItems.forEach(item => { if (!item.group) item.group = 'Commands'; });
      paletteFilteredItems = [...recents, ...paletteFilteredItems];
    }
  }
  renderPaletteList();

  // Async content matches: appended (never reordered) once the main-process
  // search resolves, token-guarded against stale responses while typing.
  if (query.length >= 2 && !query.startsWith('/')) {
    const token = ++paletteContentToken;
    window.api.searchNotes(query, { maxResults: 10 }).then(results => {
      if (token !== paletteContentToken) return;
      const currentQuery = document.getElementById('palette-search-input').value.trim().toLowerCase();
      if (currentQuery !== query) return;

      const openPaths = new Set(paletteFilteredItems.map(i => i.fsPath).filter(Boolean));
      results.slice(0, 10).forEach(r => {
        if (openPaths.has(r.fsPath)) return; // already listed via title match
        const snippet = r.snippets && r.snippets[0];
        paletteFilteredItems.push({
          label: r.title,
          subtitle: `${r.matchCount} content match${r.matchCount === 1 ? '' : 'es'}`,
          subtitleHtml: snippet ? highlightSnippet(snippet.text, snippet.ranges) : '',
          fsPath: r.fsPath,
          kind: 'content',
          action: () => openNoteAtLine(r.fsPath, snippet ? snippet.line : 0),
        });
      });
      renderPaletteList();
    }).catch(() => {});
  }
}

let paletteContentToken = 0;

function renderPaletteList() {
  const listContainer = document.getElementById('palette-results-list');
  if (!listContainer) return;
  listContainer.innerHTML = '';

  if (paletteFilteredItems.length === 0) {
    listContainer.innerHTML = `<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:16px;">No pages or commands matching query</div>`;
    return;
  }

  let prevGroup = null;
  paletteFilteredItems.forEach((item, idx) => {
    if (item.group && item.group !== prevGroup) {
      const header = document.createElement('div');
      header.className = 'palette-group-header';
      header.textContent = item.group;
      listContainer.appendChild(header);
    }
    prevGroup = item.group || prevGroup;

    const el = document.createElement('div');
    el.className = `palette-item ${idx === paletteSelectedIndex ? 'selected' : ''}`;
    const isAction = item.subtitle.startsWith('Action:');
    const isContent = item.kind === 'content';
    const icon = isAction
      ? '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'
      : isContent
        ? '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'
        : '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';
    // subtitleHtml is pre-escaped highlight markup built by highlightSnippet
    const subtitleHtml = item.subtitleHtml || escapeHtml(item.subtitle);
    el.innerHTML = `
      <div class="palette-item-content">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: ${isAction ? 'var(--accent-teal)' : 'var(--accent-blue)'};">
          ${icon}
        </svg>
        <span class="palette-item-label">${escapeHtml(item.label)}</span>
      </div>
      <span class="palette-item-shortcut">${subtitleHtml}</span>
    `;

    el.addEventListener('click', () => {
      hideCommandPalette();
      item.action();
    });

    listContainer.appendChild(el);
  });
}

function navigatePaletteSelection(dir) {
  if (paletteFilteredItems.length === 0) return;
  paletteSelectedIndex = (paletteSelectedIndex + dir + paletteFilteredItems.length) % paletteFilteredItems.length;
  
  const items = document.querySelectorAll('.palette-item');
  items.forEach((el, idx) => {
    if (idx === paletteSelectedIndex) {
      el.classList.add('selected');
      el.scrollIntoView({ block: 'nearest' });
    } else {
      el.classList.remove('selected');
    }
  });
}

function confirmPaletteSelection() {
  if (paletteFilteredItems.length === 0 || !paletteFilteredItems[paletteSelectedIndex]) return;
  const selectedItem = paletteFilteredItems[paletteSelectedIndex];
  hideCommandPalette();
  selectedItem.action();
}

// ==========================================
// TAB STRIP (MRU list of open notes; the active tab IS activeNote)
// ==========================================

let openTabs = []; // fsPath[], left-to-right order

function tabStorageKey() {
  return `mdnb-tabs:${notebookRoot}`;
}

// MRU of opened notes for the palette's "Recent" group (15 stored, 8 shown)
function recentsStorageKey() {
  return `mdnb-recents:${notebookRoot}`;
}

function recordRecentNote(fsPath) {
  if (!notebookRoot) return;
  try {
    const list = JSON.parse(localStorage.getItem(recentsStorageKey()) || '[]')
      .filter(p => p !== fsPath);
    list.unshift(fsPath);
    localStorage.setItem(recentsStorageKey(), JSON.stringify(list.slice(0, 15)));
  } catch {}
}

function getRecentNotes() {
  if (!notebookRoot) return [];
  try {
    return JSON.parse(localStorage.getItem(recentsStorageKey()) || '[]');
  } catch {
    return [];
  }
}

function persistTabs() {
  if (!notebookRoot) return;
  try {
    localStorage.setItem(tabStorageKey(), JSON.stringify({ tabs: openTabs, active: activeNote }));
  } catch {}
}

function restoreTabs() {
  if (!notebookRoot) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(tabStorageKey()) || 'null');
    if (!saved || !Array.isArray(saved.tabs)) return null;
    openTabs = saved.tabs.filter(p => findNodeByPath(treeData, p) || isTemplatePath(p));
    renderTabStrip();
    return openTabs.includes(saved.active) ? saved.active : (openTabs[0] || null);
  } catch {
    return null;
  }
}

function renderTabStrip() {
  const strip = document.getElementById('tab-strip');
  if (!strip) return;

  if (openTabs.length === 0) {
    strip.style.display = 'none';
    strip.innerHTML = '';
    return;
  }

  strip.style.display = 'flex';
  strip.innerHTML = openTabs.map(fsPath => {
    const node = findNodeByPath(treeData, fsPath);
    const title = node ? node.title : pathBasename(fsPath, '.md');
    const isActive = fsPath === activeNote;
    return `
      <div class="note-tab ${isActive ? 'active' : ''}"
           onclick="openNote(${jsArg(fsPath)})"
           onauxclick="if (event.button === 1) { event.preventDefault(); closeTab(${jsArg(fsPath)}); }"
           oncontextmenu="showTabContextMenu(event, ${jsArg(fsPath)})"
           title="${escapeHtml(fsPath)}">
        <span class="note-tab-dirty" aria-hidden="true"></span>
        <span class="note-tab-label">${escapeHtml(title)}</span>
        <button class="note-tab-close" onclick="event.stopPropagation(); closeTab(${jsArg(fsPath)})" title="Close tab">&times;</button>
      </div>
    `;
  }).join('');

  const active = strip.querySelector('.note-tab.active');
  if (active) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

// Close every tab matching the predicate (called with the tab's ORIGINAL
// index) in one pass. `keep` survives and becomes active when the active
// tab was among the closed.
async function closeTabsWhere(predicate, keep) {
  const closing = new Set(openTabs.filter((p, i) => p !== keep && predicate(p, i)));
  if (closing.size === 0) return;
  openTabs = openTabs.filter(p => !closing.has(p));

  if (closing.has(activeNote)) {
    if (openTabs.includes(keep)) {
      await openNote(keep);
    } else if (openTabs.length) {
      await openNote(openTabs[0]);
    } else {
      closeNoteCanvas();
    }
  } else {
    renderTabStrip();
  }
  persistTabs();
}

// Right-click menu on a tab: close / close others / close left / close right
function hideTabContextMenu() {
  const menu = document.getElementById('tab-context-menu');
  if (menu) menu.remove();
}

function showTabContextMenu(e, fsPath) {
  e.preventDefault();
  e.stopPropagation();
  hideTabContextMenu();
  const idx = openTabs.indexOf(fsPath);
  if (idx === -1) return;

  const items = [
    { label: 'Close Tab', enabled: true, action: () => closeTab(fsPath) },
    { label: 'Close Other Tabs', enabled: openTabs.length > 1, action: () => closeTabsWhere(p => p !== fsPath, fsPath) },
    { label: 'Close Tabs to the Left', enabled: idx > 0, action: () => closeTabsWhere((p, i) => i < idx, fsPath) },
    { label: 'Close Tabs to the Right', enabled: idx < openTabs.length - 1, action: () => closeTabsWhere((p, i) => i > idx, fsPath) },
    { label: 'Close All Tabs', enabled: openTabs.length > 0, action: () => closeTabsWhere(() => true, null) },
  ];

  const menu = document.createElement('div');
  menu.id = 'tab-context-menu';
  menu.className = 'dropdown-menu glass-card tab-context-menu';
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'dropdown-item' + (item.enabled ? '' : ' disabled');
    el.textContent = item.label;
    if (item.enabled) {
      el.addEventListener('click', () => {
        hideTabContextMenu();
        item.action();
      });
    }
    menu.appendChild(el);
  }
  document.body.appendChild(menu);

  // Clamp to the viewport so the menu never opens half off-screen
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(e.clientX, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(4, Math.min(e.clientY, window.innerHeight - rect.height - 8))}px`;
}

async function closeTab(fsPath) {
  const idx = openTabs.indexOf(fsPath);
  if (idx === -1) return;
  openTabs.splice(idx, 1);

  if (activeNote === fsPath) {
    // Activate the right neighbor, else left, else close the canvas
    const next = openTabs[idx] || openTabs[idx - 1];
    if (next) {
      await openNote(next);
    } else {
      closeNoteCanvas();
    }
  } else {
    renderTabStrip();
  }
  persistTabs();
}

// Prune tabs whose files disappeared (delete/rename/move)
function pruneTabs() {
  const before = openTabs.length;
  openTabs = openTabs.filter(p => findNodeByPath(treeData, p) || isTemplatePath(p));
  if (openTabs.length !== before) {
    persistTabs();
  }
  renderTabStrip();
}

// ==========================================
// ATTACHMENTS (paste images / drop files into the editor)
// ==========================================

function insertAttachmentLink(relPath, isImage, label) {
  const textarea = document.getElementById('note-editor');
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const link = isImage ? `![](${relPath})` : `[${label || pathBasename(relPath)}](${relPath})`;
  replaceEditorRange(textarea, start, end, link);
}

function initAttachmentHandlers() {
  const textarea = document.getElementById('note-editor');
  const editorPane = document.getElementById('editor-pane');
  if (!textarea || !editorPane) return;

  // Paste: URL onto a selection turns it into a markdown link
  textarea.addEventListener('paste', (e) => {
    if (!e.clipboardData) return;
    const text = (e.clipboardData.getData('text/plain') || '').trim();
    if (!text || !/^https?:\/\/\S+$/i.test(text)) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start === end) return; // no selection: let the URL paste plain
    e.preventDefault();
    const selected = textarea.value.substring(start, end);
    replaceEditorRange(textarea, start, end, `[${selected}](${text})`);
  });

  // Paste: intercept image data only; plain text pastes fall through
  textarea.addEventListener('paste', async (e) => {
    if (!e.clipboardData) return;
    if (e.defaultPrevented) return; // the URL-link paste above already handled it
    const imageItem = Array.from(e.clipboardData.items).find(item => item.type.startsWith('image/'));
    if (!imageItem) return;

    e.preventDefault();
    if (!activeNote) {
      showToast('Open a note before pasting images.', 'error');
      return;
    }
    const file = imageItem.getAsFile();
    if (!file) return;

    try {
      const bytes = await file.arrayBuffer();
      const ext = (imageItem.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
      const result = await window.api.saveAttachment({
        baseName: file.name || `pasted-image.${ext}`,
        bytes,
        notePath: activeNote,
      });
      if (result && result.success) {
        insertAttachmentLink(result.relPath, true);
        showToast(`Image saved to ${result.relPath}`);
      } else {
        showToast((result && result.reason) || 'Could not save the pasted image.', 'error');
      }
    } catch (err) {
      showToast('Could not save the pasted image.', 'error');
      console.error('Paste attachment failed:', err);
    }
  });

  // Drag & drop files onto the editor pane. Scoped to #editor-pane so the
  // sidebar tree's move-note drag/drop is unaffected; tree drags carry
  // text/plain data and are ignored here.
  editorPane.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  editorPane.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (!activeNote) {
      showToast('Open a note before dropping files.', 'error');
      return;
    }

    for (const file of Array.from(e.dataTransfer.files)) {
      try {
        const sourcePath = window.api.getPathForFile(file);
        let result;
        if (sourcePath) {
          result = await window.api.importAttachmentFile({ sourcePath, notePath: activeNote });
        } else {
          // Some drag sources (e.g. browser images) provide bytes but no path
          result = await window.api.saveAttachment({
            baseName: file.name || 'dropped-file',
            bytes: await file.arrayBuffer(),
            notePath: activeNote,
          });
        }
        if (result && result.success) {
          insertAttachmentLink(result.relPath, /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(result.relPath), file.name);
          showToast(`Saved to ${result.relPath}`);
        } else {
          showToast((result && result.reason) || `Could not attach ${file.name}.`, 'error');
        }
      } catch (err) {
        showToast(`Could not attach ${file.name}.`, 'error');
        console.error('Drop attachment failed:', err);
      }
    }
  });
}

// ==========================================
// TEMPLATES MANAGER
// ==========================================

async function showTemplatesModal() {
  const label = document.getElementById('templates-folder-label');
  if (label && appSettings) label.innerText = appSettings.templatesFolder || 'templates';
  document.getElementById('templates-modal').classList.add('active');
  await renderTemplatesList();
}

function hideTemplatesModal() {
  document.getElementById('templates-modal').classList.remove('active');
}

async function renderTemplatesList() {
  const container = document.getElementById('templates-list');
  container.innerHTML = '<div class="template-empty-notice">Loading templates...</div>';

  const templates = await window.api.listTemplates();
  if (!templates || templates.length === 0) {
    container.innerHTML = '<div class="template-empty-notice">No templates yet. Create one to reuse a page layout for new notes.</div>';
    return;
  }

  container.innerHTML = templates.map(t => `
    <div class="template-item">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-teal); flex-shrink: 0;"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
      <div class="template-item-main">
        <span class="template-item-title">${escapeHtml(t.title)}</span>
        <span class="template-item-name">${escapeHtml(t.name)}</span>
      </div>
      <div class="template-item-actions">
        <button class="btn btn-xs btn-outline" onclick="useTemplateForNewPage(${jsArg(t.name)})" title="Create a new page from this template">New Page</button>
        <button class="btn btn-xs btn-outline" onclick="editTemplate(${jsArg(t.fsPath)})" title="Open template in the editor">Edit</button>
        <button class="tree-node-btn" onclick="deleteTemplate(${jsArg(t.fsPath)})" title="Delete Template">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>
  `).join('\n');
}

async function useTemplateForNewPage(templateName) {
  hideTemplatesModal();
  await promptCreatePage(notebookRoot); // waits for the template list to load
  const select = document.getElementById('create-modal-template');
  if (select) select.value = templateName;
}

async function editTemplate(fsPath) {
  hideTemplatesModal();
  await openNote(fsPath);
  setViewMode('edit');
}

async function deleteTemplate(fsPath) {
  if (!confirm('Delete this template permanently?')) return;
  const success = await window.api.deleteNode(fsPath);
  if (success) {
    if (activeNote === fsPath) closeNoteCanvas();
    await renderTemplatesList();
  }
}

function promptCreateTemplate() {
  hideTemplatesModal();
  document.getElementById('create-modal-title').innerText = 'New Template';
  document.getElementById('create-modal-name-label').innerText = 'Template Name';
  document.getElementById('create-modal-name').value = '';
  document.getElementById('create-modal-name').placeholder = 'e.g. Meeting Notes';

  document.getElementById('create-modal-dest-group').style.display = 'none';
  document.getElementById('create-modal-type').value = 'template';
  document.getElementById('create-modal-page-options').style.display = 'none';
  document.getElementById('create-modal-section-options').style.display = 'none';

  document.getElementById('create-modal').classList.add('active');
  setTimeout(() => document.getElementById('create-modal-name').focus(), 100);
}

// ==========================================
// TRASH (restore / permanently delete soft-deleted notes)
// ==========================================

async function showTrashModal() {
  closeAllEditorDropdowns();
  document.getElementById('trash-modal').classList.add('active');
  await renderTrashList();
}

function hideTrashModal() {
  document.getElementById('trash-modal').classList.remove('active');
}

async function renderTrashList() {
  const container = document.getElementById('trash-list');
  container.innerHTML = '<div class="template-empty-notice">Loading…</div>';
  const items = await window.api.listTrash();

  if (!items || items.length === 0) {
    container.innerHTML = '<div class="template-empty-notice">Trash is empty.</div>';
    return;
  }

  container.innerHTML = items.map(item => {
    const date = item.deletedAt ? new Date(item.deletedAt).toLocaleString() : '';
    const icon = item.kind === 'section'
      ? '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'
      : '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';
    return `
      <div class="template-item">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--text-secondary); flex-shrink: 0;">${icon}</svg>
        <div class="template-item-main">
          <span class="template-item-title">${escapeHtml(item.title)}</span>
          <span class="template-item-name">${escapeHtml(item.originalRelPath)}${date ? ' · ' + escapeHtml(date) : ''}</span>
        </div>
        <div class="template-item-actions">
          <button class="btn btn-xs btn-outline" onclick="restoreTrashItem(${jsArg(item.trashName)})" title="Restore to its original location">Restore</button>
          <button class="tree-node-btn" onclick="deleteTrashItemForever(${jsArg(item.trashName)})" title="Delete forever">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    `;
  }).join('\n');
}

async function restoreTrashItem(trashName) {
  const result = await window.api.restoreTrashItem(trashName);
  if (result && result.success) {
    showToast(`Restored to ${pathBasename(result.restoredPath)}`);
    await refreshNotebook();
  } else {
    showToast((result && result.reason) || 'Restore failed.', 'error');
  }
  await renderTrashList();
}

async function deleteTrashItemForever(trashName) {
  if (!confirm('Permanently delete this item? This cannot be undone.')) return;
  await window.api.deleteTrashItem(trashName);
  await renderTrashList();
}

async function confirmEmptyTrash() {
  if (!confirm('Permanently delete EVERYTHING in the trash? This cannot be undone.')) return;
  const result = await window.api.emptyTrash();
  showToast(`Trash emptied (${result.removed} item${result.removed === 1 ? '' : 's'} removed).`);
  await renderTrashList();
}

// ==========================================
// NOTE HISTORY (browse and restore save snapshots)
// ==========================================

let selectedHistoryId = null;

async function showHistoryModal() {
  closeAllEditorDropdowns();
  if (!activeNote) {
    showToast('Open a note to see its history.', 'error');
    return;
  }
  selectedHistoryId = null;
  document.getElementById('history-restore-btn').disabled = true;
  document.getElementById('history-preview').innerHTML =
    '<div class="builder-preview-placeholder">Select a snapshot to preview it</div>';
  document.getElementById('history-modal').classList.add('active');

  const list = document.getElementById('history-list');
  list.innerHTML = '<div class="template-empty-notice">Loading…</div>';
  const entries = await window.api.listNoteHistory(activeNote);

  if (!entries || entries.length === 0) {
    list.innerHTML = '<div class="template-empty-notice">No snapshots yet. Versions are saved automatically as you edit (at most one every few minutes).</div>';
    return;
  }

  list.innerHTML = entries.map(e => {
    const when = e.savedAt ? new Date(e.savedAt).toLocaleString() : e.id;
    const size = e.size >= 1024 ? `${(e.size / 1024).toFixed(1)} KB` : `${e.size} B`;
    return `
      <div class="history-entry" data-id="${escapeHtml(e.id)}" onclick="previewHistoryEntry(${jsArg(e.id)})">
        <span class="history-entry-date">${escapeHtml(when)}</span>
        <span class="history-entry-size">${escapeHtml(size)}</span>
      </div>
    `;
  }).join('\n');
}

function hideHistoryModal() {
  document.getElementById('history-modal').classList.remove('active');
  selectedHistoryId = null;
}

async function previewHistoryEntry(id) {
  selectedHistoryId = id;
  document.querySelectorAll('#history-list .history-entry').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === id);
  });

  const content = await window.api.readNoteHistory(activeNote, id);
  const previewEl = document.getElementById('history-preview');
  if (!content) {
    previewEl.innerHTML = '<div class="builder-preview-placeholder">Snapshot could not be read.</div>';
    document.getElementById('history-restore-btn').disabled = true;
    return;
  }
  // This renders into the history modal's own pane, not #preview-pane,
  // so the serialized preview queue is not involved.
  previewEl.innerHTML = window.api.renderMarkdown(content, {
    resourceBase: activeNote ? pathDirname(activeNote) : '',
  });
  document.getElementById('history-restore-btn').disabled = false;
}

async function restoreSelectedHistory() {
  if (!activeNote || !selectedHistoryId) return;
  if (!confirm('Replace the current note content with this snapshot? The current version is saved to history first.')) return;

  const success = await window.api.restoreNoteHistory(activeNote, selectedHistoryId);
  hideHistoryModal();
  if (success) {
    noteContent = await window.api.readNote(activeNote);
    noteOriginalContent = noteContent;
    renderActiveNote();
    showToast('Snapshot restored.');
  } else {
    showToast('Restore failed.', 'error');
  }
}

// Close any open toolbar dropdown (used when a dropdown action opens a modal)
function closeAllEditorDropdowns() {
  document.querySelectorAll('.dropdown-menu.active').forEach(menu => {
    menu.classList.remove('active');
    const container = menu.closest('.editor-dropdown');
    const chev = container && container.querySelector('.chevron');
    if (chev) chev.style.transform = 'rotate(0deg)';
  });
}

// ==========================================
// TABLE EDITOR (visual grid for markdown tables)
// ==========================================

let tableEditContext = null; // { charStart, charEnd } when editing in place
let tableModel = { align: [], rows: [] }; // rows[0] is the header
const TABLE_MAX_COLS = 26;

// Find the table block surrounding the caret: contiguous |-prefixed lines
// with a valid divider on the second line.
function detectTableAtCaret(textarea) {
  const text = textarea.value;
  const caret = textarea.selectionStart;
  const lines = text.split('\n');

  let pos = 0;
  let caretLine = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    if (caret <= pos + lines[i].length) {
      caretLine = i;
      break;
    }
    pos += lines[i].length + 1;
  }

  const isTabular = (l) => /^\s*\|/.test(l || '');
  if (!isTabular(lines[caretLine])) return null;

  let start = caretLine;
  let end = caretLine;
  while (start > 0 && isTabular(lines[start - 1])) start--;
  while (end < lines.length - 1 && isTabular(lines[end + 1])) end++;
  if (end - start < 1) return null;

  const dividerRe = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  if (!dividerRe.test(lines[start + 1])) return null;

  let charStart = 0;
  for (let i = 0; i < start; i++) charStart += lines[i].length + 1;
  const blockLines = lines.slice(start, end + 1);
  const charEnd = charStart + blockLines.join('\n').length;

  return { charStart, charEnd, blockLines };
}

const PIPE_PLACEHOLDER = '\u0000'; // cannot occur in note text

function parseTableRowCells(line) {
  // Protect escaped pipes so they survive the split as literal | in cells
  let s = line.trim().replace(/\\\|/g, PIPE_PLACEHOLDER);
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim().split(PIPE_PLACEHOLDER).join('|'));
}

function parseMarkdownTable(blockLines) {
  const header = parseTableRowCells(blockLines[0]);
  const align = parseTableRowCells(blockLines[1]).map(cell => {
    const c = cell.trim();
    if (c.startsWith(':') && c.endsWith(':')) return 'c';
    if (c.endsWith(':')) return 'r';
    return 'l';
  });
  const rows = [header, ...blockLines.slice(2).map(parseTableRowCells)];

  // Normalize: every row padded to the widest column count
  const cols = Math.max(align.length, ...rows.map(r => r.length));
  while (align.length < cols) align.push('l');
  rows.forEach(r => { while (r.length < cols) r.push(''); });
  return { align, rows };
}

function serializeMarkdownTable(model) {
  const cols = model.align.length;
  const esc = (c) => String(c ?? '').replace(/\|/g, '\\|');
  const cells = model.rows.map(row => {
    const out = [];
    for (let i = 0; i < cols; i++) out.push(esc(row[i]));
    return out;
  });
  const widths = model.align.map((a, i) => Math.max(3, ...cells.map(r => r[i].length)));
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
  const rowStr = (r) => '| ' + r.map((c, i) => pad(c, widths[i])).join(' | ') + ' |';
  const divider = '| ' + model.align.map((a, i) => {
    const w = widths[i];
    if (a === 'c') return ':' + '-'.repeat(Math.max(1, w - 2)) + ':';
    if (a === 'r') return '-'.repeat(Math.max(2, w - 1)) + ':';
    return '-'.repeat(w);
  }).join(' | ') + ' |';

  return [rowStr(cells[0]), divider, ...cells.slice(1).map(rowStr)].join('\n');
}

// mode: 'insert' (blank table) or 'edit' (table under the caret)
function openTableEditor(mode) {
  // Close the table dropdown that launched us
  const menu = document.getElementById('dropdown-table');
  if (menu) menu.classList.remove('active');

  if (!activeNote) {
    showToast('Open a note first.', 'error');
    return;
  }
  // The editor pane must exist for caret work
  if (viewMode === 'preview') {
    setViewMode('split');
  }

  tableEditContext = null;
  if (mode === 'edit') {
    const textarea = document.getElementById('note-editor');
    const found = detectTableAtCaret(textarea);
    if (found) {
      tableEditContext = { charStart: found.charStart, charEnd: found.charEnd };
      tableModel = parseMarkdownTable(found.blockLines);
    } else {
      showToast('No table at the cursor — starting a new one.');
    }
  }
  if (!tableEditContext) {
    tableModel = {
      align: ['l', 'l', 'l'],
      rows: [['Header 1', 'Header 2', 'Header 3'], ['', '', ''], ['', '', '']],
    };
  }

  document.getElementById('table-editor-apply').innerText = tableEditContext ? 'Update Table' : 'Insert Table';
  renderTableEditorGrid();
  document.getElementById('table-editor-modal').classList.add('active');
}

function hideTableEditorModal() {
  document.getElementById('table-editor-modal').classList.remove('active');
  tableEditContext = null;
}

const ALIGN_LABELS = { l: 'Left', c: 'Center', r: 'Right' };

// Rebuild the grid DOM from tableModel. Cell values flow through input.value
// (never innerHTML), so arbitrary content is safe.
function renderTableEditorGrid() {
  const grid = document.getElementById('table-editor-grid');
  grid.innerHTML = '';
  const cols = tableModel.align.length;

  // Column controls row
  const controls = document.createElement('div');
  controls.className = 'table-editor-row table-editor-controls';
  const gutterSpacer = document.createElement('span');
  gutterSpacer.className = 'table-editor-gutter';
  controls.appendChild(gutterSpacer);
  tableModel.align.forEach((a, col) => {
    const cell = document.createElement('div');
    cell.className = 'table-editor-colctl';
    const alignBtn = document.createElement('button');
    alignBtn.className = 'btn btn-xs btn-outline';
    alignBtn.innerText = ALIGN_LABELS[a];
    alignBtn.title = 'Cycle column alignment';
    alignBtn.onclick = () => {
      syncTableModelFromInputs();
      tableModel.align[col] = a === 'l' ? 'c' : a === 'c' ? 'r' : 'l';
      renderTableEditorGrid();
    };
    cell.appendChild(alignBtn);
    if (cols > 1) {
      const rm = document.createElement('button');
      rm.className = 'tree-node-btn';
      rm.innerHTML = '&times;';
      rm.title = 'Remove column';
      rm.onclick = () => {
        syncTableModelFromInputs();
        tableModel.align.splice(col, 1);
        tableModel.rows.forEach(r => r.splice(col, 1));
        renderTableEditorGrid();
      };
      cell.appendChild(rm);
    }
    controls.appendChild(cell);
  });
  if (cols < TABLE_MAX_COLS) {
    const addCol = document.createElement('button');
    addCol.className = 'btn btn-xs btn-outline';
    addCol.innerText = '+ Col';
    addCol.title = 'Add column';
    addCol.onclick = () => {
      syncTableModelFromInputs();
      tableModel.align.push('l');
      tableModel.rows.forEach((r, i) => r.push(i === 0 ? `Header ${tableModel.align.length}` : ''));
      renderTableEditorGrid();
    };
    controls.appendChild(addCol);
  }
  grid.appendChild(controls);

  // Data rows (row 0 = header)
  tableModel.rows.forEach((row, rowIdx) => {
    const rowEl = document.createElement('div');
    rowEl.className = `table-editor-row ${rowIdx === 0 ? 'header-row' : ''}`;
    const gutter = document.createElement('span');
    gutter.className = 'table-editor-gutter';
    if (rowIdx > 0 && tableModel.rows.length > 2) {
      const rm = document.createElement('button');
      rm.className = 'tree-node-btn';
      rm.innerHTML = '&times;';
      rm.title = 'Remove row';
      rm.onclick = () => {
        syncTableModelFromInputs();
        tableModel.rows.splice(rowIdx, 1);
        renderTableEditorGrid();
      };
      gutter.appendChild(rm);
    }
    rowEl.appendChild(gutter);

    row.forEach((cell, colIdx) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'table-editor-cell';
      input.value = cell;
      input.dataset.row = rowIdx;
      input.dataset.col = colIdx;
      input.placeholder = rowIdx === 0 ? 'Header' : '';
      input.addEventListener('input', () => {
        tableModel.rows[rowIdx][colIdx] = input.value;
        updateTableEditorOutput();
      });
      rowEl.appendChild(input);
    });
    grid.appendChild(rowEl);
  });

  const addRow = document.createElement('button');
  addRow.className = 'btn btn-xs btn-outline table-editor-addrow';
  addRow.innerText = '+ Row';
  addRow.onclick = () => {
    syncTableModelFromInputs();
    tableModel.rows.push(new Array(tableModel.align.length).fill(''));
    renderTableEditorGrid();
  };
  grid.appendChild(addRow);

  updateTableEditorOutput();
}

function syncTableModelFromInputs() {
  document.querySelectorAll('#table-editor-grid .table-editor-cell').forEach(input => {
    const r = parseInt(input.dataset.row, 10);
    const c = parseInt(input.dataset.col, 10);
    if (tableModel.rows[r]) tableModel.rows[r][c] = input.value;
  });
}

function updateTableEditorOutput() {
  document.getElementById('table-editor-output').value = serializeMarkdownTable(tableModel);
}

function applyTableEditor() {
  syncTableModelFromInputs();
  const tableMd = serializeMarkdownTable(tableModel);
  const textarea = document.getElementById('note-editor');

  if (tableEditContext) {
    const { charStart, charEnd } = tableEditContext;
    const current = textarea.value.slice(charStart, charEnd);
    if (/^\s*\|/.test(current)) {
      replaceEditorRange(textarea, charStart, charEnd, tableMd);
      hideTableEditorModal();
      return;
    }
    showToast('The note changed while editing — inserting at the cursor instead.', 'error');
  }

  const caret = textarea.selectionStart;
  replaceEditorRange(textarea, caret, textarea.selectionEnd, `\n${tableMd}\n`);
  hideTableEditorModal();
}

// ==========================================
// MERMAID DIAGRAM BUILDER
// ==========================================

let builderPreviewTimer = null;
let builderRenderCounter = 0;
let builderEditContext = null; // { line, originalSrc } while editing an existing block

function showMermaidBuilder() {
  // Close the mermaid dropdown if it triggered us
  const menu = document.getElementById('dropdown-mermaid');
  if (menu) {
    menu.classList.remove('active');
    const chev = menu.closest('.editor-dropdown').querySelector('.chevron');
    if (chev) chev.style.transform = 'rotate(0deg)';
  }
  builderEditContext = null;
  document.getElementById('builder-apply-btn').innerText = 'Insert into Note';
  document.getElementById('mermaid-builder-modal').classList.add('active');
  switchBuilderType();
}

function hideMermaidBuilder() {
  document.getElementById('mermaid-builder-modal').classList.remove('active');
  builderEditContext = null;
  document.getElementById('builder-apply-btn').innerText = 'Insert into Note';
}

// "Edit Diagram" button on rendered mermaid blocks: reopen the builder in
// raw-code mode with the block's source, and update it in place on apply.
function editMermaidDiagram(btn) {
  const container = btn.closest('.mermaid-block-container');
  const pre = container ? container.querySelector('.notebook-mermaid') : null;
  const src = pre ? (pre.dataset.mermaidSrc || '') : '';
  if (!src.trim()) {
    showToast('Could not read this diagram’s source.', 'error');
    return;
  }

  showMermaidBuilder();
  builderEditContext = {
    line: parseInt(container.dataset.line, 10) || 0,
    originalSrc: src,
  };
  document.getElementById('builder-type').value = 'custom';
  switchBuilderType();
  document.getElementById('builder-code').value = src.trim();
  document.getElementById('builder-apply-btn').innerText = 'Update Diagram';
  scheduleBuilderPreview();
}

// Locate a ```mermaid fence whose body matches `originalSrc`, preferring the
// candidate nearest `hintLine`. Returns character offsets covering the whole
// fence (opening line through closing line), or null.
function findMermaidFenceRange(text, hintLine, originalSrc) {
  const lines = text.split('\n');
  const target = originalSrc.trim();
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^\s*(`{3,}|~{3,})\s*mermaid\b/i);
    if (!open) continue;
    const marker = open[1];
    const body = [];
    let j = i + 1;
    while (j < lines.length && !lines[j].trim().startsWith(marker)) {
      body.push(lines[j]);
      j++;
    }
    if (j >= lines.length) continue; // unterminated fence
    if (body.join('\n').trim() === target) {
      candidates.push({ start: i, end: j });
    }
    i = j;
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Math.abs(a.start - hintLine) - Math.abs(b.start - hintLine));
  const { start, end } = candidates[0];

  let charStart = 0;
  for (let k = 0; k < start; k++) charStart += lines[k].length + 1;
  const charEnd = charStart + lines.slice(start, end + 1).join('\n').length;
  return { charStart, charEnd };
}

const BUILDER_TYPES = ['flowchart', 'sequence', 'pie', 'gantt', 'class', 'state', 'journey', 'er', 'timeline', 'mindmap', 'quadrant', 'custom'];

function switchBuilderType() {
  const type = document.getElementById('builder-type').value;
  BUILDER_TYPES.forEach(t => {
    const group = document.getElementById(`builder-fields-${t}`);
    if (group) group.style.display = t === type ? 'block' : 'none';
  });
  // 'custom' is a raw-code mode: no form, no example to load
  const exampleBtn = document.getElementById('builder-example-btn');
  if (exampleBtn) exampleBtn.style.display = type === 'custom' ? 'none' : 'inline-flex';
  if (type !== 'custom') {
    updateBuilderCode();
  } else {
    scheduleBuilderPreview();
  }
}

// "See Example" fills the current type's form with a working sample, so users
// keep a reference even after their own typing has replaced the placeholders.
const BUILDER_EXAMPLES = {
  flowchart: {
    direction: 'TD',
    steps: 'Receive request\nValid input?\nProcess order\nSend confirmation',
  },
  sequence: 'Client -> Server: Login request\nServer -> Database: Verify user\nDatabase --> Server: OK\nServer --> Client: Welcome!',
  pie: {
    title: 'Time spent',
    data: 'Meetings: 4\nCoding: 6\nEmail: 2',
  },
  gantt: {
    title: 'Website Redesign',
    start: '', // filled with today's date on load
    tasks: 'Gather requirements: 3\nDesign mockups: 5\nBuild pages: 7\nLaunch review: 2',
  },
  class: {
    classes: 'Animal: name, age, speak()\nDog: breed, fetch()\nCat: indoor, nap()',
    relations: 'Animal <- Dog\nAnimal <- Cat',
  },
  state: 'Idle -> Running: start\nRunning -> Paused: pause\nPaused -> Running: resume\nRunning -> Idle: stop',
  journey: {
    title: 'Morning routine',
    actor: 'Me',
    tasks: 'Wake up: 3\nMake coffee: 5\nCheck email: 2\nStart deep work: 4',
  },
  er: {
    entities: 'Customer: id, name, signup_date\nOrder: id, total, placed_at\nProduct: id, name, price',
    relations: 'Customer one-to-many Order: places\nOrder many-to-many Product: contains',
  },
  timeline: {
    title: 'Company milestones',
    events: '2023: Founded; First hire\n2024: Product launch\n2025: 1000 customers; Series A',
  },
  mindmap: 'Project Plan\n  Research\n    Competitors\n    User interviews\n  Design\n    Wireframes\n  Build\n    MVP\n    Beta',
  quadrant: {
    title: 'Effort vs Impact',
    xleft: 'Low Effort', xright: 'High Effort',
    ybottom: 'Low Impact', ytop: 'High Impact',
    q1: 'Strategic bets', q2: 'Quick wins', q3: 'Skip', q4: 'Money pits',
    points: 'Dark mode: 0.2, 0.7\nRewrite backend: 0.9, 0.8\nNew logo: 0.3, 0.2',
  },
};

function loadBuilderExample() {
  const type = document.getElementById('builder-type').value;
  if (type === 'flowchart') {
    document.getElementById('builder-flow-direction').value = BUILDER_EXAMPLES.flowchart.direction;
    document.getElementById('builder-flow-steps').value = BUILDER_EXAMPLES.flowchart.steps;
  } else if (type === 'sequence') {
    document.getElementById('builder-seq-messages').value = BUILDER_EXAMPLES.sequence;
  } else if (type === 'pie') {
    document.getElementById('builder-pie-title').value = BUILDER_EXAMPLES.pie.title;
    document.getElementById('builder-pie-data').value = BUILDER_EXAMPLES.pie.data;
  } else if (type === 'gantt') {
    document.getElementById('builder-gantt-title').value = BUILDER_EXAMPLES.gantt.title;
    document.getElementById('builder-gantt-start').value = localToday();
    document.getElementById('builder-gantt-tasks').value = BUILDER_EXAMPLES.gantt.tasks;
  } else if (type === 'class') {
    document.getElementById('builder-class-classes').value = BUILDER_EXAMPLES.class.classes;
    document.getElementById('builder-class-relations').value = BUILDER_EXAMPLES.class.relations;
  } else if (type === 'state') {
    document.getElementById('builder-state-transitions').value = BUILDER_EXAMPLES.state;
  } else if (type === 'journey') {
    document.getElementById('builder-journey-title').value = BUILDER_EXAMPLES.journey.title;
    document.getElementById('builder-journey-actor').value = BUILDER_EXAMPLES.journey.actor;
    document.getElementById('builder-journey-tasks').value = BUILDER_EXAMPLES.journey.tasks;
  } else if (type === 'er') {
    document.getElementById('builder-er-entities').value = BUILDER_EXAMPLES.er.entities;
    document.getElementById('builder-er-relations').value = BUILDER_EXAMPLES.er.relations;
  } else if (type === 'timeline') {
    document.getElementById('builder-timeline-title').value = BUILDER_EXAMPLES.timeline.title;
    document.getElementById('builder-timeline-events').value = BUILDER_EXAMPLES.timeline.events;
  } else if (type === 'mindmap') {
    document.getElementById('builder-mindmap-outline').value = BUILDER_EXAMPLES.mindmap;
  } else if (type === 'quadrant') {
    const q = BUILDER_EXAMPLES.quadrant;
    document.getElementById('builder-quadrant-title').value = q.title;
    document.getElementById('builder-quadrant-xleft').value = q.xleft;
    document.getElementById('builder-quadrant-xright').value = q.xright;
    document.getElementById('builder-quadrant-ybottom').value = q.ybottom;
    document.getElementById('builder-quadrant-ytop').value = q.ytop;
    document.getElementById('builder-quadrant-q1').value = q.q1;
    document.getElementById('builder-quadrant-q2').value = q.q2;
    document.getElementById('builder-quadrant-q3').value = q.q3;
    document.getElementById('builder-quadrant-q4').value = q.q4;
    document.getElementById('builder-quadrant-points').value = q.points;
  }
  updateBuilderCode();
}

// Escape a label for use inside a quoted Mermaid node/segment label
function mermaidLabel(s) {
  return String(s).replace(/"/g, '#quot;');
}

function generateBuilderCode() {
  const type = document.getElementById('builder-type').value;

  if (type === 'flowchart') {
    const direction = document.getElementById('builder-flow-direction').value;
    const steps = document.getElementById('builder-flow-steps').value
      .split('\n').map(s => s.trim()).filter(s => s);
    if (steps.length === 0) return '';

    const idFor = (i) => {
      // A, B, ... Z, AA, AB ... for arbitrarily many steps
      let n = i, id = '';
      do { id = String.fromCharCode(65 + (n % 26)) + id; n = Math.floor(n / 26) - 1; } while (n >= 0);
      return id;
    };

    const lines = [`flowchart ${direction}`];
    steps.forEach((step, i) => {
      const isDecision = /\?\s*$/.test(step);
      const label = mermaidLabel(step);
      lines.push(isDecision ? `    ${idFor(i)}{"${label}"}` : `    ${idFor(i)}["${label}"]`);
    });
    for (let i = 0; i < steps.length - 1; i++) {
      lines.push(`    ${idFor(i)} --> ${idFor(i + 1)}`);
    }
    return lines.join('\n');
  }

  if (type === 'sequence') {
    const rows = document.getElementById('builder-seq-messages').value
      .split('\n').map(s => s.trim()).filter(s => s);
    if (rows.length === 0) return '';

    const lines = ['sequenceDiagram'];
    rows.forEach(row => {
      const m = row.match(/^(.+?)\s*(-->|->)\s*(.+?)\s*:\s*(.+)$/);
      if (m) {
        const arrow = m[2] === '-->' ? '-->>' : '->>';
        lines.push(`    ${m[1].trim()}${arrow}${m[3].trim()}: ${m[4].trim()}`);
      } else {
        lines.push(`    %% Could not read: ${row} (expected "From -> To: message")`);
      }
    });
    return lines.join('\n');
  }

  if (type === 'pie') {
    const title = document.getElementById('builder-pie-title').value.trim();
    const rows = document.getElementById('builder-pie-data').value
      .split('\n').map(s => s.trim()).filter(s => s);
    if (rows.length === 0) return '';

    const lines = [title ? `pie title ${title}` : 'pie'];
    rows.forEach(row => {
      const m = row.match(/^(.+?)\s*[:=]\s*([\d.]+)\s*$/);
      if (m) {
        lines.push(`    "${mermaidLabel(m[1].trim())}" : ${m[2]}`);
      }
    });
    return lines.length > 1 ? lines.join('\n') : '';
  }

  if (type === 'gantt') {
    const title = document.getElementById('builder-gantt-title').value.trim();
    const start = document.getElementById('builder-gantt-start').value || localToday();
    const rows = document.getElementById('builder-gantt-tasks').value
      .split('\n').map(s => s.trim()).filter(s => s);
    if (rows.length === 0) return '';

    const lines = ['gantt'];
    if (title) lines.push(`    title ${title}`);
    lines.push('    dateFormat YYYY-MM-DD', '    section Tasks');
    let prevId = '';
    rows.forEach((row, i) => {
      const m = row.match(/^(.+?)\s*[:=]\s*(\d+)\s*d?\s*$/);
      if (!m) return;
      const id = `t${i + 1}`;
      const when = prevId ? `after ${prevId}` : start;
      lines.push(`    ${m[1].trim()} :${id}, ${when}, ${m[2]}d`);
      prevId = id;
    });
    return lines.length > 3 ? lines.join('\n') : '';
  }

  if (type === 'class') {
    const classRows = document.getElementById('builder-class-classes').value
      .split('\n').map(s => s.trim()).filter(s => s);
    const relRows = document.getElementById('builder-class-relations').value
      .split('\n').map(s => s.trim()).filter(s => s);
    if (classRows.length === 0 && relRows.length === 0) return '';

    const lines = ['classDiagram'];
    classRows.forEach(row => {
      const m = row.match(/^([A-Za-z_][\w]*)\s*(?::\s*(.*))?$/);
      if (!m) return;
      const name = m[1];
      const members = (m[2] || '').split(',').map(s => s.trim()).filter(s => s);
      if (members.length === 0) {
        lines.push(`    class ${name}`);
      } else {
        lines.push(`    class ${name} {`);
        members.forEach(member => lines.push(`        +${member}`));
        lines.push('    }');
      }
    });
    relRows.forEach(row => {
      // "Parent <- Child" = inheritance, "A -> B" = association, "A - B" = link
      let m = row.match(/^(\w+)\s*<-\s*(\w+)$/);
      if (m) { lines.push(`    ${m[1]} <|-- ${m[2]}`); return; }
      m = row.match(/^(\w+)\s*->\s*(\w+)$/);
      if (m) { lines.push(`    ${m[1]} --> ${m[2]}`); return; }
      m = row.match(/^(\w+)\s*-\s*(\w+)$/);
      if (m) { lines.push(`    ${m[1]} -- ${m[2]}`); }
    });
    return lines.length > 1 ? lines.join('\n') : '';
  }

  if (type === 'state') {
    const rows = document.getElementById('builder-state-transitions').value
      .split('\n').map(s => s.trim()).filter(s => s);
    if (rows.length === 0) return '';

    const lines = ['stateDiagram-v2'];
    let firstState = '';
    rows.forEach(row => {
      const m = row.match(/^(.+?)\s*->\s*(.+?)(?:\s*:\s*(.+))?$/);
      if (!m) return;
      const from = m[1].trim().replace(/\s+/g, '_');
      const to = m[2].trim().replace(/\s+/g, '_');
      if (!firstState) firstState = from;
      lines.push(`    ${from} --> ${to}${m[3] ? `: ${m[3].trim()}` : ''}`);
    });
    if (firstState) {
      lines.splice(1, 0, `    [*] --> ${firstState}`);
    }
    return lines.length > 1 ? lines.join('\n') : '';
  }

  if (type === 'journey') {
    const title = document.getElementById('builder-journey-title').value.trim();
    const actor = document.getElementById('builder-journey-actor').value.trim() || 'Me';
    const rows = document.getElementById('builder-journey-tasks').value
      .split('\n').map(s => s.trim()).filter(s => s);
    if (rows.length === 0) return '';

    const lines = ['journey'];
    if (title) lines.push(`    title ${title}`);
    lines.push('    section Steps');
    rows.forEach(row => {
      const m = row.match(/^(.+?)\s*[:=]\s*([1-5])\s*$/);
      if (m) {
        lines.push(`      ${m[1].trim()}: ${m[2]}: ${actor}`);
      }
    });
    return lines.length > 2 ? lines.join('\n') : '';
  }

  if (type === 'er') {
    const entityRows = document.getElementById('builder-er-entities').value
      .split('\n').map(s => s.trim()).filter(s => s);
    const relRows = document.getElementById('builder-er-relations').value
      .split('\n').map(s => s.trim()).filter(s => s);
    if (entityRows.length === 0 && relRows.length === 0) return '';

    const entityName = (s) => s.trim().replace(/\s+/g, '_');
    const lines = ['erDiagram'];
    entityRows.forEach(row => {
      const m = row.match(/^(.+?)\s*:\s*(.*)$/);
      const name = entityName(m ? m[1] : row);
      const attrs = m ? m[2].split(',').map(a => a.trim()).filter(a => a) : [];
      if (attrs.length === 0) {
        lines.push(`    ${name} {`, '    }');
        return;
      }
      lines.push(`    ${name} {`);
      attrs.forEach(attr => {
        const parts = attr.split(/\s+/);
        // "int id" keeps its type; a bare "id" is typed string
        if (parts.length >= 2) {
          lines.push(`        ${parts[0]} ${parts.slice(1).join('_')}`);
        } else {
          lines.push(`        string ${parts[0]}`);
        }
      });
      lines.push('    }');
    });

    const CARDINALITY = {
      'one-to-one': '||--||', '1-1': '||--||',
      'one-to-many': '||--o{', '1-n': '||--o{',
      'many-to-one': '}o--||', 'n-1': '}o--||',
      'many-to-many': '}o--o{', 'n-n': '}o--o{',
    };
    relRows.forEach(row => {
      const m = row.match(/^(.+?)\s+(one-to-one|one-to-many|many-to-one|many-to-many|1-1|1-n|n-1|n-n)\s+(.+?)(?:\s*:\s*(.+))?$/i);
      if (!m) return;
      const symbol = CARDINALITY[m[2].toLowerCase()];
      lines.push(`    ${entityName(m[1])} ${symbol} ${entityName(m[3])} : "${mermaidLabel(m[4] || 'has')}"`);
    });
    return lines.length > 1 ? lines.join('\n') : '';
  }

  if (type === 'timeline') {
    const title = document.getElementById('builder-timeline-title').value.trim();
    const rows = document.getElementById('builder-timeline-events').value
      .split('\n').map(s => s.trim()).filter(s => s);
    if (rows.length === 0) return '';

    const lines = ['timeline'];
    if (title) lines.push(`    title ${title}`);
    rows.forEach(row => {
      const m = row.match(/^(.+?)\s*:\s*(.+)$/);
      if (!m) return;
      const events = m[2].split(';').map(e => e.trim()).filter(e => e);
      if (events.length) {
        lines.push(`    ${m[1].trim()} : ${events.join(' : ')}`);
      }
    });
    return lines.length > 1 ? lines.join('\n') : '';
  }

  if (type === 'mindmap') {
    const rawLines = document.getElementById('builder-mindmap-outline').value
      .split('\n').filter(l => l.trim());
    if (rawLines.length === 0) return '';

    const lines = ['mindmap'];
    const rootLabel = rawLines[0].trim().replace(/[()]/g, '');
    lines.push(`  root((${rootLabel}))`);
    let prevDepth = 0;
    rawLines.slice(1).forEach(raw => {
      const leading = raw.match(/^\s*/)[0].length;
      // two spaces per level, clamped so children never skip a generation
      let depth = Math.min(Math.floor(leading / 2) + 1, prevDepth + 1);
      if (depth < 1) depth = 1;
      prevDepth = depth;
      lines.push(`${'  '.repeat(depth + 1)}${raw.trim().replace(/[()]/g, '')}`);
    });
    return lines.length > 2 ? lines.join('\n') : (lines.length === 2 ? lines.join('\n') : '');
  }

  if (type === 'quadrant') {
    const title = document.getElementById('builder-quadrant-title').value.trim();
    const xLeft = document.getElementById('builder-quadrant-xleft').value.trim() || 'Low';
    const xRight = document.getElementById('builder-quadrant-xright').value.trim() || 'High';
    const yBottom = document.getElementById('builder-quadrant-ybottom').value.trim() || 'Low';
    const yTop = document.getElementById('builder-quadrant-ytop').value.trim() || 'High';
    const q1 = document.getElementById('builder-quadrant-q1').value.trim() || 'Quadrant 1';
    const q2 = document.getElementById('builder-quadrant-q2').value.trim() || 'Quadrant 2';
    const q3 = document.getElementById('builder-quadrant-q3').value.trim() || 'Quadrant 3';
    const q4 = document.getElementById('builder-quadrant-q4').value.trim() || 'Quadrant 4';
    const rows = document.getElementById('builder-quadrant-points').value
      .split('\n').map(s => s.trim()).filter(s => s);
    if (rows.length === 0) return '';

    const clamp01 = (v) => Math.max(0, Math.min(1, parseFloat(v) || 0));
    const lines = ['quadrantChart'];
    if (title) lines.push(`    title ${title}`);
    lines.push(`    x-axis ${xLeft} --> ${xRight}`);
    lines.push(`    y-axis ${yBottom} --> ${yTop}`);
    lines.push(`    quadrant-1 ${q1}`, `    quadrant-2 ${q2}`, `    quadrant-3 ${q3}`, `    quadrant-4 ${q4}`);
    rows.forEach(row => {
      const m = row.match(/^(.+?)\s*:\s*([\d.]+)\s*,\s*([\d.]+)\s*$/);
      if (m) {
        lines.push(`    ${m[1].trim()}: [${clamp01(m[2])}, ${clamp01(m[3])}]`);
      }
    });
    return lines.length > 7 ? lines.join('\n') : '';
  }

  if (type === 'custom') {
    // Raw-code mode: the code textarea is the source of truth
    return document.getElementById('builder-code').value;
  }

  return '';
}

function updateBuilderCode() {
  const code = generateBuilderCode();
  document.getElementById('builder-code').value = code;
  scheduleBuilderPreview();
}

function scheduleBuilderPreview() {
  if (builderPreviewTimer) clearTimeout(builderPreviewTimer);
  builderPreviewTimer = setTimeout(renderBuilderPreview, 250);
}

async function renderBuilderPreview() {
  const code = document.getElementById('builder-code').value.trim();
  const preview = document.getElementById('builder-preview');
  const errorBox = document.getElementById('builder-error');

  if (!code) {
    preview.innerHTML = '<div class="builder-preview-placeholder">Fill in the form to see your diagram</div>';
    errorBox.style.display = 'none';
    return;
  }
  try {
    await ensureMermaid();
    const { svg } = await window.mermaid.render(`builder-preview-svg-${++builderRenderCounter}`, code);
    preview.innerHTML = svg;
    errorBox.style.display = 'none';
  } catch (err) {
    // Keep the last good preview visible; surface the parse error below it
    errorBox.innerText = (err && err.message) ? err.message : String(err);
    errorBox.style.display = 'block';
    // Mermaid can leave a temp error element behind on failed renders
    const stray = document.getElementById(`dbuilder-preview-svg-${builderRenderCounter}`);
    if (stray) stray.remove();
  }
}

function insertBuilderDiagram() {
  const code = document.getElementById('builder-code').value.trim();
  if (!code) {
    alert('The diagram is empty — fill in the form first.');
    return;
  }
  if (!activeNote) {
    alert('Open a note first, then insert the diagram.');
    return;
  }

  const textarea = document.getElementById('note-editor');
  const fenced = `\`\`\`mermaid\n${code}\n\`\`\``;

  // Update-in-place when launched from a rendered block's Edit button
  if (builderEditContext) {
    const range = findMermaidFenceRange(textarea.value, builderEditContext.line, builderEditContext.originalSrc);
    if (range) {
      replaceEditorRange(textarea, range.charStart, range.charEnd, fenced);
      hideMermaidBuilder();
      if (viewMode === 'preview') {
        setViewMode('split');
      } else if (viewMode === 'split') {
        renderMarkdownPreview();
      }
      textarea.focus();
      return;
    }
    showToast('Couldn’t find the original diagram — inserting at the cursor instead.', 'error');
  }

  replaceEditorRange(textarea, textarea.selectionStart, textarea.selectionEnd, `\n${fenced}\n`);
  hideMermaidBuilder();

  // Make sure the user sees the result immediately
  if (viewMode === 'preview') {
    setViewMode('split');
  } else if (viewMode === 'split') {
    renderMarkdownPreview();
  }
  textarea.focus();
}

// --- Drag & Drop Handlers ---
let dragSourcePath = null;

function handleDragStart(e, fsPath) {
  dragSourcePath = fsPath;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', fsPath);
  e.stopPropagation();
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.stopPropagation();
  const node = e.currentTarget;
  if (node && node.classList && !node.classList.contains('drag-over')) {
    node.classList.add('drag-over');
  }
}

function handleDragLeave(e) {
  e.stopPropagation();
  const node = e.currentTarget;
  if (node && node.classList) {
    node.classList.remove('drag-over');
  }
}

async function handleDrop(e, targetFsPath) {
  e.preventDefault();
  e.stopPropagation();
  const node = e.currentTarget;
  if (node && node.classList) {
    node.classList.remove('drag-over');
  }
  
  const srcPath = dragSourcePath;
  if (!srcPath || !targetFsPath || srcPath === targetFsPath) return;

  const success = await window.api.relocateNode(srcPath, targetFsPath);
  if (success) {
    await refreshNotebook();
    if (activeNote === srcPath) {
      closeNoteCanvas();
    }
  }
}

// --- Drag & drop onto PAGE rows: reorder within a section, or move across ---
function nodeParentDir(fsPath) {
  const i = Math.max(fsPath.lastIndexOf('/'), fsPath.lastIndexOf('\\'));
  return i > 0 ? fsPath.slice(0, i) : fsPath;
}

// Whether the pointer is in the top half of the row = insert BEFORE it
function pageDropBefore(e, row) {
  if (!row || typeof row.getBoundingClientRect !== 'function') return true;
  const rect = row.getBoundingClientRect();
  return (e.clientY - rect.top) < rect.height / 2;
}

function handlePageDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  const row = e.currentTarget;
  const before = pageDropBefore(e, row);
  if (row && row.classList) {
    row.classList.toggle('drag-over-top', before);
    row.classList.toggle('drag-over-bottom', !before);
  }
}

function handlePageDragLeave(e) {
  e.stopPropagation();
  const row = e.currentTarget;
  if (row && row.classList) row.classList.remove('drag-over-top', 'drag-over-bottom');
}

async function handlePageDrop(e, dirPath, targetName) {
  e.preventDefault();
  e.stopPropagation();
  const row = e.currentTarget;
  const before = pageDropBefore(e, row);
  if (row && row.classList) row.classList.remove('drag-over-top', 'drag-over-bottom');

  const srcPath = dragSourcePath;
  if (!srcPath) return;
  const srcDir = nodeParentDir(srcPath);
  const srcName = srcPath.slice(srcDir.length + 1);

  if (!/\.md$/i.test(srcPath)) {
    // A section dropped onto a page row: move it into that page's folder
    if (srcDir !== dirPath && srcPath !== dirPath) {
      const ok = await window.api.relocateNode(srcPath, dirPath);
      if (ok) await refreshNotebook();
    }
    return;
  }

  if (srcDir === dirPath) {
    // Same section: rewrite the order file with the page in its new slot
    if (srcName.toLowerCase() === targetName.toLowerCase()) return;
    const section = findSectionByFsPath(treeData, dirPath);
    if (!section) return;
    const ord = section.pages.map(p => p.name).filter(n => n.toLowerCase() !== srcName.toLowerCase());
    let ti = ord.findIndex(n => n.toLowerCase() === targetName.toLowerCase());
    if (ti === -1) return;
    if (!before) ti += 1;
    ord.splice(ti, 0, srcName);
    const ok = await window.api.setNodeOrder(dirPath, ord);
    if (ok) await refreshNotebook();
  } else {
    // Different section: move the page there (lands at the default position)
    const ok = await window.api.relocateNode(srcPath, dirPath);
    if (ok) {
      await refreshNotebook();
      if (activeNote === srcPath) closeNoteCanvas();
    }
  }
}
