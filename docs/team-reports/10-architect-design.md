# Architect Design: Cycle 4 — Search Groups, Batch/Sharing Exports, Perf Trio, Quick Capture, Palette Recents, CI

All guardrails from `01-architect-review.md` §5 remain binding (jsArg/escapeHtml discipline, serialized preview queue, .notebook-order invariants, settings migration, CRLF caution).

## Summary — one line each

1. **Search rework** — sidebar results become three collapsible groups (Titles / Content / Tags) rendered by one `renderSearchGroups()`; `#`-prefix flips into tag-autocomplete mode that bypasses tree filtering and the content IPC.
2. **Batch PDF** — renderer renders each note offscreen (string HTML + `mermaid.render`, never `#preview-pane`), builds TOC + per-note sections, and reuses `export-to-pdf` unchanged; the diagram phase chains onto `previewRenderQueue`.
3. **Theme-true diagrams** — shared `withMermaidTheme()`: initialize(export theme) → `mermaid.render` per `dataset.mermaidSrc` → initialize(app theme) in a `finally`; per-block fallback keeps the original SVG; serialized via `previewRenderQueue`.
4. **Perf trio** — trailing-div-only gutter updates; optimistic checkbox toggle patching `noteContent`/`noteOriginalContent` to exactly match main's normalized write; `(mtimeMs,size)`-keyed scan cache in main backing both meta and the search index with shared references (no duplicate memory).
5. **Sharing** — `export-to-html` (themed self-contained HTML, images inlined as data: URIs in main with 10 MB/40 MB caps), `export-to-docx` (new `runPandocToFile`, frontmatter stripped via temp copy, mermaid-as-code-block limitation documented), `copy-rich-text` (`clipboard.write({html,text})`).
6. **Quick capture** — lazy-singleton frameless always-on-top window on configurable `globalShortcut` (default `CommandOrControl+Shift+N`, empty disables), `append-quick-capture` IPC writing under `## Quick Capture` in today's daily note (found anywhere by basename, created at root otherwise); `unregisterAll()` on `will-quit`; failed registration surfaces a toast.
7. **Palette recents** — MRU `fsPath[]` updated in `openNote`, persisted per-notebook in localStorage (15 stored / 8 shown), shown as a "Recently opened" group on empty query with non-selectable group headers.
8. **CI** — already landed (`d2ebb3b`); only add a `concurrency` cancel-in-progress group.

## 1. Search Rework

