// Settings harness: drives the real settings panel against a stubbed hubApi.
//
// The point of this screen is that nobody has to hand-edit hub.config.json, so
// the assertions are about round-tripping — what you type in the form is what
// reaches saveConfigJson — plus the hotkey reporting, which is the one control
// that has to tell the truth about whether the OS accepted it.
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
  window.__config = {
    launch: [{ title: 'Jenkins', icon: 'web', url: 'https://jenkins.example.com', keywords: ['ci'] }],
    projects: { roots: ['C:\\dev'], maxDepth: 3, openWith: [{ label: 'VS Code', program: 'code', args: ['{path}'] }] },
    todos: { roots: [], includeTags: [], openWith: { program: 'code', args: ['-g', '{path}:{line}'] } },
    health: { intervalSeconds: 60, timeoutMs: 4000, endpoints: [{ name: 'API', url: 'http://localhost:8080/health', expect: 200 }] },
    logs: { intervalSeconds: 60, staleAfterMins: 15, files: [{ name: 'api', path: 'C:\\services\\api\\application.log' }] },
    command: [],
  };
  window.__shortcut = { accelerator: 'CommandOrControl+Shift+Space', registered: false, error: 'Windows refused it — another application already owns it.' };

  // Seeded rather than defaulted inside getSettings: setItemOverride merges
  // onto this object, and merging onto `undefined` throws.
  window.__settings = {
    theme: 'dark', launcherShortcut: 'CommandOrControl+Shift+Space', keepInTray: true,
    startMinimized: false, dashboardColumns: 2, notifyOnFailure: false,
    providers: { launch: true, projects: true, todos: true, health: true, logs: true },
    collapsed: [], cardLayout: {}, setupComplete: true,
    itemOverrides: { 'launch::0:Jenkins': { hidden: true } },
    launcher: {
      opacity: 0.88, showHints: true, maxResults: 40, showRecentWhenEmpty: true,
      modes: ['all', 'projects', 'launch', 'todos', 'health', 'logs'],
    },
  };

  window.hubApi = {
    getSettings: async () => window.__settings,
    setupSuggestions: async () => ({ tools: [], repoRoots: [], notebookRoot: '' }),
    setItemOverride: async (key, itemOverride) => {
      window.__calls.push(['setItemOverride', key, JSON.stringify(itemOverride)]);
      const overrides = Object.assign({}, window.__settings.itemOverrides);
      if (itemOverride.hidden) overrides[key] = itemOverride; else delete overrides[key];
      window.__settings = Object.assign({}, window.__settings, { itemOverrides: overrides });
      return window.__settings;
    },
    hiddenItems: async () => [],
    onItemsChanged: () => {},
    runAtLogin: async () => window.__runAtLogin || false,
    setRunAtLogin: async (enabled) => {
      window.__calls.push(['setRunAtLogin', String(enabled)]);
      window.__runAtLogin = enabled;
      return enabled;
    },
    saveSettings: async (patch) => {
      window.__calls.push(['saveSettings', JSON.stringify(patch)]);
      window.__settings = Object.assign({}, window.__settings, patch);
      return window.__settings;
    },
    shortcutStatus: async () => window.__shortcut,
    shortcutSuggestions: async () => ['Alt+Space', 'CommandOrControl+Alt+Space'],
    setLauncherShortcut: async (accelerator) => {
      window.__calls.push(['setLauncherShortcut', accelerator]);
      window.__shortcut = { accelerator, registered: true, error: null };
      return window.__shortcut;
    },
    getConfig: async () => ({ text: '{ "launch": [] }', path: 'C:/DevHubData/hub.config.json', error: null }),
    getConfigJson: async () => window.__config,
    saveConfig: async (text) => { window.__calls.push(['saveConfig', text]); },
    // A save persists, the way the backend's does — otherwise reopening a
    // section silently reverts to the seed config and any test that edits,
    // saves, then edits again is testing a fiction.
    saveConfigJson: async (config) => {
      window.__saved = config;
      window.__config = JSON.parse(JSON.stringify(config));
      window.__calls.push(['saveConfigJson']);
      return config;
    },
    revealConfigFile: () => window.__calls.push(['revealConfigFile']),
    pickFolder: async () => 'C:\\work\\repos',
    pickProgram: async () => 'C:\\bin\\idea64.exe',
    getResults: async () => [],
    getItems: async () => [],
    refreshProvider: async () => ({}),
    refreshAll: async () => [],
    searchItems: async () => [],
    runAction: async () => ({ success: true }),
    openExternal: async () => {},
    showLauncher: () => window.__calls.push(['showLauncher']),
    onProviderUpdated: () => {}, onConfigChanged: () => {}, onShortcutStatus: () => {},
  };
});

