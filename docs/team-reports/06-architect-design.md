# Architect Design: Cycle 3 — Search, Attachments, Fonts, Tabs, Trash/History, Table Editor, Diagram Builder v2

Scope: `src/main.ts`, `src/preload.ts`, `renderer/{app.js,index.html,style.css}`. All Risks & Guardrails from `01-architect-review.md` §5 remain binding: `jsArg()` for every dynamic value in inline handlers, `escapeHtml` for every dynamic value in innerHTML, all preview writes through `renderMarkdownPreview()`'s serialized queue, `.notebook-order` invariants, `templatesFolder ⊆ ignoreFolders` coupling, settings migration in `migrateSettings()`.

## Summary — decisions in one line each

1. **Full-text search** — line index built as a side effect of the existing full `scanDirectory` pass (zero extra I/O), queried via a new `search-notes` IPC; surfaced in the palette and a sidebar "In note contents" section.
2. **Attachments** — paste/drop saved by main into `<root>/attachments/` via `save-attachment`; preview + PDF resolved by rewriting relative `img src` to absolute `file://` URLs inside `renderMarkdown` (new `opts.resourceBase`).
3. **Local fonts** — woff2 + `vendor/fonts.css` already vendored; swap the Google Fonts `<link>`s in `index.html` for `vendor/fonts.css`.
4. **Tab strip** — MRU list of paths over the existing single-active-note model; switching = `openNote()`; persisted in `localStorage` per notebook root; landings get no tab.
5. **Trash + history** — soft delete into `<root>/.trash/` with sidecar JSON metadata; bounded per-note snapshots in `<root>/.history/<hash>/`; both dot-prefixed and therefore already invisible to scanner, watcher, and backlinks (verified).
6. **Table editor** — modal grid editor; caret-in-table detection via contiguous `|`-prefixed line runs with a valid divider; replace-in-place through `replaceEditorRange` (undo-friendly).
7. **Diagram builder v2** — ER, timeline, mindmap, quadrant types with plain-language forms; "Edit diagram" button on rendered blocks opens the builder in a new `custom` type (code-only, no reverse parsing) and replaces the original block located by `data-line` hint + source-match scan.

## 1. Global Full-Text Search

- Index in main process, built inside `scanDirectory` (which already reads every file). Per file store `{ fsPath, relPath, title, lines }`. Only `get-notebook-tree` populates a fresh collector and atomically swaps it into `searchIndex`; the `shallow` scan (move-node) must not touch it. Tag filtering happens after the scan, so filtered trees still index everything.
- IPC `search-notes(query, {maxResults})` → `SearchResult[]`: `{ fsPath, relPath, title, matchCount, snippets: [{ line, text (≤160 chars centered on first match), ranges: [start,length][] }] }`.
- Matching: trim, min length 2; whitespace-split terms; a line matches when it contains **every** term case-insensitively; ranges merged/clipped to the snippet window; frontmatter searched (deliberate).
- Caps: 50 files, 3 snippets/file, skip files >1 MB, bail after 50 matching lines/file; order by matchCount desc then title.
- Sidebar: within the existing 120 ms debounce, fire token-guarded `searchNotes` for queries ≥2 chars; render into `#content-search-results` below the tree ("In note contents"); highlight by slicing on ranges and escaping each slice separately, `<mark>` around matches; click → `openNoteAtLine`.
- Palette: keep sync commands/title matches; append ≤10 token-guarded content items (label=title, subtitle=snippet, escaped) without reordering existing rows.
- `openNoteAtLine(fsPath, line)`: open, then best-effort reveal — caret+scroll in edit/split, proportional scroll in preview.

## 2. Attachments & Images

