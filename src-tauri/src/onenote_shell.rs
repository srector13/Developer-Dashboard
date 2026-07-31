//! Driving OneNote from a separate process, and working out why in-process
//! COM failed.
//!
//! Three in-process attempts hit `TYPE_E_LIBNOTREGISTERED`, including one that
//! registered the type library for the user and retried. The candidate that
//! explains all of them is **bitness**: type library registration is split into
//! `win32` and `win64` subkeys, this app is 64-bit, and a 32-bit Office — still
//! very common in managed environments — registers only `win32`. A 64-bit
//! process asking for that library is told, correctly, that it is not
//! registered, no matter how healthy the install is.
//!
//! Nothing in-process fixes that, because the bitness of the asking process is
//! the problem. So the COM call moves to a process of the matching bitness.
//! Windows ships PowerShell in both, at fixed paths, which means no second
//! binary to build, sign or keep in step:
//!
//!   * 64-bit — `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
//!   * 32-bit — `%SystemRoot%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe`
//!
//! (From a 64-bit process those paths are literal: `System32` holds the 64-bit
//! build and `SysWOW64` the 32-bit one. The names are the wrong way round for
//! historical reasons.)
//!
//! `diagnose()` exists because three rounds of guessing is enough. It reports
//! the bitness of this process and of OneNote's own executable, which type
//! library registrations are actually present, and what each approach returned —
//! enough to identify the cause from one run instead of one fact per release.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// OneNote's `PublishFormat::pfMHTML`.
pub const PUBLISH_FORMAT_MHTML: i32 = 2;
/// OneNote's `PublishFormat::pfWord`. Word is what the page should be asked
/// for: unlike the browser-layout HTML in an MHTML export, a .docx carries real
/// headings, lists and tables, which is what pandoc needs to produce markdown
/// that reads like markdown. (pfOneNote 0, pfOneNotePackage 1, pfMHTML 2,
/// pfPDF 3, pfXPS 4, pfWord 5.)
pub const PUBLISH_FORMAT_WORD: i32 = 5;
/// OneNote's `HierarchyScope::hsPages`.
pub const HIERARCHY_SCOPE_PAGES: i32 = 4;

// ---------------------------------------------------------------------------
// PE bitness
// ---------------------------------------------------------------------------

/// The machine type in a PE file's COFF header.
///
/// A file begins with `MZ`; the 32-bit little-endian value at 0x3C is the
/// offset of the PE signature, and the machine word follows four bytes later.
pub fn pe_machine(bytes: &[u8]) -> Option<u16> {
    if bytes.len() < 0x40 || &bytes[0..2] != b"MZ" {
        return None;
    }
    let lfanew = u32::from_le_bytes(bytes[0x3C..0x40].try_into().ok()?) as usize;
    // Signature (4) + machine (2) must both be inside the file.
    if bytes.len() < lfanew + 6 || &bytes[lfanew..lfanew + 4] != b"PE\0\0" {
        return None;
    }
    Some(u16::from_le_bytes(bytes[lfanew + 4..lfanew + 6].try_into().ok()?))
}

pub fn machine_name(machine: u16) -> &'static str {
    match machine {
        0x014c => "32-bit (x86)",
        0x8664 => "64-bit (x64)",
        0xAA64 => "64-bit (ARM64)",
        0x01c4 => "32-bit (ARM)",
        _ => "unknown",
    }
}

/// Is this a 32-bit binary? Anything unrecognised is treated as not-32-bit,
/// so an odd machine type never silently routes to the 32-bit host.
pub fn is_32_bit(machine: u16) -> bool {
    machine == 0x014c || machine == 0x01c4
}

pub fn read_pe_machine(path: &Path) -> Option<u16> {
    // The COFF header sits in the first few hundred bytes; no need for the
    // whole executable, which can be tens of megabytes.
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut head = vec![0u8; 4096];
    let read = file.read(&mut head).ok()?;
    head.truncate(read);
    pe_machine(&head)
}

// ---------------------------------------------------------------------------
// The PowerShell host
// ---------------------------------------------------------------------------

/// Quote a value for a single-quoted PowerShell string, where the only escape
/// is a doubled quote. Page IDs and paths both reach the script this way, and a
/// notebook path containing an apostrophe is entirely ordinary.
pub fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// The script that reads the notebook tree.
///
/// `[ref]` is how PowerShell passes an `[out]` parameter through IDispatch,
/// which is what `GetHierarchy` needs for the XML it produces. Output goes
/// through `[Console]::Out.Write` rather than the pipeline so nothing wraps or
/// re-encodes it.
pub fn hierarchy_script() -> String {
    format!(
        "$ErrorActionPreference='Stop'\n\
         $app = New-Object -ComObject OneNote.Application\n\
         $xml = ''\n\
         $app.GetHierarchy('', {HIERARCHY_SCOPE_PAGES}, [ref]$xml)\n\
         [Console]::Out.Write($xml)\n"
    )
}

