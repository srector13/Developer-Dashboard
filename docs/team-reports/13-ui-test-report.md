# UI Test Report: Cycle 4

Scope: visual and accessibility audit after the Cycle 4 features (grouped search panel, PDF scope select, sharing entries in File Actions, quick-capture settings field) and the new `.search-group` / `.palette-group-header` / `.form-hint` styles.

Harness: `tests/renderer/ui-audit.mjs` — the real renderer in Chromium, capturing 46 screenshots across all six themes (light, dark, midnight, forest, sepia, system) and the modal/dropdown/toast/tooltip scenes, plus computed-style contrast probes written to `contrast.json`. Probes assert WCAG AA (4.5:1 for normal text).

Process note (as in previous cycles): executed inline by the developer with the committed harness; screenshots reviewed manually.

## Findings and fixes

1. **Settings hint text sub-AA in dark themes (2.26:1) — fixed.** The new "Quick Capture Shortcut" field's `.form-hint` used `--text-muted`, which in the dark palette is a decorative `#484f58` — 2.26:1 on the modal surface at 11 px, and 4.27:1 in light mode. `.form-hint` and the identical `.builder-hint` now use `--text-secondary` (≥6:1 in both bases). The muted token itself is unchanged — it remains correct for non-text decoration.
2. **Sepia inline code / links 4.17:1 — fixed.** Sepia's `--accent-blue` (`#9a5b24`) fell just under AA as inline-code and link text on the tinted code surface. Darkened to `#8a4f1d` (5.1:1). Verified the theme still reads as warm/sepia in the full-page screenshots.
3. **Sepia inactive toolbar tabs 4.26:1 — fixed.** Sepia's `--text-secondary` darkened `#6f6047` → `#5f513c` (5.4:1 on the toolbar surface).

After the fixes the probe sweep reports **zero sub-AA findings** across all themes and scenes.

## Visual review notes

- **Grouped search panel** reuses the existing row classes (`.content-search-item`, `.tag-pill`) that already pass the theme probes; the new group headers use `--text-secondary` on the sidebar surface with the shared chevron affordance, matching the tree's section headers. Collapse chevrons rotate consistently with the sidebar tree.
- **Settings modal** (dark, light): the new shortcut field and hint align with the existing form rhythm; the hint wraps cleanly at modal width.
- **PDF export modal**: the scope select sits above theme/page-size with matching control height; disabled options (no active note / no section) render with the native disabled affordance in both color schemes.
- **File Actions dropdown**: three new entries follow the existing item height/hover treatment; the menu still fits on an 800 px-tall window without clipping (right-aligned, no overflow).
- **Palette group headers** ("Recent" / "Commands") are non-interactive, uppercase-styled dividers; keyboard selection skips them (selection arithmetic untouched — verified functionally in the smoke suite).
- **Quick capture window** (`capture.html`) is standalone and honors `prefers-color-scheme` with its own token block; it is not reachable by this harness (main-process window) — reviewed by inspection, flagged for the Electron e2e suite.

## Verdict

Three contrast defects found (one introduced this cycle, two pre-existing borderline sepia values), all fixed and re-verified: 0 sub-AA probe results. No layout regressions across the 46 screenshots compared against the cycle 3 set.
