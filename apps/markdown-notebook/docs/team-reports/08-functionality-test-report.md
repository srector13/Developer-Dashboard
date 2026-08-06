# Functionality Test Report: Cycle 3

*The tester agents assigned to this cycle were twice terminated by session usage limits before producing results; the verification below was completed by the orchestrating engineer using the same in-repo harness and process (extend → run both platforms → trace failures → fix loop).*

## Summary

**PASS: 185/185 checks on darwin, 185/185 on win32** (55 new cycle-3 checks + 130 regression checks). `npm run compile` and `node --check renderer/app.js` clean. **Zero app bugs found.** Three failures during test bring-up were all defects in the new test code itself, each traced and fixed:

1. Test data mismatch — new assertions expected a note titled "Alpha" but the shared stub tree titles it "A Very Long Page Title…" (kept deliberately for truncation coverage).
2. The stubbed `renderMarkdown` didn't emit the new Edit-Diagram button that the real preload now renders — stub markup updated to mirror `src/preload.ts`.
3. Undo was sent as Meta+Z under the darwin-stubbed run, but native textarea undo binds to the real OS (Control on Linux Chromium) — switched to `ControlOrMeta+z` with a comment.

## Test Matrix (new coverage)

| Feature | Checks | Result |
|---|---|---|
| Full-text search: sidebar section, `<mark>` highlights, XSS-escaped titles/snippets, click→open, clear-hides | 8 | PASS |
| Search in palette: async content rows, no reordering, stale-token race leaves no stale rows | 3 | PASS |
| Tab strip: visibility, active highlight, click-switch, dirty dot set/clear, localStorage persistence shape, landing clears highlight, close activates neighbor | 9 | PASS |
| Trash modal: list render, XSS-escaped titles, restore IPC arg, toast | 4 | PASS |
| History modal: list, disabled-until-selected restore, preview renders in its own pane (never `#preview-pane`), correct snapshot id read | 6 | PASS |
| Table editor: 3×3 insert grid, alignment cycle → `:---:` divider, padded columns, edit-in-place parse (incl. escaped `\|`), Update-in-place, undo restores | 7 | PASS |
| Builder v2: er/timeline/mindmap/quadrant codegen constructs + live mermaid parse (svg), custom mode hides form/example | 10 | PASS |
| Builder edit-in-place: pencil per block, opens custom with source, Update replaces only the right block | 4 | PASS |
| Attachments: paste image → saveAttachment bytes + `![]()` insert + toast; drop file → link insert; `renderMarkdown` receives `resourceBase` | 4 | PASS |
| Regressions (cycles 1–2 features) | 130 | PASS |

## Infra Notes

- The harness stubs (`tests/renderer/smoke.spec.mjs`) now cover the complete preload surface including search, attachments, trash and history; injectable fixtures via `window.__searchStub/__trashStub/__historyStub`.
- Main-process code paths the Chromium harness cannot exercise (real fs moves to `.trash/`, `.history/` snapshot pruning, `search-notes` index matching, attachment file writes, watcher ignore-segments) remain covered only by design review + the Electron e2e suite when run on a machine with the Electron binary. Recommend a `tests/e2e` extension for trash/history/search on such a machine.

*Report format per team convention; verification loop: 3 iterations to green.*
