# End-to-end GUI tests (Playwright + Electron)

These tests launch the **real compiled Electron app** and drive its renderer the
way a user would — clicking the sidebar, opening notes, switching view modes,
toggling the theme, and creating pages. They use
[Playwright's Electron support](https://playwright.dev/docs/api/class-electron)
(`_electron.launch`), not a mocked browser page.

> Note: this project is an Electron **desktop** app, so mobile UI frameworks
> like Maestro (Android/iOS) don't apply. Playwright is the tool that can
> actually drive an Electron window.

## Running

```bash
# macOS / Windows (a display is already available)
npm run test:e2e

# Headless Linux / CI (Electron needs an X server)
xvfb-run -a npm run test:e2e
```

`npm run test:e2e` runs `tsc` first (via `pretest:e2e`) so `out/main.js` is up to
date, then runs `playwright test`.

Useful variants:

```bash
npx playwright test -g "settings modal"   # run tests matching a title
npx playwright show-report                # open the last HTML report
```

## What's covered

| Spec | Flows |
|------|-------|
| `app.spec.ts` | window title, onboarding overlay, core layout, theme toggle, command palette (⌘/Ctrl+K), settings modal |
| `notebook.spec.ts` | tree rendering, opening a note + rendered preview, preview/edit/split modes, sidebar search filtering, dashboard task metrics, creating a page |

## How it works

`helpers.ts` provides a `launchApp({ seedNotebook })` fixture that:

- launches Electron with a throwaway `--user-data-dir` (so tests never touch a
  real profile), and
- when `seedNotebook` is set, writes a temporary notebook folder of sample
  `.md` files and points `settings.json` at it, so the app boots straight past
  onboarding into a populated notebook.

Every launched app is closed and its temp dirs are removed automatically at the
end of each test.

## Notes

- Launch args include `--no-sandbox --disable-gpu`, required to run Electron
  headless (under xvfb, as root, in containers).
- Icon-only buttons have their `title` moved to a `data-tooltip` attribute at
  runtime by the app's custom-tooltip system, so tests target
  `[data-tooltip="…"]` rather than `getByTitle`/accessible name.
- On networks where Electron's default binary download (GitHub releases) is
  blocked, install with a mirror, e.g.
  `ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/" npm install`.
