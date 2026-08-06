# Opening a note from another program

The portable executable doubles as a "jump to this note" command. Point another
tool at the exe, hand it a path and optionally a line, and the note opens in
Markdown Notebook scrolled to that line with the block highlighted.

This exists for companion tools — a dashboard that scans the notebook for TODOs,
a script that greps for a tag — that want a clickable result.

## Usage

```
markdown-notebook.exe <path> [--line N] [--view preview|edit|split]
```

| Form | Effect |
| --- | --- |
| `markdown-notebook.exe "C:\notes\alpha.md"` | Opens the note. |
| `markdown-notebook.exe "C:\notes\alpha.md:42"` | Opens it at line 42. |
| `markdown-notebook.exe --line 42 "C:\notes\alpha.md"` | The same, spelled out. |
| `markdown-notebook.exe -l 42 "C:\notes\alpha.md"` | Short form. |
| `markdown-notebook.exe --line=42 "C:\notes\alpha.md"` | `=` works too. |
| `markdown-notebook.exe --line 42 --view edit "C:\notes\alpha.md"` | Lands in the editor with the caret on line 42. |

**Lines count from 1**, matching every editor and compiler message.

The `path:line` suffix is the form editors and grep-alikes already emit
(`code -g`, ripgrep, `vim +42`), so a caller holding such a string can pass it
straight through. Windows paths are safe: only a run of digits at the very end
counts, so `C:\notes\alpha.md` keeps its drive letter.

Relative paths resolve against the calling program's working directory.

## Behaviour

**If the app is already running, the note opens in that window** — a second copy
is never started. The running instance is raised to the front.

**If it isn't running, it starts** and opens the note once the notebook has
finished loading, after the previous session's tabs are restored, so the
requested note ends up the active tab.

**`--view` defaults to `preview` when a line is given**, since jumping to a line
usually means "show me this". Without a line, opening behaves like clicking the
note in the sidebar, which lands in preview.

**The line is located by content, not by scroll position.** Every rendered block
carries the source line it came from, so the jump is exact even though rendering
strips frontmatter and the leading H1 — which would otherwise put a "line 42" a
handful of lines off. A line inside a paragraph or a code fence scrolls to the
block containing it. The landing block flashes briefly, then settles.

## Errors

Nothing is reported for a bad invocation, because this build detaches from the
console — there is nowhere for a usage message to go. Instead:

- A path that does not exist, or is a directory, is ignored and the app opens
  normally.
- An unparseable `--line` value opens the note without jumping.
- Unknown switches are skipped rather than treated as fatal.

Refusing to start would be a worse answer than opening, so the app always opens.

## Example: calling it from another app

PowerShell:

```powershell
& "C:\Tools\Markdown-Notebook.exe" "C:\notes\Projects\alpha.md:42"
```

C#:

```csharp
Process.Start(notebookExePath, $"\"{notePath}:{lineNumber}\"");
```

Node:

```js
spawn(notebookExePath, [`${notePath}:${lineNumber}`], { detached: true });
```

Quote the argument: notebook paths routinely contain spaces, and an unquoted
path with a space would be read as several arguments, of which only the first is
taken as the path.