/// The script that exports one page to a file, in the given `PublishFormat`.
pub fn publish_script(page_id: &str, target: &Path, format: i32) -> String {
    format!(
        "$ErrorActionPreference='Stop'\n\
         $app = New-Object -ComObject OneNote.Application\n\
         $app.Publish({id}, {path}, {format}, '')\n",
        id = ps_quote(page_id),
        path = ps_quote(&target.to_string_lossy()),
    )
}

/// PowerShell's `-EncodedCommand` takes base64 of UTF-16LE. Using it avoids
/// every layer of quoting between here and the script.
pub fn encode_command(script: &str) -> String {
    use base64::Engine;
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

/// Which bitness of PowerShell to run in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Host {
    Win64,
    Win32,
}

impl Host {
    pub fn label(self) -> &'static str {
        match self {
            Host::Win64 => "64-bit PowerShell",
            Host::Win32 => "32-bit PowerShell",
        }
    }

    /// From a 64-bit process these paths are literal — `System32` really does
    /// hold the 64-bit build, and `SysWOW64` the 32-bit one.
    pub fn powershell_path(self, system_root: &str) -> PathBuf {
        let dir = match self {
            Host::Win64 => "System32",
            Host::Win32 => "SysWOW64",
        };
        PathBuf::from(system_root)
            .join(dir)
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe")
    }
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod run {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    /// No console window behind a conversion the user did not ask to watch.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    /// A whole notebook's hierarchy is quick; a hung COM call is not. Either
    /// way the user should not be stuck staring at a spinner forever.
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

    fn system_root() -> String {
        std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string())
    }

    /// Run a script in the given PowerShell and hand back its stdout.
    pub fn run_script(host: Host, script: &str) -> Result<String, String> {
        let exe = host.powershell_path(&system_root());
        if !exe.is_file() {
            return Err(format!("{} is not installed", host.label()));
        }
        let mut command = Command::new(&exe);
        command
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-EncodedCommand")
            .arg(encode_command(script))
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let child = command
            .spawn()
            .map_err(|e| format!("{} could not be started: {e}", host.label()))?;
        let output = wait_with_timeout(child)?;

        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        // PowerShell's error text runs to many lines of stack; the first
        // sentence is the part that identifies the failure.
        let first = stderr
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("no error text");
        Err(format!("{}: {first}", host.label()))
    }

    fn wait_with_timeout(mut child: std::process::Child) -> Result<std::process::Output, String> {
        let start = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return child.wait_with_output().map_err(|e| e.to_string()),
                Ok(None) => {
                    if start.elapsed() > TIMEOUT {
                        let _ = child.kill();
                        return Err("OneNote did not answer in time".into());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    }

    /// Which host to try first, and which to fall back to.
    ///
    /// A 32-bit OneNote can only be reached by a 32-bit caller, and vice versa,
    /// so the order is led by OneNote's own bitness when it is known. Both are
    /// tried regardless: guessing wrong should cost a second attempt, not the
    /// feature.
    pub fn host_order(onenote_exe: Option<&Path>) -> [Host; 2] {
        let onenote_is_32 = onenote_exe
            .and_then(read_pe_machine)
            .map(is_32_bit)
            .unwrap_or(false);
        if onenote_is_32 {
            [Host::Win32, Host::Win64]
        } else {
            [Host::Win64, Host::Win32]
        }
    }
}

#[cfg(windows)]
pub use run::{host_order, run_script};

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/// One line of the report: what was checked, and what came back.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub label: String,
    pub value: String,
    /// `true` when this line is the sort of thing that explains a failure.
    pub problem: bool,
}

fn ok(label: &str, value: impl Into<String>) -> Finding {
    Finding { label: label.into(), value: value.into(), problem: false }
}

fn bad(label: &str, value: impl Into<String>) -> Finding {
    Finding { label: label.into(), value: value.into(), problem: true }
}

