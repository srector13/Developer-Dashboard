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

  // A provider whose item groups its openers, as `projects` does in practice.
  window.__groupedResult = {
    provider: 'grouped', displayName: 'Grouped', refreshedAt: now, error: null,
    items: [{
      id: 'g1', provider: 'grouped', title: 'payments-api', subtitle: 'C:/dev/payments-api',
      status: 'neutral', badges: [],
      actions: [
        { kind: 'run', label: 'IntelliJ', program: 'idea64.exe', args: [], capture: false },
        { kind: 'run', label: 'VS Code', program: 'code', args: [], capture: false },
        { kind: 'openPath', label: 'Open folder', path: 'C:/dev/payments-api' },
        { kind: 'copyText', label: 'Copy path', text: 'C:/dev/payments-api' },
      ],
      actionGroups: [{ label: 'Open with', actions: [0, 1, 2] }],
    }],
  };

  // Seeded rather than defaulted inside getSettings: saveSettings merges onto
  // this object, and merging onto `undefined` silently dropped every key the
  // patch didn't mention.
  window.__settings = {
    theme: 'dark', launcherShortcut: 'CommandOrControl+Shift+Space',
    dashboardColumns: 2, collapsed: [], cardLayout: {}, cardOrder: [],
    // Already set up: first-run setup has its own spec.
    setupComplete: true,
  };

  window.hubApi = {
    getSettings: async () => window.__settings,
    setupSuggestions: async () => ({ tools: [], repoRoots: [], notebookRoot: '' }),
    runAtLogin: async () => false,
    setRunAtLogin: async (enabled) => enabled,
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
    setItemOverride: async (key, itemOverride) => {
      window.__calls.push(['setItemOverride', key, JSON.stringify(itemOverride)]);
      window.__settings.itemOverrides = Object.assign({}, window.__settings.itemOverrides, { [key]: itemOverride });
      return window.__settings;
    },
    hiddenItems: async () => [],
    onItemsChanged: () => {},
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

check('the hover strip holds every action except the default', await page.evaluate(() => {
  // One action button, plus the always-present customise button.
  const row = document.querySelector('.card[data-provider="projects"] .card-row');
  return row.querySelectorAll('.row-btn:not([data-customise])').length === 1
    && row.querySelectorAll('[data-customise]').length === 1;
}));

await page.evaluate(() => { window.__runResult = { success: false, message: 'IntelliJ — could not run idea64.exe' }; });
await page.click('.card[data-provider="launch"] .card-row .row-main');
await page.waitForTimeout(120);
check('a failed action surfaces as a toast rather than silence', await page.evaluate(() =>
  document.getElementById('toast').classList.contains('visible') &&
  document.getElementById('toast').textContent.includes('could not run')));
await page.evaluate(() => { window.__runResult = { success: true }; });

// --- Refresh --------------------------------------------------------------

await page.click('.card[data-provider="health"] [data-refresh]');
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

// --- Card sizing ----------------------------------------------------------

// Bring in the grouped-actions card for the menu assertions below.
await page.evaluate(() => window.__providerUpdated(window.__groupedResult));
await page.waitForTimeout(150);

// The projects card was replaced by the provider-updated test above with
// action-less items, so this reads the launch card, which still has its.
check('action buttons carry their label, not just a glyph', await page.evaluate(() => {
  const button = document.querySelector('.card[data-provider="launch"] .row-btn');
  return button.textContent.trim() === 'Copy URL' && !!button.querySelector('svg');
}));

check('cards default to the medium preset', await page.evaluate(() =>
  document.querySelector('.card[data-provider="launch"]').classList.contains('size-medium')));

check('every card is a whole number of grid rows, so rows stay aligned', await page.evaluate(() => {
  const spans = [...document.querySelectorAll('.card')]
    .map(c => getComputedStyle(c).gridRowEnd);
  return spans.every(s => /^span \d+$/.test(s));
}));

await page.click('.card[data-provider="launch"] .size-btn[data-size="large"]');
await page.waitForTimeout(200);
check('choosing Large applies the preset', await page.evaluate(() => {
  const card = document.querySelector('.card[data-provider="launch"]');
  return card.classList.contains('size-large') && !card.classList.contains('size-medium');
}));
check('a large card spans two columns', await page.evaluate(() =>
  getComputedStyle(document.querySelector('.card[data-provider="launch"]')).gridColumnEnd === 'span 2'));
check('the size is persisted', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'saveSettings' && c[1].includes('"size":"large"'))));

