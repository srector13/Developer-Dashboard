// Launcher UI harness: loads renderer/launcher.html in Chromium with a stubbed
// launcherApi and exercises orb cycling, per-mode filtering, the keyboard model
// and the action menu.
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
const page = await browser.newPage({ viewport: { width: 804, height: 560 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERROR:', m.text()); });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.addInitScript(() => {
  window.__calls = [];
  window.__items = [
    {
      id: 'C:/dev/payments-api', provider: 'projects', title: 'payments-api',
      subtitle: 'C:/dev/payments-api · 2h ago', icon: 'git', status: 'warn',
      badges: ['main', 'dirty', '↑3'], keywords: [],
      actions: [
        { kind: 'run', label: 'IntelliJ', program: 'idea64.exe', args: [], capture: false },
        { kind: 'openPath', label: 'Open folder', path: 'C:/dev/payments-api' },
        { kind: 'openUrl', label: 'Open remote', url: 'https://github.com/o/payments-api' },
      ],
    },
    {
      id: '0:Jenkins', provider: 'launch', title: 'Jenkins',
      subtitle: 'https://jenkins.example.com', icon: 'web', status: 'neutral',
      badges: [], keywords: ['ci'],
      actions: [{ kind: 'openUrl', label: 'Open', url: 'https://jenkins.example.com' }],
    },
  ];
  window.launcherApi = {
    context: async () => ({ theme: 'dark', version: '0.1.0', providers: ['projects', 'launch'] }),
    search: async (query, provider, maxResults) => {
      window.__calls.push(['search', query, provider, maxResults]);
      if (window.__searchDelayMs) await new Promise(r => setTimeout(r, window.__searchDelayMs));
      const rows = provider ? window.__items.filter(i => i.provider === provider) : window.__items;
      return query ? rows.filter(i => i.title.toLowerCase().includes(query.toLowerCase())) : rows;
    },
    run: async (itemId, actionIndex) => {
      window.__calls.push(['run', itemId, actionIndex]);
      return window.__runResult || { success: true };
    },
    refresh: async (provider) => {
      window.__calls.push(['refresh', provider]);
      return {
        provider, displayName: 'Health', refreshedAt: 1, error: null,
        items: [{
          id: 'http://localhost:8080/health', provider: 'health', title: 'API — local',
          subtitle: '200 · 12ms', status: 'ok', badges: ['200'], actions: [],
        }],
      };
    },
    resize: (h) => { window.__lastResize = h; },
    hide: () => window.__calls.push(['hide']),
    onReset: (cb) => { window.__resetCb = cb; },
  };
});

await page.goto(`${server.origin}/launcher.html`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(300);

// --- Orbs -----------------------------------------------------------------

check('five mode orbs render', await page.evaluate(() => document.querySelectorAll('#orbs .orb').length === 5));
check('the All orb is active by default', await page.evaluate(() =>
  document.querySelectorAll('.orb')[0].classList.contains('active') &&
  document.getElementById('q').placeholder.toLowerCase().includes('search everything')));

check('an empty query still lists cached items, ranked', await page.evaluate(() =>
  document.querySelectorAll('#results .result').length === 2));

// --- Mode switching -------------------------------------------------------

await page.fill('#q', 'jenk');
await page.waitForTimeout(220);
check('typing searches with no provider filter in All mode', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'search' && c[1] === 'jenk' && c[2] === null)));

await page.keyboard.press('Tab');
await page.waitForTimeout(220);
check('Tab moves to the Projects orb', await page.evaluate(() =>
  document.querySelectorAll('.orb')[1].classList.contains('active')));
check('switching modes clears the query so it cannot leak', await page.evaluate(() =>
  document.getElementById('q').value === ''));
check('Projects mode filters to the projects provider', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'search' && c[2] === 'projects')));

await page.keyboard.press('Shift+Tab');
await page.waitForTimeout(120);
check('Shift+Tab moves back', await page.evaluate(() =>
  document.querySelectorAll('.orb')[0].classList.contains('active')));

await page.keyboard.press('Control+3');
await page.waitForTimeout(220);
check('Ctrl+3 jumps straight to the Launch orb', await page.evaluate(() =>
  document.querySelectorAll('.orb')[2].classList.contains('active') &&
  window.__calls.some(c => c[0] === 'search' && c[2] === 'launch')));

await page.keyboard.press('Control+1');
await page.waitForTimeout(220);

// --- Results and the keyboard model ---------------------------------------

