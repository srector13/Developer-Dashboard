// Renders build/icon.svg to build/icon.png at 1024x1024 using the Playwright
// Chromium already required by the e2e tests. Run: node scripts/render-icon.mjs
// (In CI containers pass the preinstalled browser via CHROMIUM_PATH.)
import { createRequire } from 'module';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = path.join(ROOT, 'build', 'icon.svg');
const pngPath = path.join(ROOT, 'build', 'icon.png');

const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({
  viewport: { width: 1024, height: 1024 },
  deviceScaleFactor: 1,
});

const svg = fs.readFileSync(svgPath, 'utf8');
await page.setContent(
  `<!doctype html><body style="margin:0;background:transparent">${svg}</body>`,
);
await page.waitForTimeout(200);
await page.screenshot({ path: pngPath, omitBackground: true });
await browser.close();
console.log(`Rendered ${pngPath}`);
