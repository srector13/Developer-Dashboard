# Log Viewer

A portable Windows log tail: several files at once, merged into one stream in
timestamp order, with saved filters and highlight rules.

One `.exe`. No installer, no admin rights, no runtime to install. Part of
[Dev Suite](../../README.md) — drop it beside Dev Hub and the two find each
other.

## Download

**[Log-Viewer-beta-win-x64-portable.exe](https://github.com/srector13/Developer-Dashboard/releases/download/beta/Log-Viewer-beta-win-x64-portable.exe)**

That URL is permanent — every push rebuilds it. Settings live in a
`LogViewerData` folder beside the exe and survive an overwrite.

---

## Opening a file

Four ways, none of which need configuration:

- **Drop it on the window.**
- **Ctrl+O**, or the **+** button.
- **From Dev Hub** — its Logs card, or the launcher: hotkey, type the log's
  name, Enter.
- **From a command line**: `Log-Viewer.exe C:\services\api\logs\application.log`,
  or `--file <path>` repeated. A second launch hands its files to the running
  window rather than starting a second process.

Files opened this way are for the session only — looking at a log once is not a
preference. The **pin** button on a source keeps it in `logs.config.json` so it
comes back next time.

## The merged view

Several files tailed at once are shown as one stream, ordered by the timestamp
on each line rather than by the order the bytes arrived. Two services writing
two files share no clock, so ingest order is not time order.

The part that is easy to get wrong: the second and subsequent lines of a stack
trace carry no timestamp at all, and sorting those by "no timestamp" scatters
them to the top of the view. Here an untimestamped line inherits the position of
the line above it *from its own source*, so every trace stays intact, in order,
directly under the line that threw. Those lines are indented and dimmed, and
show no clock of their own — they have a position, not a time.

Recognised timestamp formats:

```text
2024-05-01T12:34:56.789Z          ISO-8601, with or without a zone
2024-05-01T12:34:56.789+01:00
2024-05-01 12:34:56,789           logback / log4j default
2024/05/01 12:34:56
[2024-05-01 12:34:56]             bracketed
12:34:56.789                      bare time — resolved against today's date
```

A line with no recognisable timestamp is not a problem; it just takes the
position of the line above it.

## Filtering

| Control | Does |
| --- | --- |
| **Filter** | Lines must match this to show. Substring by default. |
| **Exclude** | Lines matching this are hidden even if they matched the filter. |
| **.\*** | Treat both as regular expressions. |
| **Aa** | Match case. |
| **Level** | Hide anything below a severity. |

Exclude is the one that does the real work during an incident — a health-check
endpoint logging every second buries everything else.

A level floor never hides a line whose level couldn't be read. Filtering to
`error` is exactly when you need the stack trace, and its continuation lines
carry no level token.

An invalid regular expression is reported inline, naming which of the two boxes
is wrong. The previous results stay on screen: blanking the window on every
keystroke of a half-typed `(\d` would make the feature unusable.

Filters you want back live in `logs.config.json` under `filters`, and appear in
the sidebar.

## Highlight rules

Colouring, never hiding — lines you want to spot while scrolling past
everything else. Errors and warnings are coloured out of the box; the rest is
config. The first matching rule wins, so the order in the list is how you decide
which one takes precedence.

## Following

On by default. Scrolling up turns it off and offers **Jump to newest**;
scrolling back to the bottom turns it on again. Nothing moves the viewport while
you are reading, which is the single most annoying thing a log viewer can do.

## Rotation

When `app.log` becomes `app.log.1` and a new `app.log` appears, the view marks
the boundary and carries on from the new file. Truncation in place (`> app.log`)
is handled the same way. Neither replays lines you have already seen.

## Keyboard

| Key | Does |
| --- | --- |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> or <kbd>/</kbd> | Focus the filter box |
| <kbd>Ctrl</kbd>+<kbd>O</kbd> | Open a file |
| <kbd>Ctrl</kbd>+<kbd>L</kbd> | Clear the buffer |
| <kbd>F</kbd> | Toggle following |
| <kbd>End</kbd> | Jump to newest |
| <kbd>Esc</kbd> | Leave the filter box |

---

## Configuration

Two files in `LogViewerData/`, beside the exe (falling back to
`%APPDATA%\LogViewer` if that folder isn't writable):

- **`settings.json`** — app state: theme, wrapping, poll interval, buffer size.
- **`logs.config.json`** — your content: which files, which filters, which
  highlight rules.

They are separate so the config can be hand-edited and version-controlled
without dragging app state along. Both are merged onto their defaults on read,
so a partial file never silently loses keys.

```jsonc
{
  "sources": [
    { "name": "api", "path": "C:\\services\\payments\\logs\\application.log", "colour": "blue" },
    { "name": "worker", "path": "C:\\services\\worker\\logs\\application.log", "colour": "teal" }
  ],
  "filters": [
    { "id": "errors", "name": "Errors only", "minLevel": "error" },
    { "id": "quiet", "name": "No health checks", "exclude": "/actuator/health" }
  ],
  "highlights": [
    { "id": "error", "name": "Errors", "pattern": "\\b(ERROR|FATAL|Exception)\\b",
      "regex": true, "caseSensitive": true, "colour": "red" }
  ]
}
```

Colours are names, not values — `blue`, `teal`, `violet`, `amber`, `green`,
`pink` — so a config file can never put a raw value into a style attribute.

### `settings.json`

```jsonc
{
  "theme": "system",
  "wrap": false,             // off: wrapping makes the row count stop matching the line count
  "showTimestamps": true,
  "showSource": true,
  "showLevel": true,
  "pollIntervalMs": 250,     // 50–5000
  "follow": true,
  "capacity": 500000,        // lines held in memory
  "window": 2000,            // lines handed to the window at once
  "fontSize": 12
}
```

## Memory

The buffer is bounded. A viewer pointed at a service logging 20k lines a second
must not grow until the machine swaps, so lines are held in a ring and the
oldest fall off — the status bar says **scrollback trimmed** when that has
happened. What you lose is what has already scrolled past, which is what the
file on disk is for.

Opening an existing file starts near its end rather than reading all of it: the
interesting part of a 2GB log is the last part. A source's **refresh** button
re-reads it from the top when that is genuinely what you want.

---

## Development

From the repository root:

```bash
npm run dev:logs             # cargo tauri dev
npm run build:logs           # cargo build --release -p log-viewer
cargo test -p log-viewer     # backend tests
npm run test:renderer:logs   # the renderer spec, node-run in Chromium
```

### Layout

```
src-tauri/src/
├─ main.rs      Tauri wiring, CLI, the poll loop
├─ commands.rs  every #[tauri::command]
├─ tail.rs      incremental reads, rotation, partial lines
├─ parse.rs     timestamp and level extraction
├─ line.rs      what a parsed line is
├─ store.rs     the ring buffer and the merge
├─ filter.rs    compiled filters and highlight rules
├─ settings.rs  portable settings + logs.config.json
├─ state.rs     what is being watched
└─ cli.rs       --file / --follow

renderer/
├─ index.html + app.js   the window
├─ api-tauri.js          the renderer↔Rust bridge
└─ style.css             component classes; palette from ui/tokens.css
```

`suite-core`, `suite-config` and `suite-registry` hold everything shared with
the rest of the suite — see [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

## Licence

MIT
