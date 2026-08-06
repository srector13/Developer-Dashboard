# Renderer Test Harness

Fast, display-server-free checks of the shared UI (`renderer/index.html` +
`app.js` + `style.css` + `markdown.js`) in plain Chromium with a stubbed
`window.api` — the surface the Rust backend provides at runtime via
`renderer/api-tauri.js`. They run anywhere Chromium runs, including Linux
containers, so the UI stays covered without a Windows machine.

## Suites

- **`markdown.spec.mjs`** — the markdown pipeline in isolation: frontmatter and
  H1 stripping, `==mark==`, `[[wiki-links]]`, task checkboxes with line numbers,
  mermaid fences, image resolution/width/figcaption, external link targets, and
  syntax highlighting (including the dart and scala grammars loaded separately
  from highlight.js's common bundle).

  ```bash
  node tests/renderer/markdown.spec.mjs
  ```

- **`smoke.spec.mjs`** — 333 functional assertions per platform: theme system,
  tab/enter editor behavior, diagram builder (all types), PDF export dialog
  flow, platform-aware shortcuts, shortcuts modal, templates, page info,
  backlinks, landing dashboards, palette escaping, and more.

  ```bash
  npm run test:renderer            # markdown + darwin + win32 + launcher
  SMOKE_PLATFORM=win32 node tests/renderer/smoke.spec.mjs
  ```

  The shipped app is Windows-only, so `win32` is the configuration that matters;
  the `darwin` run is kept because `app.js` still carries both keybinding
  branches and the assertion pair catches accidental divergence.

- **`launcher.spec.mjs`** — 24 checks over the Golden-Gate launcher window: orb
  cycling, per-tool behavior, search results, and the keyboard model.

- **`ui-audit.mjs`** — captures ~46 screenshots across all six themes and every
  modal, plus programmatic WCAG contrast probes (composited against real stacked
  backgrounds). Output goes to `tests/renderer/ui-audit-output/` (gitignored)
  including `contrast.json`.

  ```bash
  npm run test:ui-audit
  ```

## Environment

- If Playwright can't locate its own Chromium build (version-pinned browsers),
  point `CHROMIUM_PATH` at any Chromium/Chrome binary:
  `CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:renderer`

## When the backend API changes

The stubs live in `smoke.spec.mjs` and `launcher.spec.mjs` (search for
`window.api = {`). Keep them in sync with `renderer/api-tauri.js` and the
`#[tauri::command]` signatures in `src-tauri/src/commands.rs` — the stubs
intentionally return canned data shaped exactly like the real responses, and
drift between stub shape and real shape is the main way these tests can lie to
you. A missing stub method fails loudly at the first call.
