# Next Steps: Making Markdown Notebook the Go-To Work Notes App

> **Status update (cycle 4):** the remaining near/medium-term items are **delivered** — batch/section PDF export with a generated TOC (3), theme-true PDF diagrams (4), incremental gutter + in-place checkbox toggling (5), the mtime scan cache (6), sharing to standalone HTML / DOCX / rich-text clipboard (8), quick capture on a global shortcut (9), and palette recents (10) — plus a reworked grouped search panel with `#` tag autocomplete and a CI workflow (renderer suite on ubuntu, Electron e2e on macOS/Windows). See reports 10–13. Still open: the longer-term items 11, 14, and 15 below.
>
> **Status update (cycle 3):** items 1 (full-text search), 2 (attachments & images), 5-in-part (local fonts), 7 (trash + note history), 10-in-part (tab strip), 12 (table editor), and 13-in-part (diagram builder: 4 more types + edit-in-place via Custom mode) are **delivered** — see reports 06–09.

The target: a one-stop shop for taking work notes, importing documents into the notebook, and exporting/sharing them as polished PDFs. Ordered by expected impact per unit of effort.

## Near term (high impact, small-to-medium effort)

1. **Global full-text search.** Search currently matches titles only. Index note contents during the existing tree scan (it already reads every file) and surface matched lines with context in the command palette. This is the single biggest gap versus OneNote/Obsidian for a work notebook.
2. **Attachments & images.** Paste an image from the clipboard → save to an `attachments/` folder and insert the markdown link; drag-and-drop files onto the editor. Work notes live and die by pasted screenshots.
3. **Export whole sections / the whole notebook.** The PDF pipeline now has themes and options; extend it to batch-export a section (one PDF per note, or a single merged PDF with a generated table of contents) for sharing complete project documentation.
4. **PDF theme-true diagrams.** Diagrams currently export with the app theme's colors. Re-render each from its stored source (`dataset.mermaidSrc`) inside the hidden print window using the PDF theme, so a light PDF never contains dark diagrams.
5. **Bundle the UI fonts locally** (Inter/Outfit are fetched from Google Fonts at startup — offline-first apps shouldn't touch the network) and add an incremental line-number gutter + in-place checkbox toggling (the two remaining renderer hot spots from the architect review, E11/E12).

## Medium term

6. **Scan cache keyed on mtime.** The debounce cut rescans dramatically, but each rescan still reads every file. Caching parsed metadata per `(path, mtime)` makes refreshes O(changed files) and unlocks smooth 5,000+-note notebooks.
7. **Note history / trash.** Soft-delete to a `.trash/` folder with restore, and optional lightweight snapshots on save (a bounded `.history/` ring). Deleting is currently irreversible, which is scary for a primary work tool.
8. **Richer sharing targets:** export to standalone HTML (self-contained, mailable), copy-as-rich-text for pasting into Outlook/Slack, and "export to DOCX" via the Pandoc integration that already exists for imports.
9. **Quick capture:** a global OS shortcut that pops a small always-on-top capture window appending to the daily note (the scratchpad IPC plumbing already exists and is unused by the UI).
10. **Tab strip / multiple open notes** with unsaved-state indicators, plus "recently edited" in the palette (it only ranks by title match today).

## Longer term

11. **Sync & mobile companion.** Notes are plain files, so iCloud/OneDrive/git already work passively; add first-class git integration (auto-commit on save, history browser) as the professional differentiator.
12. **Table editor** (tab between cells in the preview, add/remove rows visually) — tables are the most syntax-hostile part of markdown for non-technical users, same rationale as the Diagram Builder.
13. **Extend the Diagram Builder** with the remaining mermaid families (ER, timeline, mindmap, quadrant) and two-way editing: parse an existing ```mermaid block back into the form when the caret is inside it.
14. **Plugin/theme API:** the theme registry + token system now makes user-supplied palettes trivial (a JSON of token overrides); publish the token contract.
15. **Ship it:** signed installers (dmg/msi via electron-builder targets), auto-update feed, and a website download page. The e2e Playwright suite should run in CI on macOS + Windows runners where the Electron binary is available.

## Engineering hygiene carried forward

- Keep `docs/team-reports/` as the pattern for future cycles (architect → dev → testers with written hand-offs).
- The Chromium renderer harness (260 checks, platform-parameterized) should be checked into `tests/renderer/` and run in CI alongside the Electron e2e suite; it caught every regression this cycle without needing a display server or the Electron binary.
