// OneNote import picker harness: loads renderer/index.html in Chromium with a
// stubbed window.api and exercises the picker end to end — hierarchy render,
// parent/child checkbox cascade, the section path each page is filed under,
// and the "OneNote isn't installed" path.
//
// The section path is the part worth pinning: it decides which folders the
// import creates, and getting it wrong scatters someone's whole notebook.
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('@playwright/test');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  ok ? passed++ : failed++;
}

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => { console.log('PAGEERROR:', e.message); failed++; });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERROR:', m.text()); });
// The import surfaces problems through alert(); record them so a failure says
// what went wrong instead of just leaving the modal open.
const dialogs = [];
page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });

await page.addInitScript(() => {
  // Two sections called "Projects" under different parents — the case that
  // makes a leaf-name-only destination list impossible to choose from.
  const tree = {
    kind: 'section', name: 'Root', fsPath: '/nb', relPath: '', pages: [],
    sections: [
      {
        kind: 'section', name: 'Imported', fsPath: '/nb/Imported', relPath: 'Imported',
        pages: [], sections: [],
      },
      {
        kind: 'section', name: 'Claims', fsPath: '/nb/Claims', relPath: 'Claims', pages: [],
        sections: [{
          kind: 'section', name: 'Projects', fsPath: '/nb/Claims/Projects',
          relPath: 'Claims/Projects', pages: [], sections: [],
        }],
      },
      {
        kind: 'section', name: 'Customer Service', fsPath: '/nb/Customer Service',
        relPath: 'Customer Service', pages: [],
        sections: [{
          kind: 'section', name: 'Projects', fsPath: '/nb/Customer Service/Projects',
          relPath: 'Customer Service/Projects', pages: [], sections: [],
        }],
      },
    ],
  };

  // Mirrors what src-tauri/src/onenote.rs serialises.
  window.__oneNoteBooks = [{
    id: '{N1}', name: 'Work',
    sections: [
      { id: '{S1}', name: 'Meetings', groupPath: [], pages: [
        { id: '{P1}', name: 'Standup', level: 1 },
        { id: '{P2}', name: 'Retro', level: 2 },
      ] },
      { id: '{S2}', name: 'Apollo', groupPath: ['Projects', 'Archive'], pages: [
        { id: '{P3}', name: 'Kickoff', level: 1 },
      ] },
    ],
  }];
  window.__probe = { available: true };
  window.__importCalls = [];

  window.api = {
    platform: 'win32',
    getSettings: async () => ({
      notebookRoot: '/nb', theme: 'dark', defaultPageWidth: 'standard',
      defaultMermaidZoom: 100, ignoreFolders: [], templatesFolder: 'templates',
      attachmentsFolder: 'attachments', author: '', scratchpadFile: 'scratchpad.md',
      autoSaveEnabled: false, spellcheckEnabled: true, keepInTray: true,
      pdfExport: { theme: 'light', pageSize: 'A4', openAfter: true, reveal: false },
      ai: { enabled: false, provider: 'ollama', baseUrl: '', model: '', autocomplete: false },
      quickCaptureShortcut: '', clipboardCaptureShortcut: '', clipboardCaptureTarget: '',
    }),
    saveSettings: async (s) => s,
    getNotebookTree: async () => tree,
    readNote: async () => '# Note\n',
    writeNote: async () => true,
    searchNotes: async () => [],
    getBacklinks: async () => [],
    listTemplates: async () => [],
    listTrash: async () => [],
    listNoteHistory: async () => [],
    renderMarkdown: (t) => `<p>${t}</p>`,
    resolveRelativePath: (a, b) => b,
    onFilesChanged: () => () => {},
    onCaptureShortcutFailed: () => {},
    onOpenNote: () => {},
    onOpenNoteExport: () => {},
    getAppVersion: async () => '1.5.0-beta.4',
    checkForUpdates: async () => ({ status: 'portable' }),
    aiListModels: async () => ({ ok: false }),

    // The surface under test
    oneNoteProbe: async () => window.__probe,
    oneNoteNotebooks: async () => window.__oneNoteBooks,
    oneNoteImport: async (items, destDir) => {
      window.__importCalls.push({ items, destDir });
      return { imported: items.length, failures: [], firstPath: '/nb/Imported/standup.md' };
    },
    onOneNoteImportProgress: () => () => {},
  };
});

await page.goto(`file://${path.join(ROOT, 'renderer', 'index.html')}`);
await page.waitForTimeout(400);

// --- the picker opens and lists the hierarchy -----------------------------

await page.evaluate(() => window.openOneNoteImport());
await page.waitForTimeout(250);

// .modal-overlay toggles opacity, not display, so it is always "visible" to
// Playwright — the `active` class is what actually shows it.
const modalOpen = () => page.evaluate(() =>
  document.getElementById('onenote-modal').classList.contains('active'));

check('modal opens', await modalOpen());
const rowCount = await page.evaluate(() => document.querySelectorAll('.onenote-check').length);
// 1 notebook + 2 sections + 3 pages
check('every notebook, section and page gets a row', rowCount === 6, `got ${rowCount}`);

const labels = await page.evaluate(() =>
  [...document.querySelectorAll('#onenote-tree span')].map(s => s.innerText));
check('section groups are shown in the label',
  labels.some(l => l.includes('Projects / Archive / Apollo')), labels.join(' | '));
check('page counts are shown', labels.some(l => /Meetings\s+\(2\)/.test(l)), labels.join(' | '));

// --- cascade ---------------------------------------------------------------

