# UI Test Report: Theme & Design-Language Audit

Method: the renderer was loaded in Chromium with a stubbed IPC layer and a seed note exercising every styled element (headings, lists, tasks, inline code, fenced `js` code, blockquote, highlight mark, table, mermaid flowchart). 46 screenshots were captured across all six themes (preview, editor, and split views) and every modal (settings, PDF export, shortcuts, templates, page info, and all seven diagram-builder types), plus toast, command palette, dropdowns, tree hover, and tooltips. Computed-style contrast ratios were probed programmatically for 12 element classes per theme (WCAG relative-luminance, alpha-composited against the real stacked backgrounds).

*Note: the audit run was completed by the orchestrating engineer after the original UI-tester agent was cut off by a session usage limit; the agent's harness (`ui-audit.mjs`) was used as-is.*

## Summary Verdict

**PASS after one fix round.** The token cleanup works: all six themes render with correct, readable colors across every audited surface — including the previously broken light-mode editor pane, code blocks (light hljs palette now active), tables, dropdowns, palette, and tooltips. Three contrast findings were identified, fixed, and re-verified.

## Theme Matrix

| Surface | Dark | Light | Midnight | Forest | Sepia | System |
|---|---|---|---|---|---|---|
| Note preview (all elements) | OK | OK | OK | OK | OK | OK |
| Raw editor pane | OK | OK | OK | OK | OK | OK |
| Split view | OK | OK | — | — | — | — |
| Settings modal | OK | **Issue 2 → fixed** | OK | OK | fixed | OK |
| PDF export modal | OK | **Issue 2 → fixed** | — | — | — | — |
| Shortcuts modal | OK | **Issue 3 → fixed** | — | — | — | — |
| Diagram builder (7 types) | OK | OK | — | — | — | — |
| Templates / Page info | OK | OK | — | — | — | — |
| Toast (success + error) | OK | OK | — | — | — | — |
| Command palette | OK | OK | — | — | — | — |
| Tooltip / dropdown / tree hover | OK | OK | — | — | — | — |
| Mode toggle (toolbar) | OK | **Issue 1 → fixed** | OK | OK | fixed | fixed |

## Issues Found (all fixed & re-verified)

1. **Inactive view-mode tab buttons under 4:1 contrast in light-base themes** — severity: medium. `.mode-toggles` used a hardcoded `rgba(0,0,0,0.2)` recessed wash, producing a mid-gray pill on light backgrounds (ratio 3.82 light / 3.10 sepia). **Fix:** new `--inset-bg` token (dark `rgba(0,0,0,.2)`, light `rgba(27,31,36,.07)`, sepia `rgba(92,75,55,.1)`), also applied to the table-grid header and palette footer insets. Re-verified: 5.34 light / 4.26 sepia.
2. **Light-theme modal labels muddy (3.21 ratio)** — severity: medium. The light glass card (`--glass-bg` at 0.6 alpha) over the dark modal overlay composited to a murky `rgb(184,184,184)` surface behind form labels in the settings/PDF/page-info modals. **Fix:** light glass raised to 0.92 alpha (sepia 0.95) and a new `--overlay-bg` token softens the backdrop in light themes (`rgba(27,31,36,.4)`). Re-verified: 6.01 light / 5.12 sepia.
3. **Shortcuts-modal section headers** — same root cause and fix as issue 2. Re-verified with the rest.

Post-fix contrast probes: every audited element ≥ 4.26:1 in all six themes; the full 260-check functional suite still passes on both platforms.

## Design Language Observations

- Radius, spacing, and typography are consistent across the five modals (all glass cards, `--radius-xl`, same header/footer bands); the new PDF-export and shortcuts modals are indistinguishable in structure from the established ones.
- The new `:focus-visible` ring appears consistently on buttons, selects, and checkboxes.
- kbd chips in the shortcuts modal, palette footer keys, and tooltip shortcut chips share the same visual treatment.
- Named themes read as intentional palettes rather than hue-shifts: Midnight and Forest re-tint accents, glass, code and editor surfaces; Sepia adjusts text and borders to warm tones. Mermaid diagrams follow the theme base (dark/default).
- Minor (accepted): the onboarding overlay keeps its brand-dark gradient in all themes by design; hljs token colors come in exactly two palettes (light/dark), so Midnight/Forest code blocks use the standard dark token palette — reasonable, noted for the roadmap if per-theme code palettes are ever wanted.

*Report compiled from the UI audit harness output (`ui-audit/` screenshots + `contrast.json`) and post-fix verification (`ui-verify-fixes.mjs`).*
