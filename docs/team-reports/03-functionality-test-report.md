# 03 — Functionality Test Report

**Tester:** Functionality Tester (renderer smoke harness)
**Date:** 2026-07-11 (updated same day after the Bug 1 fix landed)
**Scope:** Full verification of the latest change set — theme system, PDF export modal, 7-type diagram builder, platform shortcuts, shortcuts modal, editor combos, taskLines landing pages, backlinks, save/tree-refresh efficiency change, palette HTML escaping — plus regression of the previously covered feature set.

## Summary

Final state after fix verification: **all checks pass on both platforms.**

| Run | Checks | Passed | Failed |
| --- | --- | --- | --- |
| smoke-v2, platform stub `darwin` (post-fix) | 130 | 130 | 0 |
| smoke-v2, platform stub `win32` (post-fix) | 130 | 130 | 0 |
| `npm run compile` (tsc, post-fix) | — | PASS | — |
| `node --check renderer/app.js` (post-fix) | — | PASS | — |

Initial verification run (before the fix): 128/130 per platform — the 4 failures
(2 per platform run) shared **one root cause**, Bug 1 below (tooltip platform
normalization ran too late at startup). The developer fixed it in
`renderer/app.js`; re-running the full harness on both platforms confirms the 4
previously-failing checks now pass with **no regressions** (see Bug 1 —
FIXED & VERIFIED). Everything else — including all regressions from the old smoke
suite — passed on both platform runs throughout.

Harness: `smoke-v2.mjs` (extension of `smoke.mjs`, which is unchanged), located in
the session scratchpad. Run with:

```
SMOKE_PLATFORM=darwin node smoke-v2.mjs
SMOKE_PLATFORM=win32  node smoke-v2.mjs
```

## Test Matrix

| Feature | Result | Notes |
| --- | --- | --- |
| Boot: onboarding skip, tree render | PASS | |
| Theme: boot applies `settings.theme` (dark) | PASS | body class + `data-theme` + hljs sheet |
| Theme: midnight/forest → dark base; sepia → light base | PASS | `data-theme` set correctly |
| Theme: `applyTheme` preserves other body classes | PASS | `sidebar-collapsed` survives theme switch |
| Theme: hljs `#hljs-dark`/`#hljs-light` `disabled` swap | PASS | |
| Theme: `system` resolves via `prefers-color-scheme` | PASS | |
| Theme: `toggleGlobalTheme` flips light/dark, syncs settings select | PASS | |
| PDF export: `exportToPdf()` opens `#pdf-export-modal` prefilled from `settings.pdfExport` | PASS | light/A4/openAfter=true/reveal=false |
| PDF export: `confirmPdfExport()` reads all 4 fields, passes options to `api.exportToPdf` | PASS | dark/Letter/openAfter/reveal verified |
| PDF export: sanitization (no `.mermaid-actions-bar`, svg `max-width` capped px) | PASS | |
| PDF export: success toast `#app-toast` with pdf basename | PASS | uses stub's `{success, pdfPath}` shape |
| PDF export: options remembered for next open (`appSettings.pdfExport`) | PASS | |
| Builder: flowchart / sequence / pie (form → code → live svg) | PASS | regression |
| Builder: gantt (`dateFormat YYYY-MM-DD`, `:t1, <start>, Nd`, chained `after t1`) | PASS | example + custom input |
| Builder: class (`class X {` member blocks, `A <|-- B`, `A --> B`, `A -- B`) | PASS | |
| Builder: state (`stateDiagram-v2`, `[*] --> First`, labeled transitions) | PASS | |
| Builder: journey (`title`, `section Steps`, `Step: N: Actor`) | PASS | |
| Builder: all 7 codes parse in mermaid (svg in `#builder-preview`, no error box) | PASS | mermaid 11.15.0 vendored |
| Builder: `switchBuilderType` toggles `#builder-fields-<type>` | PASS | |
| Builder: `loadBuilderExample()` fills every type | PASS | all 7 verified |
| Builder: insert fenced block, keeps edit mode | PASS | regression |
| Platform: `window.api.platform` drives modifier rendering | PASS | after Bug 1 fix |
| Platform: `#palette-shortcut-hint` shows ⌘K / Ctrl+K | PASS | |
| Platform: `normalizeShortcutTitles()` rewrites `(Cmd+1 / Ctrl+1)` titles | PASS | also tested on a fresh element |
| Platform: mode-button / toolbar `data-tooltip` platform-correct after init | PASS | initially FAILED (Bug 1); fixed & re-verified — `(⌘1)`/`(⌘B)` on darwin, `(Ctrl+1)`/`(Ctrl+B)` on win32 |
| Shortcuts modal: Mod+/ opens `#shortcuts-modal` | PASS | Meta+/ on mac stub, Control+/ on win stub |
| Shortcuts modal: sections + `<kbd>` chips rendered, platform-correct (⌘⌥L vs Ctrl+Alt+L) | PASS | |
| Shortcuts modal: reachable via Settings button | PASS | |
| Editor: Mod+Alt+L → `- `, Mod+Alt+C / Mod+Alt+X → `- [ ] `, Mod+Alt+Minus → `---` | PASS | via `e.code` KeyL/KeyC/KeyX/Minus, both platform stubs |
| Efficiency: `saveActiveNote` (Mod+S) writes without rescanning the tree | PASS | `getNotebookTree` call count unchanged |
| Efficiency: `onFilesChanged` callback → `refreshNotebook` re-renders tree | PASS | new node appears after simulated watcher event |
| Landing: dashboard metrics from tree `openTasks`/`completedTasks` | PASS | 3 pages / 1 completed / 1 pending |
| Landing: "Pending Actions" rendered from `taskLines` (text + origin) | PASS | no extra file reads |
| Backlinks: `api.getBacklinks(activeNote)` called on drawer open, pills in `#note-meta-backlinks` | PASS | pill title resolved via tree node |
| Palette: Mod+K toggle, Escape close, commands listed | PASS | |
| Palette: HTML escaped in labels (`<img onerror>` page title) | PASS | `window.__xss` stays undefined; literal text; no `<img>` in results |
| Sidebar tree: XSS title also rendered literally (bonus check) | PASS | |
| Regression: sidebar collapse/expand/persist, drag resize | PASS | |
| Regression: editor Tab/Enter list behavior, caret scroll, native undo | PASS | |
| Regression: view mode shortcuts Mod+1/2/3 | PASS | now tested with the stub platform's modifier |
| Regression: page info modal (prefill, save via `api.updateNoteMeta`) | PASS | |
| Regression: mermaid popout (re-render, zoom label, pixel width, Escape) | PASS | |
| Regression: inline mermaid zoom (`dataset.zoomLevel`, px width, 100% restore) | PASS | |
| Regression: preview zoom label, full width mode, templates modal, drawer resize | PASS | |

