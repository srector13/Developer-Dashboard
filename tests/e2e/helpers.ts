import { _electron as electron, test as base, ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_ENTRY = path.join(PROJECT_ROOT, 'out', 'main.js');

export interface LaunchOptions {
  /** Seed a temporary notebook folder + settings so the app boots past onboarding. */
  seedNotebook?: boolean;
}

export interface LaunchResult {
  app: ElectronApplication;
  page: Page;
  /** Electron userData dir (holds settings.json) — unique per launch. */
  userDataDir: string;
  /** The notebook root folder on disk (populated when seedNotebook is set). */
  notebookDir: string;
}

/** Create a sample notebook tree on disk so tree/landing/note flows have content. */
export function seedNotebook(dir: string): void {
  fs.mkdirSync(path.join(dir, 'Projects'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Journal'), { recursive: true });

  fs.writeFileSync(
    path.join(dir, 'welcome.md'),
    [
      '---',
      'title: Welcome',
      'created: 2026-07-01',
      'tags: [intro, guide]',
      '---',
      '',
      '# Welcome',
      '',
      'This is a **seeded** note used by the E2E tests.',
      '',
      '- [ ] An open task',
      '- [x] A completed task',
      '',
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(dir, 'Projects', 'alpha.md'),
    [
      '---',
      'title: Alpha Project',
      'created: 2026-07-02',
      'tags: [project]',
      '---',
      '',
      '# Alpha Project',
      '',
      'Planning notes for the Alpha project.',
      '',
      '- [ ] Draft spec',
      '- [ ] Review with team',
      '',
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(dir, 'Journal', '2026-07-05.md'),
    [
      '---',
      'title: 2026-07-05',
      'created: 2026-07-05',
      'tags: [daily]',
      '---',
      '',
      '# 2026-07-05',
      '',
      'A daily journal entry.',
      '',
    ].join('\n'),
  );
}

async function launch(opts: LaunchOptions): Promise<LaunchResult> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdnb-userdata-'));
  const notebookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdnb-notebook-'));

  if (opts.seedNotebook) {
    seedNotebook(notebookDir);
    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({ notebookRoot: notebookDir }, null, 2),
      'utf8',
    );
  }

  const app = await electron.launch({
    args: [
      MAIN_ENTRY,
      // Required for Electron under xvfb / root in CI containers.
      '--no-sandbox',
      '--disable-gpu',
      // Redirect Chromium userData so tests never touch a real profile.
      `--user-data-dir=${userDataDir}`,
    ],
    cwd: PROJECT_ROOT,
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, userDataDir, notebookDir };
}

/**
 * Test fixture exposing a `launchApp(opts)` factory. Every app launched through
 * it is closed automatically at the end of the test.
 */
export const test = base.extend<{
  launchApp: (opts?: LaunchOptions) => Promise<LaunchResult>;
}>({
  launchApp: async ({}, use) => {
    const launched: LaunchResult[] = [];
    await use(async (opts: LaunchOptions = {}) => {
      const result = await launch(opts);
      launched.push(result);
      return result;
    });
    for (const { app, userDataDir, notebookDir } of launched) {
      await app.close().catch(() => {});
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(notebookDir, { recursive: true, force: true });
    }
  },
});

export const expect = test.expect;
