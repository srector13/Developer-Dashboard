# Functionality Test Report: Cycle 4

Scope: the eight Cycle 4 features (grouped search, `#` tag autocomplete, perf trio, batch/themed PDF export, sharing, quick capture, palette recents, CI) plus regression of everything covered by the existing suite.

Harness: `tests/renderer/smoke.spec.mjs` — the real renderer (`index.html` + `app.js` + `style.css`) in plain Chromium with a stubbed `window.api`, run for both simulated platforms (`darwin`, `win32`). The suite grew **185 → 231 checks**. Both platform runs pass:

```
ALL 231 CHECKS PASSED   (darwin)
ALL 231 CHECKS PASSED   (win32)
```

Process note (same as previous cycles): the tester pass was executed by the developer inline using the committed harnesses; agent-based tester runs were not available this session.

## New coverage

**Grouped search panel (section 27)**
- Three groups render in order `titles / content / tags`, each with a live count in the header.
- Titles group matches page titles synchronously; Content group fills asynchronously with match counts and `<mark>` highlighted snippets; Tags group shows "No matching tags" with count 0 for a non-tag query.
- Collapsing Titles adds the collapsed class, persists to `localStorage['mdnb-search-groups']`, and — because the toggle flips classes in place — leaves the async-filled Content group untouched. Expanding restores it.

**`#` tag autocomplete (section 28)**
- `#` alone renders a single tags group listing every registered tag; the sidebar tree is *not* title-filtered in tag mode.
- `#te` filters the list live to `#test`; `#zz` shows the empty message.
- A hostile tag name (`<img src=x onerror=…>`) renders literally, injects no elements, and executes nothing.
- Clicking a tag row activates the tag-filter indicator (`#test`), and clears the search box.

**Palette recents (section 29)**
- With seeded recents, an empty palette query leads with a "Recent" group header, the active note is excluded, titles resolve via the tree, and the "Commands" header follows.

**Perf: incremental gutter (section 30)**
- Growing 3 → 5 lines appends rows without rebuilding: a marker property set on the first row node survives. Shrinking to 1 line trims trailing rows, again keeping the original node.

**Perf: in-place checkbox toggle (section 31)**
- One click produces exactly one `toggleTaskAtLine(path, 2)` IPC call, **zero** `renderMarkdown` calls (no preview re-render), a visually flipped checkbox, and the editor content patched to `- [x] task`.
- **Bug found and fixed by this test:** when the click lands on the checkbox `<input>` itself, the browser toggles it natively before dispatch and reverts it after `preventDefault` — *after* the handler's microtask continuations. The original handler read the current state from `checkbox.checked` (wrong at that moment) and its synchronous optimistic flip was silently undone by the revert. Fix: derive the state from the markdown source line and re-assert the visual state in a fresh macrotask. Regression-covered by the "visually flipped in place" check.

**Theme-true single-note PDF export (section 32)**
- With the app in dark theme and PDF theme light, a `mermaid.initialize` spy records exactly `["default", "dark"]` — the export theme applied, then the app theme restored.
- The exported HTML contains the re-rendered SVG and no `mermaid-actions-bar` chrome; `#preview-pane` keeps its own SVG untouched.

**Batch PDF export (section 33)**
- `/pdfbook` presets the scope select to notebook; confirming produces one payload with a `.pdf-toc` section, one `.pdf-note` section per page (≥3), and TOC entry count equal to note-section count. Suggested filename is `notebook.pdf`. The preview pane is untouched (offscreen rendering).

**Sharing (section 34)**
- `exportAsHtml` sends the note path plus sanitized HTML (no action bars) and toasts success; `exportAsDocx` sends the note path; `copyAsRichText` sends rendered HTML plus the raw markdown (mermaid fence present) as plain text and toasts.
- The File Actions dropdown lists all three entries; `/docx` resolves in the palette.

**Quick capture settings (section 35)**
- The settings modal prefills `CommandOrControl+Shift+N`; saving passes an edited `quickCaptureShortcut` through `saveSettings`; a simulated `capture-shortcut-failed` event surfaces as an error toast naming the failed accelerator.

## Known gaps

- Quick capture's window lifecycle (`globalShortcut`, blur-hide, `append-quick-capture` daily-note insertion) is main-process code the Chromium harness cannot reach — flagged for the Electron e2e suite in CI.
- DOCX export requires a real pandoc binary; only the renderer→IPC contract is covered.
- The mtime scan cache is main-process; correctness is guarded by the 2 s freshness window and prune logic reviewed in code, not by this suite.

## Verdict

All 231 checks green on both platforms; one real defect (checkbox revert race) was found by the new coverage and fixed. No regressions in the pre-existing 185 checks.