- One folder `<root>/attachments/`, new setting `attachmentsFolder` (default 'attachments'), migration appends it to `ignoreFolders` if absent ('_media' kept for back-compat).
- Paste: renderer `paste` listener on the editor sends bytes via `save-attachment { baseName, bytes, notePath }` → `{ success, fsPath, relPath }`; insert `![](relPath)` via `replaceEditorRange`; toast. Non-image paste falls through.
- Drop: `drop`/`dragover` on `#editor-pane` only (must not interfere with the tree's move DnD); real files resolved via `webUtils.getPathForFile` exposed as `api.getPathForFile`; copied by `import-attachment-file { sourcePath, notePath }`; images insert `![]()`, other files `[name]()`.
- Naming: `YYYYMMDD-HHmmss-<slug(base)||'pasted-image'>.<ext>`; uniquify via generalized `uniqueFile`; cap bytes 50 MB.
- Preview resolution: `index.html` loads via `loadFile`, so relative img src resolves into the renderer directory — always broken. Fix in preload: `renderMarkdown(text, { resourceBase })` overrides the image rule to rewrite non-absolute, non-scheme srcs to `pathToFileURL(resolve(resourceBase, src))`. Renderer passes `resourceBase = dirname(activeNote)`.
- PDF export works unchanged: the sanitized clone already carries absolute `file://` srcs into the temp print HTML. Do not "clean up" absolute URLs at export.
- Watcher: attachment writes must not trigger rescans — `save-attachment` doesn't notify, and the watcher callback additionally ignores events whose first path segment is in `ignoreFolders`. Also: `save-settings` should re-arm the watcher when `notebookRoot`/`ignoreFolders` change.

## 3. Local UI Fonts

Remove the two `preconnect` lines + Google Fonts stylesheet from `index.html`; link `vendor/fonts.css` above `style.css`. Weights 300–700 normal latin (matches previous request). Widen `--font-display` fallback to `'Outfit', 'Inter', …`. Add `scripts/sync-fonts.mjs` + npm `fonts:sync` for reproducible upgrades. electron-builder's `renderer/**/*` glob already ships the woff2.

## 4. Tab Strip

- `let openTabs = []` (fsPath array); the active tab **is** `activeNote` (no second source of truth). `openNote` appends if missing + renders strip + persists. Close: remove; if active, activate right neighbor, else left, else `closeNoteCanvas()`. Middle-click (auxclick) and × button close.
- `#tab-strip` sits between toolbar and note workspace, visible when `openTabs.length > 0`, horizontal overflow scroll, active tab `scrollIntoView`. Title via `findNodeByPath` fallback `pathBasename`; every title escaped; every path through `jsArg`.
- Dirty dot: only the active note can be dirty (single-note model, v1); `updateSaveStatus` toggles a `.dirty` class.
- Prune tabs on `refreshNotebook` when the path is gone (unless template). Renames close the old tab (path changed) — accepted v1.
- Persist `{ tabs, active }` in `localStorage['mdnb-tabs:'+notebookRoot]`; restore after first `refreshNotebook`. Landing/section views get no tab.

## 5. Trash + Note History

Verified: scanner (`startsWith('.')`), watcher, and `listMarkdownFiles` all skip `.trash`/`.history`.

- Trash: `delete-node` becomes a move into `<root>/.trash/<stamp>-<basename>` (cross-device fallback copy+rm) + sidecar `<name>.trashmeta.json` `{ originalRelPath, deletedAt, kind, title }`. Folders move whole (one restore unit). `.notebook-order` removal preserved. Renderer copy: "Move to Trash?" + toast.
- IPC: `listTrash()`, `restoreTrashItem(trashName)` (recreates parents, uniquifies, re-appends to `.notebook-order`), `deleteTrashItem(trashName)`, `emptyTrash()`. Manual pruning only (v1).
- History: shared `writeNoteFile(filePath, content, {snapshot})` used by `write-note`; snapshot the previous content when file exists, content changed, and newest snapshot ≥5 min old (`HISTORY_MIN_INTERVAL_MS`); prune to `HISTORY_MAX_SNAPSHOTS = 20`. Store under `.history/<sha1(relPath)[:12]>/<timestamp>.md` + `index.json`. `rename-node` moves the history dir. Task-toggle/meta writes unsnapshotted.
- IPC: `listNoteHistory(fsPath)`, `readNoteHistory(fsPath, id)`, `restoreNoteHistory(fsPath, id)` (snapshots current first — restore is undoable).
- UI: `#trash-modal` (rows: title/original path/date; Restore / Delete Forever; Empty Trash double-confirm) from file-actions dropdown + palette + settings; `#history-modal` for the active note (list + rendered preview into its own container + confirm restore, then re-read + `renderActiveNote`).
- Watcher: trash/history writes don't notify; delete/restore do.

## 6. Table Editor

- Entry: table dropdown gains "Open Table Editor" (blank 3×3, insert mode) and "Edit Table at Cursor" (enabled when caret in table, recomputed on dropdown open).
- Detection: expand contiguous `/^\s*\|/` lines around the caret line; validate ≥2 lines with divider `/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/` on the second; convert to char offsets in `tableEditContext`.
- Parsing: protect `\|` with a placeholder, strip outer pipes, split/trim, restore; alignment from divider (`:--:` center, `--:` right); pad ragged rows.
- Grid modal: input-per-cell (native Tab order), per-column alignment cycle + remove, add row/column, minimums 1 col / header+1 row, cap 26 cols; live serialized output in a readonly textarea; contextual footer button (Insert/Update Table).
- Serialization: `\|`-escape cells; column width = max(3, widest cell); padded cells; alignment-aware dividers; trailing newline.
- Apply via `replaceEditorRange`; staleness re-check (slice still starts with `|`), else toast + insert at caret. If in preview mode, switch to split first.

## 7. Extended Diagram Builder

- New types + forms:
  - **ER**: entities "Customer: id, name" (optional `type name`), relationships "Customer one-to-many Order: places" (1-1/1-n/n-1/n-n shorthands) → `erDiagram` with `||--o{` etc.; single-word attrs typed `string`.
  - **Timeline**: title + "2024: Founded; First hire" lines (semicolon = multiple events) → `timeline`.
  - **Mindmap**: single outline textarea, first line = center `root((label))`, two-space indents, depth clamped to parent+1.
  - **Quadrant**: title, 4 axis labels, 4 quadrant names, points "Item A: 0.3, 0.8" clamped to [0,1] → `quadrantChart`.
  - **Custom**: no form fields; code textarea + preview only; hides See Example. Used as the edit-mode landing type. No reverse parsing anywhere.
- "Edit Diagram" pencil button added to the preload fence actions bar (static HTML). Handler reads `dataset.mermaidSrc` + container `data-line`, opens builder in `custom` with the code prefilled, footer becomes "Update Diagram".
- Replace-on-update: `data-line` used only as a **hint** — scan outward (±30 lines) for the nearest ```` ```mermaid ```` fence whose body equals `originalSrc.trim()`, falling back to a whole-file exact match (immune to the frontmatter/H1 stripping offset); replace fence-inclusive range via `replaceEditorRange`; on failure toast + insert at caret. Clear `builderEditContext` on close/apply.

## Cross-Feature Concerns

- `.trash`/`.history` excluded everywhere by dot-prefix; `attachments/` excluded from scan/backlinks/search via ignoreFolders, and from watcher via the new first-segment filter.
- Settings: add `attachmentsFolder` (default 'attachments'); migration self-heals and couples it into `ignoreFolders`. No settings for tabs/trash/history (localStorage / constants).
- `notifyFilesChanged`: not for attachment/history/trash-content writes; yes for delete/restore.
- Renderer discipline: `escapeHtml` + `jsArg` on every new surface (tab strip, search results, trash/history lists, palette snippets); nothing outside the render queue writes `#preview-pane`; all editor insertions via `replaceEditorRange`.

## Test Impact

Stub additions for tests/renderer (searchNotes, saveAttachment, importAttachmentFile, getPathForFile, listTrash/restoreTrashItem/deleteTrashItem/emptyTrash, listNoteHistory/readNoteHistory/restoreNoteHistory); `renderMarkdown` stub gains `(text, opts)`; fence HTML gains a fifth action button. New coverage: tabs (open/switch/close/middle-click/persist), search results with `<mark>` + XSS-escaped snippets, table editor round-trip, builder custom + edit-in-place block replacement, palette async token race. Electron e2e covers real clipboard/drop/filesystem/PDF-image behavior.

## Suggested Implementation Order

1. Local fonts (hours) → 2. Full-text search → 3. Attachments → 4. Tab strip → 5. Table editor → 6. Diagram builder v2 → 7. Trash + history (last: rewires the two most safety-critical handlers).

*Design by the Architect agent; committed by the developer.*
