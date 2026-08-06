# Architect Review: Markdown Notebook (Electron App)

Scope: `src/main.ts`, `src/preload.ts`, `renderer/app.js`, `renderer/index.html`, `renderer/style.css`. `vscode-extension/` excluded.

## Summary

The app is functionally solid with several well-thought-out mechanisms (preview render queue serialization, `jsArg()` escaping, wiki-link rewriting on rename). The two dominant problems are:

1. **An I/O amplification loop**: every file event triggers a full-notebook rescan that re-reads every `.md` file, and the app itself generates 2+ such events per save. Backlinks and landing-page tasks then re-read every note file *again* from the renderer, per render. With autosave on, a medium notebook (say 500 notes) performs thousands of redundant file reads per minute of typing.
2. **A theme system that is only half variable-driven**: `body.light-theme` swaps ~15 CSS variables, but ~60 declarations hardcode dark-only colors (`#fff` text, white-alpha washes, `#0d1117`/`#090c10` surfaces), so light theme is visibly broken in the editor pane, note title, preview headings, tables, dropdowns, command palette, tooltips, and scrollbars. This must be fixed before named themes are feasible.

Also flagged: an HTML-injection bug in the command palette, and a `body.className` assignment that silently destroys state classes.

---

## 1. Efficiency Findings

| # | Severity | Location | Finding |
|---|----------|----------|---------|
| E1 | High | `src/main.ts:94-101` + `renderer/app.js:41-43` | `fs.watch` handler sends `files-changed` per raw event with **no debounce**. A single save produces multiple watcher events; each one triggers `refreshNotebook()` → `get-notebook-tree` → `scanDirectory`, which reads **every note file in the notebook**. Bulk operations (git pull, sync clients) cause an event storm of full rescans. |
| E2 | High | `src/main.ts:392-398` + `renderer/app.js:872-880` | Self-amplification: `write-note` emits `files-changed`, the watcher fires again for the same write, **and** `saveActiveNote()` explicitly calls `refreshNotebook(false)`. One save = 3 full-notebook rescans. With autosave this happens continuously while typing. |
| E3 | High | `renderer/app.js` `updateOutlineAndBacklinks` | Backlinks scan launches `allPages.forEach(async ...)` — an unbounded, fire-and-forget async loop that reads every note file via IPC, once per note render. Also a race: `backlinksList.innerHTML = ''` runs synchronously, but in-flight reads from a previous invocation still append pills afterward, so rapid note switching can show duplicate/stale backlinks. Fix: move backlink computation to the main process (a single `get-backlinks` handler reusing `listMarkdownFiles`), or index links during `scanDirectory` (see E5). |
| E4 | Medium | `renderer/app.js` `getPendingTasksForPages` | Reads every page **sequentially** (`await` in a `for` loop) over IPC. Root landing = one serial IPC read per note in the notebook, re-run on every `files-changed`. |
| E5 | Medium | `src/main.ts` `scanDirectory` | The tree scan already reads full file contents to parse frontmatter and count tasks — but throws the content away. **Free win:** collect open-task lines (text + line index) into `PageNode` during this pass; the landing pages then need zero extra reads and E4 disappears. |
| E6 | Medium | `renderer/app.js` `handleSearch` | Rebuilds the entire sidebar `innerHTML` on every keystroke, then `initCustomTooltips()` rescans the whole document. Debounce ~100-150ms. |
| E7 | Medium | `renderer/app.js` `openNote` | Calls `renderActiveNote()` (renders preview) then `setViewMode('preview')` which renders again — every note open runs markdown + mermaid twice. |
| E8 | Medium | `renderer/app.js` `savePageInfo` | Metadata save cascade: `updateNoteMeta` → rescan, `renameNode` (reads all md files) → rescan, then explicit `refreshNotebook()`. Three-plus full scans for one dialog. |
| E9 | Low | `src/main.ts` `move-node` | When no order file exists, calls `scanDirectory` recursively (reads every file in the subtree) just to learn one directory's page order. |
| E10 | Low | `src/main.ts` `readSettings` | Hits disk on every IPC call. Cache in memory; invalidate on `writeSettings`. |
| E11 | Low | `renderer/app.js` task toggle | Toggling one checkbox re-reads the note and rebuilds the full preview including Mermaid re-render. |
| E12 | Low | `renderer/app.js` `updateLineNumbers` | Rebuilds the entire gutter innerHTML per keystroke — O(lines) DOM churn on large notes. |
| E13 | Low | `renderer/index.html` | Google Fonts fetched from the network at startup — blocks font rendering offline; bundle locally. |
| E14 | Low | `src/preload.ts` `renderMarkdown` | Synchronous markdown-it + hljs blocks the renderer thread on very large notes. Acceptable now. |

**Recommended sequencing:** (a) debounce watcher in main (~300ms trailing) and stop triple-scanning per save; (b) enrich `scanDirectory` output with task lines; (c) replace E3/E4 renderer loops with tree data / one IPC call; (d) debounce search.

---

## 2. UI Consistency Findings (light-theme breakage)

`body.light-theme` only swaps variables; the following bypass variables and stay dark-tuned:

**Severe (unreadable/invisible in light theme)**
- `#note-title` `color: #fff` (white-on-white).
- `#editor-pane` background `#090c10`, `#note-editor` color `#e6edf3` — the whole editor pane stays dark while the gutter half-switches.
- Preview headings hardcoded `#ffffff`/`#f0f6fc`/`#e6edf3`; white-alpha heading borders.
- Table `th` dark glass bg + `color: #ffffff !important`.
- `pre` background `#090c10 !important`; inline code white-alpha bg; `.code-block-wrapper` `#0d1117` + dark header. `github-dark.css` (hljs) loads unconditionally.
- Command palette hardcoded dark card, `#fff` input/selection, white-alpha footer keys.
- `.dropdown-menu` dark glass `rgba(22,27,34,0.95) !important`.
- `.custom-tooltip` dark bg. Mermaid action buttons / popout card hardcoded dark.
- Scrollbar thumbs white-alpha: invisible on light backgrounds.

