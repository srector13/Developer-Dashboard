// UI audit harness: loads renderer/index.html in plain Chromium with a stubbed
// window.api, cycles all 6 themes + modals + toast + palette + tooltips, saves
// screenshots into ui-audit/ and dumps computed-style contrast data.
// Re-runnable: node ui-audit.mjs
import { createRequire } from 'module';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('@playwright/test');

const OUT = process.env.UI_AUDIT_OUT || path.join(ROOT, 'tests', 'renderer', 'ui-audit-output');
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Seed note: every styled markdown element visible at once.
// ---------------------------------------------------------------------------
const NOTE_MD = `---
title: Smoke Note
created: 2026-07-10
tags: [test, ui]
---

# Smoke Note

Intro paragraph with **bold text**, *italics*, \`inline code\`, a ==highlighted phrase== and a [web link](https://example.com).

## Second Level Heading

Some body prose under the h2 so line-height and color are visible.

### Third Level Heading

- first bullet
- second bullet
  - nested bullet

- [ ] open task item
- [x] completed task item

\`\`\`js
function greet(name) {
  const msg = \`Hello, \${name}!\`; // template literal
  if (!name) return null;
  return msg.toUpperCase();
}
greet('world');
\`\`\`

> A blockquote with wise words and \`code inside a quote\`.

| Column A | Column B | Column C |
| -------- | -------- | -------- |
| alpha    | 1        | true     |
| beta     | 2        | false    |

\`\`\`mermaid
flowchart LR
    A[Receive request] --> B{Valid input?}
    B -->|Yes| C[Process order]
    B -->|No| D[Reject]
\`\`\`
`;


// ---------------------------------------------------------------------------
// Browser setup
// ---------------------------------------------------------------------------
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.addInitScript(({ noteMd }) => {
  const tree = {
    kind: 'section', name: 'Root', fsPath: '/nb', relPath: '',
    pages: [{ kind: 'page', name: 'smoke.md', fsPath: '/nb/smoke.md', relPath: 'smoke.md', title: 'Smoke Note', created: '2026-07-10', tags: ['test', 'ui'], pinned: false, openTasks: 1, completedTasks: 1, taskLines: [] }],
    sections: [{
      kind: 'section', name: 'Projects', fsPath: '/nb/Projects', relPath: 'Projects',
      pages: [{ kind: 'page', name: 'alpha.md', fsPath: '/nb/Projects/alpha.md', relPath: 'Projects/alpha.md', title: 'A Very Long Page Title That Should Truncate Nicely', created: '2026-07-02', tags: ['project'], pinned: true, openTasks: 1, completedTasks: 1, taskLines: [] }],
      sections: []
    }],
  };
  const files = { '/nb/smoke.md': noteMd };
  let settings = {
    notebookRoot: '/nb', defaultPageWidth: 'standard', defaultMermaidZoom: 100,
    theme: 'light', ignoreFolders: ['templates'], templatesFolder: 'templates',
    author: '', pandocPath: '', scratchpadFile: 'scratchpad.md', autoSaveEnabled: false,
    pdfExport: { theme: 'light', pageSize: 'A4', openAfter: true, reveal: false },
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
    platform: 'darwin',
    getSettings: async () => settings,
    saveSettings: async (s) => { settings = Object.assign({}, settings, s); return settings; },
    getNotebookTree: async () => JSON.parse(JSON.stringify(tree)),
    readNote: async (p) => files[p] || '',
    writeNote: async (p, c) => { files[p] = c; return true; },
    listTemplates: async () => ([
      { name: 'meeting-notes.md', fsPath: '/nb/templates/meeting-notes.md', title: 'Meeting Notes' },
      { name: 'daily-log.md', fsPath: '/nb/templates/daily-log.md', title: 'Daily Log' },
    ]),
    createTemplate: async () => '/nb/templates/new.md',
    updateNoteMeta: async () => true,
    getBacklinks: async () => [],
    onFilesChanged: () => () => {},
    toggleTaskAtLine: async () => true,
    toggleMermaidOrientation: () => {},
    openExternal: async () => true,
    resolveRelativePath: (b, r) => r,
    // Render through the app's own pipeline (renderer/markdown.js, loaded by
    // index.html) rather than a copy of it — the audit should be looking at
    // what actually ships.
    renderMarkdown: (text, opts) => window.NotebookMarkdown.render(text, opts),
    createPage: async () => '/nb/new.md', createSection: async () => '/nb/s',
    deleteNode: async () => true, renameNode: async () => true,
    relocateNode: async () => true, moveNode: async () => true,
    readScratchpad: async () => '', appendScratchpad: async () => true,
    importClipboard: async () => ({ success: false }), importDocument: async () => null,
    exportToPdf: async () => ({ success: true, pdfPath: '/tmp/x.pdf' }),
    selectFolder: async () => '/nb',
  };
}, { noteMd: NOTE_MD });

