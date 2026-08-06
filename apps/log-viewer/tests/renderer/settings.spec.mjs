// The Log Viewer's settings screen.
//
// The point of this screen is that logs.config.json never has to be opened by
// hand, so the things worth testing are the ones that would send someone back
// to the file: a nickname or a group that doesn't reach the save, a highlight
// whose regex is wrong in a way nothing mentions, a colour that isn't applied,
// and a raw-JSON edit that overwrites a working config with something broken.
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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERROR:', m.text()); });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.addInitScript(() => {
  window.__calls = [];

  window.__settings = {
    theme: 'dark', wrap: false, showTimestamps: true, showSource: true,
    showLevel: true, pollIntervalMs: 250, follow: true,
    capacity: 500000, window: 2000, fontSize: 12,
  };

  window.__config = {
    sources: [
      { id: 'api-0', name: 'api', path: 'C:/logs/api.log', enabled: true, colour: 'blue', app: 'Payments', env: 'prod' },
      { id: 'worker-1', name: '', path: 'C:/logs/worker.log', enabled: true, colour: 'teal', app: '', env: '' },
    ],
    filters: [],
    highlights: [
      { id: 'error', name: 'Errors', pattern: 'ERROR', regex: false, caseSensitive: true, colour: 'red', enabled: true },
    ],
  };

  // What the filter bar currently holds, for "save what the filter bar says".
  window.__filter = {
    query: 'timeout', exclude: '/health', regex: false, caseSensitive: false,
    minLevel: 'warn', sources: [], sinceMins: 60,
  };

  const empty = { lines: [], matched: 0, total: 0, truncated: false };

  window.logsApi = {
    context: async () => ({
      settings: JSON.parse(JSON.stringify(window.__settings)),
      config: JSON.parse(JSON.stringify(window.__config)),
      sources: [],
      filter: JSON.parse(JSON.stringify(window.__filter)),
      version: '0.2.0',
      configError: null,
      siblings: [],
    }),
    listSources: async () => [],
    setFilter: async () => empty,
    refresh: async () => empty,
    clear: async () => empty,
    copyView: async () => '',
    writeClipboard: async () => {},
    saveSettings: async (s) => { window.__calls.push(['saveSettings', s]); window.__settings = s; return s; },
    saveConfig: async (c) => {
      window.__calls.push(['saveConfig', c]);
      if (window.__saveConfigError) throw window.__saveConfigError;
      window.__config = c;
      return c;
    },
    setSourceEnabled: async () => {},
    removeSource: async () => {},
    pinSource: async () => {},
    reloadSource: async () => {},
    revealSource: async () => {},
    addSource: async () => {},
    pickFiles: async () => [],
    browseFile: async () => { window.__calls.push(['browseFile']); return 'C:/logs/picked.log'; },
    revealConfigFile: async () => { window.__calls.push(['revealConfigFile']); },
    openSibling: async () => {},
    // The real one is Rust's regex crate. The stub refuses an unbalanced paren,
    // which is enough to prove the UI reports what the backend says rather than
    // validating with the browser's own, different, RegExp.
    checkPattern: async (pattern, regex) => {
      window.__calls.push(['checkPattern', pattern, regex]);
      if (regex && (pattern.split('(').length !== pattern.split(')').length)) {
        throw 'regex parse error: unclosed group';
      }
    },
    onLinesAppended: (cb) => { window.__appended = cb; },
    onSourcesChanged: (cb) => { window.__sourcesChanged = cb; },
    onConfigChanged: (cb) => { window.__configChanged = cb; },
    onFileDrop: () => {},
    onFileDropHover: () => {},
    onFileDropCancel: () => {},
  };
});

await page.goto(`${server.origin}/index.html`);
await page.waitForSelector('body[data-ready="true"]');

