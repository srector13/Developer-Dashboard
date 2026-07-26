# Rust (Tauri) port — plan and outcome

**Status: done.** This branch *is* the Rust build. The Electron main process
(`src/*.ts`) and the electron-builder packaging have been removed; the UI in
`renderer/` is unchanged and now talks to a Rust backend. The Electron version
still lives on `main`.

## What actually changed

| | Electron (on `main`) | This branch |
|---|---|---|
| Windows portable exe | ~85–100 MB | a few MB |
| Runtime | bundled Chromium + Node | WebView2 (an OS component) + one Rust binary |
| Renderer code | `renderer/` | `renderer/`, unchanged except three added script tags and a relaxed CSP |
| Backend code | `src/main.ts` (~3,300 lines TS) | `src-tauri/src/` (~4,000 lines Rust, 104 unit tests) |
| Targets | mac dmg/zip, win nsis/portable/zip, linux AppImage | **Windows portable exe only** |
| Auto-update | installer builds only | none (portable can't self-update) |

The `window.api` surface defined by the old preload is the contract that made
this possible. `renderer/api-tauri.js` re-implements all 74 of its methods over
`invoke()`, so `renderer/app.js` — 6,600 lines — needed no changes at all.

## Layout

```
markdown-notebook/
├── renderer/                 # the UI, shared and unmodified
│   ├── api-tauri.js          # window.api / captureApi / launcherApi / …
│   └── markdown.js           # the markdown-it pipeline, moved out of the preload
├── src-tauri/
│   ├── src/
│   │   ├── main.rs           # builder, tray wiring, close-to-tray
│   │   ├── commands.rs       # the 65 #[tauri::command]s (1 per old IPC channel)
│   │   ├── desktop.rs        # helper windows, tray, shortcuts, watcher, screenshots
│   │   ├── platform.rs       # WebView2 PrintToPdf + CF_HTML clipboard (Windows)
│   │   ├── notebook.rs       # scan, frontmatter, ordering, caches
│   │   ├── notes.rs          # history, trash, rename + wiki-link rewriting
│   │   ├── search.rs         # full-text index, launcher search, backlinks
│   │   └── …                 # settings, capture, exports, pandoc, ai, attachments
│   └── tauri.conf.json
└── package.json              # renderer tests + icon generation only
```

## The two risk items, resolved

The original plan flagged these as the only features without a drop-in
equivalent. Both are now implemented natively in `src-tauri/src/platform.rs`.

**PDF export.** Electron used `webContents.printToPDF` — silent, no dialog.
Tauri exposes no equivalent, but WebView2 does: `ICoreWebView2_7::PrintToPdf`.
`with_webview()` hands us the real `ICoreWebView2Controller`, so an offscreen
window loads the styled HTML from a temp file and prints straight to the chosen
path. Page size, margins and `ShouldPrintBackgrounds` (needed for the dark and
tinted PDF themes) map one-to-one onto the old options. This is strictly better
than the plan's fallbacks — `window.print()` would have shown the OS dialog, and
shelling out to headless Chrome would have added a dependency.

**Clipboard HTML.** `clipboard-win` reads and writes the `CF_HTML` format,
unwrapping and generating its header. `clipboard.readHTML()` becomes
`formats::Html.read_clipboard()` and `clipboard.write({html, text})` becomes a
paired `CF_HTML` + `CF_UNICODETEXT` write, so "Paste as note" and "Copy as rich
text" behave as before.

## Other deltas worth knowing

- **Markdown rendering** moved from the preload into `renderer/markdown.js`,
  with markdown-it and highlight.js vendored as plain browser bundles in
  `renderer/vendor/`. It stays synchronous, so the renderer's
  `innerHTML = renderMarkdown(...)` call sites are untouched. All six custom
  rules (`==mark==`, mermaid fences, `[[wiki-links]]`, image resolution/width/
  figcaption, external link targets, task checkboxes) came across verbatim.
- **Image URLs.** The page can't load `file://` from its own origin, so relative
  image paths now resolve to Tauri asset URLs. `exports.rs` decodes those back
  to real paths for HTML inlining, and rewrites them to `file://` for the print
  pass. Legacy `file://` URLs still decode, so previously exported HTML is
  unaffected.
- **Drag-and-drop attachments.** Electron exposed a dropped file's path via the
  non-standard `webUtils.getPathForFile`. WebView2 has no equivalent, so
  `getPathForFile()` returns `''` and `app.js` takes its existing byte-copy
  branch — the same attachment lands in the same place, copied rather than read
  from its original path.
- **`alert()` / `confirm()`** work in WebView2 (they don't in WKWebView), so the
  renderer's 16 call sites needed no change. This is a Windows-only build; that
  shortcut would not survive a macOS port.
- **Spell check** is WebView2's own, including the suggestions context menu, so
  the hand-rolled Electron context-menu handler is gone.
- **CSP.** `launcher.html`, `scratchpad.html` and `region-select.html` declared
  `script-src 'unsafe-inline'`, which blocked the new bridge script. They now
  allow `'self'` and the Tauri IPC endpoint.

## Verification

- `cargo test` — 104 unit tests over the ported logic: frontmatter parsing,
  wiki-link rewriting (including the ambiguity rules), ordering, trash, history,
  search ranking and snippet offsets, template variables, capture, export URL
  handling, accelerator translation, screenshot cropping.
- `npm run test:renderer` — the markdown pipeline check plus the pre-existing
  333-check UI suite and 24-check launcher suite, unchanged and passing against
  the shared renderer.
- `cargo clippy -- -D warnings` and a `--target x86_64-pc-windows-msvc` check
  run in CI on a Windows runner, which is also where the release exe is built.
