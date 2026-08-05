//! Small helpers with no app in them: the clock, relative times, the
//! `{path}` / `{line}` substitution the configured openers use, and the
//! program resolution every app needs before it can spawn anything.
//!
//! Host-specific helpers stay with their host — Dev Hub's git remote parsing,
//! for instance, is in `dev_hub::util`.

use std::path::Path;

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// "just now" / "4m" / "3h" / "2d". Used for last-commit age and, in the
/// renderer, last-refreshed times.
pub fn relative_age(secs: i64) -> String {
    let secs = secs.max(0);
    match secs {
        0..=59 => "just now".to_string(),
        60..=3599 => format!("{}m ago", secs / 60),
        3600..=86_399 => format!("{}h ago", secs / 3600),
        86_400..=2_591_999 => format!("{}d ago", secs / 86_400),
        _ => format!("{}mo ago", secs / 2_592_000),
    }
}

/// Substitute the placeholders the config's `openWith` entries use.
///
/// Only `{path}` and `{line}` are recognised; anything else is left alone, so a
/// literal brace in a command line survives.
pub fn expand_placeholders(arg: &str, path: &str, line: Option<usize>) -> String {
    let mut out = arg.replace("{path}", path);
    if let Some(line) = line {
        out = out.replace("{line}", &line.to_string());
    }
    out
}

// ---------------------------------------------------------------------------
// Launching programs
// ---------------------------------------------------------------------------

/// The extensions Windows will append to a bare program name, from PATHEXT.
#[cfg(windows)]
fn path_extensions() -> Vec<String> {
    std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .map(|ext| ext.trim().to_lowercase())
        .filter(|ext| !ext.is_empty())
        .collect()
}

/// Resolve a program name to a concrete executable, the way a shell would.
///
/// This exists because `CreateProcess` only ever appends `.exe`. A config entry
/// of `code` or `npm` — really `code.cmd` and `npm.cmd` — would not be found,
/// and the obvious workaround of routing everything through `cmd /C` is worse
/// than the disease: `cmd` starts successfully and *then* fails to find the
/// program, so a fire-and-forget spawn reports success and nothing happens.
/// Resolving up front turns a bad program name into a message on the card.
#[cfg(windows)]
pub fn resolve_program(program: &str) -> Option<std::path::PathBuf> {
    let raw = Path::new(program);
    let extensions = path_extensions();

    let probe = |base: &Path| -> Option<std::path::PathBuf> {
        if base.is_file() {
            return Some(base.to_path_buf());
        }
        extensions.iter().find_map(|ext| {
            let mut candidate = base.as_os_str().to_os_string();
            candidate.push(ext);
            let candidate = std::path::PathBuf::from(candidate);
            candidate.is_file().then_some(candidate)
        })
    };

    // A name with a separator in it is a path, not something to look up.
    if raw.is_absolute() || program.contains('/') || program.contains('\\') {
        return probe(raw);
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| probe(&dir.join(raw)))
}

/// On Unix the kernel does the lookup and `spawn` reports a missing program
/// honestly, so there is nothing to resolve.
#[cfg(not(windows))]
pub fn resolve_program(program: &str) -> Option<std::path::PathBuf> {
    Some(std::path::PathBuf::from(program))
}

/// A batch file can't be handed to `CreateProcess` — it has to go through the
/// command interpreter, even once we know exactly where it lives.
pub fn needs_command_interpreter(path: &Path) -> bool {
    path.extension()
        .map(|ext| ext.eq_ignore_ascii_case("bat") || ext.eq_ignore_ascii_case("cmd"))
        .unwrap_or(false)
}

/// A display name for a path: the last component, or the whole thing when
/// there isn't one (a bare drive root).
pub fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Path with forward slashes, for subtitles that need to be readable on both
/// platforms (the renderer never has to care which OS wrote them).
pub fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_ages_read_the_way_a_person_would_say_them() {
        assert_eq!(relative_age(0), "just now");
        assert_eq!(relative_age(59), "just now");
        assert_eq!(relative_age(60), "1m ago");
        assert_eq!(relative_age(7200), "2h ago");
        assert_eq!(relative_age(86_400 * 3), "3d ago");
        assert_eq!(relative_age(2_592_000 * 2), "2mo ago");
    }

    #[test]
    fn negative_ages_from_a_skewed_clock_do_not_underflow() {
        assert_eq!(relative_age(-500), "just now");
    }

    #[test]
    fn batch_files_are_the_only_thing_that_needs_the_interpreter() {
        assert!(needs_command_interpreter(Path::new("C:\\bin\\code.cmd")));
        assert!(needs_command_interpreter(Path::new("C:\\bin\\build.BAT")));
        assert!(!needs_command_interpreter(Path::new("C:\\bin\\idea64.exe")));
        assert!(!needs_command_interpreter(Path::new("/usr/bin/code")));
    }

    #[test]
    fn an_existing_file_resolves_to_itself_when_given_as_a_path() {
        // The test binary is the one executable guaranteed to exist here.
        let exe = std::env::current_exe().unwrap();
        let resolved = resolve_program(&exe.to_string_lossy()).expect("an existing path resolves");
        assert_eq!(resolved, exe);
    }

    #[cfg(windows)]
    #[test]
    fn a_program_that_is_nowhere_on_path_does_not_resolve() {
        assert!(resolve_program("suite-core-definitely-not-installed").is_none());
    }

    #[test]
    fn placeholders_expand_only_where_they_are_defined() {
        assert_eq!(expand_placeholders("-g", "C:\\notes\\a.md", Some(12)), "-g");
        assert_eq!(
            expand_placeholders("{path}:{line}", "C:\\notes\\a.md", Some(12)),
            "C:\\notes\\a.md:12"
        );
        // No line available — the token is left alone rather than becoming "0".
        assert_eq!(
            expand_placeholders("{path}:{line}", "/a.md", None),
            "/a.md:{line}"
        );
    }
}
