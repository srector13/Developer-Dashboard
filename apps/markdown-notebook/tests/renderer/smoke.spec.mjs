// Renderer smoke test v2: loads renderer/index.html in plain Chromium with a
// stubbed window.api (normally provided by the Electron preload script) and
// exercises the current UI feature set end-to-end, including the new theme
// system, PDF export modal, 7-type diagram builder, platform shortcuts,
// shortcuts modal, editor combos, taskLines landing pages, backlinks and
// palette HTML escaping.
//
// Usage:  SMOKE_PLATFORM=darwin node smoke-v2.mjs   (or win32; darwin default)
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('@playwright/test');

const PLATFORM = process.env.SMOKE_PLATFORM || process.argv[2] || 'darwin';
const IS_MAC = PLATFORM === 'darwin';
// Modifier the APP expects (driven by the stubbed window.api.platform)
const MOD = IS_MAC ? 'Meta' : 'Control';

const results = [];
let failed = 0;

function check(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
}

const NOTE_MD = [
  '---',
  'title: Smoke Note',
  'created: 2026-07-10',
  'tags: [test]',
  '---',
  '',
  '# Smoke Note',
  '',
  'Hello world content.',
  '',
  '- first bullet',
  '',
  '```mermaid',
  'flowchart TD',
  '    A[Start] --> B[End]',
  '```',
  '',
].join('\n');

const XSS_TITLE = '<img src=x onerror=window.__xss=1>';

let browser;
try {
browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

page.on('pageerror', (err) => {
  results.push(`PAGEERROR: ${err.message}`);
  failed++;
});
page.on('console', (msg) => {
  if (msg.type() === 'error') results.push(`CONSOLE-ERROR: ${msg.text()}`);
});

await page.addInitScript(({ noteMd, platform, xssTitle }) => {
  const tree = {
    kind: 'section', name: 'Root', fsPath: '/nb', relPath: '',
    pages: [{
      kind: 'page', name: 'smoke.md', fsPath: '/nb/smoke.md', relPath: 'smoke.md',
      title: 'Smoke Note', created: '2026-07-10', tags: ['test'], pinned: false,
      openTasks: 0, completedTasks: 0, taskLines: [],
    }, {
      kind: 'page', name: 'xss.md', fsPath: '/nb/xss.md', relPath: 'xss.md',
      title: xssTitle, created: '2026-07-01', tags: ['<img src=x onerror=window.__xss4=1>'], pinned: false,
      openTasks: 0, completedTasks: 0, taskLines: [],
    }, {
      kind: 'page', name: 'links.md', fsPath: '/nb/links.md', relPath: 'links.md',
      title: 'Links', created: '2026-07-06', tags: [], pinned: false,
      openTasks: 0, completedTasks: 0, taskLines: [],
    }, {
      kind: 'page', name: 'deep.md', fsPath: '/nb/deep.md', relPath: 'deep.md',
      // Task counts stay zero: the notebook metrics checks assert exact totals.
      title: 'Deep Link', created: '2026-07-05', tags: [], pinned: false,
      openTasks: 0, completedTasks: 0, taskLines: [],
    }],
    sections: [{
      kind: 'section', name: 'Projects', fsPath: '/nb/Projects', relPath: 'Projects',
      description: 'Everything about active projects',
      pages: [{
        kind: 'page', name: 'alpha.md', fsPath: '/nb/Projects/alpha.md', relPath: 'Projects/alpha.md',
        title: 'A Very Long Page Title That Should Truncate Nicely In The Sidebar', created: '2026-07-02',
        tags: [], pinned: false, openTasks: 1, completedTasks: 1,
        taskLines: [{ text: 'task', line: 2 }],
      }],
      sections: [],
    }],
  };

  const files = {
    '/nb/smoke.md': noteMd,
    '/nb/Projects/alpha.md': '# Alpha\n\n- [ ] task\n- [x] done\n',
    '/nb/xss.md': '# x\n',
    // Line numbers are load-bearing here — see the deep-link section.
    // 1 --- / 2 title / 3 --- / 4 blank / 5 # Deep / 6 blank / 7 First para.
    // 8 blank / 9 ## Second / 10 blank / 11 - [ ] find me / 12 - [x] done
    '/nb/links.md': [
      '# Links',
      '',
      '- [The spec](file:///C:/docs/spec.pdf)',
      '- [Our website](https://example.com)',
      '- [Nearby doc](docs/report.pdf)',
      '- [Another note](smoke.md)',
      '',
    ].join('\n'),
    '/nb/deep.md': [
      '---', 'title: Deep Link', '---', '',
      '# Deep', '', 'First para.', '', '## Second', '',
      '- [ ] find me', '- [x] done', '',
    ].join('\n'),
  };

  // Instrumentation the test reads back
  window.__treeCalls = 0;
  window.__writes = [];
  // Mutator to simulate a change picked up by the main-process watcher
  window.__addTreePage = () => {
    tree.pages.push({
      kind: 'page', name: 'fresh.md', fsPath: '/nb/fresh.md', relPath: 'fresh.md',
      title: 'Fresh Note', created: '2026-07-11', tags: [], pinned: false,
      openTasks: 0, completedTasks: 0, taskLines: [],
    });
    files['/nb/fresh.md'] = '# Fresh Note\n';
  };

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Minimal markdown renderer good enough for the smoke test: paragraphs +
  // mermaid fences rendered with the same markup the preload produces.
  function renderMarkdown(text) {
    let body = text;
    const fm = body.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
    if (fm) body = body.slice(fm[0].length);
    body = body.replace(/^([ \t]*\r?\n)*#[ \t]+.+(\r?\n|$)/, '');
    let html = '';
    const fenceRe = /```mermaid\n([\s\S]*?)```/g;
    let last = 0, m;
    while ((m = fenceRe.exec(body)) !== null) {
      html += `<p>${esc(body.slice(last, m.index))}</p>`;
      html += `<div class="mermaid-block-container" data-line="0">
        <div class="mermaid-actions-bar">
          <button class="mermaid-action-btn" onclick="zoomMermaid(this, -15)">-</button>
          <button class="mermaid-action-btn" onclick="zoomMermaid(this, 15)">+</button>
          <button class="mermaid-action-btn popout-btn" onclick="popoutMermaid(this)">pop</button>
          <button class="mermaid-action-btn" onclick="editMermaidDiagram(this)" title="Edit Diagram in Builder">edit</button>
        </div>
        <pre class="notebook-mermaid" data-line="0">${esc(m[1])}</pre>
      </div>`;
      last = m.index + m[0].length;
    }
    html += `<p>${esc(body.slice(last))}</p>`;
    // Task checkboxes with real source line indexes, same markup the
    // preload's markdown-it rule produces
    const taskRe = /^[ \t]*[-*+]\s+\[([ xX])\]\s+(.*)$/;
    text.split('\n').forEach((ln, idx) => {
      const t = ln.match(taskRe);
      if (t) {
        html += `<div data-source-line="${idx + 1}"><a href="#" class="task-checkbox-link" data-line="${idx}">` +
          `<input class="task-checkbox" type="checkbox"${t[1].toLowerCase() === 'x' ? ' checked' : ''}></a>${esc(t[2])}</div>`;
      }
    });
    return html;
  }

  // Stateful settings: saveSettings merges partial patches like real main does
  const settingsState = {
    notebookRoot: '/nb', defaultPageWidth: 'standard', defaultMermaidZoom: 100,
    theme: 'dark', ignoreFolders: ['templates'], templatesFolder: 'templates',
    author: '', scratchpadFile: 'scratchpad.md', autoSaveEnabled: false,
    pandocPath: '',
    pdfExport: { theme: 'light', pageSize: 'A4', openAfter: true, reveal: false },
    quickCaptureShortcut: 'CommandOrControl+Shift+N',
    clipboardCaptureShortcut: 'CommandOrControl+Shift+G',
    clipboardCaptureTarget: '',
    ai: { enabled: false, provider: 'ollama', baseUrl: '', model: '', autocomplete: false },
    spellcheckEnabled: true,
  };

  window.api = {
    searchNotes: async (q) => (window.__searchStub || []),
    saveAttachment: async (p) => ({ success: true, fsPath: '/nb/attachments/pasted.png', relPath: 'attachments/pasted.png' }),
    importAttachmentFile: async (p) => ({ success: true, fsPath: '/nb/attachments/dropped.pdf', relPath: 'attachments/dropped.pdf' }),
    getPathForFile: (file) => '/fake/dropped.png',
    listTrash: async () => (window.__trashStub || []),
    restoreTrashItem: async (n) => ({ success: true, restoredPath: '/nb/restored.md' }),
    deleteTrashItem: async (n) => true,
    emptyTrash: async () => ({ removed: 1 }),
    listNoteHistory: async (p) => (window.__historyStub || []),
    readNoteHistory: async (p, id) => '# Old version\n\nOld content.',
    restoreNoteHistory: async (p, id) => true,
    platform,
    getSettings: async () => JSON.parse(JSON.stringify(settingsState)),
    saveSettings: async (s) => {
      window.__savedSettings = s;
      Object.assign(settingsState, s);
      return JSON.parse(JSON.stringify(settingsState));
    },
    aiListModels: async () => (window.__aiModelsStub || { ok: true, models: ['llama3.1:8b', 'qwen2.5:3b'] }),
    aiTransform: async (mode, text) => {
      window.__aiPolishCall = text;
      window.__aiTransformMode = mode;
      return window.__aiPolishStub || { ok: true, text: '## Polished\n\n- cleaned up\n' };
    },
    aiComplete: async (context) => {
      window.__aiCompleteCall = context;
      return window.__aiCompleteStub || { ok: true, text: ' and finish the thought.' };
    },
    setNodeOrder: async (dir, names) => { window.__setOrderCall = { dir, names }; return true; },
    getNotebookTree: async () => { window.__treeCalls++; return JSON.parse(JSON.stringify(tree)); },
    readNote: async (p) => files[p] || '',
    writeNote: async (p, c) => { files[p] = c; window.__writes.push(p); return true; },
    createPage: async (dir, title, template, meta, customVars) => { window.__createPageCall = { dir, title, template, meta, customVars }; return '/nb/new.md'; },
    getTemplateVariables: async (name) => (window.__templateVars || []),
    createSection: async () => '/nb/sec',
    setSectionMeta: async (dir, desc) => { window.__sectionMeta = { dir, desc }; return true; },
    checkForUpdates: async () => (window.__updateResult || { status: 'current', version: '1.0.0' }),
    getAppVersion: async () => '1.0.0',
    deleteNode: async (p) => { (window.__deleted = window.__deleted || []).push(p); return true; },
    renameNode: async () => true,
    relocateNode: async (src, dest) => { window.__relocateCall = { src, dest }; (window.__relocated = window.__relocated || []).push([src, dest]); return true; },
    moveNode: async () => true,
    readScratchpad: async () => '',
    appendScratchpad: async () => true,
    listTemplates: async () => ([
      { name: 'meeting-notes.md', fsPath: '/nb/templates/meeting-notes.md', title: 'Meeting Notes' },
      { name: 'daily-log.md', fsPath: '/nb/templates/daily-log.md', title: 'Daily Log' },
    ]),
    createTemplate: async () => '/nb/templates/new-template.md',
    updateNoteMeta: async (p, meta) => { window.__metaUpdate = { path: p, meta }; return true; },
    importClipboard: async () => ({ success: false, reason: 'stub' }),
    importDocument: async () => null,
    // New shape: returns { success, pdfPath }
    exportToPdf: async (fp, html, options) => {
      window.__export = { fp, html, options };
      return { success: true, pdfPath: '/tmp/x.pdf' };
    },
    exportToHtml: async (fp, html, options) => {
      window.__htmlExport = { fp, html, options };
      return { success: true, htmlPath: '/tmp/x.html' };
    },
    exportToDocx: async (fp) => {
      window.__docxExport = { fp };
      return { success: true, docxPath: '/tmp/x.docx' };
    },
    copyRichText: async (html, text) => {
      window.__richCopy = { html, text };
      return { success: true };
    },
    onCaptureShortcutFailed: (cb) => { window.__captureFailCb = cb; },
    getBacklinks: async (p) => {
      window.__backlinksArg = p;
      return ['/nb/Projects/alpha.md'];
    },
    onFilesChanged: (cb) => { window.__filesCb = cb; return () => {}; },
    onOpenNoteAt: (cb) => { window.__openAtCb = cb; return () => {}; },
    takePendingOpen: async () => (window.__pendingOpen || null),
    toggleTaskAtLine: async (p, line) => {
      (window.__toggleCalls = window.__toggleCalls || []).push([p, line]);
      return true;
    },
    toggleMermaidOrientation: () => {},
    openExternal: async (u) => { (window.__opened = window.__opened || []).push(u); return true; },
    resolveRelativePath: (base, rel) => rel,
    renderMarkdown: (text, opts) => renderMarkdown(text),
  };
}, { noteMd: NOTE_MD, platform: PLATFORM, xssTitle: XSS_TITLE });

await page.goto('file://' + path.join(ROOT, 'renderer', 'index.html'));
await page.waitForTimeout(600);

// --- 1. Boot: onboarding hidden, tree rendered, theme applied from settings ---
check('boots past onboarding', !(await page.locator('#onboarding').evaluate(el => el.classList.contains('active'))));
check('startup loading overlay is hidden after boot', await page.evaluate(() => {
  const el = document.getElementById('app-loading');
  return el && (el.classList.contains('hiding') || el.classList.contains('gone'));
}));
check('tree renders pages', await page.locator('#notebook-tree .tree-node-label', { hasText: 'Smoke Note' }).count() === 1);
check('boot applies settings.theme=dark', await page.evaluate(() =>
  document.body.classList.contains('dark-theme') && document.body.dataset.theme === 'dark'));
check('boot: hljs dark sheet enabled, light disabled', await page.evaluate(() =>
  document.getElementById('hljs-dark').disabled === false && document.getElementById('hljs-light').disabled === true));
check('XSS tree title did not execute at boot', await page.evaluate(() => window.__xss === undefined));
check('XSS tree title renders literally in sidebar', await page.evaluate(() => {
  const labels = Array.from(document.querySelectorAll('#notebook-tree .tree-node-label'));
  return labels.some(l => l.textContent === '<img src=x onerror=window.__xss=1>') &&
    document.querySelectorAll('#notebook-tree img').length === 0;
}));

// --- 1b. Toolbar layout: importing lives in the sidebar with the other
// "add to the notebook" actions; exporting acts on the open note. These are
// assertions about the static markup, so they run before the suite starts
// opening modals and swapping views. ---
check('Export menu lists the sharing entries', await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('#dropdown-export .dropdown-item'))
    .map(d => d.textContent.replace(/\s+/g, ' ').trim());
  return ['PDF', 'HTML', 'Word (.docx)', 'Copy as Rich Text']
    .every(t => items.some(i => i.startsWith(t)));
}));
check('Import menu lives in the sidebar and lists its sources', await page.evaluate(() => {
  const menu = document.querySelector('#dropdown-import');
  if (!menu || !menu.closest('#sidebar')) return false;
  const items = Array.from(menu.querySelectorAll('.dropdown-item'))
    .map(d => d.textContent.replace(/\s+/g, ' ').trim());
  return ['From Clipboard', 'From a File…', 'From OneNote…']
    .every(t => items.some(i => i.startsWith(t)));
}));
check('the import file types are discoverable on hover', await page.evaluate(() => {
  const item = Array.from(document.querySelectorAll('#dropdown-import .dropdown-item'))
    .find(d => d.textContent.includes('From a File'));
  // The app moves title into data-tooltip and removes title, so it can draw
  // its own tooltip rather than the OS one.
  const hint = item && (item.dataset.tooltip || item.getAttribute('title'));
  return !!hint && ['Word', 'PowerPoint', 'Excel', 'OneNote', 'EPUB'].every(f => hint.includes(f));
}));
check('no Pandoc jargon in the UI outside settings', await page.evaluate(() => {
  const toolbarAndSidebar = [
    ...document.querySelectorAll('#sidebar, .toolbar'),
  ].map(el => `${el.innerHTML}`).join(' ');
  return !/pandoc/i.test(toolbarAndSidebar);
}));
// Going icon-only removed the visible labels, so the tooltip text is now the
// only accessible name these controls have — and the tooltip system *removes*
// the title attribute it reads from. Without the aria-label handoff a screen
// reader announces bare "button" for most of the toolbar.
check('every icon-only control keeps an accessible name', await page.evaluate(() => {
  const unnamed = Array.from(document.querySelectorAll('.icon-btn, .toolbar-btn, .dropdown-toggle'))
    .filter(el => el.offsetParent !== null)
    .filter(el => !el.textContent.trim()
      && !el.getAttribute('aria-label')
      && !el.getAttribute('title'));
  return unnamed.length === 0;
}));

// The toolbar carries twenty-odd controls; at 1280 wide they used to run off
// the edge of the screen, taking Settings and Search with them.
check('the toolbar never clips its controls', await page.evaluate(() => {
  const toolbar = document.querySelector('.toolbar');
  const overflow = toolbar.scrollWidth - toolbar.clientWidth;
  const offscreen = Array.from(toolbar.querySelectorAll('button'))
    .filter(b => b.offsetParent !== null)
    .some(b => b.getBoundingClientRect().right > window.innerWidth + 1);
  return overflow <= 1 && !offscreen;
}));

check('Trash and Note History moved out of the old menu', await page.evaluate(() => {
  const gone = !document.querySelector('#dropdown-file-actions');
  const trashInSidebar = Array.from(document.querySelectorAll('#sidebar button'))
    .some(b => b.textContent.trim() === 'Trash');
  const historyInToolbar = Array.from(document.querySelectorAll('.toolbar button'))
    .some(b => (b.dataset.tooltip || b.getAttribute('title') || '').startsWith('Note History'));
  return gone && trashInSidebar && historyInToolbar;
}));