/// Everything worth knowing about why OneNote automation is or is not working,
/// gathered in one pass.
///
/// This exists because the failure has now survived three releases of educated
/// guessing, each costing a build and a round trip. A report the user can copy
/// back identifies the cause in one go.
#[cfg(windows)]
pub fn diagnose() -> Vec<Finding> {
    let mut findings = Vec::new();

    let app_bits = if cfg!(target_pointer_width = "64") { "64-bit" } else { "32-bit" };
    findings.push(ok("This app", app_bits));

    let exe = crate::onenote::com_onenote_exe();
    match &exe {
        Some(path) => {
            findings.push(ok("OneNote program", path.display().to_string()));
            match read_pe_machine(path) {
                Some(machine) => {
                    let name = machine_name(machine);
                    // The headline: a bitness split is exactly what stops a
                    // type library from being found.
                    let mismatch = is_32_bit(machine) != cfg!(target_pointer_width = "32");
                    findings.push(Finding {
                        label: "OneNote build".into(),
                        value: if mismatch {
                            format!("{name} — does NOT match this app, which is why the type library is not visible to it")
                        } else {
                            format!("{name} — matches this app")
                        },
                        problem: mismatch,
                    });
                }
                None => findings.push(bad("OneNote build", "could not be read")),
            }
        }
        None => findings.push(bad(
            "OneNote program",
            "not registered — the Store version of OneNote has no automation interface",
        )),
    }

    findings.extend(typelib_findings());

    // What each route actually does, which is the ground truth the rest of the
    // report only explains.
    match crate::onenote::hierarchy_probe_in_process() {
        Ok(bytes) => findings.push(ok("Reading notebooks in this app", format!("worked ({bytes} bytes)"))),
        Err(why) => findings.push(bad("Reading notebooks in this app", why)),
    }
    for host in [Host::Win64, Host::Win32] {
        match run_script(host, &hierarchy_script()) {
            Ok(xml) => findings.push(ok(
                &format!("Reading notebooks via {}", host.label()),
                format!("worked ({} bytes)", xml.len()),
            )),
            Err(why) => findings.push(bad(&format!("Reading notebooks via {}", host.label()), why)),
        }
    }

    findings
}

/// Which type library registrations exist, per bitness and per hive.
#[cfg(windows)]
fn typelib_findings() -> Vec<Finding> {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, KEY_READ,
    };

    // OneNote's type library, as registered by Office setup.
    const ONENOTE_TYPELIB: &str = "{0EA692EE-BB50-4E3C-AEF0-356D91732725}";
    let mut findings = Vec::new();

    let exists = |root: HKEY, path: &str| -> bool {
        let wide = HSTRING::from(path);
        let mut key = HKEY::default();
        let opened = unsafe { RegOpenKeyExW(root, &wide, Some(0), KEY_READ, &mut key) };
        if opened.is_ok() {
            unsafe { let _ = RegCloseKey(key); };
            true
        } else {
            false
        }
    };

    for (hive, root, prefix) in [
        ("machine-wide", HKEY_CLASSES_ROOT, "TypeLib"),
        ("your account", HKEY_CURRENT_USER, r"Software\Classes\TypeLib"),
    ] {
        let base = format!(r"{prefix}\{ONENOTE_TYPELIB}");
        if !exists(root, &base) {
            findings.push(Finding {
                label: format!("Type library ({hive})"),
                value: "not registered at all".into(),
                problem: hive == "machine-wide",
            });
            continue;
        }
        // Office registers under a version subkey; check both bitness leaves
        // beneath whichever versions are present.
        let mut found = Vec::new();
        for version in ["1.1", "1.0", "2.0"] {
            for (bits, leaf) in [("win32", "win32"), ("win64", "win64")] {
                if exists(root, &format!(r"{base}\{version}\0\{leaf}")) {
                    found.push(format!("{version} {bits}"));
                }
            }
        }
        findings.push(Finding {
            label: format!("Type library ({hive})"),
            value: if found.is_empty() {
                "present but with no usable entry".into()
            } else {
                found.join(", ")
            },
            problem: found.is_empty(),
        });
    }
    findings
}