## Bugs Found

### Bug 1 — Shortcut tooltips are never platform-normalized (show raw "(Cmd+1 / Ctrl+1)" on every platform) — **FIXED & VERIFIED**

**Status:** FIXED by the developer in `renderer/app.js` and re-verified by re-running
the full harness on both platforms: **130/130 PASS on darwin, 130/130 PASS on win32,
no regressions**; `npm run compile` and `node --check renderer/app.js` still pass.
The fix (a) moves `normalizeShortcutTitles()` to the top of the `DOMContentLoaded`
handler, before the awaited `refreshNotebook()` that binds tooltips, and (b) adds a
`normalizeShortcutText(text)` helper that `initCustomTooltips()` now applies at
capture time, so late-rendered elements are platform-correct regardless of ordering.
Verified tooltip output after fix: `Rendered Preview (⌘1)` / `Bold text formatting (⌘B)`
on the darwin stub; `(Ctrl+1)` / `(Ctrl+B)` on the win32 stub. The isolated
`normalizeShortcutTitles` function check also still passes.

Original finding (for the record):

**Severity:** Medium (cosmetic but defeats the entire point of the new platform-shortcut feature for tooltips).

**Symptom:** After startup, hovering the mode buttons (Preview/Edit/Split) or the
formatting toolbar buttons (Bold, Italic, bullet/checklist/separator) shows the
dual-platform raw text, e.g. `Rendered Preview (Cmd+1 / Ctrl+1)` and
`Bold text formatting (Cmd+B / Ctrl+B)` — on macOS *and* Windows stubs. Expected:
`(⌘1)` on darwin, `(Ctrl+1)` on win32.

**Repro (harness):** run `SMOKE_PLATFORM=darwin node smoke-v2.mjs`; the checks
"mode button tooltip shows ⌘ on darwin" and "toolbar Bold tooltip platform-correct
(darwin)" fail with `data-tooltip = "Rendered Preview (Cmd+1 / Ctrl+1)"`. Same on
win32. In the real app: launch with a notebook root configured, hover the Preview
mode button.