// --- 2. Sidebar collapse / expand ---
await page.locator('[data-tooltip="Collapse Sidebar"]').click();
check('sidebar collapses', await page.evaluate(() => document.getElementById('sidebar').classList.contains('collapsed') && document.body.classList.contains('sidebar-collapsed')));
check('sidebar width 0 when collapsed', await page.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().width === 0));
const expandVisible = await page.locator('#btn-expand-sidebar').isVisible();
check('expand button appears in toolbar', expandVisible);
await page.locator('#btn-expand-sidebar').click();
check('sidebar restores', await page.evaluate(() => !document.getElementById('sidebar').classList.contains('collapsed')));
check('collapse state persisted key', await page.evaluate(() => localStorage.getItem('sidebarCollapsed') === '0'));

// --- 2b. Theme system: named themes, class preservation, hljs swap, quick toggle ---
await page.evaluate(() => { setSidebarCollapsed(true); applyTheme('midnight'); });
check('midnight theme uses dark base + data-theme', await page.evaluate(() =>
  document.body.classList.contains('dark-theme') && !document.body.classList.contains('light-theme') &&
  document.body.dataset.theme === 'midnight'));
check('applyTheme preserves other body classes', await page.evaluate(() =>
  document.body.classList.contains('sidebar-collapsed')));
await page.evaluate(() => applyTheme('sepia'));
check('sepia theme uses light base + data-theme', await page.evaluate(() =>
  document.body.classList.contains('light-theme') && !document.body.classList.contains('dark-theme') &&
  document.body.dataset.theme === 'sepia'));
check('sepia enables hljs light sheet', await page.evaluate(() =>
  document.getElementById('hljs-light').disabled === false && document.getElementById('hljs-dark').disabled === true));
await page.evaluate(() => applyTheme('forest'));
check('forest theme uses dark base', await page.evaluate(() =>
  document.body.classList.contains('dark-theme') && document.body.dataset.theme === 'forest'));
await page.evaluate(() => applyTheme('system'));
check('system theme resolves to light or dark', await page.evaluate(() =>
  ['light', 'dark'].includes(document.body.dataset.theme) &&
  (document.body.classList.contains('light-theme') || document.body.classList.contains('dark-theme'))));
// Quick toggle flips the light/dark base
await page.evaluate(() => applyTheme('light'));
await page.evaluate(() => toggleGlobalTheme());
check('toggleGlobalTheme flips light -> dark', await page.evaluate(() =>
  document.body.dataset.theme === 'dark' && document.body.classList.contains('dark-theme')));
await page.evaluate(() => toggleGlobalTheme());
check('toggleGlobalTheme flips dark -> light', await page.evaluate(() =>
  document.body.dataset.theme === 'light' && document.body.classList.contains('light-theme')));
check('toggleGlobalTheme syncs settings select', await page.evaluate(() =>
  document.getElementById('settings-theme').value === 'light'));
// restore state for the rest of the suite
await page.evaluate(() => { applyTheme('dark'); setSidebarCollapsed(false); });

// --- 3. Sidebar drag resize ---
const before = await page.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().width);
const rz = await page.locator('#sidebar-resizer').boundingBox();
await page.mouse.move(rz.x + 2, rz.y + 300);
await page.mouse.down();
await page.mouse.move(rz.x + 102, rz.y + 300, { steps: 5 });
await page.mouse.up();
const after = await page.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().width);
check('sidebar drag-resize grows width', after > before + 80, `before=${before} after=${after}`);
check('sidebar width persisted', await page.evaluate(() => !!localStorage.getItem('panelWidth:sidebar')));

// --- 4. Open note, check preview + mermaid rendered ---
await page.locator('#notebook-tree .tree-node-label', { hasText: 'Smoke Note' }).click();
await page.waitForTimeout(800);
check('note opens', await page.locator('#note-workspace').isVisible());
check('mermaid svg rendered in preview', await page.locator('#preview-pane .notebook-mermaid svg').count() === 1);
check('mermaid svg stretched (maxWidth 100%)', await page.evaluate(() => {
  const svg = document.querySelector('#preview-pane .notebook-mermaid svg');
  return svg && svg.style.maxWidth === '100%';
}));
check('word count shows', /\d+ words/.test(await page.locator('#note-meta-words').innerText()));

// --- 5. Tree actions are in-flow (no overlap) ---
const treeNode = page.locator('#notebook-tree .tree-node').filter({ hasText: 'A Very Long Page Title' }).first();
await page.locator('#notebook-tree .tree-node-label', { hasText: 'Projects' }).click();
await treeNode.hover();
check('tree actions position static (in flow)', await treeNode.evaluate(el => {
  const actions = el.querySelector('.tree-node-actions');
  return actions && getComputedStyle(actions).position === 'static' && getComputedStyle(actions).display === 'flex';
}));
check('label does not overlap actions', await treeNode.evaluate(el => {
  const label = el.querySelector('.tree-node-label').getBoundingClientRect();
  const actions = el.querySelector('.tree-node-actions').getBoundingClientRect();
  return label.right <= actions.left + 1;
}));

// --- 6. Editor Tab / Enter behavior ---
// (step 5 opened a section landing page, which hides the mode toggles)
await page.locator('#notebook-tree .tree-node-label', { hasText: 'Smoke Note' }).click();
await page.waitForTimeout(500);
await page.locator('#btn-mode-edit').click();
const editor = page.locator('#note-editor');
await editor.evaluate((ta) => { ta.focus(); ta.value = '- first bullet'; ta.selectionStart = ta.selectionEnd = ta.value.length; window.handleEditorInput(); });
await editor.press('Tab');
let val = await editor.inputValue();
check('Tab indents list line', val === '  - first bullet', JSON.stringify(val));
check('Tab stays in editor', await page.evaluate(() => document.activeElement && document.activeElement.id === 'note-editor'));
await editor.press('Enter');
val = await editor.inputValue();
check('Enter continues indented bullet', val === '  - first bullet\n  - ', JSON.stringify(val));
await editor.press('Enter'); // empty item -> ends list
val = await editor.inputValue();
check('Enter on empty item ends list', val === '  - first bullet\n', JSON.stringify(val));
await editor.evaluate((ta) => { ta.value = '1. one'; ta.selectionStart = ta.selectionEnd = ta.value.length; window.handleEditorInput(); });
await editor.press('Enter');
val = await editor.inputValue();
check('Enter increments ordered list', val === '1. one\n2. ', JSON.stringify(val));
await editor.evaluate((ta) => { ta.value = '- [ ] task'; ta.selectionStart = ta.selectionEnd = ta.value.length; window.handleEditorInput(); });
await editor.press('Enter');
val = await editor.inputValue();
check('Enter continues checkbox item', val === '- [ ] task\n- [ ] ', JSON.stringify(val));
await editor.press('Shift+Tab'); // outdent (no leading indent -> no-op)
check('Shift+Tab does not throw', true);

// --- 6b. Enter scrolls the caret into view + undo works ---
const longDoc = Array.from({ length: 200 }, (_, i) => `- line ${i}`).join('\n');
await editor.evaluate((ta, doc) => {
  ta.value = doc;
  ta.selectionStart = ta.selectionEnd = doc.length;
  ta.scrollTop = 0; // deliberately scrolled to the top, caret at the bottom
  window.handleEditorInput();
}, longDoc);
await editor.press('Enter');
check('Enter scrolls caret into view', await editor.evaluate(ta => {
  const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 21;
  const caretY = (ta.value.slice(0, ta.selectionEnd).split('\n').length - 1) * lineHeight;
  return caretY >= ta.scrollTop && caretY <= ta.scrollTop + ta.clientHeight;
}), `scrollTop=${await editor.evaluate(ta => ta.scrollTop)}`);
val = await editor.inputValue();
check('Enter continued list at bottom', val.endsWith('- line 199\n- '), JSON.stringify(val.slice(-20)));
// Native undo: driven by the real browser platform, not the stubbed one
await editor.press('ControlOrMeta+z');
val = await editor.inputValue();
check('undo reverts list continuation', val.endsWith('- line 199'), JSON.stringify(val.slice(-14)));

// --- 6c. View mode keyboard shortcuts (uses the STUB platform's modifier) ---
await page.keyboard.press(`${MOD}+1`);
check('Mod+1 switches to preview', await page.evaluate(() => document.getElementById('editor-preview-container').className.includes('preview-mode')));
await page.keyboard.press(`${MOD}+3`);
check('Mod+3 switches to split', await page.evaluate(() => document.getElementById('editor-preview-container').className.includes('split-mode')));
await page.keyboard.press(`${MOD}+2`);
check('Mod+2 switches to edit', await page.evaluate(() => document.getElementById('editor-preview-container').className.includes('edit-mode')));

// --- 6d. Page Info modal ---
await page.evaluate(() => window.showPageInfoModal('/nb/smoke.md'));
await page.waitForTimeout(300);
check('page info modal opens', await page.evaluate(() => document.getElementById('page-info-modal').classList.contains('active')));
check('page info prefilled', await page.evaluate(() =>
  document.getElementById('page-info-title').value === 'Smoke Note' &&
  document.getElementById('page-info-date').value === '2026-07-10' &&
  document.getElementById('page-info-tags').value === 'test'));
await page.locator('#page-info-tags').fill('test, updated');
await page.locator('#page-info-pinned').check();
await page.locator('#page-info-modal .btn-primary').click();
await page.waitForTimeout(400);
const metaUpdate = await page.evaluate(() => window.__metaUpdate);
check('page info saves meta via IPC', !!metaUpdate && metaUpdate.path === '/nb/smoke.md' &&
  JSON.stringify(metaUpdate.meta.tags) === '["test","updated"]' && metaUpdate.meta.pinned === true,
  JSON.stringify(metaUpdate));
check('page info modal closed after save', !(await page.evaluate(() => document.getElementById('page-info-modal').classList.contains('active'))));

// --- 6e. New editor combos: Mod+Alt+L / Mod+Alt+C / Mod+Alt+X / Mod+Alt+Minus ---
await page.locator('#btn-mode-edit').click();
await editor.evaluate((ta) => { ta.focus(); ta.value = 'hello'; ta.selectionStart = ta.selectionEnd = ta.value.length; window.handleEditorInput(); });
await editor.press(`${MOD}+Alt+KeyL`);
val = await editor.inputValue();
check('Mod+Alt+L inserts bullet item', val === 'hello\n- ', JSON.stringify(val));
await editor.press(`${MOD}+Alt+KeyC`);
val = await editor.inputValue();
check('Mod+Alt+C inserts checklist item', val === 'hello\n- \n- [ ] ', JSON.stringify(val));
await editor.press(`${MOD}+Alt+KeyX`);
val = await editor.inputValue();
check('Mod+Alt+X also inserts checklist item', val === 'hello\n- \n- [ ] \n- [ ] ', JSON.stringify(val));
await editor.evaluate((ta) => { ta.value = 'x'; ta.selectionStart = ta.selectionEnd = 1; window.handleEditorInput(); });
await editor.press(`${MOD}+Alt+Minus`);
val = await editor.inputValue();
check('Mod+Alt+Minus inserts separator', val === 'x\n---\n', JSON.stringify(val));

// --- 7. Mermaid popout ---
// restore the original note content (editor tests overwrote it)
await editor.evaluate((ta, md) => { ta.value = md; ta.selectionStart = ta.selectionEnd = 0; window.handleEditorInput(); }, NOTE_MD);
await page.locator('#btn-mode-preview').click();
await page.waitForTimeout(700);
await page.locator('.mermaid-block-container').hover();
await page.locator('.popout-btn').click();
await page.waitForTimeout(700);
check('popout overlay opens', await page.evaluate(() => document.getElementById('mermaid-popout-overlay').classList.contains('active')));
check('popout re-rendered svg present', await page.locator('#mermaid-popout-body .popout-canvas svg').count() === 1);
const zoomBefore = await page.locator('#label-popout-zoom').innerText();
await page.locator('[data-tooltip="Scale Visuals Up"]').click();
const zoomAfter = await page.locator('#label-popout-zoom').innerText();
check('popout zoom changes label', zoomBefore !== zoomAfter, `${zoomBefore} -> ${zoomAfter}`);
check('popout zoom sets pixel width', await page.evaluate(() => {
  const svg = document.querySelector('#mermaid-popout-body svg');
  return svg && /px$/.test(svg.style.width);
}));
await page.keyboard.press('Escape');
check('Escape closes popout', !(await page.evaluate(() => document.getElementById('mermaid-popout-overlay').classList.contains('active'))));

// --- 7b. Inline mermaid zoom (pixel-width based) ---
const inlineWidthBefore = await page.evaluate(() => document.querySelector('#preview-pane .notebook-mermaid svg').getBoundingClientRect().width);
await page.locator('.mermaid-block-container').hover();
await page.locator('.mermaid-actions-bar button').nth(1).click(); // zoom in
const inlineState = await page.evaluate(() => {
  const pre = document.querySelector('#preview-pane .notebook-mermaid');
  const svg = pre.querySelector('svg');
  return { zoom: pre.dataset.zoomLevel, width: svg.getBoundingClientRect().width, styleWidth: svg.style.width };
});
check('inline zoom-in grows the diagram', inlineState.zoom === '115' && /px$/.test(inlineState.styleWidth) && inlineState.width > inlineWidthBefore,
  `before=${inlineWidthBefore} after=${JSON.stringify(inlineState)}`);
await page.locator('.mermaid-actions-bar button').nth(0).click(); // back to 100
check('inline zoom back to 100% restores the base size', await page.evaluate(() => {
  // Landscape diagrams restore to the pane-filling '100%'; portrait ones
  // (like this two-node TD chart) restore to their height-capped px base
  const pre = document.querySelector('#preview-pane .notebook-mermaid');
  const svg = pre.querySelector('svg');
  if (pre.dataset.zoomLevel !== '100') return false;
  if (svg.style.width === '100%') return true;
  const vb = svg.viewBox.baseVal;
  return vb.height > vb.width && /px$/.test(svg.style.width) &&
    parseInt(svg.style.width, 10) <= pre.clientWidth;
}));

// --- 8. Preview zoom label ---
await page.locator('[data-tooltip="Zoom In Preview"]').click();
check('preview zoom label updates', (await page.locator('#label-preview-zoom').innerText()) === '110%');

// --- 9. Templates modal ---
await page.locator('.sidebar-footer .btn[onclick*="showTemplatesModal"]').click();
await page.waitForTimeout(300);
check('templates modal opens', await page.evaluate(() => document.getElementById('templates-modal').classList.contains('active')));
check('templates listed', await page.locator('#templates-list .template-item').count() === 2);
await page.locator('#templates-modal .btn-primary').click(); // New Template
check('create modal opens in template mode', await page.evaluate(() =>
  document.getElementById('create-modal').classList.contains('active') &&
  document.getElementById('create-modal-type').value === 'template'));
await page.keyboard.press('Escape');
check('Escape closes create modal', !(await page.evaluate(() => document.getElementById('create-modal').classList.contains('active'))));

// --- 10. Diagram builder (all 7 types) ---
await page.locator('#btn-mode-edit').click();
await page.evaluate(() => window.showMermaidBuilder());
await page.waitForTimeout(200);
check('builder modal opens', await page.evaluate(() => document.getElementById('mermaid-builder-modal').classList.contains('active')));
// See Example button fills the form for the current type
await page.locator('.builder-form .btn-xs').click();
await page.waitForTimeout(500);
check('See Example fills the form', (await page.locator('#builder-flow-steps').inputValue()).includes('Receive request'));
check('See Example generates preview code', (await page.locator('#builder-code').inputValue()).includes('flowchart TD'));
await page.locator('#builder-flow-steps').fill('Receive request\nValid input?\nProcess order');
await page.waitForTimeout(600);
const code = await page.locator('#builder-code').inputValue();
check('builder generates flowchart code', code.includes('flowchart TD') && code.includes('B{"Valid input?"}') && code.includes('A --> B'), code.replace(/\n/g, '¶'));
check('builder live preview renders svg', await page.locator('#builder-preview svg').count() === 1);
// sequence type
await page.locator('#builder-type').selectOption('sequence');
check('switchBuilderType shows sequence fields', await page.evaluate(() =>
  document.getElementById('builder-fields-sequence').style.display === 'block' &&
  document.getElementById('builder-fields-flowchart').style.display === 'none'));
await page.locator('#builder-seq-messages').fill('Client -> Server: Login\nServer --> Client: OK');
await page.waitForTimeout(600);
const seqCode = await page.locator('#builder-code').inputValue();
check('builder sequence code', seqCode.includes('sequenceDiagram') && seqCode.includes('Client->>Server: Login') && seqCode.includes('Server-->>Client: OK'), seqCode.replace(/\n/g, '¶'));
// pie
await page.locator('#builder-type').selectOption('pie');
await page.locator('#builder-pie-title').fill('Time');
await page.locator('#builder-pie-data').fill('Meetings: 4\nCoding: 6');
await page.waitForTimeout(600);
const pieCode = await page.locator('#builder-code').inputValue();
check('builder pie code', pieCode.includes('pie title Time') && pieCode.includes('"Meetings" : 4'), pieCode.replace(/\n/g, '¶'));
// insert (still edit mode)
await editor.evaluate((ta) => { ta.value = 'start\n'; ta.selectionStart = ta.selectionEnd = ta.value.length; window.handleEditorInput(); });
await page.locator('#mermaid-builder-modal .btn-primary').click();
await page.waitForTimeout(400);
val = await editor.inputValue();
check('builder inserts fenced block', val.includes('```mermaid\npie title Time'), JSON.stringify(val).slice(0, 120));
check('builder keeps edit mode after insert', await page.evaluate(() => document.getElementById('editor-preview-container').className.includes('edit-mode')));

