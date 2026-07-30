// Dashboard harness: loads renderer/index.html in Chromium with a stubbed
// hubApi and exercises card rendering, provider-updated live refresh, error
// surfacing, collapse persistence and action dispatch.
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
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERROR:', m.text()); });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.addInitScript(() => {
  window.__calls = [];
  const now = Math.floor(Date.now() / 1000);
  window.__results = [
    {
      provider: 'launch', displayName: 'Launch', refreshedAt: now, error: null,
      items: [{
        id: '0:Jenkins', provider: 'launch', title: 'Jenkins',
        subtitle: 'https://jenkins.example.com', icon: 'web', status: 'neutral',
        badges: [], keywords: [],
        actions: [
          { kind: 'openUrl', label: 'Open', url: 'https://jenkins.example.com' },
          { kind: 'copyText', label: 'Copy URL', text: 'https://jenkins.example.com' },
        ],
      }],
    },
    {
      provider: 'projects', displayName: 'Projects', refreshedAt: now - 300,
      error: 'Z:\\missing does not exist',
      items: [{
        id: 'C:/dev/api', provider: 'projects', title: 'api',
        subtitle: 'C:/dev/api · 2h ago', icon: 'git', status: 'warn',
        badges: ['main', 'dirty'], keywords: [],
        actions: [
          { kind: 'run', label: 'IntelliJ', program: 'idea64.exe', args: [], capture: false },
          { kind: 'openPath', label: 'Open folder', path: 'C:/dev/api' },
        ],
      }],
    },
    // Never refreshed: the card must say so rather than looking empty.
    { provider: 'health', displayName: 'Health', refreshedAt: 0, error: null, items: [] },
  ];

  window.hubApi = {
    getSettings: async () => window.__settings || {
      theme: 'dark', launcherShortcut: 'CommandOrControl+Shift+Space',
      dashboardColumns: 2, collapsed: [],
    },
    saveSettings: async (patch) => {
      window.__calls.push(['saveSettings', JSON.stringify(patch)]);
      window.__settings = Object.assign({}, window.__settings, patch);
      return window.__settings;
    },
    getAppVersion: async () => '0.1.0',
    shortcutStatus: async () => window.__shortcut || {
      accelerator: 'CommandOrControl+Shift+Space', registered: true, error: null,
    },
    shortcutSuggestions: async () => ['Alt+Space'],
    setLauncherShortcut: async (accelerator) => {
      window.__calls.push(['setLauncherShortcut', accelerator]);
      return { accelerator, registered: true, error: null };
    },
    getConfig: async () => ({ text: '{}', path: 'C:/DevHubData/hub.config.json', error: window.__configError || null }),
    getConfigJson: async () => window.__config || { launch: [], projects: { roots: [], maxDepth: 3, openWith: [] }, todos: {}, health: { endpoints: [], intervalSeconds: 60, timeoutMs: 4000 }, command: [] },
    saveConfig: async () => {},
    saveConfigJson: async (config) => { window.__calls.push(['saveConfigJson', JSON.stringify(config)]); return config; },
    revealConfigFile: () => window.__calls.push(['revealConfigFile']),
    pickFolder: async () => window.__picked || null,
    pickProgram: async () => window.__picked || null,
    listProviders: async () => [],
    getResults: async () => window.__results,
    getItems: async () => [],
    refreshProvider: async (provider) => {
      window.__calls.push(['refreshProvider', provider]);
      return {
        provider, displayName: 'Health', refreshedAt: Math.floor(Date.now() / 1000), error: null,
        items: [{
          id: 'http://localhost:8080/health', provider: 'health', title: 'API — local',
          subtitle: '200 · 12ms', status: 'ok', badges: ['200'], actions: [],
        }],
      };
    },
    refreshAll: async () => { window.__calls.push(['refreshAll']); return window.__results; },
    searchItems: async () => [],
    runAction: async (itemId, actionIndex) => {
      window.__calls.push(['runAction', itemId, actionIndex]);
      return window.__runResult || { success: true };
    },
    openExternal: async () => {},
    showLauncher: () => window.__calls.push(['showLauncher']),
    onProviderUpdated: (cb) => { window.__providerUpdated = cb; },
    onConfigChanged: (cb) => { window.__configChanged = cb; },
    onShortcutStatus: (cb) => { window.__shortcutStatus = cb; },
  };
});

