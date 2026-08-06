# Developer Report: Cycle 3 — Search, Attachments, Fonts, Tabs, Trash/History, Table Editor, Diagram Builder v2

Implements `06-architect-design.md` in its suggested order. All seven features landed; deviations from the design are noted inline.

## 1. Local UI fonts
Google Fonts `<link>`s removed; `vendor/fonts.css` (Inter + Outfit, latin 300–700, `font-display: swap`) loads before `style.css`. `--font-display` fallback widened to degrade to Inter. `scripts/sync-fonts.mjs` + `npm run fonts:sync` re-vendors from the `@fontsource` packages. The app now starts with zero network requests.

## 2. Global full-text search
- `scanDirectory` gains an optional collector populated with `{fsPath, relPath, title, lines}` per note (skipping files >1 MB); only `get-notebook-tree` passes one and atomically swaps it into `searchIndex`, so the index is exactly as fresh as the sidebar and costs no extra reads. The `shallow` scan never touches it.
- `search-notes` IPC: whitespace-split terms, line-level AND, case-insensitive, min 2 chars; ≤50 files / ≤3 snippets each; snippets ≤160 chars centered on the first hit with merged highlight ranges.
- Sidebar: an "In note contents" section under the tree, populated inside the existing 120 ms debounce with a request token; snippets highlight matches via range-sliced `escapeHtml` + `<mark>`.
- Palette: token-guarded async append of up to 10 content results (never reordering existing rows, so arrow-key selection is stable); duplicate titles already matched by name are skipped.
- `openNoteAtLine`: caret + scroll in edit/split; proportional scroll in preview.

## 3. Attachments & images
- New `attachmentsFolder` setting (default `attachments`), coupled into `ignoreFolders` by migration.
- Paste: an `image/*` clipboard item is intercepted, sent as bytes to `save-attachment`, saved as `YYYYMMDD-HHmmss-<slug>.<ext>` (50 MB cap), and `![](relative/path)` is inserted through `replaceEditorRange` (undo-friendly). Non-image pastes fall through untouched.
- Drop: scoped to `#editor-pane` (`Files` drags only, so sidebar note-drag is unaffected); real files are copied via `webUtils.getPathForFile` + `import-attachment-file`, browser-sourced files fall back to bytes. Images insert `![]()`, other files `[name]()`.
- Preview/PDF resolution: `renderMarkdown(text, { resourceBase })` rewrites relative img srcs to absolute `file://` URLs (markdown-it image rule override in the preload). The PDF path needs nothing extra — the sanitized clone carries the absolute URLs into the temp print HTML.
- Watcher: attachment writes don't notify, and the watcher now ignores events under any `ignoreFolders` first segment. Bonus fix from the design: `save-settings` re-arms the watcher when `notebookRoot`/`ignoreFolders` change (previously only `select-folder` did).

## 4. Tab strip
`openTabs` path array; the active tab **is** `activeNote`. Opening a note appends a tab; switching = `openNote()` (autosave semantics unchanged); close via × or middle-click activates the nearest neighbor. Dirty dot driven by `updateSaveStatus`. Tabs are pruned on every tree refresh, persisted per notebook root in localStorage, and restored (with the active note re-opened) at startup. Landing/section views clear the active highlight but hold no tab.

## 5. Trash + note history
- `delete-node` is now a soft delete: file or whole folder moves to `<root>/.trash/<stamp>-<name>` (cross-device copy+rm fallback) with a `.trashmeta.json` sidecar (original path, date, kind, title); `.notebook-order` cleanup preserved; paths outside the notebook (absolute template dirs) still hard-delete.
- `list/restore/delete/empty` trash IPC; restore recreates parent folders, uniquifies collisions, and re-appends pages to `.notebook-order`. Trash modal (File Actions → Trash, `/trash`): restore, delete-forever, empty (double-confirmed).
- History: `write-note` snapshots the previous content when it changed and the newest snapshot is ≥5 min old; ≤20 snapshots per note under `.history/<sha1(relPath)[:12]>/` with a self-describing `index.json`. `rename-node` migrates the history dir. History modal (File Actions → Note History, `/history`): snapshot list + rendered preview (own container, not `#preview-pane`) + restore, which force-snapshots the current content first so restores are undoable.
- Dot-prefixed dirs are already invisible to scanner/watcher/backlinks/search (verified by the architect; relied on here).

## 6. Table editor
- Entry: table dropdown → "Open Table Editor…" (blank 3×3) / "Edit Table at Cursor". *Deviation:* instead of disabling the edit item when the caret isn't in a table, it gracefully falls back to a new table with a toast — less plumbing, no dead-looking menu item.
- Detection: contiguous `|`-prefixed lines around the caret + divider validation on line 2; escaped `\|` protected through parse (NUL placeholder) and re-escaped on serialize.
- Grid modal: input-per-cell (native Tab order), per-column alignment cycling (left/center/right), add/remove rows and columns (min 1 col, header+1 row; max 26 cols), live padded-column markdown output.
- Apply: in-place replace via `replaceEditorRange` with a staleness re-check; insert mode otherwise; preview mode switches to split first.

## 7. Diagram builder v2
- Four new plain-language types: **ER** (entities + one-to-many-style relationships with typed fields), **Timeline** (period: event; event), **Mindmap** (indented outline, depth clamped so children can't skip generations), **Quadrant** (title, axis labels, quadrant names, 0–1 points, clamped).
- New **Custom** type: raw code + live preview only (form and See Example hidden). No reverse parsing, per design.
- "Edit Diagram" pencil on every rendered mermaid block (preload actions bar; automatically stripped from PDF along with the rest of the bar). It opens the builder in Custom mode with the block's source and an "Update Diagram" button; apply locates the original fence by `data-line` hint + body-match scan (immune to the frontmatter-strip line offset) and replaces it through `replaceEditorRange`, falling back to insert-at-cursor with a toast if the block vanished.

## Test impact handled
Both harness stubs gained the full new API surface (`searchNotes`, attachment, trash, history methods; `renderMarkdown(text, opts)`); the pre-existing 130-check suite passes on both platforms with zero regressions. New-feature coverage is delegated to the functionality tester (report 08).

*Report by the Developer.*