**Moderate (washed out / low contrast)**
- Pervasive `color: #fff` on hover/active states (logo, icon buttons, tree nodes, tabs, toolbar, outline items, modal headers, close buttons).
- `rgba(255,255,255,x)` surface/hover washes that read as "nothing" on white.
- `color: #0d1117` text on accent backgrounds — dark-on-dark in light theme where accents are dark.
- Landing titles/metric values `#ffffff`; progress-ring track white-alpha inline; landing task badges hardcode white-alpha in JS template strings.

**Design-language inconsistencies (both themes)**
- Border radius spread: 3/4/6/8/12px ad hoc. Recommend tokens `--radius-sm/md/lg/xl/pill`.
- Focus treatment inconsistent; all buttons declare `outline: none` with no `:focus-visible` replacement — keyboard-accessibility gap.
- Padding drift across surfaces; tokenize while doing the color pass.

---

## 3. Theme Architecture Recommendation

1. **Settings model.** Add `theme: 'system' | 'light' | 'dark' | 'midnight' | 'forest' | 'sepia'`. Migrate inside `readSettings()`: derive from `previewTheme` (`'github'`→`'system'`, `'github-dark'`→`'dark'`, `'off'`→`'light'`) when absent.
2. **Renderer theme registry**: each entry declares `base` (dark/light body class) and a mermaid theme. `applyTheme` resolves `'system'` via `prefers-color-scheme`, then uses `classList` (never `body.className =`, which wipes `sidebar-collapsed`) and sets `body.dataset.theme`.
3. **CSS**: `:root` = dark base; `body.light-theme` = light base; each named theme is a pure variable block on `body[data-theme=...]`. Requires the Section 2 token cleanup first; add semantic vars: `--text-heading`, `--text-inverse`, `--editor-bg`, `--code-bg`, `--surface-hover`, `--surface-active`, `--scrollbar-thumb`, `--tooltip-bg`, `--menu-bg`.
4. **hljs**: ship light + dark stylesheets, toggle `link.disabled` from `applyTheme`.
5. **Mermaid**: keep the re-init + re-render hook in `applyTheme`; source theme from the registry. Delete the duplicate init in DOMContentLoaded.
6. **Settings UI**: replace the three-option select with the theme list; update `toggleGlobalTheme()`.

---

## 4. PDF Export Recommendation

1. **Renderer export modal** (reuse `modal-overlay`/`glass-card`): PDF theme (`light | dark | minimal`), page size (`A4 | Letter | Legal`), checkboxes "Open after export" and "Reveal in folder". Persist last-used options in settings.
2. **Preload:** widen bridge to `exportToPdf(filePath, htmlContent, options)`.
3. **Main:** split into `PDF_BASE_CSS` (layout/page-break/UI-hiding, written against `--pdf-*` tokens) + per-theme token blocks; pass `pageSize` into `printToPDF`; after write, `shell.openPath` / `shell.showItemInFolder` per options; return `{ success, pdfPath }`.
4. **Constraints:** diagrams are cloned from the live preview so they carry the app's current theme (document in modal; v2 = re-render from `dataset.mermaidSrc` with the PDF theme). The `data:` URL load has size limits — prefer a temp file + `loadFile`.

---

## 5. Architecture Risks & Guardrails for the Developer

- **Preview render queue**: renders are serialized deliberately; never set `#preview-pane` innerHTML outside `renderMarkdownPreview()`.
- **`jsArg()` escaping**: every dynamic value in inline onclick template strings must go through it.
- **Palette injection bug (fix now)**: `handlePaletteSearch` inserts `item.label`/`item.subtitle` into innerHTML without `escapeHtml` — a note titled `<img src=x onerror=...>` executes.
- **`.notebook-order` invariants**: create/import append; delete removes; rename rewrites; `move-node` lazily initializes. Keep in sync; keep the watcher's `.notebook-order` ignore filter.
- **Template folder exclusion**: `isTemplatePath` special-casing depends on `templatesFolder` ⊆ `ignoreFolders`; keep coupled.
- **`applyTheme` className wipe**: `body.className = 'dark-theme'` destroys `sidebar-collapsed` (latent bug today) — use classList.
- **Watcher debounce semantics**: preserve `refreshNotebook(false)` behavior (doesn't reset active note; only reloads preview when content actually changed).
- **Line endings**: `toggle-task-at-line` normalizes CRLF; don't blindly copy that pattern.

---

## 6. Prioritized Work Order

1. **P0** — Watcher debounce + save-loop removal (E1, E2). Smallest change, biggest I/O win.
2. **P0** — Palette XSS fix + `applyTheme` classList fix.
3. **P1** — Kill renderer full-notebook reads (E3, E4, E5): task lines in `scanDirectory`; one `get-backlinks` IPC; fixes the backlinks race.
4. **P1** — Search debounce (E6); `openNote` double render (E7).
5. **P2** — CSS variable/token cleanup (prerequisite for themes) + focus-visible + radius tokens.
6. **P2** — Named themes (registry, migration, Midnight/Forest/Sepia, mermaid mapping, settings UI).
7. **P3** — PDF export overhaul (modal, options, themed tokens, pageSize, open/reveal, temp-file load).
8. **P3** — Cleanups: settings cache (E10), move-node shallow scan (E9), savePageInfo cascade (E8), local fonts (E13), incremental gutter (E12).

*Report produced by the Architect agent; committed to the repo by the developer.*
