# Importing from OneNote

There are three ways to get OneNote content into the notebook. The first is
the one to use if you're migrating; the other two need no setup and are worth
knowing about.

## 1. Import from OneNote (File Actions → *Import from OneNote…*)

Pick whole notebooks, whole sections, or individual pages. Each OneNote page
becomes its own markdown note, and the structure is preserved:

```
OneNote                     default (flat)      "Recreate OneNote's folders"
  Work                        standup.md          Work/
    Meetings                  retro.md              Meetings/
      Standup                 kickoff.md              standup.md
      Retro                                           retro.md
    Projects  (group)                               Projects/
      Archive (group)                                 Archive/
        Apollo                                          Apollo/
          Kickoff                                         kickoff.md
```

Images embedded in a page come across as attachments. Each imported note gets
a `onenote` tag, so you can find everything the import produced with a tag
search afterwards.

### What it needs

**OneNote 2016, or the OneNote desktop app installed with Microsoft 365.**
Those register a COM automation server that the import drives. The Store
version ("OneNote for Windows 10") does not register one, and neither does
OneNote on the web — the picker says so rather than failing partway through.

OneNote must be running, or able to start; the import launches it if needed.

### How it works

`src-tauri/src/onenote.rs` makes exactly two calls, late-bound through
`IDispatch` so no interface IIDs have to be hard-coded:

- **`GetHierarchy`** returns an XML tree of notebooks, section groups, sections
  and pages. Recycle bins and deleted pages are filtered out — restoring
  someone's deleted pages during a migration would be a nasty surprise.
- **`Publish`** exports one page to a file. The import asks for **Word
  (`.docx`)**, and pandoc converts that to markdown.

### Why Word, and not the web-page export

MHTML was the obvious choice at first — it carries images inline — and it
produced badly mangled notes. OneNote's MHTML is layout for a browser: nested
absolutely-positioned `<div>`s, every run of text inside a styled `<span>`, and
a single-cell `<table>` placing the body on the canvas. There is no amount of
cleaning that reliably turns that back into structure, because the structure was
thrown away on the way out.

