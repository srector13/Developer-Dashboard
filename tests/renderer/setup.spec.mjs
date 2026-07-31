// First-run setup harness.
//
// The point of this screen is that a fresh install doesn't open on empty cards,
// so the assertions are about what it offers unprompted and what it writes when
// you accept — plus that it never comes back once dismissed.
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { serve, reporter } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('@playwright/test');

const { check, finish } = reporter();
const server = await serve(path.join(ROOT, 'renderer'));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERROR:', m.text()); });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.addInitScript(() => {
  window.__calls = [];
  window.__saved = null;
  window.__settings = {
    theme: 'dark', launcherShortcut: 'CommandOrControl+Shift+Space', keepInTray: true,
    dashboardColumns: 2, collapsed: [], cardLayout: {},
    setupComplete: false, // a fresh install
  };

  window.hubApi = {
    getSettings: async () => window.__settings,
    saveSettings: async (patch) => {
      window.__calls.push(['saveSettings', JSON.stringify(patch)]);
      window.__settings = Object.assign({}, window.__settings, patch);
      return window.__settings;
    },
    setupSuggestions: async () => ({
      tools: [
        { id: 'intellij', label: 'IntelliJ IDEA', program: 'C:\\JB\\idea64.exe', args: ['{path}'], opensFolders: true },
        { id: 'vscode', label: 'VS Code', program: 'C:\\VSC\\code.cmd', args: ['{path}'], opensFolders: true },
        { id: 'terminal', label: 'Windows Terminal', program: 'C:\\wt.exe', args: ['-d', '{path}'], opensFolders: true },
      ],
      repoRoots: ['C:\\dev'],
      notebookRoot: 'C:\\notes',
    }),
    runAtLogin: async () => false,
    setRunAtLogin: async (enabled) => { window.__calls.push(['setRunAtLogin', String(enabled)]); return enabled; },
    shortcutStatus: async () => ({ accelerator: 'x', registered: true, error: null }),
    shortcutSuggestions: async () => [],
    getConfig: async () => ({ text: '{}', path: 'x', error: null }),
    getConfigJson: async () => ({ launch: [], projects: { roots: [], maxDepth: 3, openWith: [] }, todos: {}, health: { endpoints: [] }, command: [] }),
    saveConfig: async () => {},
    saveConfigJson: async (config) => { window.__saved = config; window.__calls.push(['saveConfigJson']); return config; },
    revealConfigFile: () => {},
    pickFolder: async () => 'C:\\work\\repos',
    pickProgram: async () => null,
    getResults: async () => [],
    getItems: async () => [],
    refreshProvider: async () => ({}),
    refreshAll: async () => [],
    searchItems: async () => [],
    runAction: async () => ({ success: true }),
    openExternal: async () => {},
    showLauncher: () => {},
    onProviderUpdated: () => {}, onConfigChanged: () => {}, onShortcutStatus: () => {},
  };
});

await page.goto(`${server.origin}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(450);

// --- It opens on a fresh install ------------------------------------------

check('setup opens by itself on a fresh install', await page.evaluate(() =>
  document.getElementById('setup-overlay').classList.contains('visible')));

check('folders that look like repo roots are offered, pre-ticked', await page.evaluate(() => {
  const box = document.querySelector('[data-root="C:\\\\dev"]');
  return !!box && box.checked;
}));

check('installed editors are offered, pre-ticked', await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('[data-tool]')];
  return boxes.length === 3 && boxes.every(b => b.checked);
}));

check('the detected program path is shown, not just the name', await page.evaluate(() =>
  document.getElementById('setup-body').textContent.includes('C:\\JB\\idea64.exe')));

check('the notebook found by the sibling app is mentioned', await page.evaluate(() =>
  document.getElementById('setup-body').textContent.includes('C:\\notes')));

// --- Choices reach the config ---------------------------------------------

await page.uncheck('[data-tool="terminal"]');
await page.click('#setup-add-root');
await page.waitForTimeout(200);
check('browsing adds a folder and ticks it', await page.evaluate(() => {
  const box = document.querySelector('[data-root="C:\\\\work\\\\repos"]');
  return !!box && box.checked;
}));

await page.click('#setup-finish');
await page.waitForTimeout(300);

check('both chosen roots are written to the config', await page.evaluate(() =>
  JSON.stringify(window.__saved.projects.roots) === JSON.stringify(['C:\\dev', 'C:\\work\\repos'])));

check('only the ticked tools become repo openers', await page.evaluate(() => {
  const labels = window.__saved.projects.openWith.map(o => o.label);
  return labels.length === 2 && labels.includes('IntelliJ IDEA') && !labels.includes('Windows Terminal');
}));

check('an opener keeps the {path} placeholder', await page.evaluate(() =>
  window.__saved.projects.openWith[0].args.includes('{path}')));

check('the first real editor also becomes the todo opener', await page.evaluate(() =>
  window.__saved.todos.openWith.program === 'C:\\JB\\idea64.exe'));

check('start-with-Windows is applied when left ticked', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'setRunAtLogin' && c[1] === 'true')));

check('setup is marked complete', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'saveSettings' && c[1].includes('setupComplete'))));

check('the screen closes when finished', await page.evaluate(() =>
  !document.getElementById('setup-overlay').classList.contains('visible')));

// --- VS Code gets the line-jumping argument form --------------------------

await page.evaluate(async () => {
  window.__settings.setupComplete = false;
  await window.DevHubSetup.open();
});
await page.waitForTimeout(250);
await page.uncheck('[data-tool="intellij"]');
await page.uncheck('[data-tool="terminal"]');
await page.click('#setup-finish');
await page.waitForTimeout(300);
check('VS Code is given the argument form that jumps to a line', await page.evaluate(() =>
  JSON.stringify(window.__saved.todos.openWith.args) === JSON.stringify(['-g', '{path}:{line}'])));

// --- It does not come back ------------------------------------------------
//
// Driven through maybeOpenSetup rather than a page reload: addInitScript runs
// again on every navigation, so a reload would rebuild the stub with
// setupComplete back to false and the assertion would be testing the harness.

check('setup does not reappear once completed', await page.evaluate(async () => {
  await window.DevHubDashboard.load();
  return window.DevHubDashboard.maybeOpenSetup() === false
    && !document.getElementById('setup-overlay').classList.contains('visible');
}));

// --- Skipping also counts as answered -------------------------------------

await page.evaluate(async () => {
  window.__settings.setupComplete = false;
  window.__calls = [];
  window.__saved = null;
  await window.DevHubDashboard.load();
  window.DevHubDashboard.maybeOpenSetup();
});
await page.waitForTimeout(250);
check('setup returns while it is still unanswered', await page.evaluate(() =>
  document.getElementById('setup-overlay').classList.contains('visible')));

await page.click('#setup-skip');
await page.waitForTimeout(250);
check('skipping writes no config', await page.evaluate(() => window.__saved === null));
check('skipping still marks setup answered, so it stops asking', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'saveSettings' && c[1].includes('setupComplete'))));

await browser.close();
await server.close();
process.exit(finish('setup') === 0 ? 0 : 1);
