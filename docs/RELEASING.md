# Releasing Markdown Notebook

## What a release produces

Pushing a tag like `v1.2.0` runs `.github/workflows/release.yml`, which builds on real macOS and Windows runners and attaches everything to a draft GitHub Release:

| Platform | Artifact | Notes |
|---|---|---|
| Windows | `Markdown Notebook-Setup-<version>.exe` | NSIS installer, **per-user** — installs under `%LOCALAPPDATA%` and never asks for admin elevation |
| Windows | `Markdown Notebook-<version>-portable.exe` | Single portable executable — run from anywhere, nothing installed |
| Windows | `Markdown Notebook-<version>-win-x64.zip` | Plain unpacked app |
| macOS | `Markdown Notebook-<version>.dmg` | Drag-and-drop disk image |
| macOS | `Markdown Notebook-<version>-mac-<arch>.zip` | Plain app bundle |

Local equivalents: `npm run pack:win` / `npm run pack:mac` (or `npm run pack` for the current platform) — output lands in `dist/`.

## Portable mode

The portable target keeps **all app state next to the executable** instead of `%APPDATA%`: at startup, `src/main.ts` redirects Electron's `userData` into a `MarkdownNotebookData` folder beside the `.exe` (electron-builder's portable launcher sets `PORTABLE_EXECUTABLE_DIR`). Settings, window state, and caches all travel with the file — USB-stick friendly.

> Note: the portable target intentionally does **not** set `unpackDirName`. A fixed unpack directory makes the launcher reuse a previous version's extracted files, so an updated exe would silently run stale code. The default (version-hashed temp dir) re-unpacks per version, guaranteeing an updated exe runs the new code.

The zip distribution can opt in to the same behavior: create a folder named `MarkdownNotebookData` next to the executable once, and the app becomes self-contained from then on. Without that folder, zip builds use the normal per-user location.

Independent of portable state, the app maintains a per-user pointer file (`~/.markdown-notebook/last-notebook.json`) recording the active notebook path. A fresh portable copy — or one whose data folder was deleted — falls back to that pointer, so the notebook reopens without re-selection; the folder chooser appears only when neither settings nor the pointer resolve to an existing directory.

## Code signing

Signing is **automatic when the secrets exist and silently skipped when they don't** — unsigned builds always succeed, so forks and test releases work without certificates. Signing applies to *every* Windows artifact (installer, portable, zip contents), not just the installer; a signed portable exe is much less likely to be blocked by SmartScreen or corporate AV.

Configure these repository secrets (GitHub → Settings → Secrets → Actions):

### Windows

| Secret | Value |
|---|---|
| `WIN_CSC_LINK` | Base64 of the `.pfx` code-signing certificate (`base64 -i cert.pfx`) |
| `WIN_CSC_KEY_PASSWORD` | The certificate's password |

Any OV/EV code-signing certificate works. (If you move to Azure Trusted Signing later, electron-builder supports it via `win.azureSignOptions` — swap the env wiring in the workflow.)

### macOS

| Secret | Value |
|---|---|
| `MAC_CSC_LINK` | Base64 of the Developer ID Application `.p12` |
| `MAC_CSC_KEY_PASSWORD` | The `.p12` password |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | 10-character team ID |

Hardened runtime + entitlements (`build/entitlements.mac.plist`) are always applied so a signed build is notarization-ready. Notarization itself runs only when the Apple credentials are present (the workflow flips the config's `notarize` off-switch on the command line).

## Auto-update

The installed builds (NSIS installer, dmg) self-update via `electron-updater`, reading the `latest.yml` / `latest-mac.yml` feed electron-builder publishes to each GitHub release. Updates are picked up from **published** (non-draft) releases only, so the flow is: build → review the draft → **publish** → installed apps update on their next launch. The **portable exe** and **zip** cannot update in place and are skipped (they show a "download the latest from Releases" message on a manual check). macOS auto-update requires the build to be signed + notarized; unsigned macOS builds won't self-update.

## Cutting a release

```sh
npm version minor            # bumps package.json, creates the vX.Y.Z tag
git push --follow-tags
```

Then review the draft GitHub Release the workflow created, edit notes, and publish.

## Locked-down work machines

- The **portable exe** and **zip** run without any installation.
- The **installer** is per-user (no admin prompt), which satisfies "no elevation" policies.
- If the machine enforces application allowlisting (AppLocker/WDAC), only signing with a certificate the org trusts — or IT approval — will help; that's policy, not packaging.