A `.docx` keeps it. Headings are headings, lists are lists with their nesting,
tables are tables — so pandoc's docx reader produces markdown that reads like
markdown. This is the approach
[ConvertOneNote2MarkDown](https://github.com/theohbrothers/ConvertOneNote2MarkDown)
takes, and it is right.

Images come with it: `--extract-media` has pandoc unpack every embedded image
and rewrite the links itself, which deletes the entire problem of matching an
image reference to the right part of the file. The app then moves each extracted
file into the notebook's attachments folder and points the link there.

One wrinkle, confirmed by running the real conversion: a Word export always
carries image dimensions, which pandoc's gfm writer can only express by falling
back to a raw `<img>` tag. Those are turned back into `![alt](src)` afterwards.

`src-tauri/tests/docx_pipeline.rs` runs this end to end against a real `.docx`
with a real embedded image, and asserts what comes out — headings, nested lists,
a pipe table, a blockquote, the extracted image, and no layout tags. It is
skipped where pandoc is not installed.

MHTML remains as a fallback for a OneNote that will not publish Word, and is
still the path used when importing a `.mht` file by hand.

### Where the pages land

**Flat, by default**: every selected page becomes a note directly in the section
chosen in the picker. No folders are created, so an import cannot merge into
something already there or scatter pages across a structure you did not ask for.
Two pages with the same name are safe — each note gets a unique filename.

Tick **Recreate OneNote's folders** to rebuild OneNote's own structure instead:
the notebook, then any section groups, then the section, as folders under the
destination.

Section and notebook names become folder names, so they are sanitised first:
OneNote allows `\ / : * ? " < > |` and trailing dots in names and Windows does
not, and names like `CON` are reserved device names.

A page that fails to import is reported and the run continues — one unreadable
page shouldn't cost you the other two hundred.

### "Library not registered"

Automation goes through OneNote's type library twice: once to turn a method name
into a DISPID, and again when OneNote dispatches the call. If that library
cannot be loaded, both fail with `TYPE_E_LIBNOTREGISTERED` even though the
OneNote object is live and healthy.

The likely cause is **bitness**, and it is not a broken install. Type library
registration is split into `win32` and `win64` subkeys. This app is 64-bit. A
32-bit Office — still common in managed environments — registers only `win32`,
so a 64-bit caller is told, correctly, that the library is not registered.
Nothing done inside a 64-bit process fixes that, because the bitness of the
asking process is the problem.

The import therefore tries three routes in order, stopping at the first that
works:

1. **In-process COM.** The fast path, and the only one with no child process.
2. **The type library read straight off OneNote's binary**, via
   `HKCR\CLSID\{…}\LocalServer32` and `LoadTypeLibEx(…, REGKIND_NONE)`, which
   answers the name-to-DISPID question without the registry. Enough on its own
   only when the name lookup was the sole failure.
3. **A PowerShell process of OneNote's own bitness**, which is what actually
   clears a bitness mismatch. Windows ships both builds at fixed paths —
   `System32\WindowsPowerShell` is the 64-bit one and `SysWOW64\WindowsPowerShell`
   the 32-bit one, confusingly — so there is no second binary to ship. OneNote's
   own executable is inspected (its PE machine word) to decide which to try
   first; both are tried either way.

The script is passed with `-EncodedCommand` (base64 of UTF-16LE), so no quoting
layer can mangle a page ID or a path, and values interpolated into it are
single-quoted with doubled quotes.

An in-process attempt may also register the type library for the current user
with `RegisterTypeLibForUser`, which writes under
`HKEY_CURRENT_USER\Software\Classes\TypeLib` — the current user's hive only, no
administrator rights, no effect on other accounts. To undo it, delete the
OneNote entry under that key.

### When it still does not work: run the check

The import dialog offers **Run a check** whenever it fails. It reports, in one
pass:

- the bitness of this app and of OneNote's own executable, and whether they
  differ;
- where OneNote's program file is, according to the registry;
- which type library registrations actually exist, machine-wide and per-user,
  broken down by version and bitness;
- what each of the three routes above returned, verbatim.

**Copy this report** puts it on the clipboard as plain text. It identifies the
cause in one run, rather than one fact per attempt.

### Caveats

- **Importing twice creates duplicates.** Nothing tracks which OneNote pages
  have already been imported.
- **OneNote's free-form canvas flattens.** OneNote pages are a canvas of
  independently positioned boxes; markdown is a single linear document. Pages
  laid out in columns or with scattered text boxes come through in the order
  OneNote lists them, which may not match how they looked.
- **Ink, audio and embedded files** have no markdown equivalent and are
  dropped. Handwriting is not converted to text.
- **Pandoc is required**, as it is for the Word and PowerPoint imports.

## 2. Copy and paste a page

Select a page's content in OneNote, copy, then **File Actions → Paste Note
from Clipboard**. This reads the clipboard's HTML flavour, so headings,
tables, lists and formatting survive. Good for grabbing one page without
opening the picker, and it works with any version of OneNote including the
Store app and the web.

## 3. Export from OneNote, then import the file

In OneNote: **File → Export**, choose a page, section or notebook, and save as
either **Word (`.docx`)** or **Single File Web Page (`.mht`)**. Then use
**File Actions → Import Doc via Pandoc**.

Both formats are accepted. `.mht` is usually the better choice because its
images are embedded and come through as attachments; a `.docx` export converts
its text faithfully but its images are not extracted.

Note that exporting a *section* or *notebook* this way produces one single
document — every page concatenated together, with the page titles as headings.
That's the trade-off versus method 1, which keeps the pages separate.

## Which should I use?

| | Structure kept | Images | Needs desktop OneNote |
|---|---|---|---|
| Import from OneNote | **Yes** — one note per page | Yes | Yes |
| Paste from clipboard | One page at a time | Yes | No |
| Export → import file | No — one flat document | `.mht` only | No |
