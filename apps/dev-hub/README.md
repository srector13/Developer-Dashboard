# Dev Hub

A portable Windows desktop app that acts as a single hub for full-stack development
work: a global quick launcher plus a dashboard that aggregates live signal from the
things you already work in — git repos, running services, markdown notes.

One `.exe`. No installer, no admin rights, no runtime to install. Drop it on a
locked-down corporate Windows 11 box and run it.

Part of [Dev Suite](../../README.md): same stack (Tauri v2 + Rust + a
vanilla-JS renderer), the same design tokens and launcher chrome as
[Log Viewer](../log-viewer/) and
[Markdown Notebook](https://github.com/srector13/markdown-notebook), and a
shared registry that lets them find and launch each other — see
[Finding the rest of the suite](#finding-the-rest-of-the-suite).

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

## The dashboard

Cards sit on a grid, each in one of three sizes — **S**, **M**, **L** — chosen
from the control that appears when you hover a card. Sizes are whole numbers of
grid rows and columns, so rows always line up; a large card takes two columns
where there are two to take. Drag a card by its header to rearrange, and the
rest close up around it. Both are remembered.

Each provider has its own colour, so a card is identifiable before you've read
its title. Cards show their items as a **list** or a **grid** of tiles —
whichever suits what's on them.

### Making items yours

Right-click any item, or use its **⋯** button, to give it a nickname, an icon,
a colour, or to hide it. Left-click still runs it — that's the point of the app,
and a click that sometimes launches and sometimes opens a menu would make the
primary action feel unreliable.

A nickname is searched as well as displayed, so renaming something to what you
actually call it makes it findable by that name. Hidden items are listed in
Settings → General, with a button to bring each one back.

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
| `health` | HTTP checks against endpoints you list — status code, latency, and a warning when a service answers but slowly | Configurable, 60s default |
| `logs` | Log files you name — size, last write, and a warning when one goes quiet. Opens in Log Viewer | 60s |
| `command` | **The escape hatch.** Runs any command on an interval and reads stdout as JSON items | Configurable |

The `command` provider is what makes this extensible without a plugin API. If a
thing has a CLI — `gh pr list`, a kubectl one-liner, a company script — it can be
a card and a launcher source with a config block and no recompile.

---

## Configuration

**Everything is editable in the app** — press **Settings** in the top strip. Apps
and links, repo folders, services to watch, the launcher hotkey, and custom
command cards all have forms, with Browse buttons so no Windows path has to be
typed by hand. Nothing below is required reading unless you prefer files.

Behind the UI are two files in `DevHubData/`, next to the exe (falling back to
`%APPDATA%\DevHub` if that folder isn't writable):

- **`settings.json`** — app state: theme, shortcut, which providers are on.
- **`hub.config.json`** — your content: projects, URLs, endpoints, todo sources.

They are separate so you can hand-edit (and version) the config without dragging
app state along. `hub.config.json` is watched: save it and the providers reload,
whether the edit came from the settings screen or your editor. No restart to add
a project root.

> Saving from the settings forms rewrites `hub.config.json` from the parsed
> shape, which drops comments and any keys the forms don't cover. Settings →
> **Advanced** keeps a raw text editor that saves the file verbatim if you want
> to keep comments.

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
  "logs": {
    "intervalSeconds": 60,
    "staleAfterMins": 15,        // 0 disables the quiet warning
    "files": [
      { "name": "api", "path": "C:\\services\\payments\\logs\\application.log" }
    ]
  },
  "command": []
}
```

`{path}` and `{line}` are substituted in `args`. A program without a `.exe`
extension is launched through `cmd /C`, so PATH shims like `code` and `npm`
resolve.

### The Logs card

Dev Hub never reads these files — it checks their size and when they were last
written. Clicking a row hands the path to whichever installed app advertises
that it can tail a file, found through the
[suite registry](../../README.md#put-them-in-the-same-folder). Dev Hub is not
told that Log Viewer exists, so a different tool registering the same capability
takes the action over with nothing to change here. With nothing installed that
can tail, the rows still reveal and copy.

A log that has not been written to for `staleAfterMins` is flagged **quiet**.
A service that stops logging is often the first sign of trouble, and no health
check will tell you about it — the port still answers. It is a warning rather
than an error, because a low-traffic service being quiet over lunch is not a
fault, and it can be switched off per file for a log that is *supposed* to be
silent.

### Finding the rest of the suite

Dev Hub writes one entry into `%USERPROFILE%\.dev-suite\registry.json` on
startup and reads the others. That is how it finds Log Viewer, and how the other
apps find it. The format is in the
[suite README](../../README.md#put-them-in-the-same-folder).

When `todos.roots` is empty, Dev Hub follows whatever notebook the registry
names — falling back to `%USERPROFILE%\.markdown-notebook\last-notebook.json`,
the per-user pointer Markdown Notebook wrote before the registry existed, so an
un-migrated notebook keeps working untouched. Dev Hub only ever reads that; it
never writes it. Open a notebook in one app and the other finds it with zero
configuration.

The notebook roots are watched too, so ticking a checkbox in Markdown Notebook
updates the Todos card within a second or two rather than waiting out the
refresh interval. The watcher ignores everything the provider wouldn't read —
`.git`, `attachments`, `templates`, non-markdown files — so a `git status` in
your notes repo doesn't trigger a rescan.

Clicking a todo opens its note **on the line**. Dev Hub looks for Markdown
Notebook on disk — beside its own exe first, since the two ship as portable
siblings — and calls it as
`Markdown-Notebook.exe --line 42 --view edit "C:\notes\alpha.md"`. Set
`todos.openWith` only to override that; leaving it unset is what lets the
lookup keep working if either app moves.

Aggregate notes — `*.toc.md`, `*.tasks.md`, and generated folder indexes — are
skipped, because they list todos that live in other files and would otherwise
report each one twice. Identical todos are also collapsed, keeping the copy in
the note you'd actually edit. Both are adjustable in Settings → Todos.

### `settings.json`

```jsonc
{
  "theme": "system",
  "launcherShortcut": "CommandOrControl+Shift+Space",
  "launcher": {
    "opacity": 0.88,               // 0.5–1.0
    "showHints": true,
    "modes": ["all", "projects", "launch", "todos", "health", "logs"],
    "maxResults": 40,
    "showRecentWhenEmpty": true
  },
  "keepInTray": true,
  "startMinimized": false,
  "runAtLogin": false,
  "notifyOnFailure": false,
  "dashboardColumns": 2,
  "providers": { "launch": true, "projects": true, "todos": true, "health": true, "logs": true },
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
| <kbd>/</kbd> | List commands — `/projects`, `/apps`, `/todos`, `/health`, `/logs`, `/all` |
| <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> | Cycle modes (All · Projects · Launch · Todos · Health · Logs) |
| <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>6</kbd> | Jump straight to a mode |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move the selection |
| <kbd>Enter</kbd> | Run the item's default action — named on the selected row |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Open the item's full action menu |
| <kbd>Esc</kbd> | Leave the commands or action menu, or hide the launcher |

Typing `/` opens the command list; typing narrows it, and <kbd>Tab</kbd> or
<kbd>Enter</kbd> picks. Aliases work too — `/repos`, `/p`, `/a`, `/t`.

Tailing a log is the shortest path this buys you: hotkey, type the log's name,
<kbd>Enter</kbd>, and it opens in Log Viewer.

Settings → **Quick Launch** holds the rest of it: the hotkey, how opaque the
panel is (it floats over whatever you summoned it from, so how transparent is
too transparent depends on what you keep on screen), whether the keyboard hints
along the bottom are shown, which modes get an orb, and how many matches a
search reaches for. Changes reach an open launcher immediately.

Matching is a fuzzy subsequence over title, subtitle and hidden keywords, scored
by contiguity and word-boundary starts, with prefix matches first. Things you
launch often get a small recency nudge — enough to break ties, never enough to
promote a worse match.

Closing the dashboard window leaves Dev Hub in the tray so the hotkey stays live.

### If the hotkey does nothing

Another application already owns the combination. Windows gives no warning — it
simply doesn't deliver the key, and the app never hears about it either.

Settings → **General** shows whether the hotkey actually registered, and offers
combinations that rarely clash. **Open the launcher now** in that panel bypasses
the hotkey entirely, so it tells you whether the problem is the shortcut or the
launcher itself. The tray menu and the dashboard's search box are the other two
ways in.

---

## Privacy and portability

- One `.exe`, no installer, no elevation.
- All state in `DevHubData/` beside the exe, plus one entry in the shared
  registry under `%USERPROFILE%\.dev-suite\`. Nothing is written elsewhere.
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

From the repository root:

```bash
npm install
npm run dev:hub              # cargo tauri dev
npm run build:hub            # cargo build --release -p dev-hub
cargo test -p dev-hub        # backend unit tests
npm run test:renderer:hub    # launcher, dashboard, settings and setup specs
npm run icons dev-hub        # regenerate this app's icon set
```

See the [suite README](../../README.md#development) for the workspace-wide
scripts and what CI runs.

### Layout

```
src-tauri/src/
├─ main.rs        builder wiring, tray, lifecycle
├─ commands.rs    every #[tauri::command] + the action executor
├─ desktop.rs     launcher window, tray, global shortcut, config watcher
├─ settings.rs    portable settings + hub.config.json
├─ state.rs       AppState — settings, config, provider cache, usage
├─ registry.rs    provider registry, refresh loops, hot reload
├─ util.rs        git remote URLs; the rest re-exported from suite-core
└─ providers/     mod.rs (the trait) + launch, projects, todos, health, logs, command

renderer/
├─ index.html + app.js    the dashboard
├─ launcher.html          the quick launcher
├─ api-tauri.js           the renderer↔Rust bridge
└─ style.css              component classes; palette from ui/tokens.css
```

`Item`, `Action`, the fuzzy matcher, the portable-directory logic and the
settings merge live in the suite's shared crates — see
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

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
- **Reading log contents.** The Logs card stats files; tailing them is
  Log Viewer's job. Two apps rendering the same log two different ways is how a
  suite stops feeling like one product.

---

## Releases

Dev Hub ships with the rest of the suite from one build of one workspace — see
the [suite README](../../README.md).

## Licence

MIT