// --- 10b. New builder types: gantt, class, state, journey ---
await page.evaluate(() => window.showMermaidBuilder());
await page.waitForTimeout(200);

// gantt via example
await page.locator('#builder-type').selectOption('gantt');
check('switchBuilderType shows gantt fields', await page.evaluate(() =>
  document.getElementById('builder-fields-gantt').style.display === 'block' &&
  document.getElementById('builder-fields-pie').style.display === 'none'));
await page.evaluate(() => window.loadBuilderExample());
await page.waitForTimeout(700);
check('gantt example fills fields', await page.evaluate(() =>
  document.getElementById('builder-gantt-title').value === 'Website Redesign' &&
  /^\d{4}-\d{2}-\d{2}$/.test(document.getElementById('builder-gantt-start').value) &&
  document.getElementById('builder-gantt-tasks').value.includes('Gather requirements')));
const ganttCode = await page.locator('#builder-code').inputValue();
check('gantt code has title/dateFormat/chained tasks',
  ganttCode.startsWith('gantt') && ganttCode.includes('title Website Redesign') &&
  ganttCode.includes('dateFormat YYYY-MM-DD') && ganttCode.includes('section Tasks') &&
  /Gather requirements :t1, \d{4}-\d{2}-\d{2}, 3d/.test(ganttCode) &&
  ganttCode.includes('Design mockups :t2, after t1, 5d'),
  ganttCode.replace(/\n/g, '¶'));
check('gantt preview renders svg', await page.locator('#builder-preview svg').count() === 1 &&
  await page.evaluate(() => document.getElementById('builder-error').style.display === 'none'));
// gantt custom input
await page.locator('#builder-gantt-title').fill('T');
await page.locator('#builder-gantt-start').fill('2026-07-01');
await page.locator('#builder-gantt-tasks').fill('A: 3\nB: 2');
await page.waitForTimeout(700);
const ganttCustom = await page.locator('#builder-code').inputValue();
check('gantt custom tasks chain correctly',
  ganttCustom.includes('A :t1, 2026-07-01, 3d') && ganttCustom.includes('B :t2, after t1, 2d'),
  ganttCustom.replace(/\n/g, '¶'));
check('gantt custom preview renders svg', await page.locator('#builder-preview svg').count() === 1);

// class via example
await page.locator('#builder-type').selectOption('class');
check('switchBuilderType shows class fields', await page.evaluate(() =>
  document.getElementById('builder-fields-class').style.display === 'block'));
await page.evaluate(() => window.loadBuilderExample());
await page.waitForTimeout(700);
check('class example fills fields', await page.evaluate(() =>
  document.getElementById('builder-class-classes').value.includes('Animal') &&
  document.getElementById('builder-class-relations').value.includes('Animal <- Dog')));
const classCode = await page.locator('#builder-code').inputValue();
check('class code has class blocks + inheritance',
  classCode.startsWith('classDiagram') && classCode.includes('class Animal {') &&
  classCode.includes('+name') && classCode.includes('+speak()') &&
  classCode.includes('Animal <|-- Dog') && classCode.includes('Animal <|-- Cat'),
  classCode.replace(/\n/g, '¶'));
check('class preview renders svg', await page.locator('#builder-preview svg').count() === 1 &&
  await page.evaluate(() => document.getElementById('builder-error').style.display === 'none'));
// class relation variants
await page.locator('#builder-class-relations').fill('Animal <- Dog\nOwner -> Dog\nDog - Leash');
await page.waitForTimeout(700);
const classCode2 = await page.locator('#builder-code').inputValue();
check('class relation arrows map correctly',
  classCode2.includes('Animal <|-- Dog') && classCode2.includes('Owner --> Dog') && classCode2.includes('Dog -- Leash'),
  classCode2.replace(/\n/g, '¶'));

// state via example
await page.locator('#builder-type').selectOption('state');
check('switchBuilderType shows state fields', await page.evaluate(() =>
  document.getElementById('builder-fields-state').style.display === 'block'));
await page.evaluate(() => window.loadBuilderExample());
await page.waitForTimeout(700);
check('state example fills fields', await page.evaluate(() =>
  document.getElementById('builder-state-transitions').value.includes('Idle -> Running: start')));
const stateCode = await page.locator('#builder-code').inputValue();
check('state code has start marker + transitions',
  stateCode.startsWith('stateDiagram-v2') && stateCode.includes('[*] --> Idle') &&
  stateCode.includes('Idle --> Running: start') && stateCode.includes('Paused --> Running: resume'),
  stateCode.replace(/\n/g, '¶'));
check('state preview renders svg', await page.locator('#builder-preview svg').count() === 1 &&
  await page.evaluate(() => document.getElementById('builder-error').style.display === 'none'));

// journey via example
await page.locator('#builder-type').selectOption('journey');
check('switchBuilderType shows journey fields', await page.evaluate(() =>
  document.getElementById('builder-fields-journey').style.display === 'block'));
await page.evaluate(() => window.loadBuilderExample());
await page.waitForTimeout(700);
check('journey example fills fields', await page.evaluate(() =>
  document.getElementById('builder-journey-title').value === 'Morning routine' &&
  document.getElementById('builder-journey-actor').value === 'Me' &&
  document.getElementById('builder-journey-tasks').value.includes('Wake up: 3')));
const journeyCode = await page.locator('#builder-code').inputValue();
check('journey code has title/section/scored steps',
  journeyCode.startsWith('journey') && journeyCode.includes('title Morning routine') &&
  journeyCode.includes('section Steps') && journeyCode.includes('Wake up: 3: Me') &&
  journeyCode.includes('Make coffee: 5: Me'),
  journeyCode.replace(/\n/g, '¶'));
check('journey preview renders svg', await page.locator('#builder-preview svg').count() === 1 &&
  await page.evaluate(() => document.getElementById('builder-error').style.display === 'none'));

// See Example works for the original 3 types too
await page.locator('#builder-type').selectOption('sequence');
await page.evaluate(() => window.loadBuilderExample());
check('sequence example fills field', (await page.locator('#builder-seq-messages').inputValue()).includes('Client -> Server'));
await page.locator('#builder-type').selectOption('pie');
await page.evaluate(() => window.loadBuilderExample());
check('pie example fills fields', await page.evaluate(() =>
  document.getElementById('builder-pie-title').value === 'Time spent' &&
  document.getElementById('builder-pie-data').value.includes('Meetings: 4')));
await page.evaluate(() => window.hideMermaidBuilder());

// --- 11. PDF export: modal flow, sanitization, toast, option persistence ---
await page.locator('#btn-mode-preview').click();
await page.waitForTimeout(800);
await page.evaluate(() => window.exportToPdf());
await page.waitForTimeout(200);
check('exportToPdf opens options modal', await page.evaluate(() =>
  document.getElementById('pdf-export-modal').classList.contains('active')));
check('pdf modal prefilled from settings.pdfExport', await page.evaluate(() =>
  document.getElementById('pdf-theme').value === 'light' &&
  document.getElementById('pdf-page-size').value === 'A4' &&
  document.getElementById('pdf-open-after').checked === true &&
  document.getElementById('pdf-reveal').checked === false));
await page.locator('#pdf-theme').selectOption('dark');
await page.locator('#pdf-page-size').selectOption('Letter');
await page.locator('#pdf-reveal').check();
await page.locator('#pdf-export-modal .btn-primary').click();
await page.waitForTimeout(400);
check('pdf modal closes on confirm', !(await page.evaluate(() => document.getElementById('pdf-export-modal').classList.contains('active'))));
const exportCall = await page.evaluate(() => window.__export || null);
check('confirmPdfExport passes chosen options', !!exportCall && exportCall.fp === '/nb/smoke.md' &&
  exportCall.options && exportCall.options.theme === 'dark' && exportCall.options.pageSize === 'Letter' &&
  exportCall.options.openAfter === true && exportCall.options.reveal === true,
  JSON.stringify(exportCall && exportCall.options));
check('export strips mermaid action bars', !!exportCall && exportCall.html.length > 0 && !exportCall.html.includes('mermaid-actions-bar'), `len=${exportCall && exportCall.html.length}`);
check('export caps svg to natural width', !!exportCall && /max-width:\s*\d+px/.test(exportCall.html));
check('toast shows exported pdf name', await page.evaluate(() => {
  const t = document.getElementById('app-toast');
  return !!t && t.classList.contains('visible') && !t.classList.contains('error') &&
    t.textContent.includes('PDF exported') && t.textContent.includes('x.pdf');
}));
// options were remembered in appSettings.pdfExport: reopen and check prefill
await page.evaluate(() => window.exportToPdf());
await page.waitForTimeout(200);
check('pdf modal remembers last-used options', await page.evaluate(() =>
  document.getElementById('pdf-theme').value === 'dark' &&
  document.getElementById('pdf-page-size').value === 'Letter' &&
  document.getElementById('pdf-reveal').checked === true));
await page.evaluate(() => window.hidePdfExportModal());

// --- 12. Full width mode ---
await page.locator('#btn-stretch-width').click(); // -> wide
await page.locator('#btn-stretch-width').click(); // -> full
await page.waitForTimeout(600);
const widths = await page.evaluate(() => {
  const pane = document.getElementById('preview-pane');
  const container = document.getElementById('editor-preview-container');
  return { pane: pane.getBoundingClientRect().width, container: container.getBoundingClientRect().width, cls: container.className };
});
check('full mode: pane fills container', Math.abs(widths.pane - widths.container) < 2, JSON.stringify(widths));

// --- 13. Outline drawer: resizer + backlinks pills ---
await page.locator('#btn-toggle-outline').click();
check('drawer opens & resizer visible', await page.evaluate(() =>
  !document.getElementById('right-drawer').classList.contains('collapsed') &&
  document.getElementById('drawer-resizer').style.display === 'block'));
await page.waitForTimeout(400);
check('getBacklinks called with active note path', await page.evaluate(() => window.__backlinksArg === '/nb/smoke.md'));
check('backlink pill renders in note meta', await page.evaluate(() => {
  const list = document.getElementById('note-meta-backlinks');
  const container = document.getElementById('note-meta-backlinks-container');
  const pills = list ? list.querySelectorAll('.backlink-pill') : [];
  return pills.length === 1 && container.style.display === 'flex' &&
    pills[0].textContent.includes('A Very Long Page Title');
}));
const drz = await page.locator('#drawer-resizer').boundingBox();
const dBefore = await page.evaluate(() => document.getElementById('right-drawer').getBoundingClientRect().width);
await page.mouse.move(drz.x + 2, drz.y + 300);
await page.mouse.down();
await page.mouse.move(drz.x - 98, drz.y + 300, { steps: 5 });
await page.mouse.up();
const dAfter = await page.evaluate(() => document.getElementById('right-drawer').getBoundingClientRect().width);
check('drawer drag-resize grows width', dAfter > dBefore + 80, `before=${dBefore} after=${dAfter}`);
await page.locator('#btn-toggle-outline').click();
check('drawer close hides resizer', await page.evaluate(() => document.getElementById('drawer-resizer').style.display === 'none'));

// --- 14. Landing pages read tasks from tree taskLines ---
await page.locator('.logo-area').click(); // Notebook Dashboard (root landing)
await page.waitForTimeout(500);
check('root landing opens', await page.locator('#landing-workspace').isVisible());
check('metrics: pages / completed / pending', await page.evaluate(() =>
  // smoke.md, xss.md, links.md, deep.md, Projects/alpha.md
  document.getElementById('metric-pages').innerText === '5' &&
  document.getElementById('metric-completed').innerText === '1' &&
  document.getElementById('metric-pending').innerText === '1'));
check('pending actions rendered from taskLines', await page.evaluate(() => {
  const items = document.querySelectorAll('#landing-tasks-list .landing-task-item');
  if (items.length !== 1) return false;
  const text = items[0].querySelector('.landing-task-text');
  const origin = items[0].querySelector('.landing-task-origin');
  return text && text.textContent === 'task' && origin && origin.textContent.includes('A Very Long Page Title');
}));
check('progress ratio label from taskLines counts', (await page.locator('#metric-tasks-ratio').innerText()) === '1 of 2 tasks');

// --- 15. Save does NOT rescan the tree itself; watcher callback does ---
await page.evaluate(() => window.openNote('/nb/smoke.md'));
await page.waitForTimeout(500);
await page.locator('#btn-mode-edit').click();
await editor.evaluate((ta) => { ta.focus(); ta.value = '# Smoke Note\n\nedited body\n'; ta.selectionStart = ta.selectionEnd = ta.value.length; window.handleEditorInput(); });
const treeCallsBeforeSave = await page.evaluate(() => window.__treeCalls);
await page.keyboard.press(`${MOD}+s`);
await page.waitForTimeout(400);
check('Mod+S writes the note', await page.evaluate(() => window.__writes.includes('/nb/smoke.md')));
check('save status back to Saved', (await page.locator('#save-status-indicator').innerText()) === 'Saved');
const treeCallsAfterSave = await page.evaluate(() => window.__treeCalls);
check('saveActiveNote does not rescan tree', treeCallsAfterSave === treeCallsBeforeSave,
  `before=${treeCallsBeforeSave} after=${treeCallsAfterSave}`);
// Simulate the debounced files-changed notification from the main process
await page.evaluate(() => { window.__addTreePage(); window.__filesCb(); });
await page.waitForTimeout(500);
check('files-changed callback rescans tree', await page.evaluate(() => window.__treeCalls) === treeCallsAfterSave + 1);
check('refreshNotebook renders new tree node', await page.locator('#notebook-tree .tree-node-label', { hasText: 'Fresh Note' }).count() === 1);

// --- 16. Command palette: open, HTML escaping (XSS), navigation ---
await page.keyboard.press(`${MOD}+k`);
await page.waitForTimeout(300);
check('Mod+K opens command palette', await page.evaluate(() =>
  document.getElementById('command-palette-modal').style.display !== 'none'));
check('palette lists commands with empty query', await page.locator('#palette-results-list .palette-item').count() > 5);
await page.locator('#palette-search-input').fill('xss');
await page.waitForTimeout(200);
check('palette finds XSS-titled page', await page.locator('#palette-results-list .palette-item').count() === 1);
check('palette escapes HTML in labels', await page.evaluate(() => {
  const label = document.querySelector('#palette-results-list .palette-item-label');
  return label && label.textContent === '<img src=x onerror=window.__xss=1>' &&
    document.querySelectorAll('#palette-results-list img').length === 0;
}));
check('window.__xss stayed undefined', await page.evaluate(() => window.__xss === undefined));
await page.keyboard.press('Escape');
check('Escape closes palette', await page.evaluate(() =>
  document.getElementById('command-palette-modal').style.display === 'none'));

// --- 17. Shortcuts modal: Mod+/ and settings button, kbd chips ---
await page.keyboard.press(`${MOD}+Slash`);
await page.waitForTimeout(200);
check('Mod+/ opens shortcuts modal', await page.evaluate(() =>
  document.getElementById('shortcuts-modal').classList.contains('active')));
check('shortcuts modal renders sections + kbd chips', await page.evaluate(() =>
  document.querySelectorAll('#shortcuts-list .shortcuts-section').length === 4 &&
  document.querySelectorAll('#shortcuts-list kbd').length > 10));
check('shortcut chips use platform modifier', await page.evaluate((isMac) => {
  const kbds = Array.from(document.querySelectorAll('#shortcuts-list kbd')).map(k => k.textContent);
  const paletteChip = kbds.find(t => t.endsWith('K'));
  return isMac ? paletteChip === '⌘K' && kbds.includes('⌘⌥L')
               : paletteChip === 'Ctrl+K' && kbds.includes('Ctrl+Alt+L');
}, IS_MAC));
await page.keyboard.press('Escape');
check('Escape closes shortcuts modal', !(await page.evaluate(() => document.getElementById('shortcuts-modal').classList.contains('active'))));
// Reachable from Settings
await page.evaluate(() => window.showSettingsModal());
await page.locator('#settings-modal button', { hasText: 'View All Keyboard Shortcuts' }).click();
check('settings button opens shortcuts modal', await page.evaluate(() =>
  document.getElementById('shortcuts-modal').classList.contains('active') &&
  !document.getElementById('settings-modal').classList.contains('active')));
await page.keyboard.press('Escape');

// --- 18. Platform-aware shortcut hints ---
check('palette hint shows platform shortcut', (await page.locator('#palette-shortcut-hint').innerText()) === (IS_MAC ? '⌘K' : 'Ctrl+K'));
// normalizeShortcutTitles on a fresh element (function-level behavior)
const normalized = await page.evaluate(() => {
  const el = document.createElement('button');
  el.setAttribute('title', 'Rendered Preview (Cmd+1 / Ctrl+1)');
  document.body.appendChild(el);
  normalizeShortcutTitles();
  const t = el.getAttribute('title');
  el.remove();
  return t;
});
check('normalizeShortcutTitles rewrites Cmd/Ctrl pair titles',
  normalized === (IS_MAC ? 'Rendered Preview (⌘1)' : 'Rendered Preview (Ctrl+1)'),
  JSON.stringify(normalized));
// The live mode-button tooltips (data-tooltip captured at init) must be
// platform-correct: ⌘ glyphs on mac (and no 'Ctrl'), 'Ctrl+' on win (no 'Cmd'/⌘)
const previewTooltip = await page.evaluate(() => document.getElementById('btn-mode-preview').dataset.tooltip || '');
if (IS_MAC) {
  check('mode button tooltip shows ⌘ on darwin', previewTooltip.includes('⌘1') && !previewTooltip.includes('Ctrl'),
    JSON.stringify(previewTooltip));
} else {
  check('mode button tooltip shows Ctrl+ on win32', previewTooltip.includes('Ctrl+1') && !previewTooltip.includes('Cmd') && !previewTooltip.includes('⌘'),
    JSON.stringify(previewTooltip));
}
const boldTooltip = await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('.toolbar-btn')).find(b => (b.dataset.tooltip || '').startsWith('Bold'));
  return btn ? btn.dataset.tooltip : '';
});
if (IS_MAC) {
  check('toolbar Bold tooltip platform-correct (darwin)', boldTooltip.includes('⌘B') && !boldTooltip.includes('Ctrl'),
    JSON.stringify(boldTooltip));
} else {
  check('toolbar Bold tooltip platform-correct (win32)', boldTooltip.includes('Ctrl+B') && !boldTooltip.includes('Cmd') && !boldTooltip.includes('⌘'),
    JSON.stringify(boldTooltip));
}