await page.goto('file://' + path.join(ROOT, 'renderer', 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
await page.locator('#notebook-tree .tree-node-label', { hasText: 'Smoke Note' }).click();
await page.waitForTimeout(1000);

const shot = (name, opts = {}) => page.screenshot({ path: `${OUT}/${name}.png`, ...opts });
const applyTheme = async (t) => {
  await page.evaluate((th) => window.applyTheme(th), t);
  await page.waitForTimeout(850); // mermaid re-render
};

// ---------------------------------------------------------------------------
// Contrast probing helpers (runs inside the page)
// ---------------------------------------------------------------------------
const PROBE_FN = `(() => {
  function parse(c) {
    const m = String(c).match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/);
    if (!m) return null;
    return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  }
  function effBg(el) {
    // collect backgrounds from element up to <html>, then composite top-down
    const stack = [];
    let e = el;
    while (e) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) stack.push(c); e = e.parentElement; }
    let out = [255, 255, 255]; // fallback base
    const bodyIsDark = document.body.classList.contains('dark-theme');
    if (bodyIsDark) out = [13, 17, 23];
    for (let i = stack.length - 1; i >= 0; i--) {
      const [r, g, b, a] = stack[i];
      out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
    }
    return out;
  }
  function lum([r, g, b]) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function ratio(fg, bg) {
    const l1 = lum(fg), l2 = lum(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  return function probe(pairs) {
    return pairs.map(([label, sel]) => {
      const el = document.querySelector(sel);
      if (!el) return { label, sel, missing: true };
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      const bg = effBg(el);
      return {
        label, sel,
        color: cs.color,
        bg: 'rgb(' + bg.map(Math.round).join(',') + ')',
        ratio: fg ? +ratio(fg.slice(0, 3), bg).toFixed(2) : null,
        fontSize: cs.fontSize, fontFamily: cs.fontFamily.split(',')[0],
        radius: cs.borderRadius, padding: cs.padding,
      };
    });
  };
})()`;

async function probeContrast(pairs) {
  return page.evaluate(({ fnSrc, pairs }) => eval(fnSrc)(pairs), { fnSrc: PROBE_FN, pairs });
}

const THEMES = ['light', 'dark', 'midnight', 'forest', 'sepia', 'system'];
const contrastReport = {};

// ---------------------------------------------------------------------------
// 1. All six themes: preview + edit + probes
// ---------------------------------------------------------------------------
for (const t of THEMES) {
  await applyTheme(t);
  // ensure preview mode
  await page.evaluate(() => window.setViewMode('preview'));
  await page.waitForTimeout(900);
  await shot(`${t}-preview`);

  // hljs stylesheet state
  const hljsState = await page.evaluate(() => ({
    dataTheme: document.body.dataset.theme,
    bodyClass: document.body.className,
    hljsDarkDisabled: document.getElementById('hljs-dark').disabled,
    hljsLightDisabled: document.getElementById('hljs-light').disabled,
  }));

  const probes = await probeContrast([
    ['note-title', '#note-title'],
    ['body-paragraph', '#preview-pane > p'],
    ['h2', '#preview-pane h2'],
    ['h3', '#preview-pane h3'],
    ['table-th', '#preview-pane table th'],
    ['table-td', '#preview-pane table td'],
    ['blockquote', '#preview-pane blockquote p'],
    ['inline-code', '#preview-pane p > code'],
    ['code-block', '#preview-pane pre.hljs code'],
    ['mark-highlight', '#preview-pane mark'],
    ['tree-label', '#notebook-tree .tree-node-label'],
    ['toolbar-tab-btn', '.mode-toggles .tab-btn:not(.active)'],
    ['toolbar-tab-btn-active', '.mode-toggles .tab-btn.active'],
    ['sidebar-footer-btn', '.sidebar-footer .btn'],
    ['note-meta-date', '.note-meta, #note-date-label'],
  ]);
  contrastReport[t] = { hljsState, probes };

  // edit mode
  await page.evaluate(() => window.setViewMode('edit'));
  await page.waitForTimeout(400);
  await shot(`${t}-edit`);
  contrastReport[t].editorProbe = await probeContrast([
    ['editor-textarea', '#editor-pane textarea, #markdown-editor, textarea'],
  ]);
  await page.evaluate(() => window.setViewMode('preview'));
  await page.waitForTimeout(600);
}

// split view, light + dark
for (const t of ['light', 'dark']) {
  await applyTheme(t);
  await page.evaluate(() => window.setViewMode('split'));
  await page.waitForTimeout(900);
  await shot(`${t}-split`);
  await page.evaluate(() => window.setViewMode('preview'));
  await page.waitForTimeout(600);
}

// ---------------------------------------------------------------------------
// 2. Modals in dark AND light
// ---------------------------------------------------------------------------
for (const t of ['dark', 'light']) {
  await applyTheme(t);
  await page.evaluate(() => window.setViewMode('preview'));
  await page.waitForTimeout(700);

  // Settings
  await page.evaluate(() => window.showSettingsModal());
  await page.waitForTimeout(350);
  await shot(`${t}-modal-settings`);
  contrastReport[`${t}-modals`] = contrastReport[`${t}-modals`] || {};
  contrastReport[`${t}-modals`].settings = await probeContrast([
    ['modal-title', '#settings-modal h3, #settings-modal h2'],
    ['modal-label', '#settings-modal label'],
    ['modal-input', '#settings-modal input[type="text"]'],
    ['modal-select', '#settings-modal select'],
    ['modal-hint', '#settings-modal .form-hint, #settings-modal small'],
    ['modal-btn-primary', '#settings-modal .btn-primary'],
    ['modal-btn-secondary', '#settings-modal .btn:not(.btn-primary)'],
  ]);
  await page.evaluate(() => window.hideSettingsModal());

  // PDF export
  await page.evaluate(() => window.exportToPdf());
  await page.waitForTimeout(350);
  await shot(`${t}-modal-pdf-export`);
  contrastReport[`${t}-modals`].pdf = await probeContrast([
    ['pdf-label', '#pdf-export-modal label'],
    ['pdf-select', '#pdf-export-modal select'],
    ['pdf-checkbox-label', '#pdf-export-modal .checkbox-row, #pdf-export-modal label.checkbox'],
  ]);
  await page.evaluate(() => window.hidePdfExportModal());

  // Shortcuts
  await page.evaluate(() => window.showShortcutsModal());
  await page.waitForTimeout(350);
  await shot(`${t}-modal-shortcuts`);
  contrastReport[`${t}-modals`].shortcuts = await probeContrast([
    ['shortcut-desc', '#shortcuts-modal .shortcut-desc'],
    ['shortcut-kbd', '#shortcuts-modal kbd'],
    ['shortcut-h4', '#shortcuts-modal .shortcuts-section h4'],
  ]);
  await page.evaluate(() => window.hideShortcutsModal());

  // Page info
  await page.evaluate(() => window.showPageInfoModal('/nb/smoke.md'));
  await page.waitForTimeout(400);
  await shot(`${t}-modal-page-info`);
  await page.evaluate(() => window.hidePageInfoModal());

  // Templates
  await page.evaluate(() => window.showTemplatesModal());
  await page.waitForTimeout(500);
  await shot(`${t}-modal-templates`);
  await page.evaluate(() => window.hideTemplatesModal());

  // Mermaid builder — flowchart example first
  await page.evaluate(() => window.showMermaidBuilder());
  await page.evaluate(() => window.loadBuilderExample());
  await page.waitForTimeout(900);
  await shot(`${t}-modal-builder-flowchart`);

  // cycle all 7 types; screenshot gantt + journey in both themes, all in dark
  const types = ['sequence', 'pie', 'gantt', 'class', 'state', 'journey'];
  for (const ty of types) {
    await page.evaluate((ty) => {
      document.getElementById('builder-type').value = ty;
      window.switchBuilderType();
      window.loadBuilderExample();
    }, ty);
    await page.waitForTimeout(900);
    if (t === 'dark' || ty === 'gantt' || ty === 'journey') {
      await shot(`${t}-modal-builder-${ty}`);
    }
  }
  // reset builder back to flowchart
  await page.evaluate(() => {
    document.getElementById('builder-type').value = 'flowchart';
    window.switchBuilderType();
    window.hideMermaidBuilder();
  });

  // Toast (success + error)
  await page.evaluate(() => window.showToast('Test message'));
  await page.waitForTimeout(300);
  await shot(`${t}-toast`);
  contrastReport[`${t}-modals`].toast = await probeContrast([['toast', '#app-toast']]);
  await page.evaluate(() => window.showToast('Something went wrong', 'error'));
  await page.waitForTimeout(300);
  await shot(`${t}-toast-error`);
  await page.evaluate(() => { document.getElementById('app-toast').classList.remove('visible', 'error'); });

  // Command palette
  await page.evaluate(() => window.showCommandPalette());
  await page.waitForTimeout(400);
  await shot(`${t}-command-palette`);
  contrastReport[`${t}-modals`].palette = await probeContrast([
    ['palette-input', '#palette-search-input'],
    ['palette-item-label', '#palette-results-list .palette-item, #palette-results-list > div'],
  ]);
  await page.evaluate(() => window.hideCommandPalette());
  await page.waitForTimeout(200);
}

// ---------------------------------------------------------------------------
// 3. Light-theme interaction extras: tree hover, tooltip, dropdown
// ---------------------------------------------------------------------------
for (const t of ['light', 'dark']) {
  await applyTheme(t);
  await page.waitForTimeout(500);

  // Tree hover actions
  await page.locator('#notebook-tree .tree-node').filter({ hasText: 'Smoke Note' }).first().hover();
  await page.waitForTimeout(300);
  await shot(`${t}-tree-hover`, { clip: { x: 0, y: 0, width: 480, height: 900 } });
  contrastReport[`${t}-modals`] = contrastReport[`${t}-modals`] || {};
  contrastReport[`${t}-modals`].treeHoverBtn = await probeContrast([['tree-node-btn', '.tree-node-btn']]);

  // Tooltip on toolbar button (custom tooltip shows on mouseenter)
  await page.locator('#btn-mode-edit').hover();
  await page.waitForTimeout(400);
  await shot(`${t}-tooltip`, { clip: { x: 0, y: 0, width: 900, height: 400 } });
  contrastReport[`${t}-modals`].tooltip = await probeContrast([['custom-tooltip', '#custom-tooltip.visible']]);
  await page.mouse.move(700, 700);

  // Dropdown menu (edit mode toolbar)
  await page.evaluate(() => window.setViewMode('edit'));
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('dropdown-heading').classList.add('active'));
  await page.waitForTimeout(250);
  await shot(`${t}-dropdown-heading`, { clip: { x: 0, y: 0, width: 1000, height: 500 } });
  contrastReport[`${t}-modals`].dropdown = await probeContrast([
    ['dropdown-item', '#dropdown-heading .dropdown-item'],
  ]);
  await page.evaluate(() => {
    document.getElementById('dropdown-heading').classList.remove('active');
    window.setViewMode('preview');
  });
  await page.waitForTimeout(500);
}

fs.writeFileSync(`${OUT}/contrast.json`, JSON.stringify(contrastReport, null, 2));
console.log('DONE. Screenshots + contrast.json in', OUT);
