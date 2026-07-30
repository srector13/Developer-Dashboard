# Dev Hub

A portable Windows desktop app that acts as a single hub for full-stack development
work: a global quick launcher plus a dashboard that aggregates live signal from the
things you already work in — git repos, running services, markdown notes.

One `.exe`. No installer, no admin rights, no runtime to install. Drop it on a
locked-down corporate Windows 11 box and run it.

Built as a sibling to [Markdown Notebook](https://github.com/srector13/markdown-notebook):
same stack (Tauri v2 + Rust + a vanilla-JS renderer), same design tokens, same
launcher chrome and keyboard model. The two apps also find each other — see
[Notebook discovery](#notebook-discovery).

---

## Download

**[Dev-Hub-beta-win-x64-portable.exe](https://github.com/srector13/Developer-Dashboard/releases/download/beta/Dev-Hub-beta-win-x64-portable.exe)**

That URL is permanent. Every push rebuilds it, so testing a change is *download,
overwrite, run* — no hunting for a release page. Your settings and config live in
a `DevHubData` folder beside the exe and survive the swap.

Requires the Microsoft Edge WebView2 runtime, which ships with Windows 10 (from
the 2020 updates) and Windows 11. The build is unsigned, so SmartScreen will warn
on first run.

---

## The idea

Everything in the app is a **provider** that yields **items** that carry
**actions**:

- The **launcher** is every provider's items flattened and fuzzy-matched.
- The **dashboard** is the same items rendered as cards.

There is deliberately no second code path for "dashboard data" versus "launcher
data" — both read the same cache, so a row in one can never disagree with a row
in the other.

### v1 providers

| Provider | What it shows | Refresh |
| --- | --- | --- |
| `launch` | Static apps, URLs and folders from your config | On config change |
| `projects` | Git repos found under your roots — branch, dirty flag, ahead/behind, last-commit age | 120s |
| `todos` | Unchecked `- [ ]` lines in your markdown notes, with `#tags` and `@due` dates | On note change, 300s floor |
| `health` | HTTP checks against endpoints you list — status code and latency | Configurable, 60s default |
| `command` | **The escape hatch.** Runs any command on an interval and reads stdout as JSON items | Configurable |

The `command` provider is what makes this extensible without a plugin API. If a
thing has a CLI — `gh pr list`, a kubectl one-liner, a company script — it can be
a card and a launcher source with a config block and no recompile.

---

## Configuration

Two files in `DevHubData/`, next to the exe (falling back to `%APPDATA%\DevHub`
if that folder isn't writable):

- **`settings.json`** — app state: theme, shortcut, which providers are on.
- **`hub.config.json`** — your content: projects, URLs, endpoints, todo sources.

They are separate so you can hand-edit (and version) the config without dragging
app state along. `hub.config.json` is watched: save it and the providers reload.
No restart to add a project root.

Open it from the tray (*Edit hub.config.json*) or the dashboard's **Config**
button. A first run writes a starter file full of worked examples.

```jsonc
{
  "launch": [
    { "title": "IntelliJ IDEA", "icon": "app",
      "run": { "program": "C:\\Program Files\\JetBrains\\IntelliJ IDEA\\bin\\idea64.exe" } },
    { "title": "Jenkins", "icon": "web", "url": "https://jenkins.example.com",
      "keywords": ["ci", "build"] }
  ],
  "projects": {
    "roots": ["C:\\dev", "C:\\work\\repos"],
    "maxDepth": 3,
    "openWith": [
      { "label": "IntelliJ", "program": "C:\\...\\idea64.exe", "args": ["{path}"] },
      { "label": "VS Code",  "program": "code",   "args": ["{path}"] },
      { "label": "Terminal", "program": "wt.exe", "args": ["-d", "{path}"] }
    ]
  },
  "todos": {
    "roots": [],                 // empty → follow the Markdown Notebook pointer
    "includeTags": [],           // empty → every todo
    "openWith": { "program": "code", "args": ["-g", "{path}:{line}"] }
  },
  "health": {
    "intervalSeconds": 60,
    "timeoutMs": 4000,
    "endpoints": [
      { "name": "API — local", "url": "http://localhost:8080/actuator/health", "expect": 200 }
    ]
  },
  "command": []
}
```

`{path}` and `{line}` are substituted in `args`. A program without a `.exe`
extension is launched through `cmd /C`, so PATH shims like `code` and `npm`
resolve.

### Notebook discovery

When `todos.roots` is empty, Dev Hub reads
`%USERPROFILE%\.markdown-notebook\last-notebook.json` — the per-user pointer
Markdown Notebook writes — and scans that notebook. Open a notebook in one app
and the other finds it with zero configuration. Dev Hub only ever reads that
file; it never writes it.

The notebook roots are watched too, so ticking a checkbox in Markdown Notebook
updates the Todos card within a second or two rather than waiting out the
refresh interval. The watcher ignores everything the provider wouldn't read —
`.git`, `attachments`, `templates`, non-markdown files — so a `git status` in
your notes repo doesn't trigger a rescan.

### `settings.json`

```jsonc
{
  "theme": "system",
  "launcherShortcut": "CommandOrControl+Shift+Space",
  "keepInTray": true,
  "startMinimized": false,
  "dashboardColumns": 2,
  "providers": { "launch": true, "projects": true, "todos": true, "health": true },
  "ai": { "enabled": false, "provider": "openai-compatible", "baseUrl": "", "model": "" }
}
```

Both files are merged onto their defaults on read, so a partial or hand-trimmed
file never silently loses keys.

> The `ai` block is inert in v1. It exists so an AI panel can be added later
> without a settings migration.

---

## Keyboard

**Launcher** — <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> by default.

| Key | Does |
| --- | --- |
| <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> | Cycle modes (All · Projects · Launch · Todos · Health) |
| <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>5</kbd> | Jump straight to a mode |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move the selection |
| <kbd>Enter</kbd> | Run the item's default action |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Open the item's full action menu |
| <kbd>Esc</kbd> | Leave the action menu, or hide the launcher |

Matching is a fuzzy subsequence over title, subtitle and hidden keywords, scored
by contiguity and word-boundary starts, with prefix matches first. Things you
launch often get a small recency nudge — enough to break ties, never enough to
promote a worse match.

Closing the dashboard window leaves Dev Hub in the tray so the hotkey stays live.

---

## Privacy and portability

- One `.exe`, no installer, no elevation.
- All state in `DevHubData/` beside the exe. Nothing is written outside it.
- **No outbound network calls** except: the health endpoints you configure, the
  `command` providers you configure, and URLs you explicitly open. No update
  check, no telemetry, no analytics.
- A strict CSP on both windows; no remote script or font origins. Fonts are
  vendored.
- Action execution is backend-only: the renderer sends an item key and an action
  index and can never name a program to run. The only programs that can start are
  ones your own config described.
- Fail soft everywhere — a missing config key, an unreachable root, a repo with
  no upstream all produce readable text on a card, never a panic or a blank app.

---

## Development

```bash
npm install
npm run dev            # cargo tauri dev
npm run build          # cargo build --release
npm run check          # cargo check
npm run test:rust      # backend unit tests
npm run test:renderer  # launcher + dashboard specs, node-run in Chromium
npm run icons          # regenerate the icon set from build/icon.svg
npm run fonts:sync     # re-copy the vendored fonts from @fontsource
```

CI runs the renderer suite and the Rust tests on Linux, then `cargo fmt --check`,
`cargo clippy -- -D warnings`, the tests and a release build on Windows.

### Layout

```
src-tauri/src/
├─ main.rs        builder wiring, tray, lifecycle
├─ commands.rs    every #[tauri::command] + the action executor
├─ desktop.rs     launcher window, tray, global shortcut, config watcher
├─ settings.rs    portable settings + hub.config.json
├─ state.rs       AppState — settings, config, provider cache, usage
├─ model.rs       Item / Action / ProviderResult
├─ registry.rs    provider registry, refresh loops, hot reload
├─ search.rs      the fuzzy matcher
├─ util.rs        clock, relative ages, remote-URL normalisation
└─ providers/     mod.rs (the trait) + launch, projects, todos, health, command

renderer/
├─ index.html + app.js    the dashboard
├─ launcher.html          the quick launcher
├─ api-tauri.js           the renderer↔Rust bridge
├─ icons.js               the fixed icon set
└─ style.css              tokens + component classes
```

**Adding a provider** is a new file in `providers/`, a `pub mod` line, a config
block in `settings.rs`, and one line in `registry::build`. That is the whole
seam.

### Deliberately deferred

- **Calendar.** Not implemented. The provider seam is kept clean so an ICS feed,
  an Outlook COM shell-out, or an MSAL device-code flow can land as one new file
  and a config block.
- **AI panel.** Not in v1. The intended implementation is a generic
  OpenAI-compatible client with a configurable `baseUrl` and `model` — never a
  hardcoded vendor.

---

## Releases

- **Beta** — every push to `main` or a `claude/**` branch rebuilds the rolling
  `beta` release. Permanent download URL, always the newest build.
- **Versioned** — pushing a `v*` tag builds and attaches a portable exe. A semver
  prerelease (`v0.2.0-beta.1`) publishes immediately; a plain tag (`v0.2.0`)
  lands as a draft for review.

## Licence

MIT