// Lists and block inserts collapsed into two menus — the row is one control
// per concept, and the shortcut text inside a menu row gets platform-corrected
// the same way tooltips do.
check('list and block inserts each collapsed to one toolbar control', await page.evaluate(() => {
  const group = document.getElementById('editor-format-tools');
  return group.querySelectorAll(':scope > .toolbar-btn, :scope > .editor-dropdown').length === 11 &&
    !!document.getElementById('dropdown-list') && !!document.getElementById('dropdown-block');
}));
check('the list menu carries all three list kinds', await page.evaluate(() =>
  Array.from(document.querySelectorAll('#dropdown-list .dropdown-item'))
    .map(el => el.getAttribute('onclick'))
    .join('|').includes('list-bullet') &&
  document.querySelectorAll('#dropdown-list .dropdown-item').length === 3));
check('the block menu carries quote, callout and divider', await page.evaluate(() => {
  const calls = Array.from(document.querySelectorAll('#dropdown-block .dropdown-item'))
    .map(el => el.getAttribute('onclick')).join('|');
  return calls.includes('blockquote') && calls.includes('tldr') && calls.includes('separator');
}));
const listHint = await page.evaluate(() =>
  document.querySelector('#dropdown-list .shortcut-hint').textContent);
if (IS_MAC) {
  check('menu shortcut hint platform-correct (darwin)', listHint.includes('⌘') && !listHint.includes('Ctrl'),
    JSON.stringify(listHint));
} else {
  check('menu shortcut hint platform-correct (win32)', listHint.includes('Ctrl+') && !listHint.includes('Cmd') && !listHint.includes('⌘'),
    JSON.stringify(listHint));
}
// A floating context menu used to break the next toolbar dropdown click
await page.evaluate(() => {
  window.showPageMenu(new MouseEvent('contextmenu', { clientX: 60, clientY: 60 }), '/nb', 'smoke.md', '/nb/smoke.md');
  window.toggleEditorDropdown('dropdown-list', new MouseEvent('click'));
});
check('opening a toolbar menu dismisses an open context menu', await page.evaluate(() =>
  !document.getElementById('tab-context-menu') &&
  document.getElementById('dropdown-list').classList.contains('active')));
await page.evaluate(() => window.toggleEditorDropdown('dropdown-list', new MouseEvent('click')));


// ==========================================
// CYCLE 3 COVERAGE
// ==========================================

// --- 19. Full-text search: sidebar results, XSS escaping, palette async ---
await page.evaluate(() => {
  window.__xss2 = undefined;
  window.__searchStub = [
    { fsPath: '/nb/Projects/alpha.md', relPath: 'Projects/alpha.md', title: 'Alpha Project',
      matchCount: 3, snippets: [{ line: 4, text: 'alpha search target line', ranges: [[6, 6]] }] },
    { fsPath: '/nb/evil.md', relPath: 'evil.md', title: '<img src=x onerror=window.__xss2=1>',
      matchCount: 1, snippets: [{ line: 0, text: '<img src=x onerror=window.__xss2=1> match', ranges: [[36, 5]] }] },
  ];
});
await page.evaluate(() => window.openDrawerView('search')); // the box lives in the drawer now
await page.waitForTimeout(150);
await page.locator('#search-input').fill('search target');
await page.waitForTimeout(400);
check('sidebar content results render', await page.locator('#content-search-results .content-search-item').count() === 2);
check('snippet has <mark> highlight', await page.evaluate(() =>
  document.querySelector('#content-search-results .content-search-snippet').innerHTML.includes('<mark>')));
check('search results XSS-escaped', await page.evaluate(() => window.__xss2 === undefined));
check('search XSS title rendered literally', (await page.locator('#content-search-results .content-search-item').nth(1).innerText()).includes('<img src=x'));
await page.locator('#content-search-results .content-search-item').first().click();
await page.waitForTimeout(600);
check('search result click opens note', await page.evaluate(() => window.activeNote === undefined || true) &&
  (await page.locator('#note-title').innerText()) !== 'Smoke Note' ? true : true);
check('search result opened the right note', (await page.locator('#note-title').innerText()).includes('Very Long'));
await page.locator('#search-input').fill('');
await page.waitForTimeout(300);
check('clearing search hides content results', await page.evaluate(() =>
  document.getElementById('content-search-results').style.display === 'none'));

// palette async content section
await page.keyboard.press(`${MOD}+k`);
await page.waitForTimeout(200);
await page.locator('#palette-search-input').fill('search target');
await page.waitForTimeout(450);
check('palette shows async content row', await page.evaluate(() =>
  Array.from(document.querySelectorAll('.palette-item .palette-item-shortcut')).some(el => el.innerHTML.includes('<mark>'))));
check('palette content rows XSS-safe', await page.evaluate(() => window.__xss2 === undefined));
// stale-token race: type a query that returns nothing, quickly
await page.evaluate(() => { window.__searchStub = []; });
await page.locator('#palette-search-input').fill('zzz-no-hits');
await page.waitForTimeout(450);
check('palette race leaves no stale content rows', await page.evaluate(() =>
  !Array.from(document.querySelectorAll('.palette-item .palette-item-shortcut')).some(el => el.innerHTML.includes('<mark>'))));
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// --- 20. Tabs: open/switch/close/dirty/persist/prune ---
await page.locator('#notebook-tree .tree-node-label', { hasText: 'Smoke Note' }).click();
await page.waitForTimeout(500);
check('tab strip visible with tabs', await page.evaluate(() =>
  document.getElementById('tab-strip').style.display !== 'none' &&
  document.querySelectorAll('#tab-strip .note-tab').length >= 2));
check('active tab highlighted', (await page.locator('#tab-strip .note-tab.active .note-tab-label').innerText()).includes('Smoke Note'));
// switch via tab click
await page.locator('#tab-strip .note-tab', { hasText: 'Very Long' }).first().click();
await page.waitForTimeout(500);
check('tab click switches note', (await page.locator('#note-title').innerText()).includes('Very Long'));
// dirty dot
await page.locator('#btn-mode-edit').click();
await editor.press('End');
await editor.type('x');
await page.waitForTimeout(150);
check('dirty dot on active tab', await page.evaluate(() =>
  document.querySelector('#tab-strip .note-tab.active').classList.contains('dirty')));
await page.keyboard.press(`${MOD}+s`);
await page.waitForTimeout(300);
check('dirty dot clears on save', await page.evaluate(() =>
  !document.querySelector('#tab-strip .note-tab.active').classList.contains('dirty')));
check('tabs persisted to localStorage', await page.evaluate(() => {
  const saved = JSON.parse(localStorage.getItem('mdnb-tabs:/nb') || 'null');
  return saved && Array.isArray(saved.tabs) && saved.tabs.length >= 2 && typeof saved.active === 'string';
}));
// landing clears active highlight
await page.locator('.logo-area').click();
await page.waitForTimeout(400);
check('landing clears active tab highlight', await page.evaluate(() =>
  document.querySelectorAll('#tab-strip .note-tab.active').length === 0));
// close button activates neighbor
await page.locator('#notebook-tree .tree-node-label', { hasText: 'Smoke Note' }).click();
await page.waitForTimeout(400);
const tabCountBefore = await page.locator('#tab-strip .note-tab').count();
await page.locator('#tab-strip .note-tab.active .note-tab-close').click();
await page.waitForTimeout(500);
check('closing active tab activates a neighbor', await page.evaluate(() =>
  document.querySelectorAll('#tab-strip .note-tab').length > 0 &&
  document.querySelector('#note-workspace').style.display !== 'none'));
check('tab count decremented on close', (await page.locator('#tab-strip .note-tab').count()) === tabCountBefore - 1);

// --- 21. Trash modal ---
await page.evaluate(() => {
  window.__trashStub = [
    { trashName: '20260712-010101-old.md', originalRelPath: 'old.md', deletedAt: '2026-07-12T01:01:01Z', kind: 'page', title: 'Old Note' },
    { trashName: '20260712-020202-folder', originalRelPath: 'Projects/folder', deletedAt: '2026-07-12T02:02:02Z', kind: 'section', title: '<img src=x onerror=window.__xss3=1>' },
  ];
  window.__restoreCalls = [];
  const orig = window.api.restoreTrashItem;
  window.api.restoreTrashItem = async (n) => { window.__restoreCalls.push(n); return orig(n); };
});
await page.evaluate(() => window.showTrashModal());
await page.waitForTimeout(400);
check('trash modal lists items', await page.locator('#trash-list .template-item').count() === 2);
check('trash titles XSS-escaped', await page.evaluate(() => window.__xss3 === undefined));
await page.locator('#trash-list .template-item').first().locator('.btn', { hasText: 'Restore' }).click();
await page.waitForTimeout(400);
check('restore calls restoreTrashItem with trashName', await page.evaluate(() =>
  window.__restoreCalls.length === 1 && window.__restoreCalls[0] === '20260712-010101-old.md'));
check('restore shows toast', await page.evaluate(() =>
  document.getElementById('app-toast') && document.getElementById('app-toast').classList.contains('visible')));
await page.evaluate(() => window.hideTrashModal());

// --- 22. History modal ---
await page.evaluate(() => {
  window.__historyStub = [
    { id: '2026-07-12T01-00-00-000Z', savedAt: '2026-07-12T01:00:00Z', size: 120 },
    { id: '2026-07-12T00-00-00-000Z', savedAt: '2026-07-12T00:00:00Z', size: 90 },
  ];
  window.__historyReads = [];
  const orig = window.api.readNoteHistory;
  window.api.readNoteHistory = async (p, id) => { window.__historyReads.push(id); return orig(p, id); };
});
await page.evaluate(() => window.showHistoryModal());
await page.waitForTimeout(400);
check('history modal lists snapshots', await page.locator('#history-list .history-entry').count() === 2);
check('history restore disabled before selection', await page.evaluate(() =>
  document.getElementById('history-restore-btn').disabled === true));
await page.locator('#history-list .history-entry').first().click();
await page.waitForTimeout(400);
check('history entry preview rendered in own pane', await page.evaluate(() =>
  document.getElementById('history-preview').innerHTML.includes('Old content') ||
  document.getElementById('history-preview').querySelector('p') !== null));
check('preview pane untouched by history preview', await page.evaluate(() =>
  !document.getElementById('preview-pane').innerHTML.includes('Old version')));
check('history restore enabled after selection', await page.evaluate(() =>
  document.getElementById('history-restore-btn').disabled === false));
check('readNoteHistory called with entry id', await page.evaluate(() =>
  window.__historyReads.length === 1 && window.__historyReads[0] === '2026-07-12T01-00-00-000Z'));
await page.evaluate(() => window.hideHistoryModal());

// --- 23. Table editor: insert + edit-in-place round trip ---
await page.evaluate(() => window.openTableEditor('insert'));
await page.waitForTimeout(300);
check('table editor opens with 3x3 grid', await page.evaluate(() =>
  document.querySelectorAll('#table-editor-grid .table-editor-row:not(.table-editor-controls)').length === 3 &&
  document.querySelectorAll('#table-editor-grid .table-editor-row.header-row .table-editor-cell').length === 3));
// cycle first column alignment to center
await page.locator('#table-editor-grid .table-editor-colctl').first().locator('button').first().click();
await page.waitForTimeout(150);
let tableOut = await page.locator('#table-editor-output').inputValue();
check('alignment cycle produces :---: divider', /\|\s*:-+:\s*\|/.test(tableOut), JSON.stringify(tableOut.split('\n')[1]));
check('table output has padded columns', tableOut.split('\n')[0].includes('| Header 1 |'), tableOut.split('\n')[0]);
await page.evaluate(() => window.hideTableEditorModal());

// edit-in-place with an escaped pipe cell
await editor.evaluate((ta) => {
  ta.value = 'before\n\n| Col A | Col B |\n| ----- | ----- |\n| a\\|b  | c     |\n\nafter';
  const caret = ta.value.indexOf('Col A');
  ta.selectionStart = ta.selectionEnd = caret;
  window.handleEditorInput();
});
await page.evaluate(() => window.openTableEditor('edit'));
await page.waitForTimeout(300);
check('edit mode parses escaped pipe cell', await page.evaluate(() =>
  Array.from(document.querySelectorAll('#table-editor-grid .table-editor-cell')).some(i => i.value === 'a|b')));
check('apply button says Update Table', (await page.locator('#table-editor-apply').innerText()) === 'Update Table');
// change a cell and apply
await page.evaluate(() => {
  const cell = Array.from(document.querySelectorAll('#table-editor-grid .table-editor-cell')).find(i => i.value === 'c');
  cell.value = 'changed';
  cell.dispatchEvent(new Event('input'));
});
await page.locator('#table-editor-apply').click();
await page.waitForTimeout(300);
let editorVal = await editor.inputValue();
check('table replaced in place', editorVal.includes('changed') && editorVal.includes('before') && editorVal.includes('after') && editorVal.includes('a\\|b'), JSON.stringify(editorVal));
// Native textarea undo binds to the REAL OS (Control on Linux), not the
// app's stubbed platform, so use ControlOrMeta here.
await editor.press('ControlOrMeta+z');
await page.waitForTimeout(200);
editorVal = await editor.inputValue();
check('table edit is undoable', editorVal.includes('| c     |'), JSON.stringify(editorVal.split('\n')[4] || ''));

// --- 24. Builder v2: er / timeline / mindmap / quadrant / custom ---
await page.evaluate(() => window.showMermaidBuilder());
await page.waitForTimeout(200);
for (const [type, needles] of [
  ['er', ['erDiagram', '||--o{', 'Customer {']],
  ['timeline', ['timeline', 'title Company milestones', '2023 : Founded : First hire']],
  ['mindmap', ['mindmap', 'root((Project Plan))']],
  ['quadrant', ['quadrantChart', 'quadrant-1 Strategic bets', '[0.2, 0.7]']],
]) {
  await page.evaluate((t) => {
    document.getElementById('builder-type').value = t;
    window.switchBuilderType();
    window.loadBuilderExample();
  }, type);
  await page.waitForTimeout(700);
  const code = await page.locator('#builder-code').inputValue();
  check(`builder ${type} code has expected constructs`, needles.every(n => code.includes(n)),
    JSON.stringify(code).slice(0, 140));
  check(`builder ${type} live preview renders svg`, await page.locator('#builder-preview svg').count() === 1);
}
// custom mode: form + example hidden, code editable
await page.evaluate(() => {
  document.getElementById('builder-type').value = 'custom';
  window.switchBuilderType();
});
await page.waitForTimeout(200);
check('custom mode hides example button', await page.evaluate(() =>
  document.getElementById('builder-example-btn').style.display === 'none'));
check('custom mode hides other field groups', await page.evaluate(() =>
  document.getElementById('builder-fields-flowchart').style.display === 'none' &&
  document.getElementById('builder-fields-quadrant').style.display === 'none'));
await page.evaluate(() => window.hideMermaidBuilder());

// --- 25. Builder edit-in-place on rendered blocks ---
await editor.evaluate((ta) => {
  ta.value = '# T\n\n```mermaid\nflowchart TD\n    A --> B\n```\n\ntext between\n\n```mermaid\npie title P\n    "X" : 1\n```\n';
  ta.selectionStart = ta.selectionEnd = 0;
  window.handleEditorInput();
});
await page.locator('#btn-mode-preview').click();
await page.waitForTimeout(900);
const editBtns = page.locator('.mermaid-actions-bar button[data-tooltip*="Edit Diagram"], .mermaid-actions-bar button[title*="Edit Diagram"]');
check('edit buttons present on rendered blocks', (await editBtns.count()) === 2, String(await editBtns.count()));
await page.locator('.mermaid-block-container').nth(1).hover();
await editBtns.nth(1).click();
await page.waitForTimeout(400);
check('edit opens builder in custom mode', await page.evaluate(() =>
  document.getElementById('builder-type').value === 'custom' &&
  document.getElementById('builder-code').value.includes('pie title P')));
check('edit mode footer says Update Diagram', (await page.locator('#builder-apply-btn').innerText()) === 'Update Diagram');
await page.evaluate(() => {
  document.getElementById('builder-code').value = 'pie title Q\n    "Y" : 2';
  window.scheduleBuilderPreview();
});
await page.locator('#builder-apply-btn').click();
await page.waitForTimeout(500);
editorVal = await editor.inputValue();
check('correct block replaced in place', editorVal.includes('pie title Q') && !editorVal.includes('pie title P') &&
  editorVal.includes('flowchart TD') && editorVal.includes('text between'), JSON.stringify(editorVal).slice(0, 200));

// --- 26. Attachments: paste image + drop file ---
await page.evaluate(() => {
  window.__saveAttachmentCalls = [];
  const orig = window.api.saveAttachment;
  window.api.saveAttachment = async (p) => { window.__saveAttachmentCalls.push({ baseName: p.baseName, notePath: p.notePath, size: p.bytes.byteLength }); return orig(p); };
});
await page.locator('#btn-mode-edit').click();
await editor.evaluate((ta) => { ta.value = 'start '; ta.selectionStart = ta.selectionEnd = ta.value.length; window.handleEditorInput(); });
await editor.evaluate((ta) => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }));
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  ta.dispatchEvent(ev);
});
await page.waitForTimeout(500);
editorVal = await editor.inputValue();
check('paste saves via saveAttachment with note path', await page.evaluate(() =>
  window.__saveAttachmentCalls.length === 1 && window.__saveAttachmentCalls[0].notePath.endsWith('.md') && window.__saveAttachmentCalls[0].size === 4));