check('rows render a status dot, badges and a subtitle', await page.evaluate(() => {
  const row = document.querySelector('#results .result');
  return !!row.querySelector('.r-dot.warn')
    && row.querySelectorAll('.r-badge').length === 3
    && row.querySelector('.r-sub').textContent.includes('payments-api');
}));

check('the first result is selected', await page.evaluate(() =>
  document.querySelectorAll('#results .result')[0].classList.contains('sel')));

await page.keyboard.press('ArrowDown');
check('ArrowDown moves the selection', await page.evaluate(() =>
  document.querySelectorAll('#results .result')[1].classList.contains('sel')));

await page.keyboard.press('ArrowUp');
await page.keyboard.press('Enter');
await page.waitForTimeout(120);
check('Enter runs action 0 with the provider-namespaced key', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'run' && c[1] === 'projects::C:/dev/payments-api' && c[2] === 0)));
check('a successful action hides the launcher', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'hide')));

// --- Action menu ----------------------------------------------------------

await page.keyboard.press('Control+Enter');
await page.waitForTimeout(120);
check('Ctrl+Enter opens the action menu for the selected item', await page.evaluate(() =>
  document.querySelectorAll('#results .result').length === 3 &&
  document.querySelector('#results .result .r-title').textContent === 'IntelliJ'));

await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
await page.waitForTimeout(120);
check('Enter in the menu runs the chosen action index', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'run' && c[2] === 2)));

await page.keyboard.press('Control+Enter');
await page.waitForTimeout(120);
await page.keyboard.press('Escape');
await page.waitForTimeout(120);
check('Esc leaves the action menu instead of closing the window', await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#results .result .r-title')].map(e => e.textContent);
  return rows.includes('payments-api');
}));

// --- Failure feedback -----------------------------------------------------

await page.evaluate(() => { window.__runResult = { success: false, message: 'IntelliJ — could not run idea64.exe' }; });
await page.keyboard.press('Enter');
await page.waitForTimeout(120);
check('a failed action shows the reason and keeps the launcher open', await page.evaluate(() =>
  document.getElementById('status').textContent.includes('could not run')));
await page.evaluate(() => { window.__runResult = { success: true }; });

// --- Health mode ----------------------------------------------------------

await page.keyboard.press('Control+5');
await page.waitForTimeout(150);
check('the Health orb hides the text field', await page.evaluate(() =>
  document.getElementById('q').style.display === 'none'));
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
check('Enter re-checks every endpoint and renders the result inline', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'refresh' && c[1] === 'health') &&
  document.querySelector('#results .result .r-title').textContent === 'API — local'));

// --- Window sizing and reset ----------------------------------------------

check('the window is resized to fit its content', await page.evaluate(() =>
  typeof window.__lastResize === 'number' && window.__lastResize > 180));

await page.evaluate(() => window.__resetCb && window.__resetCb());
await page.waitForTimeout(200);
check('launcher-reset returns to the All orb with an empty query', await page.evaluate(() =>
  document.querySelectorAll('.orb')[0].classList.contains('active') &&
  document.getElementById('q').value === '' &&
  document.getElementById('status').textContent === ''));

// --- Guards ---------------------------------------------------------------

check('no emoji glyphs anywhere in the chrome (SVG icons only)', await page.evaluate(() => {
  const text = document.getElementById('orbs').textContent + document.getElementById('mode-glyph').textContent;
  return !/[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u.test(text);
}));
check('the mode glyph renders an SVG, not text', await page.evaluate(() =>
  !!document.querySelector('#mode-glyph svg') && document.getElementById('mode-glyph').textContent.trim() === ''));

// A slow in-flight search must not overwrite the results of a newer one.
await page.evaluate(() => { window.__searchDelayMs = 400; });
await page.fill('#q', 'payments');
await page.waitForTimeout(140);
await page.evaluate(() => { window.__searchDelayMs = 0; });
await page.fill('#q', 'jenkins');
await page.waitForTimeout(700);
check('a stale search result cannot overwrite a newer one', await page.evaluate(() => {
  const titles = [...document.querySelectorAll('#results .r-title')].map(e => e.textContent);
  return titles.length === 1 && titles[0] === 'Jenkins';
}), await page.evaluate(() => [...document.querySelectorAll('#results .r-title')].map(e => e.textContent).join(',')));

await browser.close();
await server.close();
process.exit(finish('launcher') === 0 ? 0 : 1);
