import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for the Markdown Notebook Electron app.
 *
 * These are end-to-end GUI tests: each test launches the real compiled
 * Electron application (out/main.js) through Playwright's Electron driver
 * and drives the renderer the way a user would.
 *
 * On headless Linux (CI, containers) Electron needs a display server, so run
 * the suite under xvfb:  `xvfb-run -a npm run test:e2e`.
 * On macOS / Windows a display is already present, so `npm run test:e2e` works
 * directly.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // Each spec spins up its own Electron process; keep them from racing for the
  // (single, shared) X display and GPU.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
});