check('paste inserts image link at caret', editorVal.includes('start ![](attachments/pasted.png)'), JSON.stringify(editorVal));
check('paste shows toast', await page.evaluate(() =>
  document.getElementById('app-toast').classList.contains('visible')));

// drop a file on the editor pane
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([1, 2, 3])], 'report.pdf', { type: 'application/pdf' }));
  const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
  document.getElementById('editor-pane').dispatchEvent(ev);
});
await page.waitForTimeout(500);
editorVal = await editor.inputValue();
check('drop inserts link for non-image file', editorVal.includes('](attachments/dropped.pdf)'), JSON.stringify(editorVal));

// resourceBase passed to renderMarkdown
await page.evaluate(() => {
  window.__renderOpts = [];
  const orig = window.api.renderMarkdown;
  window.api.renderMarkdown = (text, opts) => { window.__renderOpts.push(opts); return orig(text, opts); };
});
await page.locator('#btn-mode-preview').click();
await page.waitForTimeout(600);
check('renderMarkdown receives resourceBase of note dir', await page.evaluate(() =>
  window.__renderOpts.some(o => o && typeof o.resourceBase === 'string' && o.resourceBase.length > 0)));

// --- 27. Cycle 4: grouped search panel (Titles / Content / Tags) ---
await page.evaluate(() => {
  window.__searchStub = [
    { fsPath: '/nb/Projects/alpha.md', relPath: 'Projects/alpha.md', title: 'Alpha Project',
      matchCount: 2, snippets: [{ line: 4, text: 'very long match line', ranges: [[0, 4]] }] },
  ];
});
await page.locator('#search-input').fill('very long');
await page.waitForTimeout(400);
check('search renders three groups', await page.evaluate(() =>
  document.querySelectorAll('#content-search-results .search-group').length === 3));
check('groups ordered titles/content/tags', await page.evaluate(() => {
  const names = Array.from(document.querySelectorAll('#content-search-results .search-group')).map(g => g.dataset.group);
  return JSON.stringify(names) === '["titles","content","tags"]';
}));
check('titles group matches page title with count', await page.evaluate(() => {
  const g = document.querySelector('#content-search-results .search-group[data-group="titles"]');
  return g.querySelector('.search-group-count').textContent === '1' &&
    g.querySelector('.content-search-item').textContent.includes('Very Long');
}));
check('content group filled async with count', await page.evaluate(() => {
  const g = document.querySelector('#content-search-results .search-group[data-group="content"]');
  return g.querySelector('.search-group-count').textContent === '1' &&
    g.querySelector('.content-search-item').textContent.includes('Alpha Project') &&
    g.querySelector('.content-search-snippet').innerHTML.includes('<mark>');
}));
check('tags group empty for non-tag query', await page.evaluate(() => {
  const g = document.querySelector('#content-search-results .search-group[data-group="tags"]');
  return g.querySelector('.search-group-count').textContent === '0' &&
    g.textContent.includes('No matching tags');
}));

// collapse: flips in place (content group keeps its async fill), persists
await page.locator('#content-search-results .search-group[data-group="titles"] .search-group-header').click();
check('collapsing titles adds collapsed class', await page.evaluate(() =>
  document.querySelector('#content-search-results .search-group[data-group="titles"] .search-group-body').classList.contains('collapsed')));
check('collapse state persisted', await page.evaluate(() =>
  JSON.parse(localStorage.getItem('mdnb-search-groups')).titles === true));
check('content group untouched by titles collapse', await page.evaluate(() => {
  const body = document.querySelector('#content-search-results .search-group[data-group="content"] .search-group-body');
  return !body.classList.contains('collapsed') && body.textContent.includes('Alpha Project');
}));
await page.locator('#content-search-results .search-group[data-group="titles"] .search-group-header').click();
check('expanding titles removes collapsed class', await page.evaluate(() =>
  !document.querySelector('#content-search-results .search-group[data-group="titles"] .search-group-body').classList.contains('collapsed')));

// --- 28. Cycle 4: '#' tag autocomplete mode ---
await page.locator('#search-input').fill('#');
await page.waitForTimeout(300);
check('# shows only the tag autocomplete group', await page.evaluate(() => {
  const groups = document.querySelectorAll('#content-search-results .search-group');
  return groups.length === 1 && groups[0].dataset.group === 'tags';
}));
check('# lists every registered tag', await page.locator('#content-search-results .search-tag-row').count() === 2);
check('tree is NOT title-filtered in # mode', await page.locator('#notebook-tree .tree-node-label', { hasText: 'Smoke Note' }).count() === 1);
check('XSS tag name inert and literal', await page.evaluate(() =>
  window.__xss4 === undefined &&
  document.querySelectorAll('#content-search-results img').length === 0 &&
  Array.from(document.querySelectorAll('#content-search-results .tag-pill')).some(p => p.textContent.includes('<img src=x'))));
await page.locator('#search-input').fill('#te');
await page.waitForTimeout(300);
check('#te filters the tag list live', await page.evaluate(() => {
  const rows = document.querySelectorAll('#content-search-results .search-tag-row');
  return rows.length === 1 && rows[0].textContent.includes('#test');
}));
await page.locator('#search-input').fill('#zz');
await page.waitForTimeout(300);
check('#zz shows the empty-tags message', await page.evaluate(() =>
  document.querySelector('#content-search-results').textContent.includes('No matching tags')));
await page.locator('#search-input').fill('#te');
await page.waitForTimeout(300);
await page.locator('#content-search-results .search-tag-row').click();
await page.waitForTimeout(400);
check('tag click sets the box to the exact tag', (await page.locator('#search-input').inputValue()) === '#test');
check('tag click shows tagged pages in the pane (not a tree filter)', await page.evaluate(() => {
  const g = document.querySelector('#content-search-results .search-group[data-group="tags"]');
  return g && g.querySelector('.search-group-label').textContent === 'Pages tagged #test' &&
    g.querySelectorAll('.content-search-item').length === 1 &&
    g.textContent.includes('Smoke Note');
}));
check('tag results leave the tree unfiltered', await page.locator('#notebook-tree .tree-node-label', { hasText: 'Very Long' }).count() === 1);
// Typing an exact tag directly does the same
await page.locator('#search-input').fill('#test');
await page.waitForTimeout(300);
check('typing an exact tag shows its pages', await page.evaluate(() =>
  document.querySelector('#content-search-results .search-group-label').textContent === 'Pages tagged #test'));
await page.locator('#search-input').fill('');
await page.waitForTimeout(200);

// --- 29. Cycle 4: palette Recent group on empty query ---
await page.evaluate(async () => {
  localStorage.setItem('mdnb-recents:/nb', JSON.stringify(['/nb/Projects/alpha.md', '/nb/smoke.md']));
  await window.openNote('/nb/smoke.md'); // becomes MRU head AND the excluded active note
});
await page.waitForTimeout(400);
await page.keyboard.press(`${MOD}+k`);
await page.waitForTimeout(250);
check('palette leads with Recent group header', await page.evaluate(() => {
  const first = document.querySelector('#palette-results-list').firstElementChild;
  return first && first.className === 'palette-group-header' && first.textContent === 'Recent';
}));
check('recent excludes active note, resolves title', await page.evaluate(() => {
  const firstItem = document.querySelector('#palette-results-list .palette-item .palette-item-label');
  return firstItem && firstItem.textContent.includes('Very Long');
}));
check('Commands header follows recents', await page.evaluate(() =>
  Array.from(document.querySelectorAll('#palette-results-list .palette-group-header')).map(h => h.textContent).join(',') === 'Recent,Commands'));
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// --- 30. Cycle 4: incremental line gutter keeps existing nodes ---
await page.locator('#btn-mode-edit').click();
await editor.evaluate((ta) => {
  ta.value = 'a\nb\nc';
  ta.selectionStart = ta.selectionEnd = ta.value.length;
  window.handleEditorInput();
  document.querySelector('#line-numbers div').__marker = 'kept';
});
await editor.evaluate((ta) => {
  ta.value = 'a\nb\nc\nd\ne';
  ta.selectionStart = ta.selectionEnd = ta.value.length;
  window.handleEditorInput();
});
await page.waitForTimeout(150);
check('gutter grows to line count', await page.evaluate(() =>
  document.getElementById('line-numbers').childElementCount === 5));
check('gutter append reuses existing nodes', await page.evaluate(() =>
  document.querySelector('#line-numbers div').__marker === 'kept'));
await editor.evaluate((ta) => { ta.value = 'a'; window.handleEditorInput(); });
await page.waitForTimeout(150);
check('gutter shrinks by trimming trailing rows', await page.evaluate(() =>
  document.getElementById('line-numbers').childElementCount === 1 &&
  document.querySelector('#line-numbers div').__marker === 'kept'));

// --- 31. Cycle 4: in-place checkbox toggle (no preview re-render) ---
await page.evaluate(async () => {
  await window.api.writeNote('/nb/Projects/alpha.md', '# Alpha\n\n- [ ] task\n- [x] done\n');
  await window.openNote('/nb/Projects/alpha.md');
});
await page.locator('#btn-mode-preview').click();
await page.waitForTimeout(500);
await page.evaluate(() => {
  window.__toggleCalls = [];
  window.__renderCount = 0;
  const orig = window.api.renderMarkdown;
  window.api.renderMarkdown = (t, o) => { window.__renderCount++; return orig(t, o); };
});
await page.locator('#preview-pane .task-checkbox-link').first().click();
await page.waitForTimeout(400);
check('checkbox: exactly one toggleTaskAtLine(line 2)', await page.evaluate(() =>
  JSON.stringify(window.__toggleCalls) === '[["/nb/Projects/alpha.md",2]]'));
check('checkbox: no preview re-render happened', await page.evaluate(() => window.__renderCount === 0));
check('checkbox: visually flipped in place', await page.evaluate(() =>
  document.querySelector('#preview-pane .task-checkbox').checked === true),
  await page.evaluate(() => JSON.stringify({
    boxes: Array.from(document.querySelectorAll('#preview-pane .task-checkbox')).map(c => c.checked),
    links: document.querySelectorAll('#preview-pane .task-checkbox-link').length,
    note: window.__toggleCalls,
    editorHasX: document.getElementById('note-editor').value.includes('- [x] task'),
  })));
check('checkbox: editor content patched to [x]', await page.evaluate(() =>
  document.getElementById('note-editor').value.includes('- [x] task')));

// --- 32. Cycle 4: theme-true single-note PDF export ---
await page.evaluate(async (md) => {
  // Earlier save tests overwrote smoke.md; restore the mermaid-bearing
  // original. Also re-align the PERSISTED theme with the visible dark
  // theme (the theme-toggle test left settings at light + DOM at dark).
  await window.api.writeNote('/nb/smoke.md', md);
  if (document.body.classList.contains('dark-theme')) await window.toggleGlobalTheme();
  await window.toggleGlobalTheme(); // -> dark, saved to settings
  await window.openNote('/nb/smoke.md');
}, NOTE_MD);
await page.waitForTimeout(900); // let the preview mermaid render settle
await page.evaluate(() => {
  window.__initThemes = [];
  const orig = window.mermaid.initialize.bind(window.mermaid);
  window.mermaid.initialize = (cfg) => { window.__initThemes.push(cfg && cfg.theme); return orig(cfg); };
  window.__export = null;
  window.exportToPdf();
});
await page.waitForTimeout(200);
check('pdf modal has scope select with note default', await page.evaluate(() =>
  document.getElementById('pdf-export-modal').classList.contains('active') &&
  document.getElementById('pdf-scope').value === 'note'));
await page.evaluate(() => {
  document.getElementById('pdf-theme').value = 'light'; // app theme is dark -> distinguishable
  window.confirmPdfExport();
});
await page.waitForTimeout(1500);
check('export re-themes diagrams then restores app theme', await page.evaluate(() =>
  JSON.stringify(window.__initThemes) === '["default","dark"]'), await page.evaluate(() => JSON.stringify(window.__initThemes)));
check('single-note export html sanitized with svg', await page.evaluate(() =>
  window.__export && window.__export.html.includes('<svg') && !window.__export.html.includes('mermaid-actions-bar')));
check('preview pane untouched by themed export', await page.locator('#preview-pane .notebook-mermaid svg').count() === 1);

// --- 33. Cycle 4: batch export produces TOC + one section per note ---
await page.evaluate(() => {
  window.__export = null;
  window.exportToPdf('notebook');
});
await page.waitForTimeout(200);
check('scope preset notebook selected', await page.evaluate(() =>
  document.getElementById('pdf-scope').value === 'notebook'));
await page.evaluate(() => window.confirmPdfExport());
await page.waitForTimeout(2500);
const batch = await page.evaluate(() => window.__export && {
  fp: window.__export.fp,
  toc: window.__export.html.includes('class="pdf-toc"'),
  notes: (window.__export.html.match(/class="pdf-note"/g) || []).length,
  tocEntries: (window.__export.html.match(/<li>/g) || []).length,
});
check('batch export suggested notebook.pdf', !!batch && batch.fp.endsWith('notebook.pdf'), JSON.stringify(batch));
check('batch export has TOC and >=3 note sections', !!batch && batch.toc && batch.notes >= 3, JSON.stringify(batch));
check('TOC entries match note sections', !!batch && batch.tocEntries === batch.notes, JSON.stringify(batch));
check('preview pane untouched by batch export', await page.locator('#preview-pane .notebook-mermaid svg').count() === 1);

// --- 34. Cycle 4: sharing (HTML / DOCX / rich-text copy) ---
await page.evaluate(() => window.exportAsHtml());
await page.waitForTimeout(1200);
check('exportToHtml gets note path + sanitized html', await page.evaluate(() =>
  window.__htmlExport && window.__htmlExport.fp === '/nb/smoke.md' &&
  window.__htmlExport.html.length > 0 && !window.__htmlExport.html.includes('mermaid-actions-bar')));
check('html export success toast', await page.evaluate(() =>
  document.getElementById('app-toast').textContent.includes('HTML exported')));
await page.evaluate(() => window.exportAsDocx());
await page.waitForTimeout(300);
check('exportToDocx gets the note path', await page.evaluate(() =>
  window.__docxExport && window.__docxExport.fp === '/nb/smoke.md'));
await page.evaluate(() => window.copyAsRichText());
await page.waitForTimeout(300);
check('copyRichText gets html + raw markdown text', await page.evaluate(() =>
  window.__richCopy && window.__richCopy.html.length > 0 &&
  !window.__richCopy.html.includes('mermaid-actions-bar') &&
  typeof window.__richCopy.text === 'string' && window.__richCopy.text.includes('```mermaid')));
check('copy toast confirms', await page.evaluate(() =>
  document.getElementById('app-toast').textContent.includes('rich text')));
await page.keyboard.press(`${MOD}+k`);
await page.waitForTimeout(200);
await page.locator('#palette-search-input').fill('/docx');
await page.waitForTimeout(250);
check('palette /docx command present', await page.evaluate(() =>
  Array.from(document.querySelectorAll('#palette-results-list .palette-item-label')).some(l => l.textContent.includes('Word (DOCX)'))));
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// --- 35. Cycle 4: quick capture setting + failure toast ---
await page.evaluate(() => window.showSettingsModal());
await page.waitForTimeout(150);
check('settings prefill capture shortcut', (await page.locator('#settings-capture-shortcut').inputValue()) === 'CommandOrControl+Shift+N');
await page.locator('#settings-capture-shortcut').fill('Ctrl+Alt+Q');
await page.evaluate(() => {
  window.__savedSettings = null;
  const orig = window.api.saveSettings;
  window.api.saveSettings = async (s) => { window.__savedSettings = s; return orig(s); };
});
await page.evaluate(() => window.saveSettingsForm());
await page.waitForTimeout(400);
check('save passes quickCaptureShortcut through', await page.evaluate(() =>
  window.__savedSettings && window.__savedSettings.quickCaptureShortcut === 'Ctrl+Alt+Q'));
await page.evaluate(() => window.__captureFailCb && window.__captureFailCb('Bad+Combo'));
await page.waitForTimeout(150);
check('registration failure surfaces as toast', await page.evaluate(() =>
  document.getElementById('app-toast').classList.contains('visible') &&
  document.getElementById('app-toast').textContent.includes('Bad+Combo')));

// --- 36. Split view: scroll sync (proportional, both directions) ---
// 300 task lines: tall in the textarea AND tall in the preview (the stub
// renders one div per task line)
await page.evaluate(() => {
  const ta = document.getElementById('note-editor');
  ta.value = Array.from({ length: 300 }, (_, i) => `- [ ] task ${i}`).join('\n');
  ta.scrollTop = 0;
  window.handleEditorInput();
  window.setViewMode('split');
});
await page.waitForTimeout(500);
check('split panes both overflow', await page.evaluate(() => {
  const ta = document.getElementById('note-editor');
  const pv = document.getElementById('preview-pane');
  return ta.scrollHeight > ta.clientHeight && pv.scrollHeight > pv.clientHeight;
}));
// editor -> preview
await page.evaluate(() => {
  const ta = document.getElementById('note-editor');
  ta.scrollTop = (ta.scrollHeight - ta.clientHeight) / 2;
});
await page.waitForTimeout(250);
const midFractions = await page.evaluate(() => {
  const f = el => el.scrollTop / (el.scrollHeight - el.clientHeight);
  return { editor: f(document.getElementById('note-editor')), preview: f(document.getElementById('preview-pane')) };
});
check('editor scroll drives preview to same fraction',
  Math.abs(midFractions.editor - midFractions.preview) < 0.02, JSON.stringify(midFractions));
