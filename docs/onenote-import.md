# Importing from OneNote

There are three ways to get OneNote content into the notebook. The first is
the one to use if you're migrating; the other two need no setup and are worth
knowing about.

## 1. Import from OneNote (File Actions → *Import from OneNote…*)

Pick whole notebooks, whole sections, or individual pages. Each OneNote page
becomes its own markdown note, and the structure is preserved:

```
OneNote                                Notebook
  Work                                   Work/
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

Section and notebook names become folder names, so they are sanitised first:
OneNote allows `\ / : * ? " < > |` and trailing dots in names and Windows does
not, and names like `CON` are reserved device names.

A page that fails to import is reported and the run continues — one unreadable
page shouldn't cost you the other two hundred.

### "Library not registered"

Automation goes through OneNote's type library twice: once to translate a
method name into a DISPID, and again when OneNote dispatches the call itself.
On some Office installs that library's registration is missing or points at the
wrong bitness, so both fail with `TYPE_E_LIBNOTREGISTERED` — even though the
OneNote object is live and perfectly usable.

The import recovers in two steps.

**Reading the library directly.** OneNote's program file is found via
`HKCR\CLSID\{…}\LocalServer32`, and the type library is loaded straight out of
that binary with `LoadTypeLibEx(…, REGKIND_NONE)`. That answers the name-to-
DISPID question without consulting the registry at all. Resolved DISPIDs are
cached for the life of the process.

**Registering it for the current user.** Supplying our own DISPID is not enough
when it is OneNote's own dispatch that cannot find the library, so on that
failure the app calls `RegisterTypeLibForUser` and retries the call once.

> **This writes to the registry.** `RegisterTypeLibForUser` adds type library
> entries under `HKEY_CURRENT_USER\Software\Classes\TypeLib` — the current
> user's hive only. It needs no administrator rights, which is what makes it
> usable on a managed or locked-down computer, and it affects no other user
> account. It is the same registration Office setup would normally have made.
> To undo it, delete the OneNote entry under that key.

If both steps fail, the picker explains what was tried and falls back to
suggesting an Office Quick Repair, which may need an IT administrator on a
managed machine.

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
