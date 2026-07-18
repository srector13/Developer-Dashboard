// Launcher UI harness: loads renderer/launcher.html in Chromium with a stubbed
// launcherApi and exercises orb cycling, per-tool behavior, search, and the
// keyboard model. Mirrors the smoke harness approach.
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

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 760, height: 560 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERROR:', m.text()); });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.addInitScript(() => {
  window.__calls = [];
  window.__searchRows = [
    { fsPath: '/nb/alpha.md', relPath: 'alpha.md', title: 'Alpha Note', snippet: '' },
    { fsPath: '/nb/beta.md', relPath: 'Projects/beta.md', title: 'Beta Plan', snippet: 'the beta line' },
  ];
  window.launcherApi = {
    context: async () => ({ theme: 'dark', hasNotebook: true }),
    search: async (q) => { window.__calls.push(['search', q]); return window.__searchRows; },
    openNote: (fsPath) => window.__calls.push(['openNote', fsPath]),
    openDaily: async () => { window.__calls.push(['openDaily']); return { success: true }; },
    capture: async (text) => { window.__calls.push(['capture', text]); return window.__captureResult || { success: true }; },
    captureTask: async (text) => { window.__calls.push(['captureTask', text]); return { success: true }; },
    screenshot: async () => { window.__calls.push(['screenshot']); return { success: true }; },
    openScratchpad: async () => { window.__calls.push(['openScratchpad']); return { success: true }; },
    resize: (h) => { window.__lastResize = h; },
    hide: () => window.__calls.push(['hide']),
    onReset: (cb) => { window.__resetCb = cb; },
  };
});

await page.goto('file://' + path.join(ROOT, 'renderer', 'launcher.html'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(300);

// --- Orbs render, Search is default ---
check('six tool orbs render', await page.evaluate(() => document.querySelectorAll('#orbs .orb').length === 6));
check('search orb active by default', await page.evaluate(() =>
  document.querySelectorAll('.orb')[0].classList.contains('active') &&
  document.getElementById('q').placeholder.toLowerCase().includes('search')));

// --- Typing searches, results render ---
await page.click('#q');
await page.type('#q', 'beta');
await page.waitForTimeout(220);
check('typing triggers a search call', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'search' && c[1] === 'beta')));
check('search results render', await page.evaluate(() =>
  document.querySelectorAll('#results .result').length === 2 &&
  document.querySelector('#results .result .r-title').textContent === 'Alpha Note'));
check('first result selected', await page.evaluate(() =>
  document.querySelectorAll('#results .result')[0].classList.contains('sel')));

// --- Arrow moves selection, Enter opens the selected note ---
await page.keyboard.press('ArrowDown');
check('ArrowDown moves selection to 2nd', await page.evaluate(() =>
  document.querySelectorAll('#results .result')[1].classList.contains('sel')));
await page.keyboard.press('Enter');
check('Enter opens the selected note', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'openNote' && c[1] === '/nb/beta.md')));

// --- Tab cycles to Note tool ---
await page.keyboard.press('Tab');
check('Tab activates the Note tool', await page.evaluate(() =>
  document.querySelectorAll('.orb')[1].classList.contains('active') &&
  document.getElementById('q').placeholder.toLowerCase().includes('note')));

// Note capture: type + Enter files and hides
await page.type('#q', 'remember the milk');
await page.keyboard.press('Enter');
await page.waitForTimeout(100);
check('Note tool Enter files a quick capture', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'capture' && c[1] === 'remember the milk')));
check('successful capture hides the launcher', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'hide')));

// --- Cmd/Ctrl+3 jumps to Task tool ---
await page.keyboard.press('Control+3');
check('Ctrl+3 jumps to the Task tool', await page.evaluate(() =>
  document.querySelectorAll('.orb')[2].classList.contains('active')));
await page.type('#q', 'call the dentist');
await page.keyboard.press('Enter');
await page.waitForTimeout(100);
check('Task tool files a task', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'captureTask' && c[1] === 'call the dentist')));

// --- Daily (action tool): input hidden, Enter opens daily ---
await page.keyboard.press('Control+4');
check('Daily tool hides the text input', await page.evaluate(() =>
  document.getElementById('q').style.display === 'none'));
await page.keyboard.press('Enter');
await page.waitForTimeout(80);
check('Daily tool Enter opens the daily note', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'openDaily')));

// --- Screenshot (action): Enter fires capture + hides ---
await page.keyboard.press('Control+5');
await page.keyboard.press('Enter');
await page.waitForTimeout(80);
check('Screenshot tool Enter starts capture and hides', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'screenshot') && window.__calls.filter(c => c[0] === 'hide').length >= 2));

// --- Scratchpad (action): Enter opens scratchpad ---
await page.keyboard.press('Control+6');
await page.keyboard.press('Enter');
await page.waitForTimeout(80);
check('Scratchpad tool Enter opens the scratchpad', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'openScratchpad')));

// --- Clicking an orb activates it ---
await page.click('.orb[data-idx="0"]');
check('clicking the Search orb re-activates it', await page.evaluate(() =>
  document.querySelectorAll('.orb')[0].classList.contains('active')));

// --- Escape hides ---
await page.keyboard.press('Escape');
check('Escape hides the launcher', await page.evaluate(() =>
  window.__calls.some(c => c[0] === 'hide')));

// --- Reset callback returns to Search + clears input ---
await page.evaluate(() => { document.getElementById('q').value = 'stale'; window.__resetCb && window.__resetCb(); });
check('reset returns to Search tool with a cleared field', await page.evaluate(() =>
  document.querySelectorAll('.orb')[0].classList.contains('active') && document.getElementById('q').value === ''));

// --- Failed capture keeps the launcher open and shows status ---
await page.keyboard.press('Tab'); // to Note
await page.evaluate(() => { window.__captureResult = { success: false, reason: 'No notebook folder is set.' }; });
await page.type('#q', 'orphan note');
await page.keyboard.press('Enter');
await page.waitForTimeout(120);
check('failed capture surfaces the reason and does not clear', await page.evaluate(() =>
  document.getElementById('status').textContent.includes('No notebook folder') &&
  document.getElementById('q').value === 'orphan note'));

await browser.close();
console.log(`\n${failed === 0 ? 'ALL' : failed + '/' + (passed + failed)} ${passed + failed} LAUNCHER CHECKS ${failed === 0 ? 'PASSED' : 'FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
