# Releasing Markdown Notebook (Windows / Rust build)

## What a release produces

Pushing a tag like `v1.5.0` runs `.github/workflows/release.yml` on a Windows
runner and attaches a single artifact to a draft GitHub Release:

| Artifact | Notes |
|---|---|
| `Markdown Notebook-<version>-win-x64-portable.exe` | The whole app. Nothing to install, no unpacking step. |

That's the entire matrix on purpose — this build is **portable only**. There is
no installer, no zip, and no macOS or Linux target.

Local equivalent:

```sh
cargo build --release --manifest-path src-tauri/Cargo.toml
# → src-tauri/target/release/markdown-notebook.exe
```

## Why the exe is small, and what it needs

The UI runs in **WebView2**, the Edge rendering engine that is already part of
Windows, rather than a bundled copy of Chromium. The executable is therefore a
few megabytes instead of ~90, and it needs the WebView2 runtime to be present:

- **Windows 11** — always present.
- **Windows 10** — present since the 2020 servicing updates; on an unusually
  stale machine the [Evergreen Bootstrapper][webview2] installs it per-user
  with no admin rights.

[webview2]: https://developer.microsoft.com/microsoft-edge/webview2/

## Portable mode

There is only portable mode. On startup `src-tauri/src/settings.rs` puts all app
state in a `MarkdownNotebookData` folder **beside the executable**: settings and
the note-metadata cache. Copy the exe to a USB stick and its configuration goes
with it.

If that folder can't be created — the exe was dropped somewhere read-only, such
as `Program Files` — the app falls back to `%APPDATA%\Markdown Notebook` rather
than refusing to start.

Independently of that, the app keeps a per-user pointer file
(`~/.markdown-notebook/last-notebook.json`) recording the active notebook path.
A fresh copy of the exe — or one whose data folder was deleted — falls back to
that pointer, so the notebook reopens without re-selection. The folder chooser
appears only when neither the settings nor the pointer resolve to a directory
that exists.

## No auto-update

A running executable cannot replace itself on Windows, so the portable build
does not self-update — the same as the Electron portable build before it.
"Check for Updates" in the command palette reports the portable status and
points at the Releases page. Releasing is therefore: build → review the draft →
publish → users download the new exe and replace the old one. Their notebook and
their `MarkdownNotebookData` folder are untouched by that swap.

## Startup performance

There is no extraction step — the old portable Electron launcher unpacked the
whole app to `%TEMP%` on every run, which was the bulk of a portable launch
(often 5–15s with antivirus scanning). This build starts the binary directly.

In-app startup work is kept off the critical path, as before: the window paints
before the notebook scan (the in-page loading overlay), mermaid (~3 MB) loads
lazily on first diagram use, and note metadata is served from a persistent cache
(`MarkdownNotebookData/scan-meta-cache-v1.json`) so unchanged files cost one
`stat()` on a cold start. Full-text search documents are rebuilt in the
background afterwards; a search issued during that window waits for it rather
than returning partial results.

## Code signing

Signing is **automatic when the secrets exist and silently skipped when they
don't** — unsigned builds always succeed, so forks and test releases work
without certificates. A signed portable exe is much less likely to be blocked by
SmartScreen or corporate AV.

Configure these repository secrets (GitHub → Settings → Secrets → Actions):

| Secret | Value |
|---|---|
| `WIN_CSC_LINK` | Base64 of the `.pfx` code-signing certificate (`base64 -i cert.pfx`) |
| `WIN_CSC_KEY_PASSWORD` | The certificate's password |

Any OV/EV code-signing certificate works. The workflow signs with `signtool`
from the Windows SDK that the runner already has.

## Cutting a release

```sh
npm version minor            # bumps package.json, creates the vX.Y.Z tag
git push --follow-tags
```

Keep `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` in step with
`package.json` — the release workflow reads the version from `package.json`, but
the version compiled into the exe comes from `Cargo.toml`.

Then review the draft GitHub Release the workflow created, edit the notes, and
publish.

## Locked-down work machines

- The portable exe runs without any installation and writes only to its own
  folder and the user's notebook.
- If the machine enforces application allowlisting (AppLocker/WDAC), only
  signing with a certificate the organisation trusts — or IT approval — will
  help; that's policy, not packaging.
- If executables are blocked outright, no packaging choice helps. The shared
  `renderer/` directory is the starting point for a browser build using the File
  System Access API, which needs no executable at all.