#[cfg(not(windows))]
pub fn diagnose() -> Vec<Finding> {
    vec![bad("OneNote", "This check only runs on Windows.")]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The smallest thing `pe_machine` should accept: MZ, an e_lfanew, and a
    /// PE signature followed by the machine word.
    fn fake_pe(machine: u16, lfanew: usize) -> Vec<u8> {
        let mut bytes = vec![0u8; lfanew + 8];
        bytes[0..2].copy_from_slice(b"MZ");
        bytes[0x3C..0x40].copy_from_slice(&(lfanew as u32).to_le_bytes());
        bytes[lfanew..lfanew + 4].copy_from_slice(b"PE\0\0");
        bytes[lfanew + 4..lfanew + 6].copy_from_slice(&machine.to_le_bytes());
        bytes
    }

    #[test]
    fn a_64_bit_image_reports_amd64() {
        let bytes = fake_pe(0x8664, 0x100);
        assert_eq!(pe_machine(&bytes), Some(0x8664));
        assert!(!is_32_bit(0x8664));
        assert_eq!(machine_name(0x8664), "64-bit (x64)");
    }

    #[test]
    fn a_32_bit_image_reports_i386() {
        let bytes = fake_pe(0x014c, 0x80);
        assert_eq!(pe_machine(&bytes), Some(0x014c));
        assert!(is_32_bit(0x014c));
        assert_eq!(machine_name(0x014c), "32-bit (x86)");
    }

    #[test]
    fn an_unknown_machine_is_not_treated_as_32_bit() {
        // Routing to the 32-bit host on a guess would be worse than declining.
        assert!(!is_32_bit(0x5032));
        assert_eq!(machine_name(0x5032), "unknown");
    }

    #[test]
    fn garbage_is_rejected_rather_than_misread() {
        assert_eq!(pe_machine(b""), None);
        assert_eq!(pe_machine(&[0u8; 512]), None); // no MZ
        let mut no_pe = fake_pe(0x8664, 0x100);
        no_pe[0x100] = b'X'; // signature broken
        assert_eq!(pe_machine(&no_pe), None);
    }

    #[test]
    fn an_lfanew_past_the_end_does_not_panic() {
        let mut bytes = vec![0u8; 0x40];
        bytes[0..2].copy_from_slice(b"MZ");
        bytes[0x3C..0x40].copy_from_slice(&0xFFFF_FF00u32.to_le_bytes());
        assert_eq!(pe_machine(&bytes), None);
    }

    #[test]
    fn single_quotes_are_doubled_for_powershell() {
        assert_eq!(ps_quote("plain"), "'plain'");
        assert_eq!(ps_quote("Bob's notes"), "'Bob''s notes'");
        assert_eq!(ps_quote(r"C:\a'b\c.mht"), r"'C:\a''b\c.mht'");
    }

    #[test]
    fn a_page_id_cannot_break_out_of_its_quotes() {
        // A hostile-looking id has to stay one string literal.
        let script = publish_script(
            "'; Remove-Item C:\\ -Recurse; '",
            Path::new("C:\\out.mht"),
            PUBLISH_FORMAT_MHTML,
        );
        assert!(script.contains("''; Remove-Item C:\\ -Recurse; ''"));
        // One Publish call, and the injected text never starts a new statement.
        assert_eq!(script.matches("$app.Publish(").count(), 1);
        assert!(!script.contains("\nRemove-Item"));
    }

    #[test]
    fn the_publish_script_carries_the_format_it_was_given() {
        let word = publish_script("{ID}", Path::new(r"C:\tmp\page.docx"), PUBLISH_FORMAT_WORD);
        assert!(word.contains("$app.Publish('{ID}', 'C:\\tmp\\page.docx', 5, '')"), "{word}");
        let mht = publish_script("{ID}", Path::new(r"C:\tmp\page.mht"), PUBLISH_FORMAT_MHTML);
        assert!(mht.contains("$app.Publish('{ID}', 'C:\\tmp\\page.mht', 2, '')"), "{mht}");
    }

    #[test]
    fn the_hierarchy_script_asks_for_pages_and_writes_the_xml_out() {
        let script = hierarchy_script();
        assert!(script.contains("GetHierarchy('', 4, [ref]$xml)"));
        assert!(script.contains("[Console]::Out.Write($xml)"));
        assert!(script.contains("New-Object -ComObject OneNote.Application"));
    }

    #[test]
    fn encoded_commands_are_base64_of_utf16le() {
        // "hi" -> 68 00 69 00 -> aABpAA==
        assert_eq!(encode_command("hi"), "aABpAA==");
    }

    /// Compared by component, because the separator this joins with is the
    /// host's — the assertion is about which directories, not their spelling.
    #[test]
    fn the_two_hosts_resolve_to_the_documented_directories() {
        let parts = |path: PathBuf| {
            path.components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        let win64 = parts(Host::Win64.powershell_path(r"C:\Windows"));
        assert!(win64.contains(&"System32".to_string()), "{win64:?}");
        assert!(!win64.contains(&"SysWOW64".to_string()), "{win64:?}");
        assert_eq!(win64.last().unwrap(), "powershell.exe");

        let win32 = parts(Host::Win32.powershell_path(r"C:\Windows"));
        // SysWOW64 holds the 32-bit build. The names read backwards; that is
        // Windows' doing, and getting it round the wrong way is the whole bug
        // this module exists to work around.
        assert!(win32.contains(&"SysWOW64".to_string()), "{win32:?}");
        assert!(!win32.contains(&"System32".to_string()), "{win32:?}");
        assert!(win32.contains(&"WindowsPowerShell".to_string()));
        assert!(win32.contains(&"v1.0".to_string()));
    }
}
