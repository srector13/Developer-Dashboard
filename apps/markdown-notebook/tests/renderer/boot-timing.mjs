// Measure renderer boot: navigation start -> first paint -> load, with the
// current synchronous mermaid tag. Run before and after the perf changes.
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('@playwright/test');

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  // minimal api stub so app.js init doesn't throw
  window.api = {
    platform: 'darwin',
    getSettings: async () => ({ notebookRoot: '', defaultPageWidth: 'standard', defaultMermaidZoom: 100, theme: 'dark', ignoreFolders: [], templatesFolder: 'templates', author: '', scratchpadFile: 's.md', autoSaveEnabled: false, pdfExport: {}, ai: { enabled: false }, spellcheckEnabled: true }),
    getNotebookTree: async () => null,
    onFilesChanged: () => () => {}, onOpenNote: () => {}, onCaptureShortcutFailed: () => {},
    listTemplates: async () => [], searchNotes: async () => [], getBacklinks: async () => [],
    renderMarkdown: (t) => '<p></p>', getAppVersion: async () => '0', readNote: async () => '',
    saveSettings: async (s) => s,
  };
});
const runs = [];
for (let i = 0; i < 5; i++) {
  const t0 = Date.now();
  await page.goto('file://' + path.join(ROOT, 'renderer', 'index.html'), { waitUntil: 'load' });
  const nav = await page.evaluate(() => {
    const [e] = performance.getEntriesByType('navigation');
    const paint = performance.getEntriesByType('paint').find(p => p.name === 'first-contentful-paint');
    return {
      domContentLoaded: Math.round(e.domContentLoadedEventEnd),
      load: Math.round(e.loadEventEnd),
      fcp: paint ? Math.round(paint.startTime) : -1,
      mermaidLoaded: typeof window.mermaid !== 'undefined',
    };
  });
  runs.push(nav);
  await page.goto('about:blank');
}
console.log(JSON.stringify(runs, null, 1));
await browser.close();