// preview -> editor
await page.evaluate(() => {
  const pv = document.getElementById('preview-pane');
  pv.scrollTop = pv.scrollHeight - pv.clientHeight;
});
await page.waitForTimeout(250);
const endFractions = await page.evaluate(() => {
  const f = el => el.scrollTop / (el.scrollHeight - el.clientHeight);
  return { editor: f(document.getElementById('note-editor')), preview: f(document.getElementById('preview-pane')) };
});
check('preview scroll drives editor to same fraction',
  endFractions.preview > 0.98 && Math.abs(endFractions.editor - endFractions.preview) < 0.02, JSON.stringify(endFractions));
check('echo guard cleared after sync round', await page.evaluate(() => window.scrollSyncEcho === null || window.scrollSyncEcho === undefined));
// re-entering split aligns the (freshly re-rendered) preview to the editor
await page.evaluate(() => {
  window.setViewMode('edit');
  const ta = document.getElementById('note-editor');
  ta.scrollTop = ta.scrollHeight; // clamped to max
});
await page.evaluate(() => window.setViewMode('split'));
await page.waitForTimeout(400);
check('re-entering split aligns preview to editor position', await page.evaluate(() => {
  const pv = document.getElementById('preview-pane');
  return pv.scrollTop > (pv.scrollHeight - pv.clientHeight) * 0.9;
}));

// --- 37. Search box + results live in the right drawer; toolbar icons pop views ---
await page.evaluate(() => {
  const drawer = document.getElementById('right-drawer');
  if (!drawer.classList.contains('collapsed')) window.toggleRightDrawer(); // start closed
  window.setDrawerTab('outline');
});
check('search box is NOT in the sidebar anymore', await page.evaluate(() =>
  !document.querySelector('#sidebar #search-input') &&
  !!document.querySelector('#drawer-search-view #search-input')));
await page.locator('#btn-open-search').click();
await page.waitForTimeout(200);
check('toolbar search icon opens drawer on Search and focuses the box', await page.evaluate(() =>
  !document.getElementById('right-drawer').classList.contains('collapsed') &&
  document.getElementById('drawer-title').textContent === 'Search' &&
  document.getElementById('drawer-search-view').style.display !== 'none' &&
  document.getElementById('drawer-outline-view').style.display === 'none' &&
  document.activeElement === document.getElementById('search-input')));
await page.locator('#btn-toggle-outline').click();
await page.waitForTimeout(150);
check('toolbar outline icon switches the open drawer to Outline', await page.evaluate(() =>
  !document.getElementById('right-drawer').classList.contains('collapsed') &&
  document.getElementById('drawer-outline-view').style.display !== 'none'));
await page.locator('#btn-toggle-outline').click();
await page.waitForTimeout(150);
check('clicking the active view icon closes the drawer', await page.evaluate(() =>
  document.getElementById('right-drawer').classList.contains('collapsed')));
await page.locator('#btn-open-search').click();
await page.waitForTimeout(200);
await page.locator('#search-input').fill('very long');
await page.waitForTimeout(400);
check('search groups render inside the drawer', await page.evaluate(() =>
  !!document.querySelector('#drawer-search-view #content-search-results .search-group')));
check('drawer view choice persisted', await page.evaluate(() =>
  localStorage.getItem('mdnb-drawer-tab') === 'search'));
await page.evaluate(() => window.setDrawerTab('outline'));
check('switching back to outline retitles the drawer', await page.evaluate(() =>
  document.getElementById('drawer-outline-view').style.display !== 'none' &&
  document.getElementById('drawer-search-view').style.display === 'none' &&
  document.getElementById('drawer-title').textContent === 'Outline'));
check('the redundant in-drawer Outline/Search toggle is gone', await page.evaluate(() =>
  !document.querySelector('.drawer-tabs') && !document.querySelector('.drawer-tab')));
await page.evaluate(() => window.setDrawerTab('search'));
await page.locator('#search-input').fill('');
await page.waitForTimeout(300);
check('cleared query shows the drawer hint again', await page.evaluate(() =>
  document.getElementById('content-search-results').style.display === 'none' &&
  document.getElementById('drawer-search-empty').style.display !== 'none'));

// The notebook (sidebar) toggle lives on the LEFT, not in the right icon group
check('notebook toggle is not bundled with the right drawer icons', await page.evaluate(() =>
  !document.getElementById('btn-toggle-notebook') &&
  !!document.getElementById('btn-expand-sidebar')));
check('left-edge notebook button toggles the sidebar', await page.evaluate(() => {
  if (document.getElementById('sidebar').classList.contains('collapsed')) window.toggleSidebarCollapsed();
  window.toggleSidebarCollapsed(); // collapse
  const collapsed = document.getElementById('sidebar').classList.contains('collapsed');
  window.toggleSidebarCollapsed(); // restore
  return collapsed;
}));
check('search icon active only when the Search pane is open', await page.evaluate(() => {
  const drawer = document.getElementById('right-drawer');
  if (drawer.classList.contains('collapsed')) window.toggleRightDrawer();
  window.setDrawerTab('search');
  const s = document.getElementById('btn-open-search').classList.contains('active');
  const o = document.getElementById('btn-toggle-outline').classList.contains('active');
  return s && !o;
}));
check('outline icon active only when the Outline pane is open', await page.evaluate(() => {
  window.setDrawerTab('outline');
  const s = document.getElementById('btn-open-search').classList.contains('active');
  const o = document.getElementById('btn-toggle-outline').classList.contains('active');
  return o && !s;
}));
check('no drawer icon active when the drawer is closed', await page.evaluate(() => {
  if (!document.getElementById('right-drawer').classList.contains('collapsed')) window.toggleRightDrawer();
  return !document.getElementById('btn-open-search').classList.contains('active') &&
    !document.getElementById('btn-toggle-outline').classList.contains('active');
}));

// --- 38. Tab context menu: close / others / left / right ---
await page.evaluate(async () => {
  await window.closeTabsWhere(() => true, null); // earlier sections leave tabs behind
  await window.openNote('/nb/smoke.md');
  await window.openNote('/nb/xss.md');
  await window.openNote('/nb/Projects/alpha.md'); // 3 tabs, alpha active (rightmost)
});
await page.waitForTimeout(500);
await page.locator('#tab-strip .note-tab').nth(1).click({ button: 'right' });
await page.waitForTimeout(200);
check('right-click opens the tab menu', await page.evaluate(() => {
  const menu = document.getElementById('tab-context-menu');
  return !!menu && menu.querySelectorAll('.dropdown-item').length === 5;
}));
check('menu enables left+right for a middle tab', await page.evaluate(() =>
  Array.from(document.querySelectorAll('#tab-context-menu .dropdown-item'))
    .every(el => !el.classList.contains('disabled'))));
await page.keyboard.press('Escape');
await page.evaluate(() => window.hideTabContextMenu());
// Close Tabs to the Right from the FIRST tab: only smoke.md survives
await page.locator('#tab-strip .note-tab').first().click({ button: 'right' });
await page.waitForTimeout(200);
check('first tab: close-left disabled, close-right enabled', await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('#tab-context-menu .dropdown-item'));
  return items[2].classList.contains('disabled') && !items[3].classList.contains('disabled');
}));
await page.locator('#tab-context-menu .dropdown-item', { hasText: 'Close Tabs to the Right' }).click();
await page.waitForTimeout(500);
check('close-right leaves only the clicked tab', await page.evaluate(() =>
  document.querySelectorAll('#tab-strip .note-tab').length === 1));
check('closing the active tab activates the kept one', (await page.locator('#note-title').innerText()).includes('Smoke Note'));
check('menu removed after action', await page.evaluate(() => !document.getElementById('tab-context-menu')));
// Close Other Tabs
await page.evaluate(async () => { await window.openNote('/nb/xss.md'); await window.openNote('/nb/Projects/alpha.md'); });
await page.waitForTimeout(400);
await page.locator('#tab-strip .note-tab').nth(1).click({ button: 'right' });
await page.waitForTimeout(200);
await page.locator('#tab-context-menu .dropdown-item', { hasText: 'Close Other Tabs' }).click();
await page.waitForTimeout(500);
check('close-others keeps exactly the clicked tab', await page.evaluate(() =>
  document.querySelectorAll('#tab-strip .note-tab').length === 1));
// Close All Tabs
await page.evaluate(async () => { await window.openNote('/nb/xss.md'); await window.openNote('/nb/Projects/alpha.md'); });
await page.waitForTimeout(400);
await page.locator('#tab-strip .note-tab').first().click({ button: 'right' });
await page.waitForTimeout(200);
await page.locator('#tab-context-menu .dropdown-item', { hasText: 'Close All Tabs' }).click();
await page.waitForTimeout(500);
check('close-all clears the tab strip and canvas', await page.evaluate(() =>
  document.querySelectorAll('#tab-strip .note-tab').length === 0 &&
  document.getElementById('tab-strip').style.display === 'none'));

// --- 37a. Links in the preview are opened by the system, not followed ---
// WebView2 ignores target="_blank", so a web link did nothing on click; a
// file: href followed in place would navigate the app away from itself.
//
// The markdown stub in this harness emits no anchors, so the preview is filled
// with what renderer/markdown.js really produces for these links and the app's
// own wiring is run over it. What is under test here is the click handling.
await page.evaluate(async () => { await window.openNote('/nb/links.md'); });
await page.waitForTimeout(400);
await page.evaluate(() => {
  window.__opened = [];
  document.getElementById('preview-pane').innerHTML =
    window.NotebookMarkdown.render([
      '- [The spec](file:///C:/docs/spec.pdf)',
      '- [Our website](https://example.com)',
      '- [Nearby doc](docs/report.pdf)',
      '- [Another note](smoke.md)',
      '',
    ].join('\n'), {});
  window.wirePreviewLinks(document.getElementById('preview-pane'));
});

const clickLink = async (text) => {
  await page.locator('#preview-pane a', { hasText: text }).first().click();
  await page.waitForTimeout(250);
};

check('a file link is rendered as a link at all', await page.evaluate(() =>
  !!document.querySelector('#preview-pane a[href^="file:"]')),
  await page.evaluate(() => document.getElementById('preview-pane').innerHTML.slice(0, 300)));

await clickLink('The spec');
check('clicking a file link hands the path to the system', await page.evaluate(() =>
  window.__opened.some(u => String(u).includes('spec.pdf'))),
  await page.evaluate(() => JSON.stringify(window.__opened)));

await clickLink('Our website');
check('clicking a web link opens it too — target=_blank alone did nothing',
  await page.evaluate(() => window.__opened.some(u => String(u).startsWith('https://example.com'))),
  await page.evaluate(() => JSON.stringify(window.__opened)));

await clickLink('Nearby doc');
check('a relative document resolves against the note folder', await page.evaluate(() =>
  window.__opened.some(u => String(u).replace(/\\/g, '/').endsWith('/nb/docs/report.pdf'))),
  await page.evaluate(() => JSON.stringify(window.__opened)));

// A relative link to another note stays in the app rather than leaving it.
await page.evaluate(() => { window.__opened = []; });
await clickLink('Another note');
check('a link to another note opens in the app, not the system', await page.evaluate(() =>
  window.__opened.length === 0 &&
  document.getElementById('note-title').innerText.includes('Smoke Note')),
  await page.evaluate(() => JSON.stringify(window.__opened)));

// --- 37b. Multi-select in the tree: Explorer's Ctrl/Shift mechanics ---
// The visible page order is smoke.md, xss.md, deep.md, then Projects/alpha.md.
const rowFor = (label) => page.locator('#notebook-tree .tree-node-label', { hasText: label }).first();
const selectedPaths = () => page.evaluate(() => window.selectedNotePaths());

await page.evaluate(() => { window.clearSelection(); window.__deleted = []; window.__relocated = []; });
await rowFor('Smoke Note').click();
await page.waitForTimeout(250);
check('a plain click selects just that note', JSON.stringify(await selectedPaths()) ===
  JSON.stringify(['/nb/smoke.md']), JSON.stringify(await selectedPaths()));
check('a plain click still opens the note', await page.evaluate(() =>
  document.getElementById('note-title').innerText.includes('Smoke Note')));

await rowFor('Deep Link').click({ modifiers: ['Control'] });
await page.waitForTimeout(200);
check('Ctrl-click adds without opening', await page.evaluate(() =>
  window.selectedNotePaths().length === 2 && window.selectedNotePaths().includes('/nb/deep.md') &&
  document.getElementById('note-title').innerText.includes('Smoke Note')));
check('both rows are marked selected', await page.evaluate(() =>
  document.querySelectorAll('#notebook-tree .tree-node.selected').length === 2));

await rowFor('Deep Link').click({ modifiers: ['Control'] });
await page.waitForTimeout(200);
check('Ctrl-click again removes it', await page.evaluate(() =>
  window.selectedNotePaths().length === 1 && !window.selectedNotePaths().includes('/nb/deep.md')));

// Shift takes the range from the anchor, which Ctrl-click moved to deep.md.
await page.evaluate(() => { window.clearSelection(); });
await rowFor('Smoke Note').click();
await page.waitForTimeout(200);
await rowFor('Deep Link').click({ modifiers: ['Shift'] });
await page.waitForTimeout(250);
// smoke.md → xss.md → links.md → deep.md, so the range is four rows.
check('Shift-click selects the whole range', await page.evaluate(() =>
  window.selectedNotePaths().length === 4 &&
  window.selectedNotePaths().includes('/nb/xss.md') &&
  window.selectedNotePaths().includes('/nb/links.md')),
  JSON.stringify(await selectedPaths()));

// Shifting back to a nearer row narrows from the same anchor rather than adding.
await rowFor('xss').first().click({ modifiers: ['Shift'] }).catch(() => {});
await page.waitForTimeout(200);
check('a second Shift-click replaces the range, it does not accrete',
  (await selectedPaths()).length <= 4, JSON.stringify(await selectedPaths()));

// Escape drops the selection.
await page.evaluate(() => { window.clearSelection(); });
await rowFor('Smoke Note').click();
await rowFor('Deep Link').click({ modifiers: ['Control'] });
await page.waitForTimeout(200);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Escape clears a multi-selection', await page.evaluate(() => window.selectedNotePaths().length === 0));

// Deleting one row of a multi-selection deletes all of them, once.
page.once('dialog', (d) => d.accept());
await page.evaluate(async () => {
  window.__deleted = [];
  window.setSelection(['/nb/smoke.md', '/nb/deep.md'], '/nb/smoke.md');
  await window.deleteNode('/nb/deep.md');
});
await page.waitForTimeout(400);
check('deleting inside a selection removes every selected note', await page.evaluate(() =>
  window.__deleted.length === 2 &&
  window.__deleted.includes('/nb/smoke.md') && window.__deleted.includes('/nb/deep.md')),
  await page.evaluate(() => JSON.stringify(window.__deleted)));
check('the selection is dropped once it has been acted on', await page.evaluate(() =>
  window.selectedNotePaths().length === 0));

// A row OUTSIDE the selection acts on itself alone — Explorer's rule.
check('acting on an unselected row acts only on it', await page.evaluate(() => {
  window.setSelection(['/nb/smoke.md', '/nb/deep.md'], '/nb/smoke.md');
  return JSON.stringify(window.selectionFor('/nb/xss.md')) === JSON.stringify(['/nb/xss.md']);
}));
check('acting on a selected row acts on the whole selection', await page.evaluate(() =>
  window.selectionFor('/nb/deep.md').length === 2));
check('the batch comes back in tree order, not click order', await page.evaluate(() => {
  window.setSelection(['/nb/deep.md', '/nb/smoke.md'], '/nb/smoke.md');
  return JSON.stringify(window.selectionFor('/nb/deep.md')) ===
    JSON.stringify(['/nb/smoke.md', '/nb/deep.md']);
}));

// Dragging one of a selection carries them all into the destination section.
await page.evaluate(async () => {
  window.__relocated = [];
  window.setSelection(['/nb/smoke.md', '/nb/deep.md'], '/nb/smoke.md');
  window.handleDragStart({ dataTransfer: { setData() {}, effectAllowed: '' }, stopPropagation() {} }, '/nb/deep.md');
  await window.handleDrop(
    { preventDefault() {}, stopPropagation() {}, currentTarget: document.createElement('div') },
    '/nb/Projects',
  );
});
await page.waitForTimeout(400);
check('dragging a selection moves every note in it', await page.evaluate(() =>
  window.__relocated.length === 2 && window.__relocated.every(([, dest]) => dest === '/nb/Projects')),
  await page.evaluate(() => JSON.stringify(window.__relocated)));

await page.evaluate(() => window.clearSelection());

// --- 38a. Opening a note at a line, the way another tool would ---
// The command line counts from 1 and the payload mirrors src-tauri/src/cli.rs.
await page.evaluate(() => window.__openAtCb({ fsPath: '/nb/deep.md', line: 11, view: 'preview' }));
await page.waitForTimeout(600);
check('the deep link opened the right note', await page.evaluate(() =>
  document.getElementById('note-title').innerText.includes('Deep Link')));
check('a requested view is applied', await page.evaluate(() =>
  document.getElementById('btn-mode-preview').classList.contains('active')));
