# Markdown Notebook (VS Code extension)

By Stephen Rector.

A Markdown note-taking workspace for VS Code — a OneNote-style companion that keeps your notes as plain `.md` files so they work with git and GitHub Copilot. It gives you a notebook tree view, templates, paste-to-import, and document conversion in one place.

Features:

- **Notebook view** — a note-aware sidebar (sections, pages, pinned notes, daily notes) separate from the file Explorer.
- **New Page / New Section / New from Template** — with frontmatter (including your `author:` name) filled in.
- **Import** — turn copied text or an email chain into a clean Markdown note via pandoc.
- **Reorder & rename** — drag-and-drop ordering and link-preserving renames that keep `[[wiki-links]]` intact.
- **Convert documents** — right-click a Word, PowerPoint, or Excel file to convert it to Markdown.

## Converting documents

Right-click a Word, PowerPoint, or Excel file in the Explorer, choose **Convert to Markdown (Pandoc)**, and the extension creates a `.md` next to it and (optionally) cleans up the original.

| File | Pandoc reader | Notes |
|------|---------------|-------|
| `.docx` (Word) | `docx` | Works on any modern pandoc. Embedded images extracted to `<file>_media/`. |
| `.pptx` (PowerPoint) | `pptx` | **Requires pandoc ≥ 3.8.3** (the pptx *input* reader was added then). |
| `.xlsx` (Excel) | `xlsx` | **Requires pandoc ≥ 3.8.3.** Each worksheet becomes a section with a table. |
| `.odt`, `.rtf`, `.epub`, `.html` | matching reader | Bonus formats pandoc has long supported. |

Converted files get Notebook frontmatter (`title`, `created`, `author`, `tags: [converted]`) prepended automatically, so they land in the Notebook view as titled notes. The title comes from the document's first heading (which is then removed from the body to avoid a duplicate), falling back to the filename. Turn this off with `pandocToMarkdown.addFrontmatter`; it's skipped automatically when `standalone` is on, since pandoc writes its own metadata then.

> **Heads up:** PowerPoint and Excel *input* are new in pandoc 3.8.3. If you're on an older pandoc the extension will convert Word fine and show a clear message telling you to upgrade for the other two. Check yours with `pandoc --version`.

`.doc`, `.ppt`, and `.xls` (the old pre-2007 binary formats) are **not** supported by pandoc — convert them to the `x` formats in Office first.

## Prerequisites