await page.click('.card[data-provider="launch"] .size-btn[data-size="small"]');
await page.waitForTimeout(200);
check('choosing Small applies too, and drops back to one column', await page.evaluate(() => {
  const card = document.querySelector('.card[data-provider="launch"]');
  // Measured against a card known to be one column wide, rather than against
  // the computed grid-column — an unspanned card computes to `auto`, not
  // `span 1`, so asserting on the string would be asserting on CSS trivia.
  const single = document.querySelector('.card[data-provider="projects"]');
  return card.classList.contains('size-small')
    && Math.abs(card.getBoundingClientRect().width - single.getBoundingClientRect().width) < 2;
}));
check('the active size is the one marked in the control', await page.evaluate(() => {
  const active = document.querySelector('.card[data-provider="launch"] .size-btn[data-size].active');
  return active && active.dataset.size === 'small';
}));

check('cards never overlap each other', await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('.card')].map(c => c.getBoundingClientRect());
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const overlaps = a.left < b.right - 1 && b.left < a.right - 1
        && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      if (overlaps) return false;
    }
  }
  return true;
}));

check('a large card cannot span two columns when the grid has one', await page.evaluate(async () => {
  window.__settings = Object.assign({}, await window.hubApi.getSettings(), { dashboardColumns: 1 });
  await window.DevHubDashboard.load();
  window.DevHubDashboard.setSize('launch', 'large');
  await new Promise(r => setTimeout(r, 80));
  const card = document.querySelector('.card[data-provider="launch"]');
  const grid = document.getElementById('grid');
  // Never wider than the grid's content box, whatever the preset says.
  return card.getBoundingClientRect().width <= grid.clientWidth + 1;
}));

await page.evaluate(async () => {
  window.__settings = Object.assign({}, await window.hubApi.getSettings(), { dashboardColumns: 2 });
  window.DevHubDashboard.setSize('launch', 'small');
  await window.DevHubDashboard.load();
  // load() re-reads getResults(), which doesn't include the injected grouped
  // provider — put it back for the assertions below.
  window.__providerUpdated(window.__groupedResult);
});
await page.waitForTimeout(200);

// --- Rearranging ----------------------------------------------------------

check('a provider with no saved order is appended rather than dropped', await page.evaluate(() =>
  window.DevHubDashboard.orderedProviders().join(',') === 'launch,projects,health,grouped'));

check('dragging is started from the header, not the body', await page.evaluate(() =>
  document.querySelector('.card-header').getAttribute('draggable') === 'true' &&
  !document.querySelector('.card-body').getAttribute('draggable')));

// Reorder through the DOM the way a drop does, then persist.
check('a rearrangement is persisted as the new order', await page.evaluate(() => {
  const grid = document.getElementById('grid');
  const launch = document.querySelector('.card[data-provider="launch"]');
  const health = document.querySelector('.card[data-provider="health"]');
  grid.insertBefore(launch, health.nextSibling);
  window.DevHubDashboard.persistOrder();
  const call = window.__calls.filter(c => c[0] === 'saveSettings').pop();
  return JSON.parse(call[1]).cardOrder.join(',') === 'projects,health,launch,grouped';
}));

// --- Grouped actions ------------------------------------------------------

check('grouped actions collapse into one menu button', await page.evaluate(() => {
  const row = document.querySelector('.card[data-provider="grouped"] .card-row');
  const buttons = [...row.querySelectorAll('.row-actions > .row-btn:not([data-customise])')];
  // Three editors behind "Open with", plus the ungrouped "Copy path" — two
  // buttons where the old layout would have shown four.
  return buttons.length === 2
    && buttons[0].textContent.trim() === 'Open with'
    && buttons[1].textContent.trim() === 'Copy path';
}));

check('a grouped action is not also shown as a loose button', await page.evaluate(() => {
  const labels = [...document.querySelectorAll('.card[data-provider="grouped"] .row-actions > .row-btn:not([data-customise])')]
    .map(b => b.textContent.trim());
  return !labels.includes('IntelliJ') && !labels.includes('VS Code');
}));

check('the menu is closed until asked for', await page.evaluate(() =>
  !document.querySelector('.row-menu-popup')));

await page.click('.card[data-provider="grouped"] [data-open-menu]');
await page.waitForTimeout(150);
check('opening the menu lists every editor', await page.evaluate(() => {
  const items = [...document.querySelectorAll('.row-menu-popup .menu-item')];
  return items.map(i => i.textContent.trim()).join(',') === 'IntelliJ,VS Code,Open folder';
}));