await page.goto(`${server.origin}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(350);

const openSettings = async (section) => {
  await page.evaluate((s) => window.DevHubSettings.open(s), section || 'general');
  await page.waitForTimeout(200);
};

// --- The hotkey -----------------------------------------------------------

await openSettings('general');
check('the settings panel opens on General', await page.evaluate(() =>
  document.getElementById('settings-overlay').classList.contains('visible') &&
  document.querySelector('.set-nav-item.active').textContent.includes('General')));

// The hotkey lives with the rest of the launcher's settings.
await openSettings('launcher');
check('a hotkey the OS refused is shown as an error, not as working', await page.evaluate(() =>
  document.querySelector('.shortcut-box').classList.contains('error') &&
  document.querySelector('.shortcut-msg').textContent.includes('already owns')));

check('suggested alternatives are offered', await page.evaluate(() =>
  document.querySelectorAll('.shortcut-suggestions .chip-btn').length === 2));

await page.click('#set-test');
await page.waitForTimeout(80);
check('"Open the launcher now" bypasses the hotkey entirely', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'showLauncher')));

await page.click('.shortcut-suggestions .chip-btn');
await page.waitForTimeout(150);
check('picking a suggestion applies it', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'setLauncherShortcut' && c[1] === 'Alt+Space')));
check('a hotkey that registered is shown as working', await page.evaluate(() =>
  document.querySelector('.shortcut-box').classList.contains('ok')));

// Recording: click to arm, then press a combination.
await page.click('#set-record');
await page.waitForTimeout(80);
check('the recorder arms on click', await page.evaluate(() =>
  document.getElementById('set-record').textContent.includes('Press keys')));
await page.keyboard.press('Control+Alt+J');
await page.waitForTimeout(150);
check('a recorded combination is sent as an accelerator', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'setLauncherShortcut' && c[1] === 'CommandOrControl+Alt+J')));

check('a bare key with no modifier is refused, so a letter is not swallowed', await page.evaluate(() =>
  window.DevHubSettings.acceleratorFrom({ key: 'j', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }) === null));
check('a modifier alone does not end recording', await page.evaluate(() =>
  window.DevHubSettings.acceleratorFrom({ key: 'Control', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }) === null));
check('space is named the way the backend parses it', await page.evaluate(() =>
  window.DevHubSettings.acceleratorFrom({ key: ' ', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }) === 'CommandOrControl+Shift+Space'));

// --- Hidden items ---------------------------------------------------------

await openSettings('general');
check('hidden items are listed with a way back', await page.evaluate(() =>
  document.querySelector('#settings-body').textContent.includes('launch::0:Jenkins') &&
  !!document.querySelector('[data-unhide]')));

await page.click('[data-unhide]');
await page.waitForTimeout(250);
check('restoring one clears its hidden flag', await page.evaluate(() => {
  const call = window.__calls.filter(c => c[0] === 'setItemOverride').pop();
  return call[1] === 'launch::0:Jenkins' && JSON.parse(call[2]).hidden === false;
}));

check('the list empties once nothing is hidden', await page.evaluate(() =>
  !document.querySelector('[data-unhide]') &&
  document.querySelector('#settings-body').textContent.includes('Nothing hidden')));

// --- Quick Launch ---------------------------------------------------------

await openSettings('launcher');
check('the opacity slider reflects the stored value', await page.evaluate(() =>
  document.getElementById('launcher-opacity').value === '88' &&
  document.getElementById('opacity-value').textContent === '88%'));

await page.fill('#launcher-opacity', '96');
await page.waitForTimeout(120);
check('dragging the slider updates the readout live', await page.evaluate(() =>
  document.getElementById('opacity-value').textContent === '96%'));

check('every mode is listed and ticked by default', await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('[data-mode]')];
  return boxes.length === 6 && boxes.every(b => b.checked);
}));

await page.uncheck('[data-mode="health"]');
await page.waitForTimeout(120);
await page.click('#settings-save');
await page.waitForTimeout(250);

check('opacity is saved as a fraction, not a percentage', await page.evaluate(() => {
  const patch = JSON.parse(window.__calls.filter(c => c[0] === 'saveSettings').pop()[1]);
  return patch.launcher.opacity === 0.96;
}));

check('an unticked mode is dropped, and the rest keep their orb order', await page.evaluate(() => {
  const patch = JSON.parse(window.__calls.filter(c => c[0] === 'saveSettings').pop()[1]);
  return patch.launcher.modes.join(',') === 'all,projects,launch,todos,logs';
}));

// Ticking in a different order must not reorder the orbs.
await openSettings('launcher');
await page.uncheck('[data-mode="all"]');
await page.check('[data-mode="health"]');
await page.check('[data-mode="all"]');
await page.waitForTimeout(120);
await page.click('#settings-save');
await page.waitForTimeout(250);
check('mode order follows the orb rail, not the order you ticked them', await page.evaluate(() => {
  const patch = JSON.parse(window.__calls.filter(c => c[0] === 'saveSettings').pop()[1]);
  return patch.launcher.modes.join(',') === 'all,projects,launch,todos,health,logs';
}));

// The last mode standing can't be switched off.
await openSettings('launcher');
await page.evaluate(async () => {
  for (const id of ['all', 'projects', 'launch', 'todos', 'logs']) {
    const box = document.querySelector(`[data-mode="${id}"]`);
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const last = document.querySelector('[data-mode="health"]');
  last.checked = false;
  last.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 60));
});
check('switching off the last mode is refused, not silently accepted', await page.evaluate(() =>
  document.querySelector('[data-mode="health"]').checked &&
  document.getElementById('toast').textContent.includes('at least one mode')));

check('the keyboard hints have a switch', await page.evaluate(() =>
  !!document.querySelector('[data-path="launcher.showHints"]')));

// --- Apps & links ---------------------------------------------------------

await openSettings('launch');
check('existing entries render', await page.evaluate(() =>
  document.querySelectorAll('.set-card[data-entry]').length === 1 &&
  document.querySelector('.set-title-input').value === 'Jenkins'));

await page.click('[data-add-entry="launch"]');
await page.waitForTimeout(120);
check('adding an entry appends a card', await page.evaluate(() =>
  document.querySelectorAll('.set-card[data-entry]').length === 2));

// Fill the new entry in as a program, browsing for the path.
await page.click('.set-card[data-entry="1"] .kind-tab[data-kind="run"]');
await page.waitForTimeout(120);
await page.fill('.set-card[data-entry="1"] input[data-entry-field="title"]', 'IntelliJ');
await page.click('.set-card[data-entry="1"] [data-browse="program"]');
await page.waitForTimeout(150);
check('Browse fills the program path in', await page.evaluate(() =>
  document.querySelector('.set-card[data-entry="1"] input[data-entry-field="run.program"]').value === 'C:\\bin\\idea64.exe'));

await page.click('#settings-save');
await page.waitForTimeout(200);
check('saving sends the new entry to the backend', await page.evaluate(() => {
  const entry = (window.__saved.launch || [])[1];
  return entry && entry.title === 'IntelliJ' && entry.run.program === 'C:\\bin\\idea64.exe';
}));
check('switching an entry to a program drops its stale url', await page.evaluate(() =>
  window.__saved.launch[1].url === undefined));
check('saving closes the panel', await page.evaluate(() =>
  !document.getElementById('settings-overlay').classList.contains('visible')));

// --- Repos ----------------------------------------------------------------

await openSettings('projects');
check('repo roots render as an editable list', await page.evaluate(() =>
  document.querySelectorAll('input[data-listpath="projects.roots"]').length === 1 &&
  document.querySelector('input[data-listpath="projects.roots"]').value === 'C:\\dev'));

await page.click('[data-add-string="projects.roots"]');
await page.waitForTimeout(120);
await page.click('.set-list [data-index="1"][data-browse="folder"]');
await page.waitForTimeout(150);
check('Browse adds a folder to the list', await page.evaluate(() =>
  document.querySelectorAll('input[data-listpath="projects.roots"]')[1].value === 'C:\\work\\repos'));

await page.click('[data-remove="projects.roots"][data-index="0"]');
await page.waitForTimeout(120);
check('removing a root drops exactly that one', await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('input[data-listpath="projects.roots"]')];
  return inputs.length === 1 && inputs[0].value === 'C:\\work\\repos';
}));

await page.click('#settings-save');
await page.waitForTimeout(200);
check('the edited roots reach the backend', await page.evaluate(() =>
  JSON.stringify(window.__saved.projects.roots) === JSON.stringify(['C:\\work\\repos'])));

// --- Services -------------------------------------------------------------

await openSettings('health');
check('endpoints render', await page.evaluate(() =>
  document.querySelectorAll('[data-endpoint-field="url"]').length === 1));

await page.click('[data-add-endpoint]');
await page.waitForTimeout(120);
await page.fill('[data-endpoint-field="name"][data-index="1"]', 'API — dev');
await page.fill('[data-endpoint-field="url"][data-index="1"]', 'https://api.dev.example.com/health');
await page.fill('[data-endpoint-field="expect"][data-index="1"]', '204');
await page.click('#settings-save');
await page.waitForTimeout(200);
check('a new service round-trips with its expected status code', await page.evaluate(() => {
  const endpoint = window.__saved.health.endpoints[1];
  return endpoint.name === 'API — dev'
    && endpoint.url === 'https://api.dev.example.com/health'
    && endpoint.expect === 204;
}));

// --- Logs -----------------------------------------------------------------

await openSettings('logs');
check('watched log files render', await page.evaluate(() =>
  document.querySelectorAll('input[data-log-field="path"]').length === 1));
check('the panel says Dev Hub does not read the files itself', await page.evaluate(() =>
  document.querySelector('#settings-body').textContent.includes('never reads them')));

await page.click('[data-add-log]');
await page.waitForTimeout(120);
await page.fill('[data-log-field="name"][data-index="1"]', 'worker');
await page.fill('[data-log-field="path"][data-index="1"]', 'C:\\services\\worker\\logs\\application.log');
await page.fill('[data-path="logs.staleAfterMins"]', '30');
await page.click('#settings-save');
await page.waitForTimeout(200);
check('a new log file round-trips', await page.evaluate(() => {
  const file = window.__saved.logs.files[1];
  return file.name === 'worker' && file.path === 'C:\\services\\worker\\logs\\application.log';
}));
check('the staleness threshold round-trips as a number', await page.evaluate(() =>
  window.__saved.logs.staleAfterMins === 30));

// Saving closes the panel, so removing needs it open again.
await openSettings('logs');
await page.click('[data-remove-log="1"]');
await page.waitForTimeout(120);
await page.click('#settings-save');
await page.waitForTimeout(200);
check('removing a log file drops only that one', await page.evaluate(() =>
  window.__saved.logs.files.length === 1 && window.__saved.logs.files[0].name === 'api'));

// --- Todos ----------------------------------------------------------------

await openSettings('todos');
check('an empty notes root explains the Markdown Notebook fallback', await page.evaluate(() =>
  document.querySelector('#settings-body').textContent.includes('Markdown Notebook')));
check('the todo opener args edit as one string', await page.evaluate(() =>
  document.querySelector('[data-path="todos.openWith.argsText"]').value === '-g {path}:{line}'));

check('Save stays disabled until something is actually edited', await page.evaluate(() =>
  document.getElementById('settings-save').disabled));

await page.fill('[data-path="todos.openWith.program"]', 'code');
await page.click('#settings-save');
await page.waitForTimeout(200);
check('opener args are split back into an array on save', await page.evaluate(() =>
  JSON.stringify(window.__saved.todos.openWith.args) === JSON.stringify(['-g', '{path}:{line}'])
  && window.__saved.todos.openWith.argsText === undefined));

// --- General settings round-trip ------------------------------------------

await openSettings('general');
await page.selectOption('select[data-path="dashboardColumns"]', '3');
await page.click('input[data-path="providers.todos"]');
await page.click('#settings-save');
await page.waitForTimeout(200);
check('app settings save as their proper types', await page.evaluate(() => {
  const call = window.__calls.filter(c => c[0] === 'saveSettings').pop();
  const patch = JSON.parse(call[1]);
  return patch.dashboardColumns === 3 && patch.providers.todos === false;
}));

// --- Advanced -------------------------------------------------------------

await openSettings('advanced');
await page.waitForTimeout(150);
check('the raw editor is loaded with the file as written', await page.evaluate(() =>
  document.getElementById('set-raw').value.includes('"launch"')));
await page.click('#set-raw-save');
await page.waitForTimeout(150);
check('the raw editor saves text verbatim', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'saveConfig' && c[1].includes('"launch"'))));

// --- Guards ---------------------------------------------------------------

await openSettings('launch');
check('entry titles are escaped, not injected', await page.evaluate(async () => {
  window.__config.launch.push({ title: '<img src=x onerror=alert(1)>', icon: 'web', url: 'https://x' });
  await window.DevHubSettings.open('launch');
  await new Promise(r => setTimeout(r, 120));
  const body = document.getElementById('settings-body');
  return body.querySelectorAll('img').length === 0
    && [...body.querySelectorAll('.set-title-input')].some(i => i.value === '<img src=x onerror=alert(1)>');
}));

check('Save is disabled until something changes', await page.evaluate(async () => {
  await window.DevHubSettings.open('general');
  await new Promise(r => setTimeout(r, 120));
  return document.getElementById('settings-save').disabled;
}));

await browser.close();
await server.close();
process.exit(finish('settings') === 0 ? 0 : 1);