- [Pandoc](https://pandoc.org/installing.html) on your `PATH` (or set its path in settings). Quick installs:
  - macOS: `brew install pandoc`
  - Windows: `winget install --id JohnMacFarlane.Pandoc`
  - Linux: `sudo apt install pandoc` (note: distro packages are often older than 3.8.3; for pptx/xlsx grab the latest from the [releases page](https://github.com/jgm/pandoc/releases))
- [Node.js](https://nodejs.org) (only to build the extension).

## Build & run

```bash
npm install
npm run compile      # or: npm run watch
```

Then either:

- **Try it live:** open this folder in VS Code and press `F5`. A second VS Code window ("Extension Development Host") launches with the extension loaded.
- **Install it for real:** package it into a `.vsix` and install:
  ```bash
  npm install -g @vscode/vsce
  vsce package
  code --install-extension pandoc-to-markdown-0.1.0.vsix
  ```

## Usage

1. Drop a `.docx` / `.pptx` / `.xlsx` into your project.
2. Right-click it in the Explorer → **Convert to Markdown (Pandoc)**.
3. A new `.md` appears beside it and opens automatically. The original is moved to Trash (recoverable) by default.

Select multiple files first to batch-convert them. The command also appears in the Command Palette for whatever file is open in the editor.

## Settings

| Setting | Default | What it does |
|---------|---------|--------------|
| `pandocToMarkdown.pandocPath` | `pandoc` | Path to the pandoc executable. |
| `pandocToMarkdown.deleteOriginal` | `true` | Remove the source file after a successful conversion. |
| `pandocToMarkdown.useTrash` | `true` | Move removed originals to Trash instead of deleting permanently. |
| `pandocToMarkdown.confirmDelete` | `false` | Ask once before removing originals. |
| `pandocToMarkdown.extractMedia` | `true` | Pull embedded images into `<file>_media/` and link them. |
| `pandocToMarkdown.markdownVariant` | `gfm` | Markdown flavor (gfm renders tables well). |
| `pandocToMarkdown.wrap` | `none` | Pandoc `--wrap` mode. |
| `pandocToMarkdown.standalone` | `false` | Emit a YAML metadata header. |
| `pandocToMarkdown.openAfterConvert` | `true` | Open the result after converting. |
| `pandocToMarkdown.extraArgs` | `[]` | Extra args appended to every pandoc call. |

## Safety notes

- The original is only removed **after** pandoc exits successfully.
- "Cleanup" uses the OS Trash by default, so a mistaken conversion is recoverable. Set `useTrash` to `false` for permanent deletion, or `confirmDelete` to `true` to be asked first.
- File paths are passed to pandoc as separate arguments (via `execFile`), not through a shell, so names with spaces or special characters are safe.

## Notebook view

The extension adds a **Notebook** icon to the activity bar — a note-aware view of your folder that sits alongside (not instead of) the file Explorer.

- Folders show as **sections** (book icon) with a child count; `.md` files show as **pages**.
- Page labels come from the note's `title:` frontmatter, or its first `#` heading, falling back to a humanized filename.
- `pinned: true` notes float to the top with a star, scanned from anywhere in the notebook.
- Daily notes (names matching `markdownNotebook.dailyNotePattern`, default `YYYY-MM-DD`) get a calendar icon, friendly dates (today / yesterday), and newest-first order.
- Inline descriptions show the modified date, the first couple of `#tags`, and a count of open `- [ ]` tasks.
- Clutter (`.git`, `.vscode`, `_media`, `attachments`, `templates`, non-markdown files) is hidden — configurable via `markdownNotebook.ignoreFolders`.
- Toolbar / right-click actions: **New Page**, **New Section** (templated with frontmatter), **Refresh**, **Reveal in Explorer**.

Notebook settings live under `markdownNotebook.*` (`root`, `ignoreFolders`, `dailyNotePattern`, `templatesFolder`, `author`).

### Import a document into the tree

**Import Document…** (the download icon on the Notebook toolbar) lets you bring in a Word/PowerPoint/Excel/etc. file from anywhere on disk: pick the file, choose which section it should land in (any folder in your notebook, or create a new section on the spot), and it's copied in and converted to Markdown there. The original file outside your notebook is never touched. This is the menu-driven counterpart to right-clicking a file that's already in the workspace.

### Import copied text (paste → Markdown)

Two commands turn whatever you've copied into a clean note, without saving a file first:

- **Import Clipboard as Note** (clipboard icon on the view toolbar) reads your clipboard directly.
- **Import Pasted Text as Note** (Command Palette) opens an input box pre-filled from the clipboard so you can trim it first.

The text is piped through pandoc. If it looks like rich text / HTML (as a copied email chain usually is), it's read as HTML so quoting, links, and tables survive; otherwise it's cleaned up as Markdown. You're then asked for a **title (optional — leave it blank to use the detected title** from the first heading or line) and **where in the tree** to put it. The note is saved with `title:`, `created:`, your `author:` (if set), and a `tags: [imported]` block.

### Daily / dated notes

Notes whose filename matches `dailyNotePattern` get a calendar icon and date-aware sorting. If the note also has a title (frontmatter or `# H1`), the **title is shown as the label with the date alongside it** — e.g. `2026-05-28-budget-sync.md` titled "Budget Sync" shows as **Budget Sync · May 28** — so you get the meeting context at a glance. A bare daily with no title still shows the formatted date (**Thu, May 28 · today**). Dates from a previous year include the year.

**New from Template** (view toolbar or right-click a section) lists the `.md` files in your `templatesFolder` (default `templates/`, which is hidden from the tree), asks for a title, and creates a page from the chosen template. If you have no templates yet, it offers to drop in starter `daily.md` and `meeting.md` files.

Templates support these placeholders: `{{title}}`, `{{slug}}`, `{{date}}`, `{{time}}`, `{{datetime}}`, `{{year}}`, `{{month}}`, `{{day}}`, `{{weekday}}`, and a `{{cursor}}` marker that positions your cursor in the new note.

### Reordering

- **Move Up / Move Down** (right-click a page) and **drag-and-drop** let you arrange pages manually.
- Drag a page or section **onto another section** to move it there.
- Drop a page **onto another page in the same section** to place it just before that page.
- Manual order is stored in a hidden `.notebook-order` file per folder (one filename per line), so notes themselves stay clean and the order survives in git. Pages not listed there fall back to the default daily/alphabetical sort.

### Rename (link-preserving)

**Rename (update links)** (the pencil on a page, or right-click) renames a note and keeps `[[wiki-links]]` intact:

- Updates the file's `title:` frontmatter and a leading `# H1` that matched the old title.
- Renames the file (slugified) and rewrites every `[[old-name]]` reference across the notebook to the new name — preserving aliases (`[[old|Text]]`), headings/blocks (`[[old#Section]]`), `.md` suffixes, and folder-qualified targets (`[[dir/old]]`). Matching is by note name and case-insensitive.
- Edits to other notes are applied as **unsaved** changes so you can review them before saving (Save All to commit). Moving a note between sections doesn't need link updates, since wiki-links resolve by name, not path.

## Enhanced Markdown preview

The extension upgrades VS Code's built-in Markdown preview (no separate preview window to learn):

- **Mermaid diagrams** — ` ```mermaid ` fenced blocks render as diagrams, themed to match your light/dark mode. Mermaid is vendored, so it works offline.
- **GitHub theme** — a faithful GitHub-style stylesheet that follows your VS Code light/dark mode (or force dark with `markdownNotebook.previewTheme`).
- **Task lists** — `- [ ]` / `- [x]` render as checkboxes.
- **`==highlight==`** → highlighted text.
- External links open in a new tab.

These apply to the standard preview (the open-preview button / `Ctrl+K V`); there's nothing extra to launch.

## Export to PDF

Right-click a note in the Notebook view (or use the inline PDF button that appears when you hover a page), or right-click any `.md` file in the Explorer / editor tab, and choose **Export to PDF…**. You pick where to save, and the note is rendered to PDF with the same GitHub theme as the preview.

How it works (no LaTeX, no bundled browser): pandoc converts the note to HTML, the theme CSS is inlined, and a lightweight HTML-based PDF engine produces the file. Configure the engine with `markdownNotebook.pdfEngine` (`auto` tries WeasyPrint → wkhtmltopdf → Prince). Install one with e.g. `pip install weasyprint`.

- **Mermaid in PDF:** if you have mermaid-cli (`npm i -g @mermaid-js/mermaid-cli`), diagrams are pre-rendered to SVG and appear in the PDF; without it, they're left as code and you're told how to enable them. (The live preview renders Mermaid without mermaid-cli.)
- **No PDF engine installed?** Save with a `.html` extension in the dialog instead — you get a styled, self-contained HTML file with no extra dependencies.

## License

MIT
