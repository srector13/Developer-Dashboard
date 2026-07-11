# Renderer Test Harness

Fast, display-server-free checks of the renderer (`renderer/index.html` + `app.js` + `style.css`) in plain Chromium with a stubbed `window.api` (the surface normally provided by `src/preload.ts`). These complement the Electron-driven Playwright suite in `tests/e2e` — they run anywhere Chromium runs, including containers where the Electron binary can't be downloaded.

## Suites

- **`smoke.spec.mjs`** — 130 functional assertions per platform: theme system, tab/enter editor behavior, diagram builder (all types), PDF export dialog flow, platform-aware shortcuts, shortcuts modal, templates, page info, backlinks, landing dashboards, palette escaping, and more.

  ```bash
  npm run test:renderer            # darwin + win32 back to back
  SMOKE_PLATFORM=win32 node tests/renderer/smoke.spec.mjs
  ```

- **`ui-audit.mjs`** — captures ~46 screenshots across all six themes and every modal, plus programmatic WCAG contrast probes (composited against real stacked backgrounds). Output goes to `tests/renderer/ui-audit-output/` (gitignored) including `contrast.json`.

  ```bash
  npm run test:ui-audit
  ```

## Environment

- If Playwright can't locate its own Chromium build (version-pinned browsers), point `CHROMIUM_PATH` at any Chromium/Chrome binary:
  `CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:renderer`
- Keep the stubbed `window.api` in these files in sync with `src/preload.ts` when the IPC surface changes — a missing stub method fails loudly at the first call.

## When the preload API changes

Update the stub in both files (search for `window.api = {`). The stubs intentionally return canned data shaped exactly like the main process's real responses; drift between stub shape and real shape is the main way these tests can lie to you.