const lastSave = () => page.evaluate(() => {
  const call = window.__calls.filter(c => c[0] === 'saveConfig').pop();
  return call ? call[1] : null;
});
const lastSettingsSave = () => page.evaluate(() => {
  const call = window.__calls.filter(c => c[0] === 'saveSettings').pop();
  return call ? call[1] : null;
});
const open = async (section) => {
  await page.evaluate((s) => window.LogViewerSettings.open(s), section || null);
  await page.waitForTimeout(120);
};

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

{
  await page.click('#open-settings');
  await page.waitForTimeout(150);
  check('the gear opens the settings screen',
    await page.locator('#settings-overlay').evaluate(el => el.classList.contains('visible')));
  check('it lands on Sources', (await page.locator('.set-nav-item.on').textContent()).trim() === 'Sources');
  check('one card per configured file',
    await page.locator('.set-card[data-card="sources"]').count() === 2);
  check('Save starts disabled — nothing has been changed yet',
    await page.locator('#settings-save').isDisabled());
}

{
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check('Escape closes it',
    !(await page.locator('#settings-overlay').evaluate(el => el.classList.contains('visible'))));
}

{
  // Each sidebar panel's "Edit" opens the section it belongs to, so you land on
  // the thing you were looking at.
  await page.hover('#highlights-panel');
  await page.click('#highlights-panel .panel-action');
  await page.waitForTimeout(150);
  check('a panel\'s Edit link opens that section',
    (await page.locator('.set-nav-item.on').textContent()).trim() === 'Highlights');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
}

// ---------------------------------------------------------------------------
// Sources: nicknames and grouping
// ---------------------------------------------------------------------------

{
  await open('sources');
  const card = page.locator('.set-card[data-card="sources"]').nth(1);
  await card.locator('input[data-key="name"]').fill('worker');
  await card.locator('input[data-key="app"]').fill('Payments');
  await card.locator('input[data-key="env"]').fill('uat');

  check('editing enables Save', !(await page.locator('#settings-save').isDisabled()));
  await page.click('#settings-save');
  await page.waitForTimeout(200);

  const saved = await lastSave();
  check('the nickname reaches the config', saved.sources[1].name === 'worker', JSON.stringify(saved.sources[1]));
  check('…as do the application and environment',
    saved.sources[1].app === 'Payments' && saved.sources[1].env === 'uat',
    JSON.stringify(saved.sources[1]));
  check('…and the file it was already watching is untouched',
    saved.sources[0].path === 'C:/logs/api.log');
  check('Save goes back to disabled once it has been taken',
    await page.locator('#settings-save').isDisabled());
}

{
  const before = await page.locator('.set-card[data-card="sources"]').count();
  await page.click('[data-add="sources"]');
  await page.waitForTimeout(100);
  check('a file can be added without touching the config file',
    await page.locator('.set-card[data-card="sources"]').count() === before + 1);

  await page.locator('.set-card[data-card="sources"]').last().locator('[data-browse]').click();
  await page.waitForTimeout(200);
  check('Browse fills the path in',
    await page.locator('.set-card[data-card="sources"]').last().locator('input[data-key="path"]').inputValue()
      === 'C:/logs/picked.log');
  check('…and names it after the file, since nothing else has',
    await page.locator('.set-card[data-card="sources"]').last().locator('input[data-key="name"]').inputValue()
      === 'picked.log');
}

{
  // An empty row left behind by a mis-click must not become a source that can
  // never be read.
  await page.click('[data-add="sources"]');
  await page.waitForTimeout(100);
  await page.click('#settings-save');
  await page.waitForTimeout(200);
  const saved = await lastSave();
  check('a row with no path is dropped rather than saved',
    saved.sources.every(s => s.path.trim()), JSON.stringify(saved.sources.map(s => s.path)));
}

