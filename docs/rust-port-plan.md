# Rust (Tauri) port — comparison & side-by-side plan

Goal: keep the current Electron app working while standing up a Tauri (Rust)
version of the same app in the same repo, so the two can be compared feature
by feature before committing to either.

## Why Tauri specifically

A "Rust rewrite" does not mean rewriting the UI. Tauri keeps the entire
`renderer/` (HTML/CSS/JS) as-is and only replaces the Electron **main
process** with a small Rust binary. The UI renders in the OS WebView
(WebView2 on Windows, WKWebView on macOS) instead of a bundled Chromium —
that is where the ~90 MB savings comes from.

| | Electron (current) | Tauri |
|---|---|---|
| Windows portable exe | ~85–100 MB | ~5–15 MB |
| Runtime | bundled Chromium + Node | OS WebView + Rust binary |
| Renderer code | `renderer/` unchanged | `renderer/` unchanged (~95%) |
| Backend code | `src/main.ts` (~1,050 lines) | rewritten in Rust |
| Rendering consistency | identical everywhere | WebView2 ≈ Chromium on Windows; WKWebView (Safari engine) on macOS — minor CSS differences possible |

## Feature-by-feature: what carries over, what needs care

| Feature | Electron implementation | Tauri equivalent | Risk |
|---|---|---|---|
| File tree scan, read/write, order files | `fs` in main.ts | Rust `std::fs` / `walkdir` | ✅ trivial |
| Settings JSON | `app.getPath('userData')` | `tauri-plugin-store` or `dirs` crate | ✅ trivial |
| Folder picker dialog | `dialog.showOpenDialog` | `tauri-plugin-dialog` | ✅ trivial |
| File watching (auto-refresh) | `fs.watch` recursive | `notify` crate (better than fs.watch) | ✅ improvement |
| Markdown rendering | markdown-it in **preload** | stays in the renderer — bundle markdown-it as a plain JS file, or render with `pulldown-cmark` in Rust | ✅ small refactor |
| Task checkbox toggling | line edit in main.ts | same logic in Rust | ✅ trivial |
| Rename + wiki-link rewriting | regex pass over all files | same regex logic in Rust | ⚠️ medium effort, port carefully with tests |
| Pandoc import (clipboard/doc) | `execFile('pandoc')` | `tauri-plugin-shell` Command (same: shells out to pandoc) | ✅ same behavior |
| Clipboard **HTML** read | `clipboard.readHTML()` | `tauri-plugin-clipboard-manager` reads text; **HTML read needs the community `tauri-plugin-clipboard`** | ⚠️ check early — this powers "Paste Note" |
| PDF export | `webContents.printToPDF` (headless, silent) | **no direct equivalent** — options: `window.print()` (shows OS dialog), or shell out to pandoc/chrome headless | ⚠️ biggest gap; decide before porting |
| Frameless titlebar (`hiddenInset`) | BrowserWindow option | `titleBarStyle: "Overlay"` in tauri.conf | ✅ supported |
| `alert()` / `confirm()` dialogs | work in Electron | **not implemented in WKWebView on macOS** — must swap to `tauri-plugin-dialog` calls | ⚠️ renderer touch-ups needed |

Bottom line: nothing is impossible, but **PDF export** and **clipboard HTML
read** are the two things to prototype first, because they're the only
features without a drop-in equivalent.

## Repo layout for side-by-side versions

```
markdown-notebook/
├── renderer/            # shared UI — used by BOTH shells
│   └── api-adapter.js   # picks window.api impl: Electron preload vs Tauri invoke()
├── src/                 # Electron main process (unchanged)
├── src-tauri/           # Tauri shell
│   ├── tauri.conf.json  # points frontendDist at ../renderer
│   ├── Cargo.toml
│   └── src/main.rs      # Rust commands mirroring the IPC surface 1:1
└── package.json
```

The trick that makes comparison honest: keep the `window.api` surface
(defined in `src/preload.ts`) as the single contract. In Tauri, a small
`api-adapter.js` implements the same ~20 functions via `invoke('read_note')`
etc. The renderer never knows which shell it's running in, so any behavior
difference you spot is genuinely a shell difference.

## Migration order (each step leaves both apps working)

1. `npm create tauri-app` scaffold in `src-tauri/`, pointed at `renderer/`.
2. Move markdown-it rendering out of preload into a renderer-side script
   (both shells benefit; removes the preload dependency).
3. Implement read-only commands in Rust: settings, tree scan, read note.
   → app opens and browses notes. First size comparison possible here.
4. Write commands: save, create (with the metadata modal), delete, order.
5. The two risk items: clipboard HTML import, PDF export. Prototype, decide.
6. Rename/wiki-link rewriting last (most intricate logic).

Estimated Rust surface: ~600–800 lines for parity, mostly mechanical.

## Build & transfer notes

- Tauri Windows builds must be produced on Windows (or via GitHub Actions
  `windows-latest` runner). The output is a single portable `.exe`.
- A ~10 MB exe is small enough for transfer routes that a 90 MB one isn't
  (email to self, OneDrive/SharePoint, USB — whatever the workplace allows).
- If the workplace blocks *running* unsigned executables entirely (AppLocker /
  SmartScreen policy), no framework helps — the fallback is the browser
  version of this app using the File System Access API in Edge, which needs
  no executable at all. The shared-renderer structure above is also the
  first step toward that.
