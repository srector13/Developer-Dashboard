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
├─ log-viewer/
└─ markdown-notebook/
```

### Each app watches its own config file

Dev Hub and Log Viewer both watch the JSON file that holds their content and
reload it in place. This is not shared code — it is thirty lines each, over
`notify-debouncer-mini`, and the thing it reloads is different in both — but it
*is* a shared rule, and the reason is worth writing down: a config file that is
only read at startup makes an edit look like a failure. Log Viewer went a whole
beta without one, and the bug it produced was reported as "I added a log and I
can't see the lines" — everything downstream was correct, and the app had simply
never been told.

Both watch the *directory* rather than the file. Most editors save by writing a
temp file and renaming it over the original, which destroys the handle a file
watch is bound to; a file watch therefore works exactly once, which is worse
than not having one.

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

1. **Teach it the registry.** ✅ Done, on that repo's
   `claude/suite-registry` branch. It registers on startup with
   `open-note-at-line` and records the notebook root alongside its existing
   pointer write. Dev Hub already reads the registry first and falls back to
   the old pointer, so this changed nothing for anyone until it lands — and
   nothing breaks if it never does.
2. **Move the code in.** ✅ Brought in with `git subtree`, so `git log` and
   `git blame` still reach its 104 commits rather than starting at the move.
   Its vendored registry module is gone in favour of the crate, and its
   duplicated design tokens and fonts in favour of `ui/`.
3. **Migrate the issues**, and leave the old repository archived with a pointer
   here. The old release download URL is the thing to be careful about: anything
   bookmarking it needs a redirect or a final release that says where to go.
   **Still to do** — and the only reason not to archive the old repo today.

### Step 1 did not use the crate, and that was right at the time

The plan above originally said Markdown Notebook would call
`suite_registry::register`. While it lived in another repository it didn't —
it had its own ~150-line module writing the same file. Step 2 deleted that
module and switched it to the crate, which is what the module's own doc comment
said should happen. The reasoning is kept here because it applies to the next
app that has to interoperate before it can move in.

Depending on the crate would have meant a Cargo git dependency from one
repository to another, for the sake of writing a small JSON file. That is worse
than the duplication it avoids: it makes a portable app's build depend on
network access to a second repository, and — right now — on an unmerged branch
of it. The registry is an **interchange format**, and a second implementation of
a format is ordinary. The `last-notebook.json` pointer it replaces always worked
exactly this way.

What that cost was the risk of two implementations drifting, so the contract was
pinned from the reader's side: `suite-registry` carries a test with the verbatim
output of that writer, captured from a real run. There is one implementation
again now, but the test stays — betas are out there that have already written
that shape into people's home directories, and a renamed field would strand
every one of them *silently*, because a registry that fails to parse reads as
"no apps installed" rather than as an error.

## Deliberately not doing

- **A plugin API.** Dev Hub's `command` provider covers the same ground with a
  fraction of the surface area and nothing to keep stable across versions.
- **Auto-update.** A running exe can't replace itself, and a background updater
  on a locked-down corporate box is a support problem, not a feature.
- **Splitting the crates into their own repository.** That is the version-bump
  dance again, with none of the benefits.
- **Telemetry.** Ever.