// The menu must escape the card, which clips its own overflow and has a fixed
// height on the grid — an inline dropdown lost its lower half near an edge.
check('the menu is not clipped by the card it belongs to', await page.evaluate(() => {
  const popup = document.querySelector('.row-menu-popup');
  const card = document.querySelector('.card[data-provider="grouped"]');
  return popup.parentElement === document.body
    && !card.contains(popup)
    && getComputedStyle(popup).position === 'fixed';
}));

check('the menu is fully on screen', await page.evaluate(() => {
  const box = document.querySelector('.row-menu-popup').getBoundingClientRect();
  return box.top >= 0 && box.left >= 0
    && box.bottom <= window.innerHeight && box.right <= window.innerWidth;
}));

await page.click('.row-menu-popup .menu-item:nth-child(2)');
await page.waitForTimeout(150);
check('choosing one runs that action index', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'runAction' && c[1] === 'grouped::g1' && c[2] === 1)));
check('the menu closes after choosing', await page.evaluate(() =>
  !document.querySelector('.row-menu-popup')));

await page.click('.card[data-provider="grouped"] [data-open-menu]');
await page.waitForTimeout(120);
await page.keyboard.press('Escape');
await page.waitForTimeout(120);
check('Escape dismisses the menu', await page.evaluate(() =>
  !document.querySelector('.row-menu-popup')));

// --- Item customisation ---------------------------------------------------

await page.click('.card[data-provider="projects"] [data-customise]');
await page.waitForTimeout(200);
check('the ⋯ button opens the customisation menu', await page.evaluate(() =>
  !!document.querySelector('.item-menu')));

check('the menu escapes the card and stays on screen', await page.evaluate(() => {
  const menu = document.querySelector('.item-menu');
  const box = menu.getBoundingClientRect();
  return menu.parentElement === document.body
    && getComputedStyle(menu).position === 'fixed'
    && box.top >= 0 && box.left >= 0
    && box.bottom <= window.innerHeight && box.right <= window.innerWidth;
}));

check('it offers a nickname, icons and colours', await page.evaluate(() =>
  !!document.querySelector('#item-nickname')
  && document.querySelectorAll('.icon-choice').length > 4
  && document.querySelectorAll('.accent-choice').length > 4));

await page.fill('#item-nickname', 'Payments API');
await page.click('.accent-choice[data-accent="#bc8cff"]');
await page.click('.icon-choice[data-icon="star"]');
await page.click('#item-save');
await page.waitForTimeout(250);

check('saving sends the nickname, icon and accent for that item', await page.evaluate(() => {
  const call = window.__calls.filter(c => c[0] === 'setItemOverride').pop();
  const patch = JSON.parse(call[2]);
  return call[1] === 'projects::C:/dev/api'
    && patch.nickname === 'Payments API'
    && patch.accent === '#bc8cff'
    && patch.icon === 'star'
    && patch.hidden === false;
}));

check('the menu closes after saving', await page.evaluate(() =>
  !document.querySelector('.item-menu')));

// Right-click is the fast route to the same menu.
await page.click('.card[data-provider="launch"] .card-row', { button: 'right' });
await page.waitForTimeout(200);
check('right-clicking a row opens the menu too', await page.evaluate(() =>
  !!document.querySelector('.item-menu')));

await page.click('#item-hide');
await page.waitForTimeout(250);
check('Hide sends hidden without inventing a nickname', await page.evaluate(() => {
  const call = window.__calls.filter(c => c[0] === 'setItemOverride').pop();
  const patch = JSON.parse(call[2]);
  return call[1] === 'launch::0:Jenkins' && patch.hidden === true && patch.nickname === null;
}));

await page.click('.card[data-provider="projects"] [data-customise]');
await page.waitForTimeout(200);
await page.click('#item-reset');
await page.waitForTimeout(250);
check('Reset clears every field rather than only the one you see', await page.evaluate(() => {
  const patch = JSON.parse(window.__calls.filter(c => c[0] === 'setItemOverride').pop()[2]);
  return patch.nickname === null && patch.icon === null && patch.accent === null && patch.hidden === false;
}));

check('left-clicking a row still runs it rather than opening the menu', await page.evaluate(async () => {
  const before = window.__calls.filter(c => c[0] === 'runAction').length;
  document.querySelector('.card[data-provider="projects"] .card-row .row-main').click();
  await new Promise(r => setTimeout(r, 120));
  return window.__calls.filter(c => c[0] === 'runAction').length === before + 1
    && !document.querySelector('.item-menu');
}));

