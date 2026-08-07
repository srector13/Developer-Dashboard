// Log Viewer UI harness: loads renderer/index.html in Chromium with a stubbed
// logsApi and exercises the parts that are easy to get subtly wrong — the
// virtualiser's arithmetic, follow mode yielding to the reader, filter errors
// staying non-destructive, and log text going in as text.
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
const page = await browser.newPage({ viewport: { width: 1280, height: 700 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERROR:', m.text()); });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.addInitScript(() => {
  window.__calls = [];

  const line = (seq, source, text, level, timestamp, extra = {}) => ({
    line: {
      seq, source, text, level, timestamp,
      effectiveTimestamp: timestamp,
      continuation: false,
      ...extra,
    },
    highlight: extra.highlight ?? null,
  });

  // A base of 400 lines, so the virtualiser has to actually virtualise.
  window.__all = [];
  for (let i = 0; i < 400; i++) {
    window.__all.push(line(i, 'api', `line ${i}`, 'info', 1714565696000 + i * 1000));
  }
  window.__all.push(line(400, 'api', 'ERROR something exploded', 'error', 1714566096000, { highlight: 'error' }));
  window.__all.push(line(401, 'api', '\tat com.example.App.main(App.java:42)', 'unknown', null, { continuation: true }));
  window.__all.push(line(402, 'worker', '<img src=x onerror="window.__pwned=1">', 'info', 1714566097000));

  // Two applications, three files, one of which is not there — the shape the
  // sidebar has to cope with: grouping, an environment sub-heading, and a
  // source whose path does not resolve.
  window.__sources = [
    { id: 'api-0', name: 'api', path: 'C:/logs/api.log', enabled: true, colour: 'blue', lines: 402, pinned: true, app: 'Payments', env: 'prod', missing: false, seen: true },
    { id: 'worker-1', name: 'worker', path: 'C:/logs/worker.log', enabled: true, colour: 'teal', lines: 1, pinned: false, app: 'Payments', env: 'uat', missing: false, seen: true },
    { id: 'gateway-2', name: 'gateway', path: 'C:/logs/typo.log', enabled: true, colour: 'violet', lines: 0, pinned: true, app: 'Gateway', env: '', missing: true, seen: false },
  ];

  const viewFor = (filter) => {
    const query = (filter?.query || '').toLowerCase();
    const matched = query ? window.__all.filter(v => v.line.text.toLowerCase().includes(query)) : window.__all;
    return {
      lines: matched.slice(-2000),
      matched: matched.length,
      total: window.__all.length,
      truncated: false,
    };
  };

  window.logsApi = {
    context: async () => ({
      settings: {
        theme: 'dark', wrap: false, showTimestamps: true, showSource: true,
        showLevel: true, pollIntervalMs: 250, follow: true,
        capacity: 500000, window: 2000, fontSize: 12,
      },
      config: {
        sources: [],
        filters: [{ id: 'errors', name: 'Errors only', query: '', exclude: '', regex: false, caseSensitive: false, minLevel: 'error', sources: [], sinceMins: 15 }],
        highlights: [{ id: 'error', name: 'Errors', pattern: 'ERROR', regex: false, caseSensitive: true, colour: 'red', enabled: true }],
      },
      sources: window.__sources,
      filter: { query: '', exclude: '', regex: false, caseSensitive: false, minLevel: 'unknown', sources: [], sinceMins: 0 },
      version: '0.2.0',
      configError: null,
      siblings: [{ id: 'dev-hub', name: 'Dev Hub' }],
    }),
    listSources: async () => window.__sources,
    setFilter: async (filter) => {
      window.__calls.push(['setFilter', filter]);
      if (window.__filterError) throw window.__filterError;
      return viewFor(filter);
    },
    refresh: async () => viewFor({}),
    clear: async () => { window.__calls.push(['clear']); return { lines: [], matched: 0, total: 0, truncated: false }; },
    copyView: async () => 'copied text',
    writeClipboard: async (text) => { window.__calls.push(['clipboard', text]); },
    saveSettings: async (s) => { window.__calls.push(['saveSettings', s.follow]); return s; },
    saveConfig: async (c) => { window.__calls.push(['saveConfig']); return c; },
    setSourceEnabled: async (id, enabled) => {
      window.__calls.push(['setSourceEnabled', id, enabled]);
      window.__sources = window.__sources.map(s => (s.id === id ? { ...s, enabled } : s));
    },
    removeSource: async (id) => {
      window.__calls.push(['removeSource', id]);
      window.__sources = window.__sources.filter(s => s.id !== id);
    },
    pinSource: async (id) => { window.__calls.push(['pinSource', id]); },
    reloadSource: async (id) => { window.__calls.push(['reloadSource', id]); },
    revealSource: async (id) => { window.__calls.push(['revealSource', id]); },
    addSource: async (p) => { window.__calls.push(['addSource', p]); },
    pickFiles: async () => { window.__calls.push(['pickFiles']); return []; },
    revealConfigFile: async () => { window.__calls.push(['revealConfigFile']); },
    openSibling: async (id) => { window.__calls.push(['openSibling', id]); },
    browseFile: async () => { window.__calls.push(['browseFile']); return 'C:/logs/chosen.log'; },
    checkPattern: async (pattern, regex) => {
      window.__calls.push(['checkPattern', pattern, regex]);
      if (regex && /\($/.test(pattern)) throw 'unclosed group';
    },
    onLinesAppended: (cb) => { window.__appended = cb; },
    onSourcesChanged: (cb) => { window.__sourcesChanged = cb; },
    onConfigChanged: (cb) => { window.__configChanged = cb; },
    onFileDrop: (cb) => { window.__fileDrop = cb; },
    onFileDropHover: (cb) => { window.__fileDropHover = cb; },
    onFileDropCancel: (cb) => { window.__fileDropCancel = cb; },
  };
});

await page.goto(`${server.origin}/index.html`);
await page.waitForSelector('body[data-ready="true"]');

const rowCount = () => page.locator('#rows .row').count();
const rowTexts = () => page.locator('#rows .row .txt').allTextContents();
const settle = () => page.waitForTimeout(220);

// ---------------------------------------------------------------------------
// Virtualisation
// ---------------------------------------------------------------------------

{
  const rendered = await rowCount();
  check('only a window of rows is in the DOM, not all 403',
    rendered > 0 && rendered < 200, `rendered ${rendered}`);

  const sizerHeight = await page.locator('#sizer').evaluate(el => el.getBoundingClientRect().height);
  const scrollHeight = await page.locator('#scroller').evaluate(el => el.scrollHeight);
  check('the spacer gives the scrollbar the full result height',
    sizerHeight > 4000 && Math.abs(scrollHeight - sizerHeight) < 40,
    `sizer ${sizerHeight}, scrollHeight ${scrollHeight}`);
}

{
  // Follow is on at boot, so the newest line is the one on screen.
  const texts = await rowTexts();
  check('following starts at the bottom, showing the newest line',
    texts[texts.length - 1] === '<img src=x onerror="window.__pwned=1">',
    JSON.stringify(texts.slice(-1)));
}

{
  const pwned = await page.evaluate(() => window.__pwned);
  const html = await page.locator('#rows').innerHTML();
  check('a log line that looks like markup is rendered as text, not parsed',
    pwned === undefined && !html.includes('<img src=x'),
    `pwned=${pwned}`);
  check('…and its text is still shown verbatim',
    (await rowTexts()).includes('<img src=x onerror="window.__pwned=1">'));
}

// ---------------------------------------------------------------------------
// Scrolling and follow
// ---------------------------------------------------------------------------

{
  await page.locator('#scroller').evaluate(el => { el.scrollTop = 200; });
  await page.waitForTimeout(120);

  check('scrolling up turns following off', !(await page.locator('#follow').evaluate(el => el.classList.contains('on'))));
  check('…and offers a way back', await page.locator('#jump').isVisible());

  const top = await rowTexts();
  check('scrolling up shows older lines', top.some(t => /^line \d/.test(t)), JSON.stringify(top.slice(0, 2)));
}

{
  // A line arriving while the reader is scrolled up must not yank the viewport.
  const before = await page.locator('#scroller').evaluate(el => el.scrollTop);
  await page.evaluate(() => window.__appended({
    lines: [{ line: { seq: 500, source: 'api', text: 'arrived while reading', level: 'info', timestamp: 1714566099000, effectiveTimestamp: 1714566099000, continuation: false }, highlight: null }],
    matched: 404, total: 404,
  }));
  await page.waitForTimeout(120);
  const after = await page.locator('#scroller').evaluate(el => el.scrollTop);
  check('a new line does not scroll the view while following is off',
    Math.abs(after - before) < 4, `${before} → ${after}`);
  check('but the counts still update',
    (await page.locator('#counts').textContent()).includes('404'));
}

{
  await page.locator('#jump').click();
  await page.waitForTimeout(120);
  check('jump to newest turns following back on',
    await page.locator('#follow').evaluate(el => el.classList.contains('on')));
  const texts = await rowTexts();
  check('…and lands on the newest line',
    texts[texts.length - 1] === 'arrived while reading', JSON.stringify(texts.slice(-1)));
}

{
  await page.evaluate(() => window.__appended({
    lines: [{ line: { seq: 501, source: 'api', text: 'arrived while following', level: 'info', timestamp: 1714566100000, effectiveTimestamp: 1714566100000, continuation: false }, highlight: null }],
    matched: 405, total: 405,
  }));
  await page.waitForTimeout(120);
  const texts = await rowTexts();
  check('while following, a new line scrolls into view',
    texts[texts.length - 1] === 'arrived while following', JSON.stringify(texts.slice(-1)));
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

{
  const marked = page.locator('#rows .row[data-highlight="error"]').first();
  check('a highlighted line carries its rule', await marked.count() === 1);
  // The rule's own colour, not one CSS guessed from the id. A rule someone
  // creates has an id no stylesheet has ever heard of.
  check('…and the colour that rule was given, so a custom rule can be coloured',
    (await marked.getAttribute('data-highlight-colour')) === 'red',
    await marked.getAttribute('data-highlight-colour'));

  const continuation = await page.locator('#rows .row[data-continuation="true"]').count();
  check('a continuation line is marked so the trace reads as one thing',
    continuation === 1, `${continuation}`);
}

{
  // Scroll to where the error and its stack frame are.
  await page.evaluate(() => {
    const el = document.getElementById('scroller');
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(120);
  const stack = page.locator('#rows .row[data-continuation="true"]').first();
  check('the continuation line shows no timestamp of its own',
    (await stack.locator('.ts').textContent()) === '',
    'it inherits a position for ordering, but has no clock of its own');
}

{
  const src = await page.locator('#rows .row .src').last().textContent();
  check('each row names its source by display name', src === 'worker' || src === 'api', src);
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

{
  // "exploded" rather than "ERROR": the XSS-probe line contains the substring
  // `onerror`, so filtering on ERROR legitimately matches two lines and would
  // be testing the stub's matcher rather than the view.
  await page.fill('#query', 'exploded');
  await settle();
  const texts = await rowTexts();
  check('typing a filter narrows the view',
    texts.length === 1 && texts[0] === 'ERROR something exploded', JSON.stringify(texts));
  check('the counts say how many matched of how many there are',
    /1 of 40[0-9] lines/.test(await page.locator('#counts').textContent()),
    await page.locator('#counts').textContent());
}

{
  const calls = await page.evaluate(() => window.__calls.filter(c => c[0] === 'setFilter').length);
  await page.fill('#query', '');
  await page.type('#query', 'line 3');
  await settle();
  const after = await page.evaluate(() => window.__calls.filter(c => c[0] === 'setFilter').length);
  check('typing is debounced rather than querying per keystroke',
    after - calls <= 3, `${after - calls} calls for 8 keystrokes`);
}

{
  await page.click('#regex');
  await settle();
  const sent = await page.evaluate(() => window.__calls.filter(c => c[0] === 'setFilter').pop()[1]);
  check('the regex toggle reaches the backend', sent.regex === true);
  await page.click('#regex');
  await settle();
}

{
  await page.selectOption('#level', 'error');
  await settle();
  const sent = await page.evaluate(() => window.__calls.filter(c => c[0] === 'setFilter').pop()[1]);
  check('the level floor reaches the backend', sent.minLevel === 'error', JSON.stringify(sent));
  await page.selectOption('#level', 'unknown');
  await settle();
}

{
  // An invalid regex must not blank the window mid-typing.
  await page.fill('#query', 'line 1');
  await settle();
  const before = await rowCount();

  await page.evaluate(() => { window.__filterError = 'Filter: unclosed group'; });
  await page.fill('#query', 'line 1(');
  await settle();

  check('an invalid pattern shows an error', await page.locator('#filter-error').isVisible());
  check('…naming which box is wrong',
    (await page.locator('#filter-error').textContent()).includes('unclosed group'));
  check('…and marks that input', await page.locator('#query').evaluate(el => el.classList.contains('invalid')));
  check('…while the previous results stay on screen', await rowCount() === before,
    'blanking the view on every keystroke of a half-typed regex is unusable');

  await page.evaluate(() => { window.__filterError = null; });
  await page.fill('#query', '');
  await settle();
  check('a valid pattern clears the error', await page.locator('#filter-error').isHidden());
}

{
  await page.selectOption('#interval', '15');
  await settle();
  const sent = await page.evaluate(() => window.__calls.filter(c => c[0] === 'setFilter').pop()[1]);
  check('choosing an interval reaches the backend as minutes',
    sent.sinceMins === 15, JSON.stringify(sent));

  await page.selectOption('#interval', '0');
  await settle();
  const full = await page.evaluate(() => window.__calls.filter(c => c[0] === 'setFilter').pop()[1]);
  check('…and "Full log" asks for no interval at all', full.sinceMins === 0, JSON.stringify(full));
}

{
  await page.click('.saved-filter');
  await settle();
  const sent = await page.evaluate(() => window.__calls.filter(c => c[0] === 'setFilter').pop()[1]);
  check('a saved filter applies its whole spec', sent.minLevel === 'error', JSON.stringify(sent));
  check('…including how much of the log it wanted', sent.sinceMins === 15, JSON.stringify(sent));
  check('…and the filter bar shows what was applied',
    await page.locator('#interval').inputValue() === '15');
  await page.selectOption('#level', 'unknown');
  await page.selectOption('#interval', '0');
  await settle();
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

{
  check('every source is listed', await page.locator('#source-list .source').count() === 3);
  check('a source shows its line count',
    (await page.locator('#source-list .source .count').first().textContent()).includes('402'));
  check('a source names its file in a tooltip',
    (await page.locator('#source-list .source .name').first().getAttribute('title')) === 'C:/logs/api.log');
}

// ---------------------------------------------------------------------------
// Grouping, and files that are not there
// ---------------------------------------------------------------------------

{
  const apps = await page.locator('#source-list .source-group > h3').allTextContents();
  check('sources are grouped by application', JSON.stringify(apps) === JSON.stringify(['Payments', 'Gateway']),
    JSON.stringify(apps));

  const envs = await page.locator('#source-list .source-group h4').allTextContents();
  check('…and by environment within it', JSON.stringify(envs) === JSON.stringify(['prod', 'uat']),
    JSON.stringify(envs));

  const gateway = page.locator('#source-list .source').nth(2);
  check('a source with no environment needs no sub-heading — it is still listed',
    (await gateway.locator('.name').textContent()) === 'gateway');
}

{
  // The bug this whole pass started from: a file that cannot be read looked
  // exactly like a file with nothing in it.
  const trouble = page.locator('#source-list .source[data-trouble="true"]');
  check('a file that cannot be read is called out', await trouble.count() === 1);
  check('…and says which of the two problems it is',
    (await trouble.locator('.trouble').textContent()) === 'not found');
  check('…with the path and what to do about it on hover',
    (await trouble.locator('.trouble').getAttribute('title')).includes('C:/logs/typo.log'));
  check('…and the healthy sources are not marked',
    await page.locator('#source-list .source:not([data-trouble="true"])').count() === 2);
}

{
  await page.locator('#source-list .source').first().hover();
  await page.locator('#source-list .source').first().locator('.row-action').first().click();
  await page.waitForTimeout(120);
  const call = await page.evaluate(() => window.__calls.filter(c => c[0] === 'setSourceEnabled').pop());
  check('the eye toggles a source off', call && call[1] === 'api-0' && call[2] === false, JSON.stringify(call));
  check('…and the row is dimmed rather than removed',
    await page.locator('#source-list .source[data-off="true"]').count() === 1);
}

{
  // A pinned source offers no pin button; an unpinned one does.
  const pinnedActions = await page.locator('#source-list .source').first().locator('.row-action').count();
  const sessionActions = await page.locator('#source-list .source').nth(1).locator('.row-action').count();
  check('only an unpinned source offers to be kept in the config',
    sessionActions === pinnedActions + 1, `${pinnedActions} vs ${sessionActions}`);
}

{
  await page.locator('#source-list .source').nth(1).hover();
  await page.locator('#source-list .source').nth(1).locator('.row-action').last().click();
  await page.waitForTimeout(200);
  check('the bin closes a source', await page.locator('#source-list .source').count() === 2);
}

// ---------------------------------------------------------------------------
// Toolbar and keyboard
// ---------------------------------------------------------------------------

{
  await page.keyboard.press('Control+f');
  check('Ctrl+F focuses the filter box',
    await page.evaluate(() => document.activeElement.id) === 'query');
  await page.keyboard.press('Escape');
  check('Escape leaves it', await page.evaluate(() => document.activeElement.id) !== 'query');
}

{
  await page.keyboard.press('f');
  await page.waitForTimeout(80);
  check('f toggles following when not typing',
    !(await page.locator('#follow').evaluate(el => el.classList.contains('on'))));
  await page.keyboard.press('f');
  await page.waitForTimeout(80);
}

{
  await page.fill('#query', '');
  await page.locator('#query').focus();
  await page.keyboard.type('f');
  check('…but f typed into the filter box is just an f',
    await page.locator('#query').inputValue() === 'f');
  await page.fill('#query', '');
  await page.locator('#query').blur();
  await settle();
}

{
  await page.click('#copy');
  await page.waitForTimeout(150);
  const call = await page.evaluate(() => window.__calls.filter(c => c[0] === 'clipboard').pop());
  check('Copy view puts the shown lines on the clipboard', call && call[1] === 'copied text');
  check('…and says so', (await page.locator('#copy').textContent()) === 'Copied');
}

{
  await page.click('#clear');
  await page.waitForTimeout(200);
  check('Clear empties the view', await rowCount() === 0);
  check('…and says there is nothing to show', await page.locator('#log-empty').isVisible());
}

// ---------------------------------------------------------------------------
// Dropping a file
// ---------------------------------------------------------------------------

{
  await page.evaluate(() => window.__fileDropHover(true));
  check('dragging a file over the window offers to open it',
    await page.locator('#drop-hint').isVisible());

  await page.evaluate(() => window.__fileDrop(['C:/logs/dropped.log']));
  await page.waitForTimeout(200);
  check('…and dropping it opens that path',
    (await page.evaluate(() => window.__calls.filter(c => c[0] === 'addSource').pop()))[1] === 'C:/logs/dropped.log');
  check('…and the hint goes away', await page.locator('#drop-hint').isHidden());
}

// ---------------------------------------------------------------------------
// The config changing underneath the window
// ---------------------------------------------------------------------------

{
  // Editing logs.config.json used to do nothing until the next launch, which is
  // most of why "I added a log and see nothing" happened at all.
  await page.evaluate(() => {
    window.__sources = [
      ...window.__sources,
      { id: 'added-by-hand', name: 'edited in', path: 'C:/logs/new.log', enabled: true, colour: 'green', lines: 7, pinned: true, app: 'Payments', env: 'prod', missing: false, seen: true },
    ];
  });
  const before = await page.locator('#source-list .source').count();
  await page.evaluate(() => window.__configChanged());
  await page.waitForTimeout(250);
  check('a config edited on disk shows up without a restart',
    await page.locator('#source-list .source').count() === before + 1);
}

// ---------------------------------------------------------------------------
// Loaded with no backend behind it
// ---------------------------------------------------------------------------

{
  // The failure this replaces was silent: the window sat there saying "No lines
  // yet", which is also what it says when everything works and the log is quiet.
  const bare = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await bare.goto(`${server.origin}/index.html`);
  await bare.waitForSelector('body[data-ready="no-bridge"]');
  check('a window with no backend says so rather than looking empty',
    await bare.locator('#no-bridge').isVisible());
  check('…and does not pretend the log is simply quiet',
    await bare.locator('#no-bridge').evaluate((el) => {
      const box = el.getBoundingClientRect();
      return box.width >= window.innerWidth && box.height >= window.innerHeight;
    }));
  await bare.close();
}

await browser.close();
await server.close();
process.exit(finish('log viewer'));
