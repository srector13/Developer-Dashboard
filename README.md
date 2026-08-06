# Dev Suite

Portable Windows developer tools that behave like one product. No installer, no
admin rights, no runtime to install — drop the `.exe`s on a locked-down
corporate Windows 11 box and run them.

| App | What it is | Download |
| --- | --- | --- |
| **[Dev Hub](apps/dev-hub/)** | A global quick launcher plus a dashboard aggregating live signal from git repos, running services, markdown notes and log files. | [`Dev-Hub-beta-win-x64-portable.exe`](https://github.com/srector13/Developer-Dashboard/releases/download/beta/Dev-Hub-beta-win-x64-portable.exe) |
| **[Log Viewer](apps/log-viewer/)** | A multi-file tail with saved filters, highlight rules and timestamp alignment across sources. | [`Log-Viewer-beta-win-x64-portable.exe`](https://github.com/srector13/Developer-Dashboard/releases/download/beta/Log-Viewer-beta-win-x64-portable.exe) |
| **[Markdown Notebook](apps/markdown-notebook/)** | Local-first markdown notes — one folder of plain files, no account, no sync. | [`Markdown-Notebook-beta-win-x64-portable.exe`](https://github.com/srector13/Developer-Dashboard/releases/download/beta/Markdown-Notebook-beta-win-x64-portable.exe) |

Those URLs are permanent. Every push rebuilds them, so testing a change is
*download, overwrite, run*. Each app's state lives in a folder beside its own
exe and survives the swap.

Requires the Microsoft Edge WebView2 runtime, which ships with Windows 10 (from
the 2020 updates) and Windows 11. The builds are unsigned, so SmartScreen will
warn on first run.

---

## Put them in the same folder

That is the whole setup. The apps then find each other:

- Dev Hub's **Logs** card opens a file in Log Viewer — one click, or the hotkey
  and the log's name.
- Open a notebook in Markdown Notebook and Dev Hub's **Todos** card follows it,
  with no path configured anywhere — and clicking a todo opens the note *on the
  line the todo is on*.
- Each app can launch its siblings.

None of this is hardcoded. Every app writes one entry into
`%USERPROFILE%\.dev-suite\registry.json` on startup — who it is, where its exe
is, and what it can be asked to do — and reads the others. Dev Hub does not ask
for "Log Viewer"; it asks for something that can `tail-file`. A new tool that
registers the same capability takes the action over without either app being
changed.

```jsonc
{
  "version": 1,
  "apps": {
    "dev-hub": {
      "id": "dev-hub", "name": "Dev Hub",
      "exe": "C:\\tools\\Dev-Hub.exe", "version": "0.2.0-beta.1",
      "capabilities": ["launcher", "dashboard"],
      "registeredAt": 1772899200
    },
    "log-viewer": {
      "id": "log-viewer", "name": "Log Viewer",
      "exe": "C:\\tools\\Log-Viewer.exe", "version": "0.2.0-beta.1",
      "capabilities": ["tail-file"],
      "registeredAt": 1772899215
    },
    "markdown-notebook": {
      "id": "markdown-notebook", "name": "Markdown Notebook",
      "exe": "C:\\tools\\Markdown-Notebook.exe", "version": "1.5.0-beta.15",
      "capabilities": ["open-note-at-line"],
      "registeredAt": 1772899230
    }
  },
  "notebookRoot": "C:\\notes"
}
```

Each app carries its own version, deliberately — they are at different points
in their lives, and a shared number would either push a mature app backwards or
claim maturity a young one hasn't earned. What has to agree is the registry's
own `version`, and that is checked where it is read.

Nothing is ever pruned from it: an exe on a USB stick that isn't plugged in is
missing, not gone. A registered path that no longer resolves is skipped, not
deleted. And a missing registry is normal — on a fresh box that is the truth,
so every read returns an empty one rather than an error.

The older pointer file (`%USERPROFILE%\.markdown-notebook\last-notebook.json`)
is still written and read alongside, so a build of any app that predates the
registry keeps working.

---

## Layout

```
crates/
├─ suite-core/       Item · Action · Status · ProviderResult · fuzzy search
├─ suite-config/     portable data dir, merge-onto-defaults, load/save
└─ suite-registry/   the %USERPROFILE%\.dev-suite\registry.json above

ui/                  design tokens, the icon set, the vendored fonts
apps/
├─ dev-hub/            → dev-hub.exe
├─ log-viewer/         → log-viewer.exe
└─ markdown-notebook/  → markdown-notebook.exe
```

`suite-core` and `suite-config` carry **no Tauri dependency**, on purpose: they
build and test in seconds with no system libraries, and CI proves it in a
separate job so the boundary can't erode quietly.

`ui/` is copied into each app's renderer rather than imported from it, because
Tauri serves one directory as the whole frontend root and nothing above it is
addressable at runtime. The copies are committed so a fresh clone builds with
cargo alone; `npm run ui:check` fails CI if they drift.

Why one repository rather than three, and what it cost:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Development

```bash
npm install
npm run dev:hub        # cargo tauri dev, Dev Hub
npm run dev:logs       # cargo tauri dev, Log Viewer
npm run dev:notes      # cargo tauri dev, Markdown Notebook
npm run build          # all three release exes
npm run check          # cargo check, whole workspace
npm run lint           # clippy, warnings as errors
npm run test:rust      # every backend + crate test
npm run test:renderer  # every renderer spec, node-run in Chromium
npm run ui:sync        # re-copy ui/ into the apps
npm run ui:check       # fail if those copies have drifted
npm run icons          # regenerate every app's icon set
npm run fonts:sync     # re-copy the vendored fonts from @fontsource
```

Building one app: `cargo build -p log-viewer`. Testing one crate:
`cargo test -p suite-core`.

CI runs the renderer suites, the workspace tests and a standalone build of the
shared crates on Linux, then `cargo fmt --check`, clippy, the tests and all
three release exes on Windows.

### Adding an app

1. `apps/<name>/src-tauri` as a workspace member, depending on the crates it
   needs.
2. Add it to `APPS` in `scripts/render-icons.mjs` and `scripts/sync-ui.mjs`.
3. Call `suite_registry::register` at startup with the capabilities it offers.
4. Add its exe to the two release workflows.

Discovery, cross-launch, the design language and the settings behaviour come
for free from steps 1 and 3.

---

## Privacy and portability

- One `.exe` per app. No installer, no elevation.
- All state beside the exe (`DevHubData`, `LogViewerData`,
  `MarkdownNotebookData`), plus the shared registry under `%USERPROFILE%`.
  Nothing is written anywhere else.
- **No outbound network calls** except the health endpoints and `command`
  providers you configure yourself, and URLs you explicitly open. No update
  check, no telemetry, no analytics.
- A strict CSP on every window; no remote script or font origins. Fonts are
  vendored.
- Action execution is backend-only: a renderer sends an item key and an action
  index, or a source id — it can never name a program to run or a path to read.
- Fail soft everywhere. A missing config key, an unreachable root, a log file
  that doesn't exist yet all produce readable text, never a panic or a blank
  window.

## Licence

MIT