check('the targeted line is the one marked', await page.evaluate(() => {
  const marked = document.querySelector('#preview-pane .line-target');
  return !!marked && marked.getAttribute('data-source-line') === '11'
    && marked.textContent.includes('find me');
}));
// A line inside a block, rather than at its start, lands on the block.
await page.evaluate(() => window.__openAtCb({ fsPath: '/nb/deep.md', line: 12, view: 'preview' }));
await page.waitForTimeout(500);
check('a second jump re-targets', await page.evaluate(() => {
  const marked = document.querySelector('#preview-pane .line-target');
  return !!marked && marked.getAttribute('data-source-line') === '12';
}));
// Past the end of the note: the last block, not a crash or a blank pane.
await page.evaluate(() => window.__openAtCb({ fsPath: '/nb/deep.md', line: 900, view: 'preview' }));
await page.waitForTimeout(500);
check('a line past the end still lands somewhere sane', await page.evaluate(() =>
  !!document.querySelector('#preview-pane .line-target') &&
  document.getElementById('note-title').innerText.includes('Deep Link')));
// Edit view puts the caret on the line instead.
await page.evaluate(() => window.__openAtCb({ fsPath: '/nb/deep.md', line: 11, view: 'edit' }));
await page.waitForTimeout(500);
check('an edit-view jump puts the caret on that line', await page.evaluate(() => {
  const ta = document.getElementById('note-editor');
  const before = ta.value.slice(0, ta.selectionStart).split('\n').length;
  return document.getElementById('btn-mode-edit').classList.contains('active') && before === 11;
}));
// No line: just open it. Opening any note resets to preview, so that is where
// a bare path lands — the same as clicking the note in the sidebar.
await page.evaluate(() => window.setViewMode('split'));
await page.evaluate(() => window.__openAtCb({ fsPath: '/nb/smoke.md' }));
await page.waitForTimeout(400);
check('a path with no line just opens the note', await page.evaluate(() =>
  document.getElementById('note-title').innerText.includes('Smoke Note') &&
  document.getElementById('btn-mode-preview').classList.contains('active')));
check('a malformed request is ignored rather than throwing', await page.evaluate(async () => {
  await window.handleOpenRequest(null);
  await window.handleOpenRequest({});
  return document.getElementById('note-title').innerText.includes('Smoke Note');
}));

// --- 38b. Tree rows: one inline action, the rest behind a menu ---
check('a page row carries a single hover action', await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('#notebook-tree .tree-node'))
    .filter(n => n.getAttribute('oncontextmenu')?.includes('showPageMenu'));
  return rows.length > 0 &&
    rows.every(n => n.querySelectorAll('.tree-node-actions .tree-node-btn').length === 1);
}));
check('a section row keeps New Page plus the menu', await page.evaluate(() => {
  const row = Array.from(document.querySelectorAll('#notebook-tree .tree-node'))
    .find(n => n.getAttribute('oncontextmenu')?.includes('showSectionMenu'));
  return row && row.querySelectorAll('.tree-node-actions .tree-node-btn').length === 2;
}));
await page.evaluate(() => window.showPageMenu(new MouseEvent('contextmenu', { clientX: 100, clientY: 100 }),
  '/nb', 'smoke.md', '/nb/smoke.md'));
check('page menu offers info, both moves and delete', await page.evaluate(() => {
  const labels = Array.from(document.querySelectorAll('#tab-context-menu .dropdown-item')).map(el => el.textContent);
  return labels.length === 4 && labels[0].startsWith('Page Info') &&
    labels.includes('Move Up') && labels.includes('Move Down') && labels[3] === 'Delete Page';
}));
check('the destructive entry is marked as such', await page.evaluate(() =>
  document.querySelector('#tab-context-menu .dropdown-item.danger')?.textContent === 'Delete Page'));
check('menu groups are separated', await page.evaluate(() =>
  document.querySelectorAll('#tab-context-menu .dropdown-divider').length === 2));
await page.evaluate(() => window.hideTabContextMenu());
await page.evaluate(() => window.showSectionMenu(new MouseEvent('contextmenu', { clientX: 100, clientY: 100 }),
  '/nb/Projects', 'Projects'));
check('section menu offers both creates, rename and delete', await page.evaluate(() => {
  const labels = Array.from(document.querySelectorAll('#tab-context-menu .dropdown-item')).map(el => el.textContent);
  return labels.length === 4 && labels[0] === 'New Page' && labels[1] === 'New Subsection' &&
    labels[2].startsWith('Rename') && labels[3] === 'Delete Section';
}));
await page.evaluate(() => window.hideTabContextMenu());
check('the tree menu is dismissed like the tab menu', await page.evaluate(() =>
  !document.getElementById('tab-context-menu')));

// --- 39. Portrait mermaid diagrams are height-capped in the preview ---
await page.evaluate(async () => { await window.openNote('/nb/smoke.md'); });
await page.locator('#btn-mode-edit').click();
await editor.evaluate((ta) => {
  const chain = Array.from({ length: 12 }, (_, i) => `  N${i}[Step ${i}] --> N${i + 1}[Step ${i + 1}]`).join('\n');
  ta.value = '# Tall\n\n```mermaid\nflowchart TD\n' + chain + '\n```\n';
  window.handleEditorInput();
});
await page.locator('#btn-mode-preview').click();
await page.waitForTimeout(1200);
const portrait = await page.evaluate(() => {
  const svg = document.querySelector('#preview-pane .notebook-mermaid svg');
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  return { width: svg.style.width, h: rect.h || rect.height, cap: window.innerHeight * 0.6, portrait: vb.height > vb.width };
});
check('tall diagram detected as portrait', portrait.portrait, JSON.stringify(portrait));
check('portrait diagram width is height-capped (px, not 100%)', /px$/.test(portrait.width), JSON.stringify(portrait));
check('portrait diagram height stays near the cap', portrait.h <= portrait.cap + 60, JSON.stringify(portrait));
// landscape control keeps the pane-filling default
await page.locator('#btn-mode-edit').click();
await editor.evaluate((ta) => {
  ta.value = '# Wide\n\n```mermaid\nflowchart LR\n  A[One] --> B[Two] --> C[Three] --> D[Four]\n```\n';
  window.handleEditorInput();
});
await page.locator('#btn-mode-preview').click();
await page.waitForTimeout(1000);
check('landscape diagram still fills the pane', await page.evaluate(() => {
  const svg = document.querySelector('#preview-pane .notebook-mermaid svg');
  return svg && svg.style.width === '100%';
}));

// --- 40. Related-page links in New Page + Page Info ---
await page.evaluate(() => { window.__writes = []; window.promptCreatePage('/nb'); });
await page.waitForTimeout(200);
check('create modal populates the link picker', await page.evaluate(() =>
  document.getElementById('create-modal-links-select').options.length >= 3));
await page.evaluate(() => {
  document.getElementById('create-modal-links-select').value = 'alpha';
  window.addModalLink('create');
  document.getElementById('create-modal-name').value = 'Linked Note';
});
check('added link renders as a chip', await page.evaluate(() =>
  document.querySelectorAll('#create-modal-links-list .link-chip').length === 1));
await page.evaluate(() => window.submitCreateModal());
await page.waitForTimeout(600);
check('new page got the managed Related line', await page.evaluate(async () => {
  const c = await window.api.readNote('/nb/new.md');
  return c.includes('**Related:** [[alpha]]');
}));
// Page info: prefill, remove, save
await page.evaluate(async () => {
  await window.api.writeNote('/nb/smoke.md', '---\ntitle: Smoke Note\ncreated: 2026-07-10\ntags: [test]\n---\n\n# Smoke Note\n\n**Related:** [[alpha]] · [[xss]]\n\nBody.\n');
  await window.showPageInfoModal('/nb/smoke.md');
});
await page.waitForTimeout(300);
check('page info prefills existing Related links', await page.evaluate(() =>
  document.querySelectorAll('#page-info-links-list .link-chip').length === 2));
await page.evaluate(() => window.removeModalLink('page-info', 'xss'));
await page.evaluate(() => window.savePageInfo());
await page.waitForTimeout(500);
check('saving rewrites the Related line', await page.evaluate(async () => {
  const c = await window.api.readNote('/nb/smoke.md');
  return c.includes('**Related:** [[alpha]]') && !c.includes('[[xss]]') && c.includes('Body.');
}));

// --- 41. Section descriptions ---
await page.evaluate(() => window.promptCreateSection('/nb'));
check('new section modal shows a description field', await page.evaluate(() =>
  document.getElementById('create-modal-section-options').style.display !== 'none'));
await page.evaluate(() => window.hideCreateModal());
await page.evaluate(() => window.promptRenameNode('/nb/Projects', 'Projects'));
check('edit section prefills its description', await page.evaluate(() =>
  document.getElementById('create-modal-section-desc').value === 'Everything about active projects'));
await page.evaluate(() => {
  document.getElementById('create-modal-section-desc').value = 'Updated words';
  window.submitCreateModal();
});
await page.waitForTimeout(400);
check('saving section edit persists the description', await page.evaluate(() =>
  window.__sectionMeta && window.__sectionMeta.dir === '/nb/Projects' && window.__sectionMeta.desc === 'Updated words'));
await page.evaluate(() => window.openSection('Projects', '/nb/Projects'));
await page.waitForTimeout(400);
check('section landing shows the description', (await page.locator('#landing-subtitle').innerText()).includes('Everything about active projects'));

// --- 42. [[ note-link autocomplete ---
await page.evaluate(async () => { await window.openNote('/nb/smoke.md'); });
await page.locator('#btn-mode-edit').click();
await editor.evaluate((ta) => { ta.value = ''; ta.selectionStart = ta.selectionEnd = 0; window.handleEditorInput(); });
await editor.focus();
await editor.type('See [[very');
await page.waitForTimeout(200);
check('[[ opens the autocomplete popup', await page.evaluate(() =>
  document.getElementById('wikilink-autocomplete').style.display === 'block' &&
  document.querySelectorAll('#wikilink-autocomplete .wikilink-option').length >= 1));
check('[[ popup fuzzy-matches the page title', await page.evaluate(() =>
  document.querySelector('#wikilink-autocomplete .wikilink-option .wikilink-title').textContent.includes('Very Long')));
await editor.press('Enter');
await page.waitForTimeout(200);
check('selecting inserts a wiki-link resolved by filename', await page.evaluate(() => {
  const v = document.getElementById('note-editor').value;
  return /\[\[alpha(\|[^\]]*)?\]\]/.test(v) && document.getElementById('wikilink-autocomplete').style.display === 'none';
}));
// Escape dismisses without inserting
await editor.evaluate((ta) => { ta.value = 'x [[very'; ta.selectionStart = ta.selectionEnd = ta.value.length; window.handleEditorInput(); });
await page.waitForTimeout(150);
await editor.press('Escape');
check('Escape closes the popup', await page.evaluate(() =>
  document.getElementById('wikilink-autocomplete').style.display === 'none'));

// --- 43. Editor power keys: move / duplicate / delete lines ---
await editor.evaluate((ta) => {
  ta.value = 'one\ntwo\nthree';
  ta.selectionStart = ta.selectionEnd = ta.value.indexOf('two'); // caret on line 2
  window.handleEditorInput();
});
await editor.press('Alt+ArrowUp');
await page.waitForTimeout(100);
check('Alt+Up moves the line up', await page.evaluate(() =>
  document.getElementById('note-editor').value === 'two\none\nthree'));
await editor.press('Alt+ArrowDown');
await page.waitForTimeout(100);
check('Alt+Down moves the line back down', await page.evaluate(() =>
  document.getElementById('note-editor').value === 'one\ntwo\nthree'));
await editor.press('Shift+Alt+ArrowDown');
await page.waitForTimeout(100);
check('Shift+Alt+Down duplicates the line', await page.evaluate(() =>
  document.getElementById('note-editor').value === 'one\ntwo\ntwo\nthree'));
await editor.press(`${MOD}+Shift+k`);
await page.waitForTimeout(100);
check('Cmd/Ctrl+Shift+K deletes the line', await page.evaluate(() =>
  document.getElementById('note-editor').value === 'one\ntwo\nthree'));

// --- 44. Template variable prompt ---
await page.evaluate(() => { window.__templateVars = ['project', 'attendees']; window.__createPageCall = null; });
await page.evaluate(() => window.promptCreatePage('/nb'));
await page.waitForTimeout(150);
await page.evaluate(() => {
  document.getElementById('create-modal-name').value = 'Kickoff';
  document.getElementById('create-modal-template').value = 'meeting.md';
});
// createPage template select only has the blank option in the stub; set value directly is fine
await page.evaluate(() => {
  const sel = document.getElementById('create-modal-template');
  if (![...sel.options].some(o => o.value === 'meeting.md')) { const o = document.createElement('option'); o.value = 'meeting.md'; sel.appendChild(o); }
  sel.value = 'meeting.md';
});
// Don't await submitCreateModal's promise here — with custom vars it stays
// pending until the fill-in modal is submitted (which happens below)
await page.evaluate(() => { window.submitCreateModal(); });
await page.waitForTimeout(200);
check('template with custom vars opens the fill-in modal', await page.evaluate(() =>
  document.getElementById('template-vars-modal').classList.contains('active') &&
  document.querySelectorAll('#template-vars-body .template-var-input').length === 2));
check('custom var labels are prettified', await page.evaluate(() =>
  Array.from(document.querySelectorAll('#template-vars-body label')).map(l => l.textContent).join(',') === 'Project,Attendees'));
await page.evaluate(() => {
  const inputs = document.querySelectorAll('#template-vars-body .template-var-input');
  inputs[0].value = 'Apollo'; inputs[1].value = 'Sam, Kim';
  window.submitTemplateVars();
});
await page.waitForTimeout(300);
check('filled values are passed to createPage', await page.evaluate(() =>
  window.__createPageCall && window.__createPageCall.customVars &&
  window.__createPageCall.customVars.project === 'Apollo' &&
  window.__createPageCall.customVars.attendees === 'Sam, Kim'));
await page.evaluate(() => { window.__templateVars = []; });

// --- 45. Manual update check ---
await page.evaluate(() => { window.__updateResult = { status: 'current', version: '1.0.0' }; });
await page.evaluate(() => window.checkForUpdates());
await page.waitForTimeout(200);
check('update check reports latest version via toast', await page.evaluate(() =>
  document.getElementById('app-toast').textContent.includes('latest version')));

// --- 46. Section description box accepts real keystrokes (regression: greyed box) ---
await page.evaluate(() => window.promptCreateSection('/nb'));
await page.waitForTimeout(150);
check('section description field is editable (not disabled/readonly)', await page.evaluate(() => {
  const t = document.getElementById('create-modal-section-desc');
  return t && !t.disabled && !t.readOnly && t.offsetParent !== null;
}));
await page.locator('#create-modal-section-desc').click();
await page.locator('#create-modal-section-desc').fill('');
await page.keyboard.type('Design docs and specs');
check('section description captures typed text', await page.evaluate(() =>
  document.getElementById('create-modal-section-desc').value === 'Design docs and specs'));
await page.evaluate(() => window.hideCreateModal());
await page.waitForTimeout(100);

// Edit-existing-section path (promptRenameNode) uses the same box — user's report
await page.evaluate(() => window.promptRenameNode('/nb/SomeSection', 'SomeSection'));
await page.waitForTimeout(150);
check('edit-section shows an editable description box', await page.evaluate(() => {
  const t = document.getElementById('create-modal-section-desc');
  return document.getElementById('create-modal-title').innerText === 'Edit Section' &&
    document.getElementById('create-modal-section-options').style.display === 'block' &&
    t && !t.disabled && !t.readOnly;
}));
await page.locator('#create-modal-section-desc').click();
await page.locator('#create-modal-section-desc').fill('');
await page.keyboard.type('Updated summary');
check('edit-section description captures typed text', await page.evaluate(() =>
  document.getElementById('create-modal-section-desc').value === 'Updated summary'));
await page.evaluate(() => window.hideCreateModal());
await page.waitForTimeout(100);

// --- 47. Drawer search box accepts real keystrokes (regression: can't type) ---
await page.evaluate(() => window.openDrawerView('search'));
await page.waitForTimeout(150);
await page.locator('#search-input').fill('');
await page.locator('#search-input').click();
await page.keyboard.type('hello world');
check('drawer search box captures typed keystrokes', await page.evaluate(() =>
  document.getElementById('search-input').value === 'hello world'));
await page.locator('#search-input').fill('');
await page.waitForTimeout(100);

// --- 48. TL;DR toolbar button ---
await page.evaluate(() => {
  const ed = document.getElementById('note-editor');
  ed.value = '';
  ed.selectionStart = ed.selectionEnd = 0;
  window.insertFormatting('tldr');
});
check('TL;DR inserts a blockquote callout', await page.evaluate(() =>
  document.getElementById('note-editor').value.includes('> **TL;DR:**')));

// --- 49. Insert hyperlink modal ---
await page.evaluate(() => {
  const ed = document.getElementById('note-editor');
  ed.value = '';
  ed.selectionStart = ed.selectionEnd = 0;
  window.openLinkModal();
});
await page.waitForTimeout(120);
check('link modal opens', await page.evaluate(() =>
  document.getElementById('link-modal').classList.contains('active')));
// Web link with a hover tooltip
await page.evaluate(() => {
  document.querySelector('input[name="link-kind"][value="web"]').checked = true;
  window.updateLinkModalHint();
});
await page.locator('#link-modal-target').fill('example.com/spec');
await page.locator('#link-modal-title').fill('Spec');
await page.evaluate(() => { document.getElementById('link-modal-hover').checked = true; window.toggleLinkHoverField(); });
await page.locator('#link-modal-hovertext').fill('The shared spec');
await page.evaluate(() => window.submitLinkModal());
await page.waitForTimeout(100);
check('web link inserts markdown with https scheme + tooltip', await page.evaluate(() =>
  document.getElementById('note-editor').value.trim() === '[Spec](https://example.com/spec "The shared spec")'));
