// Markdown Notebook Renderer App
 
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
 
// Initialize App
document.addEventListener('DOMContentLoaded', async () => {
  // Load settings
  appSettings = await window.api.getSettings();
  autoSaveEnabled = appSettings.autoSaveEnabled || false;
  document.getElementById('header-autosave').checked = autoSaveEnabled;
  
  // Set theme from settings
  applyTheme(appSettings.previewTheme);
 
  if (appSettings.notebookRoot) {
    notebookRoot = appSettings.notebookRoot;
    document.getElementById('onboarding').classList.remove('active');
    document.getElementById('settings-root-path').value = notebookRoot;
    await refreshNotebook();
  } else {
    document.getElementById('onboarding').classList.add('active');
  }

  // File watcher setup (auto refresh)
  window.api.onFilesChanged(async () => {
    await refreshNotebook(false); // refresh tree without resetting active note
  });

  // Initialize Mermaid
  if (window.mermaid) {
    const isDark = document.body.classList.contains('dark-theme');
    window.mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'default',
      securityLevel: 'loose'
    });
  }

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
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const isCmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

  if (isCmdOrCtrl && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveActiveNote();
  } else if (isCmdOrCtrl && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    toggleCommandPalette();
  } else if (isCmdOrCtrl && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    if (notebookRoot) promptCreatePage(notebookRoot);
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
  }
}

// Apply theme helper
function applyTheme(theme) {
  const body = document.body;
  let isDark = false;
  if (theme === 'github-dark') {
    body.className = 'dark-theme';
    isDark = true;
  } else if (theme === 'off') {
    body.className = 'light-theme';
    isDark = false;
  } else {
    // auto detect system light/dark
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (systemDark) {
      body.className = 'dark-theme';
      isDark = true;
    } else {
      body.className = 'light-theme';
      isDark = false;
    }
  }

  if (window.mermaid) {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'default',
      securityLevel: 'loose'
    });
    // Force re-render of note preview so Mermaid charts update colors
    if (activeNote && viewMode !== 'edit') {
      renderMarkdownPreview();
    }
  }
}

