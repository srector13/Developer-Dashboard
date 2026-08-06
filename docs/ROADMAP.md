# Dev Suite roadmap

Ordered by what makes the suite better per hour of work, not by what's most fun
to build. Each phase is independently shippable — nothing here needs the phase
after it to be useful.

The through-line for **Dev Hub**: it answers two questions — *what should I do
next* and *is anything broken*. A feature earns its place by making one of those
answers faster or more trustworthy. Features that just add surface get cut.

The through-line for the **suite**: a new tool should cost a weekend, not a
month, and should feel like part of the same product on the day it ships. That
is what the shared crates and the registry are for — see
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## Phase 1 — Make it trustworthy ✅ *shipped*

The things that decide whether you keep the app open after week one.

- **Run it at login.** ✅ A value under the per-user Run key, toggled from
  Settings. Starts in the tray, so nothing opens over your desktop.
- **A first-run screen.** ✅ Two questions — where your repos are, which editor
  opens them — with everything else filled in from what it can see. Skippable,
  and never returns uninvited.
- **Detect what's already installed.** ✅ IntelliJ (including Toolbox layouts),
  Rider, VS Code, Windows Terminal, found in their usual places and offered as
  openers rather than asked for as paths.
- **Health checks that say more than up/down.** ✅ A configurable latency
  threshold flips a service to `Warn` while it's still returning 200.
  *Still outstanding:* response-time history as a sparkline on the row.
- **Notifications, sparingly.** ✅ A desktop notification when a watched service
  goes from OK to failing, only on the transition, off by default.

---

## Phase 1.5 — One suite ✅ *shipped*

The connective tissue, built before app #4 rather than after it.

- **A Cargo workspace.** ✅ `suite-core`, `suite-config` and `suite-registry`,
  with the apps as members. The item model, the fuzzy matcher, the portable data
  directory and the merge-onto-defaults behaviour existed twice and had drifted;
  now they exist once.
- **A shared UI layer.** ✅ `ui/` holds the design tokens, the icon set and the
  vendored fonts, copied into each app's renderer with a CI check that the
  copies are current.
- **The suite registry.** ✅ Every app writes its exe path and its capabilities
  to `%USERPROFILE%\.dev-suite\registry.json` and reads the others. Apps ask
  for capabilities, not for each other, so a new tool gets cross-launch for
  free. The old notebook pointer is still read as a fallback.
- **One release for everything.** ✅ Both exes from one build of one workspace,
  so a version means something and code signing will be one step rather than
  three.

All three apps now live here. Markdown Notebook came in with `git subtree`, so
its history survived the move; the Electron build it replaced is gone. What is
left of that migration is bookkeeping — issues and the old download URL — see
[ARCHITECTURE.md](ARCHITECTURE.md#bringing-markdown-notebook-in).

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
check does. The logs half is now cheap: `docker logs -f` into Log Viewer, which
mostly means teaching the viewer to tail a process's stdout as well as a file.

**Recent files and branches.** Files you touched today across all repos, and
branches you've had checked out — both come free from data already being read,
and both are things you hunt for constantly.

**Logs, done. ✅** Shipped as its own app plus a Dev Hub card — see
[Log Viewer](../apps/log-viewer/README.md).

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

**Code signing.** The wall between "runs on my machine" and "a teammate can run
it" — SmartScreen flags every unsigned build. Needs a certificate, and is now
one step in one workflow for the whole suite rather than one per app. This is
the highest-value item on this list if anyone else is ever going to run these.

**Theming beyond dark/light.** The token block is already the only thing that
would need to change.

**A second machine.** Config sync via a file you point both installs at — a
OneDrive path, a git repo — rather than any kind of cloud service. Consistent
with the apps making no network calls they weren't told to make. Worth doing
once, in `suite-config`, for every app at once.

**Linux/macOS builds.** The Rust is nearly portable already; the Windows-specific
parts are the foreground workaround and the `cmd` handling. Only worth doing if
you actually want it — the spec is deliberately Windows-first.

---

## The other apps that were considered

From the same review that produced Log Viewer, in the order they'd be worth
building:

**A REST client** — the offline Postman replacement, collections stored as plain
files so they version with your notes. The biggest single workflow win for
full-stack work on a locked-down box, and it would share the health-check
endpoint config that already exists.

**A dev toolbox** — JSON/XML/YAML format and convert, diff, JWT decode, base64,
epoch, UUID, hash, regex tester, cron parser. Low effort, used ten times a day,
and it kills the habit of pasting company payloads into a website — which is a
policy story worth being able to tell.

**A SQL scratchpad** — highest value, highest cost, because of driver bundling.
Worth scoping down to saved parameterised queries against the databases you
actually touch.

Each of these is now a binary crate and a `register` call away from discovery,
cross-launch and a Dev Hub card. That was the point of Phase 1.5.

## Deliberately not doing

- **A plugin API.** The `command` provider covers the same ground with a fraction
  of the surface area, and nothing to keep stable across versions.
- **Auto-update.** A running exe can't replace itself, and a background updater on
  a locked-down corporate box is a support problem, not a feature.
- **Telemetry.** Ever.
- **A note editor in Dev Hub.** That's Markdown Notebook's job; Dev Hub surfaces
  todos from the notebook and hands the note to it.
- **Two apps rendering the same thing.** Dev Hub stats log files; Log Viewer
  reads them. Overlapping surfaces are how a suite stops feeling like one
  product.