check('a per-item accent reaches the row', await page.evaluate(async () => {
  window.__providerUpdated({
    provider: 'launch', displayName: 'Launch', refreshedAt: 1, error: null,
    items: [{
      id: 'a', provider: 'launch', title: 'Coloured', accent: '#bc8cff', icon: 'star',
      status: 'neutral', badges: [], actions: [],
    }],
  });
  await new Promise(r => setTimeout(r, 80));
  const row = document.querySelector('.card[data-provider="launch"] .card-row');
  return row.style.getPropertyValue('--row-accent') === '#bc8cff'
    && !!row.querySelector('.row-glyph')
    && !!row.querySelector('.row-dot');
}));

// --- View modes -----------------------------------------------------------

await page.click('.card[data-provider="launch"] [data-view="grid"]');
await page.waitForTimeout(200);
check('grid view renders tiles instead of rows', await page.evaluate(() => {
  const card = document.querySelector('.card[data-provider="launch"]');
  return !!card.querySelector('.tile-grid')
    && card.querySelectorAll('.card-tile').length === 1
    && card.querySelectorAll('.card-row').length === 0;
}));

check('the view choice is persisted alongside the size', await page.evaluate(() => {
  const patch = JSON.parse(window.__calls.filter(c => c[0] === 'saveSettings').pop()[1]);
  return patch.cardLayout.launch.view === 'grid' && !!patch.cardLayout.launch.size;
}));

check('a tile runs the item when clicked', await page.evaluate(async () => {
  const before = window.__calls.filter(c => c[0] === 'runAction').length;
  document.querySelector('.card[data-provider="launch"] .card-tile').click();
  await new Promise(r => setTimeout(r, 120));
  return window.__calls.filter(c => c[0] === 'runAction').length === before + 1;
}));

await page.click('.card[data-provider="launch"] [data-view="list"]');
await page.waitForTimeout(200);
check('switching back gives rows again', await page.evaluate(() => {
  const card = document.querySelector('.card[data-provider="launch"]');
  return card.querySelectorAll('.card-row').length === 1 && !card.querySelector('.tile-grid');
}));

// --- Markdown titles ------------------------------------------------------

check('a rich title renders its markdown', await page.evaluate(async () => {
  window.__providerUpdated({
    provider: 'todos', displayName: 'Todos', refreshedAt: 1, error: null,
    items: [{
      id: 't1', provider: 'todos', title: 'ship the **beta** to `prod`',
      richTitle: true, subtitle: 'work/plan.md:4', status: 'neutral', badges: [],
      actions: [{ kind: 'openPath', label: 'Open note', path: '/n/plan.md' }],
    }],
  });
  await new Promise(r => setTimeout(r, 80));
  const title = document.querySelector('.card[data-provider="todos"] .row-title');
  return !!title.querySelector('strong') && !!title.querySelector('code')
    && title.textContent === 'ship the beta to prod';
}));

check('a todo shows no action buttons, because it has exactly one action', await page.evaluate(() =>
  document.querySelectorAll('.card[data-provider="todos"] .row-actions > .row-btn:not([data-customise])').length === 0));

check('markup in a rich title is still escaped, not executed', await page.evaluate(async () => {
  window.__providerUpdated({
    provider: 'todos', displayName: 'Todos', refreshedAt: 1, error: null,
    items: [{
      id: 't2', provider: 'todos', title: '<img src=x onerror=alert(1)> **b**',
      richTitle: true, status: 'neutral', badges: [], actions: [],
    }],
  });
  await new Promise(r => setTimeout(r, 80));
  const card = document.querySelector('.card[data-provider="todos"]');
  return card.querySelectorAll('img').length === 0
    && !!card.querySelector('.row-title strong')
    && card.querySelector('.row-title').textContent.includes('<img src=x onerror=alert(1)>');
}));

check('a plain title is left alone, so an underscore is not an italic', await page.evaluate(() => {
  const title = document.querySelector('.card[data-provider="projects"] .row-title');
  return !title.querySelector('em') && !title.querySelector('strong');
}));

check('cards carry a per-provider accent colour', await page.evaluate(() => {
  const a = document.querySelector('.card[data-provider="launch"]').style.getPropertyValue('--card-accent');
  const b = document.querySelector('.card[data-provider="projects"]').style.getPropertyValue('--card-accent');
  return !!a && !!b && a !== b;
}));

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