async function toggleGlobalTheme() {
  const body = document.body;
  const isDark = body.classList.contains('dark-theme');
  const newTheme = isDark ? 'off' : 'github-dark';
  applyTheme(newTheme);
  
  if (appSettings) {
    appSettings.previewTheme = newTheme;
    await window.api.saveSettings(appSettings);
    document.getElementById('settings-theme').value = newTheme;
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

// Recursive tag scanner
function scanGlobalTags(node) {
  if (!node) return;
  if (node.kind === 'section') {
    node.pages.forEach(p => p.tags.forEach(t => tagSet.add(t)));
    node.sections.forEach(s => scanGlobalTags(s));
  }
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
             ondragstart="handleDragStart(event, ${jsArg(page.fsPath)})">
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
            <button class="tree-node-btn" onclick="event.stopPropagation(); promptRenameNode(${jsArg(page.fsPath)}, ${jsArg(page.title)})" title="Rename">
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

// Search handler
function handleSearch(val) {
  searchQuery = val;
  renderSidebarTree();
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

    renderActiveNote();
    
    // Render sidebar active selection state
    renderSidebarTree();

    // Reset view to default preview
    setViewMode('preview');
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
  const renderedHtml = window.api.renderMarkdown(noteContent);
  preview.innerHTML = renderedHtml;

  // Remember each diagram's source before Mermaid replaces it with an SVG,
  // so the popout viewer can re-render it at full quality later.
  preview.querySelectorAll('.notebook-mermaid').forEach(el => {
    el.dataset.mermaidSrc = el.textContent;
  });

  // Intercept click event on checklists in preview mode
  preview.querySelectorAll('.task-checkbox-link').forEach(link => {
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      const lineIdx = parseInt(link.getAttribute('data-line'), 10);
      if (isNaN(lineIdx)) return;
      
      const success = await window.api.toggleTaskAtLine(activeNote, lineIdx);
      if (success) {
        // Read file contents refreshed
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
  if (window.mermaid) {
    try {
      await window.mermaid.run({
        querySelector: '#preview-pane .notebook-mermaid',
      });
    } catch (err) {
      console.error('Mermaid render error:', err);
    }

    // Inject zoom interactions or hover styling for diagrams
    preview.querySelectorAll('.mermaid-block-container').forEach(container => {
      const diagram = container.querySelector('.notebook-mermaid');
      if (diagram) {
        diagram.style.zoom = (appSettings.defaultMermaidZoom / 100);
        const svg = diagram.querySelector('svg');
        if (svg) {
          svg.style.maxWidth = '100%';
          svg.style.height = 'auto';
        }
      }
    });
  }
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

// Set view layout modes
function setViewMode(mode) {
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
    renderMarkdownPreview();
    if (activeNote && noteContent !== noteOriginalContent) {
      saveActiveNote();
    }
  }
}

// Editor interaction handling
function handleEditorInput() {
  const textarea = document.getElementById('note-editor');
  noteContent = textarea.value;
  updateLineNumbers();
  updateWordCount();
  updateSaveStatus(true);

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
}

// Line Numbers counter
function updateLineNumbers() {
  const textarea = document.getElementById('note-editor');
  const lineNumbers = document.getElementById('line-numbers');
  const lines = textarea.value.split('\n').length;
  let html = '';
  for (let i = 1; i <= lines; i++) {
    html += `<div>${i}</div>`;
  }
  lineNumbers.innerHTML = html;
  syncEditorScroll(); // rebuilding the gutter resets its scroll position
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

// Auto save active note
async function saveActiveNote() {
  if (!activeNote || noteContent === noteOriginalContent) return;
  await window.api.writeNote(activeNote, noteContent);
  noteOriginalContent = noteContent;
  updateSaveStatus(false);
  
  // Re-load notebook metadata updates
  await refreshNotebook(false);
}

// Handle special keys inside editor
function handleEditorKeys(e) {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const isCmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

  if (isCmdOrCtrl) {
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

    textarea.value = text.slice(0, lineStart) + changed + text.slice(end);
    textarea.selectionStart = Math.max(lineStart, start + firstLineDelta);
    textarea.selectionEnd = Math.max(lineStart, end + totalDelta);
  } else {
    // Plain cursor: insert an indent step at the caret
    textarea.value = text.slice(0, start) + EDITOR_INDENT + text.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + EDITOR_INDENT.length;
  }
  handleEditorInput();
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
      const insertion = '\n' + indentMatch[0];
      textarea.value = text.slice(0, start) + insertion + text.slice(end);
      textarea.selectionStart = textarea.selectionEnd = start + insertion.length;
      handleEditorInput();
      return true;
    }
    return false;
  }

  const [, indent, marker, spacing, checkbox, content] = m;

  // Empty list item: pressing Enter ends the list (removes the marker)
  if (!content.trim()) {
    textarea.value = text.slice(0, lineStart) + text.slice(start);
    textarea.selectionStart = textarea.selectionEnd = lineStart;
    handleEditorInput();
    return true;
  }

  // Continue the list at the same indentation (incrementing ordered markers)
  let nextMarker = marker;
  const num = marker.match(/^(\d+)([.)])$/);
  if (num) {
    nextMarker = (parseInt(num[1], 10) + 1) + num[2];
  }
  const insertion = '\n' + indent + nextMarker + spacing + (checkbox ? '[ ] ' : '');
  textarea.value = text.slice(0, start) + insertion + text.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + insertion.length;
  handleEditorInput();
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
    const title = el.getAttribute('title');
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
  if (isOpen) {
    updateOutlineAndBacklinks();
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

    // 2b. Scan notebook-wide incoming backlinks
    if (!treeData) return;
    const noteBaseName = pathBasename(activeNote, '.md');
    const activeNoteName = pathBasename(activeNote);
    
    // Gather all pages recursively in the entire notebook for complete backlinks check
    const allPages = gatherPagesRecursively(treeData);
    const templatesDir = appSettings.templatesFolder;
    
    allPages.forEach(async (page) => {
      if (!page || !page.fsPath || page.fsPath === activeNote) return;
      if (templatesDir && page.relPath && page.relPath.startsWith(templatesDir + '/')) return;

      try {
        const fileText = await window.api.readNote(page.fsPath);
        const escapeBaseName = escapeRegex(noteBaseName || '');
        const escapeFullName = escapeRegex(activeNoteName || '');
        
        const wikiRegex = new RegExp(`\\[\\[${escapeBaseName}(\\||#|\\]\\])`, 'i');
        const mdRegex = new RegExp(`\\(\\.*\\/?.*?${escapeFullName}\\)`, 'i');
        
        if (wikiRegex.test(fileText) || mdRegex.test(fileText)) {
          const pill = document.createElement('span');
          pill.className = 'backlink-pill';
          pill.innerHTML = `
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:2px;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            ${page.title}
          `;
          pill.title = `Go to: ${page.title}`;
          pill.onclick = (e) => {
            e.stopPropagation();
            if (page.fsPath) {
              openNote(page.fsPath);
            }
          };
          backlinksList.appendChild(pill);
          backlinksContainer.style.display = 'flex';
        }
      } catch (err) {
        console.error('Error scanning backlinks for page:', page.fsPath, err);
      }
    });
  }
}

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
  document.getElementById('settings-theme').value = appSettings.previewTheme;
  document.getElementById('settings-templates-folder').value = appSettings.templatesFolder;
  document.getElementById('settings-author').value = appSettings.author;
  document.getElementById('settings-pandoc-path').value = appSettings.pandocPath || '';
  document.getElementById('settings-ignore-folders').value = appSettings.ignoreFolders.join(', ');
  document.getElementById('settings-autosave').checked = autoSaveEnabled;
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
  const ignore = document.getElementById('settings-ignore-folders').value.split(',').map(s => s.trim()).filter(s => s);
  const autosave = document.getElementById('settings-autosave').checked;

  appSettings = await window.api.saveSettings({
    defaultPageWidth: width,
    defaultMermaidZoom: zoom,
    previewTheme: theme,
    templatesFolder: templates,
    author: author,
    pandocPath: pandocPath,
    scratchpadFile: appSettings.scratchpadFile,
    ignoreFolders: ignore,
    autoSaveEnabled: autosave,
  });

  applyTheme(theme);
  toggleAutoSave(autosave);
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
  document.getElementById('create-modal-template-group').style.display = 'block';
  document.getElementById('create-modal-date').value = localToday();
  document.getElementById('create-modal-tags').value = '';

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
    const newPath = await window.api.createPage(dest, name, template, collectModalMeta());
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
    // dest holds the fsPath of the node being renamed
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
    await window.api.createSection(dest, name);
    hideCreateModal();
    await refreshNotebook();
  }
}

// Rename nodes dialog (window.prompt is not supported in Electron,
// so this reuses the create modal in "rename" mode)
function promptRenameNode(fsPath, currentName) {
  document.getElementById('create-modal-title').innerText = 'Rename';
  document.getElementById('create-modal-name-label').innerText = 'New Name';
  document.getElementById('create-modal-name').value = currentName || '';
  
  document.getElementById('create-modal-dest-group').style.display = 'none';
  document.getElementById('create-modal-rename-path').value = fsPath;
  
  document.getElementById('create-modal-type').value = 'rename';
  document.getElementById('create-modal-page-options').style.display = 'none';

  document.getElementById('create-modal').classList.add('active');
  setTimeout(() => {
    const input = document.getElementById('create-modal-name');
    input.focus();
    input.select();
  }, 100);
}

async function promptRenameCurrent() {
  if (!activeNote) return;
  const node = findNodeByPath(treeData, activeNote);
  const currentTitle = node ? node.title : pathBasename(activeNote, '.md');
  await promptRenameNode(activeNote, currentTitle);
}

// Delete note node dialog
async function deleteNode(fsPath) {
  const isDir = fsPath && !fsPath.endsWith('.md');
  const confirmMsg = isDir 
    ? 'Are you sure you want to delete this section folder and ALL files inside it permanently?' 
    : 'Are you sure you want to delete this note page?';
    
  if (confirm(confirmMsg)) {
    const success = await window.api.deleteNode(fsPath);
    if (success) {
      if (activeNote === fsPath) {
        closeNoteCanvas();
      }
      await refreshNotebook();
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

// Native PDF Export
async function exportToPdf() {
  if (!activeNote) return;
  const preview = document.getElementById('preview-pane');

  // Sanitize a copy of the rendered note for print: strip interactive UI and
  // reset Mermaid SVG sizing. On screen the SVGs are stretched to 100% width,
  // which in print blows tall diagrams up over multiple pages and produces
  // blank pages around them; exporting at natural (viewBox) size fixes that.
  const clone = preview.cloneNode(true);
  clone.querySelectorAll('.mermaid-actions-bar, .code-block-copy-btn').forEach(el => el.remove());
  clone.querySelectorAll('.notebook-mermaid').forEach(pre => {
    pre.style.zoom = '';
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

  const success = await window.api.exportToPdf(activeNote, clone.innerHTML);
  if (success) {
    alert('Note exported as PDF successfully!');
  }
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

async function getPendingTasksForPages(pages) {
  const tasks = [];
  for (const page of pages) {
    try {
      const content = await window.api.readNote(page.fsPath);
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        const checkboxRegex = /^([ \t]*([-*+]\s+|\d+\.\s+)?)\[ \]/i;
        if (checkboxRegex.test(line)) {
          const text = line.replace(checkboxRegex, '').trim();
          tasks.push({
            fsPath: page.fsPath,
            title: page.title,
            text: text,
            lineIndex: index
          });
        }
      });
    } catch {}
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
  document.getElementById('landing-subtitle').innerText = `Directory: ${sectionNode.relPath || 'Notebook Root'}`;
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
        <span class="task-badge" style="background-color: rgba(255,255,255,0.06); font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 4px; color: var(--text-secondary);">
          ${p.completedTasks}/${taskTotal} Done
        </span>
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
        <span class="task-badge" style="background-color: rgba(255,255,255,0.06); font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 4px; color: var(--text-secondary);">
          ${p.completedTasks}/${taskTotal} Done
        </span>
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
  const pre = container.querySelector('.notebook-mermaid');
  if (!pre) return;
  
  let currentZoom = parseFloat(pre.style.zoom) || 1;
  let newZoom = Math.max(0.4, Math.min(3.0, currentZoom + (amount / 100)));
  pre.style.zoom = newZoom;
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
    if (source && window.mermaid) {
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

  // Start fitted to the visible area; don't blow small diagrams up past 150%
  const available = popoutBody.clientWidth - 80;
  const fit = Math.round((available / popoutBaseWidth) * 100);
  popoutZoomLevel = Math.max(40, Math.min(150, fit || 100));
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

  if (paletteFilteredItems.length === 0) {
    listContainer.innerHTML = `<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:16px;">No pages or commands matching query</div>`;
    return;
  }

  paletteFilteredItems.forEach((item, idx) => {
    const el = document.createElement('div');
    el.className = `palette-item ${idx === paletteSelectedIndex ? 'selected' : ''}`;
    el.innerHTML = `
      <div class="palette-item-content">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: ${item.subtitle.startsWith('Action:') ? 'var(--accent-teal)' : 'var(--accent-blue)'};">
          ${item.subtitle.startsWith('Action:') 
            ? '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>' 
            : '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'}
        </svg>
        <span class="palette-item-label">${item.label}</span>
      </div>
      <span class="palette-item-shortcut">${item.subtitle}</span>
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

  document.getElementById('create-modal').classList.add('active');
  setTimeout(() => document.getElementById('create-modal-name').focus(), 100);
}

// ==========================================
// MERMAID DIAGRAM BUILDER
// ==========================================

let builderPreviewTimer = null;
let builderRenderCounter = 0;

function showMermaidBuilder() {
  // Close the mermaid dropdown if it triggered us
  const menu = document.getElementById('dropdown-mermaid');
  if (menu) {
    menu.classList.remove('active');
    const chev = menu.closest('.editor-dropdown').querySelector('.chevron');
    if (chev) chev.style.transform = 'rotate(0deg)';
  }
  document.getElementById('mermaid-builder-modal').classList.add('active');
  updateBuilderCode();
}

function hideMermaidBuilder() {
  document.getElementById('mermaid-builder-modal').classList.remove('active');
}

function switchBuilderType() {
  const type = document.getElementById('builder-type').value;
  document.getElementById('builder-fields-flowchart').style.display = type === 'flowchart' ? 'block' : 'none';
  document.getElementById('builder-fields-sequence').style.display = type === 'sequence' ? 'block' : 'none';
  document.getElementById('builder-fields-pie').style.display = type === 'pie' ? 'block' : 'none';
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
  if (!window.mermaid) return;

  try {
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
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  const insertion = `\n\`\`\`mermaid\n${code}\n\`\`\`\n`;

  textarea.value = text.substring(0, start) + insertion + text.substring(end);
  textarea.selectionStart = textarea.selectionEnd = start + insertion.length;
  handleEditorInput();
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
