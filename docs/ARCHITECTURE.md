# Why one repository

The suite was two repositories — Dev Hub and Markdown Notebook — that cohered
through a copied block of design tokens and one pointer file. That arrangement
survives two apps. It does not survive three: a third app would have meant a
third copy of the item model, a third copy of the settings-merge, a third
portable-data-dir implementation, and a discovery story that grows
quadratically as each app learns about each other app.

So the shared parts became crates, and the third app was built on them rather
than beside them.

## What the decision actually turned on

The textbook arguments against a monorepo — CI matrix blow-up, unrelated-team
churn, giant checkouts, needing build-graph tooling — are all costs that appear
at a scale this project does not have. One developer, one stack, one target
platform, and around 15k lines in total.

The costs that *are* real here:

- **CI does more work per push.** Mitigated by path filters and by keeping the
  shared crates in a job that needs no system libraries at all.
- **Moving a repository breaks its history.** GitHub redirects a renamed repo,
  but a repo-to-subdirectory move loses issues and stars unless they are
  migrated deliberately. This is the main reason Markdown Notebook is still
  where it is.

Against that, three things a monorepo buys that separate repositories with a
shared git-dependency do not:

1. **Atomic cross-cutting change.** Adding a field to `Item` is one commit
   across the crate and every app, with one CI run. With a git dependency it is
   a version-bump dance per app, per change, forever.
2. **One release, one version.** The apps share a registry format. A version
   only means something if they move together.
3. **One signing step.** Code signing is the wall between "runs on my machine"
   and "a teammate can run it" — SmartScreen will flag every unsigned build. One
   certificate applied once in one workflow is the difference between solving
   that problem and solving it three times.

The third is the practical argument. The first is the one that will save the
most hours.

## The layout

```
crates/
├─ suite-core/       Item · Action · Status · ProviderResult · fuzzy search · clock
├─ suite-config/     portable data dir, merge-onto-defaults, load/save
└─ suite-registry/   %USERPROFILE%\.dev-suite\registry.json

ui/                  tokens.css, icons.js, the vendored fonts
apps/
├─ dev-hub/
└─ log-viewer/
```

### The crates carry no Tauri dependency

`suite-core` and `suite-config` depend on `serde` and nothing else. This is
enforced by a CI job that builds and tests them alone, on a runner with no
GTK/WebKit packages installed. The first `use tauri::` in `suite-core` fails
that job in seconds, long before it fails anything else — which is the point.
A "shared" crate that quietly acquires a desktop toolchain dependency stops
being shareable, and nobody notices until the next thing tries to use it.

### `ui/` is copied, not imported

Tauri serves one directory as the entire frontend root; nothing above it is
addressable at runtime. There is no bundler in this stack to resolve a sibling
import, and adding one to share three files would be a poor trade.

So `scripts/sync-ui.mjs` copies `ui/` into `apps/<app>/renderer/vendor/suite/`,
and those copies are committed — a fresh clone builds with `cargo` alone, with
no npm step. Committed copies drift, which is exactly the problem `ui/` exists
to solve, so `npm run ui:check` re-runs the copy in memory and fails CI on any
difference.

### A trap worth knowing about

`suite_config::merge_onto_defaults` reads defaults from `T::default()`. That
makes a `#[serde(default = "default_true")]` attribute on a type with a
*derived* `Default` a silent bug: after merging there is no missing key left for
the attribute to fill in, so the derived value (`false`) wins.

Three separate versions of this went wrong the first time the config types were
written — a log source list that arrived switched off, a registry that called
itself version 0, and a set of highlight rules that vanished. Every type used
with that function now writes `Default` out by hand, mirroring every
`serde(default = …)` on it.

## The registry

`%USERPROFILE%\.dev-suite\registry.json`, described in the
[README](../README.md#put-them-in-the-same-folder). Three properties the design
leans on:

- **Writes are last-one-wins, per entry.** An app rewrites its own key and
  copies everyone else's through untouched, so two apps starting simultaneously
  can at worst lose one registration until the next launch. Writes go through a
  temp file and a rename, so a reader never sees half a file.
- **Nothing is ever pruned.** A missing exe is skipped, not deleted — an exe on
  a drive that isn't mounted is missing, not gone, and deleting the entry would
  mean rediscovering it by hand later.
- **A missing registry is normal.** Every read returns an empty registry rather
  than an error.

Apps ask for **capabilities**, not for each other. Dev Hub's Logs card asks for
something that can `tail-file`; it is never told that Log Viewer exists. That is
what makes a fourth app free rather than an integration task.

## Bringing Markdown Notebook in

Deliberately last, and not yet done.

Extracting a shared abstraction from *one* app is guessing. Two apps is the
minimum signal for what is genuinely shared, and the crates have now been proven
against two. Markdown Notebook can be moved in with a much better idea of what
it should be reusing.

The order:

1. **Teach it the registry.** One call to `suite_registry::register` on startup
   with `open-note-at-line`, and `set_notebook_root` where it currently writes
   its pointer file. Done in its own repository, shipped, verified. Dev Hub
   already reads the registry first and falls back to the old pointer, so this
   changes nothing for anyone until it lands — and nothing breaks if it never
   does.
2. **Move the code in**, as `apps/markdown-notebook`, replacing its copies of
   the model, the settings merge and the design tokens with the crates.
3. **Migrate the issues**, and leave the old repository archived with a pointer
   here. The old release download URL is the thing to be careful about: anything
   bookmarking it needs a redirect or a final release that says where to go.

Only step 1 has to happen soon; it is small and it removes the fallback path.
Steps 2 and 3 can wait for a quiet week.

## Deliberately not doing

- **A plugin API.** Dev Hub's `command` provider covers the same ground with a
  fraction of the surface area and nothing to keep stable across versions.
- **Auto-update.** A running exe can't replace itself, and a background updater
  on a locked-down corporate box is a support problem, not a feature.
- **Splitting the crates into their own repository.** That is the version-bump
  dance again, with none of the benefits.
- **Telemetry.** Ever.
