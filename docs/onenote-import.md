# Importing from OneNote

There are three ways to get OneNote content into the notebook. The first is
the one to use if you're migrating; the other two need no setup and are worth
knowing about.

## 1. Import from OneNote (File Actions → *Import from OneNote…*)

Pick whole notebooks, whole sections, or individual pages. Each OneNote page
becomes its own markdown note, and the structure is preserved:

```
OneNote                                the section you picked
  Work                                     (no folder unless you ask)
    Meetings                               Meetings/
      Standup                                standup.md
      Retro                                  retro.md
    Projects  (section group)              Projects/
      Archive (section group)                Archive/
        Apollo                                 Apollo/
          Kickoff                                kickoff.md
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
- **`Publish`** exports one page to a file. The import asks for **MHTML**,
  because that format carries the page's images inline; `src-tauri/src/mhtml.rs`
  then unwraps it into HTML plus image attachments, and pandoc converts the
  HTML to markdown.

### Getting readable markdown out of it

OneNote publishes HTML meant for a browser: nested absolutely-positioned
`<div>`s, every run of text inside a `<span style="font-family:…">`, and a
single-cell `<table>` used to place the body on the canvas. Handed that
directly, pandoc does the only thing it can with what markdown cannot express —
passes it through as raw HTML — which is why early imports arrived full of tags.

`src-tauri/src/html_clean.rs` strips the presentation first: conditional
comments, `<style>`/`<script>` blocks, Office's `<o:p>`-style tags, every
presentation attribute, and single-cell layout tables (a table with more than
one cell is one the user made, and is left alone). pandoc is then run with
`-f html-native_divs-native_spans -t gfm-raw_html`, which stops it preserving
those wrappers and removes the raw-HTML escape hatch entirely. The markdown is
tidied afterwards — trailing spaces dropped, runs of blank lines collapsed.

Images are matched to their MHTML part by source string, `cid:`, bare filename
and percent-decoded name; anything still unmatched falls back to the saved
attachments in document order, so an image referenced by a spelling this does
not recognise still lands on the right file. Attachment extensions follow the
part's own media type, so a JPEG is not saved as `.png`.

### Where the pages land

Pages go into the section chosen in the picker, with OneNote's section groups
and section recreated beneath it. The notebook's own name is **not** a folder by
default — the destination was already chosen, and adding a level on top of it
second-guesses that. Tick **Put each notebook in its own folder** when importing
from several notebooks at once, where that level is what keeps two same-named
sections apart.

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