{
  await open('sources');
  const first = await page.locator('.set-card[data-card="sources"] input[data-key="path"]').first().inputValue();
  await page.locator('.set-card[data-card="sources"]').first().locator('[data-move][data-delta="1"]').click();
  await page.waitForTimeout(100);
  const moved = await page.locator('.set-card[data-card="sources"] input[data-key="path"]').nth(1).inputValue();
  check('sources can be reordered', moved === first, `${first} → ${moved}`);

  const count = await page.locator('.set-card[data-card="sources"]').count();
  await page.locator('.set-card[data-card="sources"]').first().locator('[data-remove]').click();
  await page.waitForTimeout(100);
  check('…and removed', await page.locator('.set-card[data-card="sources"]').count() === count - 1);
  check('…which takes the right one out',
    await page.locator('.set-card[data-card="sources"] input[data-key="path"]').first().inputValue() === first,
    'the card that moved down is now the first one');
}

// ---------------------------------------------------------------------------
// Highlights
// ---------------------------------------------------------------------------

{
  await open('highlights');
  check('the shipped rule is listed', await page.locator('.set-card[data-card="highlights"]').count() === 1);

  await page.click('[data-add="highlights"]');
  await page.waitForTimeout(100);
  const card = page.locator('.set-card[data-card="highlights"]').nth(1);
  await card.locator('input[data-key="name"]').fill('Timeouts');
  await card.locator('[data-flag="regex"]').click();
  await page.waitForTimeout(120);

  // The card is re-rendered on a flag change, so re-resolve it.
  const rule = page.locator('.set-card[data-card="highlights"]').nth(1);
  check('the regex toggle sticks', await rule.locator('[data-flag="regex"]').evaluate(el => el.classList.contains('on')));

  await rule.locator('input[data-key="pattern"]').fill(String.raw`\b(timed? ?out|deadline exceeded)\b`);
  await page.waitForTimeout(350);
  check('a pattern that compiles is not flagged',
    !(await page.locator('.set-card[data-card="highlights"]').nth(1).evaluate(el => el.classList.contains('invalid'))));
  check('…and it was the backend that was asked, not the browser',
    (await page.evaluate(() => window.__calls.filter(c => c[0] === 'checkPattern').length)) > 0);
}

{
  const rule = page.locator('.set-card[data-card="highlights"]').nth(1);
  await rule.locator('input[data-key="pattern"]').fill(String.raw`\b(timed? ?out\b`);
  await page.waitForTimeout(350);

  const card = page.locator('.set-card[data-card="highlights"]').nth(1);
  check('a regex that will not compile is flagged as you type',
    await card.evaluate(el => el.classList.contains('invalid')));
  check('…with the reason, rather than silently colouring nothing',
    (await card.locator('.set-error').textContent()).includes('unclosed group'));
}

{
  const rule = page.locator('.set-card[data-card="highlights"]').nth(1);
  await rule.locator('input[data-key="pattern"]').fill('timeout');
  await rule.locator('[data-flag="regex"]').click();
  await page.waitForTimeout(200);

  await page.locator('.set-card[data-card="highlights"]').nth(1)
    .locator('[data-pick-colour][data-colour="amber"]').click();
  await page.waitForTimeout(120);
  check('a colour is picked from the palette',
    await page.locator('.set-card[data-card="highlights"]').nth(1)
      .locator('[data-pick-colour][data-colour="amber"]').evaluate(el => el.classList.contains('on')));

  await page.click('#settings-save');
  await page.waitForTimeout(200);
  const saved = await lastSave();
  const added = saved.highlights[1];
  check('the new rule is saved whole',
    added.name === 'Timeouts' && added.pattern === 'timeout' && added.colour === 'amber' && added.enabled === true,
    JSON.stringify(added));
  check('…with an id of its own, so the view can key colour off it',
    !!added.id && added.id !== saved.highlights[0].id, JSON.stringify(added.id));
}

{
  // The sidebar is the reason to bother: a rule added here shows up there.
  check('the sidebar picks up the new rule',
    await page.locator('#highlight-list .highlight').count() === 2);
}

