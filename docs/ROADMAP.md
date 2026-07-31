# Dev Hub roadmap

Ordered by what makes the app better per hour of work, not by what's most fun to
build. Each phase is independently shippable — nothing here needs the phase after
it to be useful.

The through-line: Dev Hub answers two questions — *what should I do next* and *is
anything broken*. A feature earns its place by making one of those answers faster
or more trustworthy. Features that just add surface get cut.

---

## Phase 1 — Make it trustworthy

The things that decide whether you keep the app open after week one.

**Run it at login.** A launcher you have to launch is a launcher you forget.
A Windows startup shortcut, toggled from Settings, plus `startMinimized` so it
goes straight to the tray. Small, and it changes the app from "a thing I open"
to "a thing that's there".

**A first-run screen.** Right now a fresh exe shows four cards, three of them
empty, and the config that would fill them is a file you have to find. Replace
that with: pick your repo folder, name one service, done — with everything else
discoverable later in Settings.

**Detect what's already installed.** On first run, look for `idea64.exe`,
`code.cmd`, `wt.exe`, `git` in their usual places and offer them as openers
instead of asking for paths. The single largest source of "I configured it and
nothing happened" is a typo'd program path.

**Health checks that say more than up/down.** Response-time history as a
sparkline on the row, and a flip to `Warn` when latency degrades rather than only
when the endpoint dies. A service that answers in 4s instead of 40ms is broken in
the way that actually costs you an afternoon.

**Notifications, sparingly.** A tray notification when a watched service goes
from OK to failing, off by default and rate-limited. This is the feature that
lets the dashboard stay closed and still be useful.

---

## Phase 2 — More of what you already look at

New providers, each following the existing seam: one file, one config block, one
line in `registry::build`.

**Pull requests.** The single highest-value card for full-stack work: what's
waiting on you, what you're blocking. Ships today via the `command` provider
(`gh pr list --json …`), which is worth doing first to learn the shape — then a
native provider with auth handled properly and review state in the badges.

**CI status.** Last build result per repo, so a red `main` is visible without
opening Jenkins. Jenkins and GitHub Actions cover most of it; the seam is a
generic "poll a URL, map JSON to items" provider so anything else is config.

**Calendar.** The one the spec deliberately deferred. In order of likelihood:
a published ICS feed (a plain GET and an ICS parse — no auth story, works on a
locked-down tenant), then MSAL device-code against a pre-consented client ID with
`Calendars.Read`. Outlook COM via PowerShell is a dead end on the new Outlook
client and should be tried last, if at all.

**Docker / local services.** Which containers are running, one-click logs. On a
full-stack machine this answers "is anything broken" more often than any HTTP
check does.

**Recent files and branches.** Files you touched today across all repos, and
branches you've had checked out — both come free from data already being read,
and both are things you hunt for constantly.

---

## Phase 3 — Make the launcher earn its hotkey

**Actions, not just navigation.** Typing `git pull` on a selected repo, or
`restart` on a service. The `Action` model already supports it; what's missing is
a grammar in the launcher for verb-then-object.

**Inline results.** Health mode already re-checks inline. Extend that: a repo's
recent commits, a service's last response body, without leaving the window.

**Clipboard-aware.** If a Jira key or a URL is on the clipboard when the launcher
opens, offer it as the first result. Cheap to build, feels like telepathy.

**Frecency, properly.** The current recency boost is deliberately small. With
real usage data, weight by time-of-day and by which app is in the foreground —
you open different things at 9am than at 4pm.

---

## Phase 4 — The AI panel

The settings shape is already reserved. The implementation is a generic
OpenAI-compatible client with a configurable `baseUrl` and `model` — never a
hardcoded vendor, so it works against Ollama on your own box, a corporate
endpoint, or nothing at all.

Worth building only for things that beat a search box:

- **Explain this diff** — point it at a dirty repo, get a summary of what changed
  since your last commit. Genuinely useful when returning to work after a week.
- **Draft the commit message** from the staged diff.
- **Summarise the day** — todos due, repos touched, services that flapped.

What it should *not* do is become a chat window. There are plenty of those.

---

## Phase 5 — Polish and reach

**Code signing.** Removes the SmartScreen warning, which matters if this ever
goes beyond your own machines. Needs a certificate.

**Theming beyond dark/light.** The token block is already the only thing that
would need to change.

**A second machine.** Config sync via a file you point both installs at — a
OneDrive path, a git repo — rather than any kind of cloud service. Consistent
with the app making no network calls it wasn't told to make.

**Linux/macOS builds.** The Rust is nearly portable already; the Windows-specific
parts are the foreground workaround and the `cmd` handling. Only worth doing if
you actually want it — the spec is deliberately Windows-first.

---

## Deliberately not doing

- **A plugin API.** The `command` provider covers the same ground with a fraction
  of the surface area, and nothing to keep stable across versions.
- **Auto-update.** A running exe can't replace itself, and a background updater on
  a locked-down corporate box is a support problem, not a feature.
- **Telemetry.** Ever.
- **A note editor.** That's Markdown Notebook. The two apps stay separate and
  find each other.