- Keep the `#content-search-results` element as host for all three groups; `renderSearchGroups(query)` is the entry; `runContentSearch` survives as the async Content feed.
- `handleSearch`: single 120 ms debounce retained. `tagMode = val.startsWith('#')`; in tag mode force `searchQuery = ''` (tree unfiltered — '#foo' would blank it), then `renderSidebarTree()` + `renderSearchGroups(val)`. Keep the in-place tree title filter for normal queries — groups are additive.
- Collapse state: `searchGroupCollapsed = {titles, content, tags}` persisted in `localStorage['mdnb-search-groups']` (app-wide). `toggleSearchGroup(name)` flips classes in place (no full re-render, so the async Content fill isn't lost). Headers show total counts even when collapsed; zero-match groups render a muted "No matches" row.
- Groups: **Titles** (sync, gatherPagesRecursively title/name match, cap 20, tree order, click → openNote); **Content** (async searchNotes, token-guarded, cap 20, "Searching…" placeholder, existing highlight + openNoteAtLine); **Tags** (sync from tagSet, name-contains match, alphabetical, cap 25, rows show page counts from a Map built in scanGlobalTags; click → toggleTagFilter; active tag gets `.active`).
- `#` mode: only the Tags group ("Tags — autocomplete"); `'#'` alone lists ALL tags; `'#nonexistent'` → empty row; no searchNotes IPC (but bump the token to kill stale responses); click → toggleTagFilter + clear the input + `handleSearch('')` (the active-tag indicator is the persistent state). Leading-whitespace `' #x'` is NOT tag mode.
- Content min-length 2; Titles/Tags from length 1. Panel hidden when query empty. Every tag through escapeHtml/jsArg (XSS tag name must render inert).

## 2. Batch PDF Export

- Reuse `export-to-pdf` IPC unchanged (temp-file load has no data:-URL limit). Renderer builds the whole document.
- Entry points: `#pdf-scope` select in the PDF modal (Current note / This section (N) / Entire notebook (N)), enabled per opener; a landing-header export button presetting section/notebook scope; palette `/pdfsection` + `/pdfbook`.
- Pipeline `buildBatchExportHtml(sectionNode, opts)`: gatherPagesRecursively (tree order = document order); >150 pages → confirm(); per page: readNote → renderMarkdown(text, {resourceBase}) → detached div → shared `sanitizeExportDom()` → for each `pre.notebook-mermaid`, `mermaid.render` on the detached content (works detached; on error replace container with escaped source + note) → wrap in `<section class="pdf-note" id="note-i"><h1>title</h1>…</section>` (explicit H1 because renderMarkdown strips it). Progress via a sticky toast variant, yielding to paint. TOC section prepended (`.pdf-toc`, anchor links, no page numbers, page-break-after). CSS for `.pdf-note{page-break-before:always}` etc. added to PDF_BASE_CSS. Whole mermaid phase inside one `withMermaidTheme` (single initialize/restore for the batch). Skipped unreadable notes are counted in the final toast.

## 3. Theme-True PDF Diagrams

- `PDF_MERMAID_THEME = { light:'default', minimal:'default', dark:'dark' }`.
- `withMermaidTheme(exportTheme, fn)` chains onto `previewRenderQueue`: initialize(export) → fn → finally initialize(resolved app theme). This is the mermaid mutex: preview refreshes queue behind exports; applyTheme still initializes directly but re-renders behind the queue and the export's finally reads the fresh theme.
- Single-note export: clone (dataset survives cloneNode) → for each block `mermaid.render(uid, pre.dataset.mermaidSrc)` replacing pre content; catch → keep original app-theme SVG. Update the modal hint text.

## 4. Perf Trio

- **Gutter**: diff on `lineNumbers.childElementCount`; equal → return; more → append missing divs via DocumentFragment; fewer → remove trailing. Keep syncEditorScroll when count changed. Row text never changes (row i is always i).
- **Checkbox**: optimistic flip; `toggleTaskAtLine`; on failure revert + toast; on success patch the one line in `noteContent` replicating main's `\r?\n → \n` normalization, set `noteOriginalContent = noteContent`, sync editor.value, updateWordCount. No re-render/re-read (debounced refresh becomes a preview no-op because contents match — load-bearing invariant). Regex miss → fall back to old full path.
- **Scan cache** (main): `Map<path,{mtimeMs,size,meta,doc}>`; hit requires equal mtimeMs+size AND file older than 2 s (sub-second mtime + write races); miss → read/parse/store. `searchIndex` collector pushes the SAME doc references (no duplicate memory). Pruning: only full scans (with collector) prune against a `seen` set threaded through recursion; shallow scans read-through but never prune. `SCAN_CACHE_MAX = 5000` → clear() as belt-and-braces. Atomic `searchIndex = collector` swap unchanged.

## 5. Sharing

- All three in File Actions + palette (`/html`, `/docx`, `/copyrich`); require activeNote.
- **HTML**: sanitized clone + withMermaidTheme (theme from the shared modal, `data-mode="html"` hides PDF-only rows); main `export-to-html`: save dialog, PDF_THEMES+PDF_BASE_CSS full document + small screen-only centering block, inline `src="file://…"` images as data: URIs (ext→MIME map; 10 MB per image, 40 MB total; over-cap kept as file:// and counted), return {success, htmlPath, inlined, skipped} → toast mentions skips.
- **DOCX**: `runPandocToFile(inputPath,'gfm',outPath)` with `-o` (binary output — never stdout), `-t docx`, `cwd` = note dir (relative images resolve), 60 s timeout; frontmatter stripped via temp copy in app temp; pandoc-missing → friendly reason. Tooltip + toast document the mermaid-as-code-block limitation.
- **Copy rich text**: renderer ensures preview is fresh (await renderMarkdownPreview when in edit mode), sends {html: sanitized clone, text: preview innerText} → main `clipboard.write` → toast.
- Preload: `exportToHtml`, `exportToDocx`, `copyRichText`.

## 6. Quick Capture

- Setting `quickCaptureShortcut` (default `CommandOrControl+Shift+N`; migration free via defaults spread). Settings input + system-wide warning hint; re-register on save (unregister old first; try/catch invalid accelerators; register()===false → `capture-shortcut-failed` → renderer toast).
- Lazy-singleton hidden BrowserWindow (520×150, frameless, alwaysOnTop, skipTaskbar, own `capture-preload.ts` exposing only `appendQuickCapture`/`hideCaptureWindow`); toggle on shortcut; hide on blur/Esc; `closed` nulls singleton; `will-quit` → `globalShortcut.unregisterAll()`.
- `append-quick-capture(text)`: find today's daily note anywhere by basename (listMarkdownFiles), else create at root with the create-page skeleton + order-file append; insert `- HH:MM text` (newlines collapsed) at the end of the `## Quick Capture` section (create the heading at EOF if missing); `writeNoteFile({snapshot:true})`; `notifyFilesChanged()`. Unsaved-edit collision documented (last writer wins; history keeps the capture).
- `renderer/capture.html` standalone (own CSS, no app.js): textarea, Enter submits / Shift+Enter newline / Esc hides, brief "Captured ✓" state.

## 7. Palette Recents

- `localStorage['mdnb-recents:'+root]` = fsPath[], MRU-first, updated in openNote (dedupe, unshift, cap 15).
- Empty query: first 8 that resolve via findNodeByPath/isTemplatePath, excluding activeNote, rendered above commands with non-selectable `.palette-group-header` divs ("Recent", "Commands") that live outside `paletteFilteredItems` so selection arithmetic is untouched. Non-empty queries unchanged. Lazy pruning only.

## 8. CI

Landed in `d2ebb3b`; add `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`. No linux-e2e leg this cycle.

## Cross-Feature Concerns

Single 120 ms search timer (no second timer or tree/panel desync); one mermaid mutex via previewRenderQueue with applyTheme's direct init acceptable; exports only read (no watcher storms); the 2 s cache guard covers capture/autosave write races (mtime+size-preserving external editors are the accepted blind spot); global shortcut is the only global registration; `sanitizeExportDom` shared by single-note PDF, batch, HTML and copy-rich so the chrome-strip list can't drift; escapeHtml/jsArg on all new surfaces.

## Test Impact

Stubs: `exportToHtml`, `exportToDocx`, `copyRichText`. Search: keep `.content-search-item*` classes; header assertions change to group headers; new checks for counts, collapse persistence, `#` all-tags, `#zz` empty, tree unfiltered in # mode, tag-click → toggleTagFilter, XSS tag inert. Perf: gutter node-identity stability across append; checkbox → one toggleTaskAtLine call, no renderMarkdown call, content patched. Batch: exportToPdf stub receives `.pdf-toc` + N `.pdf-note` sections; `#preview-pane` untouched. Theme-true: mermaid.initialize spy sees [exportTheme, appTheme]. Recents: seeded localStorage → "Recently opened" header first on empty query. Quick capture is main-process → e2e territory.

## Implementation Order

1. Perf trio → 2. Search rework → 3. Palette recents → 4. withMermaidTheme + sanitizeExportDom → 5. Batch PDF → 6. Sharing → 7. Quick capture → 8. CI concurrency line.

*Design by the Architect agent; committed by the developer.*