await page.evaluate(() => {
  const box = document.querySelector('.onenote-check[data-book="0"][data-section="0"]:not([data-page])');
  box.checked = true;
  box.dispatchEvent(new Event('change'));
});
const afterSection = await page.evaluate(() =>
  [...document.querySelectorAll('.onenote-check')].filter(b => b.checked).length);
check('ticking a section ticks its pages only', afterSection === 3, `got ${afterSection}`);

await page.evaluate(() => {
  const box = document.querySelector('.onenote-check[data-book="0"]:not([data-section])');
  box.checked = true;
  box.dispatchEvent(new Event('change'));
});
const afterBook = await page.evaluate(() =>
  [...document.querySelectorAll('.onenote-check')].filter(b => b.checked).length);
check('ticking the notebook ticks everything', afterBook === 6, `got ${afterBook}`);

// --- selection maps to section paths ---------------------------------------

const selection = await page.evaluate(() => window.selectedOneNotePages());
check('only pages are submitted, not the parent rows', selection.length === 3, `got ${selection.length}`);

const kickoff = selection.find(s => s.name === 'Kickoff');
check('a grouped section becomes notebook → groups → section',
  JSON.stringify(kickoff.sectionPath) === JSON.stringify(['Work', 'Projects', 'Archive', 'Apollo']),
  JSON.stringify(kickoff && kickoff.sectionPath));

const standup = selection.find(s => s.name === 'Standup');
check('an ungrouped section becomes notebook → section',
  JSON.stringify(standup.sectionPath) === JSON.stringify(['Work', 'Meetings']),
  JSON.stringify(standup && standup.sectionPath));
check('page ids are carried through', standup.id === '{P1}', standup && standup.id);

// --- destination list names the whole chain, not just the leaf -------------

const destOptions = await page.evaluate(() =>
  Array.from(document.getElementById('onenote-dest').options).map(o => [o.text, o.value]));
check('the root is offered first', destOptions[0][0] === 'Notebook Root',
  JSON.stringify(destOptions[0]));
check('nested sections show their whole chain',
  destOptions.some(([t, v]) => t === 'Claims › Projects' && v === '/nb/Claims/Projects') &&
  destOptions.some(([t, v]) => t === 'Customer Service › Projects' && v === '/nb/Customer Service/Projects'),
  JSON.stringify(destOptions));
check('same-named sections are no longer identical rows',
  new Set(destOptions.map(([t]) => t)).size === destOptions.length,
  JSON.stringify(destOptions.map(([t]) => t)));
check('every row carries its path as a tooltip too', await page.evaluate(() =>
  Array.from(document.getElementById('onenote-dest').options)
    .slice(1)
    .every(o => o.title === o.text)));

// A destination that has since disappeared must not silently become the root
// option's value without the value actually being the root.
check('an unknown destination falls back to the notebook root', await page.evaluate(() => {
  window.fillOneNoteDestinations('/nb/Gone');
  return document.getElementById('onenote-dest').value === '/nb';
}));

// --- import passes the chosen destination ----------------------------------

await page.evaluate(() => { document.getElementById('onenote-dest').value = '/nb/Imported'; });
await page.evaluate(() => window.runOneNoteImport());
await page.waitForTimeout(300);

const call = await page.evaluate(() => window.__importCalls[0]);
check('import is called with the chosen destination', call && call.destDir === '/nb/Imported',
  call && call.destDir);
check('import is called with the selected pages', call && call.items.length === 3,
  call && String(call.items.length));
check('modal closes after a successful import', !(await modalOpen()),
  dialogs.length ? `alert fired: ${dialogs.join(' / ')}` : 'no alert fired');

// --- OneNote missing --------------------------------------------------------

await page.evaluate(() => {
  window.__probe = { available: false, reason: 'OneNote automation is not registered.' };
});
await page.evaluate(() => window.openOneNoteImport());
await page.waitForTimeout(250);

const statusText = await page.evaluate(() => document.getElementById('onenote-status').innerText);
check('an unavailable OneNote is explained', statusText.includes('not registered'), statusText);
const disabled = await page.evaluate(() => document.getElementById('onenote-import-btn').disabled);
check('import is disabled when OneNote is unavailable', disabled === true);
check('the failure is styled as a failure, not as progress', await page.evaluate(() =>
  document.getElementById('onenote-status').classList.contains('is-error')));
check('a failure offers the diagnostic check', await page.evaluate(() =>
  document.getElementById('onenote-diag-actions').style.display === 'block'));

// The report itself: every finding rendered, problems marked, copyable.
await page.evaluate(() => {
  window.api.oneNoteDiagnostics = async () => ([
    { label: 'This app', value: '64-bit', problem: false },
    { label: 'OneNote build', value: '32-bit (x86) — does NOT match this app', problem: true },
  ]);
});
await page.locator('#onenote-diag-actions button').click();
await page.waitForTimeout(300);
check('the check renders every finding', await page.evaluate(() =>
  document.querySelectorAll('#onenote-diag-rows tr').length === 2));
check('a problem finding is marked as one', await page.evaluate(() => {
  const rows = document.querySelectorAll('#onenote-diag-rows tr');
  return !rows[0].classList.contains('is-problem') && rows[1].classList.contains('is-problem');
}));
check('findings are inserted as text, not markup', await page.evaluate(() => {
  const cells = document.querySelectorAll('#onenote-diag-rows td');
  return cells[1].textContent === '64-bit';
}));
check('the report copies as readable text', await page.evaluate(() =>
  window.oneNoteDiagnosticsText() ===
  '    This app: 64-bit\n[!] OneNote build: 32-bit (x86) — does NOT match this app'));

await browser.close();
console.log(`\n${failed ? `${failed} FAILED, ` : ''}${passed} passed`);
process.exit(failed ? 1 : 0);