{
  await open('highlights');
  await page.locator('.set-card[data-card="highlights"]').first().locator('input[data-key="pattern"]').fill('');
  await page.click('#settings-save');
  await page.waitForTimeout(200);
  const saved = await lastSave();
  check('a rule with no pattern is dropped — it would match every line',
    saved.highlights.every(r => r.pattern.trim()), JSON.stringify(saved.highlights.map(r => r.pattern)));
}

// ---------------------------------------------------------------------------
// Saved filters
// ---------------------------------------------------------------------------

{
  await open('filters');
  await page.click('#set-capture');
  await page.waitForTimeout(200);

  const card = page.locator('.set-card[data-card="filters"]').first();
  check('the filter bar can be kept as a saved filter',
    await card.locator('input[data-key="query"]').inputValue() === 'timeout');
  check('…including the exclusion', await card.locator('input[data-key="exclude"]').inputValue() === '/health');
  check('…the level floor', await card.locator('select[data-key="minLevel"]').inputValue() === 'warn');
  check('…and how much of the log it was showing',
    await card.locator('select[data-key="sinceMins"]').inputValue() === '60');

  await page.click('#settings-save');
  await page.waitForTimeout(200);
  const saved = await lastSave();
  check('a saved filter reaches the config with its interval as a number',
    saved.filters[0].sinceMins === 60, JSON.stringify(saved.filters[0]));
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

{
  await open('display');
  await page.locator('input[data-path="wrap"]').check();
  await page.locator('input[data-path="fontSize"]').fill('16');
  await page.click('#settings-save');
  await page.waitForTimeout(200);

  const saved = await lastSettingsSave();
  check('a display preference reaches settings.json', saved.wrap === true, JSON.stringify(saved.wrap));
  check('…and a number arrives as a number, not as text', saved.fontSize === 16, typeof saved.fontSize);
  check('…and the log pane adopts it straight away',
    await page.evaluate(() => document.body.classList.contains('wrap')));
  check('…including the text size',
    (await page.evaluate(() => document.documentElement.style.getPropertyValue('--log-font-size'))).trim() === '16px');
}

// ---------------------------------------------------------------------------
// Advanced
// ---------------------------------------------------------------------------

{
  await open('advanced');
  const text = await page.locator('#set-raw').inputValue();
  check('the raw file is shown as it will be stored', text.includes('"sources"') && text.includes('"highlights"'));

  await page.locator('#set-raw').fill('{ "sources": [ }');
  await page.click('#settings-save');
  await page.waitForTimeout(200);
  check('invalid JSON is refused rather than written',
    (await page.locator('#settings-status').textContent()).includes("isn't valid JSON"));
  check('…and the file is left alone',
    (await lastSave()).sources !== undefined);

  await page.locator('#set-raw').fill('{ "sources": [{ "path": "C:/logs/hand.log", "name": "by hand" }], "filters": [], "highlights": [] }');
  await page.click('#settings-save');
  await page.waitForTimeout(200);
  const saved = await lastSave();
  check('valid JSON is saved as typed', saved.sources[0].name === 'by hand', JSON.stringify(saved.sources));

  await page.click('#set-reveal');
  await page.waitForTimeout(120);
  check('the file can still be opened in Explorer for anyone who wants it',
    (await page.evaluate(() => window.__calls.filter(c => c[0] === 'revealConfigFile').length)) === 1);
}

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

{
  await open('sources');
  await page.evaluate(() => { window.__saveConfigError = 'the file is read-only'; });
  await page.locator('.set-card[data-card="sources"]').first().locator('input[data-key="name"]').fill('changed');
  await page.click('#settings-save');
  await page.waitForTimeout(200);

  check('a save that fails says so', (await page.locator('#settings-status').textContent()).includes('read-only'));
  check('…and leaves Save available to try again',
    !(await page.locator('#settings-save').isDisabled()));
  await page.evaluate(() => { window.__saveConfigError = null; });
}

await browser.close();
await server.close();
process.exit(finish('log viewer settings'));