await page.goto(`${server.origin}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(400);

// --- Cards ----------------------------------------------------------------

check('one card per provider, in backend order', await page.evaluate(() =>
  [...document.querySelectorAll('.card')].map(c => c.dataset.provider).join(',') === 'launch,projects,health'));

check('cards show their item count and last-refreshed time', await page.evaluate(() => {
  const card = document.querySelector('.card[data-provider="launch"]');
  return card.querySelector('.card-count').textContent === '1'
    && card.querySelector('.card-meta').textContent === 'just now';
}));

check('a provider error renders on the card alongside what it did find', await page.evaluate(() => {
  const card = document.querySelector('.card[data-provider="projects"]');
  return card.querySelector('.card-error').textContent.includes('does not exist')
    && card.querySelectorAll('.card-row').length === 1;
}));

check('a never-refreshed provider says it is loading, not that it is empty', await page.evaluate(() => {
  const card = document.querySelector('.card[data-provider="health"]');
  return card.querySelector('.card-empty').textContent.trim() === 'Loading…';
}));

check('rows carry a status dot and badges', await page.evaluate(() => {
  const row = document.querySelector('.card[data-provider="projects"] .card-row');
  return !!row.querySelector('.row-dot.warn')
    && [...row.querySelectorAll('.badge')].map(b => b.textContent).join(',') === 'main,dirty'
    && !!row.querySelector('.badge.warn');
}));

// --- Actions --------------------------------------------------------------

await page.click('.card[data-provider="launch"] .card-row .row-main');
await page.waitForTimeout(100);
check('a row click runs action 0 with the namespaced key', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'runAction' && c[1] === 'launch::0:Jenkins' && c[2] === 0)));

await page.click('.card[data-provider="projects"] .card-row .row-btn');
await page.waitForTimeout(100);
check('a hover action button runs the matching action index', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'runAction' && c[1] === 'projects::C:/dev/api' && c[2] === 1)));

check('the hover strip holds every action except the default', await page.evaluate(() =>
  document.querySelector('.card[data-provider="projects"] .card-row').querySelectorAll('.row-btn').length === 1));

await page.evaluate(() => { window.__runResult = { success: false, message: 'IntelliJ — could not run idea64.exe' }; });
await page.click('.card[data-provider="launch"] .card-row .row-main');
await page.waitForTimeout(120);
check('a failed action surfaces as a toast rather than silence', await page.evaluate(() =>
  document.getElementById('toast').classList.contains('visible') &&
  document.getElementById('toast').textContent.includes('could not run')));
await page.evaluate(() => { window.__runResult = { success: true }; });

// --- Refresh --------------------------------------------------------------

await page.click('.card[data-provider="health"] .card-refresh');
await page.waitForTimeout(150);
check('the per-card refresh button refreshes only that provider', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'refreshProvider' && c[1] === 'health')));
check('the refreshed card re-renders in place with its new items', await page.evaluate(() => {
  const card = document.querySelector('.card[data-provider="health"]');
  return card.querySelector('.card-row .row-title').textContent === 'API — local'
    && [...document.querySelectorAll('.card')].map(c => c.dataset.provider).join(',') === 'launch,projects,health';
}));

await page.click('#refresh-all');
await page.waitForTimeout(150);
check('the top strip refreshes everything', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'refreshAll')));

// --- Live updates ---------------------------------------------------------

await page.evaluate(() => window.__providerUpdated({
  provider: 'projects', displayName: 'Projects', refreshedAt: Math.floor(Date.now() / 1000),
  error: null,
  items: [
    { id: 'C:/dev/api', provider: 'projects', title: 'api', subtitle: 'C:/dev/api', status: 'neutral', badges: [], actions: [] },
    { id: 'C:/dev/web', provider: 'projects', title: 'web', subtitle: 'C:/dev/web', status: 'neutral', badges: [], actions: [] },
  ],
}));
await page.waitForTimeout(120);
check('provider-updated replaces just that card, clearing its old error', await page.evaluate(() => {
  const card = document.querySelector('.card[data-provider="projects"]');
  return card.querySelector('.card-count').textContent === '2'
    && !card.querySelector('.card-error')
    && document.querySelectorAll('.card').length === 3;
}));

// --- Collapse -------------------------------------------------------------

await page.click('.card[data-provider="launch"] .card-header');
await page.waitForTimeout(120);
check('clicking a header collapses the card', await page.evaluate(() =>
  document.querySelector('.card[data-provider="launch"]').classList.contains('collapsed')));
check('collapse state is persisted to settings', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'saveSettings' && c[1].includes('launch'))));

await page.click('.card[data-provider="launch"] .card-header');
await page.waitForTimeout(120);
check('clicking again expands it', await page.evaluate(() =>
  !document.querySelector('.card[data-provider="launch"]').classList.contains('collapsed')));

// --- Top strip ------------------------------------------------------------

await page.click('#search-wrap');
await page.waitForTimeout(80);
check('the search field opens the launcher rather than searching in place', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'showLauncher')));
check('the search field shows the configured shortcut', await page.evaluate(() =>
  document.getElementById('search-kbd').textContent === 'Ctrl+Shift+Space'));

await page.click('#open-settings');
await page.waitForTimeout(150);
check('the Settings button opens the settings panel', await page.evaluate(() =>
  document.getElementById('settings-overlay').classList.contains('visible')));
await page.keyboard.press('Escape');
await page.waitForTimeout(80);
check('Escape closes the settings panel', await page.evaluate(() =>
  !document.getElementById('settings-overlay').classList.contains('visible')));

// --- Banners --------------------------------------------------------------

await page.evaluate(() => window.__shortcutStatus({
  accelerator: 'CommandOrControl+Shift+Space',
  registered: false,
  error: 'Windows refused CommandOrControl+Shift+Space — another application already owns it.',
}));
await page.waitForTimeout(80);
check('a hotkey that did not register is reported in the banner', await page.evaluate(() =>
  document.getElementById('banner').classList.contains('visible') &&
  document.getElementById('banner').textContent.includes('already owns')));
check('the banner offers a way to fix it', await page.evaluate(() =>
  document.getElementById('banner-action').textContent === 'Choose another'));

await page.evaluate(() => window.__configChanged({ ok: false, error: 'hub.config.json is not valid JSON: expected value at line 3' }));
await page.waitForTimeout(80);
check('a broken config is reported in the banner', await page.evaluate(() =>
  document.getElementById('banner').textContent.includes('not valid JSON')));

await page.evaluate(() => window.__configChanged({ ok: true }));
await page.waitForTimeout(200);
check('a good config reload clears the banner', await page.evaluate(() =>
  !document.getElementById('banner').classList.contains('visible')));

// --- Guards ---------------------------------------------------------------

check('no emoji glyphs in the chrome (SVG icons only)', await page.evaluate(() =>
  !/[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u.test(document.getElementById('topbar').textContent)));

check('the grid honours the configured column count', await page.evaluate(() =>
  getComputedStyle(document.getElementById('grid')).getPropertyValue('--columns').trim() === '2'));

check('titles are escaped, not injected as markup', await page.evaluate(async () => {
  window.__providerUpdated({
    provider: 'launch', displayName: 'Launch', refreshedAt: 1, error: null,
    items: [{ id: 'x', provider: 'launch', title: '<img src=x onerror=alert(1)>', status: 'neutral', badges: [], actions: [] }],
  });
  await new Promise(r => setTimeout(r, 60));
  const card = document.querySelector('.card[data-provider="launch"]');
  return card.querySelectorAll('img').length === 0
    && card.querySelector('.row-title').textContent === '<img src=x onerror=alert(1)>';
}));

await browser.close();
await server.close();
process.exit(finish('dashboard') === 0 ? 0 : 1);