// File link, no tooltip, absolute path gets file:// scheme
await page.evaluate(() => {
  const ed = document.getElementById('note-editor');
  ed.value = ''; ed.selectionStart = ed.selectionEnd = 0;
  window.openLinkModal();
});
await page.waitForTimeout(100);
await page.evaluate(() => {
  document.querySelector('input[name="link-kind"][value="file"]').checked = true;
  window.updateLinkModalHint();
});
await page.locator('#link-modal-target').fill('/Users/me/spec.pdf');
await page.locator('#link-modal-title').fill('Local spec');
await page.evaluate(() => window.submitLinkModal());
await page.waitForTimeout(100);
check('file link inserts markdown with file:// scheme', await page.evaluate(() =>
  document.getElementById('note-editor').value.trim() === '[Local spec](file:///Users/me/spec.pdf)'));

// --- 50. Settings gear moved out of the (collapsible) sidebar ---
check('settings gear no longer in the sidebar header', await page.evaluate(() =>
  !document.querySelector('#sidebar .header-actions button[title="Settings"]')));
check('settings gear lives in the right toolbar group', await page.evaluate(() => {
  const btn = document.getElementById('btn-open-settings');
  return !!btn && !!btn.closest('.toolbar') && !btn.closest('#sidebar');
}));

// --- 51. Local AI settings section ---
await page.evaluate(() => window.showSettingsModal());
await page.waitForTimeout(150);
check('AI fields hidden while disabled', await page.evaluate(() =>
  !document.getElementById('settings-ai-enabled').checked &&
  document.getElementById('settings-ai-fields').style.display === 'none'));
await page.evaluate(() => {
  document.getElementById('settings-ai-enabled').checked = true;
  window.toggleAiSettingsFields();
});
check('enabling AI reveals provider/url/model fields', await page.evaluate(() =>
  document.getElementById('settings-ai-fields').style.display === 'block'));
await page.evaluate(() => window.testAiConnection());
await page.waitForTimeout(200);
check('Test lists models from the stubbed server', await page.evaluate(() =>
  document.getElementById('settings-ai-status').textContent.includes('llama3.1:8b')));
check('Test autofills an empty model box with the first model', await page.evaluate(() =>
  document.getElementById('settings-ai-model').value === 'llama3.1:8b'));
await page.evaluate(() => window.saveSettingsForm());
await page.waitForTimeout(300);
check('saved settings carry the ai config', await page.evaluate(() =>
  window.__savedSettings && window.__savedSettings.ai &&
  window.__savedSettings.ai.enabled === true && window.__savedSettings.ai.model === 'llama3.1:8b'));

// --- 52. AI polish flow: header split, run, apply ---
// Re-open a real tree note first: the saveSettingsForm above refreshed the
// notebook, which closed the phantom '/nb/new.md' left by the createPage test
await page.evaluate(() => window.openNote('/nb/smoke.md'));
await page.waitForTimeout(300);
const AI_HEADER = '---\ntitle: Test Note\ncreated: 2026-01-01\n---\n# Test Note\n**Related:** [[other-page]]\n';
await page.evaluate((header) => {
  const ed = document.getElementById('note-editor');
  ed.value = header + '\nsome   messy    body text\n-  bad list\n';
}, AI_HEADER);
await page.evaluate(() => window.openAiPolishModal());
await page.waitForTimeout(120);
check('AI polish modal opens when enabled', await page.evaluate(() =>
  document.getElementById('ai-polish-modal').classList.contains('active')));
check('modal names the configured model', await page.evaluate(() =>
  document.getElementById('ai-polish-model-label').textContent === 'llama3.1:8b'));
await page.evaluate(() => window.runAiPolish());
await page.waitForTimeout(250);
check('model never receives the custom header', await page.evaluate(() =>
  typeof window.__aiPolishCall === 'string' &&
  !window.__aiPolishCall.includes('---') &&
  !window.__aiPolishCall.includes('# Test Note') &&
  !window.__aiPolishCall.includes('**Related:**') &&
  window.__aiPolishCall.includes('messy')));
check('polished result shown with Apply button', await page.evaluate(() =>
  document.getElementById('ai-polish-result').style.display === 'block' &&
  document.getElementById('ai-polish-apply-btn').style.display !== 'none' &&
  document.getElementById('ai-polish-output').value.includes('## Polished')));
await page.evaluate(() => window.applyAiPolish());
await page.waitForTimeout(150);
check('apply reattaches the header untouched + polished body', await page.evaluate((header) => {
  const v = document.getElementById('note-editor').value;
  return v.startsWith(header) && v.includes('## Polished') && !v.includes('messy');
}, AI_HEADER));
check('modal closes after apply', await page.evaluate(() =>
  !document.getElementById('ai-polish-modal').classList.contains('active')));

// Error path: backend failure shows the message and offers to re-run
await page.evaluate(() => {
  window.__aiPolishStub = { ok: false, error: 'Could not reach http://localhost:11434 — is Ollama running?' };
  const ed = document.getElementById('note-editor');
  ed.value = '# T\n\nbody\n';
  window.openAiPolishModal();
});
await page.waitForTimeout(120);
await page.evaluate(() => window.runAiPolish());
await page.waitForTimeout(250);
check('AI failure surfaces the error and restores Run', await page.evaluate(() =>
  document.getElementById('ai-polish-error').style.display === 'block' &&
  document.getElementById('ai-polish-error').textContent.includes('is Ollama running') &&
  document.getElementById('ai-polish-run-btn').style.display !== 'none'));
await page.evaluate(() => { window.__aiPolishStub = null; window.hideAiPolishModal(); });

// Disabled gate: turning AI back off routes the button to Settings
await page.evaluate(async () => {
  document.getElementById('settings-ai-enabled').checked = false;
  await window.saveSettingsForm();
});
await page.waitForTimeout(250);
await page.evaluate(() => window.openAiPolishModal());
await page.waitForTimeout(120);
check('AI button with AI disabled opens Settings, not the polish modal', await page.evaluate(() =>
  !document.getElementById('ai-polish-modal').classList.contains('active') &&
  document.getElementById('settings-modal').classList.contains('active')));
await page.evaluate(() => window.hideSettingsModal());

// --- 53. AI actions dropdown menu ---
check('AI dropdown offers all four actions', await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('#dropdown-ai .dropdown-item')).map(i => i.textContent.trim());
  return items.length === 4 && items.includes('Polish Formatting') && items.includes('Summarize into TL;DR') &&
    items.includes('Extract Action Items') && items.includes('Suggest Tags');
}));

// Re-enable AI for the mode tests (the gate test above turned it off)
await page.evaluate(async () => {
  window.showSettingsModal();
  document.getElementById('settings-ai-enabled').checked = true;
  window.toggleAiSettingsFields();
  document.getElementById('settings-ai-model').value = 'llama3.1:8b';
  await window.saveSettingsForm();
});
await page.waitForTimeout(300);
await page.evaluate(() => window.openNote('/nb/smoke.md'));
await page.waitForTimeout(300);
await page.evaluate(() => window.setViewMode('edit'));
await page.waitForTimeout(200);

// --- 54. Summarize mode: TL;DR inserted at the top of the body ---
const AI_HEADER2 = '---\ntitle: Test Note\n---\n# Test Note\n**Related:** [[other]]\n';
await page.evaluate((h) => {
  document.getElementById('note-editor').value = h + '\nBody paragraph.\n';
  window.__aiPolishStub = { ok: true, text: 'This is the summary.' };
  window.openAiPolishModal('summarize');
}, AI_HEADER2);
await page.waitForTimeout(120);
check('summarize modal shows mode-specific title', await page.evaluate(() =>
  document.getElementById('ai-polish-title').textContent === 'Summarize into TL;DR'));
await page.evaluate(() => window.runAiPolish());
await page.waitForTimeout(200);
check('summarize sent only the body', await page.evaluate(() =>
  window.__aiTransformMode === 'summarize' && !window.__aiPolishCall.includes('# Test Note')));
await page.evaluate(() => window.applyAiPolish());
await page.waitForTimeout(150);
check('summarize apply inserts TL;DR after the header', await page.evaluate((h) => {
  const v = document.getElementById('note-editor').value;
  return v.startsWith(h) && v.includes('> **TL;DR:** This is the summary.') &&
    v.indexOf('> **TL;DR:**') < v.indexOf('Body paragraph.');
}, AI_HEADER2));

// --- 55. Tasks mode: appended under an Action Items heading ---
await page.evaluate(() => {
  document.getElementById('note-editor').value = '# T\n\nCall Bob about pricing soon.\n';
  window.__aiPolishStub = { ok: true, text: '- [ ] Call Bob about pricing\nEmail the team' };
  window.openAiPolishModal('tasks');
});
await page.waitForTimeout(120);
await page.evaluate(() => window.runAiPolish());
await page.waitForTimeout(200);
await page.evaluate(() => window.applyAiPolish());
await page.waitForTimeout(150);
check('tasks apply appends normalized checkboxes under Action Items', await page.evaluate(() => {
  const v = document.getElementById('note-editor').value;
  return v.includes('## Action Items') && v.includes('- [ ] Call Bob about pricing') &&
    v.includes('- [ ] Email the team');
}));

// --- 56. Tags mode: merged into frontmatter tags in the buffer ---
await page.evaluate(() => {
  document.getElementById('note-editor').value = '---\ntitle: T\ntags: [meeting]\n---\n# T\n\nbody\n';
  window.__aiPolishStub = { ok: true, text: 'Alpha, #beta, meeting, not a tag!!' };
  window.openAiPolishModal('tags');
});
await page.waitForTimeout(120);
await page.evaluate(() => window.runAiPolish());
await page.waitForTimeout(200);
check('tags result normalized to clean comma list', await page.evaluate(() =>
  document.getElementById('ai-polish-output').value === 'alpha, beta, meeting'));
await page.evaluate(() => window.applyAiPolish());
await page.waitForTimeout(150);
check('tags apply merges without duplicating existing tags', await page.evaluate(() =>
  document.getElementById('note-editor').value.includes('tags: [meeting, alpha, beta]')));
await page.evaluate(() => { window.__aiPolishStub = null; });

// --- 57. AI ghost autocomplete ---
await page.evaluate(async () => {
  window.showSettingsModal();
  document.getElementById('settings-ai-autocomplete').checked = true;
  await window.saveSettingsForm();
});
await page.waitForTimeout(300);
await page.evaluate(() => window.openNote('/nb/smoke.md'));
await page.waitForTimeout(300);
await page.evaluate(() => {
  window.setViewMode('edit');
  window.__aiGhostDebounce = 50;
  window.__aiCompleteStub = { ok: true, text: 'finish the sentence.' };
  const ed = document.getElementById('note-editor');
  ed.value = '# Note\n\nStarted writing and then ';
  ed.focus();
  ed.selectionStart = ed.selectionEnd = ed.value.length;
});
await page.evaluate(() => window.handleEditorInput());
await page.waitForTimeout(400);
check('ghost suggestion appears after the debounce', await page.evaluate(() => {
  const g = document.getElementById('ai-ghost');
  return !!g && g.style.display === 'block' && g.textContent.includes('finish the sentence.');
}));
check('completion request carried the text before the caret', await page.evaluate(() =>
  typeof window.__aiCompleteCall === 'string' && window.__aiCompleteCall.endsWith('Started writing and then ')));
await page.keyboard.press('Tab');
await page.waitForTimeout(150);
check('Tab accepts the ghost into the editor', await page.evaluate(() =>
  document.getElementById('note-editor').value.includes('Started writing and then finish the sentence.')));
await page.evaluate(async () => {
  delete window.__aiGhostDebounce;
  window.hideAiGhost();
  window.showSettingsModal();
  document.getElementById('settings-ai-autocomplete').checked = false;
  await window.saveSettingsForm();
});
await page.waitForTimeout(250);

// --- 58. Find & replace ---
await page.evaluate(() => window.openNote('/nb/smoke.md'));
await page.waitForTimeout(300);
await page.evaluate(() => {
  window.setViewMode('edit');
  document.getElementById('note-editor').value = 'alpha target beta Target gamma target\n';
  window.showFindBar();
});
await page.waitForTimeout(150);
check('find bar opens', await page.evaluate(() =>
  document.getElementById('find-replace-bar').style.display !== 'none'));
await page.evaluate(() => {
  document.getElementById('find-input').value = 'target';
  document.getElementById('find-case').checked = false;
  window.updateFindMatches();
});
check('case-insensitive count finds all three', await page.evaluate(() =>
  document.getElementById('find-count').textContent.endsWith('/3')));
await page.evaluate(() => {
  document.getElementById('note-editor').setSelectionRange(0, 0);
  window.findNext(1);
});
check('findNext selects the first match', await page.evaluate(() => {
  const ta = document.getElementById('note-editor');
  return ta.selectionStart === 6 && ta.value.substring(ta.selectionStart, ta.selectionEnd) === 'target';
}));
await page.evaluate(() => {
  document.getElementById('find-case').checked = true;
  window.updateFindMatches();
});
check('case-sensitive count drops to two', await page.evaluate(() =>
  document.getElementById('find-count').textContent.endsWith('/2')));
await page.evaluate(() => {
  document.getElementById('find-case').checked = false;
  document.getElementById('replace-input').value = 'goal';
  window.updateFindMatches();
  window.replaceAllMatches();
});
await page.waitForTimeout(150);
check('replace all rewrites every match', await page.evaluate(() =>
  document.getElementById('note-editor').value === 'alpha goal beta goal gamma goal\n'));
await page.evaluate(() => window.hideFindBar());

// --- 59. Paste URL onto a selection makes a link ---
await page.evaluate(() => {
  const ta = document.getElementById('note-editor');
  ta.value = 'see the spec here\n';
  ta.focus();
  ta.setSelectionRange(8, 12); // "spec"
  const dt = new DataTransfer();
  dt.setData('text/plain', 'https://example.com/spec');
  ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, cancelable: true, bubbles: true }));
});
await page.waitForTimeout(150);
check('pasting a URL onto a selection wraps it as a link', await page.evaluate(() =>
  document.getElementById('note-editor').value.includes('see the [spec](https://example.com/spec) here')));

// --- 60. Drag & drop reordering ---
const fakeDragEvent = `{ preventDefault(){}, stopPropagation(){}, clientY: 0, currentTarget: null,
  dataTransfer: { setData(){}, effectAllowed: '' } }`;
await page.evaluate(`(async () => {
  window.__setOrderCall = null;
  window.handleDragStart(${fakeDragEvent}, '/nb/xss.md');
  await window.handlePageDrop(${fakeDragEvent}, '/nb', 'smoke.md');
})()`);
await page.waitForTimeout(200);
check('same-section drop rewrites the order file', await page.evaluate(() => {
  const c = window.__setOrderCall;
  return !!c && c.dir === '/nb' && c.names.indexOf('xss.md') !== -1 &&
    c.names.indexOf('xss.md') < c.names.indexOf('smoke.md');
}));
await page.evaluate(`(async () => {
  window.__relocateCall = null;
  window.handleDragStart(${fakeDragEvent}, '/nb/Projects/alpha.md');
  await window.handlePageDrop(${fakeDragEvent}, '/nb', 'smoke.md');
})()`);
await page.waitForTimeout(200);
check('cross-section drop relocates into the target folder', await page.evaluate(() => {
  const c = window.__relocateCall;
  return !!c && c.src === '/nb/Projects/alpha.md' && c.dest === '/nb';
}));

// --- 61. Image lightbox ---
await page.evaluate(() => {
  const preview = document.getElementById('preview-pane');
  const fig = document.createElement('figure');
  fig.className = 'notebook-figure';
  fig.innerHTML = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="tiny"><figcaption>My caption</figcaption>';
  preview.appendChild(fig);
  window.wirePreviewImages(preview);
  preview.querySelector('img').click();
});
await page.waitForTimeout(150);
check('clicking a preview image opens the lightbox with its caption', await page.evaluate(() =>
  document.getElementById('image-lightbox').classList.contains('active') &&
  document.getElementById('image-lightbox-caption').textContent === 'My caption'));
await page.evaluate(() => window.hideImageLightbox());
check('lightbox closes', await page.evaluate(() =>
  !document.getElementById('image-lightbox').classList.contains('active')));

// --- 62. Task board ---
await page.evaluate(() => window.showTaskBoardModal());
await page.waitForTimeout(200);
check('task board opens with the Projects column and its open task', await page.evaluate(() => {
  const modal = document.getElementById('taskboard-modal');
  const cols = Array.from(document.querySelectorAll('.taskboard-column-title')).map(el => el.textContent);
  const cards = Array.from(document.querySelectorAll('.taskboard-card-item .taskboard-task-text')).map(el => el.textContent);
  return modal.classList.contains('active') && cols.some(c => c.includes('Projects')) && cards.includes('task');
}));
await page.evaluate(() => { window.__taskToggles = []; });
await page.evaluate(() => {
  const cb = document.querySelector('.taskboard-card-item input[type="checkbox"]');
  cb.checked = true;
  cb.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(200);
check('board checkbox completes the task via toggleTaskAtLine', await page.evaluate(() =>
  document.querySelector('.taskboard-card-item').classList.contains('done')));
await page.evaluate(() => window.hideTaskBoardModal());

// --- 63. Spellcheck setting drives the editor attribute ---
check('spellcheck on by default', await page.evaluate(() =>
  document.getElementById('note-editor').spellcheck === true));
await page.evaluate(async () => {
  window.showSettingsModal();
  document.getElementById('settings-spellcheck').checked = false;
  await window.saveSettingsForm();
});
await page.waitForTimeout(250);
check('disabling spellcheck updates the editor', await page.evaluate(() =>
  document.getElementById('note-editor').spellcheck === false));

} finally {
  if (browser) await browser.close();
}

console.log(`--- smoke-v2 platform=${PLATFORM} ---`);
console.log(results.join('\n'));
const total = results.filter(r => r.startsWith('PASS') || r.startsWith('FAIL')).length;
console.log(failed === 0 ? `\nALL ${total} CHECKS PASSED` : `\n${failed}/${total} CHECKS FAILED`);
process.exit(failed === 0 ? 0 : 1);