**Root cause (traced, not guessed):** startup ordering in the `DOMContentLoaded`
handler in `renderer/app.js`:

1. `renderer/app.js:68` — `await refreshNotebook()` runs first (whenever
   `notebookRoot` is set, i.e. every normal launch).
2. `refreshNotebook` → `renderSidebarTree()` → `initCustomTooltips()` at
   `renderer/app.js:344`.
3. `initCustomTooltips()` (`renderer/app.js:1254`) matches `.mode-toggles button`,
   `.toolbar-btn`, `.icon-btn`, etc., and at `renderer/app.js:1268-1271` copies the
   *raw* `title` into `el.dataset.tooltip`, marks `el.dataset.tooltipBound = 'true'`,
   and **removes the `title` attribute**.
4. Only afterwards does `normalizeShortcutTitles()` run (`renderer/app.js:87`). It
   queries `[title]` — but the shortcut-bearing buttons no longer have `title`
   attributes, so nothing is rewritten. The second `initCustomTooltips()` at
   `renderer/app.js:92` is a no-op for them because `tooltipBound` is already set.

The `normalizeShortcutTitles()` function itself is correct (verified in isolation:
a freshly added element with title `Rendered Preview (Cmd+1 / Ctrl+1)` is rewritten
to `Rendered Preview (⌘1)` / `(Ctrl+1)` per platform). The bug is purely that it
runs after the first tooltip capture. Note the comment at `renderer/app.js:85-86`
("must be applied before tooltips capture the title attributes") states the intended
invariant that the code violates.

**Suggested fix direction:** call `normalizeShortcutTitles()` before
`refreshNotebook()` in the init handler (or normalize the title inside
`initCustomTooltips()` at capture time). *The developer's fix implemented both.*

**No other app bugs found.** Specifically verified clean: theme class preservation,
PDF modal flow/sanitization/toast, all 7 builder generators (codes parse in mermaid
11.15.0), editor Alt-combos on both platform stubs, shortcuts modal, taskLines
landing rendering, backlinks pills, save-without-rescan + watcher-driven refresh,
and palette/sidebar HTML escaping (no XSS execution).

## Test Infrastructure Notes

- **Harness:** `smoke-v2.mjs` in the session scratchpad
  (`/tmp/claude-0/-home-user-markdown-notebook/f14d1e55-8bed-5246-a559-8efd6d6622d2/scratchpad/smoke-v2.mjs`),
  parameterized by `SMOKE_PLATFORM=darwin|win32` (default darwin). The original
  `smoke.mjs` is untouched. Electron is not installable in this environment, so the
  renderer is loaded in plain Chromium (`/opt/pw-browsers/chromium`) with a stubbed
  `window.api` injected via `addInitScript`.
- **Stub updated to the new preload surface:** `platform`, `getBacklinks`,
  `updateNoteMeta`, `listTemplates`, `createTemplate`, `exportToPdf` returning
  `{success: true, pdfPath}`, `getSettings` returning `theme` (not the legacy
  `previewTheme`) plus `pdfExport: {theme, pageSize, openAfter, reveal}` and
  `defaultMermaidZoom`. Tree pages now carry `taskLines: [{text, line}]` consistent
  with `openTasks` counts (matches `parseNoteMeta` in `src/main.ts:211-259`).
- **Instrumentation:** the stub counts `getNotebookTree` calls (`window.__treeCalls`),
  records writes (`window.__writes`), captures the `onFilesChanged` callback
  (`window.__filesCb`) so the debounced main-process notification can be fired
  manually, and exposes `window.__addTreePage()` to mutate the tree between scans.
- **Old suite migrations:** the export section was rewritten for the new modal flow
  (no `confirm()` dialog anymore; sanitized HTML is asserted from the captured
  `api.exportToPdf` arguments). View-mode/save/palette shortcuts now press the
  modifier matching the *stubbed* platform (`Meta` for darwin, `Control` for win32);
  native textarea undo still uses `ControlOrMeta` since that's browser-native, not
  app code.
- **Known benign console error:** `Failed to load resource: net::ERR_CONNECTION_RESET`
  — the Google Fonts `<link>` in `renderer/index.html` is blocked by the sandbox
  network; unrelated to app logic and not counted as a failure. (In the packaged
  Electron app this is a remote-font dependency the team may still want to vendor,
  but it predates this change set.)
- Checks are intentionally re-runnable and order-dependent state (theme, sidebar
  width, note content) is restored between sections, so the harness can be re-run
  after fixes without edits.
