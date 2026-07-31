//! Importing from OneNote desktop.
//!
//! OneNote 2016 / Microsoft 365 desktop registers a COM automation server
//! (`OneNote.Application`). Two calls are all this needs:
//!
//!   * `GetHierarchy` — an XML tree of notebooks, section groups, sections and
//!     pages, so the user can pick what to bring over.
//!   * `Publish` — export one page to a file. We ask for MHTML, because that
//!     carries the page's images inline and `crate::mhtml` already unwraps it
//!     into HTML plus attachments.
//!
//! Calls are late-bound through `IDispatch`, by method name. That avoids
//! hard-coding interface IIDs that vary between OneNote builds; the cost is
//! more ceremony per call, which the helpers below absorb.
//!
//! The Store / "OneNote for Windows 10" app registers no COM server at all, so
//! `probe()` says so up front instead of failing deep inside an import.
//!
//! The XML parsing is kept apart from the COM plumbing, so the shape handling
//! — nested section groups, sub-pages, recycle bins — stays testable without
//! Windows or OneNote installed.

#[cfg(windows)]
use crate::onenote_shell;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnePage {
    pub id: String,
    pub name: String,
    /// 1 for a top-level page, 2+ for OneNote's indented sub-pages.
    pub level: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OneSection {
    pub id: String,
    pub name: String,
    /// Section-group names above this section, outermost first. These become
    /// nested folders, so a grouped notebook keeps its shape.
    pub group_path: Vec<String>,
    pub pages: Vec<OnePage>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OneNotebook {
    pub id: String,
    pub name: String,
    pub sections: Vec<OneSection>,
}

/// What the UI needs to know before it offers the import at all.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OneNoteStatus {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

// ---------------------------------------------------------------------------
// Hierarchy XML
// ---------------------------------------------------------------------------

use quick_xml::events::BytesStart;

/// Local element name, ignoring the `one:` namespace prefix.
fn local_name(raw: &[u8]) -> String {
    String::from_utf8_lossy(raw)
        .rsplit(':')
        .next()
        .unwrap_or("")
        .to_string()
}

fn attribute(e: &BytesStart, name: &str) -> Option<String> {
    e.try_get_attribute(name)
        .ok()
        .flatten()
        .and_then(|a| a.unescape_value().ok())
        .map(|v| v.into_owned())
}

fn flag(e: &BytesStart, name: &str) -> bool {
    attribute(e, name).is_some_and(|v| v.eq_ignore_ascii_case("true"))
}

/// True for anything we refuse to import. Pulling a user's deleted pages back
/// out of the recycle bin would be a nasty surprise.
fn is_discarded(e: &BytesStart) -> bool {
    flag(e, "isRecycleBin") || flag(e, "isInRecycleBin") || flag(e, "isDeletedPages")
}

/// Accumulates notebooks while walking the XML. Kept as a struct because the
/// element handlers need shared mutable state, and `Start` and `Empty` events
/// have to run the same logic with different "does this have children" answers.
#[derive(Default)]
struct HierarchyBuilder {
    notebooks: Vec<OneNotebook>,
    notebook: Option<OneNotebook>,
    section: Option<OneSection>,
    groups: Vec<String>,
    /// Depth of a subtree being ignored, so a recycle bin takes its children
    /// with it.
    skipping: usize,
}

impl HierarchyBuilder {
    fn start(&mut self, e: &BytesStart, has_children: bool) {
        if self.skipping > 0 {
            if has_children {
                self.skipping += 1;
            }
            return;
        }
        if is_discarded(e) {
            if has_children {
                self.skipping = 1;
            }
            return;
        }

        match local_name(e.name().as_ref()).as_str() {
            "Notebook" => {
                self.flush_section();
                self.flush_notebook();
                self.groups.clear();
                self.notebook = Some(OneNotebook {
                    id: attribute(e, "ID").unwrap_or_default(),
                    name: attribute(e, "name").unwrap_or_else(|| "Notebook".into()),
                    sections: Vec::new(),
                });
                if !has_children {
                    self.flush_notebook();
                }
            }
            "SectionGroup" => {
                if has_children {
                    self.groups
                        .push(attribute(e, "name").unwrap_or_else(|| "Group".into()));
                }
            }
            "Section" => {
                self.flush_section();
                self.section = Some(OneSection {
                    id: attribute(e, "ID").unwrap_or_default(),
                    name: attribute(e, "name").unwrap_or_else(|| "Section".into()),
                    group_path: self.groups.clone(),
                    pages: Vec::new(),
                });
                if !has_children {
                    self.flush_section();
                }
            }
            "Page" => {
                if let Some(section) = self.section.as_mut() {
                    section.pages.push(OnePage {
                        id: attribute(e, "ID").unwrap_or_default(),
                        name: attribute(e, "name").unwrap_or_else(|| "Untitled page".into()),
                        level: attribute(e, "pageLevel")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(1),
                    });
                }
            }
            _ => {}
        }
    }

    fn end(&mut self, name: &str) {
        if self.skipping > 0 {
            self.skipping -= 1;
            return;
        }
        match name {
            "Section" => self.flush_section(),
            "SectionGroup" => {
                self.groups.pop();
            }
            "Notebook" => {
                self.flush_section();
                self.flush_notebook();
            }
            _ => {}
        }
    }

    fn flush_section(&mut self) {
        if let (Some(section), Some(notebook)) = (self.section.take(), self.notebook.as_mut()) {
            notebook.sections.push(section);
        }
    }

    fn flush_notebook(&mut self) {
        if let Some(notebook) = self.notebook.take() {
            self.notebooks.push(notebook);
        }
    }

    fn finish(mut self) -> Vec<OneNotebook> {
        self.flush_section();
        self.flush_notebook();
        self.notebooks
    }
}

/// Parse the XML `GetHierarchy` returns into notebooks, sections and pages.
pub fn parse_hierarchy(xml: &str) -> Result<Vec<OneNotebook>, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut builder = HierarchyBuilder::default();
    // quick-xml validates that an end tag matches its start, but it happily
    // hits EOF with elements still open. Tracking depth ourselves turns a
    // truncated response into an error rather than a silently partial tree.
    let mut depth: i32 = 0;

    loop {
        match reader
            .read_event()
            .map_err(|err| format!("OneNote returned XML we couldn't read: {err}"))?
        {
            Event::Eof => break,
            Event::Start(e) => {
                depth += 1;
                builder.start(&e, true);
            }
            Event::Empty(e) => builder.start(&e, false),
            Event::End(e) => {
                depth -= 1;
                builder.end(&local_name(e.name().as_ref()));
            }
            _ => {}
        }
    }

    if depth != 0 {
        return Err("OneNote's notebook list was cut short — try the import again.".into());
    }
    Ok(builder.finish())
}

// ---------------------------------------------------------------------------
// COM automation
// ---------------------------------------------------------------------------

/// Pull the program path out of a `LocalServer32` command line.
///
/// The registry stores a command line, not a path: it is normally quoted and
/// normally carries `-Embedding`, but neither is guaranteed, and the value read
/// back from `RegGetValueW` still has its NUL terminator attached.
#[allow(dead_code)]
fn exe_from_command_line(raw: &str) -> Option<String> {
    let raw = raw.trim_end_matches('\0').trim();
    let path = if let Some(rest) = raw.strip_prefix('"') {
        rest.split('"').next().unwrap_or("")
    } else {
        // Unquoted, so a space can only be the start of a switch — an unquoted
        // path with a space in it would already be ambiguous to the shell.
        raw.split(" -").next().unwrap_or(raw).split(" /").next().unwrap_or(raw)
    }
    .trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

/// OneNote's `PublishFormat` enumeration; MHTML is the one that keeps images.
#[allow(dead_code)]
const PUBLISH_FORMAT_MHTML: i32 = 2;
/// `HierarchyScope::hsPages` — every level, down to individual pages.
#[allow(dead_code)]
const HIERARCHY_SCOPE_PAGES: i32 = 4;

#[cfg(windows)]
mod com {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use windows::core::{BSTR, GUID, HSTRING, PCWSTR};
    use windows::Win32::System::Com::{
        CLSIDFromProgID, CoCreateInstance, CoInitializeEx, IDispatch, ITypeLib, CLSCTX_ALL,
        DISPATCH_METHOD, DISPPARAMS, COINIT_APARTMENTTHREADED, EXCEPINFO,
    };
    use windows::Win32::System::Ole::{LoadTypeLibEx, REGKIND_NONE};
    use windows::Win32::System::Variant::{VARIANT, VT_BSTR, VT_BYREF, VT_I4};

    const LOCALE_USER_DEFAULT: u32 = 0x0400;

    /// TYPE_E_LIBNOTREGISTERED — "Library not registered".
    const TYPE_E_LIBNOTREGISTERED: i32 = 0x8002_801Du32 as i32;

    /// The last resort message, once the automatic repair has also failed.
    fn registration_advice(method: &str, repair: &str) -> String {
        format!(
            "OneNote is running, but Windows cannot find its automation type library, so the \
             '{method}' call could not be made (\"Library not registered\"). This is an Office \
             installation problem rather than a problem with your notes.\n\n\
             Registering the library for your account was tried automatically and did not \
             work: {repair}\n\n\
             The remaining fix needs Office itself repaired — close OneNote, open Settings › \
             Apps › Installed apps, find Microsoft Office or Microsoft 365, choose Modify and \
             run a Quick Repair. On a managed computer that may need your IT team."
        )
    }

    /// Register OneNote's type library for the current user.
    ///
    /// `RegisterTypeLibForUser` writes under `HKCU\Software\Classes`, so unlike
    /// the machine-wide `RegisterTypeLib` it needs no administrator rights and
    /// works on a locked-down computer. OneNote runs as the same user, so the
    /// registration it could not find becomes visible to it as well.
    ///
    /// This is what makes the import work at all when Office's own registration
    /// is missing: the type library is not just consulted to turn a name into a
    /// DISPID — OneNote dispatches the call itself through it, so supplying our
    /// own DISPID is not enough on its own.
    fn register_typelib_for_user(clsid: &GUID) -> Result<(), String> {
        use windows::Win32::System::Ole::RegisterTypeLibForUser;

        let exe = local_server_path(clsid)
            .ok_or_else(|| "OneNote's program file is not listed in the registry".to_string())?;
        let wide = HSTRING::from(exe.as_os_str());
        let lib: ITypeLib = unsafe { LoadTypeLibEx(&wide, REGKIND_NONE) }.map_err(|e| {
            format!("no type library could be read from {}: {e}", exe.display())
        })?;
        unsafe { RegisterTypeLibForUser(&lib, &wide, PCWSTR::null()) }
            .map_err(|e| format!("registering it for your account failed: {e}"))
    }

    /// Method name -> DISPID, once resolved. DISPIDs are fixed properties of
    /// OneNote's type library, so they stay valid for the life of the process
    /// even if OneNote itself is closed and reopened between imports.
    static DISPIDS: once_cell::sync::Lazy<Mutex<HashMap<String, i32>>> =
        once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

    /// COM has to be initialised on whichever thread makes the call. Tauri runs
    /// commands on a pool, so this is done per call; repeat calls on an
    /// already-initialised thread return S_FALSE, which is not an error.
    fn ensure_com() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
    }

    /// The live OneNote object, plus the CLSID it came from — the DISPID
    /// fallback needs the CLSID to find OneNote's program file.
    fn connect() -> Result<(IDispatch, GUID), String> {
        ensure_com();
        unsafe {
            let progid = HSTRING::from("OneNote.Application");
            let clsid = CLSIDFromProgID(PCWSTR(progid.as_ptr())).map_err(|e| {
                format!(
                    "OneNote's automation interface isn't registered on this machine \
                     (the Store version of OneNote doesn't provide one). {e}"
                )
            })?;
            let dispatch: IDispatch = CoCreateInstance(&clsid, None, CLSCTX_ALL)
                .map_err(|e| format!("Could not start OneNote: {e}"))?;
            Ok((dispatch, clsid))
        }
    }

    /// Where OneNote's out-of-process server lives, from
    /// `HKCR\CLSID\{clsid}\LocalServer32`. The value is a command line, so it
    /// can be quoted and can carry switches (`"...\ONENOTE.EXE" -Embedding`).
    fn local_server_path(clsid: &GUID) -> Option<std::path::PathBuf> {
        use windows::Win32::System::Registry::{
            RegGetValueW, HKEY_CLASSES_ROOT, RRF_RT_REG_SZ,
        };

        let key = HSTRING::from(format!(
            "CLSID\\{{{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}}}\\LocalServer32",
            clsid.data1,
            clsid.data2,
            clsid.data3,
            clsid.data4[0], clsid.data4[1], clsid.data4[2], clsid.data4[3],
            clsid.data4[4], clsid.data4[5], clsid.data4[6], clsid.data4[7],
        ));

        let mut buf = [0u16; 1024];
        let mut size = (buf.len() * 2) as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CLASSES_ROOT,
                &key,
                PCWSTR::null(),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr() as *mut _),
                Some(&mut size),
            )
        };
        if status.is_err() {
            return None;
        }

        let chars = (size as usize / 2).min(buf.len());
        let raw = String::from_utf16_lossy(&buf[..chars]);
        super::exe_from_command_line(&raw).map(std::path::PathBuf::from)
    }

    /// Ask OneNote's own type library for a DISPID, loading it straight off
    /// OneNote's binary.
    ///
    /// This is the recovery path for "Library not registered": OneNote resolves
    /// `GetIDsOfNames` against its registered type library, and when that
    /// registration is missing or points at the wrong bitness the call fails
    /// even though the object itself is live and usable. Reading the type
    /// library out of the executable sidesteps the registry entirely; the
    /// DISPIDs it yields drive `Invoke` exactly the same way.
    fn dispid_from_typelib(clsid: &GUID, method: &str) -> Result<i32, String> {
        let exe = local_server_path(clsid)
            .ok_or_else(|| "could not find OneNote's program file in the registry".to_string())?;

        // The type library is a resource inside ONENOTE.EXE on the installs
        // that have one; older layouts ship it beside the exe instead.
        let mut candidates = vec![exe.clone()];
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("ONENOTE.TLB"));
        }

        let mut last = String::from("no type library found");
        for candidate in candidates {
            let wide = HSTRING::from(candidate.as_os_str());
            let lib: ITypeLib = match unsafe { LoadTypeLibEx(&wide, REGKIND_NONE) } {
                Ok(lib) => lib,
                Err(e) => {
                    last = format!("{}: {e}", candidate.display());
                    continue;
                }
            };

            // Take the first interface in the library that knows the name.
            // Matching on the interface name instead would tie this to a
            // spelling that has changed across OneNote versions, and only
            // OneNote's Application interface declares these methods anyway.
            let count = unsafe { lib.GetTypeInfoCount() };
            for index in 0..count {
                let Ok(info) = (unsafe { lib.GetTypeInfo(index) }) else {
                    continue;
                };
                let name = HSTRING::from(method);
                let names = [PCWSTR(name.as_ptr())];
                let mut id = 0i32;
                if unsafe { info.GetIDsOfNames(names.as_ptr(), 1, &mut id) }.is_ok() {
                    return Ok(id);
                }
            }
            last = format!("{} has no '{method}'", candidate.display());
        }
        Err(last)
    }

    fn dispid(dispatch: &IDispatch, clsid: &GUID, method: &str) -> Result<i32, String> {
        if let Some(id) = DISPIDS.lock().ok().and_then(|c| c.get(method).copied()) {
            return Ok(id);
        }

        let name = HSTRING::from(method);
        let names = [PCWSTR(name.as_ptr())];
        let mut id = 0i32;
        let direct = unsafe {
            dispatch.GetIDsOfNames(&GUID::zeroed(), names.as_ptr(), 1, LOCALE_USER_DEFAULT, &mut id)
        };

        let resolved = match direct {
            Ok(()) => id,
            // Reading the library out of OneNote's own binary is tried first:
            // it answers the same question without touching the registry.
            Err(e) => match dispid_from_typelib(clsid, method) {
                Ok(id) => id,
                Err(_) if e.code().0 == TYPE_E_LIBNOTREGISTERED => {
                    // Nothing local worked, so repair the registration itself
                    // and ask OneNote again.
                    let repair = register_typelib_for_user(clsid);
                    let retried = unsafe {
                        dispatch.GetIDsOfNames(
                            &GUID::zeroed(),
                            names.as_ptr(),
                            1,
                            LOCALE_USER_DEFAULT,
                            &mut id,
                        )
                    };
                    match (repair, retried) {
                        (_, Ok(())) => id,
                        (Err(why), _) => return Err(registration_advice(method, &why)),
                        (Ok(()), Err(again)) => {
                            return Err(registration_advice(
                                method,
                                &format!(
                                    "the library registered successfully but the lookup still \
                                     failed ({again})"
                                ),
                            ))
                        }
                    }
                }
                Err(why) => {
                    return Err(format!(
                        "OneNote has no '{method}' method: {e} (and its type library did \
                         not provide one either: {why})"
                    ));
                }
            },
        };

        if let Ok(mut cache) = DISPIDS.lock() {
            cache.insert(method.to_string(), resolved);
        }
        Ok(resolved)
    }

    fn variant_i32(value: i32) -> VARIANT {
        let mut variant = VARIANT::default();
        unsafe {
            let inner = &mut variant.Anonymous.Anonymous;
            inner.vt = VT_I4;
            inner.Anonymous.lVal = value;
        }
        variant
    }

    fn variant_bstr(value: &str) -> VARIANT {
        let mut variant = VARIANT::default();
        unsafe {
            let inner = &mut variant.Anonymous.Anonymous;
            inner.vt = VT_BSTR;
            inner.Anonymous.bstrVal = std::mem::ManuallyDrop::new(BSTR::from(value));
        }
        variant
    }

    /// A VARIANT pointing at `slot`, for OneNote's `[out] BSTR*` parameters.
    fn variant_bstr_out(slot: &mut BSTR) -> VARIANT {
        let mut variant = VARIANT::default();
        unsafe {
            let inner = &mut variant.Anonymous.Anonymous;
            inner.vt = windows::Win32::System::Variant::VARENUM(VT_BSTR.0 | VT_BYREF.0);
            inner.Anonymous.pbstrVal = slot as *mut BSTR;
        }
        variant
    }

    /// One `Invoke`, reporting the raw HRESULT so the caller can decide whether
    /// it is worth retrying. `args` is in declaration order; DISPPARAMS wants
    /// it reversed.
    fn invoke_once(
        dispatch: &IDispatch,
        id: i32,
        method: &str,
        args: &mut [VARIANT],
    ) -> Result<(), (i32, String)> {
        args.reverse();
        let params = DISPPARAMS {
            rgvarg: args.as_mut_ptr(),
            cArgs: args.len() as u32,
            rgdispidNamedArgs: std::ptr::null_mut(),
            cNamedArgs: 0,
        };
        let mut excep = EXCEPINFO::default();
        let mut arg_error = 0u32;
        let result = unsafe {
            dispatch.Invoke(
                id,
                &GUID::zeroed(),
                LOCALE_USER_DEFAULT,
                DISPATCH_METHOD,
                &params,
                None,
                Some(&mut excep),
                Some(&mut arg_error),
            )
        };
        // Put the arguments back the way the caller handed them over, so a
        // retry starts from the same order rather than from the reversal.
        args.reverse();
        result.map_err(|e| {
            // EXCEPINFO's strings are ManuallyDrop<BSTR>; deref to read.
            let description = &*excep.bstrDescription;
            let detail = if description.is_empty() {
                String::new()
            } else {
                format!(" — {description}")
            };
            (e.code().0, format!("OneNote rejected {method}{detail} ({e})"))
        })
    }

    fn invoke(
        dispatch: &IDispatch,
        clsid: &GUID,
        method: &str,
        args: Vec<VARIANT>,
    ) -> Result<(), String> {
        let id = dispid(dispatch, clsid, method)?;
        let mut args = args;
        match invoke_once(dispatch, id, method, &mut args) {
            Ok(()) => Ok(()),
            // Supplying our own DISPID gets past a broken registration for the
            // *name* lookup, but OneNote dispatches the call itself through the
            // same type library. When that is what failed, register the library
            // for this user — no administrator rights needed — and try again.
            Err((code, _)) if code == TYPE_E_LIBNOTREGISTERED => {
                match register_typelib_for_user(clsid) {
                    Ok(()) => invoke_once(dispatch, id, method, &mut args).map_err(|(code, why)| {
                        if code == TYPE_E_LIBNOTREGISTERED {
                            registration_advice(
                                method,
                                "the library registered successfully but OneNote still could \
                                 not load it",
                            )
                        } else {
                            why
                        }
                    }),
                    Err(why) => Err(registration_advice(method, &why)),
                }
            }
            Err((_, why)) => Err(why),
        }
    }

    /// OneNote's executable, for reading its bitness. `None` when the COM
    /// registration itself is missing.
    pub fn onenote_exe() -> Option<std::path::PathBuf> {
        ensure_com();
        let progid = HSTRING::from("OneNote.Application");
        let clsid = unsafe { CLSIDFromProgID(PCWSTR(progid.as_ptr())) }.ok()?;
        local_server_path(&clsid)
    }

    pub fn probe() -> OneNoteStatus {
        match connect() {
            Ok(_) => OneNoteStatus {
                available: true,
                reason: None,
            },
            Err(reason) => OneNoteStatus {
                available: false,
                reason: Some(reason),
            },
        }
    }

    pub fn hierarchy_xml_in_process() -> Result<String, String> {
        let (dispatch, clsid) = connect()?;
        let mut out = BSTR::new();
        // GetHierarchy(startNodeId, scope, [out] xml)
        invoke(
            &dispatch,
            &clsid,
            "GetHierarchy",
            vec![
                variant_bstr(""),
                variant_i32(HIERARCHY_SCOPE_PAGES),
                variant_bstr_out(&mut out),
            ],
        )?;
        let xml = out.to_string();
        if xml.trim().is_empty() {
            return Err("OneNote returned an empty notebook list.".into());
        }
        Ok(xml)
    }

    pub fn publish_page_in_process(
        page_id: &str,
        target: &std::path::Path,
        format: i32,
    ) -> Result<(), String> {
        let (dispatch, clsid) = connect()?;
        // Publish refuses to overwrite, so clear any leftover first.
        let _ = std::fs::remove_file(target);
        invoke(
            &dispatch,
            &clsid,
            "Publish",
            vec![
                variant_bstr(page_id),
                variant_bstr(&target.to_string_lossy()),
                variant_i32(format),
                variant_bstr(""),
            ],
        )?;
        if !target.exists() {
            return Err("OneNote reported success but wrote no file.".into());
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod com {
    use super::*;

    const UNSUPPORTED: &str = "OneNote import is only available on Windows.";

    pub fn probe() -> OneNoteStatus {
        OneNoteStatus {
            available: false,
            reason: Some(UNSUPPORTED.into()),
        }
    }

    pub fn hierarchy_xml_in_process() -> Result<String, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn publish_page_in_process(
        _page_id: &str,
        _target: &std::path::Path,
        _format: i32,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
}

pub use com::probe;

// ---------------------------------------------------------------------------
// In-process first, then a process of the right bitness
// ---------------------------------------------------------------------------

/// Try the call here, and if the type library defeats us, try again somewhere
/// that can load it.
///
/// In-process is kept first because it is the fast path and needs no child
/// process. When it fails the reason is almost always `TYPE_E_LIBNOTREGISTERED`,
/// and no amount of retrying in *this* process changes that — the bitness of
/// the caller is the thing the type library registration is keyed on. See
/// `crate::onenote_shell` for why that is and what the fallback does.
#[cfg(windows)]
fn with_fallback<T>(
    in_process: impl FnOnce() -> Result<T, String>,
    via_host: impl Fn(onenote_shell::Host) -> Result<T, String>,
) -> Result<T, String> {
    let first = match in_process() {
        Ok(value) => return Ok(value),
        Err(why) => why,
    };
    let mut attempts = vec![format!("in this app: {first}")];
    for host in onenote_shell::host_order(com::onenote_exe().as_deref()) {
        match via_host(host) {
            Ok(value) => return Ok(value),
            Err(why) => attempts.push(why),
        }
    }
    Err(format!(
        "OneNote could not be reached.\n\n{}",
        attempts.join("\n")
    ))
}

/// Where OneNote's executable lives, for the diagnostics report.
#[cfg(windows)]
pub fn com_onenote_exe() -> Option<std::path::PathBuf> {
    com::onenote_exe()
}

/// Just the in-process read, reported as a byte count — the diagnostics report
/// needs to know whether this route works on its own.
#[cfg(windows)]
pub fn hierarchy_probe_in_process() -> Result<usize, String> {
    com::hierarchy_xml_in_process().map(|xml| xml.len())
}

#[cfg(windows)]
pub fn hierarchy_xml() -> Result<String, String> {
    let xml = with_fallback(com::hierarchy_xml_in_process, |host| {
        onenote_shell::run_script(host, &onenote_shell::hierarchy_script())
    })?;
    if xml.trim().is_empty() {
        return Err("OneNote returned an empty notebook list.".into());
    }
    Ok(xml)
}

/// Export one page. `format` is a OneNote `PublishFormat` — Word for the
/// import, since a .docx converts to far better markdown than a web page does.
#[cfg(windows)]
pub fn publish_page(page_id: &str, target: &std::path::Path, format: i32) -> Result<(), String> {
    // Publish refuses to overwrite, so clear any leftover first.
    let _ = std::fs::remove_file(target);
    with_fallback(
        || com::publish_page_in_process(page_id, target, format),
        |host| {
            onenote_shell::run_script(
                host,
                &onenote_shell::publish_script(page_id, target, format),
            )
            .map(|_| ())
        },
    )?;
    if !target.exists() {
        return Err("OneNote reported success but wrote no file.".into());
    }
    Ok(())
}

#[cfg(not(windows))]
pub use com::{hierarchy_xml_in_process as hierarchy_xml, publish_page_in_process as publish_page};

pub use crate::onenote_shell::{PUBLISH_FORMAT_MHTML as MHTML, PUBLISH_FORMAT_WORD as WORD};

/// The notebooks OneNote currently has open.
pub fn notebooks() -> Result<Vec<OneNotebook>, String> {
    parse_hierarchy(&hierarchy_xml()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0"?>
<one:Notebooks xmlns:one="http://schemas.microsoft.com/office/onenote/2013/onenote">
  <one:Notebook name="Work" ID="{N1}" path="C:\nb\Work">
    <one:Section name="Meetings" ID="{S1}">
      <one:Page ID="{P1}" name="Standup" pageLevel="1"/>
      <one:Page ID="{P2}" name="Retro notes" pageLevel="2"/>
    </one:Section>
    <one:SectionGroup name="Projects" ID="{G1}">
      <one:Section name="Apollo" ID="{S2}">
        <one:Page ID="{P3}" name="Kickoff" pageLevel="1"/>
      </one:Section>
      <one:SectionGroup name="Archive" ID="{G2}">
        <one:Section name="2025" ID="{S3}">
          <one:Page ID="{P4}" name="Old plan" pageLevel="1"/>
        </one:Section>
      </one:SectionGroup>
    </one:SectionGroup>
    <one:SectionGroup name="Deleted" ID="{G3}" isRecycleBin="true">
      <one:Section name="Trash" ID="{S9}">
        <one:Page ID="{P9}" name="Deleted page" pageLevel="1"/>
      </one:Section>
    </one:SectionGroup>
    <one:Section name="Empty" ID="{S4}"/>
  </one:Notebook>
  <one:Notebook name="Personal" ID="{N2}">
    <one:Section name="Recipes" ID="{S5}">
      <one:Page ID="{P5}" name="Bread" pageLevel="1"/>
    </one:Section>
  </one:Notebook>
</one:Notebooks>"#;

    #[test]
    fn notebooks_sections_and_pages_come_through() {
        let books = parse_hierarchy(SAMPLE).unwrap();
        assert_eq!(books.len(), 2);
        assert_eq!(books[0].name, "Work");
        assert_eq!(books[0].id, "{N1}");
        assert_eq!(books[1].name, "Personal");

        let meetings = &books[0].sections[0];
        assert_eq!(meetings.name, "Meetings");
        assert_eq!(meetings.pages.len(), 2);
        assert_eq!(meetings.pages[0].name, "Standup");
        assert_eq!(meetings.pages[1].level, 2);
    }

    #[test]
    fn section_groups_become_a_path() {
        let books = parse_hierarchy(SAMPLE).unwrap();
        let apollo = books[0]
            .sections
            .iter()
            .find(|s| s.name == "Apollo")
            .expect("Apollo section");
        assert_eq!(apollo.group_path, vec!["Projects"]);

        let nested = books[0]
            .sections
            .iter()
            .find(|s| s.name == "2025")
            .expect("nested section");
        assert_eq!(nested.group_path, vec!["Projects", "Archive"]);
    }

    #[test]
    fn the_recycle_bin_is_left_behind() {
        let books = parse_hierarchy(SAMPLE).unwrap();
        let names: Vec<&str> = books[0].sections.iter().map(|s| s.name.as_str()).collect();
        assert!(!names.contains(&"Trash"), "got {names:?}");
        let pages: Vec<&str> = books[0]
            .sections
            .iter()
            .flat_map(|s| s.pages.iter().map(|p| p.name.as_str()))
            .collect();
        assert!(!pages.contains(&"Deleted page"), "got {pages:?}");
    }

    #[test]
    fn a_group_closing_does_not_leak_into_later_sections() {
        let books = parse_hierarchy(SAMPLE).unwrap();
        // "Empty" sits after two nested groups closed; it must be at the root.
        let empty = books[0]
            .sections
            .iter()
            .find(|s| s.name == "Empty")
            .expect("Empty section");
        assert!(empty.group_path.is_empty(), "got {:?}", empty.group_path);
        assert!(empty.pages.is_empty());
    }

    #[test]
    fn a_second_notebook_starts_with_a_clean_group_stack() {
        let books = parse_hierarchy(SAMPLE).unwrap();
        assert_eq!(books[1].sections.len(), 1);
        assert!(books[1].sections[0].group_path.is_empty());
    }

    #[test]
    fn missing_attributes_fall_back_instead_of_failing() {
        let xml = r#"<one:Notebooks xmlns:one="x"><one:Notebook><one:Section><one:Page/></one:Section></one:Notebook></one:Notebooks>"#;
        let books = parse_hierarchy(xml).unwrap();
        assert_eq!(books[0].name, "Notebook");
        assert_eq!(books[0].sections[0].name, "Section");
        assert_eq!(books[0].sections[0].pages[0].name, "Untitled page");
        assert_eq!(books[0].sections[0].pages[0].level, 1);
    }

    #[test]
    fn malformed_xml_is_an_error_not_a_panic() {
        assert!(parse_hierarchy("<one:Notebook><unclosed>").is_err());
    }

    #[test]
    fn an_empty_document_yields_no_notebooks() {
        assert!(parse_hierarchy("<one:Notebooks/>").unwrap().is_empty());
    }

    // The LocalServer32 command line is what points the DISPID fallback at
    // OneNote's type library, so its parsing is worth pinning down.

    #[test]
    fn a_quoted_server_command_line_yields_the_program_path() {
        assert_eq!(
            exe_from_command_line("\"C:\\Program Files\\Microsoft Office\\Office16\\ONENOTE.EXE\" -Embedding"),
            Some("C:\\Program Files\\Microsoft Office\\Office16\\ONENOTE.EXE".to_string())
        );
    }

    #[test]
    fn an_unquoted_command_line_drops_its_switches() {
        assert_eq!(
            exe_from_command_line("C:\\Office\\ONENOTE.EXE -Embedding"),
            Some("C:\\Office\\ONENOTE.EXE".to_string())
        );
        assert_eq!(
            exe_from_command_line("C:\\Office\\ONENOTE.EXE /Automation"),
            Some("C:\\Office\\ONENOTE.EXE".to_string())
        );
    }

    #[test]
    fn a_bare_path_survives_intact() {
        assert_eq!(
            exe_from_command_line("C:\\Office\\ONENOTE.EXE"),
            Some("C:\\Office\\ONENOTE.EXE".to_string())
        );
    }

    #[test]
    fn the_registrys_nul_terminator_is_stripped() {
        assert_eq!(
            exe_from_command_line("\"C:\\Office\\ONENOTE.EXE\" -Embedding\0\0"),
            Some("C:\\Office\\ONENOTE.EXE".to_string())
        );
        // A path with spaces must survive even when only the NUL marks the end.
        assert_eq!(
            exe_from_command_line("C:\\Program Files\\ONENOTE.EXE\0"),
            Some("C:\\Program Files\\ONENOTE.EXE".to_string())
        );
    }

    #[test]
    fn a_missing_or_empty_value_yields_nothing() {
        assert_eq!(exe_from_command_line(""), None);
        assert_eq!(exe_from_command_line("\"\" -Embedding"), None);
        assert_eq!(exe_from_command_line("\0\0"), None);
    }
}
